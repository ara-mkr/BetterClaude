/**
 * Page-world driver for the embedded Claude Code terminals.
 *
 * Runs in the renderer's own realm (a plain <script> in
 * electron/code-window.html), NOT in the preload realm — so it has no
 * require(), no ipcRenderer, and no Node at all. Its entire connection to the
 * `claude` subprocesses is `window.betterClaudeCode`, the contextBridge surface
 * exposed by electron/code-preload.js.
 *
 * MULTI-SESSION: this file owns the tab strip. Every session is its own xterm
 * Terminal bound to one pty in the main process; every bridge call and every
 * event carries the session id, so keystrokes and output for one tab can never
 * reach another. The team sidebar lives in ui/code-window/team-panel.js — this
 * file deliberately knows nothing about teams beyond showing a teammate's name
 * on its tab.
 *
 * Compliance: this file forwards keystrokes and paints bytes. It never inspects
 * or pattern-matches terminal output to trigger anything, and the only thing it
 * ever writes to a child is what xterm's onData hands it — the user's own
 * input, verbatim, addressed to that tab's own pty.
 */

(async function () {
  "use strict";

  const { Terminal, FitAddon, WebglAddon } = window.BetterClaudeXterm;
  const api = window.betterClaudeCode;

  // Settings come over IPC, so they aren't available at parse time. Awaited
  // here (rather than read from a preloaded property) because the preload
  // exposes this bridge synchronously — see the comment on the
  // exposeInMainWorld call in electron/code-preload.js.
  const initialSettings = await api.getSettings();
  let latestSettings = initialSettings;

  const shell = document.getElementById("bc-code-shell");
  const cwdLabel = document.getElementById("bc-code-cwd");
  const folderBtn = document.getElementById("bc-code-folder-btn");
  const resumeBtn = document.getElementById("bc-code-resume-btn");
  const tabsStrip = document.getElementById("bc-code-tabs");
  const termHost = document.getElementById("bc-code-term");
  const newTabBtn = document.createElement("button");

  /**
   * Fixed ANSI 16 for the terminals' own palette, in dark and light variants.
   *
   * A BetterClaude theme defines nine --bc-* colours (see THEME_VAR_DEFS in
   * core/theme-engine.js) — background, elevated, sidebar, text, muted, border,
   * two bubbles, danger. That is a chat palette, not a terminal one: there is
   * no theme-supplied "cyan" to map ANSI 6 onto. Deriving sixteen hues from
   * nine chat colours would invent colour the theme author never chose and,
   * worse, could easily land unreadable (a theme whose only saturated colour is
   * a pale accent would produce a nearly invisible green).
   *
   * So the ANSI 16 stay fixed and legible, while everything the theme genuinely
   * DOES define — background, foreground, cursor, selection, and the red slot,
   * which maps cleanly onto --bc-danger — is taken live from the theme below.
   */
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

  /**
   * Perceived lightness of a colour, used only to decide which fixed ANSI set
   * reads better against the theme's background. Handles the #rgb/#rrggbb and
   * rgb()/rgba() forms themes actually ship; anything else is treated as dark,
   * which matches the app's own default palette.
   */
  function isLight(color) {
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

  /** Builds an xterm ITheme from whatever the active BetterClaude theme is. */
  function themeFromCSSVars() {
    const bg = cssVar("--bc-bg", "#14101f");
    const fg = cssVar("--bc-text", "#ece7fb");
    const accent = cssVar("--bc-accent", "#6059e6");
    const danger = cssVar("--bc-danger", "#ef4444");
    const ansi = isLight(bg) ? ANSI_LIGHT : ANSI_DARK;

    return Object.assign({}, ansi, {
      background: bg,
      foreground: fg,
      cursor: accent,
      cursorAccent: bg,
      selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}59` : "rgba(96,89,230,0.35)",
      red: danger,
      brightRed: danger,
    });
  }

  function currentFontFamily() {
    return cssVar("--bc-code-font", "SFMono-Regular, Menlo, Consolas, monospace");
  }

  function currentFontSize() {
    return Number((initialSettings.codeWindow || {}).fontSizePx) || 13;
  }

  // --- Session registry (renderer side) ---

  const sessions = new Map(); // id -> SessionTab
  let activeId = null;

  function get(id) {
    return typeof id === "string" ? sessions.get(id) || null : null;
  }

  function activeSession() {
    return activeId ? sessions.get(activeId) || null : null;
  }

  class SessionTab {
    constructor({ id, name }) {
      this.id = id;
      this.name = name || `Session ${id.replace(/^s/, "")}`;
      this.cwd = "";
      this.state = "starting";
      this.memberId = null; // set when the session belongs to a team
      this.lastSize = { cols: 0, rows: 0 };
      this.webglAddon = null;

      // --- DOM: one slot per session inside the shared terminal area ---
      this.slot = document.createElement("div");
      this.slot.className = "bc-code-slot";
      this.slot.dataset.id = id;
      this.slot.dataset.active = "false";

      this.hostEl = document.createElement("div");
      this.hostEl.className = "bc-code-term-host";
      this.slot.appendChild(this.hostEl);

      // Startup failures and exits land here rather than being written INTO
      // the terminal: the terminal shows the child's own bytes and nothing
      // else, so BetterClaude's messages stay visibly BetterClaude's.
      this.overlay = document.createElement("div");
      this.overlay.className = "bc-code-overlay";
      this.overlay.dataset.visible = "false";
      this.overlay.setAttribute("role", "status");
      this.overlayMsg = document.createElement("p");
      this.overlayMsg.className = "bc-code-overlay-msg";
      this.overlayActions = document.createElement("div");
      this.overlayActions.className = "bc-code-overlay-actions";
      this.overlay.appendChild(this.overlayMsg);
      this.overlay.appendChild(this.overlayActions);
      this.slot.appendChild(this.overlay);

      termHost.appendChild(this.slot);

      // --- Terminal ---
      this.term = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: true,
        scrollback: 5000,
        fontFamily: currentFontFamily(),
        fontSize: currentFontSize(),
        theme: themeFromCSSVars(),
      });
      this.fitAddon = new FitAddon();
      this.term.loadAddon(this.fitAddon);
      this.term.open(this.hostEl);
      this.term.onData((data) => api.write(this.id, data));

      this.buildTabButton();
    }

    buildTabButton() {
      this.tabBtn = document.createElement("button");
      this.tabBtn.className = "bc-code-tab";
      this.tabBtn.type = "button";
      this.tabBtn.setAttribute("role", "tab");
      this.tabBtn.setAttribute("aria-selected", "false");
      this.tabBtn.dataset.sessionId = this.id;
      this.tabBtn.dataset.sessionState = this.state;
      this.tabBtn.title = this.name;

      const dot = document.createElement("span");
      dot.className = "bc-code-dot";
      dot.setAttribute("aria-hidden", "true");

      this.labelEl = document.createElement("span");
      this.labelEl.className = "bc-code-tab-label";
      this.labelEl.textContent = this.name;

      this.badgeEl = document.createElement("span");
      this.badgeEl.className = "bc-code-tab-badge";
      this.badgeEl.hidden = true;

      const closeBtn = document.createElement("span");
      closeBtn.className = "bc-code-tab-close";
      closeBtn.textContent = "×";
      closeBtn.title = "Close this session";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeSession(this.id);
      });

      this.tabBtn.append(dot, this.labelEl, this.badgeEl, closeBtn);
      this.tabBtn.addEventListener("click", () => activateSession(this.id));
      tabsStrip.insertBefore(this.tabBtn, newTabBtn);
    }

    setName(name) {
      if (!name || name === this.name) return;
      this.name = name;
      this.labelEl.textContent = name;
      this.tabBtn.title = name;
    }

    setState(state) {
      this.state = state;
      this.tabBtn.dataset.sessionState = state;
      refreshChrome();
    }

    ensureWebgl() {
      // GPU renderer, with a real fallback (see the long comment in git
      // history / original single-session build): WebGL draws the buffer into
      // one canvas from a glyph atlas instead of rebuilding DOM runs, which
      // matters for the CLI's continuous TUI repaints. Only ONE tab holds a GL
      // context at a time — contexts are scarce browser-wide, and a hidden
      // terminal is never painted anyway.
      if (this.webglAddon || typeof WebglAddon !== "function") return;
      try {
        this.webglAddon = new WebglAddon();
        this.webglAddon.onContextLoss(() => {
          try { this.webglAddon.dispose(); } catch (_err) { /* already gone */ }
          this.webglAddon = null;
        });
        this.term.loadAddon(this.webglAddon);
      } catch (_err) {
        this.webglAddon = null; // No GPU path available — DOM renderer stays.
      }
    }

    disposeWebgl() {
      if (!this.webglAddon) return;
      try { this.webglAddon.dispose(); } catch (_err) { /* already gone */ }
      this.webglAddon = null;
    }

    proposeSize() {
      const proposed = this.fitAddon.proposeDimensions();
      if (!proposed || !proposed.cols || !proposed.rows) return null;
      return proposed;
    }

    syncSize() {
      const proposed = this.proposeSize();
      if (!proposed) return null;
      if (proposed.cols !== this.term.cols || proposed.rows !== this.term.rows) {
        this.fitAddon.fit();
      }
      const size = { cols: this.term.cols, rows: this.term.rows };
      // Only tell the child when the size actually changed: a resize is a
      // SIGWINCH to the CLI, which makes it redraw; firing one per resize
      // *event* makes a window drag flicker.
      if (size.cols !== this.lastSize.cols || size.rows !== this.lastSize.rows) {
        this.lastSize = size;
        api.resize(this.id, size.cols, size.rows);
      }
      return size;
    }

    hideOverlay() {
      this.overlay.dataset.visible = "false";
      this.overlayMsg.textContent = "";
      this.overlayActions.textContent = "";
    }

    showOverlay(message, actions) {
      this.overlayMsg.textContent = message;
      this.overlayActions.textContent = "";
      (actions || []).forEach(({ label, primary, onClick }) => {
        const btn = document.createElement("button");
        btn.textContent = label;
        if (primary) btn.className = "bc-code-primary";
        btn.addEventListener("click", onClick);
        this.overlayActions.appendChild(btn);
      });
      this.overlay.dataset.visible = "true";
    }

    restartInPlace() {
      this.hideOverlay();
      this.term.reset();
      this.setState("starting");
      const size = this.syncSize() || this.lastSize;
      api.restartSession({ id: this.id, cols: size.cols || 100, rows: size.rows || 30 });
    }

    destroy() {
      this.disposeWebgl();
      try { this.term.dispose(); } catch (_err) { /* already disposed */ }
      this.tabBtn.remove();
      this.slot.remove();
    }
  }

  function createSession({ id, name }) {
    const existing = sessions.get(id);
    if (existing) return existing;
    const tab = new SessionTab({ id, name });
    sessions.set(id, tab);
    activateSession(id);
    refreshTabsVisibility();
    return tab;
  }

  function closeSession(id) {
    const tab = sessions.get(id);
    if (!tab) return;
    const wasActive = id === activeId;
    api.closeSession(id);
    tab.destroy();
    sessions.delete(id);
    if (wasActive) {
      activeId = null;
      // Activate the nearest remaining tab, or show the empty-state overlay.
      const next = [...sessions.keys()].pop();
      if (next) activateSession(next);
      else refreshEmptyState();
    }
    refreshChrome();
  }

  function activateSession(id) {
    const tab = sessions.get(id);
    if (!tab) return;
    const prev = activeSession();
    if (prev && prev !== tab) {
      prev.slot.dataset.active = "false";
      prev.tabBtn.setAttribute("aria-selected", "false");
      prev.disposeWebgl();
    }
    activeId = id;
    tab.slot.dataset.active = "true";
    tab.tabBtn.setAttribute("aria-selected", "true");
    tab.ensureWebgl();
    // The host had no layout while hidden, so measure now that it's visible.
    requestAnimationFrame(() => {
      tab.syncSize();
      tab.term.focus();
    });
    refreshChrome();
  }

  function refreshEmptyState() {
    if (sessions.size > 0) return;
    cwdLabel.textContent = "";
    // With every tab closed the terminal area would be blank; surface the same
    // overlay primitive as a dead session so "+" isn't the only way back.
    emptyOverlay.dataset.visible = "true";
  }

  // Shared overlay shown when the LAST tab closes. Lives outside any slot.
  const emptyOverlay = document.createElement("div");
  emptyOverlay.className = "bc-code-overlay";
  emptyOverlay.dataset.visible = "false";
  emptyOverlay.setAttribute("role", "status");
  const emptyMsg = document.createElement("p");
  emptyMsg.className = "bc-code-overlay-msg";
  emptyMsg.textContent = "No sessions are running.";
  const emptyActions = document.createElement("div");
  emptyActions.className = "bc-code-overlay-actions";
  const emptyStartBtn = document.createElement("button");
  emptyStartBtn.className = "bc-code-primary";
  emptyStartBtn.textContent = "Start a session";
  emptyStartBtn.addEventListener("click", () => {
    emptyOverlay.dataset.visible = "false";
    openNewSession({});
  });
  emptyActions.appendChild(emptyStartBtn);
  emptyOverlay.append(emptyMsg, emptyActions);
  termHost.appendChild(emptyOverlay);

  async function openNewSession(opts) {
    const size = lastKnownSize();
    let result;
    try {
      result = await api.newSession({
        cols: size.cols,
        rows: size.rows,
        ...opts,
      });
    } catch (_err) {
      result = null;
    }
    if (!result || !result.id) return null;
    const tab = createSession(result);
    if (result.name) tab.setName(result.name);
    return tab;
  }

  function lastKnownSize() {
    const tab = activeSession();
    if (tab) {
      const proposed = tab.proposeSize();
      if (proposed) return { cols: proposed.cols, rows: proposed.rows };
    }
    return { cols: 100, rows: 30 };
  }

  /** Status bar + tab visibility follow whichever session is on screen. */
  function refreshChrome() {
    const tab = activeSession();
    if (tab && tab.cwd) {
      cwdLabel.textContent = tab.cwd;
      cwdLabel.title = tab.cwd;
    }
    if (tab) {
      shell.dataset.state =
        tab.state === "running" ? "running"
        : tab.state === "exited" ? "exited"
        : tab.state === "failed" ? "failed"
        : "starting";
    } else {
      shell.dataset.state = "starting";
    }
    // Hide the strip entirely until there is more than one session — a single
    // session gains nothing from a tab bar costing it a row.
    refreshTabsVisibility();
  }

  function refreshTabsVisibility() {
    tabsStrip.style.display = sessions.size > 0 ? "" : "none";
    newTabBtn.style.display = sessions.size > 0 ? "" : "none";
  }

  // "+" opens another session in the pane default folder.
  newTabBtn.id = "bc-code-newtab-btn";
  newTabBtn.type = "button";
  newTabBtn.textContent = "+";
  newTabBtn.title = "New session";
  newTabBtn.addEventListener("click", () => openNewSession({}));
  tabsStrip.appendChild(newTabBtn);

  // --- Events from main, routed by session id ---

  // --- While Claude Code works: Snake ------------------------------------
  // Timing bookkeeping lives here, above the event wiring that uses it.
  let lastPtyDataAt = 0;

  api.onStarted(({ id, cwd, name, pid }) => {
    const tab = sessions.get(id) || createSession({ id, name });
    tab.setName(name);
    tab.cwd = cwd;
    tab.pid = pid;
    tab.setState("running");
    tab.hideOverlay();
    emptyOverlay.dataset.visible = "false";
    refreshChrome();
    if (id === activeId) tab.term.focus();
  });

  api.onData(({ id, chunk }) => {
    const tab = sessions.get(id);
    if (!tab) return;
    tab.term.write(chunk);
    // Timing only — never content. "Bytes arrived recently" is one of this
    // window's two signals for "Claude Code is working" (the other is the
    // session being live); it feeds only the while-you-wait snake below.
    lastPtyDataAt = Date.now();
  });

  // The main window shows its waiting popup while claude.ai is generating;
  // here the equivalent signal is pty activity — output within the last few
  // seconds of a live session. The CLI repaints its spinner constantly while
  // thinking and goes quiet at an input prompt, which is exactly the
  // working/idle split this wants. Every Playful setting applies (master
  // toggle, delay), same as the main window; dismissing covers only that one
  // wait.
  let waitingBusy = false;
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
    const anyLive = Array.from(sessions.values()).some((tab) => tab.state === "running");
    const busy = anyLive && Date.now() - lastPtyDataAt < 2500;
    if (busy !== waitingBusy) {
      waitingBusy = busy;
      waitingGame.setWorking(busy);
    }
  }, 400);

  api.onExit(({ id, exitCode, signal }) => {
    const tab = sessions.get(id);
    if (!tab) return;
    tab.setState("exited");
    const how = signal ? `signal ${signal}` : `exit code ${exitCode}`;
    tab.showOverlay(`Claude Code ended (${how}).`, [
      { label: "Restart session", primary: true, onClick: () => tab.restartInPlace() },
      { label: "New session", onClick: () => openNewSession({}) },
      { label: "Close tab", onClick: () => closeSession(id) },
    ]);
  });

  // A launch that never got off the ground: no `claude` on PATH, or the pty
  // backend failed to start. The real error text is shown as-is — a vague
  // "something went wrong" would leave the user with nothing to act on.
  api.onFatal(({ id, message }) => {
    const tab = sessions.get(id);
    if (!tab) return;
    tab.setState("failed");
    tab.showOverlay(message, [
      { label: "Try again", primary: true, onClick: () => tab.restartInPlace() },
      { label: "Close tab", onClick: () => closeSession(id) },
    ]);
  });

  // Main-driven restarts (folder change via tray/menu, resume flows).
  api.onRestarting(({ id, cwd }) => {
    let tab = sessions.get(id);
    if (!tab) tab = createSession({ id });
    tab.term.reset();
    tab.setState("starting");
    if (cwd) {
      tab.cwd = cwd;
      refreshChrome();
    }
    tab.hideOverlay();
  });

  // --- Sessions picker (per tab): local transcripts + live agent sessions ---

  async function showLocalSessionsPicker(tab) {
    const sessionsList = await api.listSessions(tab.cwd);
    const header = sessionsList.length
      ? "Resume a local Claude Code session"
      : "No saved local sessions were found for this folder.";
    const items = sessionsList.slice(0, 10).map((session) => ({
      label: `${session.lastTimestamp ? new Date(session.lastTimestamp).toLocaleString() : session.sessionId.slice(0, 8)} · ${session.messageCount || 0} messages`,
      onClick: async () => {
        const size = tab.syncSize() || tab.lastSize;
        const started = await api.resumeSession({
          id: tab.id,
          sessionId: session.sessionId,
          cwd: tab.cwd,
          cols: size.cols || 100,
          rows: size.rows || 30,
        });
        if (!started) tab.showOverlay("That saved session is no longer available for this folder.", [{ label: "Back", primary: true, onClick: () => showLocalSessionsPicker(tab) }]);
      },
    }));
    tab.showOverlay(header, [
      { label: "Local", primary: true, onClick: () => showLocalSessionsPicker(tab) },
      { label: "Cloud", onClick: () => showAgentSessionsPicker(tab) },
      ...items,
      { label: "Start a new session", onClick: () => openNewSession({ cwd: tab.cwd }) },
      { label: "Back", onClick: () => tab.hideOverlay() },
    ]);
  }

  async function showAgentSessionsPicker(tab) {
    const agentSessions = await api.listAgentSessions();
    const header = agentSessions.length
      ? "Active Claude Code sessions"
      : "No other active sessions were found.";
    const items = agentSessions.slice(0, 10).map((session) => ({
      label: `${session.name || session.sessionId.slice(0, 8)} — ${session.cwd} (${session.kind === "interactive" ? "local" : "background"})`,
      onClick: async () => {
        const size = tab.syncSize() || tab.lastSize;
        const started = await api.attachAgentSession({
          id: tab.id,
          sessionId: session.sessionId,
          cwd: session.cwd,
          cols: size.cols || 100,
          rows: size.rows || 30,
        });
        if (!started) tab.showOverlay("That session is no longer available.", [{ label: "Back", primary: true, onClick: () => showAgentSessionsPicker(tab) }]);
      },
    }));
    tab.showOverlay(header, [
      { label: "Local", onClick: () => showLocalSessionsPicker(tab) },
      { label: "Cloud", primary: true, onClick: () => showAgentSessionsPicker(tab) },
      ...items,
      { label: "Start a new session", onClick: () => openNewSession({}) },
      { label: "Back", onClick: () => tab.hideOverlay() },
    ]);
  }

  resumeBtn.addEventListener("click", () => {
    let tab = activeSession();
    if (!tab) {
      openNewSession({});
      tab = activeSession();
      if (!tab) return;
    }
    showLocalSessionsPicker(tab).catch(() => {
      tab.showOverlay("Could not load saved Claude Code sessions.", [{ label: "Back", primary: true, onClick: () => tab.hideOverlay() }]);
    });
  });

  // Change folder applies to whichever session is on screen: a pty can't move,
  // so the honest way to honour the request remains restarting that tab in the
  // picked folder.
  folderBtn.addEventListener("click", async () => {
    const path = await api.pickFolderPath();
    if (!path) return;
    let tab = activeSession();
    if (!tab) {
      await openNewSession({ cwd: path });
      return;
    }
    tab.cwd = path;
    refreshChrome();
    tab.term.reset();
    tab.setState("starting");
    const size = tab.syncSize() || tab.lastSize;
    api.restartSession({ id: tab.id, cwd: path, cols: size.cols || 100, rows: size.rows || 30 });
  });

  // --- Resize plumbing ---
  //
  // ResizeObserver rather than window.onresize: it also catches the layout
  // change when the settings panel opens/closes, when the team sidebar toggles,
  // and when the status strip reflows. Coalesced to one run per frame, and it
  // only fits the VISIBLE session — hidden slots have no layout to measure.

  let sizeFrame = 0;
  const observer = new ResizeObserver(() => {
    if (sizeFrame) return;
    sizeFrame = requestAnimationFrame(() => {
      sizeFrame = 0;
      const tab = activeSession();
      if (tab) tab.syncSize();
    });
  });
  observer.observe(termHost);

  // --- Input affordances shared by every slot ---

  // Clicking anywhere in the visible terminal should put focus back in that
  // CLI — after using the settings panel, the natural next action is typing.
  termHost.addEventListener("mousedown", (e) => {
    const tab = activeSession();
    if (!tab) return;
    if (tab.overlay.dataset.visible === "true") return;
    if (e.button === 0) tab.term.focus();
  });

  // Right-click copy/paste, the convention most terminal emulators use (PuTTY,
  // most Linux terminals): a selection means "copy that", no selection means
  // "paste". term.paste() (not api.write()) so a paste still goes through
  // xterm's own bracketed-paste-mode wrapping when the running CLI has that
  // mode enabled.
  termHost.addEventListener("contextmenu", (e) => {
    const tab = activeSession();
    if (!tab) return;
    e.preventDefault();
    if (tab.overlay.dataset.visible === "true") return;
    const selection = tab.term.getSelection();
    if (selection) {
      api.copyText(selection);
      tab.term.clearSelection();
    } else {
      Promise.resolve(api.pasteText()).then((text) => {
        if (text) tab.term.paste(text);
      });
    }
    tab.term.focus();
  });

  // Live theme + font updates apply to EVERY terminal. The ptys are untouched
  // by any of this: children never learn the colours changed, so a theme switch
  // cannot interrupt a running session.
  api.onSettingsChanged((settings) => {
    latestSettings = settings || latestSettings;
    initialSettings.codeWindow = (settings || {}).codeWindow || initialSettings.codeWindow;
    const fontFamily = currentFontFamily();
    const fontSize = currentFontSize();
    for (const tab of sessions.values()) {
      tab.term.options.theme = themeFromCSSVars();
      if (tab.term.options.fontFamily !== fontFamily) tab.term.options.fontFamily = fontFamily;
      if (tab.term.options.fontSize !== fontSize) tab.term.options.fontSize = fontSize;
    }
    const tab = activeSession();
    if (tab) tab.syncSize();
  });

  // --- Session Bundle transcript viewer bridge ---
  //
  // ui/settings-panel/sections/session-bundle.js runs in the preload/isolated
  // world (same shared document, but contextIsolation gives it its own JS
  // globals) and has no access to Terminal/FitAddon, which are main-world
  // globals this page's own <script src="xterm.bundle.js"> tag set. A
  // CustomEvent on the shared document is the handoff: the preload side
  // dispatches one carrying the DOM node it already appended (DOM nodes,
  // unlike JS classes, are the same object across worlds) plus the parsed
  // transcript data; this listener builds a second, read-only Terminal into
  // that node using the classes only this side has. Nothing here reads or
  // writes any live `claude` child — completely separate Terminal instances,
  // never wired to `api`.
  const transcriptViewers = new Map();

  function formatTranscriptMessage(message) {
    const content = message && message.message && message.message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
    }
    return "";
  }

  document.addEventListener("betterclaude:mount-transcript-viewer", (e) => {
    const { requestId, container, messages } = (e && e.detail) || {};
    if (!requestId || !container) return;

    const viewerTerm = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 5000,
      fontFamily: currentFontFamily(),
      fontSize: 13,
      theme: themeFromCSSVars(),
    });
    const viewerFit = new FitAddon();
    viewerTerm.loadAddon(viewerFit);
    viewerTerm.open(container);

    (Array.isArray(messages) ? messages : []).forEach((m) => {
      if (m.type !== "user" && m.type !== "assistant") return;
      const text = formatTranscriptMessage(m).trim();
      if (!text) return;
      const label = m.type === "user" ? "\x1b[1;36mUser\x1b[0m" : "\x1b[1;35mClaude\x1b[0m";
      viewerTerm.writeln(`${label}:`);
      text.split("\n").forEach((line) => viewerTerm.writeln(line));
      viewerTerm.writeln("");
    });

    try {
      viewerFit.fit();
    } catch {
      // Container may not have a measurable layout yet — the terminal still
      // renders at its default size, just not perfectly fitted.
    }

    transcriptViewers.set(requestId, viewerTerm);
  });

  document.addEventListener("betterclaude:unmount-transcript-viewer", (e) => {
    const { requestId } = (e && e.detail) || {};
    const viewerTerm = transcriptViewers.get(requestId);
    if (!viewerTerm) return;
    viewerTerm.dispose();
    transcriptViewers.delete(requestId);
  });

  // First paint: report the measured size so the first pty is spawned at the
  // right dimensions rather than at a guess it has to correct. The session
  // itself arrives via code:started.
  requestAnimationFrame(() => {
    const size = lastKnownSize();
    setStateStarting();
    api.ready(size.cols, size.rows);
  });

  function setStateStarting() {
    shell.dataset.state = "starting";
  }

  // Tiny handoff for sibling page scripts (ui/code-window/team-panel.js),
  // which needs to know which session is on screen without reaching into this
  // closure's internals.
  window.BetterClaudeTabs = {
    get activeId() {
      return activeId;
    },
    byId(id) {
      return sessions.get(id) || null;
    },
  };
})();
