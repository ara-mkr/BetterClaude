const { contextBridge, ipcRenderer } = require("electron");
const os = require("os");
const { ThemeEngine } = require("../core/theme-engine");
const { injectStaticCSS } = require("./static-css");
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
  searchFiles: (cwd, query) => ipcRenderer.invoke("ide:search-files", cwd, query),
  pickFiles: (cwd) => ipcRenderer.invoke("ide:pick-files", cwd),
  gitInfo: (cwd) => ipcRenderer.invoke("ide:git-info", cwd),
  gitDiff: (cwd) => ipcRenderer.invoke("ide:git-diff", cwd),
  listSessions: (cwd) => ipcRenderer.invoke("ide:list-sessions", cwd),
  readFile: (cwd, relativePath) => ipcRenderer.invoke("ide:read-file", cwd, relativePath),
  writeFile: (cwd, relativePath, content, expectedMtimeMs) => ipcRenderer.invoke("ide:write-file", cwd, relativePath, content, expectedMtimeMs),
  setLastProject: (cwd) => ipcRenderer.invoke("ide:set-last-project", cwd),
  pickFolder: () => ipcRenderer.invoke("ide:pick-folder"),
  startSession: (cwd, cols, rows) => ipcRenderer.invoke("ide:start-session", cwd, cols, rows),
  resumeSession: (cwd, sessionId, cols, rows) => ipcRenderer.invoke("ide:resume-session", cwd, sessionId, cols, rows),
  attachAgent: (sessionId, cwd, cols, rows) => ipcRenderer.invoke("ide:attach-agent-session", sessionId, cwd, cols, rows),
  listAgents: () => ipcRenderer.invoke("ide:list-agents"),
  listConversations: () => ipcRenderer.invoke("ide:list-conversations"),
  listExtensions: () => ipcRenderer.invoke("ide:list-extensions"),
  searchExtensions: (query) => ipcRenderer.invoke("ide:search-extensions", query),
  installExtension: (id) => ipcRenderer.invoke("ide:install-extension", id),
  uninstallExtension: (id) => ipcRenderer.invoke("ide:uninstall-extension", id),
  listFreeModels: () => ipcRenderer.invoke("ide:list-free-models"),
  // The Code tab's own writes go through the same settings:set path as the
  // main window's panel, so a change made here broadcasts everywhere.
  setSetting: (keyPath, value) => ipcRenderer.invoke("settings:set", keyPath, value),
  openHome: (url) => ipcRenderer.invoke("ide:open-home", url),
  openCli: () => ipcRenderer.invoke("ide:open-cli"),
  // The gear opens CLAUDE's own settings surface; BetterClaude's settings
  // live on the title bar's logo button in the main window.
  openSettings: () => ipcRenderer.invoke("ide:open-claude-settings"),
  chat: (payload) => ipcRenderer.invoke("ide:chat", payload),
  stopChat: () => ipcRenderer.invoke("ide:chat-stop"),
  minimize: () => ipcRenderer.invoke("ide:window-minimize"),
  maximizeToggle: () => ipcRenderer.invoke("ide:window-maximize-toggle"),
  close: () => ipcRenderer.invoke("ide:window-close"),
  write: (data) => ipcRenderer.send("ide:input", String(data)),
  resize: (cols, rows) => ipcRenderer.send("ide:resize", { cols, rows }),
  onData: forward("ide:data"),
  onStarted: forward("ide:started"),
  onExit: forward("ide:exit"),
  onFatal: forward("ide:fatal"),
  onRestarting: forward("ide:restarting"),
  onChatEvent: forward("ide:chat-event"),
  onProjectPicked: forward("ide:project-picked"),
  onSettingsOpen: forward("ide:settings-open"),
  onWorkspaceSettings: (callback) => {
    ipcRenderer.on("betterclaude:settings-changed", (_event, payload) => callback(payload));
  },
});

async function bootstrap() {
  await new Promise((resolve) => {
    if (document.readyState !== "loading") resolve();
    else document.addEventListener("DOMContentLoaded", resolve, { once: true });
  });

  const settings = await ipcRenderer.invoke("settings:get");
  const themes = await ipcRenderer.invoke("themes:get-all");
  const themeEngine = new ThemeEngine({ presets: themes });
  themeEngine.applySettings(settings);
  injectStaticCSS("betterclaude-ide-css", require("path").join(__dirname, "../ui/code-window/ide-workspace.css"));
  document.documentElement.dataset.platform = process.platform;

  ipcRenderer.on("betterclaude:settings-changed", (_event, updated) => {
    themeEngine.applySettings(updated);
    ipcRenderer.send("ide:settings-applied");
  });
}

bootstrap().catch((error) => console.error("[BetterClaude] IDE preload failed", error));
