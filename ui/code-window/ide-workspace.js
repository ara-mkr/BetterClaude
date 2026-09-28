/* Page-world controller for BetterClaude's Code tab.
 *
 * Layout (electron/ide-window.html): a sidebar of projects with their
 * sessions, one conversation, and an on-demand right panel (Changes / Files /
 * Terminal). The conversation runs on the user's own Claude Code through
 * electron/ide-chat.js — one persistent `claude` per session — and is drawn
 * by ui/code-window/ide-transcript.js.
 */
(async function () {
  "use strict";

  const api = window.betterClaudeIDE;
  const xterm = window.BetterClaudeXterm;
  const editorFactory = window.BetterClaudeIDEEditor;
  const Transcript = window.BetterClaudeTranscript;
  const shell = document.getElementById("bc-ide-shell");
  const $ = (id) => document.getElementById(id);
  const icon = (key) => (api.icons && api.icons[key]) || "";
  /** Null-safe wiring: one missing element must not skip everything after it. */
  const on = (id, type, fn, opts) => {
    const el = typeof id === "string" ? $(id) : id;
    if (el) el.addEventListener(type, fn, opts);
    else console.warn(`[BetterClaude] Code tab: #${id} missing`);
  };

  // Every icon-only control carries a data-bc-icon placeholder filled from
  // core/icons.js, so there is one canonical icon set.
  function applyIcons(root = document) {
    root.querySelectorAll("[data-bc-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.bcIcon); });
  }
  applyIcons();

  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(key, fallback = null) { try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, String(value)); } catch {} },
    del(key) { try { localStorage.removeItem(key); } catch {} },
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let projects = [];
  let agents = [];
  let activeProject = null;
  const sessionsByCwd = new Map(); // cwd -> saved sessions [{sessionId,title,lastTimestamp,messageCount}]
  const expanded = new Set((() => { try { return JSON.parse(store.get("bc-ide-expanded", "[]")) || []; } catch { return []; } })());
  const showAll = new Set();
  let searchQuery = "";
  let latestSettings = null;
  let planUsage = null; // latest rate_limit_event info from Claude Code
  let scmInfo = null;
  let selectedAttachments = [];

  // Open conversations. A record: { tabId, cwd, sessionId|null, title, permMode,
  // host, transcript, busy, waiting, unread, titleGenerated, firstPrompt,
  // modelId, subscription, apiKeySource, viewedAt }.
  const records = [];
  let activeTabId = null;
  let tabSeq = 0;
  const MAX_OPEN_RECORDS = 12;
  const recordByTab = (tabId) => records.find((r) => r.tabId === tabId) || null;
  const activeRecord = () => recordByTab(activeTabId);

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function shortPath(cwd) {
    const home = api.homeDirectory || "";
    return cwd === home ? "~" : (home && cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd);
  }

  function relativeTime(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  const fmtCompact = (n) => {
    n = Number(n) || 0;
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return String(Math.round(n));
  };

  let toastTimer = null;
  /** Transient message at the bottom of the chat — for things worth saying out loud. */
  function toast(message, { kind = "info", ms = 3200 } = {}) {
    const el = $("bc-ide-toast");
    if (!el || !message) return;
    el.textContent = message;
    el.dataset.kind = kind;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------------------------------------------------------------------------
  // Terminal palette (xterm can't read CSS variables itself)
  // ---------------------------------------------------------------------------
  const ANSI_DARK = {
    black: "#3b3b47", red: "#f4787a", green: "#8ee08a", yellow: "#e8cf7d",
    blue: "#82a9f7", magenta: "#c79df0", cyan: "#7fd6d1", white: "#d9d5e6",
    brightBlack: "#6b6880", brightRed: "#ff9b9d", brightGreen: "#a9f0a5",
    brightYellow: "#f5e39b", brightBlue: "#a3c2ff", brightMagenta: "#dcbcff",
    brightCyan: "#a2e8e4", brightWhite: "#f6f4ff",
  };
  const ANSI_LIGHT = {
    black: "#2f2f38", red: "#c0392b", green: "#217a3d", yellow: "#8a6a12",
    blue: "#2b5fb8", magenta: "#7d3fa8", cyan: "#1f7a75", white: "#5c5a68",
    brightBlack: "#87859a", brightRed: "#e05548", brightGreen: "#2f9c52",
    brightYellow: "#a9821c", brightBlue: "#3d78d8", brightMagenta: "#9a55c9",
    brightCyan: "#2a9a94", brightWhite: "#1a1a20",
  };
  function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }
  function isColorLight(color) {
    let r, g, b;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color || "");
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
      const n = parseInt(h, 16);
      r = (n >> 16) & 0xff; g = (n >> 8) & 0xff; b = n & 0xff;
    } else {
      const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color || "");
      if (!rgb) return false;
      r = Number(rgb[1]); g = Number(rgb[2]); b = Number(rgb[3]);
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 >= 0.5;
  }
  function terminalThemeFromCSSVars() {
    const bg = cssVar("--bc-bg", "#120d1f");
    const fg = cssVar("--bc-text", "#ece7fb");
    const accent = cssVar("--bc-accent", "#8b5cf6");
    const danger = cssVar("--bc-danger", "#ef4444");
    const ansi = isColorLight(bg) ? ANSI_LIGHT : ANSI_DARK;
    return Object.assign({}, ansi, {
      background: bg,
      foreground: fg,
      cursor: accent,
      cursorAccent: bg,
      selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}59` : "rgba(96,89,230,.35)",
      red: danger,
      brightRed: danger,
    });
  }
  /** A real font stack for xterm — it can't resolve `var(--…)`. */
  function codeFontStack() {
    return cssVar("--bc-code-font", "") || "SFMono-Regular, Menlo, Consolas, monospace";
  }

  // ---------------------------------------------------------------------------
  // While-Claude-is-working snake (playful.snakeWhileWaiting)
  // ---------------------------------------------------------------------------
  let wasWaitingBusy = false;
  const waitingGame = window.BetterClaudeSnake
    ? window.BetterClaudeSnake.createWaitingSnake({
        readConfig: () => ({
          masterEnabled: !(latestSettings && latestSettings.general && latestSettings.general.enabled === false),
          snakeWhileWaiting: !!(latestSettings && latestSettings.playful && latestSettings.playful.snakeWhileWaiting),
          snakeDelayMs: (latestSettings && latestSettings.playful && latestSettings.playful.snakeDelayMs) || 2000,
        }),
      })
    : null;
  setInterval(() => {
    if (!waitingGame) return;
    // Waiting on YOUR approval isn't "Claude is busy" — no game over a card.
    const busy = records.some((r) => r.busy && !r.waiting);
    if (busy !== wasWaitingBusy) {
      wasWaitingBusy = busy;
      waitingGame.setWorking(busy);
    }
  }, 400);

  // ---------------------------------------------------------------------------
  // Sidebar: projects with their sessions
  // ---------------------------------------------------------------------------
  const projectName = (cwd) => {
    const p = projects.find((x) => x.cwd === cwd);
    return p ? p.name : (String(cwd || "").split("/").filter(Boolean).pop() || cwd);
  };

  function saveExpanded() { store.set("bc-ide-expanded", JSON.stringify(Array.from(expanded))); }

  async function loadSessions(cwd, { force = false } = {}) {
    if (!force && sessionsByCwd.has(cwd)) return sessionsByCwd.get(cwd);
    try {
      const list = (await api.listSessions(cwd)) || [];
      list.sort((a, b) => (Date.parse(b.lastTimestamp || "") || 0) - (Date.parse(a.lastTimestamp || "") || 0));
      sessionsByCwd.set(cwd, list);
    } catch {
      sessionsByCwd.set(cwd, []);
    }
    return sessionsByCwd.get(cwd);
  }

  /** Saved sessions plus live records that aren't on disk yet, newest first. */
  function sessionRowsFor(cwd) {
    const saved = sessionsByCwd.get(cwd) || [];
    const rows = saved.map((s) => ({ kind: "saved", sessionId: s.sessionId, title: s.title || `Session ${s.sessionId.slice(0, 8)}`, when: s.lastTimestamp }));
    records.filter((r) => r.cwd === cwd).forEach((r) => {
      const hit = r.sessionId && rows.find((row) => row.sessionId === r.sessionId);
      if (hit) { hit.record = r; if (r.title && r.title !== "New session") hit.title = r.title; return; }
      if (!r.transcript.isEmpty() || r.tabId === activeTabId || (r.draft && r.draft.text.trim())) rows.unshift({ kind: "live", record: r, title: r.title || "New session", when: new Date(r.viewedAt || Date.now()).toISOString() });
    });
    return rows;
  }

  function sessionGlyph(record) {
    if (!record) return "";
    if (record.waiting) return '<span class="bc-ide-glyph is-waiting" title="Needs your input">!</span>';
    if (record.busy) return '<span class="bc-ide-glyph is-busy" title="Working"></span>';
    if (record.unread) return '<span class="bc-ide-glyph is-unread" title="New reply"></span>';
    return "";
  }

  function renderSidebar() {
    const nav = $("bc-ide-projects");
    if (!nav) return;
    nav.textContent = "";
    const q = searchQuery.trim().toLowerCase();
    if (!projects.length) {
      nav.innerHTML = `<div class="bc-ide-side-empty"><strong>No projects yet</strong><span>Add a folder to start a Claude Code session in it.</span></div>`;
      return;
    }
    let visibleIndex = 0;
    projects.forEach((project) => {
      const rows = sessionRowsFor(project.cwd);
      const nameMatch = q && project.name.toLowerCase().includes(q);
      // Searching a project's name lists its sessions, not "No matching sessions".
      const matches = q && !nameMatch ? rows.filter((r) => r.title.toLowerCase().includes(q)) : rows;
      if (q && !matches.length && !nameMatch) return;
      const isOpen = q ? true : expanded.has(project.cwd);
      const group = document.createElement("section");
      group.className = "bc-ide-project" + (activeProject && activeProject.cwd === project.cwd ? " is-active" : "");
      const head = document.createElement("div");
      head.className = "bc-ide-project-head";
      head.innerHTML = `<button type="button" class="bc-ide-project-toggle" aria-expanded="${isOpen}"><span class="bc-ide-chev${isOpen ? " is-open" : ""}">${icon("CHEVRON")}</span><span class="bc-ide-project-name"></span></button><button type="button" class="bc-ide-project-new" title="New session in this project" aria-label="New session in this project">${icon("PLUS")}</button>`;
      head.querySelector(".bc-ide-project-name").textContent = project.name;
      head.title = shortPath(project.cwd);
      head.querySelector(".bc-ide-project-toggle").addEventListener("click", async () => {
        if (expanded.has(project.cwd)) expanded.delete(project.cwd);
        else { expanded.add(project.cwd); await loadSessions(project.cwd); }
        saveExpanded();
        // Expanding a project is browsing, not switching: the open
        // conversation keeps its project. Retargeting activeProject here
        // relabelled that conversation with this project's name, and the
        // next send quietly went to a new session over here instead. Only
        // a blank, untouched session follows the click.
        const r = activeRecord();
        if (!r || (!r.sessionId && r.transcript.isEmpty() && !r.busy)) await selectProject(project.cwd);
        renderSidebar();
      });
      head.querySelector(".bc-ide-project-new").addEventListener("click", async () => {
        await selectProject(project.cwd, { quiet: true });
        newSession();
      });
      group.appendChild(head);
      if (isOpen) {
        const list = document.createElement("div");
        list.className = "bc-ide-session-list";
        if (!sessionsByCwd.has(project.cwd)) {
          list.innerHTML = '<div class="bc-ide-session-empty">Loading…</div>';
          loadSessions(project.cwd).then(renderSidebar);
        } else if (!matches.length) {
          list.innerHTML = `<div class="bc-ide-session-empty">${q && !nameMatch ? "No matching sessions" : "No sessions yet"}</div>`;
        } else {
          const limit = q || showAll.has(project.cwd) ? Infinity : 5;
          matches.slice(0, limit).forEach((row) => {
            const record = row.record || null;
            const isActive = record ? record.tabId === activeTabId : false;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "bc-ide-session" + (isActive ? " is-active" : "");
            btn.dataset.index = String(++visibleIndex);
            btn.innerHTML = `<span class="bc-ide-session-glyph">${sessionGlyph(record)}</span><span class="bc-ide-session-title"></span><span class="bc-ide-session-when"></span>`;
            btn.querySelector(".bc-ide-session-title").textContent = row.title;
            btn.querySelector(".bc-ide-session-when").textContent = record && record.busy ? "" : relativeTime(row.when);
            btn.title = row.title;
            btn.addEventListener("click", () => {
              if (record) activate(record.tabId);
              else openSavedSession(project.cwd, row.sessionId, row.title);
            });
            list.appendChild(btn);
          });
          if (matches.length > limit) {
            const more = document.createElement("button");
            more.type = "button";
            more.className = "bc-ide-session-more";
            more.textContent = `Show ${matches.length - limit} more`;
            more.addEventListener("click", () => { showAll.add(project.cwd); renderSidebar(); });
            list.appendChild(more);
          }
        }
        group.appendChild(list);
      }
      nav.appendChild(group);
    });
    renderAgents(nav, q);
    if (q && !nav.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "bc-ide-side-empty";
      empty.textContent = "No projects or sessions match.";
      nav.appendChild(empty);
    }
  }

  function renderAgents(nav, q = "") {
    const shown = q
      ? agents.filter((a) => [a.name, a.sessionId, a.cwd, projectName(a.cwd || "")].some((v) => String(v || "").toLowerCase().includes(q)))
      : agents;
    if (!shown.length) return;
    const group = document.createElement("section");
    group.className = "bc-ide-project bc-ide-agents";
    group.innerHTML = `<div class="bc-ide-project-head"><span class="bc-ide-project-label">Running in other terminals</span></div>`;
    const list = document.createElement("div");
    list.className = "bc-ide-session-list";
    shown.forEach((agent) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bc-ide-session";
      btn.innerHTML = `<span class="bc-ide-session-glyph"><span class="bc-ide-glyph is-busy"></span></span><span class="bc-ide-session-title"></span><span class="bc-ide-session-when"></span>`;
      btn.querySelector(".bc-ide-session-title").textContent = agent.name || (agent.sessionId || "").slice(0, 8);
      btn.querySelector(".bc-ide-session-when").textContent = projectName(agent.cwd || "");
      btn.title = `Attach in the Terminal panel · ${agent.cwd || ""}`;
      btn.addEventListener("click", () => attachAgent(agent));
      list.appendChild(btn);
    });
    group.appendChild(list);
    nav.appendChild(group);
  }

  // ---------------------------------------------------------------------------
  // Conversations (records)
  // ---------------------------------------------------------------------------
  const MODE_CHOICES_BASE = [
    { id: "ask", label: "Ask", hint: "Ask before edits and commands" },
    { id: "acceptEdits", label: "Accept edits", hint: "Edit files freely, ask before commands" },
    { id: "plan", label: "Plan", hint: "Read and plan only — you approve the plan" },
    { id: "auto", label: "Auto", hint: "Claude Code's safety classifier decides" },
  ];
  const BYPASS_CHOICE = { id: "bypass", label: "Bypass", hint: "Run everything without asking — risky" };
  const modeChoices = () => (latestSettings && latestSettings.codeWindow && latestSettings.codeWindow.chat && latestSettings.codeWindow.chat.allowBypassMode ? [...MODE_CHOICES_BASE, BYPASS_CHOICE] : MODE_CHOICES_BASE);
  const CLI_TO_MODE = { default: "ask", manual: "ask", dontAsk: "ask", acceptEdits: "acceptEdits", plan: "plan", auto: "auto", bypassPermissions: "bypass" };
  // New sessions start in the last Ask / Accept edits / Auto choice. Plan and
  // Bypass are per-session: a fresh session that silently only plans, or runs
  // everything unasked, because of a choice made for some earlier task is a
  // surprise either way.
  const PER_SESSION_MODES = new Set(["plan", "bypass"]);
  let defaultMode = (() => {
    let m = store.get("bc-ide-perm-mode", "acceptEdits");
    if (m === "manual") m = "ask";
    if (m === "normal") m = "acceptEdits";
    return MODE_CHOICES_BASE.some((c) => c.id === m) && !PER_SESSION_MODES.has(m) ? m : "acceptEdits";
  })();

  function makeRecord({ cwd, sessionId = null, title = "New session" }) {
    const tabId = `tab-${++tabSeq}-${Date.now().toString(36)}`;
    const host = document.createElement("div");
    host.className = "bc-ide-convo";
    host.hidden = true;
    $("bc-ide-chat-messages").appendChild(host);
    const record = {
      tabId, cwd, sessionId, title, host,
      permMode: defaultMode,
      busy: false, waiting: 0, unread: false,
      titleGenerated: !!sessionId, firstPrompt: "",
      modelId: null, subscription: null, apiKeySource: null,
      viewedAt: Date.now(),
      transcript: null,
    };
    record.transcript = Transcript.create(host, {
      icon,
      onContent: () => { if (record.tabId === activeTabId) { renderEmptyState(); stickToBottom(); } },
      // In the full-IDE layout files open in the workbench editor, and an
      // edit can be reviewed in its diff editor.
      onOpenFile: (filePath) => (shell.dataset.layout === "ide" && api.workbench ? api.workbench.openFile(filePath) : openFileInPanel(filePath, record.cwd)),
      onReviewFile: (filePath) => (shell.dataset.layout === "ide" && api.workbench ? api.workbench.diff(filePath) : openPanel("changes")),
    });
    records.push(record);
    evictRecords();
    return record;
  }

  function evictRecords() {
    if (records.length <= MAX_OPEN_RECORDS) return;
    const idle = records
      .filter((r) => !r.busy && !r.waiting && r.tabId !== activeTabId && !(r.draft && (r.draft.text.trim() || r.draft.attachments.length)))
      .sort((a, b) => a.viewedAt - b.viewedAt);
    while (records.length > MAX_OPEN_RECORDS && idle.length) {
      const r = idle.shift();
      api.disposeChat(r.tabId);
      r.host.remove();
      records.splice(records.indexOf(r), 1);
    }
  }

  let stickToBottomWanted = true;
  function stickToBottom(force = false) {
    const scroller = $("bc-ide-chat-scroll");
    if (!scroller) return;
    if (force || stickToBottomWanted) scroller.scrollTop = scroller.scrollHeight;
  }
  on("bc-ide-chat-scroll", "scroll", () => {
    const s = $("bc-ide-chat-scroll");
    stickToBottomWanted = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
  }, { passive: true });

  function activate(tabId) {
    const record = recordByTab(tabId);
    if (!record) return;
    // Each conversation keeps its own unsent draft (text + attached files).
    // With one shared composer, a prompt written for one session went to
    // whichever session was active when Enter was pressed.
    const previous = recordByTab(activeTabId);
    if (previous && previous !== record) {
      const input = $("bc-ide-chat-input");
      previous.draft = { text: input.value, attachments: selectedAttachments };
      input.value = record.draft ? record.draft.text : "";
      selectedAttachments = record.draft ? record.draft.attachments : [];
      record.draft = null;
      autosizeComposer();
      renderAttachments();
    }
    activeTabId = tabId;
    record.viewedAt = Date.now();
    record.unread = false;
    records.forEach((r) => { r.host.hidden = r !== record; });
    if (!activeProject || activeProject.cwd !== record.cwd) selectProject(record.cwd, { quiet: true });
    syncChrome();
    renderSidebar();
    // The active project can sit far down a long project list — keep its row
    // in view (only here, on a switch; renders elsewhere never move the list).
    const activeRow = document.querySelector(".bc-ide-session.is-active");
    if (activeRow) activeRow.scrollIntoView({ block: "nearest" });
    stickToBottomWanted = true;
    requestAnimationFrame(() => stickToBottom(true));
    const pending = record.transcript.pendingCard();
    if (pending) pending.focus({ preventScroll: true });
    else $("bc-ide-chat-input").focus();
  }

  function newSession() {
    if (!activeProject) { toast("Add a project folder first."); return null; }
    // Reuse an untouched new session in this project instead of piling up blanks.
    const blank = records.find((r) => r.cwd === activeProject.cwd && !r.sessionId && r.transcript.isEmpty() && !r.busy);
    const record = blank || makeRecord({ cwd: activeProject.cwd });
    activate(record.tabId);
    return record;
  }

  async function openSavedSession(cwd, sessionId, title) {
    const existing = records.find((r) => r.sessionId === sessionId);
    if (existing) { activate(existing.tabId); return; }
    const record = makeRecord({ cwd, sessionId, title: title || "Session" });
    record.loading = true;
    record.transcript.welcome('<div class="bc-t-loading">Loading conversation…</div>');
    activate(record.tabId);
    try {
      const result = await api.readSession(cwd, sessionId);
      // Fill only a transcript still showing the placeholder — loadTurns
      // replaces everything, including a turn that started meanwhile.
      if (!record.transcript.isEmpty()) return;
      const turns = (result && result.turns) || [];
      if (!turns.length) record.transcript.welcome(`<div class="bc-t-loading">${escapeHtml((result && result.error) || "This conversation is empty.")}</div>`);
      else record.transcript.loadTurns(turns);
      if (record.tabId === activeTabId) {
        syncChrome();
        requestAnimationFrame(() => stickToBottom(true));
      }
    } catch (error) {
      if (record.transcript.isEmpty()) record.transcript.welcome(`<div class="bc-t-loading">${escapeHtml(error.message || "Could not load that conversation.")}</div>`);
    } finally {
      record.loading = false;
    }
  }

  /** Top bar, composer chips, empty state — everything that follows the active conversation. */
  function syncChrome() {
    const r = activeRecord();
    $("bc-ide-session-title").textContent = r ? (r.title || "New session") : "Claude Code";
    const branch = scmInfo && scmInfo.branch ? ` › ${scmInfo.branch}` : "";
    $("bc-ide-session-meta").textContent = activeProject ? `${activeProject.name}${branch}` : "";
    const tag = $("bc-ide-plan-tag");
    if (r && r.subscription === true) {
      tag.hidden = false; tag.dataset.kind = "plan"; tag.textContent = "Claude plan";
      tag.title = "This conversation runs on your Claude subscription and counts toward its usage.";
    } else if (r && r.subscription === false) {
      tag.hidden = false; tag.dataset.kind = "key"; tag.textContent = "API key";
      tag.title = `Billing an API key (${r.apiKeySource}) — not your Claude plan.`;
    } else {
      tag.hidden = true;
    }
    syncModeChip();
    syncComposerBusy();
    renderEmptyState();
    pushWorkbenchStatus();
  }

  function renderEmptyState() {
    const r = activeRecord();
    const empty = $("bc-ide-empty");
    const show = !r || (r.transcript.isEmpty() && !r.host.querySelector(".bc-t-welcome"));
    empty.hidden = !show;
    if (!show) return;
    if (!activeProject) {
      $("bc-ide-empty-title").textContent = projects.length ? "Pick a project" : "Start with a project";
      $("bc-ide-empty-sub").textContent = "Claude Code works inside a folder — reading, editing and running things with your approval.";
      const host = $("bc-ide-empty-recent");
      host.innerHTML = `<button type="button" class="bc-ide-btn bc-ide-btn-primary" data-empty-add>Add project folder</button>`;
      host.querySelector("[data-empty-add]").addEventListener("click", () => api.pickFolder());
      return;
    }
    $("bc-ide-empty-title").textContent = `What should we build in ${activeProject.name}?`;
    const bits = [shortPath(activeProject.cwd)];
    if (scmInfo && scmInfo.branch) bits.push(`on ${scmInfo.branch}`);
    $("bc-ide-empty-sub").textContent = bits.join(" ");
    const recent = (sessionsByCwd.get(activeProject.cwd) || []).slice(0, 3);
    const host = $("bc-ide-empty-recent");
    host.textContent = "";
    if (recent.length) {
      const label = document.createElement("div");
      label.className = "bc-ide-empty-label";
      label.textContent = "Pick up where you left off";
      host.appendChild(label);
      recent.forEach((s) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "bc-ide-empty-row";
        b.innerHTML = `<span class="bc-ide-empty-row-title"></span><span class="bc-ide-empty-row-when"></span>`;
        b.querySelector(".bc-ide-empty-row-title").textContent = s.title || `Session ${s.sessionId.slice(0, 8)}`;
        b.querySelector(".bc-ide-empty-row-when").textContent = relativeTime(s.lastTimestamp);
        b.addEventListener("click", () => openSavedSession(activeProject.cwd, s.sessionId, s.title));
        host.appendChild(b);
      });
    }
  }

  function syncComposerBusy() {
    const r = activeRecord();
    const busy = !!(r && r.busy);
    $("bc-ide-chat-stop").hidden = !busy;
    $("bc-ide-send").hidden = busy;
    $("bc-ide-chat-form").dataset.busy = busy ? "true" : "false";
    pushWorkbenchStatus();
  }

  function syncModeChip() {
    const r = activeRecord();
    const mode = r ? r.permMode : defaultMode;
    const choice = modeChoices().find((c) => c.id === mode) || MODE_CHOICES_BASE[1];
    const chip = $("bc-ide-mode-btn");
    chip.textContent = choice.label;
    chip.dataset.mode = choice.id;
    chip.title = `${choice.label} — ${choice.hint} (⌘⇧M)`;
    pushWorkbenchStatus();
  }

  function setPermMode(next) {
    if (!modeChoices().some((c) => c.id === next)) return;
    if (!PER_SESSION_MODES.has(next)) {
      defaultMode = next;
      store.set("bc-ide-perm-mode", next);
    }
    // A per-session mode needs a session to hold it (the empty state has none yet).
    const r = activeRecord() || (PER_SESSION_MODES.has(next) && activeProject ? newSession() : null);
    if (r) r.permMode = next;
    syncModeChip();
    if (r && r.busy) toast("The new mode applies from your next message.");
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------
  function autosizeComposer() {
    const input = $("bc-ide-chat-input");
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }

  async function sendChatMessage(event) {
    if (event) event.preventDefault();
    const input = $("bc-ide-chat-input");
    const prompt = input.value.trim();
    if (!prompt) return;
    if (!activeProject) { toast("Add a project folder first."); return; }

    // Slash commands that only exist in the interactive CLI — answer locally.
    const local = prompt.match(/^\/(model|cost|usage|context|pr)\b/i);
    if (local) {
      input.value = "";
      autosizeComposer();
      const cmd = local[1].toLowerCase();
      if (cmd === "model") openModelMenu();
      else if (cmd === "pr") openPanel("changes");
      else openUsagePop();
      return;
    }

    let r = activeRecord();
    if (!r || r.cwd !== activeProject.cwd) r = newSession();
    if (!r) return;
    if (r.busy) { toast("Claude is still working on this one — press Esc to stop it, or start a new session."); return; }
    if (r.loading) { toast("Still loading this conversation — send again in a moment."); return; }

    const sendModel = effectiveSelectedModel();
    if (!sendModel) return;
    const attachments = selectedAttachments.slice();
    const history = sendModel === "claude" ? [] : r.transcript.history();
    r.transcript.userMessage(prompt, { attachments: attachments.map((f) => f.path) });
    if (!r.firstPrompt) r.firstPrompt = prompt;
    r.lastPrompt = prompt;
    if (!r.title || r.title === "New session") {
      // Provisional until the AI title lands (maybeNameSession).
      const flat = prompt.replace(/\s+/g, " ").trim();
      r.title = flat.length > 60 ? `${flat.slice(0, 59).replace(/\s+\S*$/, "")}…` : flat;
    }
    r.busy = true;
    // The engine's `start` says "Starting Claude Code…" when it had to spawn.
    r.transcript.setWorking("Thinking…");
    input.value = "";
    autosizeComposer();
    selectedAttachments = [];
    renderAttachments();
    stickToBottomWanted = true;
    stickToBottom(true);
    syncChrome();
    renderSidebar();

    try {
      const started = await api.chat({
        cwd: r.cwd,
        prompt,
        attachments,
        history,
        sessionId: r.sessionId,
        model: sendModel,
        claudeModel: sendModel === "claude" ? (claudeModelVariant || null) : null,
        permissionMode: r.permMode,
        tabId: r.tabId,
      });
      if (started && started.error === "busy") {
        // Claude Code began a turn of its own (a background task finished)
        // a moment before this arrived — that turn owns the busy state.
        r.transcript.note("Not sent — Claude was already working in this session. Send it again when it finishes.", "muted");
        if (!input.value.trim()) { input.value = prompt; autosizeComposer(); }
        return;
      }
      // A refused send normally arrives with its own error event first; this
      // only catches one that failed before the engine could say anything.
      if (started !== true) setTimeout(() => { if (r.busy) endTurn(r); }, 400);
    } catch (error) {
      r.transcript.error(error.message || "Claude Code could not start.");
      endTurn(r);
    }
  }

  function endTurn(r) {
    r.busy = false;
    r.waiting = 0;
    r.transcript.endTurn();
    if (r.tabId !== activeTabId) r.unread = true;
    if (r.tabId === activeTabId) syncComposerBusy();
    renderSidebar();
  }

  // ---------------------------------------------------------------------------
  // Chat events from the engine (electron/ide-chat.js) and the free chain
  // ---------------------------------------------------------------------------
  const prettyModel = (id) => {
    if (!id || id === "claude") return "Claude";
    const m = /claude-?(opus|sonnet|haiku|fable)-?(\d+)?[-.]?(\d+)?/i.exec(id);
    if (!m) return id;
    const fam = m[1][0].toUpperCase() + m[1].slice(1);
    return `${fam}${m[2] ? ` ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ""}` : ""}`;
  };

  // Errors where the prompt never got an answer (stopped before sending, no
  // login, no free model took it…): hand it back so fixing the cause and
  // sending again doesn't mean retyping it.
  const PROMPT_BACK_CODES = new Set(["billing", "auth", "limit", "model", "not-found", "spawn", "free-needs-key", "free-failed"]);
  function restorePrompt(r) {
    if (!r.lastPrompt) return;
    if (r.tabId !== activeTabId) {
      // Not in view: it waits in that conversation's draft.
      if (!r.draft || !r.draft.text.trim()) r.draft = { text: r.lastPrompt, attachments: r.draft ? r.draft.attachments : [] };
      r.lastPrompt = "";
      return;
    }
    const input = $("bc-ide-chat-input");
    if (input.value.trim()) return;
    input.value = r.lastPrompt;
    r.lastPrompt = "";
    autosizeComposer();
  }

  function handleChatEvent(event = {}) {
    // Only events for a known tab — never fall back to "whatever is active",
    // which let a closed tab's late event end a different tab's turn.
    const r = event.tabId ? recordByTab(event.tabId) : null;
    if (!r) return;
    const t = r.transcript;
    switch (event.type) {
      case "start":
        r.busy = true;
        if (event.cold) t.setWorking("Starting Claude Code…");
        if (event.auto) {
          // Claude Code started this turn itself — typically a background
          // task it launched earlier just finished — so there is no prompt of
          // yours above it; say why it's talking.
          t.endTurn();
          t.note(event.reason || "Claude is following up on its own.", "muted");
          t.setWorking("Working…");
        }
        if (r.tabId === activeTabId) syncComposerBusy();
        renderSidebar();
        return;
      case "init": {
        if (event.sessionId) r.sessionId = event.sessionId;
        r.modelId = event.model || r.modelId;
        r.subscription = event.subscription;
        r.apiKeySource = event.apiKeySource;
        const actual = CLI_TO_MODE[event.permissionMode];
        if (actual && actual !== r.permMode) {
          const wanted = r.permMode;
          r.permMode = actual;
          if (wanted === "auto") {
            const label = (modeChoices().find((c) => c.id === actual) || {}).label || actual;
            t.note(`Auto mode isn't available for ${prettyModel(r.modelId)} — using ${label}.`);
          }
        }
        t.setWorking("Thinking…");
        if (r.tabId === activeTabId) syncChrome();
        return;
      }
      case "session":
        if (event.sessionId) r.sessionId = event.sessionId;
        return;
      case "mode":
        if (CLI_TO_MODE[event.permissionMode]) { r.permMode = CLI_TO_MODE[event.permissionMode]; if (r.tabId === activeTabId) syncModeChip(); }
        return;
      case "thinking":
        t.setWorking("Thinking…");
        return;
      case "delta":
        t.delta(event.segment || "free", event.text || "");
        return;
      case "text":
        t.setText(event.segment, event.text || "");
        return;
      case "tool":
        t.tool(event);
        t.setWorking("Working…");
        return;
      case "tool-result":
        t.toolResult(event);
        t.setWorking("Working…");
        return;
      case "permission":
        r.waiting += 1;
        t.permission(event, (answer) => {
          api.respondPermission({ tabId: r.tabId, ...answer }).catch(() => {});
        });
        renderSidebar();
        pushWorkbenchStatus();
        return;
      case "permission-resolved":
      case "permission-cancel":
        r.waiting = Math.max(0, r.waiting - 1);
        t.permissionSettled(event.requestId, event.type === "permission-cancel" ? "cancel" : event.decision);
        if (r.busy && !r.waiting) t.setWorking("Working…");
        renderSidebar();
        pushWorkbenchStatus();
        return;
      case "plan-usage":
        planUsage = event.info || null;
        renderUsageRing();
        return;
      case "model-switch": {
        const label = event.modelLabel || event.modelId;
        r.freeLabel = label;
        const text = `Answering with ${label}${event.keyless ? " (no login)" : ""}…`;
        if (!r.freeNote || !r.freeNote.isConnected) r.freeNote = t.note(text, "free");
        else r.freeNote.textContent = text;
        return;
      }
      case "reset":
        t.resetText();
        return;
      case "note":
        t.note(event.text || "");
        return;
      case "status":
        t.setWorking(event.text || "Working…");
        return;
      case "diagnostic":
        if (r.busy && event.message) t.setWorking(String(event.message).slice(0, 120));
        return;
      case "error": {
        const actions = [];
        if (event.code === "auth") actions.push({ label: "Open the CLI tab", run: () => api.openCli() });
        if (event.code === "billing") {
          if (Array.isArray(event.scopes) && event.scopes.includes("user")) {
            actions.push({ label: "Stop loading my ~/.claude settings", run: async () => { latestSettings = await api.setSetting("codeWindow.chat.loadUserSettings", false); toast("Code chats no longer load ~/.claude/settings.json. Send again."); } });
          }
          actions.push({ label: "Use these settings anyway", run: async () => { latestSettings = await api.setSetting("codeWindow.chat.allowApiKeyBilling", true); toast("Allowed: Code chats may now run on credentials other than your Claude plan. Send again."); } });
        }
        if (event.code === "limit") actions.push({ label: "Pick a free model", run: () => openModelMenu() });
        if (event.code === "free-needs-key") actions.push({ label: "Add a free OpenRouter key", run: () => openModelMenu() });
        if (event.code === "free-needs-key" || event.code === "free-failed") actions.push({ label: "Use Claude instead", run: () => { selectModel("claude", claudeModelVariant); toast("Back on Claude — send again."); } });
        if (event.code === "not-found") actions.push({ label: "Install Claude Code", run: () => window.open("https://docs.claude.com/en/docs/claude-code/overview") });
        // "Answering with X…" is a live status; the error lists what was tried.
        if (r.freeNote && r.freeNote.isConnected) r.freeNote.remove();
        r.freeNote = null;
        t.error(event.message || "Claude could not complete that request.", actions);
        if (PROMPT_BACK_CODES.has(event.code)) restorePrompt(r);
        endTurn(r);
        return;
      }
      case "stopped":
        t.note("Stopped.", "muted");
        endTurn(r);
        return;
      case "done": {
        if (event.sessionId) r.sessionId = event.sessionId;
        // The footer names the model that answered; the live status goes.
        if (r.freeNote && r.freeNote.isConnected) r.freeNote.remove();
        r.freeNote = null;
        const parts = [];
        if (event.free) {
          parts.push(event.modelLabel || r.freeLabel || event.modelId || "Free model", "free · not your Claude plan");
        } else {
          parts.push(`Claude · ${prettyModel(event.modelId)}`);
          const u = event.usage || {};
          const inTok = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
          const outTok = Number(u.output_tokens) || 0;
          if (inTok || outTok) parts.push(`${fmtCompact(inTok)} in · ${fmtCompact(outTok)} out`);
          if (event.durationMs) parts.push(`${(event.durationMs / 1000).toFixed(1)}s`);
          if (typeof event.costUsd === "number" && event.costUsd > 0) {
            const cost = event.costUsd < 0.01 ? event.costUsd.toFixed(4) : event.costUsd.toFixed(3);
            parts.push(event.subscription ? `≈$${cost} API-equivalent · on your plan` : `$${cost}`);
          }
        }
        t.footer(parts.join("  ·  "), { free: !!event.free });
        endTurn(r);
        maybeNameSession(r);
        refreshProjectState(r.cwd);
        loadSessions(r.cwd, { force: true }).then(() => { renderSidebar(); if (r.tabId === activeTabId) syncChrome(); });
        return;
      }
      default:
    }
  }

  async function maybeNameSession(r) {
    if (!r || r.titleGenerated || !r.sessionId) return;
    r.titleGenerated = true;
    try {
      const title = await api.generateSessionTitle({ cwd: r.cwd, sessionId: r.sessionId, prompt: r.firstPrompt || r.transcript.firstUserText(), reply: r.transcript.lastAssistantText() });
      if (title) {
        r.title = title;
        const list = sessionsByCwd.get(r.cwd) || [];
        const row = list.find((s) => s.sessionId === r.sessionId);
        if (row) row.title = title;
        renderSidebar();
        if (r.tabId === activeTabId) syncChrome();
      }
    } catch { /* keep the first-prompt title */ }
  }

  // ---------------------------------------------------------------------------
  // Model picker (Claude plan models + free models)
  // ---------------------------------------------------------------------------
  const MODEL_STORAGE_KEY = "bc-ide-chat-model";
  const CLAUDE_MODEL_KEY = "bc-ide-claude-model";
  const CLAUDE_MODEL_CHOICES = [
    { id: "", label: "Default", hint: "Your plan's default model" },
    { id: "fable", label: "Fable", hint: "Newest, most capable" },
    { id: "opus", label: "Opus", hint: "Deep reasoning, slower" },
    { id: "sonnet", label: "Sonnet", hint: "Balanced — the everyday pick" },
    { id: "haiku", label: "Haiku", hint: "Fastest, lightest" },
  ];
  let selectedModel = store.get(MODEL_STORAGE_KEY, "claude") || "claude";
  let claudeModelVariant = store.get(CLAUDE_MODEL_KEY, "") || "";
  let freeModelsCache = null;
  let freeModelsFetchedAt = 0;
  let freeModelsPromise = null;
  let freeModelsPromiseForced = false;
  // Whether an OpenRouter key is saved (main keeps the key itself in its
  // encrypted secrets store and never sends it here).
  let openRouterKey = { hasKey: false, encrypted: false };
  Promise.resolve(api.openRouterKeyStatus()).then((s) => { if (s) openRouterKey = s; }).catch(() => {});
  const FREE_MODELS_MAX_AGE_MS = 90 * 1000;

  const freeConfig = () => (latestSettings && latestSettings.codeWindow && latestSettings.codeWindow.freeModels) || {};

  function claudeModelLabel() {
    if (!claudeModelVariant) return "Claude";
    const known = CLAUDE_MODEL_CHOICES.find((c) => c.id === claudeModelVariant);
    return known ? known.label : claudeModelVariant;
  }
  function modelLabelFor(id) {
    if (!id || id === "claude") return claudeModelLabel();
    const match = freeModelsCache && freeModelsCache.find((m) => m.id === id);
    return match ? (match.displayName || match.id) : id;
  }
  function formatContext(tokens) {
    if (!tokens) return "";
    if (tokens >= 1000000) return `${Math.round((tokens / 1000000) * 10) / 10}M ctx`;
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}K ctx`;
    return `${tokens} ctx`;
  }

  function ensureFreeModels({ force = false } = {}) {
    const fresh = freeModelsCache && Date.now() - freeModelsFetchedAt < FREE_MODELS_MAX_AGE_MS;
    if (fresh && !force) return Promise.resolve(freeModelsCache);
    if (freeModelsPromise && !(force && !freeModelsPromiseForced)) return freeModelsPromise;
    freeModelsPromiseForced = force;
    freeModelsPromise = Promise.resolve(api.listFreeModels(force))
      .then((models) => {
        freeModelsCache = Array.isArray(models) ? models : [];
        freeModelsFetchedAt = Date.now();
        freeModelsPromise = null;
        updateModelButtonLabel();
        return freeModelsCache;
      })
      .catch(() => {
        freeModelsPromise = null;
        return freeModelsCache || [];
      });
    return freeModelsPromise;
  }

  function closeModelMenu() {
    $("bc-ide-model-menu").hidden = true;
    $("bc-ide-model-btn").setAttribute("aria-expanded", "false");
  }

  function modelRow({ title, sub, selected, badge, badgeKind = "ok", onPick }) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "bc-ide-model-row" + (selected ? " selected" : "");
    row.innerHTML = `<span class="bc-ide-model-copy"><strong></strong><small></small></span>${badge ? `<span class="bc-ide-model-badge"></span>` : ""}<span class="bc-ide-model-check">${icon("CHECK")}</span>`;
    row.querySelector("strong").textContent = title;
    row.querySelector("small").textContent = sub || "";
    if (badge) {
      const b = row.querySelector(".bc-ide-model-badge");
      b.textContent = badge;
      b.dataset.kind = badgeKind;
    }
    row.addEventListener("click", onPick);
    return row;
  }

  function renderModelMenu(models) {
    const menu = $("bc-ide-model-menu");
    menu.textContent = "";
    const config = freeConfig();
    const header = (text, extra) => {
      const h = document.createElement("div");
      h.className = "bc-ide-model-header";
      const label = document.createElement("span");
      label.textContent = text;
      h.appendChild(label);
      if (extra) { h.classList.add("bc-ide-model-header-row"); h.appendChild(extra); }
      menu.appendChild(h);
    };

    header("Claude · your plan");
    const claudeList = document.createElement("div");
    claudeList.className = "bc-ide-model-list";
    CLAUDE_MODEL_CHOICES.forEach((choice) => claudeList.appendChild(modelRow({
      title: choice.label,
      sub: choice.hint,
      selected: selectedModel === "claude" && claudeModelVariant === choice.id,
      onPick: () => selectModel("claude", choice.id),
    })));
    menu.appendChild(claudeList);

    const custom = document.createElement("label");
    custom.className = "bc-ide-model-key";
    custom.textContent = "Other model id";
    const customInput = document.createElement("input");
    customInput.type = "text";
    customInput.placeholder = "e.g. claude-sonnet-5";
    customInput.value = CLAUDE_MODEL_CHOICES.some((c) => c.id === claudeModelVariant) ? "" : claudeModelVariant;
    customInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (customInput.value.trim()) selectModel("claude", customInput.value.trim());
    });
    custom.appendChild(customInput);
    menu.appendChild(custom);

    if (config.enabled === false) {
      const note = document.createElement("div");
      note.className = "bc-ide-model-note";
      note.textContent = "Free models are turned off in settings.";
      menu.appendChild(note);
      return;
    }
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "bc-ide-model-refresh";
    refresh.textContent = "Refresh";
    refresh.addEventListener("click", async (event) => {
      event.stopPropagation();
      refresh.disabled = true;
      refresh.textContent = "…";
      const fresh = await ensureFreeModels({ force: true });
      if (!menu.hidden) renderModelMenu(fresh);
    });
    header("Free models · not your plan", refresh);
    const hasKey = !!openRouterKey.hasKey;
    if (selectedModel !== "claude" && models.length && !models.some((m) => m.id === selectedModel)) {
      const gone = document.createElement("div");
      gone.className = "bc-ide-model-note bc-ide-model-gone";
      gone.textContent = `${modelLabelFor(selectedModel)} is no longer free — pick another.`;
      menu.appendChild(gone);
    }
    const list = document.createElement("div");
    list.className = "bc-ide-model-list";
    const openRouter = models.filter((m) => m.kind === "openrouter");
    const local = models.filter((m) => m.keyless);
    if (!models.length) {
      const note = document.createElement("div");
      note.className = "bc-ide-model-note";
      note.textContent = "Couldn't load the free-model list right now.";
      menu.appendChild(note);
    }
    openRouter.forEach((m) => list.appendChild(modelRow({
      title: m.displayName || m.id,
      sub: [m.provider, formatContext(m.contextLength)].filter(Boolean).join(" · "),
      badge: hasKey ? "FREE" : "NEEDS KEY",
      badgeKind: hasKey ? "ok" : "muted",
      selected: selectedModel === m.id,
      onPick: () => selectModel(m.id),
    })));
    local.forEach((m) => list.appendChild(modelRow({
      title: m.displayName || m.id,
      sub: m.description || m.provider,
      badge: "NO LOGIN",
      selected: selectedModel === m.id,
      onPick: () => selectModel(m.id),
    })));
    menu.appendChild(list);

    const foot = document.createElement("div");
    foot.className = "bc-ide-model-foot";
    const failover = document.createElement("label");
    failover.className = "bc-ide-model-toggle";
    const failCheck = document.createElement("input");
    failCheck.type = "checkbox";
    failCheck.checked = config.autoFailover !== false;
    failCheck.addEventListener("change", () => { api.setSetting("codeWindow.freeModels.autoFailover", failCheck.checked).then((u) => { latestSettings = u; }).catch(() => {}); });
    failover.append(failCheck, document.createTextNode("Switch to a free model when Claude hits its limit"));
    foot.appendChild(failover);
    const keyWrap = document.createElement("label");
    keyWrap.className = "bc-ide-model-key";
    keyWrap.innerHTML = 'OpenRouter key <span class="bc-ide-muted">— free at openrouter.ai/keys; needed to run its free models</span>';
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    // Write-only: the saved key never comes back into this page.
    keyInput.placeholder = hasKey ? `Saved${openRouterKey.encrypted ? " in your keychain" : ""} — paste a new one to replace it` : "sk-or-…";
    keyInput.value = "";
    let keyTimer = null;
    keyInput.addEventListener("input", () => {
      clearTimeout(keyTimer);
      const value = keyInput.value.trim();
      if (!value) return; // removing a key is the explicit button, not an emptied field
      keyTimer = setTimeout(() => {
        api.setOpenRouterKey(value).then((status) => {
          openRouterKey = status || openRouterKey;
          keyInput.value = "";
          toast("OpenRouter key saved.");
          if (!menu.hidden) renderModelMenu(freeModelsCache || []);
        }).catch(() => toast("Couldn't save that key.", { kind: "error" }));
      }, 600);
    });
    keyWrap.appendChild(keyInput);
    if (hasKey) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "bc-ide-link-btn";
      remove.textContent = "Remove key";
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        api.setOpenRouterKey("").then((status) => {
          openRouterKey = status || { hasKey: false, encrypted: false };
          toast("OpenRouter key removed.");
          if (!menu.hidden) renderModelMenu(freeModelsCache || []);
        }).catch(() => {});
      });
      keyWrap.appendChild(remove);
    }
    foot.appendChild(keyWrap);
    menu.appendChild(foot);
  }

  async function openModelMenu() {
    closePopMenus();
    const menu = $("bc-ide-model-menu");
    menu.hidden = false;
    $("bc-ide-model-btn").setAttribute("aria-expanded", "true");
    renderModelMenu(freeModelsCache || []);
    wireMenuKeys(menu, ".bc-ide-model-row", $("bc-ide-model-btn"), closeModelMenu);
    const models = await ensureFreeModels();
    const typing = menu.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName || "");
    if (!menu.hidden && !typing) {
      // The re-render replaces the rows — keep keyboard focus inside the menu.
      const hadFocus = menu.contains(document.activeElement) || document.activeElement === document.body;
      renderModelMenu(models);
      if (hadFocus) wireMenuKeys(menu, ".bc-ide-model-row", $("bc-ide-model-btn"), closeModelMenu);
    }
  }

  function selectModel(id, variant) {
    selectedModel = id || "claude";
    if (selectedModel === "claude") {
      claudeModelVariant = typeof variant === "string" ? variant.trim().slice(0, 80) : claudeModelVariant;
      store.set(CLAUDE_MODEL_KEY, claudeModelVariant);
    } else {
      // Also the model auto-failover tries first (freeModels.preferredModelId).
      api.setSetting("codeWindow.freeModels.preferredModelId", selectedModel).then((u) => { latestSettings = u; }).catch(() => {});
    }
    store.set(MODEL_STORAGE_KEY, selectedModel);
    updateModelButtonLabel();
    closeModelMenu();
  }

  /** The model for the next send, or null when the pick can't be used. */
  function effectiveSelectedModel() {
    if (selectedModel === "claude") return "claude";
    if (freeConfig().enabled === false) { toast("Free models are off in settings — pick a Claude model."); openModelMenu(); return null; }
    // Never quietly route a free pick to the user's Claude plan.
    if (freeModelsCache && freeModelsCache.length && !freeModelsCache.some((m) => m.id === selectedModel)) {
      toast(`${modelLabelFor(selectedModel)} is no longer free — pick another model.`);
      openModelMenu();
      return null;
    }
    return selectedModel;
  }

  function updateModelButtonLabel() {
    const button = $("bc-ide-model-btn");
    if (!button) return;
    const full = modelLabelFor(selectedModel);
    button.textContent = full.length > 24 ? `${full.slice(0, 23)}…` : full;
    button.dataset.free = selectedModel === "claude" ? "false" : "true";
    button.title = selectedModel === "claude"
      ? `Claude Code on your plan (${claudeModelVariant || "default model"})`
      : `${full} — a free model, not your Claude plan`;
    pushWorkbenchStatus();
  }

  // ---------------------------------------------------------------------------
  // Composer menus: +, mode, slash, attachments, mic
  // ---------------------------------------------------------------------------
  function closePopMenus(except) {
    ["bc-ide-plus-menu", "bc-ide-mode-menu", "bc-ide-pr-menu", "bc-ide-more-menu"].forEach((id) => { if (id !== except) { const el = $(id); if (el) el.hidden = true; } });
    ["bc-ide-plus", "bc-ide-mode-btn", "bc-ide-pr-more", "bc-ide-more"].forEach((id) => { const b = $(id); if (b) b.setAttribute("aria-expanded", "false"); });
    if (except !== "bc-ide-usage-pop") { $("bc-ide-usage-pop").hidden = true; $("bc-ide-usage-btn").setAttribute("aria-expanded", "false"); }
  }

  /**
   * Keyboard for a pop-up menu (the WAI-ARIA menu-button pattern): focus lands
   * on the selected row (or the first), ↑/↓/Home/End move between rows, Esc
   * closes and hands focus back to the button that opened it. Without this a
   * keyboard user could open the mode or model menu but not pick from it.
   */
  function wireMenuKeys(menu, rowSelector, trigger, close) {
    const rows = () => Array.from(menu.querySelectorAll(rowSelector)).filter((b) => !b.disabled);
    const first = rows();
    const start = first.find((b) => b.classList.contains("selected")) || first[0];
    if (start) start.focus({ preventScroll: true });
    menu.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        if (trigger) trigger.focus();
        return;
      }
      // Arrow keys stay with a text field (the model menu has two).
      if (/^(INPUT|TEXTAREA)$/.test((document.activeElement && document.activeElement.tagName) || "")) return;
      const items = rows();
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const next = event.key === "ArrowDown" ? items[(i + 1) % items.length]
        : event.key === "ArrowUp" ? items[(i - 1 + items.length) % items.length]
        : event.key === "Home" ? items[0]
        : event.key === "End" ? items[items.length - 1]
        : null;
      if (next) { event.preventDefault(); next.focus(); }
    };
  }

  function popMenu(menuId, buttonId, rows) {
    const menu = $(menuId);
    const opening = menu.hidden;
    closePopMenus(opening ? menuId : null);
    closeModelMenu();
    if (!opening) return;
    menu.textContent = "";
    rows.forEach((r) => {
      if (r.divider) { const hr = document.createElement("div"); hr.className = "bc-ide-pop-divider"; hr.setAttribute("role", "separator"); menu.appendChild(hr); return; }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bc-ide-pop-row" + (r.selected ? " selected" : "") + (r.danger ? " is-danger" : "");
      // A row that can be "the current one" (a mode) is a radio item.
      if (typeof r.selected === "boolean") { b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(r.selected)); }
      else b.setAttribute("role", "menuitem");
      b.disabled = !!r.disabled;
      b.innerHTML = `${r.icon ? icon(r.icon) : ""}<span><strong></strong>${r.hint ? "<small></small>" : ""}</span>`;
      b.querySelector("strong").textContent = r.label;
      if (r.hint) b.querySelector("small").textContent = r.hint;
      b.addEventListener("click", () => { closePopMenus(); r.run(); });
      menu.appendChild(b);
    });
    menu.hidden = false;
    $(buttonId).setAttribute("aria-expanded", "true");
    wireMenuKeys(menu, ".bc-ide-pop-row", $(buttonId), () => closePopMenus());
  }

  function togglePlusMenu() {
    popMenu("bc-ide-plus-menu", "bc-ide-plus", [
      { icon: "ATTACH", label: "Attach project files", hint: "Add file contents to this message", run: attachProjectFiles },
      { icon: "CODE_SLASH", label: "Slash command", hint: "/compact, /review, /init…", run: () => { const i = $("bc-ide-chat-input"); if (!i.value.startsWith("/")) i.value = "/"; i.focus(); slashIndex = 0; refreshSlashMenu(); } },
    ]);
  }

  function toggleModeMenu() {
    const r = activeRecord();
    const current = r ? r.permMode : defaultMode;
    popMenu("bc-ide-mode-menu", "bc-ide-mode-btn", modeChoices().map((c) => ({ label: c.label, hint: c.hint, selected: c.id === current, danger: c.id === "bypass", run: () => setPermMode(c.id) })));
  }

  async function attachProjectFiles() {
    if (!activeProject) return;
    try {
      const files = await api.pickFiles(activeProject.cwd);
      selectedAttachments = (files || []).filter((f) => !f.binary && typeof f.content === "string");
      renderAttachments();
    } catch (error) {
      toast(error.message || "Could not attach those files.", { kind: "error" });
    }
  }

  function renderAttachments() {
    const host = $("bc-ide-chat-attachments");
    host.textContent = "";
    host.hidden = selectedAttachments.length === 0;
    selectedAttachments.forEach((file, i) => {
      const chip = document.createElement("span");
      chip.className = "bc-ide-attachment-chip";
      chip.innerHTML = `<span></span><button type="button" aria-label="Remove">${icon("CLOSE")}</button>`;
      chip.querySelector("span").textContent = file.path;
      chip.querySelector("button").addEventListener("click", () => { selectedAttachments.splice(i, 1); renderAttachments(); });
      host.appendChild(chip);
    });
  }

  const SLASH_COMMANDS = [
    { name: "/compact", blurb: "Summarise the conversation to free up context" },
    { name: "/review", blurb: "Review the current changes" },
    { name: "/init", blurb: "Create or refresh CLAUDE.md" },
    { name: "/model", blurb: "Switch model (opens the picker)" },
    { name: "/usage", blurb: "Plan usage (opens the usage panel)" },
    { name: "/pr", blurb: "Review changes and open a pull request" },
  ];
  let slashIndex = 0;
  function slashCandidates(fragment) {
    const q = fragment.replace(/^\//, "").toLowerCase();
    const prompts = ((latestSettings && latestSettings.promptLibrary && latestSettings.promptLibrary.prompts) || [])
      .map((p) => ({ name: `/${(p.title || "prompt").replace(/\s+/g, "-").toLowerCase()}`, blurb: "Prompt library", body: p.body || p.text || "" }));
    return [...SLASH_COMMANDS, ...prompts].filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, 8);
  }
  function refreshSlashMenu() {
    const input = $("bc-ide-chat-input");
    const menu = $("bc-ide-slash-menu");
    const value = input.value;
    if (!value.startsWith("/") || value.includes("\n") || value.includes(" ")) { menu.hidden = true; return; }
    const items = slashCandidates(value);
    if (!items.length) { menu.hidden = true; return; }
    if (slashIndex >= items.length) slashIndex = 0;
    menu.textContent = "";
    items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "bc-ide-slash-row" + (i === slashIndex ? " active" : "");
      row.innerHTML = "<strong></strong><small></small>";
      row.querySelector("strong").textContent = item.name;
      row.querySelector("small").textContent = item.blurb;
      row.addEventListener("mousedown", (e) => { e.preventDefault(); pickSlash(item); });
      menu.appendChild(row);
    });
    menu.hidden = false;
    menu.dataset.count = String(items.length);
  }
  function pickSlash(item) {
    const input = $("bc-ide-chat-input");
    input.value = item.body ? item.body : `${item.name} `;
    $("bc-ide-slash-menu").hidden = true;
    input.focus();
    autosizeComposer();
  }

  // Push-to-talk (macOS, whisper.cpp — see electron/speech.js)
  let micStream = null;
  let micNodes = null;
  let micChunks = [];
  let micRecording = false;
  async function startMic() {
    if (micRecording) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      toast(error && error.name === "NotAllowedError" ? "Microphone access was denied." : "No microphone available.", { kind: "error" });
      return;
    }
    micRecording = true;
    micChunks = [];
    $("bc-ide-mic").classList.add("recording");
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(micStream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => { if (micRecording) micChunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    source.connect(processor);
    processor.connect(ctx.destination);
    micNodes = { ctx, source, processor, sampleRate: ctx.sampleRate };
  }
  async function stopMic() {
    if (!micRecording) return;
    micRecording = false;
    $("bc-ide-mic").classList.remove("recording");
    const nodes = micNodes;
    micNodes = null;
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (nodes) { try { nodes.processor.disconnect(); nodes.source.disconnect(); nodes.ctx.close(); } catch {} }
    const wav = encodeWav(micChunks, nodes ? nodes.sampleRate : 48000);
    micChunks = [];
    if (!wav || wav.byteLength < 4096) { toast("Didn't catch that."); return; }
    try {
      const result = await api.transcribe(wav);
      if (result && result.text) {
        const input = $("bc-ide-chat-input");
        input.value = (input.value ? input.value.replace(/\s*$/, " ") : "") + result.text;
        autosizeComposer();
        input.focus();
      } else {
        toast((result && result.error) || "Could not transcribe that.", { kind: "error" });
      }
    } catch (error) {
      toast(error.message || "Transcription failed.", { kind: "error" });
    }
  }
  // 32-bit float PCM -> 16 kHz mono WAV, the shape whisper.cpp expects.
  function encodeWav(chunks, inputRate) {
    let length = 0;
    chunks.forEach((c) => { length += c.length; });
    const merged = new Float32Array(length);
    let offset = 0;
    chunks.forEach((c) => { merged.set(c, offset); offset += c.length; });
    const targetRate = 16000;
    const ratio = inputRate / targetRate;
    const outLength = Math.floor(merged.length / ratio);
    const out = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const sample = merged[Math.floor(i * ratio)] || 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    const buffer = new ArrayBuffer(44 + out.length * 2);
    const dv = new DataView(buffer);
    const writeStr = (pos, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(pos + i, str.charCodeAt(i)); };
    writeStr(0, "RIFF");
    dv.setUint32(4, 36 + out.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, targetRate, true);
    dv.setUint32(28, targetRate * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    writeStr(36, "data");
    dv.setUint32(40, out.length * 2, true);
    for (let i = 0; i < out.length; i++) dv.setInt16(44 + i * 2, out[i], true);
    return buffer;
  }

  // ---------------------------------------------------------------------------
  // Usage: ring + popover
  // ---------------------------------------------------------------------------
  function renderUsageRing() {
    const fill = $("bc-ide-ring-fill");
    if (!fill) return;
    const circumference = 2 * Math.PI * 7.5;
    const pct = planUsage && typeof planUsage.utilization === "number" ? Math.max(0, Math.min(1, planUsage.utilization)) : 0;
    fill.style.strokeDasharray = `${circumference}`;
    fill.style.strokeDashoffset = `${circumference * (1 - pct)}`;
    const btn = $("bc-ide-usage-btn");
    const known = !!(planUsage && typeof planUsage.utilization === "number");
    btn.dataset.level = pct >= 0.9 ? "high" : pct >= 0.7 ? "mid" : "low";
    btn.dataset.known = known ? "true" : "false";
    btn.title = known ? `Claude plan usage: ${Math.round(pct * 100)}% of the current window` : "Usage";
    const label = $("bc-ide-usage-label");
    if (label) label.textContent = known ? `${Math.round(pct * 100)}%` : "";
    pushWorkbenchStatus();
  }

  function describePlanUsage() {
    if (!planUsage || typeof planUsage.utilization !== "number") {
      return '<div class="bc-ide-muted">Claude Code reports your plan usage while you chat — send a message and it shows up here.</div>';
    }
    const pct = Math.round(planUsage.utilization * 100);
    const windowName = { five_hour: "5-hour window", seven_day: "weekly limit", seven_day_opus: "weekly Opus limit", overage: "extra usage" }[planUsage.rateLimitType] || "usage window";
    const resets = planUsage.resetsAt ? new Date(planUsage.resetsAt * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
    return `<div class="bc-ide-usage-meter"><div class="bc-ide-usage-meter-bar" data-level="${pct >= 90 ? "high" : pct >= 70 ? "mid" : "low"}"><i style="width:${pct}%"></i></div><div class="bc-ide-usage-meter-copy"><strong>${pct}%</strong> of your ${escapeHtml(windowName)} used${resets ? ` · resets ${escapeHtml(resets)}` : ""}</div></div>${planUsage.status === "rejected" ? '<div class="bc-ide-usage-warn">Limit reached — Claude Code pauses until it resets.</div>' : ""}`;
  }

  async function openUsagePop() {
    const pop = $("bc-ide-usage-pop");
    const opening = pop.hidden;
    closePopMenus(opening ? "bc-ide-usage-pop" : null);
    closeModelMenu();
    if (!opening) return;
    pop.hidden = false;
    $("bc-ide-usage-btn").setAttribute("aria-expanded", "true");
    pop.innerHTML = `<div class="bc-ide-usage-section"><div class="bc-ide-usage-title">Claude plan</div>${describePlanUsage()}</div><div class="bc-ide-usage-section" id="bc-ide-usage-local"><div class="bc-ide-usage-title">This machine</div><div class="bc-ide-muted">Loading…</div></div>`;
    const localEl = $("bc-ide-usage-local");
    const analyticsOn = !!(latestSettings && latestSettings.analytics && latestSettings.analytics.enabled);
    if (!analyticsOn) {
      localEl.innerHTML = `<div class="bc-ide-usage-title">This machine</div><div class="bc-ide-muted">Turn on Usage analytics in BetterClaude settings to keep a local history of your chats.</div>`;
      return;
    }
    try {
      const to = new Date();
      const from = new Date(to.getTime() - 83 * 86400000);
      const iso = (d) => d.toISOString().slice(0, 10);
      const data = await api.queryAnalytics({ from: iso(from), to: iso(to) });
      const totals = (data && data.totals) || { messages: 0, tokens: 0 };
      if (!totals.messages) {
        localEl.innerHTML = `<div class="bc-ide-usage-title">This machine</div><div class="bc-ide-muted">No chats recorded yet.</div>`;
        return;
      }
      const byDay = new Map((data.messagesByDay || []).map((r) => [r.day, r.messages || 0]));
      const maxDay = Math.max(1, ...byDay.values());
      const level = (n) => (n <= 0 ? 0 : n >= maxDay * 0.75 ? 4 : n >= maxDay * 0.5 ? 3 : n >= maxDay * 0.25 ? 2 : 1);
      const cells = [];
      const start = new Date(from);
      start.setDate(start.getDate() - start.getDay());
      for (let d = new Date(start); d <= to; d.setDate(d.getDate() + 1)) {
        const key = iso(d);
        const count = byDay.get(key) || 0;
        cells.push(`<div class="bc-ide-usage-cell" data-level="${d < from ? 0 : level(count)}" title="${key}: ${count} message${count === 1 ? "" : "s"}"></div>`);
      }
      const models = (data.modelsByUsage || []).slice(0, 4);
      localEl.innerHTML = `
        <div class="bc-ide-usage-title">This machine · 12 weeks</div>
        <div class="bc-ide-usage-totals"><span><strong>${fmtCompact(totals.messages)}</strong> messages</span><span><strong>${fmtCompact(totals.tokens)}</strong> tokens</span></div>
        <div class="bc-ide-usage-grid">${cells.join("")}</div>
        ${models.length ? `<div class="bc-ide-usage-models">${models.map((m) => `<div><span>${escapeHtml(prettyModel(m.model || "claude"))}</span><span class="bc-ide-muted">${fmtCompact(m.messages)} msg</span></div>`).join("")}</div>` : ""}`;
    } catch {
      localEl.innerHTML = `<div class="bc-ide-usage-title">This machine</div><div class="bc-ide-muted">Couldn't read local usage.</div>`;
    }
  }

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  async function selectProject(cwd, { quiet = false } = {}) {
    const project = projects.find((p) => p.cwd === cwd);
    if (!project) return;
    const changed = !activeProject || activeProject.cwd !== cwd;
    activeProject = project;
    if (changed) {
      scmInfo = null;
      api.setLastProject(cwd).catch(() => {});
      if (!expanded.has(cwd)) { expanded.add(cwd); saveExpanded(); }
      renderDiffPill();
      syncChrome();
      await loadSessions(cwd);
      refreshProjectState(cwd);
      syncLayoutForProject();
      filesLoadedFor = null;
      if (terminalCwd && terminalCwd !== cwd) terminalStale = true;
      if (panelOpen()) loadPanelTab(currentPanelTab);
    }
    if (!quiet) {
      const r = activeRecord();
      if (!r || r.cwd !== cwd) newSession();
    }
    renderSidebar();
    syncChrome();
  }

  async function refreshProjectState(cwd) {
    if (!activeProject || activeProject.cwd !== cwd) return;
    try {
      const info = await api.gitInfo(cwd);
      if (!activeProject || activeProject.cwd !== cwd) return;
      scmInfo = info || null;
      renderDiffPill();
      syncChrome();
      if (panelOpen() && currentPanelTab === "changes") { renderChanges(); loadDiff(); }
    } catch { /* not fatal */ }
  }

  function parseDiffStat(str) {
    const s = String(str || "");
    const ins = /(\d+)\s+insertion/.exec(s);
    const del = /(\d+)\s+deletion/.exec(s);
    return { added: ins ? Number(ins[1]) : 0, deleted: del ? Number(del[1]) : 0 };
  }

  function renderDiffPill() {
    const pill = $("bc-ide-diff-pill");
    const count = $("bc-ide-changes-count");
    const dirty = !!(scmInfo && scmInfo.isRepo && (scmInfo.changedFiles || 0) > 0);
    pill.hidden = !dirty;
    count.hidden = !dirty;
    if (!dirty) return;
    const { added, deleted } = parseDiffStat(scmInfo.diffStat);
    $("bc-ide-diff-add").textContent = `+${added}`;
    $("bc-ide-diff-del").textContent = `−${deleted}`;
    count.textContent = String(scmInfo.changedFiles);
  }

  async function attachAgent(agent) {
    openPanel("terminal");
    await ensureTerminal({ start: false });
    const ok = await api.attachAgent(agent.sessionId, agent.cwd, terminalSize.cols, terminalSize.rows);
    if (!ok) toast("Could not attach to that session.", { kind: "error" });
    else { terminalCwd = agent.cwd; terminalStale = true; }
  }

  // ---------------------------------------------------------------------------
  // Right panel: Changes / Files / Terminal / Extensions
  // ---------------------------------------------------------------------------
  let currentPanelTab = store.get("bc-ide-panel-tab", "changes");
  if (!["changes", "files", "terminal", "extensions"].includes(currentPanelTab)) currentPanelTab = "changes";
  const panelOpen = () => shell.dataset.panel === "open";

  function openPanel(tab) {
    if (tab) currentPanelTab = tab;
    shell.dataset.panel = "open";
    store.set("bc-ide-panel", "open");
    store.set("bc-ide-panel-tab", currentPanelTab);
    $("bc-ide-toggle-panel").setAttribute("aria-pressed", "true");
    document.querySelectorAll("[data-panel-tab]").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.panelTab === currentPanelTab));
      if (b.dataset.panelTab === "extensions" && currentPanelTab === "extensions") b.hidden = false;
    });
    document.querySelectorAll("[data-panel-body]").forEach((s) => { s.hidden = s.dataset.panelBody !== currentPanelTab; });
    loadPanelTab(currentPanelTab);
  }

  function closePanel() {
    shell.dataset.panel = "closed";
    store.set("bc-ide-panel", "closed");
    $("bc-ide-toggle-panel").setAttribute("aria-pressed", "false");
  }

  function togglePanel(tab) {
    if (panelOpen() && (!tab || tab === currentPanelTab)) closePanel();
    else openPanel(tab || currentPanelTab);
  }

  // ---------------------------------------------------------------------------
  // Full-IDE layout (docs/ADR-0001-full-ide-workbench.md): a real VS Code
  // workbench in its own view left of this page, which then shows only the
  // chat. Remembered per project; chat-first stays the default. The engine is
  // installed only when the user says so, after seeing its size and source.
  // ---------------------------------------------------------------------------
  const wbApi = api.workbench || null;
  const layouts = (() => { try { return JSON.parse(store.get("bc-ide-layouts", "{}")) || {}; } catch { return {}; } })();
  let chatWidth = Math.max(320, Number(store.get("bc-ide-chat-width", "440")) || 440);
  let layoutBusy = false;
  let engineInstalling = false;

  // Settings → Claude Code → Full IDE (core/settings-schema.js codeWindow.ide).
  const ideSettings = () => (latestSettings && latestSettings.codeWindow && latestSettings.codeWindow.ide) || {};
  const fullIdeOffered = () => ideSettings().engine !== "lightweight";
  // A project's own choice, else the default for projects not set yet.
  const projectLayout = (cwd) => (layouts[cwd] === "ide" || layouts[cwd] === "chat" ? layouts[cwd] : ideSettings().defaultLayout === "ide" ? "ide" : "chat");
  function rememberLayout(cwd, mode) {
    layouts[cwd] = mode === "ide" ? "ide" : "chat";
    store.set("bc-ide-layouts", JSON.stringify(layouts));
  }

  function setLayoutChrome(mode) {
    const ide = mode === "ide";
    if (ide && shell.dataset.layout !== "ide") {
      shell.dataset.sidebar = "closed";
      if (panelOpen()) closePanel();
    }
    if (!ide && shell.dataset.layout === "ide") applySidebarForWidth();
    shell.dataset.layout = ide ? "ide" : "chat";
    $("bc-ide-layout-toggle").setAttribute("aria-pressed", ide ? "true" : "false");
    // The workbench's status bar starts empty; give it the chat's state now
    // rather than at the next chat event.
    if (ide) pushWorkbenchStatus();
  }

  // `quiet`: an automatic restore (a project's remembered layout, the default
  // for new projects) — never pops the install card or a toast; the toggle does.
  async function applyLayout(mode, { remember = true, quiet = false } = {}) {
    if (!wbApi || !activeProject || layoutBusy) return;
    const cwd = activeProject.cwd;
    if (mode !== "ide") {
      setLayoutChrome("chat");
      if (remember) rememberLayout(cwd, "chat");
      await wbApi.setLayout({ active: false });
      return;
    }
    if (!fullIdeOffered()) {
      if (!quiet) toast("The full IDE is off — Settings → Claude Code → Full IDE.");
      return;
    }
    layoutBusy = true;
    try {
      const status = await wbApi.status();
      if (!status || !status.supported) { if (!quiet) toast("The full IDE isn't available on this platform."); return; }
      if (!status.installed) { if (!quiet) openInstallCard(); return; }
      if (!status.running) toast("Starting the IDE…", { ms: 2500 });
      const res = await wbApi.setLayout({ active: true, cwd, chatWidth });
      // The user may have switched projects while the engine started.
      if (!activeProject || activeProject.cwd !== cwd) return;
      if (res && res.ok) {
        setLayoutChrome("ide");
        if (remember) rememberLayout(cwd, "ide");
      } else if (res && res.needsInstall) {
        if (!quiet) openInstallCard();
      } else {
        toast((res && res.error) || "Could not open the IDE.", { kind: "error", ms: 6000 });
      }
    } finally {
      layoutBusy = false;
    }
  }

  /** The chat's model, mode, activity and plan usage, for the workbench's status bar. */
  let lastWorkbenchStatus = "";
  function pushWorkbenchStatus() {
    if (!wbApi || shell.dataset.layout !== "ide") return;
    const r = activeRecord();
    const info = {
      model: ($("bc-ide-model-btn").textContent || "").trim(),
      mode: ($("bc-ide-mode-btn").textContent || "").trim(),
      state: r && r.waiting ? "waiting" : r && r.busy ? "working" : "idle",
      usage: planUsage && typeof planUsage.utilization === "number" ? planUsage.utilization * 100 : undefined,
    };
    const key = JSON.stringify(info);
    if (key === lastWorkbenchStatus) return;
    lastWorkbenchStatus = key;
    wbApi.pushStatus(info);
  }

  /** On a project switch: the layout that project was last left in. */
  function syncLayoutForProject() {
    if (!wbApi || !activeProject) return;
    if (projectLayout(activeProject.cwd) === "ide" && fullIdeOffered()) applyLayout("ide", { remember: false, quiet: true });
    else if (shell.dataset.layout === "ide") applyLayout("chat", { remember: false });
  }

  /** Settings changed: the toggle only shows while the full IDE is offered. */
  function syncLayoutToggle() {
    if (!wbApi) return;
    $("bc-ide-layout-toggle").hidden = !fullIdeOffered();
    if (!fullIdeOffered() && shell.dataset.layout === "ide") applyLayout("chat", { remember: false });
  }

  async function openInstallCard() {
    const card = $("bc-ide-wb-install");
    card.hidden = false;
    $("bc-ide-wb-go").disabled = true;
    const info = await wbApi.latest();
    if (!info || info.error) {
      $("bc-ide-wb-name").textContent = (info && info.error) || "Could not reach GitHub releases — check your connection.";
      return;
    }
    $("bc-ide-wb-name").textContent = `VSCodium ${info.version} (${info.name})`;
    $("bc-ide-wb-size").textContent = `${(info.size / 1e6).toFixed(1)} MB`;
    $("bc-ide-wb-source").textContent = info.source;
    $("bc-ide-wb-go").disabled = false;
  }

  function closeInstallCard() {
    if (!engineInstalling) $("bc-ide-wb-install").hidden = true;
  }

  async function runEngineInstall() {
    if (engineInstalling) return;
    engineInstalling = true;
    $("bc-ide-wb-go").disabled = true;
    $("bc-ide-wb-cancel").disabled = true;
    document.querySelector(".bc-ide-wb-progress").hidden = false;
    try {
      const res = await wbApi.install();
      if (!res || !res.ok) throw new Error((res && res.error) || "The install failed.");
      engineInstalling = false;
      $("bc-ide-wb-install").hidden = true;
      await applyLayout("ide");
    } catch (error) {
      $("bc-ide-wb-phase").textContent = error.message;
      toast(error.message, { kind: "error", ms: 8000 });
    } finally {
      engineInstalling = false;
      $("bc-ide-wb-go").disabled = false;
      $("bc-ide-wb-cancel").disabled = false;
    }
  }

  if (wbApi) {
    wbApi.onProgress((p) => {
      const pct = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
      $("bc-ide-wb-bar-fill").style.width = `${p.phase === "download" ? pct : 100}%`;
      $("bc-ide-wb-phase").textContent = p.phase === "download" ? `${pct}%` : p.phase === "verify" ? "Checking sha256…" : p.phase === "unpack" ? "Unpacking…" : "Done";
    });
    // From the workbench's bridge extension. A selection becomes an
    // attachment in the composer — unsent, like any file the user attaches.
    wbApi.onBridge((message) => {
      if (message.type === "selection" && activeProject) {
        const rel = message.file.startsWith(`${activeProject.cwd}/`) ? message.file.slice(activeProject.cwd.length + 1) : message.file;
        const label = message.startLine === message.endLine ? `${rel}:${message.startLine}` : `${rel}:${message.startLine}-${message.endLine}`;
        selectedAttachments = [...selectedAttachments.filter((a) => a.path !== label), { path: label, content: message.text }];
        renderAttachments();
        $("bc-ide-chat-input").focus();
        toast(`Added ${label} to the message`);
      } else if (message.type === "create-pr") {
        runCreatePr({ web: true });
      }
    });
    wbApi.onEvent((event) => {
      if (event.type === "failed") {
        toast(event.message || "The IDE engine stopped.", { kind: "error", ms: 8000 });
        setLayoutChrome("chat");
      } else if (event.type === "restarted") {
        toast("The IDE engine restarted.");
      } else if (event.type === "uninstalled") {
        setLayoutChrome("chat");
      }
    });
    // Drag the chat's left edge: the page is its own view, so its width IS
    // the chat width; main.js re-lays out both views as it changes.
    const handle = $("bc-ide-chat-split");
    let startX = 0;
    let startWidth = 0;
    let frame = 0;
    let pending = 0;
    const onMove = (event) => {
      pending = Math.max(320, Math.round(startWidth + (startX - event.screenX)));
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; chatWidth = pending; wbApi.setChatWidth(chatWidth); });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.documentElement.classList.remove("bc-ide-resizing");
      store.set("bc-ide-chat-width", String(chatWidth));
    };
    handle.addEventListener("pointerdown", (event) => {
      startX = event.screenX;
      startWidth = window.innerWidth;
      document.documentElement.classList.add("bc-ide-resizing");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      chatWidth = Math.max(320, window.innerWidth + (event.key === "ArrowLeft" ? 24 : -24));
      wbApi.setChatWidth(chatWidth);
      store.set("bc-ide-chat-width", String(chatWidth));
    });
  } else {
    $("bc-ide-layout-toggle").hidden = true;
  }

  function loadPanelTab(tab) {
    if (tab === "changes") { renderChanges(); loadDiff(); }
    else if (tab === "files") loadFiles();
    else if (tab === "terminal") ensureTerminal({ start: true });
    else if (tab === "extensions") setExtensionTab(extensionTab);
  }

  // Changes
  function renderChanges() {
    const info = scmInfo;
    const title = $("bc-ide-changes-title");
    const branch = $("bc-ide-changes-branch");
    const files = $("bc-ide-changes-files");
    const pr = $("bc-ide-pr");
    const prMore = $("bc-ide-pr-more");
    files.textContent = "";
    if (!activeProject) { title.textContent = "No project"; branch.textContent = ""; pr.disabled = true; prMore.disabled = true; return; }
    if (!info) { title.textContent = "Checking…"; branch.textContent = ""; return; }
    if (!info.isRepo) {
      title.textContent = "Not a Git repository";
      branch.textContent = "";
      pr.disabled = true;
      prMore.disabled = true;
      return;
    }
    const n = info.changedFiles || 0;
    const { added, deleted } = parseDiffStat(info.diffStat);
    title.textContent = n ? `${n} file${n === 1 ? "" : "s"} changed` : (info.ahead ? `${info.ahead} commit${info.ahead === 1 ? "" : "s"} to push` : "No changes");
    branch.innerHTML = `${info.branch ? escapeHtml(info.branch) : "detached"}${n ? ` · <span class="bc-ide-add">+${added}</span> <span class="bc-ide-del">−${deleted}</span>` : ""}`;
    const canPr = n > 0 || (info.ahead || 0) > 0;
    pr.disabled = !canPr;
    prMore.disabled = !canPr;
    pr.textContent = n > 0 ? "Commit & PR" : "Create PR";
    (info.statusLines || []).forEach((line) => {
      const code = line.slice(0, 2).trim() || "?";
      const file = line.slice(3);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "bc-ide-change-row";
      row.innerHTML = `<span class="bc-ide-change-code" data-code="${escapeHtml(code[0])}">${escapeHtml(code)}</span><span class="bc-ide-change-path"></span>`;
      row.querySelector(".bc-ide-change-path").textContent = file;
      row.title = `Jump to ${file} in the diff`;
      row.addEventListener("click", () => {
        const name = file.replace(/^.* -> /, "");
        const target = Array.from($("bc-ide-diff").querySelectorAll(".bc-ide-diff-file")).find((el) => el.textContent.trim() === name);
        if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
      });
      files.appendChild(row);
    });
  }

  async function loadDiff() {
    const out = $("bc-ide-diff");
    if (!activeProject) { out.textContent = ""; return; }
    try {
      const res = await api.gitDiff(activeProject.cwd);
      const diff = (res && res.diff) || "";
      if (!diff) { out.innerHTML = `<span class="bc-ide-muted">${res && res.isRepo ? "Working tree is clean." : ""}</span>`; return; }
      out.innerHTML = diff.split("\n").map((ln) => {
        const cls = /^diff --git/.test(ln) ? "bc-ide-diff-file"
          : /^(index |new file|deleted file|rename |similarity |\+\+\+|---)/.test(ln) ? "bc-ide-diff-meta"
          : ln.startsWith("@@") ? "bc-ide-diff-hunk"
          : ln.startsWith("+") ? "bc-ide-diff-add"
          : ln.startsWith("-") ? "bc-ide-diff-del" : "";
        const text = cls === "bc-ide-diff-file" ? ln.replace(/^diff --git a\/(.*) b\/.*$/, "$1") : ln;
        return cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(ln);
      }).join("\n");
    } catch (error) {
      out.textContent = error.message || "Could not load the diff.";
    }
  }

  function defaultCommitMessage() {
    const r = activeRecord();
    const t = r && r.title && r.title !== "New session" ? r.title : "";
    return t ? t.replace(/\s+/g, " ").slice(0, 72) : "Changes from BetterClaude Code";
  }

  async function runCreatePr(opts = {}) {
    if (!activeProject) return;
    const btn = $("bc-ide-pr");
    btn.disabled = true;
    $("bc-ide-pr-more").disabled = true;
    const label = btn.textContent;
    btn.textContent = opts.pushOnly ? "Pushing…" : "Working…";
    try {
      let res = await api.createPr({ cwd: activeProject.cwd, web: opts.web, pushOnly: opts.pushOnly });
      if (res && res.needsCommit) {
        const message = defaultCommitMessage();
        if (!window.confirm(`Commit all changes on "${res.branch}" as:\n\n"${message}"\n\nthen push${opts.pushOnly ? "" : " and open the pull request"}?`)) return;
        res = await api.createPr({ cwd: activeProject.cwd, web: opts.web, pushOnly: opts.pushOnly, commit: true, commitMessage: message });
      }
      if (!res || !res.ok) { toast((res && res.error) || "Could not open the pull request.", { kind: "error", ms: 6000 }); return; }
      toast(`${(res.steps || []).join(" · ")}${res.url ? " — opened" : ""}`, { ms: 5000 });
      refreshProjectState(activeProject.cwd);
    } catch (error) {
      toast(error.message || "Could not open the pull request.", { kind: "error" });
    } finally {
      btn.textContent = label;
      renderChanges();
    }
  }

  async function copyDiff() {
    if (!activeProject) return;
    try {
      const res = await api.gitDiff(activeProject.cwd);
      await navigator.clipboard.writeText((res && res.diff) || "");
      toast("Diff copied.");
    } catch (error) {
      toast(error.message || "Could not copy the diff.", { kind: "error" });
    }
  }

  function prMenuRows() {
    return [
      { label: "Open PR draft in browser", hint: "gh pr create --web", run: () => runCreatePr({ web: true }) },
      { label: "Create PR directly", hint: "gh pr create --fill", run: () => runCreatePr({}) },
      { label: "Commit & push only", hint: "No pull request", run: () => runCreatePr({ pushOnly: true }) },
      { divider: true },
      { label: "Copy diff", run: copyDiff },
    ];
  }

  // Files
  let filesLoadedFor = null;
  let activeFile = null;
  let openedFiles = [];
  let editor = null;
  let editorDirty = false;
  let currentFileMtime = null;
  let fileProjectCwd = null;

  function renderTree(nodes, depth = 0) {
    const fragment = document.createDocumentFragment();
    (nodes || []).forEach((node) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.path = node.path;
      button.style.paddingLeft = `${10 + Math.min(depth, 6) * 14}px`;
      button.className = node.kind === "folder" ? "is-folder" : "";
      button.innerHTML = `<span class="tree-icon">${icon(node.kind === "folder" ? "FOLDER" : "FILE")}</span><span class="tree-name"></span>`;
      button.querySelector(".tree-name").textContent = node.name;
      if (node.kind === "file") button.addEventListener("click", () => openFile(node.path));
      fragment.appendChild(button);
      if (node.kind === "folder" && node.children) fragment.appendChild(renderTree(node.children, depth + 1));
    });
    return fragment;
  }

  async function loadFiles(force = false) {
    if (!activeProject) return;
    if (!force && filesLoadedFor === activeProject.cwd) return;
    const tree = $("bc-ide-file-tree");
    tree.innerHTML = '<div class="bc-ide-muted bc-ide-pad">Loading…</div>';
    $("bc-ide-files-root").textContent = shortPath(activeProject.cwd);
    try {
      const result = await api.listFiles(activeProject.cwd);
      filesLoadedFor = activeProject.cwd;
      tree.textContent = "";
      if (!result || !result.nodes || !result.nodes.length) { tree.innerHTML = '<div class="bc-ide-muted bc-ide-pad">No files.</div>'; return; }
      tree.appendChild(renderTree(result.nodes));
      syncFileSelection();
    } catch (error) {
      tree.innerHTML = `<div class="bc-ide-muted bc-ide-pad">${escapeHtml(error.message || "Could not list files.")}</div>`;
    }
  }

  function syncFileSelection() {
    $("bc-ide-file-tree").querySelectorAll("button[data-path]").forEach((b) => b.classList.toggle("selected", b.dataset.path === activeFile));
  }

  function renderEditorTabs() {
    const host = $("bc-ide-editor-tabs");
    host.textContent = "";
    openedFiles.forEach((filePath) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bc-ide-editor-tab" + (filePath === activeFile ? " active" : "");
      b.textContent = filePath.split("/").pop();
      b.title = filePath;
      b.addEventListener("click", () => openFile(filePath));
      host.appendChild(b);
    });
  }

  function setFileState() {
    $("bc-ide-file-state").textContent = editorDirty ? "Unsaved" : "";
    $("bc-ide-file-save").disabled = !editorDirty;
  }

  async function openFile(filePath) {
    if (!activeProject) return;
    if (editorDirty && activeFile !== filePath && !window.confirm("Discard unsaved changes to the current file?")) return;
    try {
      const result = await api.readFile(activeProject.cwd, filePath);
      activeFile = filePath;
      fileProjectCwd = activeProject.cwd;
      currentFileMtime = result.mtimeMs;
      editorDirty = false;
      if (!openedFiles.includes(filePath)) openedFiles = [...openedFiles.slice(-5), filePath];
      renderEditorTabs();
      syncFileSelection();
      $("bc-ide-files-browse").hidden = true;
      $("bc-ide-file-view").hidden = false;
      const host = $("bc-ide-editor-host");
      if (editor) editor.destroy();
      host.textContent = "";
      if (result.binary) {
        host.innerHTML = '<div class="bc-ide-muted bc-ide-pad">Binary files aren\'t shown here.</div>';
        editor = null;
      } else {
        editor = editorFactory.mount(host, {
          initialValue: result.content,
          language: String(filePath).split(".").pop().toLowerCase() === "css" ? "css" : "",
          onChange: () => { editorDirty = true; setFileState(); },
        });
      }
      setFileState();
    } catch (error) {
      toast(error.message || "Could not open that file.", { kind: "error" });
    }
  }

  function openFileInPanel(filePath, cwd) {
    // Tool rows hand us absolute paths; the editor wants project-relative.
    const root = cwd || (activeProject && activeProject.cwd) || "";
    const rel = root && filePath.startsWith(`${root}/`) ? filePath.slice(root.length + 1) : filePath;
    openPanel("files");
    openFile(rel);
  }

  async function saveCurrentFile() {
    if (!editor || !activeProject || !activeFile || !editorDirty) return;
    const result = await api.writeFile(fileProjectCwd || activeProject.cwd, activeFile, editor.getValue(), currentFileMtime);
    if (result.conflict) { toast("That file changed on disk — reopen it before saving.", { kind: "error", ms: 5000 }); return; }
    currentFileMtime = result.mtimeMs;
    editorDirty = false;
    setFileState();
    toast(`Saved ${activeFile.split("/").pop()}`);
    refreshProjectState(activeProject.cwd);
  }

  // Terminal (a login shell in the project folder)
  let term = null;
  let fitAddon = null;
  let terminalSize = { cols: 100, rows: 30 };
  let terminalCwd = null;
  let terminalStale = false;

  async function ensureTerminal({ start }) {
    if (!term) {
      term = new xterm.Terminal({
        cursorBlink: true,
        scrollback: 5000,
        fontFamily: codeFontStack(),
        fontSize: Number(latestSettings && latestSettings.codeWindow && latestSettings.codeWindow.fontSizePx) || 13,
        theme: terminalThemeFromCSSVars(),
      });
      fitAddon = new xterm.FitAddon();
      term.loadAddon(fitAddon);
      term.open($("bc-ide-terminal-host"));
      term.onData((data) => api.write(data));
      api.onData((chunk) => term.write(chunk));
      api.onStarted(({ cwd, kind }) => {
        $("bc-ide-terminal-dot").classList.add("live");
        $("bc-ide-terminal-cwd").textContent = `${kind === "claude" ? "claude · " : ""}${shortPath(cwd)}`;
      });
      api.onExit(({ exitCode, signal }) => {
        $("bc-ide-terminal-dot").classList.remove("live");
        term.write(`\r\n\x1b[2m[process ended: ${signal ? `signal ${signal}` : `exit ${exitCode}`} — “New shell” starts another]\x1b[0m\r\n`);
      });
      api.onFatal(({ message }) => term.write(`\r\n\x1b[31m${String(message || "").replace(/\n/g, "\r\n")}\x1b[0m\r\n`));
      const resize = () => {
        if (!fitAddon || $("bc-ide-terminal-host").offsetParent === null) return;
        const proposed = fitAddon.proposeDimensions();
        if (!proposed || !proposed.cols || !proposed.rows) return;
        fitAddon.fit();
        terminalSize = { cols: term.cols, rows: term.rows };
        api.resize(terminalSize.cols, terminalSize.rows);
      };
      new ResizeObserver(resize).observe($("bc-ide-terminal-host"));
      requestAnimationFrame(resize);
    }
    if (!start || !activeProject) return;
    if (terminalCwd && terminalCwd === activeProject.cwd && !terminalStale) { term.focus(); return; }
    await startShell();
  }

  async function startShell() {
    if (!activeProject) return;
    terminalCwd = activeProject.cwd;
    terminalStale = false;
    if (term) term.reset();
    await api.startShell(activeProject.cwd, terminalSize.cols, terminalSize.rows);
    if (term) term.focus();
  }

  // Extensions (VS Code-family editors on this machine + Open VSX)
  let extensionTab = "installed";
  let installedExtensions = [];
  let browseResults = null;
  let browseInFlight = null;
  const installingIds = new Set();

  function setExtensionStatus(message) {
    const status = $("bc-ide-extension-status");
    status.hidden = !message;
    status.textContent = message || "";
  }
  function setExtensionTab(next) {
    extensionTab = next;
    $("bc-ide-ext-tab-installed").setAttribute("aria-pressed", String(next === "installed"));
    $("bc-ide-ext-tab-browse").setAttribute("aria-pressed", String(next === "browse"));
    $("bc-ide-extension-search").hidden = next !== "browse";
    if (next === "installed") loadExtensions();
    else runBrowse($("bc-ide-extension-search").value);
  }
  const isExtensionInstalled = (id) => installedExtensions.some((e) => e.id === String(id).toLowerCase());
  function extensionRow({ iconHtml, actionHtml }) {
    return `<span class="bc-ide-extension-icon">${iconHtml}</span><span class="bc-ide-ext-copy"><strong></strong><small></small></span><span class="bc-ide-ext-action">${actionHtml || ""}</span>`;
  }
  function renderInstalledExtensions() {
    const host = $("bc-ide-extension-list");
    if (extensionTab !== "installed") return;
    $("bc-ide-extension-count").textContent = String(installedExtensions.length);
    host.textContent = "";
    if (!installedExtensions.length) {
      host.innerHTML = '<div class="bc-ide-muted bc-ide-pad">No VS Code, Cursor or Antigravity extensions found. Open Browse to install some.</div>';
      return;
    }
    installedExtensions.forEach((extension) => {
      const row = document.createElement("div");
      row.className = "bc-ide-extension-row";
      row.innerHTML = extensionRow({
        iconHtml: extension.icon ? `<img src="${extension.icon}" alt="" />` : icon("EXTENSIONS"),
        actionHtml: `<button type="button" class="bc-ide-icon-btn bc-ide-ext-remove" title="Uninstall from ${escapeHtml(extension.host)}" aria-label="Uninstall">${icon("CLOSE")}</button>`,
      });
      row.querySelector("strong").textContent = extension.displayName;
      row.querySelector("small").textContent = `${extension.publisher} · ${extension.host} · v${extension.version}`;
      row.title = extension.description || extension.displayName;
      row.querySelector(".bc-ide-ext-remove").addEventListener("click", async () => {
        setExtensionStatus(`Uninstalling ${extension.displayName}…`);
        try {
          await api.uninstallExtension(extension.id);
          await loadExtensions();
          setExtensionStatus(`${extension.displayName} uninstalled.`);
        } catch (error) {
          setExtensionStatus(error.message || "Could not uninstall that extension.");
        }
      });
      host.appendChild(row);
    });
  }
  function renderBrowseExtensions() {
    const host = $("bc-ide-extension-list");
    if (extensionTab !== "browse") return;
    const results = browseResults || [];
    $("bc-ide-extension-count").textContent = String(results.length);
    host.textContent = "";
    if (!results.length) { host.innerHTML = '<div class="bc-ide-muted bc-ide-pad">Nothing matched that search.</div>'; return; }
    results.forEach((extension) => {
      const row = document.createElement("div");
      row.className = "bc-ide-extension-row";
      const installed = isExtensionInstalled(extension.id);
      const busy = installingIds.has(extension.id);
      row.innerHTML = extensionRow({
        iconHtml: extension.icon ? `<img src="${extension.icon}" alt="" />` : icon("EXTENSIONS"),
        actionHtml: `<button type="button" class="bc-ide-btn bc-ide-ext-install" ${installed ? "disabled" : ""}>${busy ? "Installing…" : installed ? "Installed" : "Install"}</button>`,
      });
      row.querySelector("strong").textContent = extension.displayName;
      row.querySelector("small").textContent = [extension.publisher, extension.source === "registry" ? (extension.downloads != null ? `${extension.downloads.toLocaleString()} installs` : "registry") : extension.category].filter(Boolean).join(" · ");
      row.title = extension.description || extension.displayName;
      const installButton = row.querySelector(".bc-ide-ext-install");
      installButton.addEventListener("click", async () => {
        if (installingIds.has(extension.id) || isExtensionInstalled(extension.id)) return;
        installingIds.add(extension.id);
        installButton.textContent = "Installing…";
        setExtensionStatus(`Installing ${extension.displayName} from Open VSX…`);
        try {
          const result = await api.installExtension(extension.id);
          await loadExtensions();
          setExtensionStatus(result && result.alreadyInstalled ? `${extension.displayName} was already installed.` : `${extension.displayName} installed into ${(result && result.extension && result.extension.host) || "your editor"}.`);
          if (extensionTab === "browse") renderBrowseExtensions();
        } catch (error) {
          setExtensionStatus(error.message || `Could not install ${extension.displayName}.`);
        } finally {
          installingIds.delete(extension.id);
        }
      });
      host.appendChild(row);
    });
  }
  async function runBrowse(query) {
    const needle = String(query || "").trim();
    const token = Symbol("browse");
    browseInFlight = token;
    if (needle) setExtensionStatus("Searching extensions…");
    try {
      const results = await api.searchExtensions(needle);
      if (browseInFlight !== token) return;
      browseResults = results;
      setExtensionStatus("");
    } catch (error) {
      if (browseInFlight !== token) return;
      browseResults = [];
      setExtensionStatus(error.message || "Extension search failed.");
    }
    renderBrowseExtensions();
  }
  async function loadExtensions() {
    try {
      installedExtensions = (await api.listExtensions()) || [];
    } catch {
      installedExtensions = [];
    }
    if (extensionTab === "installed") renderInstalledExtensions();
    else renderBrowseExtensions();
  }

  // ---------------------------------------------------------------------------
  // Resizable sidebar / panel
  // ---------------------------------------------------------------------------
  function wirePanelResize({ handleId, storageKey, cssVarName, target, minWidth, maxWidth, invert = false }) {
    const handle = $(handleId);
    if (!handle || !target) return;
    const resolveMax = () => (typeof maxWidth === "function" ? maxWidth() : maxWidth);
    const clamp = (w) => Math.round(Math.min(resolveMax(), Math.max(minWidth, w)));
    const apply = (w) => document.documentElement.style.setProperty(cssVarName, `${clamp(w)}px`);
    const stored = parseInt(store.get(storageKey, ""), 10);
    if (Number.isFinite(stored)) apply(stored);
    let startX = 0;
    let startWidth = 0;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      startX = event.clientX;
      startWidth = target.getBoundingClientRect().width;
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("dragging");
      document.documentElement.classList.add("bc-ide-resizing");
    });
    handle.addEventListener("pointermove", (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const delta = event.clientX - startX;
      apply(invert ? startWidth - delta : startWidth + delta);
    });
    const end = (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      handle.releasePointerCapture(event.pointerId);
      handle.classList.remove("dragging");
      document.documentElement.classList.remove("bc-ide-resizing");
      store.set(storageKey, clamp(target.getBoundingClientRect().width));
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("dblclick", () => { store.del(storageKey); document.documentElement.style.removeProperty(cssVarName); });
    handle.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
      if (!step) return;
      event.preventDefault();
      apply(target.getBoundingClientRect().width + (invert ? -step : step));
      store.set(storageKey, clamp(target.getBoundingClientRect().width));
    });
  }

  // Below this width the sidebar floats over the conversation instead of
  // sitting beside it, so it starts collapsed there (without touching the
  // saved wide-window preference) and closes again once you pick something.
  const NARROW_W = 900;
  const isNarrow = () => window.innerWidth < NARROW_W;
  function setSidebar(open) {
    shell.dataset.sidebar = open ? "open" : "closed";
    if (!isNarrow()) store.set("bc-ide-sidebar", open ? "open" : "closed");
  }
  function applySidebarForWidth() {
    const stored = store.get("bc-ide-sidebar", "open") === "closed" ? "closed" : "open";
    shell.dataset.sidebar = isNarrow() ? "closed" : stored;
  }
  let wasNarrow = isNarrow();
  window.addEventListener("resize", () => {
    if (isNarrow() !== wasNarrow) { wasNarrow = isNarrow(); applySidebarForWidth(); }
  });
  const closeOverlaySidebar = () => { if (isNarrow() && shell.dataset.sidebar === "open") shell.dataset.sidebar = "closed"; };

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  applySidebarForWidth();
  on("bc-ide-projects", "click", (event) => { if (event.target.closest && event.target.closest(".bc-ide-session")) closeOverlaySidebar(); });
  document.querySelector(".bc-ide-main").addEventListener("pointerdown", closeOverlaySidebar);

  on("bc-ide-new", "click", () => newSession());
  on("bc-ide-search", "input", (e) => { searchQuery = e.target.value; renderSidebar(); });
  on("bc-ide-search", "keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); e.target.value = ""; searchQuery = ""; renderSidebar(); $("bc-ide-chat-input").focus(); } });
  on("bc-ide-add-project", "click", () => api.pickFolder());
  on("bc-ide-usage-btn", "click", (e) => { e.stopPropagation(); openUsagePop(); });
  on("bc-ide-settings-btn", "click", () => api.openSettings());
  on("bc-ide-toggle-sidebar", "click", () => setSidebar(shell.dataset.sidebar !== "open"));
  on("bc-ide-toggle-panel", "click", () => togglePanel());
  on("bc-ide-layout-toggle", "click", () => applyLayout(shell.dataset.layout === "ide" ? "chat" : "ide"));
  on("bc-ide-wb-go", "click", () => runEngineInstall());
  on("bc-ide-wb-cancel", "click", () => closeInstallCard());
  on("bc-ide-panel-close", "click", () => closePanel());
  on("bc-ide-diff-pill", "click", () => togglePanel("changes"));
  on("bc-ide-more", "click", (e) => {
    e.stopPropagation();
    popMenu("bc-ide-more-menu", "bc-ide-more", [
      { icon: "GIT_BRANCH", label: "Review changes", hint: "⌘⇧D", run: () => openPanel("changes") },
      { icon: "FOLDER", label: "Browse files", run: () => openPanel("files") },
      { icon: "TERMINAL", label: "Terminal", hint: "⌃`", run: () => openPanel("terminal") },
      { divider: true },
      ...prMenuRows(),
      { divider: true },
      { icon: "CODE", label: "Open in the CLI tab", hint: "Interactive claude", run: () => api.openCli() },
      { icon: "EXTENSIONS", label: "VS Code extensions", run: () => openPanel("extensions") },
    ]);
  });
  document.querySelectorAll("[data-panel-tab]").forEach((b) => b.addEventListener("click", () => openPanel(b.dataset.panelTab)));
  on("bc-ide-pr", "click", () => runCreatePr({ web: true }));
  on("bc-ide-pr-more", "click", (e) => { e.stopPropagation(); popMenu("bc-ide-pr-menu", "bc-ide-pr-more", prMenuRows()); });
  on("bc-ide-files-refresh", "click", () => loadFiles(true));
  on("bc-ide-file-back", "click", () => { $("bc-ide-file-view").hidden = true; $("bc-ide-files-browse").hidden = false; });
  on("bc-ide-file-save", "click", saveCurrentFile);
  on("bc-ide-terminal-restart", "click", () => startShell());
  on("bc-ide-clear-terminal", "click", () => { if (term) term.clear(); });
  on("bc-ide-ext-tab-installed", "click", () => setExtensionTab("installed"));
  on("bc-ide-ext-tab-browse", "click", () => setExtensionTab("browse"));
  let extensionSearchTimer = null;
  on("bc-ide-extension-search", "input", (e) => { clearTimeout(extensionSearchTimer); const v = e.target.value; extensionSearchTimer = setTimeout(() => runBrowse(v), 300); });

  // Composer
  on("bc-ide-chat-form", "submit", sendChatMessage);
  on("bc-ide-plus", "click", (e) => { e.stopPropagation(); togglePlusMenu(); });
  on("bc-ide-mode-btn", "click", (e) => { e.stopPropagation(); toggleModeMenu(); });
  on("bc-ide-model-btn", "click", (e) => { e.stopPropagation(); if ($("bc-ide-model-menu").hidden) openModelMenu(); else closeModelMenu(); });
  on("bc-ide-chat-stop", "click", () => { const r = activeRecord(); if (r) api.stopChat(r.tabId); });
  const chatInput = $("bc-ide-chat-input");
  on(chatInput, "input", () => { autosizeComposer(); refreshSlashMenu(); });
  on(chatInput, "keydown", (event) => {
    const menu = $("bc-ide-slash-menu");
    if (!menu.hidden) {
      const count = Number(menu.dataset.count || 0);
      if (event.key === "ArrowDown") { event.preventDefault(); slashIndex = (slashIndex + 1) % count; refreshSlashMenu(); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); slashIndex = (slashIndex - 1 + count) % count; refreshSlashMenu(); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); menu.hidden = true; return; }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        const rows = menu.querySelectorAll(".bc-ide-slash-row");
        if (rows[slashIndex]) rows[slashIndex].dispatchEvent(new MouseEvent("mousedown"));
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendChatMessage();
    }
  });
  on(chatInput, "blur", () => setTimeout(() => { $("bc-ide-slash-menu").hidden = true; }, 120));
  const mic = $("bc-ide-mic");
  on(mic, "pointerdown", (e) => { e.preventDefault(); startMic(); });
  on(mic, "pointerup", () => stopMic());
  on(mic, "pointerleave", () => { if (micRecording) stopMic(); });
  Promise.resolve(api.sttAvailable()).then((info) => { if (info && info.available) mic.hidden = false; }).catch(() => {});

  // Links and code-copy buttons inside rendered markdown.
  on("bc-ide-chat-messages", "click", (event) => {
    const link = event.target.closest && event.target.closest("a[href]");
    if (link) {
      event.preventDefault();
      if (link.dataset.external) window.open(link.href, "_blank");
      return;
    }
    const copy = event.target.closest && event.target.closest("[data-copy]");
    if (copy) {
      const code = copy.closest(".bc-md-code");
      const text = code ? code.querySelector("code").textContent : "";
      navigator.clipboard.writeText(text).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1400);
      }).catch(() => {});
    }
  });

  // Dismiss popovers on outside click.
  document.addEventListener("click", (event) => {
    const t = event.target;
    if (!(t.closest && t.closest(".bc-ide-model-picker"))) closeModelMenu();
    if (!(t.closest && t.closest(".bc-ide-pop-menu, #bc-ide-plus, #bc-ide-mode-btn, #bc-ide-pr-more, #bc-ide-more, #bc-ide-usage-pop, #bc-ide-usage-btn"))) closePopMenus();
  });

  // Keyboard
  const anyPopoverOpen = () => ["bc-ide-plus-menu", "bc-ide-mode-menu", "bc-ide-pr-menu", "bc-ide-more-menu", "bc-ide-usage-pop", "bc-ide-model-menu", "bc-ide-slash-menu"].some((id) => $(id) && !$(id).hidden);
  window.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (event.key === "Escape") {
      // Precedence: close a popover, then deny a pending card, then stop.
      if (anyPopoverOpen()) { closePopMenus(); closeModelMenu(); $("bc-ide-slash-menu").hidden = true; return; }
      const r = activeRecord();
      if (!r) return;
      const card = r.transcript.pendingCard();
      if (card && card.bcDeny) { card.bcDeny(); return; }
      if (r.busy) api.stopChat(r.tabId);
      return;
    }
    if (mod && key === "s" && editor && editorDirty) { event.preventDefault(); saveCurrentFile(); return; }
    if (mod && !event.shiftKey && !event.altKey && key === "n") { event.preventDefault(); newSession(); return; }
    if (mod && event.altKey && event.code === "KeyB") { event.preventDefault(); togglePanel(); return; }
    if (mod && event.altKey && event.code === "KeyI") { event.preventDefault(); applyLayout(shell.dataset.layout === "ide" ? "chat" : "ide"); return; }
    if (mod && !event.shiftKey && !event.altKey && key === "b") { event.preventDefault(); setSidebar(shell.dataset.sidebar !== "open"); return; }
    if (mod && event.shiftKey && key === "d") { event.preventDefault(); togglePanel("changes"); return; }
    if (mod && event.shiftKey && key === "m") { event.preventDefault(); toggleModeMenu(); return; }
    if (event.ctrlKey && event.code === "Backquote") { event.preventDefault(); togglePanel("terminal"); return; }
    if (mod && key === "k") { event.preventDefault(); setSidebar(true); $("bc-ide-search").focus(); $("bc-ide-search").select(); return; }
    if (mod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
      const row = document.querySelector(`.bc-ide-session[data-index="${event.key}"]`);
      if (row) { event.preventDefault(); row.click(); }
    }
  });

  wirePanelResize({ handleId: "bc-ide-sidebar-resize", storageKey: "bc-ide-sidebar-w", cssVarName: "--bc-ide-sidebar-w", target: $("bc-ide-sidebar"), minWidth: 220, maxWidth: 420 });
  wirePanelResize({ handleId: "bc-ide-panel-resize", storageKey: "bc-ide-panel-w", cssVarName: "--bc-ide-panel-w", target: $("bc-ide-panel"), minWidth: 360, maxWidth: () => Math.max(360, window.innerWidth - 520), invert: true });

  api.onChatEvent(handleChatEvent);
  api.onWorkspaceSettings((settings) => {
    latestSettings = settings;
    if (term) {
      if (settings && settings.codeWindow && settings.codeWindow.fontSizePx) term.options.fontSize = settings.codeWindow.fontSizePx;
      term.options.theme = terminalThemeFromCSSVars();
      term.options.fontFamily = codeFontStack();
    }
    syncModeChip();
    syncLayoutToggle();
  });
  api.onProjectPicked(async ({ cwd } = {}) => {
    if (!cwd) return;
    try {
      projects = (await api.listProjects()) || [];
      await selectProject(cwd);
    } catch (error) {
      toast(error.message || "Could not open that folder.", { kind: "error" });
    }
  });
  // Refresh relative times and git state when coming back to the window.
  window.addEventListener("focus", () => {
    renderSidebar();
    if (activeProject) refreshProjectState(activeProject.cwd);
  });

  // ---------------------------------------------------------------------------
  // Startup — paint the shell first, then fill it.
  // ---------------------------------------------------------------------------
  renderSidebar();
  syncChrome();
  updateModelButtonLabel();
  renderUsageRing();
  try {
    latestSettings = await api.getSettings();
  } catch { /* keep defaults */ }
  syncModeChip();
  syncLayoutToggle();
  try {
    const initial = await api.getInitialState();
    projects = initial.projects || [];
    agents = initial.agents || [];
    ensureFreeModels();
    const chosen = projects.find((p) => p.cwd === initial.lastProject) || projects[0];
    if (chosen) await selectProject(chosen.cwd);
    else { renderSidebar(); syncChrome(); }
    shell.dataset.state = "ready";
    if (store.get("bc-ide-panel", "closed") === "open") openPanel(currentPanelTab);
    // Sessions running in other terminals — slow to list, so never on the
    // first-paint path.
    Promise.resolve(api.listAgents()).then((list) => {
      agents = Array.isArray(list) ? list : [];
      if (agents.length) renderSidebar();
    }).catch(() => {});
  } catch (error) {
    shell.dataset.state = "error";
    toast(error.message || "Could not start the Code workspace.", { kind: "error", ms: 8000 });
  }
})();
