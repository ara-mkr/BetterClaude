const { app, BrowserWindow, WebContentsView, Tray, Menu, ipcMain, nativeImage, nativeTheme, shell, dialog, screen, globalShortcut, clipboard, Notification } = require("electron");
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
const { BUDDY_CANVAS, BUDDY_HIT_BOX, getBuddy, resolveActiveBuddy } = require("../core/buddies");
const { titleBarOptions, TITLE_BAR_HEIGHT } = require("./window-chrome");
const { ClaudeNotFoundError, ClaudeSession, PtySpawnError, locateClaude } = require("./claude-cli");
const { autoUpdater } = require("electron-updater");
const { pickLoadingTip } = require("../core/motion-fx");
const { deriveChannelId, encryptText, decryptText } = require("../core/clipboard-bridge");
const analyticsDb = require("./analytics-db");
const teamSync = require("./team-sync");

// Single source of truth for the repo that backs the update feed and every
// "view on GitHub" affordance. Must stay in lockstep with package.json's
// build.publish block: electron-updater reads the actual feed URL from the
// app-update.yml electron-builder generates out of THAT, not from here, so a
// mismatch means the fallback link points somewhere the update didn't come from.
const GITHUB_REPO = "ara-mkr/betterclaude";
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;
const RELEASES_URL = `${GITHUB_URL}/releases/latest`;

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

let mainWindow = null;
let tray = null;
let isQuitting = false;
let splashWindow = null;
let analyticsDbReady = null;
let buddyWindow = null;
let buddyDrag = null;        // { offsetX, offsetY } while a drag is in flight
let buddyWorking = false;    // last reported "Claude is generating" state

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
//
// CODE SIGNING — read before shipping a public release:
//   * macOS: electron-updater REFUSES to apply an update whose signature
//     doesn't match the running app. An unsigned/ad-hoc-signed build will
//     download fine and then fail at install with a code-signature error,
//     and Gatekeeper additionally quarantines the downloaded .dmg/.zip so
//     first-launch shows "app is damaged / can't be opened". Fixing this
//     needs an Apple Developer ID Application cert + notarization
//     (electron-builder `mac.notarize`). NOT attempted here.
//   * Windows: NSIS updates DO apply unsigned, but SmartScreen shows an
//     "unrecognized publisher" warning on every install until the build is
//     signed with an EV/OV code-signing cert and has built reputation.
//   Until both are in place, treat the in-app updater as best-effort: the
//   "error" state below deliberately carries releasesUrl so the UI can
//   always fall back to a manual download instead of dead-ending.
//
// state: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error"
let updateStatus = { state: "idle" };

function broadcastUpdateStatus() {
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("betterclaude:update-status", updateStatus));
}

// GitHub release bodies arrive either as a raw markdown/HTML string or, when
// several releases were skipped, as [{ version, note }, ...]. Collapse both
// into one short plain-text line — the banner has room for a blurb, not a
// changelog, and injecting release HTML into claude.ai's DOM is not something
// we want to do with text we don't control.
function summarizeReleaseNotes(raw) {
  const text = Array.isArray(raw)
    ? raw.map((r) => (r && r.note) || "").join(" ")
    : String(raw || "");
  const plain = text
    .replace(/<[^>]*>/g, " ")       // strip tags
    .replace(/^[#>*\-\s]+/gm, " ")  // strip markdown bullet/heading marks
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  return plain.length > 160 ? `${plain.slice(0, 157)}…` : plain;
}

function setupAutoUpdater() {
  // Ask before spending the user's bandwidth — checkForUpdates() alone just
  // reports availability, downloadUpdate() is a separate, explicit step
  // triggered from the renderer once the user opts in.
  autoUpdater.autoDownload = false;
  // Never install behind the user's back on quit; the renderer's
  // "Restart & Install" button is the only path to quitAndInstall().
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("checking-for-update", () => {
    updateStatus = { state: "checking" };
    broadcastUpdateStatus();
  });
  autoUpdater.on("update-available", (info) => {
    updateStatus = {
      state: "available",
      version: info.version,
      notes: summarizeReleaseNotes(info.releaseNotes),
      releasesUrl: RELEASES_URL,
    };
    broadcastUpdateStatus();
  });
  autoUpdater.on("update-not-available", () => {
    updateStatus = { state: "not-available" };
    broadcastUpdateStatus();
  });
  autoUpdater.on("error", (err) => {
    updateStatus = { state: "error", error: err.message, releasesUrl: RELEASES_URL };
    broadcastUpdateStatus();
  });
  autoUpdater.on("download-progress", (progress) => {
    updateStatus = {
      state: "downloading",
      percent: Math.round(progress.percent),
      version: updateStatus.version,
      notes: updateStatus.notes,
    };
    broadcastUpdateStatus();
  });
  autoUpdater.on("update-downloaded", (info) => {
    updateStatus = { state: "downloaded", version: (info && info.version) || updateStatus.version };
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
  // Builtin plugins are COPIED into userData/plugins so they sit alongside
  // (and can be edited like) user-installed ones. That copy used to be
  // strictly once-only — `if (!fs.existsSync(dest))` — which quietly made
  // every bundled plugin un-fixable after first launch: the repo's copy could
  // be corrected release after release and the stale copy on disk, the only
  // one actually loaded, never changed. That is exactly the silent-failure
  // shape refreshCustomThemeScaffold() above exists to prevent, and it had
  // already bitten: markdown-plus on disk still called `api.onMessage`, an API
  // removed from core/plugin-loader.js, so it threw on every single launch
  // while the bundled version had been rewritten to use a MutationObserver.
  //
  // Re-seeding has to respect edits, though: userData/plugins is a directory
  // users are invited to edit. So we remember the hash of what we last wrote
  // (plugins.seededVersions) and only overwrite a file that still matches it —
  // i.e. our own untouched copy. A file the user has changed is left alone.
  const seeded = store.get("plugins.seededVersions", {}) || {};
  const nextSeeded = { ...seeded };
  const builtins = fs.readdirSync(BUILTIN_PLUGINS_DIR).filter((f) => f.endsWith(".claudeplugin.js"));

  for (const file of builtins) {
    const src = path.join(BUILTIN_PLUGINS_DIR, file);
    const dest = path.join(userDir, file);
    try {
      const bundled = fs.readFileSync(src, "utf8");
      const bundledHash = teamSync.sha256(bundled);

      if (!fs.existsSync(dest)) {
        fs.writeFileSync(dest, bundled);
        nextSeeded[file] = bundledHash;
        continue;
      }

      const currentHash = teamSync.sha256(fs.readFileSync(dest, "utf8"));
      if (currentHash === bundledHash) {
        // Already current. Record the hash so a pre-existing install starts
        // being tracked without needing a rewrite it doesn't need.
        nextSeeded[file] = bundledHash;
        continue;
      }

      const lastSeeded = seeded[file];
      if (lastSeeded && currentHash !== lastSeeded) {
        // Diverged from what we wrote: the user edited it. Their file wins.
        continue;
      }

      if (!lastSeeded) {
        // Installed before seededVersions existed, so there is no record to
        // tell an old seed apart from a deliberate edit. The stale-copy case
        // is the one actively breaking things, so it wins — but never at the
        // cost of destroying work, hence the backup.
        fs.copyFileSync(dest, `${dest}.user-backup`);
        console.log(`[BetterClaude] updating bundled plugin "${file}"; previous copy saved as ${file}.user-backup`);
      }

      fs.writeFileSync(dest, bundled);
      nextSeeded[file] = bundledHash;
    } catch (err) {
      // One unreadable/unwritable plugin file must not stop the other eight
      // from being seeded, and must not block startup.
      console.error(`[BetterClaude] could not seed bundled plugin "${file}":`, err.message);
    }
  }

  store.set("plugins.seededVersions", nextSeeded);
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

// --- Buddy overlay window ---------------------------------------------------
// A desktop-level pet: its own frameless transparent always-on-top window that
// floats over every application, not just over BetterClaude.

const BUDDIES_DIR = path.join(__dirname, "..", "resources", "buddies");
// Half the processed canvas (640x360). Big enough for the character to read at
// a glance, small enough not to dominate a corner of the screen.
const BUDDY_W = Math.round(BUDDY_CANVAS.width / 2);
const BUDDY_H = Math.round(BUDDY_CANVAS.height / 2);

function buddyAssetUrls(buddy) {
  const dir = path.join(BUDDIES_DIR, buddy.id);
  const urls = {};
  for (const [state, file] of Object.entries(buddy.assets)) {
    // pathToFileURL, not a hand-built "file://" + path: the app can sit under
    // a directory with spaces (it does — "BETTERCLAUDE DESKTOP MAIN"), and an
    // unescaped space makes the <video> src silently fail to load.
    urls[state] = require("url").pathToFileURL(path.join(dir, file)).href;
  }
  return urls;
}

/**
 * Keep a saved position on a display that actually exists.
 *
 * Without this, unplugging the monitor the buddy was parked on would leave it
 * at coordinates no display covers — permanently invisible and undraggable,
 * with no UI to recover it.
 */
function clampToDisplays(x, y, w, h) {
  const displays = screen.getAllDisplays();
  const fits = displays.some((d) => {
    const a = d.workArea;
    return x >= a.x && y >= a.y && x + w <= a.x + a.width && y + h <= a.y + a.height;
  });
  if (fits) return { x, y };

  // Snap to whichever display's work area is nearest the saved point, then
  // clamp inside it, so the buddy lands somewhere sensible rather than at 0,0.
  const target = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }) || screen.getPrimaryDisplay();
  const a = target.workArea;
  return {
    x: Math.round(Math.min(Math.max(x, a.x), a.x + a.width - w)),
    y: Math.round(Math.min(Math.max(y, a.y), a.y + a.height - h)),
  };
}

function defaultBuddyPosition() {
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - BUDDY_W - 24, y: a.y + a.height - BUDDY_H - 24 };
}

function resolveBuddyPosition() {
  const saved = store.get("buddies.position") || {};
  if (typeof saved.x !== "number" || typeof saved.y !== "number") return defaultBuddyPosition();
  return clampToDisplays(saved.x, saved.y, BUDDY_W, BUDDY_H);
}

function buddyState() {
  const settings = mergeDefaults(store.store);
  const buddy = resolveActiveBuddy(settings);
  if (!buddy) return null;
  return {
    buddy: { id: buddy.id, label: buddy.label, cycle: buddy.cycle },
    assets: buddyAssetUrls(buddy),
    animations: settings.buddies.animations !== false,
    hitBox: BUDDY_HIT_BOX,
  };
}

function createBuddyWindow() {
  const pos = resolveBuddyPosition();
  buddyWindow = new BrowserWindow({
    width: BUDDY_W,
    height: BUDDY_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,        // never steal focus from whatever the user is doing
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "buddy-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // "floating" alone still sits below fullscreen apps and other desktops;
  // this pair is what makes it a true desktop-level overlay on macOS.
  buddyWindow.setAlwaysOnTop(true, "floating");
  buddyWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Start click-through; the renderer turns it off only while the pointer is
  // actually over the sprite. `forward: true` is what keeps mousemove flowing
  // to the page while ignoring is on, which that hit-testing depends on.
  buddyWindow.setIgnoreMouseEvents(true, { forward: true });

  buddyWindow.loadFile(path.join(__dirname, "buddy-overlay.html"));
  buddyWindow.once("ready-to-show", () => {
    if (!buddyWindow || buddyWindow.isDestroyed()) return;
    buddyWindow.showInactive();
    buddyWindow.webContents.send("buddy:working", buddyWorking);
  });
  buddyWindow.on("closed", () => { buddyWindow = null; });
  return buddyWindow;
}

function destroyBuddyWindow() {
  if (buddyWindow && !buddyWindow.isDestroyed()) buddyWindow.destroy();
  buddyWindow = null;
  buddyDrag = null;
}

/**
 * Bring the overlay in line with current settings. Safe to call on any
 * settings change — it is what makes the toggles live-apply without a restart.
 */
function syncBuddyWindow() {
  const state = buddyState();
  if (!state) {
    // Destroyed rather than hidden: an idle hidden window still holds a
    // renderer process and three decoded video elements.
    destroyBuddyWindow();
    return;
  }
  if (!buddyWindow || buddyWindow.isDestroyed()) {
    createBuddyWindow();
    return;
  }
  buddyWindow.webContents.send("buddy:state", state);
}

ipcMain.handle("buddy:get-state", () => buddyState());

ipcMain.on("buddy:drag-start", (_e, { screenX, screenY }) => {
  if (!buddyWindow || buddyWindow.isDestroyed()) return;
  const [wx, wy] = buddyWindow.getPosition();
  // Remember where inside the window the grab happened, so the sprite doesn't
  // jump to have its corner under the cursor on the first move.
  buddyDrag = { offsetX: screenX - wx, offsetY: screenY - wy };
});

ipcMain.on("buddy:drag-move", (_e, { screenX, screenY }) => {
  if (!buddyDrag || !buddyWindow || buddyWindow.isDestroyed()) return;
  buddyWindow.setPosition(Math.round(screenX - buddyDrag.offsetX), Math.round(screenY - buddyDrag.offsetY));
});

ipcMain.on("buddy:drag-end", () => {
  if (!buddyDrag || !buddyWindow || buddyWindow.isDestroyed()) return buddyDrag = null;
  const [x, y] = buddyWindow.getPosition();
  buddyDrag = null;
  // Persist on drop rather than on every move — setPosition fires at pointer
  // rate and would otherwise write to disk dozens of times per drag.
  store.set("buddies.position", { x, y });
});

ipcMain.on("buddy:set-interactive", (_e, interactive) => {
  if (!buddyWindow || buddyWindow.isDestroyed()) return;
  buddyWindow.setIgnoreMouseEvents(!interactive, { forward: true });
});

// A plain click (mousedown/up with no drag distance in between) on the
// buddy: one more way back into the main window, alongside the Dock icon and
// the tray. (An older comment here claimed the Dock icon was hidden. It never
// was — nothing in this app calls app.dock.hide() — and that belief is what
// let the Dock-click path stay broken for so long without being questioned.)
ipcMain.on("buddy:open-main", () => {
  revealMainWindow();
});

// Reported by the claude.ai preload, which is the only place that can see the
// page's generating state. Broadcast rather than polled so the overlay reacts
// on the state edge.
ipcMain.on("buddy:report-working", (_e, working) => {
  const next = !!working;
  if (next === buddyWorking) return;
  buddyWorking = next;
  if (buddyWindow && !buddyWindow.isDestroyed()) buddyWindow.webContents.send("buddy:working", buddyWorking);
});

ipcMain.handle("buddies:get-thumbnail", (_e, id) => {
  const buddy = getBuddy(id);
  if (!buddy) return null;
  const file = path.join(BUDDIES_DIR, buddy.id, buddy.assets.idle);
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return null;
  // Downscaled to a thumbnail before base64: the full idle PNG would be ~108KB
  // of data URI on a settings panel that re-renders on every keystroke.
  return img.resize({ height: 96, quality: "good" }).toDataURL();
});

// --- Embedded Claude Code window ---
//
// A BetterClaude-owned BrowserWindow wearing the same custom title bar as the
// main window, whose body is the user's REAL `claude` CLI running in a real
// pseudo-terminal (electron/claude-cli.js) and rendered with xterm.js. Same
// relationship lazygit has with git: we spawn the binary the user already
// installed and logged into, and draw its output. Nothing about Claude Code
// itself is reimplemented, faked, or modified.
//
// Compliance boundaries this window must keep (see also claude-cli.js):
//   - No auth/token/session file is read, written, or looked for anywhere in
//     this path. The CLI handles its own credentials in its own process,
//     exactly as it would in Terminal.app.
//   - The only thing ever written to the child's stdin is the user's own
//     keystrokes, forwarded verbatim from xterm's onData.
//   - Terminal output is never parsed or matched to trigger behaviour. It is
//     copied to the renderer and drawn. Themes/presets change colour and
//     chrome only, never what the CLI does.
//
// Single-session by design, matching how buddyWindow above is handled and what
// the tray/menu affordance implies: re-launching focuses the existing session
// instead of silently starting a second `claude` the user can't see. Concurrent
// sessions would need a tabbed or split UI inside the pane to be usable at all,
// which is a bigger feature than this one (flagged for review, not assumed).
//
// WHY A WebContentsView AND NOT A SECOND BrowserWindow (it used to be one), AND
// NOT AN IFRAME INSIDE claude.ai's PAGE.
//
// The iframe is out on security grounds and that is not negotiable: this pane's
// renderer talks to a node-pty over a contextBridge. Putting it in the same
// webContents as remote content from claude.ai would place that bridge one
// same-origin bug away from the internet. A WebContentsView keeps the exact
// process and realm boundary the standalone window had — separate webContents,
// separate preload, `default-src 'none'` CSP on its own local page — and
// changes only where its pixels land.
//
// It also buys the thing Step 4 needs for free: claude.ai reloading itself does
// not touch this webContents, so the terminal, its scrollback, and the child
// `claude` process all survive a reload of the page next to them.
let codeView = null;
let codeViewShown = false;
// Detached-but-still-open. A WebContentsView composites above the window's web
// page unconditionally, so it also covers BetterClaude's own in-page overlays —
// open Settings with the pane showing and the panel renders behind it. The pane
// therefore steps aside while an overlay is up. This is NOT the same state as
// `codeViewShown`: the tab is still the tab the user is on, the pill stays
// active, and the terminal and its child process are untouched.
let codeViewSuspended = false;
let codeSession = null;

// Where the pane sits, in CSS px relative to the window's content area. The
// renderer measures claude.ai's real sidebar and reports it (`code-tab:layout`)
// so the pane lands exactly where claude.ai's own content area is, and follows
// it when the user drags the sidebar's resize handle or collapses it.
//
// Seeded to a full-width content area below the title bar: that is what a
// missing or unresolvable sidebar should fall back to, and it is also correct
// for the first frame, before the renderer has measured anything.
let codeViewBounds = { x: 0, y: TITLE_BAR_HEIGHT, width: 0, height: 0 };

// cwd for the FIRST session only, consumed by the `code:ready` handler once the
// renderer has measured its terminal. Later folder changes go through
// openCodeWindowInFolder(), which restarts an already-running session instead.
let codePendingCwd = null;

// Terminal geometry before the renderer has measured itself. The real cols/rows
// arrive over `code:ready` a moment later, and every later resize comes from
// xterm's fit addon — these only have to be sane enough that a CLI which draws
// immediately doesn't wrap against a 0-column terminal.
const CODE_DEFAULT_COLS = 100;
const CODE_DEFAULT_ROWS = 30;

// Last renderer-reported terminal size, so a restart reuses the dimensions the
// pane is actually drawn at instead of re-spawning at the defaults and
// immediately resizing (which makes a CLI that paints on startup redraw over
// itself). Module-scoped now that there is no window object to hang it on.
let codeLastTerm = { cols: null, rows: null };

/**
 * Working directory for a new session, in the order the user would expect:
 * an explicitly requested folder, then the last folder they opened one in,
 * then $HOME. Never process.cwd() — for a packaged .app launched from the Dock
 * that's `/`, which is a hostile place to drop someone's coding session.
 */
function resolveCodeCwd(requested) {
  const candidates = [requested, store.get("codeWindow.lastCwd"), os.homedir()];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // Stale stored path (folder renamed or deleted since) — fall through to
      // the next candidate rather than failing the launch.
    }
  }
  return os.homedir();
}

/** Kills the child and drops our handle. Safe to call more than once. */
function disposeCodeSession() {
  if (!codeSession) return;
  codeSession.dispose();
  codeSession = null;
}

/**
 * Starts `claude` for an already-open Code window and pipes it to that window.
 * Errors are sent to the renderer to be drawn in the terminal area rather than
 * thrown here: a missing CLI is a normal, recoverable, user-facing situation
 * ("install Claude Code first"), not a main-process fault.
 */
function startCodeSession({ cwd, cols, rows }) {
  disposeCodeSession();
  const target = codeView && codeView.webContents;
  if (!target || target.isDestroyed()) return;

  let binaryPath;
  try {
    binaryPath = locateClaude(store.get("codeWindow.claudePath") || undefined);
  } catch (err) {
    if (err instanceof ClaudeNotFoundError) {
      target.send("code:fatal", { message: err.message });
      return;
    }
    throw err;
  }

  try {
    const finalCols = Number.isFinite(cols)
      ? cols
      : Number.isFinite(codeLastTerm.cols)
        ? codeLastTerm.cols
        : CODE_DEFAULT_COLS;
    const finalRows = Number.isFinite(rows)
      ? rows
      : Number.isFinite(codeLastTerm.rows)
        ? codeLastTerm.rows
        : CODE_DEFAULT_ROWS;

    codeSession = new ClaudeSession({
      binaryPath,
      cwd,
      cols: finalCols,
      rows: finalRows,
    });
  } catch (err) {
    if (err instanceof PtySpawnError) {
      target.send("code:fatal", { message: `${err.message}\n\n${err.detail}` });
      return;
    }
    throw err;
  }

  store.set("codeWindow.lastCwd", cwd);

  const session = codeSession;
  session.on("data", (chunk) => {
    // Guarded on every chunk, not just at startup: a pty can emit between the
    // window closing and the child dying, and send() on destroyed webContents
    // throws.
    if (target.isDestroyed()) return;
    target.send("code:data", chunk);
  });
  session.on("exit", ({ exitCode, signal }) => {
    if (session === codeSession) codeSession = null;
    if (target.isDestroyed()) return;
    target.send("code:exit", { exitCode, signal });
  });

  if (!target.isDestroyed()) {
    target.send("code:started", { cwd, binaryPath, pid: session.pid });
  }
}

/**
 * Build the embedded Code pane. One per app run; the child `claude` process
 * outlives every hide/show, and the pane is only torn down when the window is.
 */
function createCodeView() {
  codeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "code-preload.js"),
      contextIsolation: true,
      // Never true. The page drives xterm.js only; every pty byte crosses the
      // boundary through code-preload.js's contextBridge surface.
      nodeIntegration: false,
      sandbox: false,
      // Chromium throttles timers in views it considers backgrounded. A hidden
      // terminal that stops draining its pty and then dumps a wall of buffered
      // output on re-show reads as a hang, so opt out.
      backgroundThrottling: false,
      // Tells code-preload.js it is embedded rather than standing alone, which
      // is how it knows not to draw a second title bar underneath the main
      // window's. additionalArguments rather than a query string because it is
      // readable at preload start, before the page's first script runs.
      additionalArguments: ["--bc-embedded"],
    },
  });

  // Matches the default theme's --bc-bg so the pane doesn't flash white before
  // the theme stylesheet lands. Live theming then paints over it.
  codeView.setBackgroundColor("#14101f");
  codeView.webContents.loadFile(path.join(__dirname, "code-window.html"));

  if (process.env.BC_DEBUG_CONSOLE) {
    codeView.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      console.log(`[code-renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    codeView.webContents.on("preload-error", (_e, preloadPath, error) => {
      console.error(`[code-preload-error] ${preloadPath}`, error);
    });
  }

  // A CLI session can print links (docs URLs, MCP consent pages). Open those in
  // the real browser; never navigate this view away from its own local page.
  codeView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  return codeView;
}

/** Apply the current bounds, clamped to the window so the pane can't overhang. */
function layoutCodeView() {
  if (!codeView || !mainWindow || mainWindow.isDestroyed()) return;
  const { width, height } = mainWindow.getContentBounds();
  const x = Math.max(0, Math.min(codeViewBounds.x, width));
  const y = Math.max(0, Math.min(codeViewBounds.y, height));
  codeView.setBounds({
    x,
    y,
    width: Math.max(0, width - x),
    height: Math.max(0, height - y),
  });
}

/**
 * Show or hide the pane.
 *
 * Hiding detaches the view from the window's hierarchy rather than destroying
 * it. `removeChildView` unparents; it does not close the webContents — so the
 * terminal, its scrollback, and the running `claude` child all survive being
 * hidden, and switching back is instant rather than a fresh session. That is
 * also what makes the pane immune to claude.ai reloading itself next door.
 */
function setCodeViewShown(shown) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (shown === codeViewShown) return;
  if (!codeView) createCodeView();

  if (shown) {
    if (!codeViewSuspended) {
      mainWindow.contentView.addChildView(codeView);
      layoutCodeView();
      codeView.webContents.focus();
    }
  } else {
    mainWindow.contentView.removeChildView(codeView);
    // Focus has to go somewhere deliberate. Left alone it stays with the
    // detached view, and the user's next keystroke lands in a terminal they
    // can no longer see.
    mainWindow.webContents.focus();
  }
  codeViewShown = shown;
  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("code-tab:state", { shown });
  }
}

/**
 * Detach or re-attach the pane without changing whether the tab is "open".
 *
 * removeChildView unparents; it does not close the webContents. The pty, the
 * scrollback and the running `claude` child are all unaffected, which is why
 * this is usable as a transient guard rather than a teardown.
 */
function setCodeViewSuspended(suspended) {
  if (suspended === codeViewSuspended) return;
  codeViewSuspended = suspended;
  if (!codeView || !codeViewShown) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (suspended) {
    mainWindow.contentView.removeChildView(codeView);
    // Focus follows the pane out of the way, or the user's typing goes to a
    // terminal that is no longer on screen while they look at a settings panel.
    mainWindow.webContents.focus();
  } else {
    mainWindow.contentView.addChildView(codeView);
    layoutCodeView();
  }
}


/**
 * The ONE way to bring the main window back, used by every affordance that
 * can be asked to do so: the macOS Dock icon (`activate`), the tray menu, a
 * click on the buddy, the global accelerators, and openCodeWindow below.
 *
 * Each of those used to do its own thing, and the differences were the bug.
 * Two failure modes, both of which stranded the user with a running app they
 * could not get back to:
 *
 *   1. `show()` does NOT restore a MINIMIZED window on macOS — `restore()`
 *      does. `app.on("activate")` called only `show()`, so the sequence
 *      "minimise the window, then click the Dock icon" left the window
 *      minimised with no feedback whatsoever. The Dock icon appeared dead,
 *      and the tray and the buddy were genuinely the only remaining ways in.
 *      That is exactly the reported symptom.
 *   2. `activate` guarded with `getAllWindows().length === 0` before falling
 *      through to `mainWindow.show()`. The buddy overlay is a real
 *      BrowserWindow, so with the buddy enabled that count is never 0 — a
 *      destroyed or not-yet-created mainWindow took the `else` branch and
 *      threw a TypeError inside the event handler instead of reopening.
 *
 * Both are fixed by construction here: existence is checked on the window
 * itself rather than inferred from a window count, and restore-then-show-then
 * -focus is the single ordering everyone gets.
 */
function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return mainWindow;
  }
  // macOS only, and normally a no-op: nothing in BetterClaude hides the Dock
  // icon today, but if any future accessory-mode path ever does, a window with
  // no Dock icon and no way to raise it is unrecoverable. Cheap insurance.
  if (process.platform === "darwin" && app.dock && !app.dock.isVisible()) app.dock.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // Raise the whole app, not just the window. A hidden app (Cmd-H, or our own
  // close-to-tray path) keeps its windows "visible" as far as show() is
  // concerned, so without this the window can be re-shown behind whatever the
  // user is looking at and still read as "nothing happened".
  if (process.platform === "darwin") app.focus({ steal: true });
  return mainWindow;
}

/**
 * The single entry point every launch affordance (tray, menu, accelerator,
 * --code, the in-page pill) goes through. Focuses the existing session rather
 * than starting a second one.
 */
function openCodeWindow(requestedCwd) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  revealMainWindow();

  const firstRun = !codeView;
  setCodeViewShown(true);
  // The pending cwd is read back by the `code:ready` handler once the renderer
  // has measured its real terminal size, so the very first pty is created at
  // the right dimensions instead of being spawned at a guess.
  if (firstRun) codePendingCwd = resolveCodeCwd(requestedCwd);
  // Keep the in-page pill in step when something other than the pill opened the
  // pane (menu, tray, accelerator, --code).
  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("code-tab:state", { shown: true });
  }
  return codeView;
}

/**
 * Asks for a folder, then opens the Code pane there. Separate from
 * openCodeWindow so the plain "Open Claude Code" path never blocks on a dialog.
 * Reads a directory path only — nothing inside it is opened or inspected; it is
 * handed to the pty as its cwd.
 */
async function openCodeWindowInFolder() {
  const result = await dialog.showOpenDialog({
    title: "Open Claude Code in Folder",
    defaultPath: resolveCodeCwd(),
    buttonLabel: "Open",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const picked = result.filePaths[0];

  const hadSession = !!codeView;
  openCodeWindow(picked);
  // An already-running session is pinned to the cwd its child was spawned in; a
  // pty's working directory can't be changed after the fact. Restarting in the
  // new folder is the honest way to honour the request, and it only ever
  // discards a session the user explicitly redirected.
  if (hadSession) {
    codeView.webContents.send("code:restarting", { cwd: picked });
    startCodeSession({
      cwd: picked,
      cols: codeLastTerm.cols || CODE_DEFAULT_COLS,
      rows: codeLastTerm.rows || CODE_DEFAULT_ROWS,
    });
  }
  return codeView;
}

/** True when `sender` is the embedded pane's own webContents. */
function isCodeSender(sender) {
  return !!(codeView && !codeView.webContents.isDestroyed() && sender === codeView.webContents);
}

// Renderer reports the terminal's measured size once xterm has laid out, which
// is when the first pty can be created at the correct dimensions.
ipcMain.on("code:ready", (e, { cols, rows }) => {
  if (!isCodeSender(e.sender)) return;
  const cwd = resolveCodeCwd(codePendingCwd);
  codePendingCwd = null;
  codeLastTerm = { cols, rows };
  startCodeSession({ cwd, cols, rows });
});

// The user's own keystrokes, forwarded verbatim. This is the ONLY path into the
// child's stdin, and it never synthesises, replays, or rewrites input.
ipcMain.on("code:input", (e, data) => {
  if (!codeSession) return;
  if (!isCodeSender(e.sender)) return;
  if (typeof data !== "string") return;
  codeSession.write(data);
});

ipcMain.on("code:resize", (e, { cols, rows }) => {
  if (!isCodeSender(e.sender)) return;
  // Validate incoming dimensions to avoid NaN or non-numeric payloads reaching
  // the pty. Recorded even when there is no live session, so a restart after an
  // exit reuses the size the pane is actually drawn at.
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
  codeLastTerm = { cols, rows };
  if (codeSession) codeSession.resize(cols, rows);
});

// Restart after the child exits, so a finished or crashed session doesn't leave
// a dead pane the user has to close and reopen.
ipcMain.on("code:restart", (e, { cols, rows }) => {
  if (!isCodeSender(e.sender)) return;
  startCodeSession({ cwd: resolveCodeCwd(), cols, rows });
});

// --- In-window tab plumbing (sender: the claude.ai renderer) ---

/** Only the main window may drive the tab. */
function isMainSender(sender) {
  return !!(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents);
}

ipcMain.handle("code-tab:show", (e) => {
  if (!isMainSender(e.sender)) return false;
  openCodeWindow();
  return true;
});

ipcMain.handle("code-tab:hide", (e) => {
  if (!isMainSender(e.sender)) return false;
  setCodeViewShown(false);
  return true;
});

ipcMain.on("code-tab:suspend", (e, suspended) => {
  if (!isMainSender(e.sender)) return;
  setCodeViewSuspended(!!suspended);
});

ipcMain.handle("code-tab:get-state", (e) => {
  if (!isMainSender(e.sender)) return { shown: false };
  return { shown: codeViewShown };
});

/**
 * The renderer's measurement of claude.ai's own content area.
 *
 * Trusted for geometry only, and clamped in layoutCodeView() — a bad number
 * can misplace the pane, never escape the window.
 */
ipcMain.on("code-tab:layout", (e, rect) => {
  if (!isMainSender(e.sender)) return;
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return;
  codeViewBounds = { ...codeViewBounds, x: rect.x, y: rect.y };
  if (codeViewShown) layoutCodeView();
});

ipcMain.handle("code:pick-folder", () => openCodeWindowInFolder());

// Window controls the Code pane may ask for.
//
// These existed because the pane used to be its own BrowserWindow wearing the
// shared title bar, and `BrowserWindow.fromWebContents(e.sender)` found that
// window. It no longer does: a WebContentsView's webContents has no
// BrowserWindow of its own, so the old lookup returned null and every one of
// these silently did nothing. They now act on the window the pane is embedded
// in, and "close" means "close the tab", not "quit the app" — a Code pane that
// could close the whole claude.ai window would be a nasty surprise.
//
// Embedded panes don't mount a title bar at all (see electron/code-preload.js),
// so in practice nothing calls minimize/maximize today. Kept, correct, and
// sender-scoped rather than deleted, because the pane can still be run
// stand-alone for debugging.
ipcMain.handle("code:window-minimize", (e) => {
  if (!isCodeSender(e.sender) || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.minimize();
});
ipcMain.handle("code:window-maximize-toggle", (e) => {
  if (!isCodeSender(e.sender) || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("code:window-close", (e) => {
  if (!isCodeSender(e.sender)) return;
  setCodeViewShown(false);
});

/**
 * Survive claude.ai reloading itself.
 *
 * claude.ai periodically ships a new build and asks the user to refresh, and
 * its service worker can reload the shell on its own. Either way the page we
 * inject into is replaced underneath us.
 *
 * THE RELOAD IS NEVER INTERCEPTED. Nothing here calls preventDefault on a
 * navigation, delays one, or rewrites a URL. Anthropic's reload is Anthropic's
 * to perform; a wrapper that swallowed it would pin the user to a stale build
 * with no way to tell. Everything below is after-the-fact recovery.
 *
 * Most of the work is already done for us: a full reload re-runs the preload,
 * which re-applies the whole injection framework from scratch. This exists for
 * the three cases where that is not true —
 *
 *   1. `did-navigate-in-page` — a same-document navigation, no preload re-run.
 *      core/claude-dom.js's route watcher normally catches these from inside
 *      the page; this is the belt to that suspenders, and it also covers a
 *      navigation that happens before the watcher has mounted.
 *   2. `render-process-gone` — the page came back, but nothing in the old realm
 *      survived and any state main.js was mirroring is now stale.
 *   3. The embedded Code pane, which is NOT part of the reloaded page. It is a
 *      sibling WebContentsView, so its terminal, scrollback and child `claude`
 *      process all live straight through the reload — but the view's stacking
 *      order relative to a freshly-created page needs re-asserting, and the new
 *      renderer has no idea the pane is open until it is told.
 *
 * Explicitly NOT related to BetterClaude's own electron-updater flow (see
 * setupAutoUpdater). The two are kept apart in the code and in every log line
 * so nobody has to work out which "update" they are looking at.
 */
function attachClaudeReloadRecovery(win) {
  const wc = win.webContents;

  const reassert = (reason) => {
    if (!win || win.isDestroyed() || wc.isDestroyed()) return;
    if (codeViewShown && codeView && !codeViewSuspended) {
      // Re-parent so the pane is above the newly-created page rather than
      // behind it. removeChildView does not close the webContents, so the
      // session is untouched by this — see setCodeViewShown.
      win.contentView.removeChildView(codeView);
      win.contentView.addChildView(codeView);
      layoutCodeView();
    }
    wc.send("code-tab:state", { shown: codeViewShown });
    wc.send("betterclaude:reinject", { reason });
  };

  // dom-ready fires once the document exists but before subresources finish,
  // which is the earliest point injection can safely re-apply; did-finish-load
  // is the settled state. Both, because a slow-loading page would otherwise
  // spend seconds with the pane behind it, and a page that never finishes
  // loading would never recover at all.
  wc.on("dom-ready", () => reassert("dom-ready"));
  wc.on("did-finish-load", () => reassert("did-finish-load"));
  wc.on("did-navigate-in-page", (_e, _url, isMainFrame) => {
    if (isMainFrame) reassert("in-page navigation");
  });
  wc.on("render-process-gone", (_e, details) => {
    console.warn(`[BetterClaude] claude.ai renderer gone (${details && details.reason}); injection re-applies on reload`);
  });
  wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which is what a superseded navigation looks like —
    // normal during rapid route changes, not a failure worth reporting.
    if (!isMainFrame || errorCode === -3) return;
    console.warn(`[BetterClaude] claude.ai failed to load (${errorCode} ${errorDescription}) ${validatedURL}`);
  });
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

  attachClaudeReloadRecovery(mainWindow);

  mainWindow.on("close", (e) => {
    if (!isQuitting && process.platform === "darwin") {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // The overlay is a real BrowserWindow, so on Windows/Linux it would keep the
  // app alive after the main window closed — `window-all-closed` never fires
  // while any window is left. Tear it down here so quitting still quits.
  // (On macOS the close above is prevented and the app lives in the tray, so
  // the buddy should stay exactly where it is.)
  mainWindow.on("closed", () => {
    if (process.platform !== "darwin") destroyBuddyWindow();
    // The pane lives inside this window, so its webContents dies with it.
    // Acceptance criterion inherited from the standalone window: closing must
    // leave no orphaned `claude`.
    disposeCodeSession();
    codeView = null;
    codeViewShown = false;
  });

  // Same guarantee one beat earlier. "closed" is too late to be the only hook
  // on Windows/Linux, where the app may quit immediately after — kill the child
  // as the window starts closing and again once it is gone.
  mainWindow.on("close", () => {
    if (isQuitting || process.platform !== "darwin") disposeCodeSession();
  });

  // The pane is positioned in window coordinates, so it has to follow the
  // window. `resize` covers drags and maximise; `enter-full-screen` and its
  // partner fire without a resize event on macOS, where the window keeps its
  // size and only the content bounds change.
  const relayoutCodeView = () => { if (codeViewShown) layoutCodeView(); };
  mainWindow.on("resize", relayoutCodeView);
  mainWindow.on("enter-full-screen", relayoutCodeView);
  mainWindow.on("leave-full-screen", relayoutCodeView);

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
  // Full-color logo mark, not a template image -- template mode would strip
  // the color and render only the alpha silhouette.
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("BetterClaude");

  const updateMenu = () => {
    const alwaysOnTop = mainWindow ? mainWindow.isAlwaysOnTop() : false;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: mainWindow && mainWindow.isVisible() ? "Hide" : "Show",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
            else revealMainWindow();
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
          label: "Open Claude Code",
          click: () => openCodeWindow(),
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
          // Whichever BetterClaude window has focus — both the claude.ai
          // preload and the Code window's preload listen for this.
          click: (_item, focusedWindow) => {
            const target = focusedWindow || mainWindow;
            if (target && !target.isDestroyed()) target.webContents.send("betterclaude:toggle-settings");
          },
        },
        { type: "separator" },
        {
          label: "Open Claude Code",
          accelerator: store.get("keyboardShortcuts.openCodeWindow"),
          click: () => openCodeWindow(),
        },
        {
          label: "Open Claude Code in Folder…",
          click: () => openCodeWindowInFolder(),
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
        {
          // The recovery path for a user stuck on a stale claude.ai layout.
          //
          // Why forceReload above is not already enough: it bypasses the HTTP
          // cache, but claude.ai is a PWA and registers a service worker. A
          // service worker sits in front of the network and can keep serving a
          // cached app shell across any number of reloads, cache-busting
          // headers included — so "I reloaded and it's still the old UI" is a
          // real state that forceReload cannot get you out of.
          // clearStorageData with these quotas removes the worker and its
          // Cache Storage entries as well as the HTTP cache.
          //
          // Deliberately NOT cleared: cookies, localstorage, indexdb. Those
          // hold the claude.ai session, and silently signing the user out
          // would be a worse outcome than the stale layout it fixes — this
          // needs to stay a safe thing to click when confused.
          label: "Clear Cache and Reload",
          click: async () => {
            if (!mainWindow) return;
            const windowSession = mainWindow.webContents.session;
            try {
              await windowSession.clearCache();
              await windowSession.clearStorageData({
                storages: ["serviceworkers", "cachestorage", "shadercache"],
              });
            } catch (err) {
              // Still reload on failure: a partial clear plus a
              // cache-ignoring reload is strictly better than doing nothing,
              // and this is a manual recovery action the user is watching.
              console.error("[BetterClaude] clear-cache failed; reloading anyway", err);
            }
            mainWindow.webContents.reloadIgnoringCache();
          },
        },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "BetterClaude on GitHub",
          click: () => shell.openExternal(GITHUB_URL),
        },
        {
          label: "Release Notes",
          click: () => shell.openExternal(RELEASES_URL),
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
  // Live-apply the buddy toggles. Skipped for `buddies.position`, which this
  // handler never sets (the drag path writes it directly) — syncing on it
  // would be a no-op anyway, but the guard keeps intent obvious.
  if (keyPath.startsWith("buddies.") && keyPath !== "buddies.position") syncBuddyWindow();
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

// NOTE: there is deliberately no standalone "appearance:begin-custom" channel.
// One existed, went unused by every renderer, and was strictly worse than the
// transaction below: calling it as a separate round-trip is precisely the
// begin-then-write race that combining the two into one handler exists to
// prevent. Snapshotting is a step of a cosmetic write, not something a caller
// should be able to do on its own.
//
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
        // Global accelerator: the window may well be minimised or the app
        // hidden when this fires, which is precisely the case a bare show()
        // does not handle. Same reveal path as everything else.
        const win = revealMainWindow();
        if (win) win.webContents.send("betterclaude:trigger-prompt", p.id);
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
    updateStatus = {
      state: "error",
      error: "Updates only check in packaged builds, not `npm start`.",
      releasesUrl: RELEASES_URL,
    };
    broadcastUpdateStatus();
    return updateStatus;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // Network down, rate-limited, no published release yet, or no
    // app-update.yml in the bundle — all land here. Carrying releasesUrl
    // lets the UI offer a manual download rather than dead-ending.
    updateStatus = { state: "error", error: err.message, releasesUrl: RELEASES_URL };
    broadcastUpdateStatus();
  }
  return updateStatus;
}

ipcMain.handle("updater:check", () => checkForUpdates());

// Version is read from package.json by Electron itself, so this stays the
// one source of truth for every place the UI prints it.
ipcMain.handle("app:get-info", () => ({
  version: app.getVersion(),
  isPackaged: app.isPackaged,
  githubUrl: GITHUB_URL,
  releasesUrl: RELEASES_URL,
}));

ipcMain.handle("updater:open-releases", () => shell.openExternal(RELEASES_URL));

// "Later" on the banner suppresses THIS version only — the next release
// surfaces again (see core/settings-schema.js's updates.dismissedVersion).
ipcMain.handle("updater:dismiss", (_e, version) => {
  store.set("updates.dismissedVersion", version || null);
  broadcastSettings();
});

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
  // Give the Dock the real BetterClaude mark. Packaged builds get this from
  // build/icon.icns via electron-builder, but an unpackaged `npm start` runs
  // out of node_modules/electron and would otherwise sit in the Dock as the
  // generic Electron atom — indistinguishable from any other dev Electron app
  // on the machine, which is its own "I can't find my window" problem.
  if (process.platform === "darwin" && app.dock) {
    const dockIcon = nativeImage.createFromPath(APP_ICON_PATH);
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }
  seedBuiltinPlugins();
  // Before any window opens, so the first paint already uses the current
  // scaffold rather than flashing a stale custom theme (see the function's
  // comment for why a frozen customThemeCSS is a silent-failure trap).
  refreshCustomThemeScaffold();
  createWindow();
  // `--code` opens straight into a coding session, for anyone whose usual entry
  // point is the CLI rather than the chat UI. Now that the pane is a child of
  // the main window it has to wait for that window's first paint — opening it
  // against a window still loading claude.ai leaves the pane correctly placed
  // but sized against content bounds that are about to change.
  if (process.argv.includes("--code")) {
    mainWindow.once("ready-to-show", () => openCodeWindow());
  }
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
  syncBuddyWindow();
  // A display change can strand a parked buddy on a monitor that no longer
  // exists, so re-resolve its position against the displays that remain.
  const reseatBuddy = () => {
    if (!buddyWindow || buddyWindow.isDestroyed()) return;
    const { x, y } = resolveBuddyPosition();
    buddyWindow.setPosition(x, y);
    store.set("buddies.position", { x, y });
  };
  screen.on("display-removed", reseatBuddy);
  screen.on("display-added", reseatBuddy);
  screen.on("display-metrics-changed", reseatBuddy);
  analyticsDbReady = analyticsDb.initAnalyticsDb(app.getPath("userData")).catch((err) => {
    console.error("[BetterClaude] analytics DB init failed", err);
    return null;
  });
  startTeamSync();
  // Background check shortly after launch; silent (no native OS dialog) —
  // the renderer surfaces it via betterclaude:update-status instead so it
  // can be dismissed/actioned inside our own UI. Delayed so it never
  // competes with first paint. Opt-out via Settings -> Appearance ->
  // Updates; "Check now" there stays available either way.
  setTimeout(() => {
    if (store.get("updates.autoCheck") === false) return;
    checkForUpdates();
  }, 5000);
  // BetterClaude is a menu-bar/dock-resident app people leave running for
  // days — a launch-time-only check means anything released after that first
  // 5s window is silently missed until the next full quit+relaunch. Re-check
  // periodically on the same opt-out. Skips while a check is already in
  // flight or the banner already has something for the user to act on
  // (available/downloading/downloaded), so this never re-triggers
  // "checking" and makes an already-showing banner flicker.
  const UPDATE_RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
  setInterval(() => {
    if (store.get("updates.autoCheck") === false) return;
    if (["checking", "available", "downloading", "downloaded"].includes(updateStatus.state)) return;
    checkForUpdates();
  }, UPDATE_RECHECK_INTERVAL_MS);

  nativeTheme.on("updated", () => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send("betterclaude:os-theme-changed", { isDark: nativeTheme.shouldUseDarkColors })
    );
  });

  // Dock-icon click / Cmd-Tab back into the app. See revealMainWindow for why
  // this must not be a bare show(), and must not gate on a window count.
  app.on("activate", () => {
    revealMainWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  destroyBuddyWindow();
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
