const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, shell, dialog, screen, globalShortcut, clipboard, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const Store = require("electron-store");
const AdmZip = require("adm-zip");
const chokidar = require("chokidar");

// Must be set before app is ready: this is what the app-menu role ("appMenu")
// and app.getName() (userData folder, About panel, etc.) use — it's the
// closest thing to renaming the app that's possible without packaging it
// into a real .app bundle (see buildAppMenu / createWindow below).
app.setName("BetterClaude");

const { mergeDefaults, DEFAULT_SETTINGS } = require("../core/settings-schema");
const { buildThemeCSSFromVars } = require("../core/theme-engine");
const { extractThemeVars } = require("../core/tokens");
const { attachWindowState, getInitialBounds } = require("./window-state");
const { TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y } = require("./window-chrome");
const { autoUpdater } = require("electron-updater");
const { pickLoadingTip } = require("../core/motion-fx");
const { deriveChannelId, encryptText, decryptText } = require("../core/clipboard-bridge");
const analyticsDb = require("./analytics-db");
const teamSync = require("./team-sync");

const THEMES_DIR = path.join(__dirname, "..", "themes");
const BUILTIN_PLUGINS_DIR = path.join(__dirname, "..", "plugins");
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const APP_ICON_PATH = path.join(ASSETS_DIR, "app-icon.png");
const TRAY_ICON_PATH = path.join(ASSETS_DIR, "tray-icon.png");

// Claude's Google sign-in flow opens an OAuth popup. It must stay inside the
// persisted Electron session so the callback can return to claude.ai with the
// same cookies; sending it to the system browser breaks the login handoff.
function isAllowedAuthPopup(url) {
  try {
    const host = new URL(url).hostname;
    return host === "accounts.google.com" || host.endsWith(".accounts.google.com")
      || host === "consent.google.com" || host.endsWith(".consent.google.com");
  } catch (_e) {
    return false;
  }
}

// NOTE: `migrations` has always been truthy (it was `{}`), so conf's _migrate
// already ran on every launch and stamped __internal__.migrations.version with
// package.json's version. Existing installs therefore sit at "0.1.0" — a
// migration keyed "0.1.0" would be skipped (_shouldPerformMigration requires
// candidate > previouslyMigrated), and one keyed above package.json's version
// would be skipped too (it must also be <= projectVersion). So deleting a key
// for existing users requires BOTH a new migration key and a package.json
// version bump to at least that key. Keep those two in lockstep.
const store = new Store({
  defaults: DEFAULT_SETTINGS,
  migrations: {
    // Settings -> Personality's avatar shape/color/accessory picker was
    // replaced by Settings -> Buddies. Drop the orphaned key rather than
    // leaving it to sit in every user's config.json forever.
    "0.2.0": (s) => {
      s.delete("personality.avatar");
    },
  },
});

// Platform-specific window chrome. `frame: false` and `titleBarStyle` are
// mutually exclusive in Electron — setting frame:false suppresses the
// native traffic lights entirely, even with titleBarStyle also set — so
// this can't be a small addition on top of a shared `frame: false`; the two
// platforms need genuinely different option sets:
//   - macOS: no `frame` override (stays true) + `titleBarStyle: "hiddenInset"`,
//     which hides the title bar/toolbar but keeps the real system traffic
//     lights, repositioned via `trafficLightPosition` to sit inside the
//     custom bar at the coordinates ui/title-bar.js reserves space for
//     (see electron/window-chrome.js — same constants, so they can't drift).
//   - Windows/Linux: `frame: false` as before; ui/title-bar.js keeps
//     rendering the hand-drawn dots there since there's no native chrome.
const titleBarOptions =
  process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: TRAFFIC_LIGHT_Y } }
    : { frame: false };

let mainWindow = null;
let tray = null;
let isQuitting = false;
let splashWindow = null;
let analyticsDbReady = null;

// --- Loading-screen tips (§15) ---
// claude.ai's own first paint takes a moment; today the window just shows
// blank until then. A small always-on-top splash window with a rotating
// tip (mixing real + joke tips, both editable — see core/motion-fx.js)
// fills that gap instead of a blank rectangle.
function buildSplashHtml(tip) {
  const safeTip = String(tip || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; height: 100%; background: #11121a; color: #f1f0f8;
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
    .bc-spinner { width: 34px; height: 34px; border-radius: 50%;
      border: 3px solid rgba(241,240,248,0.14); border-top-color: #6059e6;
      animation: bc-spin 0.8s linear infinite; }
    @keyframes bc-spin { to { transform: rotate(360deg); } }
    .bc-tip { max-width: 300px; text-align: center; font-size: 12px; opacity: 0.75; padding: 0 24px; line-height: 1.5; }
    @media (prefers-reduced-motion: reduce) { .bc-spinner { animation: none; border-top-color: rgba(255,255,255,0.4); } }
  </style></head><body>
    <div class="bc-spinner"></div>
    <div class="bc-tip">${safeTip}</div>
  </body></html>`;
}

function createSplashWindow() {
  const stored = mergeDefaults(store.store);
  const tip = pickLoadingTip(stored.personality && stored.personality.customLoadingTips);
  const win = new BrowserWindow({
    width: 360,
    height: 190,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    show: true,
    backgroundColor: "#11121a",
    skipTaskbar: true,
  });
  win.loadURL(`data:text/html,${encodeURIComponent(buildSplashHtml(tip))}`);
  return win;
}

function closeSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

// --- Auto-updater ---
// state: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error"
let updateStatus = { state: "idle" };

function broadcastUpdateStatus() {
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("betterclaude:update-status", updateStatus));
}

function setupAutoUpdater() {
  // Ask before spending the user's bandwidth — checkForUpdates() alone just
  // reports availability, downloadUpdate() is a separate, explicit step
  // triggered from the renderer once the user opts in.
  autoUpdater.autoDownload = false;
  autoUpdater.on("checking-for-update", () => {
    updateStatus = { state: "checking" };
    broadcastUpdateStatus();
  });
  autoUpdater.on("update-available", (info) => {
    updateStatus = { state: "available", version: info.version };
    broadcastUpdateStatus();
  });
  autoUpdater.on("update-not-available", () => {
    updateStatus = { state: "not-available" };
    broadcastUpdateStatus();
  });
  autoUpdater.on("error", (err) => {
    updateStatus = { state: "error", error: err.message };
    broadcastUpdateStatus();
  });
  autoUpdater.on("download-progress", (progress) => {
    updateStatus = { state: "downloading", percent: Math.round(progress.percent) };
    broadcastUpdateStatus();
  });
  autoUpdater.on("update-downloaded", () => {
    updateStatus = { state: "downloaded" };
    broadcastUpdateStatus();
  });
}

function getUserPluginsDir() {
  const dir = path.join(app.getPath("userData"), "plugins");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Built-in plugins withdrawn after they had already been seeded into
// userData. Deleting the shipped source alone doesn't retire them: the
// seeded copy stays on disk, readAllPluginSources() still finds it, and
// `plugins.enabled[id] !== false` treats an id absent from the defaults as
// enabled — so a withdrawn plugin would come back ON. Delete the seeded
// copy by exact filename instead.
const RETIRED_BUILTIN_PLUGINS = [
  "conversation-export.claudeplugin.js",
  "conversation-search.claudeplugin.js",
];

function seedBuiltinPlugins() {
  const userDir = getUserPluginsDir();
  for (const file of RETIRED_BUILTIN_PLUGINS) {
    const stale = path.join(userDir, file);
    if (fs.existsSync(stale)) fs.rmSync(stale);
  }
  const builtins = fs.readdirSync(BUILTIN_PLUGINS_DIR).filter((f) => f.endsWith(".claudeplugin.js"));
  for (const file of builtins) {
    const dest = path.join(userDir, file);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(BUILTIN_PLUGINS_DIR, file), dest);
    }
  }
}

function getUserSkillsDir() {
  const dir = path.join(app.getPath("userData"), "skills");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function slugifySkillId(owner, repo) {
  return `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-");
}

// --- GitHub API (Skill Marketplace) ---
// All calls go through the main process, same reason as themes:import-url /
// weather:get above: claude.ai's own page CSP governs what the renderer/
// preload's fetch() can reach, and the main process isn't subject to it.
function githubHeaders(extra = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "BetterClaude-App",
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
  const token = store.get("skillMarketplace.githubToken", "");
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubFetch(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: githubHeaders(extraHeaders) });
  if (!res.ok) {
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      const resetEpoch = Number(res.headers.get("x-ratelimit-reset") || 0);
      const resetLabel = resetEpoch ? new Date(resetEpoch * 1000).toLocaleTimeString() : "shortly";
      throw new Error(
        `GitHub API rate limit hit. Try again after ${resetLabel}, or add a personal access token in Settings -> Skill Marketplace for a higher limit.`
      );
    }
    throw new Error(`GitHub request failed (HTTP ${res.status})`);
  }
  return res;
}

async function searchSkillsRemote({ query = "", sort = "stars", minStars = 0 } = {}) {
  const qParts = ["topic:claude-skill", "archived:false"];
  if (query && query.trim()) qParts.push(query.trim());
  if (minStars > 0) qParts.push(`stars:>=${minStars}`);
  const q = encodeURIComponent(qParts.join(" "));
  const validSort = ["stars", "updated"].includes(sort) ? sort : "stars";
  const url = `https://api.github.com/search/repositories?q=${q}&sort=${validSort}&order=desc&per_page=50`;
  const res = await githubFetch(url);
  const data = await res.json();
  const items = (data.items || []).map((r) => ({
    id: slugifySkillId(r.owner.login, r.name),
    owner: r.owner.login,
    ownerAvatarUrl: r.owner.avatar_url,
    repo: r.name,
    fullName: r.full_name,
    description: r.description || "",
    stars: r.stargazers_count,
    pushedAt: r.pushed_at,
    htmlUrl: r.html_url,
    defaultBranch: r.default_branch,
    topics: r.topics || [],
    license: r.license ? r.license.spdx_id : null,
  }));
  return { items, totalCount: data.total_count || items.length };
}

function getUserThemesDir() {
  const dir = path.join(app.getPath("userData"), "themes");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readThemesFrom(dir) {
  if (!fs.existsSync(dir)) return {};
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".css"));
  const themes = {};
  for (const file of files) {
    const id = file.replace(/\.css$/, "");
    themes[id] = fs.readFileSync(path.join(dir, file), "utf8");
  }
  return themes;
}

// Bundled presets first, then user (imported/saved) themes layered on top —
// a user theme with the same id as a bundled one wins, since it's the more
// recently-chosen/authored one.
function readAllThemes() {
  return { ...readThemesFrom(THEMES_DIR), ...readThemesFrom(getUserThemesDir()) };
}

function listUserThemeIds() {
  return Object.keys(readThemesFrom(getUserThemesDir()));
}

function slugifyThemeName(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return slug || `theme-${Date.now()}`;
}

function extractThemeName(cssText, fallback) {
  const m = /\/\*\s*BetterClaude(?: preset)? theme:\s*(.+?)\s*\*\//.exec(cssText || "");
  return (m && m[1]) || fallback;
}

// Writes a theme (already-full CSS, or vars-only JSON compiled to CSS) into
// the user themes dir and returns { id, name, themes }. Shared by the
// import-from-url/import-from-file/save-as-new-theme IPC handlers below.
function writeUserTheme({ name, cssText }) {
  const id = slugifyThemeName(name);
  fs.writeFileSync(path.join(getUserThemesDir(), `${id}.css`), cssText, "utf8");
  return { id, name, themes: readAllThemes() };
}

function importThemeText(text, { isJSON, fallbackName }) {
  if (isJSON) {
    const parsed = JSON.parse(text);
    const name = parsed.name || fallbackName || "Imported Theme";
    const vars = parsed.vars || parsed.colors || {};
    return writeUserTheme({ name, cssText: buildThemeCSSFromVars(vars, name) });
  }
  const name = extractThemeName(text, fallbackName || "Imported Theme");
  return writeUserTheme({ name, cssText: text });
}

function readAllPluginSources() {
  const dir = getUserPluginsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".claudeplugin.js"));
  return files.map((file) => ({
    id: file.replace(/\.claudeplugin\.js$/, ""),
    filename: file,
    path: path.join(dir, file),
  }));
}

// --- Team/Shared Plugin Sync ---
// Clones/pulls a git repo (electron/team-sync.js, shells out to the system
// `git`) and copies matched *.claudeplugin.js / *.css files into the same
// userData/plugins and userData/themes directories any manually-installed
// plugin or theme already lives in — so once applied, a synced file is
// indistinguishable from one the user added by hand.
function getTeamSyncDir() {
  const dir = path.join(app.getPath("userData"), "team-sync");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function teamSyncCloneDir(repoUrl) {
  return path.join(getTeamSyncDir(), teamSync.slugifyRepoUrl(repoUrl));
}

async function runTeamSync() {
  const cfg = store.get("teamSync");
  if (!cfg || !cfg.enabled || !cfg.repoUrl) return { skipped: true };

  const dest = await teamSync.syncRepo({ repoUrl: cfg.repoUrl, branch: cfg.branch, teamSyncDir: getTeamSyncDir() });
  const files = teamSync.walkFiles(dest, [".claudeplugin.js", ".css"]);

  const manifest = { ...cfg.manifest };
  const appliedPluginIds = [];
  const appliedThemeIds = [];
  const conflicts = [];
  const pendingUpdates = [];

  files.forEach((file) => {
    const isPlugin = file.filename.endsWith(".claudeplugin.js");
    const kind = isPlugin ? "plugin" : "theme";
    const targetDir = isPlugin ? getUserPluginsDir() : getUserThemesDir();
    const localPath = path.join(targetDir, file.filename);
    const repoContent = fs.readFileSync(file.absPath, "utf8");
    const manifestEntry = manifest[file.relPath];
    const result = teamSync.classify({ repoContent, localPath, manifestHash: manifestEntry ? manifestEntry.hash : null });

    if (result.status === "in-sync") {
      manifest[file.relPath] = { hash: result.repoHash, kind };
      return;
    }
    if (result.status === "local-edited") return; // repo unchanged, only the user's own copy differs — nothing to do

    if (result.status === "new" || result.status === "update-available") {
      if (cfg.autoApply) {
        fs.writeFileSync(localPath, repoContent, "utf8");
        manifest[file.relPath] = { hash: result.repoHash, kind };
        if (isPlugin) appliedPluginIds.push(file.filename.replace(/\.claudeplugin\.js$/, ""));
        else appliedThemeIds.push(file.filename.replace(/\.css$/, ""));
      } else {
        pendingUpdates.push({ relPath: file.relPath, kind, filename: file.filename });
      }
      return;
    }
    if (result.status === "conflict") {
      conflicts.push({ relPath: file.relPath, kind, filename: file.filename });
    }
  });

  store.set("teamSync.manifest", manifest);
  store.set("teamSync.conflicts", conflicts);
  store.set("teamSync.pendingUpdates", pendingUpdates);
  store.set("teamSync.lastSyncedAt", Date.now());
  store.set("teamSync.lastSyncError", null);
  broadcastSettings();
  if (appliedPluginIds.length > 0 || appliedThemeIds.length > 0) {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send("betterclaude:team-sync-applied", { pluginIds: appliedPluginIds, themeIds: appliedThemeIds })
    );
  }
  return { appliedPluginIds, appliedThemeIds, conflicts, pendingUpdates };
}

let teamSyncTimer = null;

function stopTeamSync() {
  if (teamSyncTimer) {
    clearInterval(teamSyncTimer);
    teamSyncTimer = null;
  }
}

function startTeamSync() {
  stopTeamSync();
  const cfg = store.get("teamSync");
  if (!cfg || !cfg.enabled || !cfg.repoUrl || !cfg.intervalMinutes) return; // 0 = manual sync only
  const intervalMs = Math.max(5, cfg.intervalMinutes) * 60 * 1000;
  teamSyncTimer = setInterval(() => {
    runTeamSync().catch((err) => {
      console.error("[BetterClaude] team sync failed", err);
      store.set("teamSync.lastSyncError", err.message);
      broadcastSettings();
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("betterclaude:team-sync-error", err.message));
    });
  }, intervalMs);
}

function createWindow() {
  const bounds = getInitialBounds(store);

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 760,
    minHeight: 480,
    ...titleBarOptions,
    title: "BetterClaude",
    icon: APP_ICON_PATH,
    backgroundColor: "#14101f",
    alwaysOnTop: store.get("window.alwaysOnTop", false),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: "persist:betterclaude",
    },
  });

  attachWindowState(mainWindow, store);

  // claude.ai sets document.title per-conversation; keep the OS-level
  // window title (taskbar/alt-tab on Windows & Linux) fixed as "BetterClaude"
  // instead of letting the page override it.
  mainWindow.on("page-title-updated", (e) => {
    e.preventDefault();
    mainWindow.setTitle("BetterClaude");
  });

  splashWindow = createSplashWindow();
  mainWindow.webContents.once("did-finish-load", closeSplashWindow);
  mainWindow.webContents.once("did-fail-load", closeSplashWindow);
  mainWindow.loadURL("https://claude.ai");

  if (process.env.BC_DEBUG_CONSOLE) {
    mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    mainWindow.webContents.on("preload-error", (_e, preloadPath, error) => {
      console.error(`[preload-error] ${preloadPath}`, error);
    });
  }

  mainWindow.on("close", (e) => {
    if (!isQuitting && process.platform === "darwin") {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Keep normal claude.ai link-clicking behavior (open externally for
  // non-claude.ai targets) instead of hijacking navigation.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedAuthPopup(url)) return { action: "allow" };
    if (!url.startsWith("https://claude.ai")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

function buildTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  // Template image: macOS renders it as a monochrome silhouette (alpha-only shape,
  // color discarded) and auto-inverts it for light/dark menu bars and the
  // highlighted/clicked state. Requires the PNG to be monochrome-with-alpha,
  // which assets/tray-icon.png and tray-icon@2x.png are.
  if (!icon.isEmpty()) icon.setTemplateImage(true);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("BetterClaude");

  const updateMenu = () => {
    const alwaysOnTop = mainWindow ? mainWindow.isAlwaysOnTop() : false;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: mainWindow && mainWindow.isVisible() ? "Hide" : "Show",
          click: () => {
            if (!mainWindow) return;
            if (mainWindow.isVisible()) mainWindow.hide();
            else mainWindow.show();
          },
        },
        {
          label: "Always on Top",
          type: "checkbox",
          checked: alwaysOnTop,
          click: (item) => {
            if (!mainWindow) return;
            mainWindow.setAlwaysOnTop(item.checked);
            store.set("window.alwaysOnTop", item.checked);
          },
        },
        { type: "separator" },
        {
          label: "Quit",
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ])
    );
  };

  updateMenu();
  tray.on("click", updateMenu);
}

function buildAppMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" }]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Settings",
          accelerator: store.get("keyboardShortcuts.toggleSettings"),
          click: () => mainWindow && mainWindow.webContents.send("betterclaude:toggle-settings"),
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "BetterClaude on GitHub",
          click: () => shell.openExternal("https://github.com/"),
        },
        {
          label: "Check for Updates…",
          click: () => checkForUpdates(),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- IPC: settings ---
ipcMain.handle("settings:get", () => mergeDefaults(store.store));

ipcMain.handle("settings:set", (_e, keyPath, value) => {
  store.set(keyPath, value);
  // Only prompt shortcuts touch globalShortcut, and this handler also fires
  // on every slider "input" tick elsewhere in the app, so it's gated to the
  // one keyPath that can actually change a registered accelerator.
  if (keyPath === "promptLibrary.prompts") registerAllShortcuts();
  if (keyPath.startsWith("clipboardBridge.")) startClipboardBridge();
  if (keyPath.startsWith("teamSync.")) startTeamSync();
  const updated = mergeDefaults(store.store);
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("betterclaude:settings-changed", updated));
  return updated;
});

function broadcastSettings() {
  const updated = mergeDefaults(store.store);
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("betterclaude:settings-changed", updated));
  return updated;
}

// A Custom appearance is stored as a FROZEN copy of its base theme's CSS
// (beginCustomAppearance below), which also freezes the scaffold that CSS
// was generated with. Every later fix in core/tokens.js — composer
// geometry, the disclaimer strip, focus rings, hit targets — then silently
// never reaches anyone on a custom theme, while bundled presets pick it up
// on the next `npm run regen-themes`. That is a real silent-failure trap:
// the code is updated, the audit is green, and the one surface the user is
// actually looking at is untouched.
//
// Re-deriving on startup closes it. Only the --bc-* variables are carried
// over (extractThemeVars) — those ARE the user's choices; everything else
// in the stored string is generated scaffold that should track the current
// code. Colors are preserved exactly, so this is invisible except that
// scaffold fixes finally land.
function refreshCustomThemeScaffold() {
  const current = mergeDefaults(store.store);
  const stored = current.appearance.customThemeCSS;
  if (current.appearance.activeTheme !== "custom" || !stored) return;
  try {
    const vars = extractThemeVars(stored);
    // Bail rather than overwrite if the stored CSS yielded nothing
    // parseable — a stale-but-working theme beats replacing a user's colors
    // with scaffold defaults.
    if (!vars || !vars["--bc-bg"]) return;
    const nameMatch = stored.match(/BetterClaude scaffold:\s*(.+?)\s*\*\//);
    const rebuilt = buildThemeCSSFromVars(vars, nameMatch ? nameMatch[1] : "Custom");
    if (rebuilt && rebuilt !== stored) store.set("appearance.customThemeCSS", rebuilt);
  } catch (err) {
    console.error("[BetterClaude] could not refresh the custom theme scaffold:", err);
  }
}

function beginCustomAppearance() {
  const current = mergeDefaults(store.store);
  if (current.appearance.activeTheme === "custom") return false;
  const themes = readAllThemes();
  const base = current.appearance.activeTheme;
  const css = themes[base];
  if (!css) return false;
  store.set("appearance.customThemeBase", base);
  store.set("appearance.customThemeCSS", css);
  store.set("appearance.activeTheme", "custom");
  return true;
}

// Theme selection is an atomic reset boundary. Presets are deliberately
// pristine; manual cosmetic changes are deliberately unrestricted, but are
// held in a separate Custom appearance rather than silently riding on top of
// a selected preset.
ipcMain.handle("appearance:select-theme", (_e, themeId) => {
  const themes = readAllThemes();
  if (!themes[themeId]) throw new Error("Unknown theme");
  const current = mergeDefaults(store.store);
  const defaults = mergeDefaults({});
  const next = {
    ...current,
    appearance: {
      ...current.appearance,
      activeTheme: themeId,
      customThemeBase: null,
      customThemeCSS: "",
      accentColor: defaults.appearance.accentColor,
      colorBlindSafe: defaults.appearance.colorBlindSafe,
      contrastBoost: defaults.appearance.contrastBoost,
      glassPanels: defaults.appearance.glassPanels,
      schedule: defaults.appearance.schedule,
      weatherTheme: defaults.appearance.weatherTheme,
    },
    appearanceEditor: defaults.appearanceEditor,
    background: defaults.background,
    customCSS: defaults.customCSS,
    fonts: defaults.fonts,
    layout: defaults.layout,
    cursor: defaults.cursor,
    motion: defaults.motion,
  };
  store.set(next);
  return broadcastSettings();
});

// Called before any manual cosmetic write. It snapshots the current preset
// once, then later writes retain the user's deliberately-custom look.
ipcMain.handle("appearance:begin-custom", () => {
  beginCustomAppearance();
  return broadcastSettings();
});

// One IPC transaction prevents a late cosmetic write from racing a preset
// selection and silently re-layering itself on top of that pristine preset.
ipcMain.handle("appearance:set-cosmetic", (_e, keyPath, value) => {
  beginCustomAppearance();
  store.set(keyPath, value);
  return broadcastSettings();
});

// --- IPC: themes ---
ipcMain.handle("themes:get-all", () => readAllThemes());
ipcMain.handle("themes:list-user-ids", () => listUserThemeIds());

ipcMain.handle("themes:import-url", async (_e, url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch theme (HTTP ${res.status})`);
  const text = await res.text();
  const isJSON = /\.json(\?|$)/i.test(url) || (res.headers.get("content-type") || "").includes("json");
  return importThemeText(text, { isJSON, fallbackName: url });
});

ipcMain.handle("themes:import-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import Theme",
    filters: [{ name: "Theme files", extensions: ["css", "json"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const text = fs.readFileSync(filePath, "utf8");
  const isJSON = filePath.toLowerCase().endsWith(".json");
  return importThemeText(text, { isJSON, fallbackName: path.basename(filePath).replace(/\.(css|json)$/i, "") });
});

ipcMain.handle("themes:save-user", (_e, name, cssText) => writeUserTheme({ name, cssText }));

ipcMain.handle("themes:delete-user", (_e, id) => {
  const dest = path.join(getUserThemesDir(), `${id}.css`);
  // Guard against a crafted id escaping the user themes dir.
  if (path.dirname(dest) !== getUserThemesDir()) throw new Error("Invalid theme id");
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  return readAllThemes();
});

// --- IPC: OS theme sync ---
ipcMain.handle("system:get-os-theme", () => ({ isDark: nativeTheme.shouldUseDarkColors }));

// --- IPC: settings import/export ---
ipcMain.handle("settings:export", async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export BetterClaude Settings",
    defaultPath: "betterclaude-settings.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, JSON.stringify(store.store, null, 2), "utf8");
  return true;
});

ipcMain.handle("settings:import", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import BetterClaude Settings",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const parsed = JSON.parse(fs.readFileSync(result.filePaths[0], "utf8"));
  // mergeDefaults fills in anything the imported file is missing (e.g. an
  // export from an older version) rather than importing a partial/broken
  // settings object wholesale.
  const merged = mergeDefaults(parsed);
  store.set(merged);
  registerAllShortcuts();
  const updated = mergeDefaults(store.store);
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("betterclaude:settings-changed", updated));
  return updated;
});

// --- IPC: weather-based theming ---
// Fetched from the main process rather than the renderer for the same CSP
// reason themes:import-url is (claude.ai's page CSP governs what preload's
// own fetch() can reach; the main process isn't subject to it). Open-Meteo
// needs no API key.
ipcMain.handle("weather:get", async (_e, { lat, lon }) => {
  if (lat == null || lon == null) throw new Error("Missing coordinates");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current_weather=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather lookup failed (HTTP ${res.status})`);
  const data = await res.json();
  const cw = data.current_weather || {};
  return { code: cw.weathercode, isDay: cw.is_day === 1 };
});

// --- IPC: Prompt Library import/export ---
ipcMain.handle("promptLibrary:export", async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export Prompt Library",
    defaultPath: "betterclaude-prompts.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return false;
  const settings = mergeDefaults(store.store);
  const payload = { version: 1, prompts: settings.promptLibrary.prompts, folders: settings.promptLibrary.folders };
  fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), "utf8");
  return true;
});

ipcMain.handle("promptLibrary:import", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import Prompt Library",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const parsed = JSON.parse(fs.readFileSync(result.filePaths[0], "utf8"));
  const existing = store.get("promptLibrary.prompts", []);
  const incoming = Array.isArray(parsed.prompts) ? parsed.prompts : [];
  // Merge by id rather than replace outright, so importing a shared library
  // doesn't silently wipe prompts the user already wrote.
  const byId = new Map(existing.map((p) => [p.id, p]));
  incoming.forEach((p) => { if (p && p.id) byId.set(p.id, p); });
  store.set("promptLibrary.prompts", Array.from(byId.values()));
  if (Array.isArray(parsed.folders)) {
    const folders = new Set([...store.get("promptLibrary.folders", []), ...parsed.folders]);
    store.set("promptLibrary.folders", Array.from(folders));
  }
  registerAllShortcuts();
  return broadcastSettings();
});

// --- Global keyboard shortcuts (Prompt Library) ---
// The only use of Electron's globalShortcut in this app — everything else
// (menu accelerators) goes through Menu.buildFromTemplate instead, which is
// scoped to the app menu rather than system-wide. Per-prompt bindings need
// to fire even when claude.ai isn't the focused window, hence globalShortcut.
function registerPromptShortcuts() {
  const prompts = store.get("promptLibrary.prompts", []);
  prompts.forEach((p) => {
    if (!p.shortcut) return;
    try {
      globalShortcut.register(p.shortcut, () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send("betterclaude:trigger-prompt", p.id);
      });
    } catch (_err) {
      // Invalid/unavailable accelerator (e.g. already claimed by the OS) —
      // skip it rather than crashing the whole registration pass.
    }
  });
}

function registerAllShortcuts() {
  globalShortcut.unregisterAll();
  registerPromptShortcuts();
}

// --- IPC: profiles (also backs "Time Capsule") ---
// Applying a profile replaces the ENTIRE store contents (mirrors
// settings:import) since it's a full look-and-feel swap, not a single
// keyPath update — settings:set can't do this safely for a whole-object
// replace. The profiles shelf itself and window geometry are preserved
// across the swap: applying a profile changes your customization, not your
// saved profile list or window bounds.
ipcMain.handle("profiles:apply", (_e, id) => {
  const current = mergeDefaults(store.store);
  const profile = (current.profiles.list || []).find((p) => p.id === id);
  if (!profile) throw new Error("Profile not found");
  const merged = mergeDefaults({ ...profile.snapshot, profiles: current.profiles, window: current.window });
  store.set(merged);
  registerAllShortcuts();
  const updated = mergeDefaults(store.store);
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("betterclaude:settings-changed", updated));
  return updated;
});

// --- IPC: plugins ---
ipcMain.handle("plugins:list-sources", () => readAllPluginSources());
ipcMain.handle("plugins:open-folder", () => shell.openPath(getUserPluginsDir()));

ipcMain.handle("teamSync:sync", async () => {
  try {
    return await runTeamSync();
  } catch (err) {
    store.set("teamSync.lastSyncError", err.message);
    broadcastSettings();
    throw err;
  }
});

ipcMain.handle("teamSync:apply-file", async (_e, relPath) => {
  const cfg = store.get("teamSync");
  const absPath = path.join(teamSyncCloneDir(cfg.repoUrl), relPath);
  const filename = path.basename(relPath);
  const isPlugin = filename.endsWith(".claudeplugin.js");
  const kind = isPlugin ? "plugin" : "theme";
  const targetDir = isPlugin ? getUserPluginsDir() : getUserThemesDir();
  const localPath = path.join(targetDir, filename);
  const repoContent = fs.readFileSync(absPath, "utf8");
  fs.writeFileSync(localPath, repoContent, "utf8");

  const manifest = { ...cfg.manifest, [relPath]: { hash: teamSync.sha256(repoContent), kind } };
  store.set("teamSync.manifest", manifest);
  store.set("teamSync.conflicts", (cfg.conflicts || []).filter((c) => c.relPath !== relPath));
  store.set("teamSync.pendingUpdates", (cfg.pendingUpdates || []).filter((c) => c.relPath !== relPath));
  broadcastSettings();

  const id = filename.replace(/\.claudeplugin\.js$/, "").replace(/\.css$/, "");
  BrowserWindow.getAllWindows().forEach((w) =>
    w.webContents.send("betterclaude:team-sync-applied", { pluginIds: isPlugin ? [id] : [], themeIds: isPlugin ? [] : [id] })
  );
  return true;
});

ipcMain.handle("teamSync:keep-local", async (_e, relPath) => {
  const cfg = store.get("teamSync");
  const conflict = (cfg.conflicts || []).find((c) => c.relPath === relPath);
  if (!conflict) return false;
  const targetDir = conflict.kind === "plugin" ? getUserPluginsDir() : getUserThemesDir();
  const localPath = path.join(targetDir, conflict.filename);
  const localContent = fs.readFileSync(localPath, "utf8");
  store.set("teamSync.manifest", { ...cfg.manifest, [relPath]: { hash: teamSync.sha256(localContent), kind: conflict.kind } });
  store.set("teamSync.conflicts", (cfg.conflicts || []).filter((c) => c.relPath !== relPath));
  broadcastSettings();
  return true;
});

ipcMain.handle("teamSync:get-diff", async (_e, relPath) => {
  const cfg = store.get("teamSync");
  const absPath = path.join(teamSyncCloneDir(cfg.repoUrl), relPath);
  const repoContent = fs.readFileSync(absPath, "utf8");
  const item = [...(cfg.conflicts || []), ...(cfg.pendingUpdates || [])].find((c) => c.relPath === relPath);
  const kind = item ? item.kind : (relPath.endsWith(".css") ? "theme" : "plugin");
  const targetDir = kind === "plugin" ? getUserPluginsDir() : getUserThemesDir();
  const localPath = path.join(targetDir, path.basename(relPath));
  const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath, "utf8") : "";
  return { repoContent, localContent };
});

ipcMain.handle("teamSync:open-folder", () => shell.openPath(getTeamSyncDir()));

// --- IPC: Skill Marketplace ---
// "Install" only ever downloads SKILL.md + assets into a local folder —
// claude.ai has no public API to register a Skill programmatically, so
// nothing here attempts to call one. Users upload the result themselves via
// claude.ai's own Settings -> Capabilities UI.
function broadcastSettings() {
  const updated = mergeDefaults(store.store);
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("betterclaude:settings-changed", updated));
  return updated;
}

ipcMain.handle("skills:search", (_e, params) => searchSkillsRemote(params));

ipcMain.handle("skills:refresh-cache", async () => {
  const { items } = await searchSkillsRemote({ sort: "stars" });
  store.set("skillMarketplace.cache", { items, fetchedAt: Date.now() });
  return broadcastSettings().skillMarketplace.cache;
});

ipcMain.handle("skills:get-readme", async (_e, { owner, repo }) => {
  try {
    const res = await githubFetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
      { Accept: "application/vnd.github.raw" }
    );
    return await res.text();
  } catch (err) {
    if (/HTTP 404/.test(err.message)) return null;
    throw err;
  }
});

ipcMain.handle("skills:install", async (_e, { owner, repo, defaultBranch }) => {
  const branch = defaultBranch || "main";
  const id = slugifySkillId(owner, repo);
  const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
  const res = await fetch(zipUrl);
  if (!res.ok) throw new Error(`Couldn't download "${owner}/${repo}" (HTTP ${res.status}).`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const skillEntry = entries.find((e) => /(^|\/)SKILL\.md$/i.test(e.entryName));
  if (!skillEntry) throw new Error(`No SKILL.md found in ${owner}/${repo} (${branch}).`);
  const skillDir = skillEntry.entryName.includes("/")
    ? skillEntry.entryName.slice(0, skillEntry.entryName.lastIndexOf("/") + 1)
    : "";

  const destDir = path.join(getUserSkillsDir(), id);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  entries
    .filter((e) => !e.isDirectory && e.entryName.startsWith(skillDir))
    .forEach((e) => {
      const relPath = e.entryName.slice(skillDir.length);
      if (!relPath) return;
      const destPath = path.join(destDir, relPath);
      // Guard against a zip entry escaping destDir via ../ segments.
      if (path.relative(destDir, destPath).startsWith("..")) return;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, e.getData());
    });

  let commitSha = null;
  try {
    const branchRes = await githubFetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`
    );
    const branchData = await branchRes.json();
    commitSha = (branchData.commit && branchData.commit.sha) || null;
  } catch (_e) {
    // Non-fatal: install still succeeds, just without a tracked commit sha
    // until the next refresh (no precise "update available" badge till then).
  }

  const record = { owner, repo, branch, commitSha, installedAt: Date.now(), path: destDir };
  store.set(`skillMarketplace.installed.${id}`, record);
  broadcastSettings();
  return { id, ...record };
});

ipcMain.handle("skills:uninstall", async (_e, id) => {
  const installed = store.get("skillMarketplace.installed", {});
  const record = installed[id];
  // Guard: only ever delete something actually inside the skills dir.
  if (record && record.path && path.dirname(record.path) === getUserSkillsDir()) {
    fs.rmSync(record.path, { recursive: true, force: true });
  }
  const next = { ...installed };
  delete next[id];
  store.set("skillMarketplace.installed", next);
  return broadcastSettings().skillMarketplace.installed;
});

ipcMain.handle("skills:reveal", (_e, id) => {
  const installed = store.get("skillMarketplace.installed", {});
  const record = installed[id];
  const target = record && record.path && fs.existsSync(record.path) ? record.path : getUserSkillsDir();
  shell.showItemInFolder(target);
});

// --- Conversation Branching: fork windows ---
// DOM-automated per the design constraint: forking never calls claude.ai's
// private chat API. It opens a second real window on https://claude.ai/new
// and, once that page's own preload bootstrap sees the #bc-fork= hash, pre-
// fills the composer with the captured transcript — the user reviews and
// sends it themselves (see preload.js's bootstrap() hash handling).

// --- Native File Watcher Sync ---
// Never fakes claude.ai's own native file-upload UI — "attach" is a labeled
// text block inserted into the composer (core/file-sync-indicator.js), and
// this side just watches the real file on disk and pushes fresh content to
// every window when it changes. What (if anything) happens to the composer
// in response is entirely the renderer's call (electron/preload.js).
const fileWatchers = new Map(); // absolute path -> chokidar.FSWatcher

function stopFileWatcher(filePath) {
  const w = fileWatchers.get(filePath);
  if (w) {
    w.close();
    fileWatchers.delete(filePath);
  }
}

function startFileWatcher(filePath) {
  if (fileWatchers.has(filePath)) return;
  const watcher = chokidar.watch(filePath, { ignoreInitial: true });
  watcher.on("change", () => {
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (_e) {
      return; // briefly unreadable mid-write, or deleted — skip this tick
    }
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("betterclaude:file-changed", { path: filePath, content }));
  });
  watcher.on("error", (err) => console.error(`[BetterClaude] file watcher error for ${filePath}`, err));
  fileWatchers.set(filePath, watcher);
}

ipcMain.handle("fileWatcher:pick-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: "Watch a File", properties: ["openFile"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  try {
    return { path: filePath, name: path.basename(filePath), content: fs.readFileSync(filePath, "utf8") };
  } catch (err) {
    throw new Error(`Couldn't read "${filePath}": ${err.message}`);
  }
});

ipcMain.handle("fileWatcher:start", (_e, filePath) => startFileWatcher(filePath));
ipcMain.handle("fileWatcher:stop", (_e, filePath) => stopFileWatcher(filePath));

// --- Cross-Device Clipboard Bridge ---
// Off by default; only ever active while clipboardBridge.enabled is true
// *and* both relayUrl and passphrase are set. Payloads are end-to-end
// encrypted client-side (core/clipboard-bridge.js) before this ever calls
// out to the relay, so the relay (self-hosted or otherwise) only sees
// ciphertext plus a one-way channel id — never plaintext or the passphrase.
let clipboardBridgeTimer = null;
let clipboardBridgeStatus = { state: "idle", lastError: null, lastSyncedAt: null };
let clipboardBridgeLastLocal = null; // last value we saw/wrote, for change detection + de-echo
let clipboardBridgeLastPulledTs = 0;
const clipboardBridgeSeenIds = new Set();

function broadcastClipboardBridgeStatus() {
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("betterclaude:clipboard-bridge-status", clipboardBridgeStatus));
}

function clipboardBridgeRememberId(id) {
  clipboardBridgeSeenIds.add(id);
  if (clipboardBridgeSeenIds.size > 500) {
    // Cheap unbounded-growth guard for long-running sessions — exact LRU
    // eviction isn't worth it here since a false "unseen" re-application of
    // a very old item is harmless (it just re-writes the same clipboard text).
    const first = clipboardBridgeSeenIds.values().next().value;
    clipboardBridgeSeenIds.delete(first);
  }
}

async function clipboardBridgePush(text, cfg) {
  const channel = await deriveChannelId(cfg.passphrase);
  const { iv, ciphertext } = await encryptText(text, cfg.passphrase);
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${cfg.relayUrl.replace(/\/+$/, "")}/put`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel,
      id,
      iv,
      ciphertext,
      deviceName: cfg.deviceName || os.hostname(),
      ts: Date.now(),
      ttlSeconds: Math.max(30, (cfg.ttlMinutes || 5) * 60),
    }),
  });
  if (!res.ok) throw new Error(`Relay push failed (HTTP ${res.status})`);
  clipboardBridgeRememberId(id);
}

async function clipboardBridgePull(cfg) {
  const channel = await deriveChannelId(cfg.passphrase);
  const res = await fetch(`${cfg.relayUrl.replace(/\/+$/, "")}/pull?channel=${encodeURIComponent(channel)}&after=${clipboardBridgeLastPulledTs}`);
  if (!res.ok) throw new Error(`Relay pull failed (HTTP ${res.status})`);
  const { items } = await res.json();
  const deviceName = cfg.deviceName || os.hostname();
  for (const item of items || []) {
    clipboardBridgeLastPulledTs = Math.max(clipboardBridgeLastPulledTs, item.ts);
    if (clipboardBridgeSeenIds.has(item.id)) continue;
    clipboardBridgeRememberId(item.id);
    if (item.deviceName === deviceName) continue; // defensive: ignore our own echo even if the relay ever replayed it
    let text;
    try {
      text = await decryptText(item, cfg.passphrase);
    } catch (_e) {
      continue; // wrong passphrase (different room) or corrupted payload — skip silently
    }
    clipboardBridgeLastLocal = text;
    clipboard.writeText(text);
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("betterclaude:clipboard-synced", { deviceName: item.deviceName, ts: item.ts }));
  }
}

async function clipboardBridgeTick() {
  const cfg = store.get("clipboardBridge");
  if (!cfg || !cfg.enabled || !cfg.relayUrl || !cfg.passphrase) return;
  try {
    const current = clipboard.readText();
    if (current && current !== clipboardBridgeLastLocal) {
      clipboardBridgeLastLocal = current;
      await clipboardBridgePush(current, cfg);
    }
    await clipboardBridgePull(cfg);
    clipboardBridgeStatus = { state: "connected", lastError: null, lastSyncedAt: Date.now() };
    store.set("clipboardBridge.lastSyncedAt", clipboardBridgeStatus.lastSyncedAt);
  } catch (err) {
    clipboardBridgeStatus = { state: "error", lastError: err.message, lastSyncedAt: clipboardBridgeStatus.lastSyncedAt };
  }
  broadcastClipboardBridgeStatus();
}

function stopClipboardBridge() {
  if (clipboardBridgeTimer) {
    clearInterval(clipboardBridgeTimer);
    clipboardBridgeTimer = null;
  }
  clipboardBridgeStatus = { state: "idle", lastError: null, lastSyncedAt: clipboardBridgeStatus.lastSyncedAt };
}

function startClipboardBridge() {
  stopClipboardBridge();
  const cfg = store.get("clipboardBridge");
  if (!cfg || !cfg.enabled || !cfg.relayUrl || !cfg.passphrase) {
    broadcastClipboardBridgeStatus();
    return;
  }
  // Seed with whatever's already on the clipboard so enabling the bridge
  // doesn't immediately push out old, possibly-stale clipboard content.
  clipboardBridgeLastLocal = clipboard.readText();
  clipboardBridgeStatus = { state: "connecting", lastError: null, lastSyncedAt: clipboardBridgeStatus.lastSyncedAt };
  broadcastClipboardBridgeStatus();
  const intervalMs = Math.max(3, cfg.pollIntervalSeconds || 5) * 1000;
  clipboardBridgeTimer = setInterval(() => clipboardBridgeTick(), intervalMs);
  clipboardBridgeTick();
}

ipcMain.handle("clipboardBridge:get-status", () => clipboardBridgeStatus);

ipcMain.handle("clipboardBridge:push-now", async () => {
  const cfg = store.get("clipboardBridge");
  if (!cfg.enabled || !cfg.relayUrl || !cfg.passphrase) throw new Error("Clipboard Bridge isn't fully configured yet.");
  const text = clipboard.readText();
  if (!text) throw new Error("Clipboard is empty.");
  clipboardBridgeLastLocal = text;
  await clipboardBridgePush(text, cfg);
  clipboardBridgeStatus = { state: "connected", lastError: null, lastSyncedAt: Date.now() };
  store.set("clipboardBridge.lastSyncedAt", clipboardBridgeStatus.lastSyncedAt);
  broadcastClipboardBridgeStatus();
  return clipboardBridgeStatus;
});

ipcMain.handle("clipboardBridge:test-connection", async () => {
  const cfg = store.get("clipboardBridge");
  if (!cfg.relayUrl) throw new Error("Set a relay URL first.");
  const res = await fetch(`${cfg.relayUrl.replace(/\/+$/, "")}/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
});

// --- Usage Analytics Dashboard ---
// All storage is local (electron/analytics-db.js, a WASM SQLite database
// under userData/analytics.sqlite) — no external analytics service is ever
// contacted. Every handler awaits analyticsDbReady since init is async
// (loading the WASM engine + any existing on-disk database) and can run
// after the renderer's first analytics call.
function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

ipcMain.handle("analytics:log-plugin-tick", async (_e, { ts, day, pluginIds }) => {
  await analyticsDbReady;
  try {
    (pluginIds || []).forEach((pluginId) => analyticsDb.logEvent({ ts, day, type: "plugin", pluginId }));
  } catch (err) {
    console.error("[BetterClaude] analytics plugin log failed", err);
  }
});

ipcMain.handle("analytics:query", async (_e, range) => {
  await analyticsDbReady;
  try {
    return analyticsDb.queryAnalytics(range);
  } catch (err) {
    console.error("[BetterClaude] analytics query failed", err);
    return null;
  }
});

ipcMain.handle("analytics:export-csv", async (_e, range) => {
  await analyticsDbReady;
  const rows = analyticsDb.exportRows(range);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export Usage Analytics",
    defaultPath: `betterclaude-usage-${range.from}_${range.to}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const header = "ts,day,type,role,tokens,model,project,pluginId,costUsd";
  const lines = [header, ...rows.map((r) =>
    [r.ts, r.day, r.type, csvEscape(r.role), r.tokens || 0, csvEscape(r.model), csvEscape(r.project), csvEscape(r.pluginId), r.costUsd || 0].join(",")
  )];
  fs.writeFileSync(result.filePath, lines.join("\n"), "utf8");
  return result.filePath;
});

ipcMain.handle("analytics:save-png", async (_e, { dataUrl, suggestedName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export Chart",
    defaultPath: suggestedName || "betterclaude-chart.png",
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync(result.filePath, Buffer.from(base64, "base64"));
  return result.filePath;
});

ipcMain.handle("analytics:clear", async () => {
  await analyticsDbReady;
  analyticsDb.clearAll();
  return true;
});

// --- Smart Notification Digest: native OS notification ---
// Used both for a flushed digest and for any "urgent" (failure) notify()
// call — see electron/preload.js's notify(). Electron's Notification API is
// unsupported on a handful of minimal Linux setups; isSupported() guards
// that instead of throwing.
ipcMain.handle("notifications:show-native", (_e, { title, body }) => {
  if (!Notification.isSupported()) return false;
  new Notification({ title: title || "BetterClaude", body: body || "" }).show();
  return true;
});

// --- IPC: window controls (frameless chrome) ---
ipcMain.handle("window:minimize", () => mainWindow && mainWindow.minimize());
ipcMain.handle("window:maximize-toggle", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("window:close", () => mainWindow && mainWindow.close());
ipcMain.handle("window:toggle-always-on-top", () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next);
  store.set("window.alwaysOnTop", next);
  return next;
});
ipcMain.handle("window:is-always-on-top", () => (mainWindow ? mainWindow.isAlwaysOnTop() : false));

// --- IPC: auto-updater ---
// Packaged-only: dev runs (`electron .`) have no update feed configured and
// would just surface a confusing "not found" error from electron-updater.
async function checkForUpdates() {
  if (!app.isPackaged) {
    updateStatus = { state: "error", error: "Updates only check in packaged builds, not `npm start`." };
    broadcastUpdateStatus();
    return updateStatus;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    updateStatus = { state: "error", error: err.message };
    broadcastUpdateStatus();
  }
  return updateStatus;
}

ipcMain.handle("updater:check", () => checkForUpdates());

ipcMain.handle("updater:download", async () => {
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    updateStatus = { state: "error", error: err.message };
    broadcastUpdateStatus();
  }
  return updateStatus;
});

ipcMain.handle("updater:install", () => {
  isQuitting = true;
  autoUpdater.quitAndInstall();
});

ipcMain.handle("updater:get-status", () => updateStatus);

// --- Dev-mode auto-reload (npm run dev / `electron . --dev`) --------------
// Renderer-side code (core/, ui/, themes/, plugins/, electron/preload.js)
// runs fresh from disk every time a window reloads — Electron gives preload
// a brand-new context on each navigation, so a plain webContents.reload()
// is enough to pick up edits there (esbuild's own --watch, started by
// scripts/dev-watch.js, keeps build/*.bundle.js current in the meantime).
// electron/main.js and the other main-process-only modules below only run
// once in this process, so picking up edits to *those* needs a real
// app.relaunch(), not just a window reload.
const isDev = process.argv.includes("--dev");
const DEV_HARD_RELAUNCH_FILES = [
  path.join(__dirname, "main.js"),
  path.join(__dirname, "window-state.js"),
  path.join(__dirname, "analytics-db.js"),
  path.join(__dirname, "team-sync.js"),
];
const DEV_SOFT_RELOAD_PATHS = [
  path.join(__dirname, "..", "core"),
  path.join(__dirname, "..", "ui"),
  path.join(__dirname, "..", "themes"),
  path.join(__dirname, "..", "plugins"),
  path.join(__dirname, "..", "build"),
  path.join(__dirname, "preload.js"),
];

function startDevAutoReload() {
  let reloadTimer = null;
  const softWatcher = chokidar.watch(DEV_SOFT_RELOAD_PATHS, { ignoreInitial: true });
  softWatcher.on("all", () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      console.log("[BetterClaude/dev] change detected, reloading window(s)...");
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.reloadIgnoringCache());
    }, 200);
  });

  let relaunchTimer = null;
  const hardWatcher = chokidar.watch(DEV_HARD_RELAUNCH_FILES, { ignoreInitial: true });
  hardWatcher.on("all", () => {
    clearTimeout(relaunchTimer);
    relaunchTimer = setTimeout(() => {
      console.log("[BetterClaude/dev] main-process change detected, relaunching app...");
      app.relaunch();
      app.exit(0);
    }, 200);
  });
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(APP_ICON_PATH));
  }

  seedBuiltinPlugins();
  // Before any window opens, so the first paint already uses the current
  // scaffold rather than flashing a stale custom theme (see the function's
  // comment for why a frozen customThemeCSS is a silent-failure trap).
  refreshCustomThemeScaffold();
  createWindow();
  if (isDev) startDevAutoReload();
  buildTray();
  buildAppMenu();
  setupAutoUpdater();
  registerAllShortcuts();
  // Re-arm file watchers from the saved list so watching survives a restart.
  (store.get("fileWatcher.watched", []) || []).forEach((w) => {
    if (w && w.path && fs.existsSync(w.path)) startFileWatcher(w.path);
  });
  startClipboardBridge();
  analyticsDbReady = analyticsDb.initAnalyticsDb(app.getPath("userData")).catch((err) => {
    console.error("[BetterClaude] analytics DB init failed", err);
    return null;
  });
  startTeamSync();
  // Background check shortly after launch; silent (no native OS dialog) —
  // the renderer surfaces it via betterclaude:update-status instead so it
  // can be dismissed/actioned inside our own UI.
  setTimeout(() => checkForUpdates(), 5000);

  nativeTheme.on("updated", () => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send("betterclaude:os-theme-changed", { isDark: nativeTheme.shouldUseDarkColors })
    );
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  fileWatchers.forEach((w) => w.close());
  fileWatchers.clear();
  stopClipboardBridge();
  analyticsDb.shutdown();
  stopTeamSync();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
