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
  let chatSessionId = null;
  let chatBusy = false;
  let activeAssistantMessage = null;

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
    const busy = chatBusy || terminalActive;
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
    sessions.slice(0, 30).forEach((session, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bc-ide-session-row";
      button.innerHTML = `<span class="bc-ide-status-dot ${index === 0 ? "live" : ""}"></span><span class="bc-ide-row-copy"><span class="bc-ide-row-name"></span><span class="bc-ide-row-meta"></span></span>`;
      button.querySelector(".bc-ide-row-name").textContent = session.sessionId.slice(0, 12);
      const stamp = session.lastTimestamp ? new Date(session.lastTimestamp).toLocaleString() : "saved";
      button.querySelector(".bc-ide-row-meta").textContent = `${stamp} · ${session.messageCount || 0} messages`;
      button.addEventListener("click", () => resumeLocalSession(session.sessionId, button));
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

  function scrollChatToEnd() {
    const messages = $("bc-ide-chat-messages");
    messages.scrollTop = messages.scrollHeight;
  }

  function appendChatMessage(role, text = "") {
    const messages = $("bc-ide-chat-messages");
    const welcome = messages.querySelector(".bc-ide-chat-welcome");
    if (welcome) welcome.remove();
    const item = document.createElement("article");
    item.className = "bc-ide-chat-message";
    item.dataset.role = role;
    const label = document.createElement("div");
    label.className = "bc-ide-chat-label";
    // The answer's author is whoever actually produced it — Claude, or the
    // free provider that took over after a usage limit.
    label.textContent = role === "user" ? "You" : activeModelLabel || "Claude";
    const bubble = document.createElement("div");
    bubble.className = "bc-ide-chat-bubble";
    bubble.textContent = text;
    item.append(label, bubble);
    messages.appendChild(item);
    scrollChatToEnd();
    return bubble;
  }

  /** One-line status note inside the transcript ("continuing with X…"). */
  function appendChatSystemNote(text) {
    const messages = $("bc-ide-chat-messages");
    const welcome = messages.querySelector(".bc-ide-chat-welcome");
    if (welcome) welcome.remove();
    const note = document.createElement("div");
    note.className = "bc-ide-chat-system";
    note.textContent = text;
    messages.appendChild(note);
    scrollChatToEnd();
  }

  function setChatBusy(next) {
    chatBusy = next;
    $("bc-ide-chat-stop").hidden = !next;
    $("bc-ide-chat-input").disabled = next;
    $("bc-ide-chat-attach").disabled = next;
    $("bc-ide-chat-form").dataset.busy = next ? "true" : "false";
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
      $("bc-ide-stat-files").textContent = String(tree.count || 0);
      renderSourceControl(info);
      $("bc-ide-branch").innerHTML = info && info.branch
        ? `${icon("GIT_BRANCH")}<span>${info.branch}</span>`
        : `<span>${info && info.isRepo ? "Git repository" : "No git repository"}</span>`;
      if (activeFile && !editorDirty) await openFile(activeFile);
    } catch (error) {
      setStatus(error.message || "Project changed, but the editor could not refresh.");
    }
  }

  function handleChatEvent(event = {}) {
    if (event.type === "start") {
      activeModelLabel = event.modelLabel || (selectedModel === "claude" ? "Claude" : modelLabelFor(selectedModel));
      setChatBusy(true);
      return;
    }
    if (event.type === "model-switch") {
      // A free provider took over (chosen manually or after a usage limit).
      // Say so in the transcript so the answer's provenance is never a mystery.
      activeModelLabel = event.modelLabel || event.modelId;
      if (!activeAssistantMessage || !activeAssistantMessage.textContent) {
        appendChatSystemNote(`Answering with ${activeModelLabel}${event.keyless ? " (no login)" : ""}${event.total > 1 ? ` · free provider ${event.attempt}/${event.total}` : ""}…`);
      }
      setStatus(`${activeModelLabel} is thinking...`);
      return;
    }
    if (event.type === "session" && event.sessionId) {
      chatSessionId = event.sessionId;
      return;
    }
    if (event.type === "delta" && event.text) {
      if (!activeAssistantMessage) activeAssistantMessage = appendChatMessage("assistant");
      activeAssistantMessage.textContent += event.text;
      scrollChatToEnd();
      return;
    }
    if (event.type === "diagnostic") {
      // Diagnostics are deliberately kept out of the conversation transcript;
      // they belong in the status line while Claude is working.
      setStatus(event.message.slice(0, 180));
      return;
    }
    if (event.type === "error") {
      if (!activeAssistantMessage) activeAssistantMessage = appendChatMessage("assistant");
      activeAssistantMessage.textContent = event.message || "Claude could not complete that request.";
      // If that failure looks like a usage limit and auto-failover is off,
      // tell the user the one toggle that fixes it instead of leaving them
      // stuck at the limit.
      const failoverOff = !(latestSettings && latestSettings.codeWindow && latestSettings.codeWindow.freeModels && latestSettings.codeWindow.freeModels.autoFailover !== false);
      if (/usage limit|rate.?limit|credit|quota/i.test(event.message || "") && failoverOff) {
        appendChatSystemNote("Free-model auto-failover is off — open the model picker to switch providers or turn it on.");
      }
      setChatBusy(false);
      activeAssistantMessage = null;
      setStatus("Claude request failed");
      return;
    }
    if (event.type === "stopped") {
      setChatBusy(false);
      activeAssistantMessage = null;
      setStatus("Claude request stopped");
      return;
    }
    if (event.type === "done") {
      if (!chatBusy) return;
      setChatBusy(false);
      activeAssistantMessage = null;
      setStatus(event.modelLabel && event.modelLabel !== "Claude" ? `${event.modelLabel} response ready` : "Claude response ready");
      refreshProjectAfterChat();
    }
  }

  async function sendChatMessage(event) {
    event.preventDefault();
    if (chatBusy || !activeProject) return;
    const input = $("bc-ide-chat-input");
    const prompt = input.value.trim();
    if (!prompt) return;
    const attachments = selectedAttachments.slice();
    appendChatMessage("user", prompt + (attachments.length ? `\n\nAttached: ${attachments.map((file) => file.path).join(", ")}` : ""));
    activeAssistantMessage = null;
    input.value = "";
    selectedAttachments = [];
    renderAttachments();
    activeModelLabel = selectedModel === "claude" ? "Claude" : modelLabelFor(selectedModel);
    setStatus(`${activeModelLabel} is thinking...`);
    setChatBusy(true);
    try {
      const started = await api.chat({
        cwd: activeProject.cwd,
        prompt,
        attachments,
        sessionId: chatSessionId,
        // "claude" routes to the subscription CLI; a free-model id routes to
        // the OpenRouter/keyless chain in the main process.
        model: selectedModel,
      });
      if (!started) {
        if (activeAssistantMessage) {
          activeAssistantMessage.textContent = "Claude Code could not start. Check that the Claude CLI is installed and signed in.";
          activeAssistantMessage = null;
        }
        setChatBusy(false);
      }
    } catch (error) {
      if (activeAssistantMessage) activeAssistantMessage.textContent = error.message || "Claude Code could not start.";
      activeAssistantMessage = null;
      setChatBusy(false);
      setStatus("Claude request failed");
    }
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
    if (!activeProject || chatBusy) return;
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
    // The assistant button is a TOGGLE: clicking it while the chat panel is
    // already up collapses it and returns to the last real sidebar panel,
    // instead of re-focusing an open panel forever.
    if (next === "claude") {
      const chatPanel = $("bc-ide-chat-panel");
      if (activity === "claude" && !chatPanel.hidden) {
        chatPanel.hidden = true;
        next = lastWorkspaceActivity;
      } else {
        chatPanel.hidden = false;
      }
    } else {
      lastWorkspaceActivity = next;
    }
    activity = next;
    shell.dataset.activity = next;
    document.querySelectorAll(".bc-ide-activity-btn[data-activity]").forEach((button) => {
      const active = button.dataset.activity === next;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const labels = { explorer: "Explorer", source: "Source Control", extensions: "Extensions", claude: "Claude", settings: "Settings" };
    $("bc-ide-sidebar-heading").textContent = labels[next] || "Explorer";
    ["explorer", "source", "extensions"].forEach((panel) => {
      const element = $(`bc-ide-${panel}-panel`);
      if (element) element.hidden = panel !== next;
    });
    if (next === "claude") {
      $("bc-ide-chat-input").focus();
    }
    if (next === "source") refreshSourceControl();
    if (next === "extensions") {
      setExtensionTab(extensionTab);
      loadExtensions();
      if (extensionTab === "browse") runBrowse($("bc-ide-extension-search").value);
    }
    if (next === "settings") api.openSettings();
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
      chatSessionId = null;
      activeAssistantMessage = null;
      setChatBusy(false);
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
      $("bc-ide-stat-files").textContent = String(tree.count || 0);
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
      await startTerminal(project.cwd);
    } catch (error) {
      showError(error.message || "Could not load project.");
    }
  }

  function findFirstFile(nodes) {
    for (const node of nodes || []) {
      if (node.kind === "file") return node.path;
      const nested = findFirstFile(node.children);
      if (nested) return nested;
    }
    return null;
  }

  async function resumeLocalSession(sessionId, button) {
    if (!activeProject) return;
    document.querySelectorAll(".bc-ide-session-row").forEach((row) => row.classList.toggle("active", row === button));
    setStatus(`Resuming ${sessionId.slice(0, 12)}...`);
    const ok = await api.resumeSession(activeProject.cwd, sessionId, terminalSize.cols, terminalSize.rows);
    setStatus(ok ? "Local session attached" : "That local session is no longer available.");
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
  function wirePanelResize({ handleId, storageKey, cssVar, targetSelector, minWidth, maxWidth, invert = false }) {
    const handle = $(handleId);
    const target = document.querySelector(targetSelector);
    if (!handle || !target) return;
    const clamp = (width) => Math.round(Math.min(maxWidth, Math.max(minWidth, width)));
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
    // right makes the panel narrower. It always keeps this width while open
    // (the rest of the workspace yields), so the max is generous.
    wirePanelResize({
      handleId: "bc-ide-chat-resize",
      storageKey: "bc-ide-chat-w",
      cssVar: "--bc-ide-chat-w",
      targetSelector: "#bc-ide-chat-panel",
      minWidth: 280,
      maxWidth: 820,
      invert: true,
    });
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
    $("bc-ide-cloud-home").addEventListener("click", () => api.openHome());
    // The IDE pane covers claude.ai's own Home / Code / CLI row, so the view
    // chip in this sidebar is the way between all three surfaces while the
    // Code tab is up.
    $("bc-ide-view-home").addEventListener("click", () => api.openHome());
    $("bc-ide-view-cli").addEventListener("click", () => api.openCli());
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
    $("bc-ide-chat-stop").addEventListener("click", () => api.stopChat());
    $("bc-ide-close-chat").addEventListener("click", () => {
      $("bc-ide-chat-panel").hidden = true;
      // Keep the activity bar honest: the assistant is no longer the active
      // surface, so fall back to the last real sidebar panel (same state a
      // toggle-click on its button produces).
      if (activity === "claude") setActivity(lastWorkspaceActivity);
      else setStatus("Claude assistant hidden");
    });
    wirePanelResizers();
    api.onChatEvent(handleChatEvent);
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
