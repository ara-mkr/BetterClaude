/**
 * Agent team sidebar for the embedded Claude Code window.
 *
 * Same realm as terminal.js (a plain page-world <script>): no require(), no
 * ipcRenderer — everything goes through the same `window.betterClaudeCode`
 * bridge. This file owns NO pty: it renders snapshots of the shared .bc-team/
 * hub (electron/team-hub.js) that the main process pushes over
 * `code:team:update`, and sends user intent back through code:team:* handlers.
 *
 * The sidebar shows ONE folder's team — the on-screen tab's (or, with no team
 * tab on screen, the only/first hub) — so two projects' teams never mix.
 *
 * What it shows, top to bottom:
 *   - WHO'S DOING WHAT: every teammate (CLI tabs and Code-tab chats), its live
 *     state, what it says it's on, and anything the relay is holding for it.
 *   - TEAM CHAT: inter-agent messages with their delivery state, the relay's
 *     own notes, and a composer to talk to one teammate or the whole team.
 *   - WORK BOARD: the shared task list; agents claim tasks through their own
 *     tools, this board edits the same file.
 *   - MADE SO FAR: git's view of what has actually changed on disk in the
 *     team's folder, beyond agents' self-reporting.
 *
 * It also drives the LIVE RAIL (#bc-team-rail, the tiny right-edge wire):
 * one compact entry per inter-session message and per delegated work event
 * (task claims, assignments, completions, focus changes), diffed from the
 * same snapshots and kept in timestamp order. The rail spans every team, is
 * rendered even while hidden so its history is intact when re-opened, and
 * its left-edge pull bar widens or narrows it.
 */

(function () {
  "use strict";

  const api = window.betterClaudeCode;
  if (!api || !api.teamSnapshot) return;

  const panel = document.getElementById("bc-team-panel");
  const teamToggleBtn = document.getElementById("bc-code-team-btn");
  const hideBtn = document.getElementById("bc-team-hide-btn");
  const addBtn = document.getElementById("bc-team-add-btn");
  const titleEl = panel ? panel.querySelector(".bc-team-title") : null;
  const membersList = document.getElementById("bc-team-members");
  const feed = document.getElementById("bc-team-feed");
  const composeForm = document.getElementById("bc-team-compose");
  const composeTo = document.getElementById("bc-team-compose-to");
  const composeInput = document.getElementById("bc-team-compose-input");
  const tasksList = document.getElementById("bc-team-tasks");
  const taskForm = document.getElementById("bc-team-task-form");
  const taskInput = document.getElementById("bc-team-task-input");
  const diffHost = document.getElementById("bc-team-diff");

  if (!panel || !teamToggleBtn) return;

  let snapshot = { members: [], messages: [], notes: [], tasks: [], changes: {}, diffs: {}, hubs: [] };
  let opened = false;
  // Timestamp of the newest message the user has actually SEEN (the feed being
  // visible counts). Messages newer than this badge the recipient's tab.
  let lastSeenTs = Date.now();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function activeTabId() {
    const tabs = window.BetterClaudeTabs;
    return tabs && tabs.activeId ? tabs.activeId : null;
  }

  // --- Which team is on screen ------------------------------------------------

  /** The folder whose team the sidebar shows: the on-screen tab's, else the first hub. */
  function currentHubRoot() {
    const id = activeTabId();
    const mine = id ? (snapshot.members || []).find((m) => m.sessionId === id) : null;
    if (mine && mine.hubRoot) return mine.hubRoot;
    const hubs = snapshot.hubs || [];
    return hubs.length ? hubs[0].root : null;
  }

  function inHub(item) {
    const root = currentHubRoot();
    return !root || !item || !item.hubRoot || item.hubRoot === root;
  }

  const hubMembers = () => (snapshot.members || []).filter(inHub);

  // --- Visibility -----------------------------------------------------------

  function setVisible(visible) {
    panel.dataset.visible = visible ? "true" : "false";
    teamToggleBtn.dataset.active = visible ? "true" : "false";
    teamToggleBtn.setAttribute("aria-pressed", visible ? "true" : "false");
    if (visible && !opened) {
      opened = true;
      api.teamSnapshot().then((snap) => {
        if (snap) applySnapshot(snap);
      }).catch(() => {});
    }
    if (visible) markAllSeen();
    else renderBadges();
  }

  teamToggleBtn.addEventListener("click", () => {
    setVisible(panel.dataset.visible !== "true");
  });
  hideBtn.addEventListener("click", () => setVisible(false));
  // Escape inside the sidebar closes it (the terminal keeps Escape for itself).
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    setVisible(false);
    teamToggleBtn.focus();
  });

  // --- Snapshot handling ------------------------------------------------------

  function render() {
    renderTitle();
    renderMembers();
    renderFeed();
    renderComposerTargets();
    renderTasks();
    renderDiff();
    if (panel.dataset.visible === "true") markAllSeen();
    else renderBadges();
  }

  function applySnapshot(next) {
    snapshot = next;
    syncTabNames();
    render();
    renderRail();
  }

  /** A CLI tab is labelled with its teammate's name, so a rename shows there too. */
  function syncTabNames() {
    const tabs = window.BetterClaudeTabs;
    if (!tabs) return;
    for (const member of snapshot.members || []) {
      if (member.kind !== "cli" || !member.sessionId || !member.name) continue;
      const tab = tabs.byId(member.sessionId);
      if (tab && tab.setName) tab.setName(member.name);
    }
  }

  api.onTeamUpdate((snap) => {
    if (!snap) return;
    applySnapshot(snap);
  });

  // Switching tabs can switch folders, and with it the team on screen.
  document.addEventListener("betterclaude:active-session", () => render());

  function memberBySession(sessionId) {
    return (snapshot.members || []).find((m) => m.sessionId === sessionId) || null;
  }

  function activeMember() {
    const id = activeTabId();
    return id ? memberBySession(id) : null;
  }

  function renderTitle() {
    if (!titleEl) return;
    const hubs = snapshot.hubs || [];
    const root = currentHubRoot();
    const hub = hubs.find((h) => h.root === root);
    // The folder only matters once there's more than one team to tell apart.
    titleEl.textContent = hubs.length > 1 && hub ? `Agent team · ${hub.name}` : "Agent team";
    titleEl.title = root || "";
  }

  // --- Roster -----------------------------------------------------------------

  // Dot colour follows what BetterClaude KNOWS (the session's live state from
  // Claude Code's hooks / the chat engine), not what the agent last wrote.
  const LIVE_CLASS = {
    working: "st-running",
    waiting: "st-blocked",
    idle: "st-done",
    starting: "st-idle",
    exited: "st-exited",
    offline: "st-idle",
  };
  const LIVE_LABEL = {
    working: "working",
    waiting: "waiting on you",
    idle: "at its prompt",
    starting: "starting",
    exited: "exited",
    offline: "offline",
  };

  function leaf(path) {
    if (!path) return "";
    const parts = String(path).split("/");
    return parts[parts.length - 1] || path;
  }

  function timeLabel(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  // Renaming a teammate: `editing` survives the re-renders every snapshot causes,
  // so a state change mid-typing doesn't throw the field away. `renameNote` is
  // the reason a rename was refused, shown on that card until the next try.
  let editing = null; // { memberId, value, focus }
  let renameNote = null; // { memberId, text }
  let rendering = false;

  function startRename(member) {
    renameNote = null;
    editing = { memberId: member.id, value: member.name, focus: true };
    renderMembers();
  }

  async function finishRename(member, commit) {
    if (!editing || editing.memberId !== member.id) return;
    const next = String(editing.value || "").trim();
    editing = null;
    if (!commit || !next || next === member.name) { renderMembers(); return; }
    let result = null;
    try { result = await api.teamRename({ memberId: member.id, name: next }); } catch { /* falls through to the note */ }
    renameNote = result && result.ok ? null : { memberId: member.id, text: (result && result.error) || "Couldn't rename this teammate." };
    if (result && result.ok) api.teamSnapshot().then((snap) => { if (snap) applySnapshot(snap); }).catch(() => {});
    else renderMembers();
  }

  function renameField(member) {
    const input = el("input", "bc-team-rename-input");
    input.type = "text";
    input.value = editing.value;
    input.maxLength = 32;
    input.spellcheck = false;
    input.setAttribute("aria-label", `Rename ${member.name}`);
    input.addEventListener("input", () => { if (editing) editing.value = input.value; });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); finishRename(member, true); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishRename(member, false); }
    });
    // Leaving the field saves, like a file rename — but not the blur a re-render causes.
    input.addEventListener("blur", () => { if (!rendering) finishRename(member, true); });
    return input;
  }

  function renderMembers() {
    rendering = true;
    membersList.textContent = "";
    const members = hubMembers();
    if (!members.length) {
      membersList.appendChild(el("div", "bc-team-empty", "No teammates yet — “+ Teammate” starts one in this folder."));
      renderJoinButton();
      rendering = false;
      return;
    }
    for (const member of members) {
      const card = el("div", "bc-team-member");
      card.dataset.kind = member.kind || "cli";
      card.dataset.live = member.live ? "true" : "false";

      const top = el("div", "bc-team-member-top");
      const state = member.liveState || (member.live ? "working" : "offline");
      const dot = el("span", `bc-code-dot ${LIVE_CLASS[state] || "st-idle"}`);
      dot.title = LIVE_LABEL[state] || state;
      const renamable = member.live && member.kind !== "roster";
      if (editing && editing.memberId === member.id && renamable) {
        top.append(dot, renameField(member));
      } else {
        const nameEl = el("span", "bc-team-member-name", member.name);
        nameEl.title = member.name;
        if (renamable) {
          nameEl.dataset.renamable = "";
          nameEl.title = `${member.name} — double-click to rename`;
          nameEl.addEventListener("dblclick", () => startRename(member));
        }
        top.append(dot, nameEl);
      }
      if (member.kind === "chat") top.appendChild(el("span", "bc-team-member-tag", "Code tab"));
      if (member.cwd) top.appendChild(el("span", "bc-team-member-cwd", leaf(member.cwd)));
      card.appendChild(top);

      let what;
      if (member.kind === "roster") {
        what = member.status === "exited" ? "Left the team." : `Offline — from an earlier session${member.lastSeen ? ` (last seen ${timeLabel(member.lastSeen)})` : ""}.`;
      } else if (!member.live) {
        what = "Exited.";
      } else {
        const task = member.currentTask && member.currentTask !== "Joining the team…" ? member.currentTask : "";
        what = task ? `${task} · ${LIVE_LABEL[state] || state}` : (LIVE_LABEL[state] || "working").replace(/^./, (c) => c.toUpperCase()) + ".";
      }
      card.appendChild(el("div", "bc-team-member-task", what));

      // Messages the relay is holding for this member, and why.
      if (member.queued) {
        const held = el("div", "bc-team-member-held");
        const noun = member.queued === 1 ? "message" : "messages";
        const why = member.paused ? "paused after a long back-and-forth" : member.heldWhy || "delivering…";
        held.appendChild(el("span", "", `${member.queued} ${noun} waiting — ${why}`));
        const canPush = member.paused || (member.heldWhy && !/permission|approval|offline|starting/.test(member.heldWhy));
        if (canPush) {
          const btn = el("button", "bc-team-chip-btn", member.paused ? "Resume" : "Deliver now");
          btn.type = "button";
          btn.title = member.paused
            ? "Let this back-and-forth continue"
            : "Deliver now, without waiting for a quiet moment (never into an open dialog)";
          btn.addEventListener("click", () => {
            btn.disabled = true;
            Promise.resolve(api.teamResume && api.teamResume({ memberId: member.id })).catch(() => {}).finally(() => { btn.disabled = false; });
          });
          held.appendChild(btn);
        }
        card.appendChild(held);
      }

      const actions = el("div", "bc-team-member-actions");
      if (member.live && member.kind !== "roster") {
        const nudgeBtn = el("button", "bc-team-chip-btn", "Ask for update");
        nudgeBtn.type = "button";
        nudgeBtn.title = "Ask this teammate to post a one-line status update";
        nudgeBtn.addEventListener("click", () => {
          api.teamNudge({ memberId: member.id }).catch(() => {});
        });
        actions.appendChild(nudgeBtn);
        const renameBtn = el("button", "bc-team-chip-btn", "Rename");
        renameBtn.type = "button";
        renameBtn.title = "Give this teammate a name of your own (its work and history stay the same)";
        renameBtn.addEventListener("click", () => startRename(member));
        actions.appendChild(renameBtn);
      }
      if (actions.childElementCount) card.appendChild(actions);
      if (renameNote && renameNote.memberId === member.id) card.appendChild(el("div", "bc-team-member-error", renameNote.text));

      // Work log: what this teammate says it has made (it records its own
      // file edits in the hub per the protocol). Git's independent view of
      // the same disk lives in the "Made so far" section below.
      const log = (snapshot.changes || {})[member.id];
      if (log && typeof log === "object") {
        const made = el("div", "bc-team-made");
        if (typeof log.summary === "string" && log.summary) made.appendChild(el("div", "bc-team-made-summary", log.summary));
        const files = Array.isArray(log.files) ? log.files.slice(0, 3) : [];
        for (const f of files) {
          if (!f || typeof f.path !== "string") continue;
          const line = el("div", "bc-team-diff-file");
          line.appendChild(el("span", "bc-team-diff-path", f.path));
          line.appendChild(el("span", "bc-team-diff-stats", typeof f.note === "string" ? f.note : ""));
          made.appendChild(line);
        }
        if (made.childElementCount) card.appendChild(made);
      }

      membersList.appendChild(card);
    }
    renderJoinButton();
    const field = membersList.querySelector(".bc-team-rename-input");
    if (field && editing && editing.focus) {
      editing.focus = false;
      field.focus();
      field.select();
    } else if (field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
    rendering = false;
  }

  /** "Join team" applies to whichever session is on screen but not yet on a team. */
  function renderJoinButton() {
    let existing = document.getElementById("bc-team-join-btn");
    const canJoin = !!activeTabId() && !activeMember() && !!snapshot.members;
    if (!canJoin) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      existing = el("button", "bc-team-chip-btn", "Add the session on screen to this team");
      existing.id = "bc-team-join-btn";
      existing.type = "button";
      existing.addEventListener("click", () => {
        const id = activeTabId();
        if (!id) return;
        existing.disabled = true;
        Promise.resolve(api.teamJoin({ id })).catch(() => {}).finally(() => { existing.disabled = false; });
      });
    }
    membersList.appendChild(existing);
  }

  // --- Chat -------------------------------------------------------------------

  /** Display name for a message end: an id or a name an agent wrote, "you", or a broadcast. */
  function nameOf(ref) {
    const key = String(ref == null ? "" : ref).trim();
    if (key === "you") return "you";
    if (/^@?(all|everyone|team|\*)$/i.test(key)) return "everyone";
    const members = snapshot.members || [];
    const bare = key.replace(/^@/, "").toLowerCase();
    const member = members.find((m) => m.id === key)
      || members.find((m) => String(m.name).toLowerCase() === bare)
      || members.find((m) => (m.aliases || []).some((a) => String(a).toLowerCase() === bare));
    return member ? member.name : (snapshot.names && snapshot.names[key]) || key || "unknown";
  }

  /** One short line for a message the relay did NOT (or hasn't yet) delivered. */
  function deliveryLine(msg) {
    const d = msg.delivery;
    if (!d) return "";
    switch (d.state) {
      case "queued": {
        const waiting = (d.recipients || []).filter((id) => !(d.delivered || []).includes(id)).map(nameOf);
        return waiting.length ? `Waiting to reach ${waiting.join(", ")}` : "";
      }
      case "unverified": return "Not relayed — the sender isn't on this team";
      case "undeliverable": return `Not delivered — ${d.why || "no recipient"}`;
      case "duplicate": return "Not delivered again — identical to a message moments earlier";
      case "dropped": return "Dropped — the recipient's queue was full";
      default: return "";
    }
  }

  function nearBottom(node) {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 60;
  }

  function renderFeed() {
    const rows = [
      ...(snapshot.messages || []).filter(inHub).map((m) => ({ type: "msg", ts: m.ts, item: m })),
      ...(snapshot.notes || []).filter(inHub).map((n) => ({ type: "note", ts: n.ts, item: n })),
    ].sort((a, b) => a.ts - b.ts);
    const stick = nearBottom(feed);
    feed.textContent = "";
    if (!rows.length) {
      feed.appendChild(el("div", "bc-team-empty", "Messages between teammates land here."));
      return;
    }
    for (const { type, item } of rows) {
      if (type === "note") {
        const row = el("div", "bc-team-msg");
        row.dataset.kind = "system";
        const meta = el("div", "bc-team-msg-meta");
        meta.appendChild(el("span", "bc-team-msg-from", "BetterClaude"));
        const when = el("span", "bc-team-msg-time", timeLabel(item.ts));
        meta.appendChild(when);
        row.appendChild(meta);
        row.appendChild(el("div", "", item.text));
        feed.appendChild(row);
        continue;
      }
      const msg = item;
      const row = el("div", "bc-team-msg");
      row.dataset.broadcast = nameOf(msg.to) === "everyone" ? "true" : "false";
      row.dataset.from = msg.from;
      row.dataset.kind = msg.kind || "chat";
      if (msg.delivery && msg.delivery.state) row.dataset.delivery = msg.delivery.state;

      const meta = el("div", "bc-team-msg-meta");
      meta.appendChild(el("span", "bc-team-msg-from", nameOf(msg.from)));
      meta.appendChild(el("span", "", "→"));
      meta.appendChild(el("span", "", nameOf(msg.to)));
      if (msg.kind && msg.kind !== "chat") meta.appendChild(el("span", "bc-team-msg-kind", msg.kind));
      meta.appendChild(el("span", "bc-team-msg-time", timeLabel(msg.ts)));
      row.appendChild(meta);

      row.appendChild(el("div", "", msg.body.length > 4000 ? `${msg.body.slice(0, 4000)}…` : msg.body));
      const status = deliveryLine(msg);
      if (status) row.appendChild(el("div", "bc-team-msg-status", status));
      feed.appendChild(row);
    }
    if (stick) feed.scrollTop = feed.scrollHeight;
  }

  function renderComposerTargets() {
    const previous = composeTo.value;
    composeTo.textContent = "";
    composeTo.appendChild(new Option("everyone", "all"));
    for (const member of hubMembers()) {
      if (!member.live || member.kind === "roster") continue;
      composeTo.appendChild(new Option(member.kind === "chat" ? `${member.name} (Code tab)` : member.name, member.id));
    }
    if ([...composeTo.options].some((o) => o.value === previous)) composeTo.value = previous;
  }

  composeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = composeInput.value.trim();
    if (!body) return;
    composeInput.value = "";
    api.teamSend({ to: composeTo.value || "all", body, id: activeTabId() }).catch(() => {});
  });

  addBtn.addEventListener("click", () => {
    setVisible(true);
    Promise.resolve(api.teamCreateTeammate({ id: activeTabId() })).catch(() => {});
  });

  // --- Live rail ---------------------------------------------------------------
  //
  // The tiny right-edge wire: one compact entry per inter-session message and
  // per piece of delegated work (task claims, assignments, completions, focus
  // changes). Fed from the SAME snapshots as this sidebar, so it stays current
  // even while hidden; entries accumulate (capped), in timestamp order —
  // a message that lands late but was sent earlier slots into its place.
  //
  // Delegation events are synthesised here by diffing consecutive snapshots of
  // the shared task board and the members' self-reported focus — the hub files
  // themselves stay the single source of truth.

  const rail = document.getElementById("bc-team-rail");
  const railFeed = document.getElementById("bc-team-rail-feed");
  const railHideBtn = document.getElementById("bc-team-rail-hide");
  const railToggleBtn = document.getElementById("bc-code-rail-btn");
  const RAIL_VISIBLE_KEY = "betterclaude.codeRailVisible";
  const RAIL_MAX_ENTRIES = 150;

  let railVisible = false;
  let railSeeded = false; // first snapshot baselines the board without emitting a fake event burst
  const railSeenMessages = new Set();
  const railSeenNotes = new Set();
  const railLastTasks = new Map(); // taskId -> { title, state, assignee }
  const railLastFocus = new Map(); // memberId -> currentTask text
  const railLastLive = new Map(); // memberId -> boolean

  try {
    railVisible = localStorage.getItem(RAIL_VISIBLE_KEY) !== "off";
  } catch { /* storage unavailable: default to visible */ }

  function railGlyph(kind) {
    return { claim: "◆", assign: "→", done: "✓", focus: "…", todo: "○", exit: "✕", system: "‖" }[kind] || "•";
  }

  function railNearBottom() {
    return railFeed.scrollHeight - railFeed.scrollTop - railFeed.clientHeight < 80;
  }

  function railScrollToBottom(force) {
    if (force || railNearBottom()) railFeed.scrollTop = railFeed.scrollHeight;
  }

  /** Inserts `row` at its timestamp's place (ties keep arrival order). */
  function railInsert(row, ts) {
    const stick = railNearBottom();
    const empty = railFeed.querySelector(".bc-team-empty");
    if (empty) empty.remove();
    row.dataset.ts = String(ts);
    let before = null;
    for (let node = railFeed.lastElementChild; node; node = node.previousElementSibling) {
      if (Number(node.dataset.ts) <= ts) break;
      before = node;
    }
    railFeed.insertBefore(row, before);
    while (railFeed.childElementCount > RAIL_MAX_ENTRIES) railFeed.firstElementChild.remove();
    if (stick) railScrollToBottom(true);
  }

  function railAddMessage(msg) {
    if (railSeenMessages.has(msg.id)) return;
    railSeenMessages.add(msg.id);
    const row = el("div", "bc-rail-entry");
    row.dataset.kind = msg.kind || "chat";
    row.dataset.id = msg.id;
    const route = el("div", "bc-rail-route");
    const from = el("span", "bc-rail-name", nameOf(msg.from));
    from.dataset.from = msg.from;
    route.append(from, el("span", "", "→"), el("span", "bc-rail-name", nameOf(msg.to)));
    if (msg.kind && msg.kind !== "chat") route.appendChild(el("span", "bc-rail-kind", msg.kind));
    route.appendChild(el("span", "bc-rail-time", timeLabel(msg.ts)));
    row.appendChild(route);
    const firstLine = String(msg.body || "").split("\n").find((l) => l.trim()) || "";
    row.appendChild(el("div", "bc-rail-body", firstLine));
    railInsert(row, msg.ts);
  }

  function railAddEvent(kind, who, what, ts) {
    const row = el("div", "bc-rail-entry");
    const line = el("div", "bc-rail-event");
    line.dataset.event = kind;
    line.append(
      el("span", "bc-rail-glyph", railGlyph(kind)),
      el("span", "bc-rail-who", who),
      el("span", "bc-rail-what", what),
      el("span", "bc-rail-time", timeLabel(ts)),
    );
    row.appendChild(line);
    railInsert(row, ts);
  }

  function renderRail() {
    if (!rail || !railFeed) return;

    // 1. Inter-session messages (every team). A bounded tail keeps the first
    //    paint cheap; later snapshots only ever add a few.
    const messages = snapshot.messages || [];
    if (railSeenMessages.size > 600) {
      railSeenMessages.clear();
      for (const m of messages.slice(-200)) railSeenMessages.add(m.id);
    }
    for (const msg of messages.slice(-60)) railAddMessage(msg);

    // 2. The relay's own notes (a paused back-and-forth, a dropped message).
    for (const note of snapshot.notes || []) {
      if (railSeenNotes.has(note.id)) continue;
      railSeenNotes.add(note.id);
      if (railSeeded) railAddEvent("system", "BetterClaude", note.text, note.ts);
    }

    // 3. Delegation: diff the task board against the previous snapshot.
    const tasks = snapshot.tasks || [];
    const seenTaskIds = new Set();
    const now = Date.now();
    for (const task of tasks) {
      seenTaskIds.add(task.id);
      const prev = railLastTasks.get(task.id);
      const who = task.assignee ? nameOf(task.assignee) : "Unassigned";
      if (railSeeded && prev !== undefined) {
        if (task.assignee && task.assignee !== prev.assignee) {
          railAddEvent("assign", who, `was assigned "${task.title}"`, now);
        }
        if (task.state !== prev.state) {
          if (task.state === "done") railAddEvent("done", who, `finished "${task.title}"`, now);
          else if (task.state === "doing") railAddEvent("claim", who, `picked up "${task.title}"`, now);
          else railAddEvent("todo", who, `reopened "${task.title}"`, now);
        }
      } else if (railSeeded && prev === undefined && task.assignee) {
        // A task born already-claimed: the claim is the news, not the birth.
        railAddEvent(task.state === "done" ? "done" : "claim", who, `picked up "${task.title}"`, now);
      }
      railLastTasks.set(task.id, { title: task.title, state: task.state, assignee: task.assignee });
    }
    for (const id of [...railLastTasks.keys()]) {
      if (!seenTaskIds.has(id)) railLastTasks.delete(id);
    }

    // 4. Focus + liveness: what each session says it is on right now.
    for (const member of snapshot.members || []) {
      if (member.kind === "roster") continue;
      const focus = typeof member.currentTask === "string" ? member.currentTask.trim() : "";
      const prevFocus = railLastFocus.get(member.id);
      const wasLive = railLastLive.get(member.id);
      if (
        railSeeded && focus && focus !== prevFocus &&
        focus !== "Joining the team…" // the spawn seed, not a real focus statement
      ) {
        railAddEvent("focus", member.name, `is on "${focus}"`, now);
      }
      if (focus) railLastFocus.set(member.id, focus);
      if (railSeeded && wasLive && !member.live) railAddEvent("exit", member.name, "left the team", now);
      railLastLive.set(member.id, !!member.live);
    }

    railSeeded = true;
  }

  function setRailVisible(visible) {
    railVisible = !!visible;
    rail.dataset.visible = railVisible ? "true" : "false";
    if (railToggleBtn) {
      railToggleBtn.dataset.active = railVisible ? "true" : "false";
      railToggleBtn.setAttribute("aria-pressed", railVisible ? "true" : "false");
    }
    try {
      localStorage.setItem(RAIL_VISIBLE_KEY, railVisible ? "on" : "off");
    } catch { /* private mode: visibility just won't persist */ }
    if (railVisible) railScrollToBottom(true);
  }

  if (rail && railToggleBtn) {
    railToggleBtn.addEventListener("click", () => setRailVisible(!railVisible));
    if (railHideBtn) railHideBtn.addEventListener("click", () => setRailVisible(false));
    rail.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setRailVisible(false);
      if (railToggleBtn) railToggleBtn.focus();
    });
    setRailVisible(railVisible);
  }

  // Pull bar: the rail's left edge is a full-height grab strip. Dragging left
  // widens the wire (it docks on the window's right edge), and the chosen
  // width persists across launches; double-click returns to the stylesheet's
  // default 216px. Pointer capture lives on the handle itself — a document-
  // level mousemove pair silently dies when a fast drag leaves the window or
  // crosses a scrolling surface, which is exactly what makes resize handles
  // look decorative elsewhere.
  const railResize = document.getElementById("bc-team-rail-resize");
  const RAIL_WIDTH_KEY = "betterclaude.codeRailWidthPx";
  const RAIL_MIN_W = 200;
  const RAIL_MAX_W = 520;

  function railClamp(width) {
    return Math.round(Math.min(RAIL_MAX_W, Math.max(RAIL_MIN_W, width)));
  }

  function railApplyWidth(width) {
    rail.style.width = `${railClamp(width)}px`;
  }

  // The narrow-pane Team overlay sits left of an open rail instead of on top
  // of it (code-window.css reads --bc-rail-w; 0 while the rail is hidden).
  if (typeof ResizeObserver === "function" && rail.parentElement) {
    new ResizeObserver(() => {
      rail.parentElement.style.setProperty("--bc-rail-w", `${rail.offsetWidth}px`);
    }).observe(rail);
  }

  function railRestoreWidth() {
    try {
      const stored = parseInt(localStorage.getItem(RAIL_WIDTH_KEY), 10);
      if (Number.isFinite(stored)) railApplyWidth(stored);
    } catch { /* storage unavailable: keep the stylesheet default */ }
  }

  if (rail && railResize) {
    railRestoreWidth();
    let startX = 0;
    let startWidth = 0;
    railResize.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      startX = event.clientX;
      startWidth = rail.getBoundingClientRect().width;
      railResize.setPointerCapture(event.pointerId);
      railResize.classList.add("dragging");
      document.documentElement.classList.add("bc-team-rail-resizing");
    });
    railResize.addEventListener("pointermove", (event) => {
      if (!railResize.hasPointerCapture(event.pointerId)) return;
      railApplyWidth(startWidth + (startX - event.clientX));
    });
    const endRailDrag = (event) => {
      if (!railResize.hasPointerCapture(event.pointerId)) return;
      railResize.releasePointerCapture(event.pointerId);
      railResize.classList.remove("dragging");
      document.documentElement.classList.remove("bc-team-rail-resizing");
      try {
        localStorage.setItem(RAIL_WIDTH_KEY, String(railClamp(rail.getBoundingClientRect().width)));
      } catch { /* private mode: width just won't persist */ }
    };
    railResize.addEventListener("pointerup", endRailDrag);
    railResize.addEventListener("pointercancel", endRailDrag);
    // Double-click: back to the stylesheet's default width.
    railResize.addEventListener("dblclick", () => {
      try { localStorage.removeItem(RAIL_WIDTH_KEY); } catch { /* ignore */ }
      rail.style.removeProperty("width");
    });
    // Keyboard nudge for the same control.
    railResize.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowLeft" ? 16 : event.key === "ArrowRight" ? -16 : 0;
      if (!step) return;
      event.preventDefault();
      railApplyWidth(rail.getBoundingClientRect().width + step);
      try {
        localStorage.setItem(RAIL_WIDTH_KEY, String(railClamp(rail.getBoundingClientRect().width)));
      } catch { /* private mode: width just won't persist */ }
    });
  }

  // --- Task board -------------------------------------------------------------

  function nextAssignee(current) {
    const ids = ["__none", ...hubMembers().filter((m) => m.live && m.kind !== "roster").map((m) => m.id)];
    const index = ids.indexOf(current || "__none");
    return ids[(index + 1) % ids.length];
  }

  function renderTasks() {
    tasksList.textContent = "";
    const tasks = (snapshot.tasks || []).filter(inHub);
    if (!tasks.length) {
      tasksList.appendChild(el("div", "bc-team-empty", "Break the work up into tasks for the team."));
      return;
    }
    for (const task of tasks) {
      const row = el("div", "bc-team-task");
      row.dataset.state = task.state || "todo";

      const stateBtn = el("button", "bc-team-task-state");
      stateBtn.type = "button";
      stateBtn.title = `State: ${task.state || "todo"} (click to advance)`;
      stateBtn.setAttribute("aria-label", `Task state: ${task.state || "todo"}. Click to advance.`);
      stateBtn.addEventListener("click", () => {
        const order = { todo: "doing", doing: "done", done: "todo" };
        api.teamUpdateTask({ taskId: task.id, state: order[task.state || "todo"] || "doing" }).catch(() => {});
      });
      row.appendChild(stateBtn);

      row.appendChild(el("span", "bc-team-task-title", task.title));
      row.title = task.title;

      const assigneeBtn = el("button", "bc-team-task-assignee", task.assignee ? nameOf(task.assignee) : "unassigned");
      assigneeBtn.type = "button";
      assigneeBtn.title = "Click to reassign";
      assigneeBtn.addEventListener("click", () => {
        const next = nextAssignee(task.assignee);
        api.teamUpdateTask({ taskId: task.id, assignee: next === "__none" ? null : next }).catch(() => {});
      });
      row.appendChild(assigneeBtn);

      tasksList.appendChild(row);
    }
  }

  taskForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = taskInput.value.trim();
    if (!title) return;
    taskInput.value = "";
    api.teamAddTask({ title, id: activeTabId() }).catch(() => {});
  });

  // --- Made so far ------------------------------------------------------------

  function statSpan(file) {
    const span = el("span", "bc-team-diff-stats");
    if (file.untracked) {
      span.textContent = "new";
      return span;
    }
    const add = el("span", "add", `+${file.added == null ? "?" : file.added}`);
    const del = el("span", "del", `−${file.deleted == null ? "?" : file.deleted}`);
    span.append(add, document.createTextNode(" "), del);
    return span;
  }

  function renderDiff() {
    diffHost.textContent = "";
    const diffs = snapshot.diffs || {};
    const root = currentHubRoot();
    const cwds = Object.keys(diffs).filter((cwd) => !root || cwd === root || cwd.startsWith(`${root}/`));
    if (!cwds.length) {
      diffHost.appendChild(el("div", "bc-team-empty", "Files the team has touched show up here."));
      return;
    }
    for (const cwd of cwds) {
      const summary = diffs[cwd];
      const wrap = el("div", "");
      wrap.appendChild(el("div", "bc-team-diff-branch", `${leaf(cwd)} · ${summary.branch || "no git"}`));
      const files = (summary.files || []).slice(-40).reverse();
      if (!files.length) {
        wrap.appendChild(el("div", "bc-team-empty", "No uncommitted changes yet."));
      }
      for (const file of files) {
        const line = el("div", "bc-team-diff-file");
        line.appendChild(el("span", "bc-team-diff-path", file.path));
        line.appendChild(statSpan(file));
        line.title = `${file.path}${file.untracked ? " (new file)" : ""}`;
        wrap.appendChild(line);
      }
      diffHost.appendChild(wrap);
    }
  }

  // --- Unread badges ------------------------------------------------------------
  //
  // Messages addressed to a teammate's tab (or broadcast while the sidebar is
  // shut) badge that tab until the sidebar is opened again.

  function renderBadges() {
    const tabsRoot = document.getElementById("bc-code-tabs");
    if (!tabsRoot) return;
    const pending = new Map(); // sessionId -> count
    const members = snapshot.members || [];
    for (const msg of snapshot.messages || []) {
      if (msg.ts <= lastSeenTs || msg.from === "you") continue;
      if (nameOf(msg.to) === "everyone") {
        const target = activeTabId();
        if (target) pending.set(target, (pending.get(target) || 0) + 1);
        continue;
      }
      const bare = String(msg.to).replace(/^@/, "").toLowerCase();
      const member = members.find((m) => m.id === msg.to) || members.find((m) => String(m.name).toLowerCase() === bare);
      if (member && member.sessionId) pending.set(member.sessionId, (pending.get(member.sessionId) || 0) + 1);
    }
    for (const btn of tabsRoot.querySelectorAll(".bc-code-tab")) {
      const id = btn.dataset.sessionId;
      const badge = btn.querySelector(".bc-code-tab-badge");
      if (!badge) continue;
      const count = pending.get(id) || 0;
      badge.textContent = String(count);
      badge.hidden = count === 0;
    }
  }

  function markAllSeen() {
    const messages = snapshot.messages || [];
    if (messages.length) lastSeenTs = Math.max(lastSeenTs, messages[messages.length - 1].ts);
    renderBadges();
  }
})();
