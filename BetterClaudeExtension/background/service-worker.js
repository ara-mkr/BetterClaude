/**
 * MV3 service worker — the extension's analog of electron/main.js +
 * electron/preload.js's ipcRenderer bridge. Content scripts talk to this via
 * chrome.runtime.sendMessage({type, payload}); this replies with the result
 * or throws (surfaced back as a rejected promise on the content-script
 * side — see content/bridge.js's callBackground()).
 *
 * Reuses the exact same platform-agnostic modules the Electron app does
 * (core/settings-schema, core/theme-engine, core/clipboard-bridge) — bundled
 * in by esbuild (build.js), not copied by hand.
 *
 * Dropped entirely vs. the Electron app, because there is no MV3 equivalent:
 *   - window:* (frameless window chrome) and updater:* — there is no
 *     BrowserWindow and the Chrome Web Store handles updates itself.
 *   - Native filesystem plugins/themes — service workers have no filesystem
 *     access at all; plugins here are the same built-in set bundled at
 *     build time (dist/plugins/*.bundle.js), toggled on/off, not arbitrary
 *     user-authored code (running unsandboxed eval'd JS would violate both
 *     claude.ai's CSP and the extension's own, exactly the reason Electron
 *     used require() over eval — there is no require() equivalent here).
 * Adapted with a real (not faked) substitute:
 *   - Team Sync: GitHub REST API file fetch instead of `git` shell-out
 *     (background/team-sync.js) — GitHub repos only, not arbitrary git
 *     remotes.
 *   - Usage Analytics: chrome.storage.local as a flat event log instead of
 *     a WASM SQLite file — this app's own comment on the Electron version
 *     already calls the corpus "personal-scale", which a plain array easily
 *     covers without pulling sql.js's WASM binary into a service worker that
 *     Chrome can terminate and restart at any time.
 *   - Skill "install": downloads the repo's zip via chrome.downloads instead
 *     of unzipping to a userData folder (no fs to unzip into) — the user
 *     still uploads the SKILL.md to claude.ai's own Capabilities UI
 *     themselves either way, exactly as the Electron version's own README
 *     already says is required.
 *   - Global shortcuts: chrome.commands (manifest.json) instead of
 *     Electron's globalShortcut — Chrome only allows a small, *statically
 *     declared* set of commands (see manifest.json), not arbitrary
 *     per-prompt/per-macro dynamic bindings.
 *   - Polling intervals: chrome.alarms instead of setInterval, because MV3
 *     service workers are terminated when idle and setInterval timers do not
 *     survive that. chrome.alarms has a practical 1-minute floor, so a couple
 *     of features that polled sub-minute on desktop (Clipboard Bridge's
 *     default 5s) are clamped to 1 minute here — a real responsiveness
 *     trade-off, not a bug.
 */

const { mergeDefaults, DEFAULT_SETTINGS } = require("../../core/settings-schema");
const { buildThemeCSSFromVars } = require("../../core/theme-engine");
const { deriveChannelId, encryptText, decryptText } = require("../../core/clipboard-bridge");
const teamSync = require("./team-sync");

const CLAUDE_MATCH = "https://claude.ai/*";

// --- Settings store (chrome.storage.local, mirrors electron-store) ---
async function getStoredSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return mergeDefaults(settings || {});
}

async function setStoredSettings(next) {
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function setSettingPath(keyPath, value) {
  const current = await getStoredSettings();
  const parts = keyPath.split(".");
  let node = current;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
  const merged = mergeDefaults(current);
  await setStoredSettings(merged);
  return merged;
}

async function broadcastToClaudeTabs(type, payload) {
  const tabs = await chrome.tabs.query({ url: CLAUDE_MATCH });
  tabs.forEach((tab) => chrome.tabs.sendMessage(tab.id, { type, payload }).catch(() => {}));
}

async function broadcastSettings() {
  const updated = await getStoredSettings();
  await broadcastToClaudeTabs("betterclaude:settings-changed", updated);
  return updated;
}

// MV3 can dispatch multiple messages while an earlier chrome.storage write is
// awaiting completion. Serialize appearance transitions so a slider update
// can never overwrite a preset reset (or a neighboring slider update).
let appearanceTransaction = Promise.resolve();
function enqueueAppearance(work) {
  const next = appearanceTransaction.then(work, work);
  appearanceTransaction = next.catch(() => {});
  return next;
}

function isCosmeticPath(keyPath) {
  return /^(appearance\.(accentColor|colorBlindSafe|contrastBoost|glassPanels)|appearanceEditor\.|background\.|customCSS\.|fonts\.|layout\.|cursor\.|motion\.)/.test(keyPath);
}

async function beginCustomAppearance(current) {
  if (current.appearance.activeTheme === "custom") return current;
  const themes = await getAllThemes();
  const base = current.appearance.activeTheme;
  if (!themes[base]) return current;
  current.appearance.customThemeBase = base;
  current.appearance.customThemeCSS = themes[base];
  current.appearance.activeTheme = "custom";
  return current;
}

async function selectTheme(themeId) {
  const themes = await getAllThemes();
  if (!themes[themeId]) throw new Error("Unknown theme");
  const current = await getStoredSettings();
  const defaults = mergeDefaults({});
  const next = {
    ...current,
    appearance: { ...current.appearance, activeTheme: themeId, customThemeBase: null, customThemeCSS: "", accentColor: defaults.appearance.accentColor, colorBlindSafe: defaults.appearance.colorBlindSafe, contrastBoost: defaults.appearance.contrastBoost, glassPanels: defaults.appearance.glassPanels, schedule: defaults.appearance.schedule, weatherTheme: defaults.appearance.weatherTheme },
    appearanceEditor: defaults.appearanceEditor, background: defaults.background, customCSS: defaults.customCSS,
    fonts: defaults.fonts, layout: defaults.layout, cursor: defaults.cursor, motion: defaults.motion,
  };
  await setStoredSettings(next);
  return broadcastSettings();
}

// --- Themes: bundled presets (dist/themes/*.css, fetched as extension
// resources) layered with user-saved themes (chrome.storage.local, since
// there is no themes folder to write .css files into). ---
async function fetchBundledThemes() {
  const url = chrome.runtime.getURL("dist/themes/");
  // No directory listing API for extension resources — build.js instead
  // emits a manifest.json alongside the copied CSS files at build time.
  const manifestUrl = chrome.runtime.getURL("dist/themes/_manifest.json");
  const res = await fetch(manifestUrl);
  const files = res.ok ? await res.json() : [];
  const entries = await Promise.all(
    files.map(async (id) => [id, await (await fetch(chrome.runtime.getURL(`dist/themes/${id}.css`))).text()])
  );
  return Object.fromEntries(entries);
}

async function getAllThemes() {
  const bundled = await fetchBundledThemes();
  const { userThemes } = await chrome.storage.local.get("userThemes");
  return { ...bundled, ...(userThemes || {}) };
}

async function saveUserTheme({ name, cssText }) {
  const id = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || `theme-${Date.now()}`;
  const { userThemes } = await chrome.storage.local.get("userThemes");
  const next = { ...(userThemes || {}), [id]: cssText };
  await chrome.storage.local.set({ userThemes: next });
  return { id, name, themes: await getAllThemes() };
}

async function deleteUserTheme(id) {
  const { userThemes } = await chrome.storage.local.get("userThemes");
  const next = { ...(userThemes || {}) };
  delete next[id];
  await chrome.storage.local.set({ userThemes: next });
  return getAllThemes();
}

function extractThemeName(cssText, fallback) {
  const m = /\/\*\s*BetterClaude(?: preset)? theme:\s*(.+?)\s*\*\//.exec(cssText || "");
  return (m && m[1]) || fallback;
}

async function importThemeFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch theme (HTTP ${res.status})`);
  const text = await res.text();
  const isJSON = /\.json(\?|$)/i.test(url) || (res.headers.get("content-type") || "").includes("json");
  if (isJSON) {
    const parsed = JSON.parse(text);
    const name = parsed.name || url;
    return saveUserTheme({ name, cssText: buildThemeCSSFromVars(parsed.vars || parsed.colors || {}, name) });
  }
  return saveUserTheme({ name: extractThemeName(text, url), cssText: text });
}

// --- Skill Marketplace (GitHub Search API; unchanged shape vs. Electron) ---
function slugifySkillId(owner, repo) {
  return `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-");
}

async function githubHeaders() {
  const settings = await getStoredSettings();
  const token = settings.skillMarketplace && settings.skillMarketplace.githubToken;
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubFetch(url, extraHeaders = {}) {
  const headers = { ...(await githubHeaders()), ...extraHeaders };
  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      throw new Error("GitHub API rate limit hit. Add a personal access token in Settings -> Skill Marketplace for a higher limit.");
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
  const res = await githubFetch(`https://api.github.com/search/repositories?q=${q}&sort=${validSort}&order=desc&per_page=50`);
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

async function installSkill({ owner, repo, defaultBranch }) {
  const branch = defaultBranch || "main";
  const id = slugifySkillId(owner, repo);
  const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
  // No filesystem to unzip into from a service worker — download the repo
  // archive itself via chrome.downloads so the user can pull SKILL.md out
  // and upload it to claude.ai's Settings -> Capabilities themselves,
  // same manual final step the Electron app already required.
  const downloadId = await chrome.downloads.download({ url: zipUrl, filename: `betterclaude-skills/${id}.zip`, saveAs: false });
  let commitSha = null;
  try {
    const branchRes = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
    commitSha = ((await branchRes.json()).commit || {}).sha || null;
  } catch (_e) { /* non-fatal */ }
  const record = { owner, repo, branch, commitSha, installedAt: Date.now(), downloadId };
  const settings = await getStoredSettings();
  await setSettingPath(`skillMarketplace.installed.${id}`, record);
  return { id, ...record };
}

// --- Team Sync (GitHub-API based; see background/team-sync.js) ---
async function runTeamSync() {
  const settings = await getStoredSettings();
  const cfg = settings.teamSync;
  if (!cfg || !cfg.enabled || !cfg.repoUrl) return { skipped: true };
  const parsed = teamSync.parseGithubRepoUrl(cfg.repoUrl);
  if (!parsed) throw new Error("Team Sync (extension build) only supports github.com repo URLs.");

  const settingsGh = await githubHeaders();
  const token = settingsGh.Authorization ? settingsGh.Authorization.replace("Bearer ", "") : undefined;
  const files = await teamSync.listMatchingFiles({ ...parsed, branch: cfg.branch, token });

  const manifest = { ...cfg.manifest };
  const { userThemes } = await chrome.storage.local.get("userThemes");
  const localThemes = userThemes || {};
  const { customPluginState } = await chrome.storage.local.get("customPluginState");
  const localPluginState = customPluginState || {};

  const appliedPluginIds = [];
  const appliedThemeIds = [];
  const conflicts = [];
  const pendingUpdates = [];

  for (const file of files) {
    const isPlugin = file.filename.endsWith(".claudeplugin.js");
    const kind = isPlugin ? "plugin" : "theme";
    const localId = file.filename.replace(/\.claudeplugin\.js$/, "").replace(/\.css$/, "");
    const localContent = isPlugin ? (localPluginState[localId] && localPluginState[localId].source) : localThemes[localId];
    const repoContent = await teamSync.fetchFileContent({ ...parsed, sha: file.sha });
    const manifestEntry = manifest[file.relPath];
    const result = await teamSync.classify({ repoContent, localContent, manifestHash: manifestEntry ? manifestEntry.hash : null });

    if (result.status === "in-sync") { manifest[file.relPath] = { hash: result.repoHash, kind }; continue; }
    if (result.status === "local-edited") continue;
    if (result.status === "new" || result.status === "update-available") {
      if (cfg.autoApply) {
        if (isPlugin) localPluginState[localId] = { source: repoContent };
        else localThemes[localId] = repoContent;
        manifest[file.relPath] = { hash: result.repoHash, kind };
        (isPlugin ? appliedPluginIds : appliedThemeIds).push(localId);
      } else {
        pendingUpdates.push({ relPath: file.relPath, kind, filename: file.filename });
      }
      continue;
    }
    if (result.status === "conflict") conflicts.push({ relPath: file.relPath, kind, filename: file.filename });
  }

  await chrome.storage.local.set({ userThemes: localThemes, customPluginState: localPluginState });
  await setSettingPath("teamSync.manifest", manifest);
  await setSettingPath("teamSync.conflicts", conflicts);
  await setSettingPath("teamSync.pendingUpdates", pendingUpdates);
  await setSettingPath("teamSync.lastSyncedAt", Date.now());
  await setSettingPath("teamSync.lastSyncError", null);
  await broadcastSettings();
  if (appliedPluginIds.length > 0 || appliedThemeIds.length > 0) {
    await broadcastToClaudeTabs("betterclaude:team-sync-applied", { pluginIds: appliedPluginIds, themeIds: appliedThemeIds });
  }
  return { appliedPluginIds, appliedThemeIds, conflicts, pendingUpdates };
}

// --- Usage Analytics: flat event array in chrome.storage.local ---
// Real SQL queries aren't needed at this app's own stated "personal-scale"
// corpus size — see the file-header comment above for why sql.js's WASM
// binary isn't worth pulling into a service worker Chrome can kill anytime.
const ANALYTICS_KEY = "analyticsEvents";
const ANALYTICS_MAX_EVENTS = 200000; // generous cap; oldest trimmed past this

async function logAnalyticsEvent(event) {
  const { [ANALYTICS_KEY]: events } = await chrome.storage.local.get(ANALYTICS_KEY);
  const next = [...(events || []), event];
  if (next.length > ANALYTICS_MAX_EVENTS) next.splice(0, next.length - ANALYTICS_MAX_EVENTS);
  await chrome.storage.local.set({ [ANALYTICS_KEY]: next });
}

async function queryAnalytics({ from, to }) {
  const { [ANALYTICS_KEY]: events } = await chrome.storage.local.get(ANALYTICS_KEY);
  const rows = (events || []).filter((e) => e.day >= from && e.day <= to);
  const byDay = (filterFn, reduceFn) => {
    const map = new Map();
    rows.filter(filterFn).forEach((r) => map.set(r.day, reduceFn(map.get(r.day), r)));
    return Array.from(map.entries()).sort(([a], [b]) => (a < b ? -1 : 1));
  };
  const messages = rows.filter((r) => r.type === "message");
  const plugins = rows.filter((r) => r.type === "plugin");

  const tokensByDay = byDay((r) => r.type === "message", (acc, r) => (acc || 0) + (r.tokens || 0)).map(([day, tokens]) => ({ day, tokens }));
  const messagesByDay = byDay((r) => r.type === "message", (acc) => (acc || 0) + 1).map(([day, count]) => ({ day, messages: count }));
  const costByDay = byDay((r) => r.type === "message", (acc, r) => (acc || 0) + (r.costUsd || 0)).map(([day, costUsd]) => ({ day, costUsd }));

  const pluginCounts = new Map();
  plugins.forEach((r) => pluginCounts.set(r.pluginId, (pluginCounts.get(r.pluginId) || 0) + 1));
  const topPlugins = Array.from(pluginCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([pluginId, count]) => ({ pluginId, count }));

  const projectStats = new Map();
  messages.forEach((r) => {
    const cur = projectStats.get(r.project) || { messages: 0, tokens: 0 };
    cur.messages += 1;
    cur.tokens += r.tokens || 0;
    projectStats.set(r.project, cur);
  });
  const topProjects = Array.from(projectStats.entries()).sort((a, b) => b[1].messages - a[1].messages).slice(0, 10).map(([project, s]) => ({ project, ...s }));

  const totals = messages.reduce((acc, r) => ({ messages: acc.messages + 1, tokens: acc.tokens + (r.tokens || 0), costUsd: acc.costUsd + (r.costUsd || 0) }), { messages: 0, tokens: 0, costUsd: 0 });

  return { tokensByDay, messagesByDay, costByDay, topPlugins, topProjects, totals };
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportAnalyticsCsv({ from, to }) {
  const { [ANALYTICS_KEY]: events } = await chrome.storage.local.get(ANALYTICS_KEY);
  const rows = (events || []).filter((e) => e.day >= from && e.day <= to).sort((a, b) => a.ts - b.ts);
  const header = "ts,day,type,role,tokens,model,project,pluginId,costUsd";
  const lines = [header, ...rows.map((r) => [r.ts, r.day, r.type, csvEscape(r.role), r.tokens || 0, csvEscape(r.model), csvEscape(r.project), csvEscape(r.pluginId), r.costUsd || 0].join(","))];
  return lines.join("\n");
}

// --- Branching: forked windows -> new tabs (a browser extension has no
// BrowserWindow to tile side-by-side; a second tab is the honest analog). ---
const pendingForks = new Map(); // forkId -> preamble text, in-memory (service worker lifetime — fine, consumed almost immediately)
const branchTabIds = new Map(); // branchId -> tabId

function genId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function openFork({ preambleText, label, forkedFromUrl, forkedAtTurnIndex }) {
  const branchId = genId("br");
  const forkId = genId("fk");
  pendingForks.set(forkId, preambleText || "");
  const tab = await chrome.tabs.create({ url: `https://claude.ai/new#bc-fork=${forkId}` });
  branchTabIds.set(branchId, tab.id);

  const settings = await getStoredSettings();
  const record = { id: branchId, label: label || `Fork @ ${new Date().toLocaleString()}`, createdAt: Date.now(), forkedFromUrl: forkedFromUrl || null, forkedAtTurnIndex: forkedAtTurnIndex != null ? forkedAtTurnIndex : null, conversationUrl: null };
  await setSettingPath("branching.branches", [...(settings.branching.branches || []), record]);
  await broadcastSettings();

  const listener = (tabId, changeInfo) => {
    if (tabId !== tab.id || !changeInfo.url || !/\/chat\//.test(changeInfo.url)) return;
    chrome.tabs.onUpdated.removeListener(listener);
    (async () => {
      const s = await getStoredSettings();
      const branches = s.branching.branches || [];
      const idx = branches.findIndex((b) => b.id === branchId);
      if (idx === -1) return;
      branches[idx] = { ...branches[idx], conversationUrl: changeInfo.url };
      await setSettingPath("branching.branches", branches);
      await broadcastSettings();
    })();
  };
  chrome.tabs.onUpdated.addListener(listener);
  return branchId;
}

// --- Message router ---
const handlers = {
  "settings:get": () => getStoredSettings(),
  "settings:set": async ({ keyPath, value }) => {
    const updated = await setSettingPath(keyPath, value);
    await broadcastSettings();
    return updated;
  },
  "appearance:set-cosmetic": async ({ keyPath, value }) => {
    return enqueueAppearance(async () => {
      const current = await beginCustomAppearance(await getStoredSettings());
      const parts = keyPath.split(".");
      let node = current;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (typeof node[parts[i]] !== "object" || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = value;
      await setStoredSettings(mergeDefaults(current));
      return broadcastSettings();
    });
  },
  "appearance:select-theme": ({ themeId }) => enqueueAppearance(() => selectTheme(themeId)),
  "themes:get-all": () => getAllThemes(),
  "themes:save-user": ({ name, cssText }) => saveUserTheme({ name, cssText }),
  "themes:delete-user": ({ id }) => deleteUserTheme(id),
  "themes:import-url": ({ url }) => importThemeFromUrl(url),
  "weather:get": async ({ lat, lon }) => {
    if (lat == null || lon == null) throw new Error("Missing coordinates");
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current_weather=true`);
    if (!res.ok) throw new Error(`Weather lookup failed (HTTP ${res.status})`);
    const cw = (await res.json()).current_weather || {};
    return { code: cw.weathercode, isDay: cw.is_day === 1 };
  },
  "profiles:apply": async ({ id }) => {
    const current = await getStoredSettings();
    const profile = (current.profiles.list || []).find((p) => p.id === id);
    if (!profile) throw new Error("Profile not found");
    const merged = mergeDefaults({ ...profile.snapshot, profiles: current.profiles });
    await setStoredSettings(merged);
    return broadcastSettings();
  },
  "skills:search": (params) => searchSkillsRemote(params),
  "skills:refresh-cache": async () => {
    const { items } = await searchSkillsRemote({ sort: "stars" });
    await setSettingPath("skillMarketplace.cache", { items, fetchedAt: Date.now() });
    return (await broadcastSettings()).skillMarketplace.cache;
  },
  "skills:get-readme": async ({ owner, repo }) => {
    try {
      const res = await githubFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`, { Accept: "application/vnd.github.raw" });
      return await res.text();
    } catch (err) {
      if (/HTTP 404/.test(err.message)) return null;
      throw err;
    }
  },
  "skills:install": (params) => installSkill(params),
  "skills:uninstall": async ({ id }) => {
    const settings = await getStoredSettings();
    const installed = { ...settings.skillMarketplace.installed };
    delete installed[id];
    await setSettingPath("skillMarketplace.installed", installed);
    return (await broadcastSettings()).skillMarketplace.installed;
  },
  "skills:reveal": async ({ id }) => {
    const settings = await getStoredSettings();
    const record = settings.skillMarketplace.installed[id];
    if (record && record.downloadId != null) chrome.downloads.show(record.downloadId);
    else chrome.downloads.showDefaultFolder();
  },
  "teamSync:sync": async () => {
    try {
      return await runTeamSync();
    } catch (err) {
      await setSettingPath("teamSync.lastSyncError", err.message);
      await broadcastSettings();
      throw err;
    }
  },
  "branching:open-fork": (payload) => openFork(payload || {}),
  "branching:consume-pending-fork": ({ forkId }) => {
    const text = pendingForks.get(forkId) || "";
    pendingForks.delete(forkId);
    return text;
  },
  "branching:open-branch": async ({ branchId }) => {
    const existingTabId = branchTabIds.get(branchId);
    if (existingTabId != null) {
      try {
        await chrome.tabs.update(existingTabId, { active: true });
        return true;
      } catch (_e) { /* tab closed since — fall through to reopen */ }
    }
    const settings = await getStoredSettings();
    const record = (settings.branching.branches || []).find((b) => b.id === branchId);
    if (!record) return false;
    const tab = await chrome.tabs.create({ url: record.conversationUrl || record.forkedFromUrl || "https://claude.ai/new" });
    branchTabIds.set(branchId, tab.id);
    return true;
  },
  "branching:delete-branch": async ({ branchId }) => {
    const tabId = branchTabIds.get(branchId);
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    branchTabIds.delete(branchId);
    const settings = await getStoredSettings();
    const next = (settings.branching.branches || []).filter((b) => b.id !== branchId);
    await setSettingPath("branching.branches", next);
    return (await broadcastSettings()).branching.branches;
  },
  "analytics:log-event": (event) => logAnalyticsEvent(event),
  "analytics:log-plugin-tick": ({ ts, day, pluginIds }) => Promise.all((pluginIds || []).map((pluginId) => logAnalyticsEvent({ ts, day, type: "plugin", pluginId }))),
  "analytics:query": (range) => queryAnalytics(range),
  "analytics:export-csv": (range) => exportAnalyticsCsv(range),
  "analytics:clear": () => chrome.storage.local.set({ [ANALYTICS_KEY]: [] }),
  "notifications:show-native": ({ title, body }) => {
    chrome.notifications.create({ type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title: title || "BetterClaude", body: body || "" });
    return true;
  },
  "clipboardBridge:get-status": async () => (await chrome.storage.local.get("clipboardBridgeStatus")).clipboardBridgeStatus || { state: "idle", lastError: null, lastSyncedAt: null },
  "clipboardBridge:test-connection": async ({ relayUrl }) => {
    if (!relayUrl) throw new Error("Set a relay URL first.");
    const res = await fetch(`${relayUrl.replace(/\/+$/, "")}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  "clipboardBridge:push-text": async ({ text, cfg }) => {
    const channel = await deriveChannelId(cfg.passphrase);
    const { iv, ciphertext } = await encryptText(text, cfg.passphrase);
    const id = genId("c");
    const res = await fetch(`${cfg.relayUrl.replace(/\/+$/, "")}/put`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, id, iv, ciphertext, deviceName: cfg.deviceName || "browser", ts: Date.now(), ttlSeconds: Math.max(30, (cfg.ttlMinutes || 5) * 60) }),
    });
    if (!res.ok) throw new Error(`Relay push failed (HTTP ${res.status})`);
  },
  "clipboardBridge:pull-text": async ({ cfg, afterTs }) => {
    const channel = await deriveChannelId(cfg.passphrase);
    const res = await fetch(`${cfg.relayUrl.replace(/\/+$/, "")}/pull?channel=${encodeURIComponent(channel)}&after=${afterTs || 0}`);
    if (!res.ok) throw new Error(`Relay pull failed (HTTP ${res.status})`);
    const { items } = await res.json();
    const decrypted = [];
    for (const item of items || []) {
      if (item.deviceName === (cfg.deviceName || "browser")) continue;
      try {
        decrypted.push({ text: await decryptText(item, cfg.passphrase), ts: item.ts, deviceName: item.deviceName });
      } catch (_e) { /* wrong passphrase / different room — skip */ }
    }
    return decrypted;
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message && message.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message.payload))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the message channel open for the async response
});

// --- Alarms replace setInterval (service workers don't survive idle) ---
chrome.alarms.create("team-sync", { periodInMinutes: 5 });
chrome.alarms.create("clipboard-bridge", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "team-sync") {
    const settings = await getStoredSettings();
    if (settings.teamSync && settings.teamSync.enabled) {
      runTeamSync().catch((err) => broadcastToClaudeTabs("betterclaude:team-sync-error", err.message));
    }
    return;
  }
  if (alarm.name === "clipboard-bridge") {
    const settings = await getStoredSettings();
    const cfg = settings.clipboardBridge;
    if (!cfg || !cfg.enabled || !cfg.relayUrl || !cfg.passphrase) return;
    const tabs = await chrome.tabs.query({ url: CLAUDE_MATCH, active: true });
    if (tabs.length === 0) return;
    // Delegates the actual clipboard read/write to a focused claude.ai tab
    // (see content/content-script.js's "betterclaude:clipboard-tick"
    // handler) — a service worker has no navigator.clipboard access at all.
    chrome.tabs.sendMessage(tabs[0].id, { type: "betterclaude:clipboard-tick", payload: { cfg } }).catch(() => {});
  }
});
