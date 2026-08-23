/**
 * Agent team sidebar for the embedded Claude Code window.
 *
 * Same realm as terminal.js (a plain page-world <script>): no require(), no
 * ipcRenderer — everything goes through the same `window.betterClaudeCode`
 * bridge. This file owns NO pty: it renders snapshots of the shared .bc-team/
 * hub (electron/team-hub.js) that the main process pushes over
 * `code:team:update`, and sends user intent back through code:team:* handlers.
 *
 * What it shows, top to bottom:
 *   - WHO'S DOING WHAT: every teammate, live or not, with its current task.
 *   - TEAM CHAT: inter-agent messages as they land, plus a composer so the
 *     user can talk to one teammate or broadcast to all.
 *   - WORK BOARD: the shared task list used to break work up; agents claim
 *     tasks through their own tools, this board edits the same file.
 *   - MADE SO FAR: git's view of what has actually changed on disk in each
 *     teammate folder, so "what has everyone built" has ground truth beyond
 *     agents' self-reporting.
 *
 * It also drives the LIVE RAIL (#bc-team-rail, the tiny right-edge wire):
 * one compact entry per inter-session message and per delegated work event
 * (task claims, assignments, completions, focus changes), diffed from the
 * same snapshots. The rail is rendered even while hidden so its history is
 * intact when re-opened; its left-edge pull bar widens or narrows it.
 */

(function () {
  "use strict";

  const api = window.betterClaudeCode;
  if (!api || !api.teamSnapshot) return;

  const panel = document.getElementById("bc-team-panel");
  const teamToggleBtn = document.getElementById("bc-code-team-btn");
  const hideBtn = document.getElementById("bc-team-hide-btn");
  const addBtn = document.getElementById("bc-team-add-btn");
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

  let snapshot = { members: [], messages: [], tasks: [], changes: {}, diffs: {} };
  let opened = false;
  // Timestamp of the newest message the user has actually SEEN (the feed being
  // visible counts). Messages newer than this badge the recipient's tab.
  let lastSeenTs = Date.now();
  const elCache = new Map();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // --- Visibility -----------------------------------------------------------

  function setVisible(visible) {
    panel.dataset.visible = visible ? "true" : "false";
    teamToggleBtn.dataset.active = visible ? "true" : "false";
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

  // --- Snapshot handling ------------------------------------------------------

  function applySnapshot(next) {
    snapshot = next;
    renderMembers();
    renderFeed();
    renderComposerTargets();
    renderTasks();
    renderDiff();
    renderRail();
    if (panel.dataset.visible === "true") markAllSeen();
    else renderBadges();
  }

  api.onTeamUpdate((snap) => {
    if (!snap) return;
    applySnapshot(snap);
  });

  function memberBySession(sessionId) {
    return (snapshot.members || []).find((m) => m.sessionId === sessionId) || null;
  }

  function activeMember() {
    const tabs = window.BetterClaudeTabs;
    if (!tabs || !tabs.activeId) return null;
    return memberBySession(tabs.activeId);
  }

  // --- Roster -----------------------------------------------------------------

  const STATUS_CLASS = {
    running: "st-running",
    working: "st-running",
    exited: "st-exited",
    blocked: "st-blocked",
    done: "st-done",
    idle: "st-idle",
  };

  function statusClass(member) {
    if (member.status === "running") return STATUS_CLASS.running;
    return STATUS_CLASS[member.agentStatus] || STATUS_CLASS[member.status] || STATUS_CLASS.idle;
  }

  function statusLabel(member) {
    if (member.status === "running") return member.agentStatus || "running";
    return member.status || "unknown";
  }

  function leaf(path) {
    if (!path) return "";
    const parts = String(path).split("/");
    return parts[parts.length - 1] || path;
  }

  function renderMembers() {
    membersList.textContent = "";
    const members = snapshot.members || [];
    if (!members.length) {
      membersList.appendChild(el("div", "bc-team-empty", "No teammates yet — “+ Teammate” starts one in this folder."));
      renderJoinButton();
      return;
    }
    for (const member of members) {
      const card = el("div", "bc-team-member");

      const top = el("div", "bc-team-member-top");
      const dot = el("span", `bc-code-dot ${statusClass(member)}`);
      dot.title = statusLabel(member);
      top.append(dot, el("span", "bc-team-member-name", member.name));
      if (member.cwd) top.appendChild(el("span", "bc-team-member-cwd", leaf(member.cwd)));
      card.appendChild(top);

      const what = member.currentTask || (member.live ? "Working…" : "Offline.");
      card.appendChild(el("div", "bc-team-member-task", what));

      const actions = el("div", "bc-team-member-actions");
      if (member.live && member.sessionId) {
        const nudgeBtn = el("button", "bc-team-chip-btn", "Ask for update");
        nudgeBtn.type = "button";
        nudgeBtn.addEventListener("click", () => {
          api.teamNudge({ memberId: member.id }).catch(() => {});
        });
        actions.appendChild(nudgeBtn);
      } else if (!member.live && member.sessionId === null) {
        const offlineNote = el("span", "bc-team-chip-btn", "not attached");
        offlineNote.style.cursor = "default";
        actions.appendChild(offlineNote);
      }
      if (actions.childElementCount) card.appendChild(actions);

      // Work log: what this teammate says it has made (it records its own
      // file edits in the hub per the protocol). Git's independent view of
      // the same disk lives in the "Made so far" section below.
      const log = (snapshot.changes || {})[member.id];
      if (log) {
        const made = el("div", "bc-team-made");
        if (log.summary) made.appendChild(el("div", "bc-team-made-summary", log.summary));
        const files = Array.isArray(log.files) ? log.files.slice(0, 3) : [];
        for (const f of files) {
          if (!f || typeof f.path !== "string") continue;
          const line = el("div", "bc-team-diff-file");
          line.appendChild(el("span", "bc-team-diff-path", f.path));
          line.appendChild(el("span", "bc-team-diff-stats", f.added || ""));
          made.appendChild(line);
        }
        card.appendChild(made);
      }

      membersList.appendChild(card);
    }
    renderJoinButton();
  }

  /** "Join team" applies to whichever session is on screen but not yet on a team. */
  function renderJoinButton() {
    const tabs = window.BetterClaudeTabs;
    let existing = document.getElementById("bc-team-join-btn");
    const canJoin = !!(tabs && tabs.activeId) && !activeMember() && !!snapshot.members;
    if (!canJoin) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      existing = el("button", "bc-team-chip-btn", "Add the session on screen to this team");
      existing.id = "bc-team-join-btn";
      existing.type = "button";
      existing.addEventListener("click", () => {
        const id = window.BetterClaudeTabs.activeId;
        if (!id) return;
        existing.disabled = true;
        Promise.resolve(api.teamJoin({ id })).catch(() => {}).finally(() => { existing.disabled = false; });
      });
      membersList.appendChild(existing);
    }
  }

  // --- Chat -------------------------------------------------------------------

  function timeLabel(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function nameOf(id) {
    if (id === "you") return "you";
    if (id === "all") return "everyone";
    const member = (snapshot.members || []).find((m) => m.id === id);
    return member ? member.name : id;
  }

  function nearBottom(node) {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 60;
  }

  function renderFeed() {
    const messages = snapshot.messages || [];
    const stick = nearBottom(feed);
    feed.textContent = "";
    if (!messages.length) {
      feed.appendChild(el("div", "bc-team-empty", "Messages between teammates land here."));
      return;
    }
    for (const msg of messages) {
      const row = el("div", "bc-team-msg");
      row.dataset.broadcast = msg.to === "all" ? "true" : "false";
      row.dataset.from = msg.from;
      row.dataset.kind = msg.kind || "chat";

      const meta = el("div", "bc-team-msg-meta");
      meta.appendChild(el("span", "bc-team-msg-from", nameOf(msg.from)));
      meta.appendChild(el("span", "", "→"));
      meta.appendChild(el("span", "", nameOf(msg.to)));
      const when = el("span", "");
      when.style.marginLeft = "auto";
      when.textContent = timeLabel(msg.ts);
      meta.appendChild(when);
      row.appendChild(meta);

      row.appendChild(el("div", "", msg.body));
      feed.appendChild(row);
    }
    if (stick) feed.scrollTop = feed.scrollHeight;
  }

  function renderComposerTargets() {
    const previous = composeTo.value;
    composeTo.textContent = "";
    composeTo.appendChild(new Option("everyone", "all"));
    for (const member of snapshot.members || []) {
      if (!member.live) continue;
      composeTo.appendChild(new Option(member.name, member.id));
    }
    if ([...composeTo.options].some((o) => o.value === previous)) composeTo.value = previous;
  }

  composeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = composeInput.value.trim();
    if (!body) return;
    composeInput.value = "";
    api.teamSend({ to: composeTo.value || "all", body }).catch(() => {});
  });

  addBtn.addEventListener("click", () => {
    setVisible(true);
    Promise.resolve(api.teamCreateTeammate({})).catch(() => {});
  });

  // --- Live rail ---------------------------------------------------------------
  //
  // The tiny right-edge wire: one compact entry per inter-session message and
  // per piece of delegated work (task claims, assignments, completions, focus
  // changes). Fed from the SAME snapshots as this sidebar, so it stays current
  // even while hidden; entries accumulate (capped), newest at the bottom.
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
  const railLastTasks = new Map(); // taskId -> { title, state, assignee }
  const railLastFocus = new Map(); // memberId -> currentTask text
  const railLastLive = new Map(); // memberId -> boolean
  let railEntryCount = 0;

  try {
    railVisible = localStorage.getItem(RAIL_VISIBLE_KEY) !== "off";
  } catch { /* storage unavailable: default to visible */ }

  function railGlyph(kind) {
    return { claim: "◆", assign: "→", done: "✓", focus: "…", todo: "○", exit: "✕" }[kind] || "•";
  }

  function railNearBottom() {
    return railFeed.scrollHeight - railFeed.scrollTop - railFeed.clientHeight < 80;
  }

  function railScrollToBottom(force) {
    if (force || railNearBottom()) railFeed.scrollTop = railFeed.scrollHeight;
  }

  function railAppend(row) {
    const empty = railFeed.querySelector(".bc-team-empty");
    if (empty) empty.remove();
    railFeed.appendChild(row);
    railEntryCount += 1;
    if (railEntryCount > RAIL_MAX_ENTRIES) {
      const first = railFeed.firstElementChild;
      if (first) first.remove();
      railEntryCount = RAIL_MAX_ENTRIES;
    }
    railScrollToBottom(false);
  }

  function railAddMessage(msg) {
    if (railSeenMessages.has(msg.id)) return;
    railSeenMessages.add(msg.id);
    const row = el("div", "bc-rail-entry");
    row.dataset.kind = msg.kind || "chat";
    const route = el("div", "bc-rail-route");
    const from = el("span", "bc-rail-name", nameOf(msg.from));
    from.dataset.from = msg.from;
    route.append(from, el("span", "", "→"), el("span", "bc-rail-name", nameOf(msg.to)));
    if (msg.kind && msg.kind !== "chat") route.appendChild(el("span", "bc-rail-kind", msg.kind));
    route.appendChild(el("span", "bc-rail-time", timeLabel(msg.ts)));
    row.appendChild(route);
    const firstLine = String(msg.body || "").split("\n").find((l) => l.trim()) || "";
    row.appendChild(el("div", "bc-rail-body", firstLine));
    railAppend(row);
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
    railAppend(row);
  }

  function renderRail() {
    if (!rail || !railFeed) return;

    // 1. Inter-session messages. A bounded tail keeps the first paint cheap;
    //    later snapshots only ever add a few.
    const messages = snapshot.messages || [];
    if (railSeenMessages.size > 600) {
      railSeenMessages.clear();
      for (const m of messages.slice(-200)) railSeenMessages.add(m.id);
    }
    for (const msg of messages.slice(-40)) railAddMessage(msg);

    // 2. Delegation: diff the task board against the previous snapshot.
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

    // 3. Focus + liveness: what each session says it is on right now.
    for (const member of snapshot.members || []) {
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
    if (railToggleBtn) railToggleBtn.dataset.active = railVisible ? "true" : "false";
    try {
      localStorage.setItem(RAIL_VISIBLE_KEY, railVisible ? "on" : "off");
    } catch { /* private mode: visibility just won't persist */ }
    if (railVisible) railScrollToBottom(true);
  }

  if (rail && railToggleBtn) {
    railToggleBtn.addEventListener("click", () => setRailVisible(!railVisible));
    if (railHideBtn) railHideBtn.addEventListener("click", () => setRailVisible(false));
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
  const RAIL_DEFAULT_W = 216;

  function railClamp(width) {
    return Math.round(Math.min(RAIL_MAX_W, Math.max(RAIL_MIN_W, width)));
  }

  function railApplyWidth(width) {
    rail.style.width = `${railClamp(width)}px`;
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
    const ids = ["__none", ...(snapshot.members || []).filter((m) => m.live).map((m) => m.id)];
    const index = ids.indexOf(current || "__none");
    return ids[(index + 1) % ids.length];
  }

  function renderTasks() {
    tasksList.textContent = "";
    const tasks = snapshot.tasks || [];
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
        api.teamUpdateTask({
          taskId: task.id,
          assignee: (() => {
            const next = nextAssignee(task.assignee);
            return next === "__none" ? null : next;
          })(),
        }).catch(() => {});
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
    api.teamAddTask({ title }).catch(() => {});
  });

  // --- Made so far ------------------------------------------------------------

  function statSpan(file) {
    const span = el("span", "bc-team-diff-stats");
    if (file.untracked) {
      span.textContent = "new";
      return span;
    }
    span.textContent = "";
    const add = el("span", "add", `+${file.added == null ? "?" : file.added}`);
    const del = el("span", "del", `−${file.deleted == null ? "?" : file.deleted}`);
    span.append(add, document.createTextNode(" "), del);
    return span;
  }

  function renderDiff() {
    diffHost.textContent = "";
    const diffs = snapshot.diffs || {};
    const cwds = Object.keys(diffs);
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
  // Messages addressed to a teammate (or broadcast while the sidebar is shut)
  // badge that teammate's tab until the sidebar is opened again.

  function renderBadges() {
    const tabsRoot = document.getElementById("bc-code-tabs");
    if (!tabsRoot) return;
    const pending = new Map(); // sessionId -> count
    for (const msg of snapshot.messages || []) {
      if (msg.ts <= lastSeenTs) continue;
      if (msg.from === "you") continue;
      const member = (snapshot.members || []).find((m) => m.id === msg.to);
      const broadcastToMe = msg.to === "all";
      const sessionId = member ? member.sessionId : broadcastToMe ? window.BetterClaudeTabs?.activeId : null;
      if (broadcastToMe && !sessionId) continue;
      if (!sessionId && !broadcastToMe) continue;
      const target = broadcastToMe ? window.BetterClaudeTabs?.activeId : sessionId;
      if (!target) continue;
      pending.set(target, (pending.get(target) || 0) + 1);
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
