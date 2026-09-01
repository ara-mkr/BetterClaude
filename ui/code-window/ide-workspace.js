/* Page-world controller for BetterClaude's Code-tab IDE. */
(async function () {
  "use strict";

  const api = window.betterClaudeIDE;
  const xterm = window.BetterClaudeXterm;
  const editorFactory = window.BetterClaudeIDEEditor;
  const shell = document.getElementById("bc-ide-shell");
  const $ = (id) => document.getElementById(id);
  const icon = (key) => (api.icons && api.icons[key]) || "";

  // Every icon-only control in this page's markup carries a `data-bc-icon`
  // placeholder (see electron/ide-window.html) instead of an inline glyph, so
  // there's exactly one canonical icon set (core/icons.js, bridged in by
  // electron/ide-preload.js) instead of unicode/emoji scattered through the
  // HTML. Run first and independent of everything below it, so a later
  // failure can never leave a button showing an empty placeholder.
  function applyIcons(root = document) {
    root.querySelectorAll("[data-bc-icon]").forEach((el) => {
      el.innerHTML = icon(el.dataset.bcIcon);
    });
  }
  applyIcons();

  const localMain = $("bc-ide-local-main");
  const cloudMain = $("bc-ide-cloud-main");
  const localSidebar = $("bc-ide-local-sidebar");
  const cloudSidebar = $("bc-ide-cloud-sidebar");
  const projectList = $("bc-ide-project-list");
  const sessionList = $("bc-ide-session-list");
  const agentList = $("bc-ide-agent-list");
  const fileTree = $("bc-ide-file-tree");
  const editorTabs = $("bc-ide-editor-tabs");
  const editorHost = $("bc-ide-editor-host");
  const diffPanel = $("bc-ide-diff-panel");
  const diffOutput = $("bc-ide-diff-output");
  const terminalSection = $("bc-ide-terminal");
  const terminalHost = $("bc-ide-terminal-host");
  const statusMessage = $("bc-ide-status-message");

  let projects = [];
  let sessions = [];
  let agents = [];
  let activeProject = null;
  let activeFile = null;
  let openedFiles = [];
  let editor = null;
  let editorDirty = false;
  let currentFileMtime = null;
  let term = null;
  let fitAddon = null;
  let terminalReady = false;
  let terminalSize = { cols: 100, rows: 30 };
  let source = "local";
  let activity = "explorer";
  // The last non-assistant sidebar panel, so collapsing the chat (toggle
  // click or its close button) has a panel to return to.
  let lastWorkspaceActivity = "explorer";
  window.__bcDebugActivity = () => ({ activity, last: lastWorkspaceActivity });
  let selectedAttachments = [];

  // --- Multi-session chat -------------------------------------------------
  // Each open session is one tab. Several can stream at once — every
  // ide:chat-event carries a `tabId` that routes it back to its record.
  // A record: { tabId, sessionId|null, title, permMode, transcriptEl,
  //             busy, activeAssistantMessage, seeded }
  // `sessionId` is null until the CLI reports one (a brand-new chat); once
  // set, the next turn resumes it with --resume.
  let openSessions = [];
  let activeTabId = null;
  let tabSeq = 0;
  // "chat" = the transcript is the main column; "editor" = the classic
  // file-tree + editor + terminal workspace, chat back to a right rail.
  let view = "chat";
  try {
    const storedView = localStorage.getItem("bc-ide-view");
    if (storedView === "chat" || storedView === "editor") view = storedView;
  } catch {}
  let permMode = "normal";
  try {
    const storedPerm = localStorage.getItem("bc-ide-perm-mode");
    if (["plan", "normal", "auto"].includes(storedPerm)) permMode = storedPerm;
  } catch {}

  const activeSession = () => openSessions.find((s) => s.tabId === activeTabId) || null;
  const sessionByTab = (tabId) => openSessions.find((s) => s.tabId === tabId) || null;

  // Latest merged settings, kept fresh by the workspace-settings broadcast so
  // every BetterClaude preference (themes aside, those restyle through CSS)
  // applies here exactly like it does on claude.ai — playful.snakeWhileWaiting,
  // fonts.codeFont, codeWindow.freeModels, all of it.
  let latestSettings = null;
  Promise.resolve(api.getSettings()).then((settings) => {
    if (!latestSettings && settings) latestSettings = settings;
  }).catch(() => {});

  // --- While-Claude-is-working snake -------------------------------------
  // Same contract as the main window's popup: a working edge starts the wait,
  // the configured delay gates it, dismissal covers only that one wait, and
  // the board closes itself the moment work stops. "Working" here is the OR
  // of the two real signals this window has: the chat panel's own lifecycle
  // events, and recent activity on the embedded terminal's pty (bytes within
  // the last few seconds — never content, just timing).
  let lastPtyDataAt = 0;
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

  function pollWaitingBusy() {
    if (!waitingGame) return;
    const terminalActive = terminalReady && Date.now() - lastPtyDataAt < 2500;
    const busy = openSessions.some((s) => s.busy) || terminalActive;
    if (busy !== wasWaitingBusy) {
      wasWaitingBusy = busy;
      waitingGame.setWorking(busy);
    }
  }
  setInterval(pollWaitingBusy, 400);

  // --- Terminal palette ---------------------------------------------------
  // The IDE's xterm used to be created with hardcoded violet-on-dark values,
  // so no theme ever reached it. Same approach as the CLI pane's driver
  // (ui/code-window/terminal.js): fixed, legible ANSI-16; background,
  // foreground, cursor, selection and red taken live from --bc-* vars.
  // Duplicated rather than shared because these are separate page worlds —
  // there is no module space to import from across two documents.
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

  function setStatus(message) {
    statusMessage.textContent = message;
  }

  function setBusy(message) {
    shell.dataset.state = "loading";
    $("bc-ide-status-state").textContent = message;
  }

  function showError(message) {
    shell.dataset.state = "error";
    $("bc-ide-status-state").textContent = "Error";
    setStatus(message);
  }

  function escapeText(value) {
    return String(value == null ? "" : value);
  }

  function shortPath(cwd) {
    const home = api.homeDirectory || "";
    return cwd === home ? "~" : (home && cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd);
  }

  function fileLanguage(filePath) {
    const ext = String(filePath).split(".").pop().toLowerCase();
    return ext === "css" ? "css" : "";
  }

  function fileIcon(node) {
    return icon(node.kind === "folder" ? "FOLDER" : "FILE");
  }

  function renderProjects() {
    projectList.textContent = "";
    if (!projects.length) {
      projectList.innerHTML = '<div class="bc-ide-empty-row">No project folders yet</div>';
      return;
    }
    projects.forEach((project) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bc-ide-project-row";
      button.dataset.cwd = project.cwd;
      button.innerHTML = `<span class="bc-ide-row-icon">${icon("FOLDER")}</span><span class="bc-ide-row-copy"><span class="bc-ide-row-name"></span><span class="bc-ide-row-meta"></span></span><span class="bc-ide-row-badge">${project.sessionCount || 0}</span>`;
      button.querySelector(".bc-ide-row-name").textContent = project.name;
      button.querySelector(".bc-ide-row-meta").textContent = shortPath(project.cwd);
      button.addEventListener("click", () => selectProject(project.cwd));
      if (activeProject && activeProject.cwd === project.cwd) button.classList.add("active");
      projectList.appendChild(button);
    });
  }

  function renderSessions() {
    sessionList.textContent = "";
    $("bc-ide-session-count").textContent = String(sessions.length);
    if (!sessions.length) {
      sessionList.innerHTML = '<div class="bc-ide-empty-row">No saved sessions in this folder</div>';
      return;
    }
    sessions.slice(0, 30).forEach((session) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bc-ide-session-row";
      const open = openSessions.some((s) => s.sessionId === session.sessionId);
      button.innerHTML = `<span class="bc-ide-status-dot ${open ? "live" : ""}"></span><span class="bc-ide-row-copy"><span class="bc-ide-row-name"></span><span class="bc-ide-row-meta"></span></span>`;
      button.querySelector(".bc-ide-row-name").textContent = session.title || `Session ${session.sessionId.slice(0, 8)}`;
      const stamp = session.lastTimestamp ? new Date(session.lastTimestamp).toLocaleString() : "saved";
      button.querySelector(".bc-ide-row-meta").textContent = `${stamp} · ${session.messageCount || 0} messages`;
      button.title = session.title || session.sessionId;
      button.addEventListener("click", () => openSessionInChat({ sessionId: session.sessionId, title: session.title }));
      sessionList.appendChild(button);
    });
  }

  function renderCloudRows() {
    agentList.textContent = "";
    $("bc-ide-agent-count").textContent = String(agents.length);
    $("bc-ide-cloud-stat-agents").textContent = String(agents.length);
    $("bc-ide-cloud-stat-synced").textContent = "just now";

    if (!agents.length) agentList.innerHTML = '<div class="bc-ide-empty-row">No active agents</div>';
    agents.forEach((agent) => {
      const button = makeCloudRow(agent.name || agent.sessionId.slice(0, 12), `${agent.cwd || "unknown folder"} · ${agent.kind || "active"}`, "agent");
      button.addEventListener("click", () => showCloudDetail({ ...agent, source: "Claude Code agent" }));
      agentList.appendChild(button);
    });
  }

  function makeCloudRow(name, meta, kind) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bc-ide-cloud-row";
    button.innerHTML = `<span class="bc-ide-status-dot ${kind === "agent" ? "cloud" : ""}"></span><span class="bc-ide-row-copy"><span class="bc-ide-row-name"></span><span class="bc-ide-row-meta"></span></span>`;
    button.querySelector(".bc-ide-row-name").textContent = name;
    button.querySelector(".bc-ide-row-meta").textContent = meta;
    return button;
  }

  function renderTree(nodes, depth = 0) {
    const fragment = document.createDocumentFragment();
    (nodes || []).forEach((node) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.path = node.path;
      button.className = depth ? `indent-${Math.min(depth, 2)}` : "";
      button.innerHTML = `<span class="tree-icon${node.kind === "folder" ? " folder" : ""}"></span><span class="tree-name"></span>`;
      button.querySelector(".tree-icon").innerHTML = fileIcon(node);
      button.querySelector(".tree-name").textContent = node.name;
      if (node.kind === "file") button.addEventListener("click", () => openFile(node.path));
      fragment.appendChild(button);
      if (node.kind === "folder" && node.children) fragment.appendChild(renderTree(node.children, depth + 1));
    });
    return fragment;
  }

  function renderFiles(tree) {
    fileTree.textContent = "";
    if (!tree || !tree.nodes || !tree.nodes.length) {
      fileTree.innerHTML = '<div class="bc-ide-empty-row">No visible project files</div>';
      return;
    }
    fileTree.appendChild(renderTree(tree.nodes));
    syncFileSelection();
  }

  function syncFileSelection() {
    fileTree.querySelectorAll("button[data-path]").forEach((button) => button.classList.toggle("selected", button.dataset.path === activeFile));
  }

  function renderEditorTabs() {
    editorTabs.textContent = "";
    openedFiles.forEach((filePath) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bc-ide-editor-tab";
      if (filePath === activeFile) button.classList.add("active");
      const ext = filePath.split(".").pop().toLowerCase();
      const kind = ext === "json" ? "file-json" : ext === "css" ? "file-css" : ext === "md" ? "file-md" : "file-js";
      button.innerHTML = `<span class="${kind}">${ext.toUpperCase().slice(0, 2)}</span><span></span>`;
      button.querySelector("span:last-child").textContent = filePath.split("/").pop();
      button.addEventListener("click", () => openFile(filePath));
      editorTabs.appendChild(button);
    });
  }

  async function openFile(filePath) {
    if (!activeProject) return;
    if (editorDirty && activeFile !== filePath) {
      setStatus("Save or discard the current file before switching.");
      return;
    }
    try {
      const result = await api.readFile(activeProject.cwd, filePath);
      activeFile = filePath;
      currentFileMtime = result.mtimeMs;
      editorDirty = false;
      if (!openedFiles.includes(filePath)) openedFiles.push(filePath);
      renderEditorTabs();
      syncFileSelection();
      if (editor) editor.destroy();
      editorHost.textContent = "";
      if (result.binary) {
        editorHost.innerHTML = '<div class="bc-ide-editor-empty">Binary files are not displayed in the editor.</div>';
        editor = null;
      } else {
        editor = editorFactory.mount(editorHost, {
          initialValue: result.content,
          language: fileLanguage(filePath),
          onChange: () => { editorDirty = true; setStatus(`${filePath} · unsaved changes`); },
        });
        editor.focus();
      }
      setStatus(`${filePath}${editorDirty ? " · unsaved changes" : " · ready"}`);
    } catch (error) {
      setStatus(error.message || "Could not open file.");
    }
  }

  async function showGitDiff() {
    if (!activeProject) return;
    if (!diffPanel.hidden) {
      diffPanel.hidden = true;
      editorHost.hidden = false;
      setStatus(`${activeProject.name} · editor`);
      return;
    }
    setStatus("Loading Git diff...");
    try {
      const result = await api.gitDiff(activeProject.cwd);
      diffOutput.textContent = result && result.diff
        ? result.diff
        : (result && result.isRepo ? "No uncommitted changes." : "This project is not a Git repository.");
      diffPanel.hidden = false;
      editorHost.hidden = true;
      setStatus(result && result.diff ? "Git diff · read-only" : "Git diff · clean");
    } catch (error) {
      setStatus(error.message || "Could not load Git diff.");
    }
  }

  // The scrollable host holds one .bc-ide-chat-transcript per open session;
  // only the active one is shown. A message goes into the transcript element
  // its session owns, so background sessions keep filling in while hidden.
  function transcriptFor(target) {
    if (target && target.transcriptEl) return target.transcriptEl;
    const s = activeSession();
    return s ? s.transcriptEl : null;
  }

  function scrollChatToEnd() {
    // #bc-ide-chat-messages is the single scroll container; the per-session
    // transcript divs inside it are not independently scrollable.
    const host = $("bc-ide-chat-messages");
    host.scrollTop = host.scrollHeight;
  }

  function appendChatMessage(role, text = "", target = null) {
    const host = transcriptFor(target);
    if (!host) return null;
    const welcome = host.querySelector(".bc-ide-chat-welcome");
    if (welcome) welcome.remove();
    const item = document.createElement("article");
    item.className = "bc-ide-chat-message";
    item.dataset.role = role;
    const label = document.createElement("div");
    label.className = "bc-ide-chat-label";
    label.textContent = role === "user" ? "You" : activeModelLabel || "Claude";
    const bubble = document.createElement("div");
    bubble.className = "bc-ide-chat-bubble";
    bubble.textContent = text;
    item.append(label, bubble);
    host.appendChild(item);
    if (!target || target.tabId === activeTabId) scrollChatToEnd(host);
    return bubble;
  }

  /** One-line status note inside a session's transcript. */
  function appendChatSystemNote(text, target = null) {
    const host = transcriptFor(target);
    if (!host) return;
    const welcome = host.querySelector(".bc-ide-chat-welcome");
    if (welcome) welcome.remove();
    const note = document.createElement("div");
    note.className = "bc-ide-chat-system";
    note.textContent = text;
    host.appendChild(note);
    if (!target || target.tabId === activeTabId) scrollChatToEnd(host);
  }

  // Composer chrome reflects the ACTIVE session only. Input and attach stay
  // usable while a background session streams, so you can queue work in
  // another tab.
  function syncComposerBusy() {
    const s = activeSession();
    $("bc-ide-chat-stop").hidden = !(s && s.busy);
    $("bc-ide-chat-form").dataset.busy = s && s.busy ? "true" : "false";
  }

  function renderAttachments() {
    const host = $("bc-ide-chat-attachments");
    host.textContent = "";
    host.hidden = selectedAttachments.length === 0;
    selectedAttachments.forEach((file) => {
      const chip = document.createElement("span");
      chip.className = "bc-ide-attachment-chip";
      chip.textContent = `⌘ ${file.path}`;
      host.appendChild(chip);
    });
  }

  async function refreshProjectAfterChat() {
    if (!activeProject) return;
    try {
      const [tree, info] = await Promise.all([
        api.listFiles(activeProject.cwd),
        api.gitInfo(activeProject.cwd),
      ]);
      renderFiles(tree);
      $("bc-ide-stat-files").textContent = String(tree.fileCount != null ? tree.fileCount : (tree.count || 0)) + (tree.truncated ? "+" : "");
      renderSourceControl(info);
      $("bc-ide-branch").innerHTML = info && info.branch
        ? `${icon("GIT_BRANCH")}<span>${info.branch}</span>`
        : `<span>${info && info.isRepo ? "Git repository" : "No git repository"}</span>`;
      if (activeFile && !editorDirty) await openFile(activeFile);
    } catch (error) {
      setStatus(error.message || "Project changed, but the editor could not refresh.");
    }
  }

  function endSessionTurn(s) {
    if (!s) return;
    s.busy = false;
    s.activeAssistantMessage = null;
    renderSessionTabs();
    if (s.tabId === activeTabId) syncComposerBusy();
  }

  function handleChatEvent(event = {}) {
    // Route to the tab that owns this turn; fall back to the active one for
    // pre-tab error payloads.
    const s = sessionByTab(event.tabId) || activeSession();
    if (!s) return;

    if (event.type === "start") {
      activeModelLabel = event.modelLabel || (selectedModel === "claude" ? "Claude" : modelLabelFor(selectedModel));
      s.busy = true;
      renderSessionTabs();
      if (s.tabId === activeTabId) syncComposerBusy();
      return;
    }
    if (event.type === "model-switch") {
      activeModelLabel = event.modelLabel || event.modelId;
      if (!s.activeAssistantMessage || !s.activeAssistantMessage.textContent) {
        appendChatSystemNote(`Answering with ${activeModelLabel}${event.keyless ? " (no login)" : ""}${event.total > 1 ? ` · free provider ${event.attempt}/${event.total}` : ""}…`, s);
      }
      setStatus(`${activeModelLabel} is thinking...`);
      return;
    }
    if (event.type === "session" && event.sessionId) {
      s.sessionId = event.sessionId;
      return;
    }
    if (event.type === "delta" && event.text) {
      if (!s.activeAssistantMessage) s.activeAssistantMessage = appendChatMessage("assistant", "", s);
      s.activeAssistantMessage.textContent += event.text;
      if (s.tabId === activeTabId) scrollChatToEnd(s.transcriptEl);
      return;
    }
    if (event.type === "diagnostic") {
      setStatus(String(event.message || "").slice(0, 180));
      return;
    }
    if (event.type === "error") {
      if (!s.activeAssistantMessage) s.activeAssistantMessage = appendChatMessage("assistant", "", s);
      s.activeAssistantMessage.textContent = event.message || "Claude could not complete that request.";
      const failoverOff = !(latestSettings && latestSettings.codeWindow && latestSettings.codeWindow.freeModels && latestSettings.codeWindow.freeModels.autoFailover !== false);
      if (/usage limit|rate.?limit|credit|quota/i.test(event.message || "") && failoverOff) {
        appendChatSystemNote("Free-model auto-failover is off — open the model picker to switch providers or turn it on.", s);
      }
      endSessionTurn(s);
      setStatus("Claude request failed");
      return;
    }
    if (event.type === "stopped") {
      endSessionTurn(s);
      setStatus("Claude request stopped");
      return;
    }
    if (event.type === "done") {
      if (!s.busy) return;
      endSessionTurn(s);
      setStatus(event.modelLabel && event.modelLabel !== "Claude" ? `${event.modelLabel} response ready` : "Claude response ready");
      refreshProjectAfterChat();
      refreshSessionList();
    }
  }

  async function sendChatMessage(event) {
    if (event) event.preventDefault();
    if (!activeProject) return;
    const input = $("bc-ide-chat-input");
    const prompt = input.value.trim();
    if (!prompt) return;

    let s = activeSession();
    if (!s) s = newChatSession();
    if (s.busy) { setStatus("This session is still answering — open a new tab to ask something else."); return; }

    const attachments = selectedAttachments.slice();
    appendChatMessage("user", prompt + (attachments.length ? `\n\nAttached: ${attachments.map((file) => file.path).join(", ")}` : ""), s);
    if (!s.title || s.title === "New session") {
      s.title = prompt.replace(/\s+/g, " ").slice(0, 48);
    }
    s.activeAssistantMessage = null;
    s.busy = true;
    input.value = "";
    autosizeComposer();
    selectedAttachments = [];
    renderAttachments();
    renderSessionTabs();
    syncComposerBusy();
    activeModelLabel = selectedModel === "claude" ? "Claude" : modelLabelFor(selectedModel);
    setStatus(`${activeModelLabel} is thinking...`);
    try {
      const started = await api.chat({
        cwd: activeProject.cwd,
        prompt,
        attachments,
        sessionId: s.sessionId,
        model: selectedModel,
        permissionMode: s.permMode || permMode,
        tabId: s.tabId,
      });
      if (!started) {
        appendChatMessage("assistant", "Claude Code could not start. Check that the Claude CLI is installed and signed in.", s);
        endSessionTurn(s);
      }
    } catch (error) {
      appendChatMessage("assistant", error.message || "Claude Code could not start.", s);
      endSessionTurn(s);
      setStatus("Claude request failed");
    }
  }

  // --- Session tabs + views --------------------------------------------

  function setView(next) {
    view = next === "editor" ? "editor" : "chat";
    shell.dataset.view = view;
    try { localStorage.setItem("bc-ide-view", view); } catch {}
    if (view === "chat") {
      $("bc-ide-chat-panel").hidden = false;
      $("bc-ide-chat-input").focus();
    }
  }

  function renderSessionTabs() {
    const strip = $("bc-ide-session-tabs");
    strip.textContent = "";
    openSessions.forEach((s) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "bc-ide-session-tab" + (s.tabId === activeTabId ? " active" : "");
      tab.dataset.tabId = s.tabId;
      tab.setAttribute("role", "tab");
      tab.innerHTML = `<span class="bc-ide-session-tab-dot${s.busy ? " live" : ""}"></span><span class="bc-ide-session-tab-name"></span><span class="bc-ide-session-tab-close" role="button" aria-label="Close session">${icon("CLOSE")}</span>`;
      tab.querySelector(".bc-ide-session-tab-name").textContent = s.title || "New session";
      tab.title = s.title || "New session";
      tab.addEventListener("click", (event) => {
        if (event.target.closest(".bc-ide-session-tab-close")) { closeSession(s.tabId); return; }
        showTranscript(s.tabId);
      });
      strip.appendChild(tab);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "bc-ide-session-tab-add";
    add.title = "New Claude session";
    add.setAttribute("aria-label", "New Claude session");
    add.innerHTML = icon("PLUS");
    add.addEventListener("click", () => { newChatSession(); });
    strip.appendChild(add);
  }

  function showTranscript(tabId) {
    const s = sessionByTab(tabId);
    if (!s) return;
    activeTabId = tabId;
    const host = $("bc-ide-chat-messages");
    host.querySelectorAll(".bc-ide-chat-transcript").forEach((el) => {
      el.classList.toggle("active", el === s.transcriptEl);
    });
    // Composer reflects this session.
    permMode = s.permMode || permMode;
    syncPermModeButtons();
    syncComposerBusy();
    renderSessionTabs();
    $("bc-ide-chat-subtitle").textContent = s.sessionId ? `Resuming ${s.sessionId.slice(0, 8)}` : "New session";
    scrollChatToEnd(s.transcriptEl);
  }

  function makeSessionRecord({ sessionId = null, title = "New session" } = {}) {
    const tabId = `tab-${++tabSeq}-${Date.now().toString(36)}`;
    const transcriptEl = document.createElement("div");
    transcriptEl.className = "bc-ide-chat-transcript";
    transcriptEl.dataset.tabId = tabId;
    $("bc-ide-chat-messages").appendChild(transcriptEl);
    const record = { tabId, sessionId, title, permMode, transcriptEl, busy: false, activeAssistantMessage: null };
    openSessions.push(record);
    return record;
  }

  function newChatSession() {
    const record = makeSessionRecord();
    record.transcriptEl.innerHTML = '<div class="bc-ide-chat-welcome"><strong>New Claude session</strong><p>Ask about this project, or type / for commands. This starts a fresh session — it will appear in the sidebar once it has a first reply.</p></div>';
    setView("chat");
    showTranscript(record.tabId);
    return record;
  }

  async function openSessionInChat(sessionMeta) {
    if (!activeProject || !sessionMeta || !sessionMeta.sessionId) return;
    const existing = openSessions.find((s) => s.sessionId === sessionMeta.sessionId);
    if (existing) { setView("chat"); showTranscript(existing.tabId); return; }

    const record = makeSessionRecord({ sessionId: sessionMeta.sessionId, title: sessionMeta.title || `Session ${sessionMeta.sessionId.slice(0, 8)}` });
    record.transcriptEl.innerHTML = '<div class="bc-ide-chat-welcome">Loading transcript…</div>';
    setView("chat");
    showTranscript(record.tabId);
    setStatus(`Opening ${record.title}…`);
    try {
      const result = await api.readSession(activeProject.cwd, sessionMeta.sessionId);
      record.transcriptEl.textContent = "";
      const turns = (result && result.turns) || [];
      if (!turns.length) {
        appendChatSystemNote(result && result.error ? result.error : "This session's transcript is empty.", record);
      } else {
        turns.forEach((turn) => appendChatMessage(turn.role === "user" ? "user" : "assistant", turn.text, record));
      }
      setStatus(`${record.title} · ${turns.length} message${turns.length === 1 ? "" : "s"}`);
      scrollChatToEnd(record.transcriptEl);
    } catch (error) {
      record.transcriptEl.textContent = "";
      appendChatSystemNote(error.message || "Could not load that session.", record);
    }
  }

  function closeSession(tabId) {
    const idx = openSessions.findIndex((s) => s.tabId === tabId);
    if (idx === -1) return;
    const s = openSessions[idx];
    if (s.busy) api.stopChat(tabId);
    s.transcriptEl.remove();
    openSessions.splice(idx, 1);
    if (activeTabId === tabId) {
      const next = openSessions[idx] || openSessions[idx - 1] || null;
      if (next) showTranscript(next.tabId);
      else { activeTabId = null; renderSessionTabs(); $("bc-ide-chat-subtitle").textContent = "Project-aware assistant"; }
    } else {
      renderSessionTabs();
    }
  }

  async function refreshSessionList() {
    if (!activeProject) return;
    try {
      sessions = (await api.listSessions(activeProject.cwd)) || [];
      renderSessions();
    } catch {}
  }

  function autosizeComposer() {
    const input = $("bc-ide-chat-input");
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }

  function syncPermModeButtons() {
    document.querySelectorAll("#bc-ide-perm-mode button[data-perm]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.perm === permMode));
    });
  }

  function setPermMode(next) {
    if (!["plan", "normal", "auto"].includes(next)) return;
    permMode = next;
    try { localStorage.setItem("bc-ide-perm-mode", next); } catch {}
    const s = activeSession();
    if (s) s.permMode = next;
    syncPermModeButtons();
    setStatus(next === "plan" ? "Plan mode — Claude will not edit files" : next === "auto" ? "Auto mode — Claude runs edits and commands" : "Normal mode");
  }

  // --- Slash-command menu ----------------------------------------------
  const SLASH_COMMANDS = [
    { name: "/clear", blurb: "Start a fresh context in this session" },
    { name: "/compact", blurb: "Summarise the conversation so far" },
    { name: "/review", blurb: "Review the current changes" },
    { name: "/model", blurb: "Switch the Claude model" },
    { name: "/cost", blurb: "Show token usage and cost" },
    { name: "/context", blurb: "Show what's in the context window" },
    { name: "/init", blurb: "Generate or refresh CLAUDE.md" },
    { name: "/pr", blurb: "Open a pull request for this branch" },
  ];

  function slashCandidates(fragment) {
    const q = fragment.replace(/^\//, "").toLowerCase();
    const prompts = ((latestSettings && latestSettings.promptLibrary && latestSettings.promptLibrary.prompts) || [])
      .map((p) => ({ name: `/${(p.title || "prompt").replace(/\s+/g, "-").toLowerCase()}`, blurb: "Prompt library", body: p.body || p.text || "" }));
    return [...SLASH_COMMANDS, ...prompts].filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, 8);
  }

  let slashIndex = 0;
  function refreshSlashMenu() {
    const input = $("bc-ide-chat-input");
    const menu = $("bc-ide-slash-menu");
    const value = input.value;
    if (!value.startsWith("/") || value.includes("\n")) { menu.hidden = true; return; }
    const items = slashCandidates(value);
    if (!items.length) { menu.hidden = true; return; }
    if (slashIndex >= items.length) slashIndex = 0;
    menu.textContent = "";
    items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "bc-ide-slash-row" + (i === slashIndex ? " active" : "");
      row.innerHTML = `<strong></strong><small></small>`;
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
    if (item.body) input.value = item.body;
    else input.value = `${item.name} `;
    $("bc-ide-slash-menu").hidden = true;
    input.focus();
    autosizeComposer();
  }

  // --- Push-to-talk voice (macOS; see electron/speech.js) --------------
  let micStream = null;
  let micNodes = null;
  let micChunks = [];
  let micRecording = false;

  async function startMic() {
    if (micRecording) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setStatus(error && error.name === "NotAllowedError" ? "Microphone access was denied." : "No microphone available.");
      return;
    }
    micRecording = true;
    micChunks = [];
    $("bc-ide-mic").classList.add("recording");
    setStatus("Listening…");
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(micStream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!micRecording) return;
      micChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
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
    if (nodes) {
      try { nodes.processor.disconnect(); nodes.source.disconnect(); nodes.ctx.close(); } catch {}
    }
    const wav = encodeWav(micChunks, nodes ? nodes.sampleRate : 48000);
    micChunks = [];
    if (!wav || wav.byteLength < 4096) { setStatus("Didn't catch that."); return; }
    setStatus("Transcribing…");
    try {
      const result = await api.transcribe(wav);
      if (result && result.text) {
        const input = $("bc-ide-chat-input");
        input.value = (input.value ? input.value.replace(/\s*$/, " ") : "") + result.text;
        autosizeComposer();
        input.focus();
        setStatus("Transcribed");
      } else {
        setStatus((result && result.error) || "Could not transcribe that.");
      }
    } catch (error) {
      setStatus(error.message || "Transcription failed.");
    }
  }

  // Downsample the captured 32-bit float PCM to 16 kHz mono and wrap it in a
  // WAV container — the shape whisper.cpp expects. Kept in the renderer so the
  // main process only ever receives a ready-to-transcribe file.
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

  // --- Model picker -------------------------------------------------------
  // Who answers this chat: the user's Claude subscription, or any model that
  // is free right now. The free list is scraped live from OpenRouter's public
  // catalog by the main process (electron/openrouter.js) and always ends with
  // a genuinely keyless provider, so "no login" stays true even when
  // OpenRouter's own free tier demands an API key. The choice persists in
  // this window; the auto-failover toggle and optional key persist in real
  // settings so they apply app-wide.
  const MODEL_STORAGE_KEY = "bc-ide-chat-model";
  let selectedModel = (() => {
    try {
      return localStorage.getItem(MODEL_STORAGE_KEY) || "claude";
    } catch {
      return "claude";
    }
  })();
  let activeModelLabel = "Claude";
  let freeModelsCache = null;
  let freeModelsPromise = null;

  function freeModelsConfigLocal() {
    return (latestSettings && latestSettings.codeWindow && latestSettings.codeWindow.freeModels) || {};
  }

  function modelLabelFor(id) {
    if (!id || id === "claude") return "Claude";
    if (freeModelsCache) {
      const match = freeModelsCache.find((model) => model.id === id);
      if (match) return match.displayName || match.id;
    }
    return id;
  }

  function formatContext(tokens) {
    if (!tokens) return "";
    if (tokens >= 1000000) return `${Math.round((tokens / 1000000) * 10) / 10}M ctx`;
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}K ctx`;
    return `${tokens} ctx`;
  }

  function ensureFreeModels() {
    if (freeModelsCache) return Promise.resolve(freeModelsCache);
    if (!freeModelsPromise) {
      freeModelsPromise = Promise.resolve(api.listFreeModels())
        .then((models) => {
          freeModelsCache = Array.isArray(models) ? models : [];
          updateModelButtonLabel();
          return freeModelsCache;
        })
        .catch(() => {
          freeModelsCache = [];
          return freeModelsCache;
        });
    }
    return freeModelsPromise;
  }

  function closeModelMenu() {
    const menu = $("bc-ide-model-menu");
    menu.hidden = true;
    $("bc-ide-model-btn").setAttribute("aria-expanded", "false");
  }

  function renderModelMenu(models) {
    const menu = $("bc-ide-model-menu");
    menu.textContent = "";

    const config = freeModelsConfigLocal();
    const enabled = config.enabled !== false;

    const claudeRow = document.createElement("button");
    claudeRow.type = "button";
    claudeRow.className = "bc-ide-model-row";
    claudeRow.innerHTML = `<span class="bc-ide-model-copy"><strong>Claude</strong><small>Your subscription</small></span><span class="bc-ide-model-check">${icon("CHECK")}</span>`;
    claudeRow.classList.toggle("selected", selectedModel === "claude");
    claudeRow.addEventListener("click", () => selectModel("claude"));
    menu.appendChild(claudeRow);

    if (!enabled) {
      const note = document.createElement("div");
      note.className = "bc-ide-model-note";
      note.textContent = "Free fallback is off in settings.";
      menu.appendChild(note);
    } else if (models.length) {
      const openRouter = models.filter((model) => model.kind === "openrouter");
      const keyless = models.filter((model) => model.keyless);

      const header = document.createElement("div");
      header.className = "bc-ide-model-header";
      header.textContent = "Free right now · OpenRouter";
      menu.appendChild(header);

      const list = document.createElement("div");
      list.className = "bc-ide-model-list";
      const renderModelRow = (model) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "bc-ide-model-row";
        row.title = model.description || model.displayName;
        row.innerHTML = `<span class="bc-ide-model-copy"><strong></strong><small></small></span><span class="bc-ide-model-free">FREE</span><span class="bc-ide-model-check">${icon("CHECK")}</span>`;
        row.querySelector("strong").textContent = model.displayName || model.id;
        row.querySelector("small").textContent = [model.provider, formatContext(model.contextLength)].filter(Boolean).join(" · ");
        row.classList.toggle("selected", selectedModel === model.id);
        row.addEventListener("click", () => selectModel(model.id));
        list.appendChild(row);
      };
      openRouter.forEach(renderModelRow);

      if (keyless.length) {
        const keylessHeader = document.createElement("div");
        keylessHeader.className = "bc-ide-model-header";
        keylessHeader.textContent = "No login needed";
        menu.appendChild(list);
        menu.appendChild(keylessHeader);
        const keylessList = document.createElement("div");
        keylessList.className = "bc-ide-model-list";
        keyless.forEach(renderModelRow);
        menu.appendChild(keylessList);
      } else {
        menu.appendChild(list);
      }
    } else {
      const note = document.createElement("div");
      note.className = "bc-ide-model-note";
      note.textContent = "Could not load the free-model list right now.";
      menu.appendChild(note);
    }

    // Footer: the two knobs that decide how automatic all of this is.
    const footer = document.createElement("div");
    footer.className = "bc-ide-model-foot";

    const failoverLabel = document.createElement("label");
    failoverLabel.className = "bc-ide-model-toggle";
    const failoverCheck = document.createElement("input");
    failoverCheck.type = "checkbox";
    failoverCheck.checked = config.autoFailover !== false;
    failoverCheck.addEventListener("change", () => {
      api.setSetting("codeWindow.freeModels.autoFailover", failoverCheck.checked).then((updated) => { latestSettings = updated; }).catch(() => {});
    });
    failoverLabel.append(failoverCheck, document.createTextNode("Auto-switch when Claude hits its limit"));
    footer.appendChild(failoverLabel);

    const keyWrap = document.createElement("label");
    keyWrap.className = "bc-ide-model-key";
    keyWrap.textContent = "OpenRouter key (optional)";
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.placeholder = "sk-or-…";
    keyInput.value = config.openRouterKey || "";
    let keyTimer = null;
    keyInput.addEventListener("input", () => {
      clearTimeout(keyTimer);
      keyTimer = setTimeout(() => {
        api.setSetting("codeWindow.freeModels.openRouterKey", keyInput.value.trim()).then((updated) => { latestSettings = updated; }).catch(() => {});
      }, 500);
    });
    keyWrap.appendChild(keyInput);
    footer.appendChild(keyWrap);
    menu.appendChild(footer);
  }

  async function openModelMenu() {
    const menu = $("bc-ide-model-menu");
    menu.hidden = false;
    $("bc-ide-model-btn").setAttribute("aria-expanded", "true");
    renderModelMenu(freeModelsCache || []);
    const models = await ensureFreeModels();
    if (!menu.hidden) renderModelMenu(models);
  }

  function selectModel(id) {
    selectedModel = id || "claude";
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
    } catch {}
    activeModelLabel = modelLabelFor(selectedModel);
    updateModelButtonLabel();
    closeModelMenu();
    setStatus(selectedModel === "claude" ? "Chatting with Claude" : `Next message goes to ${activeModelLabel}`);
  }

  function updateModelButtonLabel() {
    const button = $("bc-ide-model-btn");
    if (!button) return;
    const label = selectedModel === "claude"
      ? "Claude"
      : (modelLabelFor(selectedModel).length > 26 ? `${modelLabelFor(selectedModel).slice(0, 25)}…` : modelLabelFor(selectedModel));
    button.textContent = label;
    button.title = selectedModel === "claude"
      ? "Answering with your Claude subscription — click to pick a free provider instead"
      : `Answering with ${modelLabelFor(selectedModel)} (free) — click to change`;
    button.dataset.free = selectedModel === "claude" ? "false" : "true";
  }

  async function attachProjectFiles() {
    if (!activeProject) return;
    try {
      const files = await api.pickFiles(activeProject.cwd);
      selectedAttachments = files.filter((file) => !file.binary && typeof file.content === "string");
      renderAttachments();
      if (selectedAttachments.length) setStatus(`${selectedAttachments.length} file${selectedAttachments.length === 1 ? "" : "s"} attached`);
    } catch (error) {
      setStatus(error.message || "Could not attach those files.");
    }
  }

  async function refreshSourceControl() {
    if (!activeProject) return;
    try {
      const info = await api.gitInfo(activeProject.cwd);
      renderSourceControl(info);
      $("bc-ide-branch").innerHTML = info && info.branch
        ? `${icon("GIT_BRANCH")}<span>${info.branch}</span>`
        : `<span>${info && info.isRepo ? "Git repository" : "No git repository"}</span>`;
      setStatus("Source control refreshed");
    } catch (error) {
      setStatus(error.message || "Could not refresh source control.");
    }
  }

  function renderSourceControl(info) {
    const summary = $("bc-ide-source-summary");
    if (!info || !info.isRepo) {
      summary.textContent = "This folder is not a Git repository.";
      return;
    }
    summary.textContent = `${info.branch || "Detached HEAD"}\n${info.changedFiles || 0} changed file${info.changedFiles === 1 ? "" : "s"}${info.diffStat ? `\n${info.diffStat}` : ""}`;
  }

  function setActivity(next) {
    // Claude = the chat-first main view. It leaves the sidebar on whatever
    // workspace panel is up (so the session list stays in reach) and only
    // flips the main column. The other buttons return to the editor view.
    if (next === "claude") {
      document.querySelectorAll(".bc-ide-activity-btn[data-activity]").forEach((button) => {
        const active = button.dataset.activity === "claude";
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      activity = "claude";
      shell.dataset.activity = "claude";
      setView("chat");
      return;
    }
    if (next === "settings") { api.openSettings(); return; }

    lastWorkspaceActivity = next;
    activity = next;
    shell.dataset.activity = next;
    setView("editor");
    document.querySelectorAll(".bc-ide-activity-btn[data-activity]").forEach((button) => {
      const active = button.dataset.activity === next;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const labels = { explorer: "Explorer", source: "Source Control", extensions: "Extensions" };
    $("bc-ide-sidebar-heading").textContent = labels[next] || "Explorer";
    ["explorer", "source", "extensions"].forEach((panel) => {
      const element = $(`bc-ide-${panel}-panel`);
      if (element) element.hidden = panel !== next;
    });
    if (next === "source") refreshSourceControl();
    if (next === "extensions") {
      setExtensionTab(extensionTab);
      loadExtensions();
      if (extensionTab === "browse") runBrowse($("bc-ide-extension-search").value);
    }
  }

  // --- Extensions panel ----------------------------------------------------
  // Two sources, one list shape:
  //   Installed — what is actually on disk for every VS Code-family editor
  //               this machine has (see electron/ide-workspace.js).
  //   Browse    — a curated catalog bundled with the app, or live Open VSX
  //               registry search once you type. Install downloads the .vsix
  //               and unpacks it into that same on-disk layout, so anything
  //               installed here shows up under Installed immediately.
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
    if (next === "installed") {
      loadExtensions();
    } else {
      runBrowse($("bc-ide-extension-search").value);
    }
  }

  function isExtensionInstalled(id) {
    return installedExtensions.some((extension) => extension.id === String(id).toLowerCase());
  }

  function extensionRowInner({ iconHtml, title, subtitle, actionHtml }) {
    return `<span class="bc-ide-extension-icon">${iconHtml}</span><span class="bc-ide-ext-copy"><strong></strong><small></small></span><span class="bc-ide-ext-action">${actionHtml || ""}</span>`;
  }

  function renderInstalledExtensions() {
    const host = $("bc-ide-extension-list");
    if (extensionTab !== "installed") return;
    $("bc-ide-extension-count").textContent = String(installedExtensions.length);
    host.textContent = "";
    if (!installedExtensions.length) {
      host.innerHTML = '<div class="bc-ide-empty-row">No VS Code, Cursor, or Antigravity extensions found on this machine.<br />Open Browse to install some.</div>';
      return;
    }
    installedExtensions.forEach((extension) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bc-ide-extension-row";
      const iconHtml = extension.icon ? `<img src="${extension.icon}" alt="" />` : icon("EXTENSIONS");
      button.innerHTML = `${extensionRowInner({ iconHtml })}<span class="bc-ide-ext-remove" title="Uninstall from ${extension.host}" role="button">${icon("CLOSE")}</span>`;
      button.querySelector("strong").textContent = extension.displayName;
      button.querySelector("small").textContent = `${extension.publisher} · ${extension.host} · v${extension.version}`;
      button.title = extension.description || extension.displayName;
      button.querySelector(".bc-ide-ext-remove").addEventListener("click", async (event) => {
        event.stopPropagation();
        setExtensionStatus(`Uninstalling ${extension.displayName}…`);
        try {
          await api.uninstallExtension(extension.id);
          await loadExtensions();
          setExtensionStatus(`${extension.displayName} uninstalled.`);
        } catch (error) {
          setExtensionStatus(error.message || "Could not uninstall that extension.");
        }
      });
      host.appendChild(button);
    });
  }

  function renderBrowseExtensions() {
    const host = $("bc-ide-extension-list");
    if (extensionTab !== "browse") return;
    const results = browseResults || [];
    $("bc-ide-extension-count").textContent = String(results.length);
    host.textContent = "";
    if (!results.length) {
      host.innerHTML = '<div class="bc-ide-empty-row">Nothing matched that search.</div>';
      return;
    }
    results.forEach((extension) => {
      const row = document.createElement("div");
      row.className = "bc-ide-extension-row bc-ide-ext-browse-row";
      const iconHtml = extension.icon ? `<img src="${extension.icon}" alt="" />` : icon("EXTENSIONS");
      const installedAlready = isExtensionInstalled(extension.id);
      const busy = installingIds.has(extension.id);
      row.innerHTML = extensionRowInner({
        iconHtml,
        actionHtml: `<button type="button" class="bc-ide-command bc-ide-ext-install" ${installedAlready ? "disabled" : ""}>${busy ? "Installing…" : installedAlready ? "Installed" : "Install"}</button>`,
      });
      row.querySelector("strong").textContent = extension.displayName;
      const meta = [extension.publisher, extension.source === "registry" ? (extension.downloads != null ? `${extension.downloads.toLocaleString()} installs` : "registry") : extension.category].filter(Boolean).join(" · ");
      row.querySelector("small").textContent = meta;
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
          setExtensionStatus(result && result.alreadyInstalled
            ? `${extension.displayName} was already installed.`
            : `${extension.displayName} installed into ${(result && result.extension && result.extension.host) || "your editor"}.`);
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
    // One in-flight request; a newer keystroke supersedes an older search.
    const token = Symbol("browse");
    browseInFlight = token;
    if (!needle) {
      // Empty box: the offline catalog answers instantly, no network.
      try {
        const results = await api.searchExtensions("");
        if (browseInFlight === token) {
          browseResults = results;
          renderBrowseExtensions();
        }
      } catch {
        browseResults = [];
        renderBrowseExtensions();
      }
      return;
    }
    setExtensionStatus("Searching extensions…");
    try {
      const results = await api.searchExtensions(needle);
      if (browseInFlight !== token) return;
      browseResults = results;
      setExtensionStatus("");
      renderBrowseExtensions();
    } catch (error) {
      if (browseInFlight !== token) return;
      browseResults = [];
      setExtensionStatus(error.message || "Extension search failed.");
      renderBrowseExtensions();
    }
  }

  async function loadExtensions() {
    try {
      installedExtensions = (await api.listExtensions()) || [];
    } catch (error) {
      installedExtensions = [];
      $("bc-ide-extension-list").innerHTML = '<div class="bc-ide-empty-row">Could not read installed extensions.</div>';
      return;
    }
    if (extensionTab === "installed") renderInstalledExtensions();
    else renderBrowseExtensions();
  }

  async function selectProject(cwd) {
    const project = projects.find((item) => item.cwd === cwd);
    if (!project) return;
    if (editorDirty) {
      setStatus("Save or discard the current file before changing projects.");
      return;
    }
    const projectChanged = !activeProject || activeProject.cwd !== project.cwd;
    if (projectChanged) {
      // Drop every open chat session — their transcripts and --resume ids
      // belong to the project we're leaving.
      openSessions.forEach((s) => { if (s.busy) api.stopChat(s.tabId); });
      openSessions = [];
      activeTabId = null;
      $("bc-ide-chat-messages").textContent = "";
      renderSessionTabs();
      syncComposerBusy();
      activeFile = null;
      openedFiles = [];
      currentFileMtime = null;
      editorDirty = false;
      diffPanel.hidden = true;
      editorHost.hidden = false;
      if (editor) editor.destroy();
      editor = null;
      editorHost.innerHTML = '<div class="bc-ide-editor-empty">Choose a file to open it in the editor.</div>';
      renderEditorTabs();
    }
    activeProject = project;
    renderProjects();
    setBusy("Loading");
    $("bc-ide-project-crumb").textContent = project.name;
    $("bc-ide-project-title").textContent = project.name;
    $("bc-ide-status-cwd").textContent = shortPath(project.cwd);
    $("bc-ide-terminal-cwd").textContent = shortPath(project.cwd);
    try {
      const [tree, info, nextSessions] = await Promise.all([
        api.listFiles(project.cwd),
        api.gitInfo(project.cwd),
        api.listSessions(project.cwd),
      ]);
      sessions = nextSessions || [];
      renderSessions();
      renderFiles(tree);
      $("bc-ide-stat-files").textContent = String(tree.fileCount != null ? tree.fileCount : (tree.count || 0)) + (tree.truncated ? "+" : "");
      $("bc-ide-stat-sessions").textContent = String(sessions.length);
      $("bc-ide-branch").innerHTML = info && info.branch
        ? `${icon("GIT_BRANCH")}<span>${info.branch}</span>`
        : `<span>${info && info.isRepo ? "Git repository" : "No git repository"}</span>`;
      renderSourceControl(info);
      $("bc-ide-status-state").textContent = "Ready";
      shell.dataset.state = "ready";
      setStatus(`${project.name} · local project`);
      if (!activeFile) {
        const firstFile = findFirstFile(tree && tree.nodes);
        if (firstFile) await openFile(firstFile);
      }
      await api.setLastProject(project.cwd);
      if (view === "chat" && !openSessions.length) ensureChatSession();
      await startTerminal(project.cwd);
    } catch (error) {
      showError(error.message || "Could not load project.");
    }
  }

  // Chat-first landing: show the newest saved session, or a fresh one.
  function ensureChatSession() {
    if (openSessions.length) return;
    if (sessions.length) openSessionInChat({ sessionId: sessions[0].sessionId, title: sessions[0].title });
    else newChatSession();
  }

  function findFirstFile(nodes) {
    for (const node of nodes || []) {
      if (node.kind === "file") return node.path;
      const nested = findFirstFile(node.children);
      if (nested) return nested;
    }
    return null;
  }

  async function startNewSession() {
    if (!activeProject) return;
    setStatus("Starting a new Claude Code session...");
    await api.startSession(activeProject.cwd, terminalSize.cols, terminalSize.rows);
  }

  function showCloudDetail(item) {
    $("bc-ide-cloud-empty").hidden = true;
    $("bc-ide-cloud-detail").hidden = false;
    $("bc-ide-detail-source").textContent = item.source || "Cloud session";
    $("bc-ide-detail-title").textContent = item.title || item.name || item.sessionId || "Cloud session";
    $("bc-ide-detail-copy").textContent = "This active Claude Code agent can attach to the local terminal workspace.";
    $("bc-ide-detail-project").textContent = item.project || item.cwd || "Claude.ai";
    $("bc-ide-detail-location").textContent = item.cwd ? shortPath(item.cwd) : "Remote";
    $("bc-ide-detail-activity").textContent = item.startedAt || item.updatedAt || "Active";
    const action = $("bc-ide-detail-action");
    action.textContent = "Attach session";
    action.onclick = async () => {
      const ok = await api.attachAgent(item.sessionId, item.cwd, terminalSize.cols, terminalSize.rows);
      setStatus(ok ? "Cloud agent attached to terminal" : "That agent is no longer available.");
    };
    document.querySelectorAll(".bc-ide-cloud-row").forEach((row) => row.classList.remove("active"));
    setStatus(`${item.source || "Cloud"} selected`);
  }

  function setSource(next) {
    source = next;
    const isLocal = source === "local";
    $("bc-ide-local").setAttribute("aria-pressed", String(isLocal));
    $("bc-ide-cloud").setAttribute("aria-pressed", String(!isLocal));
    localSidebar.hidden = !isLocal;
    cloudSidebar.hidden = isLocal;
    localMain.hidden = !isLocal;
    cloudMain.hidden = isLocal;
    $("bc-ide-sidebar-status").textContent = isLocal ? "· local workspace" : "· connected sources";
    if (!isLocal) loadCloudSources();
  }

  async function loadCloudSources() {
    try {
      agents = await api.listAgents();
      renderCloudRows();
    } catch (error) {
      setStatus(error.message || "Cloud sources are unavailable.");
    }
  }

  async function saveCurrentFile() {
    if (!editor || !activeProject || !activeFile || !editorDirty) return;
    const result = await api.writeFile(activeProject.cwd, activeFile, editor.getValue(), currentFileMtime);
    if (result.conflict) {
      setStatus("File changed outside BetterClaude. Reload it before saving.");
      return;
    }
    currentFileMtime = result.mtimeMs;
    editorDirty = false;
    setStatus(`${activeFile} · saved`);
  }

  async function startTerminal(cwd) {
    if (!term) {
      term = new xterm.Terminal({
        cursorBlink: true,
        scrollback: 4000,
        fontFamily: "var(--bc-ide-code-font)",
        fontSize: Number((latestSettings && latestSettings.codeWindow && latestSettings.codeWindow.fontSizePx)) || 13,
        theme: terminalThemeFromCSSVars(),
      });
      fitAddon = new xterm.FitAddon();
      term.loadAddon(fitAddon);
      term.open(terminalHost);
      term.onData((data) => api.write(data));
      api.onData((chunk) => {
        term.write(chunk);
        // Timing only, never content: recent pty output is one of the two
        // signals feeding the while-Claude-is-working snake.
        lastPtyDataAt = Date.now();
      });
      api.onStarted(({ cwd: startedCwd }) => {
        terminalReady = true;
        shell.dataset.state = "ready";
        $("bc-ide-terminal-dot").classList.add("live");
        $("bc-ide-terminal-cwd").textContent = shortPath(startedCwd);
        setStatus("Local Claude Code session active");
      });
      api.onExit(({ exitCode, signal }) => {
        terminalReady = false;
        $("bc-ide-terminal-dot").classList.remove("live");
        setStatus(`Claude Code ended (${signal ? `signal ${signal}` : `exit ${exitCode}`})`);
      });
      api.onFatal(({ message }) => showError(message));
      api.onRestarting(({ cwd: restartingCwd }) => {
        terminalReady = false;
        $("bc-ide-terminal-cwd").textContent = shortPath(restartingCwd);
      });
      const resize = () => {
        if (!fitAddon) return;
        const proposed = fitAddon.proposeDimensions();
        if (!proposed || !proposed.cols || !proposed.rows) return;
        fitAddon.fit();
        terminalSize = { cols: term.cols, rows: term.rows };
        api.resize(terminalSize.cols, terminalSize.rows);
      };
      new ResizeObserver(resize).observe(terminalHost);
      window.addEventListener("resize", resize);
      requestAnimationFrame(resize);
    }
    await api.startSession(cwd, terminalSize.cols, terminalSize.rows);
  }

  // Navigation between Home, the standalone CLI pane, and this IDE lives in
  // the shared title bar (ui/title-bar.js) now — it sits above every pane and
  // is never occluded by one, unlike a copy of those controls drawn inside
  // this page would be. This page only wires its own workspace controls.
  // Resizable columns: the workspace sidebar, the file tree, and the Claude
  // assistant panel. Each handle owns one --bc-ide-*-w variable that its
  // panel's flex-basis consumes, persists the chosen width, and resets on
  // double-click. Dragging captures the pointer on the handle itself — a
  // document-level mousemove pair silently stops whenever a fast drag leaves
  // the window or a text/editor surface swallows the event stream, which is
  // exactly what made these handles look decorative before.
  // Editor's working floor, mirrored in .bc-ide-editor-column min-width
  // (ide-workspace.css). Below this the code area wraps per-character.
  const EDITOR_MIN_W = 340;
  // Chat panel's default width, mirrored in .bc-ide-chat-panel's flex-basis
  // fallback (ide-workspace.css). Used when nothing has been dragged/persisted.
  const CHAT_DEFAULT_W = 420;

  // Live ceiling for the chat panel: how wide it can be dragged before the
  // editor column would be squeezed under EDITOR_MIN_W. Reserves the file
  // panel's current width and the two resize handles, and keeps a sane absolute
  // range so a very large or very small window still behaves.
  function chatPanelMaxWidth() {
    const content = document.querySelector(".bc-ide-content");
    // Before first layout clientWidth is 0; don't let that clamp the panel to
    // its floor. The real ceiling applies once the workspace has been measured.
    if (!content || !content.clientWidth) return 820;
    const filePanel = document.querySelector(".bc-ide-file-panel");
    // Reserve the file panel's INTENDED width (its persisted/default basis), not
    // its measured width: when the chat is already over-wide the file panel has
    // been squeezed to its min, and measuring that would compute a falsely large
    // ceiling that fails to protect the editor.
    let fileReserve = 0;
    if (filePanel && !filePanel.hidden) {
      const storedFile = parseInt(localStorage.getItem("bc-ide-file-w"), 10);
      fileReserve = Number.isFinite(storedFile) ? storedFile : 226;
    }
    const room = content.clientWidth - fileReserve - EDITOR_MIN_W - 16;
    return Math.max(320, Math.min(820, room));
  }

  function wirePanelResize({ handleId, storageKey, cssVar, targetSelector, minWidth, maxWidth, invert = false }) {
    const handle = $(handleId);
    const target = document.querySelector(targetSelector);
    if (!handle || !target) return;
    // maxWidth may be a function so a panel's ceiling can track the live window
    // size — the chat panel uses this so it can never be dragged wide enough to
    // starve the editor below its floor, at any window size.
    const resolveMax = () => (typeof maxWidth === "function" ? maxWidth() : maxWidth);
    const clamp = (width) => Math.round(Math.min(resolveMax(), Math.max(minWidth, width)));
    const apply = (width) => document.documentElement.style.setProperty(cssVar, `${clamp(width)}px`);
    const restore = () => {
      const stored = parseInt(localStorage.getItem(storageKey), 10);
      if (Number.isFinite(stored)) apply(stored);
    };
    restore();

    let startX = 0;
    let startWidth = 0;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      startX = event.clientX;
      startWidth = target.getBoundingClientRect().width;
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("dragging");
      document.documentElement.classList.add("bc-ide-panel-resizing");
    });
    handle.addEventListener("pointermove", (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const delta = event.clientX - startX;
      apply(invert ? startWidth - delta : startWidth + delta);
    });
    const endDrag = (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      handle.releasePointerCapture(event.pointerId);
      handle.classList.remove("dragging");
      document.documentElement.classList.remove("bc-ide-panel-resizing");
      localStorage.setItem(storageKey, clamp(target.getBoundingClientRect().width));
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    // Double-click: back to the stylesheet's default width.
    handle.addEventListener("dblclick", () => {
      localStorage.removeItem(storageKey);
      document.documentElement.style.removeProperty(cssVar);
    });
    handle.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
      if (!step) return;
      event.preventDefault();
      apply(target.getBoundingClientRect().width + (invert ? -step : step));
      localStorage.setItem(storageKey, clamp(target.getBoundingClientRect().width));
    });
  }

  function wirePanelResizers() {
    wirePanelResize({
      handleId: "bc-ide-sidebar-resize",
      storageKey: "bc-ide-sidebar-w",
      cssVar: "--bc-ide-sidebar-w",
      targetSelector: ".bc-ide-sidebar",
      minWidth: 200,
      maxWidth: 480,
    });
    wirePanelResize({
      handleId: "bc-ide-file-resize",
      storageKey: "bc-ide-file-w",
      cssVar: "--bc-ide-file-w",
      targetSelector: ".bc-ide-file-panel",
      minWidth: 160,
      maxWidth: 520,
    });
    // The assistant docks on the right, so its edge drags inverted: pulling
    // right makes the panel narrower. Its ceiling is computed live rather than
    // fixed: the panel may grow only until the editor column would hit its
    // floor (EDITOR_MIN_W, mirrored in ide-workspace.css), so a wide chat can
    // never crush the editor into an unreadable character-wrapped strip — the
    // exact failure a persisted over-wide drag used to leave behind.
    wirePanelResize({
      handleId: "bc-ide-chat-resize",
      storageKey: "bc-ide-chat-w",
      cssVar: "--bc-ide-chat-w",
      targetSelector: "#bc-ide-chat-panel",
      minWidth: 280,
      maxWidth: chatPanelMaxWidth,
      invert: true,
    });

    // Keep the chat panel within the live editor-preserving ceiling without
    // ever corrupting the user's chosen width. The persisted (or default) value
    // is the source of truth; this only re-derives the *applied* width from it,
    // clamped to whatever the current window allows — so a previously over-wide
    // drag can't load the editor crushed, and the panel grows back to the
    // intended width once the window is wide enough again. Deliberately does not
    // write to localStorage: a transient narrow measurement during load or a
    // temporary small window must not overwrite what the user actually dragged.
    const applyChatWidthWithinCap = () => {
      const panel = document.querySelector("#bc-ide-chat-panel");
      if (!panel || panel.hidden) return;
      const stored = parseInt(localStorage.getItem("bc-ide-chat-w"), 10);
      const intended = Number.isFinite(stored) ? stored : CHAT_DEFAULT_W;
      const capped = Math.max(280, Math.min(chatPanelMaxWidth(), intended));
      document.documentElement.style.setProperty("--bc-ide-chat-w", `${Math.round(capped)}px`);
    };
    // Driven by a ResizeObserver on the content row rather than a single rAF:
    // the IDE lives in a WebContentsView whose real bounds can land a few frames
    // after load, and the observer fires exactly when the row finally has its
    // true width (and on every later window resize) — so the panel settles at
    // the intended width instead of sticking at a transient early measurement.
    const contentRow = document.querySelector(".bc-ide-content");
    if (contentRow && typeof ResizeObserver === "function") {
      new ResizeObserver(applyChatWidthWithinCap).observe(contentRow);
    } else {
      requestAnimationFrame(applyChatWidthWithinCap);
      window.addEventListener("resize", applyChatWidthWithinCap);
    }
  }

  try {
    $("bc-ide-local").addEventListener("click", () => setSource("local"));
    $("bc-ide-cloud").addEventListener("click", () => setSource("cloud"));
    $("bc-ide-sidebar-refresh").addEventListener("click", async () => {
      if (activeProject) await selectProject(activeProject.cwd);
      if (source === "cloud") await loadCloudSources();
    });
    $("bc-ide-add-project").addEventListener("click", () => api.pickFolder());
    $("bc-ide-open-diff").addEventListener("click", showGitDiff);
    $("bc-ide-close-diff").addEventListener("click", () => {
      diffPanel.hidden = true;
      editorHost.hidden = false;
      setStatus(activeProject ? `${activeProject.name} · editor` : "Editor");
    });
    $("bc-ide-new").addEventListener("click", startNewSession);
    $("bc-ide-new-session").addEventListener("click", startNewSession);
    $("bc-ide-open-terminal").addEventListener("click", () => {
      terminalSection.classList.remove("hidden");
      setStatus("Terminal shown");
    });
    $("bc-ide-toggle-terminal").addEventListener("click", () => {
      terminalSection.classList.toggle("hidden");
      $("bc-ide-toggle-terminal").classList.toggle("collapsed", terminalSection.classList.contains("hidden"));
    });
    $("bc-ide-clear-terminal").addEventListener("click", () => { if (term) term.clear(); });
    $("bc-ide-collapse-files").addEventListener("click", () => {
      const panel = document.querySelector(".bc-ide-file-panel");
      panel.hidden = !panel.hidden;
      $("bc-ide-collapse-files").classList.toggle("collapsed", panel.hidden);
    });
    $("bc-ide-cloud-refresh").addEventListener("click", loadCloudSources);
    // Home / Code / CLI navigation is the shared title-bar rail (ui/title-bar.js),
    // visible above this pane in every mode. The Cloud view keeps its own
    // "Open Home" button as an in-context shortcut.
    $("bc-ide-cloud-home").addEventListener("click", () => api.openHome());
    document.querySelectorAll(".bc-ide-activity-btn[data-activity]").forEach((button) => {
      button.addEventListener("click", () => setActivity(button.dataset.activity));
    });
    $("bc-ide-source-refresh").addEventListener("click", refreshSourceControl);
    $("bc-ide-source-diff").addEventListener("click", showGitDiff);
    // Extensions: Installed/Browse tabs + live registry search.
    $("bc-ide-ext-tab-installed").addEventListener("click", () => setExtensionTab("installed"));
    $("bc-ide-ext-tab-browse").addEventListener("click", () => setExtensionTab("browse"));
    let extensionSearchTimer = null;
    $("bc-ide-extension-search").addEventListener("input", (event) => {
      clearTimeout(extensionSearchTimer);
      const value = event.target.value;
      extensionSearchTimer = setTimeout(() => runBrowse(value), 300);
    });
    // Model picker.
    $("bc-ide-model-btn").addEventListener("click", () => {
      const menu = $("bc-ide-model-menu");
      if (menu.hidden) openModelMenu();
      else closeModelMenu();
    });
    document.addEventListener("click", (event) => {
      if (event.target.closest && event.target.closest(".bc-ide-model-picker")) return;
      closeModelMenu();
    });
    $("bc-ide-chat-form").addEventListener("submit", sendChatMessage);
    $("bc-ide-chat-attach").addEventListener("click", attachProjectFiles);
    $("bc-ide-chat-stop").addEventListener("click", () => {
      const s = activeSession();
      api.stopChat(s ? s.tabId : undefined);
    });
    $("bc-ide-close-chat").addEventListener("click", () => {
      if (view === "chat") setActivity(lastWorkspaceActivity || "explorer");
      else $("bc-ide-chat-panel").hidden = true;
    });
    $("bc-ide-view-editor").addEventListener("click", () => setActivity(lastWorkspaceActivity || "explorer"));

    // Enter sends; Shift+Enter is a newline. Also drives the slash menu.
    const chatInput = $("bc-ide-chat-input");
    chatInput.addEventListener("input", () => { autosizeComposer(); refreshSlashMenu(); });
    chatInput.addEventListener("keydown", (event) => {
      const menu = $("bc-ide-slash-menu");
      if (!menu.hidden) {
        const count = Number(menu.dataset.count || 0);
        if (event.key === "ArrowDown") { event.preventDefault(); slashIndex = (slashIndex + 1) % count; refreshSlashMenu(); return; }
        if (event.key === "ArrowUp") { event.preventDefault(); slashIndex = (slashIndex - 1 + count) % count; refreshSlashMenu(); return; }
        if (event.key === "Escape") { menu.hidden = true; return; }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const rows = menu.querySelectorAll(".bc-ide-slash-row");
          if (rows[slashIndex]) rows[slashIndex].dispatchEvent(new MouseEvent("mousedown"));
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendChatMessage();
      }
    });
    chatInput.addEventListener("blur", () => { setTimeout(() => { $("bc-ide-slash-menu").hidden = true; }, 120); });
    $("bc-ide-slash").addEventListener("click", () => {
      if (!chatInput.value.startsWith("/")) chatInput.value = "/";
      chatInput.focus();
      slashIndex = 0;
      refreshSlashMenu();
    });
    document.querySelectorAll("#bc-ide-perm-mode button[data-perm]").forEach((btn) => {
      btn.addEventListener("click", () => setPermMode(btn.dataset.perm));
    });

    // Push-to-talk: hold the mic button.
    const mic = $("bc-ide-mic");
    mic.addEventListener("pointerdown", (event) => { event.preventDefault(); startMic(); });
    mic.addEventListener("pointerup", () => stopMic());
    mic.addEventListener("pointerleave", () => { if (micRecording) stopMic(); });
    Promise.resolve(api.sttAvailable()).then((info) => {
      if (info && info.available) mic.hidden = false;
      else mic.title = (info && info.reason) || "Voice input unavailable";
    }).catch(() => {});

    wirePanelResizers();
    api.onChatEvent(handleChatEvent);
    syncPermModeButtons();
    window.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveCurrentFile();
      }
    });
  } catch (error) {
    console.error("[BetterClaude] Code workspace controls failed to wire up", error);
    showError(error.message || "Some workspace controls failed to load. Reopen the Code tab from claude.ai's sidebar.");
  }

  api.onWorkspaceSettings((settings) => {
    latestSettings = settings;
    if (settings && settings.codeWindow && settings.codeWindow.fontSizePx && term) term.options.fontSize = settings.codeWindow.fontSizePx;
    // Themes and fonts restyle through the --bc-* variables this document
    // shares with the rest of the app; xterm needs its palette re-read from
    // computed styles after the new stylesheet lands.
    if (term) term.options.theme = terminalThemeFromCSSVars();
  });

  api.onProjectPicked(async ({ cwd } = {}) => {
    if (!cwd) return;
    try {
      projects = await api.listProjects();
      renderProjects();
      if (projects.some((project) => project.cwd === cwd)) await selectProject(cwd);
    } catch (error) {
      showError(error.message || "Could not open the selected project.");
    }
  });

  try {
    const initial = await api.getInitialState();
    projects = initial.projects || [];
    agents = initial.agents || [];
    $("bc-ide-stat-agents").textContent = String(agents.length);
    $("bc-ide-stat-cli").textContent = initial.cliVersion || "Unavailable";
    renderProjects();
    renderCloudRows();
    shell.dataset.view = view;
    renderSessionTabs();
    // Warm the model picker so the button shows a real name rather than an
    // id if the user already picked a free provider.
    activeModelLabel = modelLabelFor(selectedModel);
    updateModelButtonLabel();
    ensureFreeModels();
    const chosen = projects.find((project) => project.cwd === initial.lastProject) || projects[0];
    if (chosen) await selectProject(chosen.cwd);
    else {
      shell.dataset.state = "empty";
      $("bc-ide-project-title").textContent = "Choose a project folder";
      $("bc-ide-project-crumb").textContent = "No project";
      setStatus("Choose a folder to start Claude Code");
    }
  } catch (error) {
    showError(error.message || "Could not start the Code workspace.");
  }
})();
