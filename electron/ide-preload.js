const { contextBridge, ipcRenderer } = require("electron");
const os = require("os");
const { ThemeEngine } = require("../core/theme-engine");
const icons = require("../core/icons");

const forward = (channel) => (callback) => {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
};

contextBridge.exposeInMainWorld("betterClaudeIDE", {
  homeDirectory: os.homedir(),
  // core/icons.js's shared line-icon set, exposed so this page's static markup
  // and the workspace controller can both point at one canonical source
  // instead of pasting SVG strings into the HTML.
  icons,
  getSettings: () => ipcRenderer.invoke("settings:get"),
  getInitialState: () => ipcRenderer.invoke("ide:get-initial-state"),
  listProjects: () => ipcRenderer.invoke("ide:list-projects"),
  listFiles: (cwd) => ipcRenderer.invoke("ide:list-files", cwd),
  pickFiles: (cwd) => ipcRenderer.invoke("ide:pick-files", cwd),
  attachBytes: (payload) => ipcRenderer.invoke("ide:attach-bytes", payload),
  gitInfo: (cwd) => ipcRenderer.invoke("ide:git-info", cwd),
  gitDiff: (cwd) => ipcRenderer.invoke("ide:git-diff", cwd),
  // Commit (renderer-confirmed) + push + `gh pr create` for the current branch.
  createPr: (payload) => ipcRenderer.invoke("ide:create-pr", payload),
  listSessions: (cwd) => ipcRenderer.invoke("ide:list-sessions", cwd),
  readSession: (cwd, sessionId) => ipcRenderer.invoke("ide:read-session", cwd, sessionId),
  sttAvailable: () => ipcRenderer.invoke("ide:stt-available"),
  transcribe: (arrayBuffer) => ipcRenderer.invoke("ide:transcribe", arrayBuffer),
  readFile: (cwd, relativePath) => ipcRenderer.invoke("ide:read-file", cwd, relativePath),
  writeFile: (cwd, relativePath, content, expectedMtimeMs) => ipcRenderer.invoke("ide:write-file", cwd, relativePath, content, expectedMtimeMs),
  setLastProject: (cwd) => ipcRenderer.invoke("ide:set-last-project", cwd),
  pickFolder: () => ipcRenderer.invoke("ide:pick-folder"),
  attachAgent: (sessionId, cwd, cols, rows) => ipcRenderer.invoke("ide:attach-agent-session", sessionId, cwd, cols, rows),
  listAgents: () => ipcRenderer.invoke("ide:list-agents"),
  listExtensions: () => ipcRenderer.invoke("ide:list-extensions"),
  searchExtensions: (query) => ipcRenderer.invoke("ide:search-extensions", query),
  installExtension: (id) => ipcRenderer.invoke("ide:install-extension", id),
  extensionInstallDir: () => ipcRenderer.invoke("ide:extension-install-dir"),
  uninstallExtension: (id) => ipcRenderer.invoke("ide:uninstall-extension", id),
  listFreeModels: (force) => ipcRenderer.invoke("ide:list-free-models", { force: !!force }),
  claudeModels: (cwd) => ipcRenderer.invoke("ide:claude-models", cwd),
  // The OpenRouter key is write-only from here: status says whether one is
  // saved, never what it is.
  openRouterKeyStatus: () => ipcRenderer.invoke("ide:openrouter-key-status"),
  setOpenRouterKey: (key) => ipcRenderer.invoke("ide:set-openrouter-key", String(key || "")),
  // One cheap Haiku call to name a session after its first exchange, like the
  // desktop app. Returns "" on any failure; the result is persisted in settings.
  generateSessionTitle: (payload) => ipcRenderer.invoke("ide:generate-session-title", payload),
  // Claude Code's own usage stats (electron/claude-stats.js), the numbers its
  // /stats shows: { ok, stats: { today, ranges: { all, d30, d7 } } }.
  claudeStats: (opts) => ipcRenderer.invoke("ide:claude-stats", { force: !!(opts && opts.force) }),
  // `claude auth login --claudeai` in the Terminal panel.
  claudeLogin: (cwd, cols, rows) => ipcRenderer.invoke("ide:claude-login", cwd, cols, rows),
  // The Code tab's own writes go through the same settings:set path as the
  // main window's panel, so a change made here broadcasts everywhere.
  setSetting: (keyPath, value) => ipcRenderer.invoke("settings:set", keyPath, value),
  openCli: () => ipcRenderer.invoke("ide:open-cli"),
  // The gear opens CLAUDE's own settings surface; BetterClaude's settings
  // live on the title bar's logo button in the main window.
  openSettings: () => ipcRenderer.invoke("ide:open-claude-settings"),
  chat: (payload) => ipcRenderer.invoke("ide:chat", payload),
  stopChat: (tabId) => ipcRenderer.invoke("ide:chat-stop", tabId),
  setChatMode: (payload) => ipcRenderer.invoke("ide:chat-set-mode", payload),
  // Answer an approval / question / plan card: { tabId, requestId,
  // decision: "allow" | "always" | "deny", answers?, message? }.
  respondPermission: (payload) => ipcRenderer.invoke("ide:chat-permission", payload),
  // Release a closed session tab's Claude Code process.
  disposeChat: (tabId) => ipcRenderer.invoke("ide:chat-dispose", tabId),
  // Put a session on its project's agent team (the CLI tab's Team Hub), or
  // take it off: { tabId, cwd, sessionId? } -> { memberId, name } | null.
  teamJoin: (payload) => ipcRenderer.invoke("ide:team:join", payload),
  teamLeave: (payload) => ipcRenderer.invoke("ide:team:leave", payload),
  // The mode chip moved on a chat that is on a team: { tabId, permissionMode }.
  teamSetMode: (payload) => ipcRenderer.invoke("ide:team:set-mode", payload),
  // Terminal panel: a login shell in the project folder.
  startShell: (cwd, cols, rows) => ipcRenderer.invoke("ide:start-shell", cwd, cols, rows),
  write: (data) => ipcRenderer.send("ide:input", String(data)),
  resize: (cols, rows) => ipcRenderer.send("ide:resize", { cols, rows }),
  onData: forward("ide:data"),
  onStarted: forward("ide:started"),
  onExit: forward("ide:exit"),
  onFatal: forward("ide:fatal"),
  onChatEvent: forward("ide:chat-event"),
  // Full-IDE layout (electron/workbench.js via main.js). The page learns the
  // engine's name, size and source to show before the user agrees to the
  // download; it never supplies a URL or sees the server's token.
  workbench: {
    status: () => ipcRenderer.invoke("workbench:status"),
    latest: () => ipcRenderer.invoke("workbench:latest"),
    install: () => ipcRenderer.invoke("workbench:install"),
    setLayout: (opts) => ipcRenderer.invoke("workbench:set-layout", opts),
    setChatWidth: (width) => ipcRenderer.send("workbench:chat-width", width),
    openFile: (file, line) => ipcRenderer.send("workbench:open-file", file, line),
    diff: (file) => ipcRenderer.send("workbench:diff", file),
    pushStatus: (info) => ipcRenderer.send("workbench:status", info),
    onProgress: forward("workbench:progress"),
    onEvent: forward("workbench:event"),
    // From the workbench's bridge extension: a selection for the composer,
    // or a Commit & PR request.
    onBridge: forward("workbench:bridge"),
  },
  onProjectPicked: forward("ide:project-picked"),
  // The dock's Model switcher widget (main "widgets:set-code-model").
  onSetModel: forward("ide:set-model"),
  // A teammate was renamed from the CLI tab's Team card: { memberId, name }.
  onTeamRenamed: forward("ide:team-renamed"),
  onWorkspaceSettings: (callback) => {
    ipcRenderer.on("betterclaude:settings-changed", (_event, payload) => callback(payload));
  },
});

async function bootstrap() {
  await new Promise((resolve) => {
    if (document.readyState !== "loading") resolve();
    else document.addEventListener("DOMContentLoaded", resolve, { once: true });
  });

  // The workspace stylesheet is a plain <link> in ide-window.html now, so the
  // page is styled from its very first paint. It used to be injected here,
  // after these two IPC round-trips — which is exactly the second of raw,
  // unstyled HTML the Code tab used to flash on first open.
  document.documentElement.dataset.platform = process.platform;
  let themeEngine = null;
  try {
    const settings = await ipcRenderer.invoke("settings:get");
    const themes = await ipcRenderer.invoke("themes:get-all");
    themeEngine = new ThemeEngine({ presets: themes });
    themeEngine.applySettings(settings);
  } finally {
    // Styled (the <link> blocked the page's scripts, so it has loaded by
    // DOMContentLoaded) and themed: main may composite the view now
    // (reconcileIdeView). Sent directly, NOT from requestAnimationFrame: this
    // view is still detached — hidden — at this point, and Chromium runs no
    // rAF callbacks for a hidden page, so a rAF-gated signal never arrived and
    // the Code tab never appeared. Sent even if theming failed: an unthemed
    // Code tab beats one that never opens.
    ipcRenderer.send("ide:ready");
  }

  ipcRenderer.on("betterclaude:settings-changed", (_event, updated) => {
    if (!themeEngine) return;
    themeEngine.applySettings(updated);
  });
}

bootstrap().catch((error) => console.error("[BetterClaude] IDE preload failed", error));
