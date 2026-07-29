/**
 * Preload — the only place besides main.js allowed to touch Node/Electron
 * APIs. It plays the role a background/content-script pair would play in a
 * browser extension: `ipcRenderer.invoke`/`.on` here is the direct analog
 * of `chrome.runtime.sendMessage` / `onMessage`. Everything it hands to the
 * /core and /ui modules is plain data or plain callback functions — those
 * modules never see `ipcRenderer` directly, which is what keeps them
 * portable to a real content script later.
 *
 * Note on contextIsolation: preload runs in its own JS realm but shares the
 * live DOM with the page, so calling document.* here really does mutate
 * what's on screen — no contextBridge round-trip is needed for that part.
 */
const { ipcRenderer } = require("electron");

const { ThemeEngine, resolveScheduledTheme, ensureStyleTag, restoreClaudeColorMode } = require("../core/theme-engine");
const { PluginLoader } = require("../core/plugin-loader");
const { buildExtrasCSS, applyColorBlindSafeVars } = require("../core/extras-css");
const { InteractionFX } = require("../core/interaction-fx");
const { SoundEngine } = require("../core/sound-engine");
const { celebrate, mountParallax, mountSeasonalDecoration, pickLoadingTip } = require("../core/motion-fx");
const { Companion, checkAchievements, incrementStreak, buildGreeting, ACHIEVEMENTS } = require("../core/companion");
const { CommandPalette, mountKonamiListener } = require("../core/command-palette");
const { SkillMarketplaceOverlay } = require("../core/skill-marketplace");
const { PromptPicker } = require("../core/prompt-picker");
const { DiffViewer } = require("../core/diff-viewer");
const { findAndReplaceInComposer, insertFileBlock } = require("../core/file-sync-indicator");
const { AnalyticsDashboard } = require("../core/analytics-dashboard");
const { VIBE_BUNDLES, pickRandomBundle, bundleForMood, bundleForSeason, applyBundle } = require("../core/vibe-bundles");
const { mapWeatherCodeToBundle } = require("../core/weather");
const { shouldSuppress, notificationStyleClass } = require("../core/notifications");
const { insertIntoComposer } = require("../core/compose-insert");

const { mountTitleBar } = require("../ui/title-bar");
const { SettingsPanel, SECTIONS } = require("../ui/settings-panel/panel");
const { mountSnakeGame } = require("../ui/mini-game/snake");

const fs = require("fs");
const path = require("path");

function injectStaticCSS(id, filePath) {
  const tag = document.createElement("style");
  tag.id = id;
  tag.textContent = fs.readFileSync(filePath, "utf8");
  document.head.appendChild(tag);
}

// Plugins are loaded via Node's require() on their on-disk path rather than
// eval/new Function: claude.ai's Content-Security-Policy disallows
// string-to-code generation ("unsafe-eval") for the whole renderer
// (including preload's isolated context), so eval-based loading throws.
// require() goes through Node's own module compiler, which CSP doesn't gate.
function loadPluginModule(absolutePath) {
  delete require.cache[require.resolve(absolutePath)];
  return require(absolutePath);
}

async function bootstrap() {
  await new Promise((resolve) => {
    if (document.readyState !== "loading") resolve();
    else document.addEventListener("DOMContentLoaded", resolve);
  });

  // Required lazily (not at module top-level): @codemirror/view does
  // feature-detection against `document.body` at import time, which is
  // still null before DOMContentLoaded and would crash preload's
  // synchronous top-level requires.
  const cssEditor = require("../build/css-editor.bundle.js");

  // Static chrome stylesheets (not part of the theme system's swappable tags).
  injectStaticCSS("betterclaude-squircle-css", path.join(__dirname, "../ui/squircle.css"));
  injectStaticCSS("betterclaude-titlebar-css", path.join(__dirname, "../ui/title-bar.css"));
  injectStaticCSS("betterclaude-panel-css", path.join(__dirname, "../ui/settings-panel/panel.css"));
  injectStaticCSS("betterclaude-overlays-css", path.join(__dirname, "../ui/overlays.css"));
  injectStaticCSS("betterclaude-skill-marketplace-css", path.join(__dirname, "../ui/skill-marketplace.css"));

  let settings = await ipcRenderer.invoke("settings:get");
  const themes = await ipcRenderer.invoke("themes:get-all");
  let osThemeIsDark = (await ipcRenderer.invoke("system:get-os-theme")).isDark;

  // --- Theme engine ---
  const themeEngine = new ThemeEngine({ presets: themes });

  // --- Customize Everything: cursor/sound/motion/companion/palette engines ---
  const soundEngine = new SoundEngine();
  const companion = new Companion();
  let interactionFX = null; // mounted/unmounted with the general kill-switch
  let stopParallax = null;
  let stopSeasonal = null;
  const commandPalette = new CommandPalette({ onExecute: (cmd) => runCommand(cmd) });
  let stopKonami = null;

  // --- Skill Marketplace ---
  // getCachedItems/getInstalledMap read the local `settings` closure var
  // directly (kept fresh by the betterclaude:settings-changed handler below)
  // instead of round-tripping through IPC for data we already have.
  const skillMarketplace = new SkillMarketplaceOverlay({
    getCachedItems: () => (settings.skillMarketplace.cache && settings.skillMarketplace.cache.items) || [],
    getInstalledMap: () => settings.skillMarketplace.installed || {},
    searchSkills: (params) => ipcRenderer.invoke("skills:search", params),
    getReadme: (params) => ipcRenderer.invoke("skills:get-readme", params),
    installSkill: (item) => ipcRenderer.invoke("skills:install", item),
    revealSkill: (id) => ipcRenderer.invoke("skills:reveal", id),
    notify: (message) => notify(message, { category: "plugin" }),
  });

  // --- Prompt Library ---
  const promptPicker = new PromptPicker({
    getPrompts: () => settings.promptLibrary.prompts || [],
    insertIntoComposer: (text) => insertIntoComposer(text),
    notify: (message) => notify(message, { category: "plugin" }),
  });

  // --- Compare Responses (manual paste) ---
  const diffViewer = new DiffViewer();

  // Declared (not initialized) here, assigned further down once notify
  // are ready — effectiveSoundSettings below can run before that assignment
  // (it's invoked from applyThemeState's very first call), so it needs a
  // `let` it can safely check rather than a `const` it would TDZ-fault on.
  let pluginLoader;

  // Effective (not persisted) sound settings: automations layer temporary
  // behavior (Zen Mode muting, Focus Mode pausing ambient) on top of the
  // user's real saved sound settings, without ever overwriting them.
  function effectiveSoundSettings() {
    const sound = settings.sound;
    const zenActive = !!(settings.focusReading && settings.focusReading.zenMode);
    const focusModeEntry = pluginLoader && pluginLoader.loaded.get("focus-mode");
    const focusActive = !!(focusModeEntry && focusModeEntry.module.active);
    const forcedMute = zenActive && settings.automations.zenMutesSound;
    const forcedAmbientOff = focusActive && settings.automations.focusPausesAmbient;
    return {
      ...sound,
      muted: sound.muted || forcedMute,
      ambient: forcedAmbientOff ? { ...sound.ambient, track: "off" } : sound.ambient,
    };
  }

  function applyExtras() {
    ensureStyleTag("betterclaude-extras").textContent = buildExtrasCSS(settings);
    applyColorBlindSafeVars(!!(settings.appearance && settings.appearance.colorBlindSafe));
    document.documentElement.dataset.bcMood = (settings.personality && settings.personality.mood) || "";
    // Zen Mode = Focus Mode plugin (see syncZenModeWithFocusPlugin) + these
    // two additionally hidden, so only the conversation itself is visible.
    document.body.classList.toggle("bc-zen-mode", !!(settings.focusReading && settings.focusReading.zenMode));

    soundEngine.applySettings({ sound: effectiveSoundSettings() });
    companion.update(settings);

    if (interactionFX) interactionFX.applySettings(settings);

    if (settings.motion && settings.motion.parallax && !stopParallax) {
      stopParallax = mountParallax(() => [document.getElementById("bc-companion")]);
    } else if ((!settings.motion || !settings.motion.parallax) && stopParallax) {
      stopParallax();
      stopParallax = null;
    }

    const wantsSeasonal = !!(settings.motion && settings.motion.seasonalDecorations);
    if (wantsSeasonal && !stopSeasonal) {
      stopSeasonal = mountSeasonalDecoration(new Date().getMonth());
    } else if (!wantsSeasonal && stopSeasonal) {
      stopSeasonal();
      stopSeasonal = null;
    }
  }

  // Optimistic, synchronous full re-render for a Vibe Bundle preview (theme +
  // shape + cursor + motion together). A bundle also changes
  // appearanceEditor.shape and cursor.style/trail, which live in the BASE and
  // EXTRAS style layers (border-radius, cursor CSS/trail) rather than the
  // theme layer that themeEngine.setTheme() alone rebuilds. Those two layers
  // only used to catch up once the async settings:set round trip resolved
  // and the "betterclaude:settings-changed" broadcast re-ran applyThemeState
  // — leaving corners sharp and the cursor on its old style/trail in the
  // meantime, worse if a rapid second click's response resolved first. Patch
  // the local settings snapshot and re-run the real pipeline here instead, so
  // the whole bundle lands in one synchronous paint that already matches what
  // the eventual persisted round trip will produce.
  function applyBundlePreview(bundle) {
    Object.assign(settings.appearance, { activeTheme: bundle.themeId });
    Object.assign(settings.appearanceEditor, { shape: bundle.shape });
    Object.assign(settings.cursor, { style: bundle.cursorStyle, trail: bundle.cursorTrail });
    Object.assign(settings.motion, { easing: bundle.easing, transition: bundle.transition });
    themeEngine.applySettings(settings);
    applyExtras();
  }

  // themeEngine.setAccentColor() writes --bc-accent/--bc-accent-hover/
  // --bc-focus-ring/--bc-border-focus (and possibly other --bc-*-derived
  // vars added later) directly onto document.documentElement.style, i.e.
  // outside the injected <style id="betterclaude-*"> tags that the rest of
  // applyThemeState's disabled-branch already clears. Those inline
  // properties otherwise survive the master toggle (e.g. ui/title-bar.css
  // reading var(--bc-accent, ...) for the traffic-light dots even with
  // BetterClaude fully off). Rather than hardcoding that variable list here
  // (which would silently drift from theme-engine.js's list), just sweep
  // every inline BetterClaude custom property document.documentElement
  // carries (both --bc-* palette tokens and --btn-* state tokens) — robust
  // to that set changing upstream.
  function clearInlineAccentVariables() {
    const style = document.documentElement.style;
    // Snapshot names first: mutating a live CSSStyleDeclaration while
    // iterating it by index can skip entries as indices shift.
    const bcProps = [];
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      if (prop.startsWith("--bc-") || prop.startsWith("--btn-")) bcProps.push(prop);
    }
    bcProps.forEach((prop) => style.removeProperty(prop));
  }

  // Master kill-switch: everything downstream (theme CSS, plugins)
  // only actually gets applied when general.enabled isn't false. This lets
  // Settings -> Appearance fully revert to stock claude.ai without an
  // uninstall, and flip back on just by re-checking the box. The title bar
  // itself stays mounted regardless (it's the only way back into Settings
  // once frame:false has removed the OS chrome).
  function applyThemeState() {
    if (settings.general && settings.general.enabled === false) {
      ["betterclaude-theme", "betterclaude-base", "betterclaude-custom-css", "betterclaude-background", "betterclaude-extras"].forEach((id) => {
        const tag = document.getElementById(id);
        if (tag) tag.textContent = "";
      });
      companion.update({ personality: { companionEnabled: false } });
      if (interactionFX) {
        interactionFX.unmount();
        interactionFX = null;
      }
      if (stopParallax) { stopParallax(); stopParallax = null; }
      if (stopSeasonal) { stopSeasonal(); stopSeasonal = null; }
      soundEngine.applySettings({ sound: { ...settings.sound, muted: true, ambient: { track: "off" } } });
      // Revert claude.ai's own color-mode (dark class / color-scheme) to
      // exactly what it was before BetterClaude ever touched it (§4.1).
      restoreClaudeColorMode();
      // Remove the inline --bc-accent/--bc-accent-hover/--bc-focus-ring/
      // --bc-border-focus (etc.) custom properties setAccentColor() wrote
      // directly onto :root, so no theming remnant (e.g. the title bar's
      // accent-colored traffic-light dots) survives the master toggle.
      clearInlineAccentVariables();
    } else {
      themeEngine.applySettings(settings);
      if (!interactionFX) {
        interactionFX = new InteractionFX({ onRadialAction: (id) => runRadialAction(id) });
        interactionFX.mount(settings);
      }
      applyExtras();
    }
  }

  // Scheduled/automatic theme switching lives on top of applyThemeState
  // rather than inside it: it never touches settings.appearance.activeTheme
  // in storage, so flipping the schedule back to "off" cleanly falls back
  // to whatever the user last picked manually in the Themes tab.
  function applyScheduledTheme() {
    if (settings.general && settings.general.enabled === false) return;
    // A manual cosmetic edit has intentionally created a frozen Custom
    // appearance. Schedules must not paint a different preset over that
    // state while leaving the UI labelled Custom.
    if (settings.appearance && settings.appearance.activeTheme === "custom") return;
    const schedule = settings.appearance && settings.appearance.schedule;
    if (schedule && schedule.mode === "season") {
      const bundle = bundleForSeason(new Date().getMonth());
      if (bundle && themes[bundle.themeId]) themeEngine.setTheme(bundle.themeId);
      return;
    }
    const themeId = resolveScheduledTheme(schedule, { isDarkOS: osThemeIsDark });
    if (themeId && themes[themeId]) themeEngine.setTheme(themeId);
  }

  // Opt-in: fetches current weather (main-process IPC, see electron/main.js)
  // and applies the matched Vibe Bundle. Mutually exclusive in effect with
  // the time/OS/season schedule above — whichever runs most recently wins,
  // same "last write wins" behavior the existing schedule already has.
  async function applyScheduledWeatherTheme() {
    const wt = settings.appearance && settings.appearance.weatherTheme;
    if (settings.appearance && settings.appearance.activeTheme === "custom") return false;
    if (!wt || !wt.enabled || wt.lat == null || wt.lon == null) return false;
    try {
      const { code, isDay } = await ipcRenderer.invoke("weather:get", { lat: wt.lat, lon: wt.lon });
      const bundle = mapWeatherCodeToBundle(code, isDay);
      if (!bundle) return false;
      applyBundle(bundle, { setSetting, selectTheme });
      return true;
    } catch (err) {
      console.error("[BetterClaude] weather theme fetch failed", err);
      return false;
    }
  }

  // Rotates settings.background.mode/color/gradient/imageDataUrl/fit through
  // the saved pool on an interval — same schedule-on-top-of-storage pattern
  // as applyScheduledTheme (never mutates the pool itself).
  let lastRotationAt = Date.now();
  function applyBackgroundRotation() {
    const rotation = settings.background && settings.background.rotation;
    if (!rotation || !rotation.enabled || !rotation.pool || rotation.pool.length === 0) return;
    const intervalMs = Math.max(15, rotation.intervalMinutes || 60) * 60 * 1000;
    const now = Date.now();
    if (now - lastRotationAt < intervalMs) return;
    lastRotationAt = now;
    const currentIndex = rotation.pool.findIndex((snap) => snap.mode === settings.background.mode
      && snap.color === settings.background.color && snap.gradient === settings.background.gradient);
    const next = rotation.pool[(currentIndex + 1 + rotation.pool.length) % rotation.pool.length];
    Object.entries(next).forEach(([key, value]) => setSetting(`background.${key}`, value));
  }

  async function applyPluginState() {
    const sources = await ipcRenderer.invoke("plugins:list-sources");
    if (settings.general && settings.general.enabled === false) {
      pluginLoader.list().forEach((p) => pluginLoader.unload(p.id));
      return;
    }
    sources.forEach(({ id, path: pluginPath }) => {
      // Focus Mode has no shipped product surface yet. Do not resurrect its
      // launcher from an older persisted `true` value.
      if (id === "focus-mode") {
        if (pluginLoader.list().some((p) => p.id === id)) pluginLoader.unload(id);
        return;
      }
      const shouldBeEnabled = settings.plugins.enabled[id] !== false;
      const isLoaded = pluginLoader.list().some((p) => p.id === id);
      if (shouldBeEnabled && !isLoaded) {
        try {
          pluginLoader.load(id, loadPluginModule(pluginPath));
        } catch (err) {
          console.error(`[BetterClaude] failed to evaluate plugin "${id}"`, err);
        }
      } else if (!shouldBeEnabled && isLoaded) {
        pluginLoader.unload(id);
      }
    });
  }

  // --- Settings persistence bridge ---
  // Returns the update promise (a promise is truthy, so existing
  // fire-and-forget call sites like `setSetting(a) && setSetting(b)` still
  // work unchanged) so new callers that need the fresh settings back —
  // saveProfile, applyProfile — can `await` it instead of racing a stale
  // read of the outer `settings` variable.
  function setSetting(keyPath, value) {
    const cosmetic = /^(appearance\.(accentColor|colorBlindSafe|contrastBoost|glassPanels)|appearanceEditor\.|background\.|customCSS\.|fonts\.|layout\.|cursor\.|motion\.)/.test(keyPath);
    const write = cosmetic
      ? ipcRenderer.invoke("appearance:set-cosmetic", keyPath, value)
      : ipcRenderer.invoke("settings:set", keyPath, value);
    return write.then((updated) => {
      settings = updated;
      return updated;
    });
  }

  function selectTheme(themeId) {
    return ipcRenderer.invoke("appearance:select-theme", themeId).then((updated) => {
      settings = updated;
      return updated;
    });
  }

  const settingsChangedHandlers = [];

  companion.mount(settings);

  // Never show auxiliary chrome on Claude's public sign-in/marketing route.
  // Presence of the composer is the signal — no conversation content is read.
  function syncContextualChrome() {
    const hasComposer = !!document.querySelector('[data-testid="chat-input"]');
    document.body.classList.toggle("bc-signed-out", !hasComposer);
    companion.update({
      ...settings,
      personality: { ...settings.personality, companionEnabled: !!(settings.personality && settings.personality.companionEnabled && hasComposer) },
    });
    // Cursor trails/ripples/radial controls are app chrome, not part of a
    // sign-in screen. Do not let a saved Vibe Bundle spill visual effects
    // over Claude's authentication flow.
    if (!hasComposer && interactionFX) {
      interactionFX.unmount();
      interactionFX = null;
    } else if (hasComposer && !interactionFX && (!settings.general || settings.general.enabled !== false)) {
      interactionFX = new InteractionFX({ onRadialAction: (id) => runRadialAction(id) });
      interactionFX.mount(settings);
    }
  }
  applyThemeState();
  syncContextualChrome();
  applyScheduledTheme();
  applyScheduledWeatherTheme();
  setInterval(applyScheduledTheme, 60 * 1000);
  setInterval(applyScheduledWeatherTheme, 30 * 60 * 1000);
  setInterval(applyBackgroundRotation, 60 * 1000);
  ipcRenderer.on("betterclaude:os-theme-changed", (_e, { isDark }) => {
    osThemeIsDark = isDark;
    applyScheduledTheme();
  });

  // Minimal, dependency-free toast, shared by the plugin API's api.notify()
  // and the settings panel host bridge. `category` gates it through
  // core/notifications.js's DND/priority check and per-type enable flag,
  // and picks a visual variant per settings.notifications.style.
  function showToast(message, { category = null, timeout = 3000 } = {}) {
    const style = (settings.notifications && settings.notifications.style) || "banner";
    const typeConf = category && settings.notifications && settings.notifications.types[category];

    const toast = document.createElement("div");
    toast.className = `bc-toast ${notificationStyleClass(style)}`;
    if (style === "badge" && typeConf) {
      toast.textContent = typeConf.icon || "•";
      toast.title = message;
    } else {
      toast.textContent = (typeConf && typeConf.icon ? `${typeConf.icon} ` : "") + message;
    }
    if (typeConf && typeConf.color) toast.style.borderColor = typeConf.color;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), timeout);
  }

  // --- Smart Notification Digest ---
  // Off by default (settings.notifications.digest.enabled) — every call
  // still shows immediately, unchanged, until the user opts in. Once on,
  // routine categorized completions (macro replay finished, Team Sync
  // applied files, clipboard synced, ...) queue instead of interrupting one
  // at a time; a periodic flush shows ONE native OS notification
  // summarizing what changed. `urgent: true` (failures) always bypasses the
  // queue and fires immediately as both an in-page toast and a native
  // notification, so this only changes *routine* visibility, never errors.
  let digestQueue = [];

  function flushDigest() {
    if (digestQueue.length === 0) return;
    const items = digestQueue;
    digestQueue = [];
    const shown = items.slice(0, 5).map((i) => i.message);
    const summary = shown.join(" · ") + (items.length > shown.length ? ` · +${items.length - shown.length} more` : "");
    showToast(`${items.length} update${items.length === 1 ? "" : "s"}: ${summary}`, { timeout: 6000 });
    ipcRenderer.invoke("notifications:show-native", {
      title: `BetterClaude — ${items.length} update${items.length === 1 ? "" : "s"}`,
      body: summary,
    }).catch(() => {});
  }

  let digestTimer = null;
  function syncDigestTimer() {
    if (digestTimer) {
      clearInterval(digestTimer);
      digestTimer = null;
    }
    const digest = settings.notifications && settings.notifications.digest;
    if (!digest || !digest.enabled) {
      flushDigest(); // drain anything already queued rather than lose it silently
      return;
    }
    const intervalMs = Math.max(1, digest.intervalMinutes || 15) * 60 * 1000;
    digestTimer = setInterval(flushDigest, intervalMs);
  }

  function notify(message, { category = null, timeout = 3000, urgent = false } = {}) {
    if (category && settings.notifications && shouldSuppress(settings.notifications, category)) return;
    const digest = settings.notifications && settings.notifications.digest;
    if (category && digest && digest.enabled && !urgent) {
      digestQueue.push({ message, category, ts: Date.now() });
      return;
    }
    showToast(message, { category, timeout });
    if (urgent) {
      ipcRenderer.invoke("notifications:show-native", { title: "BetterClaude", body: message }).catch(() => {});
    }
  }

  // --- Plugin loader ---
  pluginLoader = new PluginLoader({
    themeEngine,
    getSettings: () => settings,
    setSetting,
    host: { notify },
  });

  // --- Usage Analytics Dashboard: local event logging ---
  // Off by default (settings.analytics.enabled) — nothing is logged, let
  // alone sent anywhere, until the user opts in. One tick per currently-
  // enabled plugin per interval, the honest proxy this app has for
  // "most-used plugins" without instrumenting each plugin's internals.
  function logPluginAnalyticsTick() {
    if (!settings.analytics || !settings.analytics.enabled) return;
    const pluginIds = pluginLoader.list().map((p) => p.id);
    if (pluginIds.length === 0) return;
    ipcRenderer.invoke("analytics:log-plugin-tick", { ts: Date.now(), day: new Date().toISOString().slice(0, 10), pluginIds }).catch(() => {});
  }
  setInterval(logPluginAnalyticsTick, 5 * 60 * 1000);

  // --- Conversation Branching: fork buttons ---
  // Shared by an in-conversation "Fork here" and by Auto-Session Snapshots'
  // "Restore" (which forks from a saved transcript instead of a live turn
  // range) — same framing either way so the new window's model has context.
  // --- Usage Analytics Dashboard ---
  const analyticsDashboard = new AnalyticsDashboard({
    queryAnalytics: (range) => ipcRenderer.invoke("analytics:query", range),
    exportCsv: (range) => ipcRenderer.invoke("analytics:export-csv", range),
    savePng: (dataUrl, suggestedName) => ipcRenderer.invoke("analytics:save-png", { dataUrl, suggestedName }),
    clearAnalytics: () => ipcRenderer.invoke("analytics:clear"),
    notify: (message) => notify(message, { category: "plugin" }),
  });

  // Route changes (sign-in screen <-> workspace) swap claude.ai's app root
  // out from under us, so the companion/cursor-FX chrome has to re-evaluate.
  // Scoped to claude.ai's own root rather than document.body: every
  // BetterClaude surface mounts as a sibling of that root, and
  // syncContextualChrome() mutates some of them — observing body would
  // re-trigger this handler in an unbounded self-feeding loop.
  const chromeObserver = new MutationObserver(() => syncContextualChrome());
  const claudeRoot = document.getElementById("root") || document.getElementById("__next") || document.body;
  chromeObserver.observe(claudeRoot, { childList: true, subtree: true });

  // Zen Mode directly drives the existing Focus Mode plugin's own
  // setActive() (reusing its real DOM-detachment logic instead of
  // reimplementing it) — see plugins/focus-mode.claudeplugin.js.
  function syncZenModeWithFocusPlugin() {
    if (!pluginLoader) return;
    const entry = pluginLoader.loaded.get("focus-mode");
    if (entry && entry.module && typeof entry.module.setActive === "function") {
      const desired = !!(settings.focusReading && settings.focusReading.zenMode);
      // This runs on every "settings changed" broadcast, and setActive()
      // itself writes a setting — calling it unconditionally re-triggers
      // the very broadcast that invoked us, spinning the whole app (every
      // settings-panel section, every open dropdown/popover) in an
      // infinite re-render loop. Only call through when the value actually
      // needs to change.
      if (entry.module.active !== desired) entry.module.setActive(desired);
    }
  }

  // Cheap, pure stat computation re-run on every settings change; only acts
  // when checkAchievements finds something newly true. themesTried is an
  // honest approximation (distinct themes ever activated or favorited),
  // not a dedicated historical log.
  function refreshAchievements() {
    const stats = {
      launches: 1,
      streakCount: (settings.personality.streak && settings.personality.streak.count) || 0,
      themesTried: new Set([settings.appearance.activeTheme, ...(settings.appearance.favoriteThemes || [])]).size,
      pluginsEnabledCount: Object.values(settings.plugins.enabled).filter(Boolean).length,
      usedAfterMidnight: new Date().getHours() < 5,
      konamiUnlocked: !!(settings.personality.easterEggs && settings.personality.easterEggs.konamiUnlocked),
    };
    const { allUnlocked, newlyUnlocked } = checkAchievements(stats, settings.personality.achievements || []);
    if (newlyUnlocked.length === 0) return;
    setSetting("personality.achievements", allUnlocked);
    newlyUnlocked.forEach((id) => {
      const achievement = ACHIEVEMENTS.find((a) => a.id === id);
      notify(`Achievement unlocked: ${achievement ? achievement.label : id}`, { category: "achievement" });
    });
    companion.react("happy");
    if (settings.motion.confetti && settings.automations.achievementBurstsConfetti) celebrate();
  }

  // --- Team/Shared Plugin Sync ---
  // Applying a synced file (electron/main.js) broadcasts which plugin/theme
  // ids changed rather than expecting every window to blindly re-fetch
  // everything; this reloads exactly those (unload+reload for a plugin
  // whose file changed underneath an already-loaded instance, since
  // applyPluginState() alone only loads/unloads based on the enabled flag,
  // not on file content changing).
  async function reloadTeamSyncedItems({ pluginIds, themeIds }) {
    if (pluginIds && pluginIds.length > 0) {
      const sources = await ipcRenderer.invoke("plugins:list-sources");
      pluginIds.forEach((id) => {
        const found = sources.find((s) => s.id === id);
        if (!found) return;
        if (pluginLoader.list().some((p) => p.id === id)) pluginLoader.unload(id);
        if (settings.plugins.enabled[id] !== false) {
          try {
            pluginLoader.load(id, loadPluginModule(found.path));
          } catch (err) {
            console.error(`[BetterClaude] failed to reload synced plugin "${id}"`, err);
          }
        }
      });
    }
    if (themeIds && themeIds.length > 0) {
      const updatedThemes = await ipcRenderer.invoke("themes:get-all");
      Object.assign(themes, updatedThemes);
    }
  }

  ipcRenderer.on("betterclaude:team-sync-error", (_e, message) => {
    notify(`Team Sync failed: ${message}`, { category: "plugin", urgent: true });
  });

  ipcRenderer.on("betterclaude:team-sync-applied", (_e, payload) => {
    reloadTeamSyncedItems(payload).catch((err) => console.error("[BetterClaude] team sync reload failed", err));
    const parts = [];
    if (payload.pluginIds.length > 0) parts.push(`${payload.pluginIds.length} plugin${payload.pluginIds.length === 1 ? "" : "s"}`);
    if (payload.themeIds.length > 0) parts.push(`${payload.themeIds.length} theme${payload.themeIds.length === 1 ? "" : "s"}`);
    if (parts.length > 0) notify(`Team Sync applied ${parts.join(" and ")}.`, { category: "plugin" });
  });

  // Seeded from the settings already loaded at bootstrap so a restart with
  // pre-existing conflicts (from a previous session) doesn't re-notify.
  let lastTeamSyncConflictCount = (settings.teamSync && settings.teamSync.conflicts.length) || 0;

  ipcRenderer.on("betterclaude:settings-changed", (_e, updated) => {
    settings = updated;
    applyThemeState();
    applyScheduledTheme();
    applyPluginState();
    syncZenModeWithFocusPlugin();
    syncDigestTimer();
    refreshAchievements();
    const conflictCount = (updated.teamSync && updated.teamSync.conflicts.length) || 0;
    if (conflictCount > lastTeamSyncConflictCount) {
      notify(`Team Sync: ${conflictCount} conflict${conflictCount === 1 ? "" : "s"} need review — Settings → Team Sync.`, { category: "plugin" });
    }
    lastTeamSyncConflictCount = conflictCount;
    settingsChangedHandlers.forEach((cb) => cb(settings));
  });

  await applyPluginState();
  syncZenModeWithFocusPlugin();
  syncDigestTimer();

  // --- Streak + greeting (once per bootstrap) ---
  {
    const todayStr = new Date().toISOString().slice(0, 10);
    const nextStreak = incrementStreak(settings.personality.streak, todayStr);
    if (nextStreak.bumped) {
      setSetting("personality.streak", { count: nextStreak.count, lastActiveDate: nextStreak.lastActiveDate });
      if (nextStreak.count > 1) companion.react("streak-bump");
    }
    refreshAchievements();
    const greeting = buildGreeting({
      name: settings.personality.userName,
      streakCount: nextStreak.count,
      style: settings.personality.greetingStyle,
    });
    companion.say(settings.personality.statusMessage || greeting);
  }

  // --- Command palette (Cmd/Ctrl+K) + Konami easter egg ---
  function runCommand(cmd) {
    if (!cmd) return;
    if (typeof cmd.run === "function") {
      cmd.run();
      return;
    }
    if (cmd.settingPath) setSetting(cmd.settingPath, cmd.value);
  }

  // "For Everything": one flat, freshly-built list covering every indexable
  // surface — app actions, settings pages, plugins, prompt library entries,
  // and skills (installed + marketplace cache). Rebuilt fresh every time the
  // palette opens (below) rather than kept reactively in sync, so a prompt or
  // plugin added a second ago is always there without extra wiring.
  async function indexedCommands() {
    const actions = [
      { id: "open-settings", label: "Open Settings", group: "Action", run: () => settingsPanel.open() },
      { id: "toggle-zen", label: "Toggle Zen Mode", group: "Action", run: () => setSetting("focusReading.zenMode", !settings.focusReading.zenMode) },
      { id: "toggle-mute", label: "Toggle Mute", group: "Action", run: () => setSetting("sound.muted", !settings.sound.muted) },
      { id: "surprise-me", label: "Surprise Me (randomize everything)", group: "Action", run: () => surpriseMe() },
      { id: "play-snake", label: "Play Snake", group: "Action", run: () => openMiniGame() },
      { id: "open-skill-marketplace", label: "Open Skill Marketplace", group: "Skills", run: () => skillMarketplace.open() },
      { id: "insert-prompt", label: "Insert Prompt…", group: "Prompts", run: () => promptPicker.open() },
      { id: "compare-responses", label: "Compare Responses (Diff)", group: "Action", run: () => diffViewer.open() },
      { id: "open-usage-analytics", label: "Open Usage Analytics", group: "Analytics", run: () => analyticsDashboard.open() },
      {
        id: "sync-team-now",
        label: "Sync Team Plugins Now",
        group: "Action",
        run: () => ipcRenderer.invoke("teamSync:sync").catch((err) => notify(`Team Sync failed: ${err.message}`)),
      },
      ...(settings.commandPalette.customCommands || []).map((c) => ({ id: c.id, label: c.label, group: "Action", settingPath: c.settingPath, value: c.value })),
    ];

    const settingsPages = SECTIONS.map((section) => ({
      id: `settings-${section}`,
      label: `Settings: ${section}`,
      group: "Settings",
      keywords: "settings preferences",
      run: () => settingsPanel.openSection(section),
    }));

    const prompts = (settings.promptLibrary.prompts || []).map((p) => ({
      id: `prompt-${p.id}`,
      label: `Insert Prompt: ${p.title}`,
      group: "Prompts",
      run: () => promptPicker.open(p.id),
    }));

    const installedSkills = Object.entries(settings.skillMarketplace.installed || {}).map(([id, record]) => ({
      id: `skill-installed-${id}`,
      label: `Reveal Skill: ${record.owner}/${record.repo}`,
      group: "Skills",
      run: () => ipcRenderer.invoke("skills:reveal", id),
    }));

    const cachedSkills = ((settings.skillMarketplace.cache && settings.skillMarketplace.cache.items) || []).map((item) => ({
      id: `skill-cache-${item.id}`,
      label: `Marketplace: ${item.fullName}`,
      group: "Skills",
      run: () => {
        skillMarketplace.open();
        skillMarketplace.select(item);
      },
    }));

    let plugins = [];
    try {
      const sources = await panelHost.listPlugins();
      plugins = sources.map((p) => ({
        id: `plugin-${p.id}`,
        label: `Toggle Plugin: ${p.name}`,
        group: "Plugins",
        run: () => panelHost.togglePlugin(p.id, !p.enabled),
      }));
    } catch (_e) {
      // Non-fatal — the palette just shows everything else without plugins this time.
    }

    return [...actions, ...settingsPages, ...prompts, ...installedSkills, ...cachedSkills, ...plugins];
  }

  document.addEventListener("keydown", async (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      commandPalette.setCommands(await indexedCommands());
      commandPalette.toggle();
    }
  });

  // In-page fallback for opening the Prompt Picker (works while the window
  // has focus). The same prompt can also carry its own OS-wide accelerator,
  // registered in electron/main.js's registerPromptShortcuts() and delivered
  // here via the betterclaude:trigger-prompt IPC channel below.
  document.addEventListener("keydown", (e) => {
    const accel = settings.keyboardShortcuts.openPromptPicker || "";
    if (!accel) return;
    const wantsMeta = /commandorcontrol|cmdorctrl/i.test(accel);
    const wantsShift = /shift/i.test(accel);
    const keyMatch = /\+([a-z0-9])$/i.exec(accel);
    if (!keyMatch) return;
    if ((wantsMeta ? (e.metaKey || e.ctrlKey) : true) && (wantsShift ? e.shiftKey : true) && e.key.toLowerCase() === keyMatch[1].toLowerCase()) {
      e.preventDefault();
      promptPicker.toggle();
    }
  });

  ipcRenderer.on("betterclaude:trigger-prompt", (_e, promptId) => promptPicker.open(promptId));

  // --- Native File Watcher Sync ---
  // "Auto-reattach" only ever find-and-replaces the labeled block this app
  // itself inserted into an *unsent* composer — it can't and doesn't try to
  // edit an already-sent message. A miss (marker not found) just marks the
  // record stale so Settings -> File Watcher can offer a manual re-insert.
  ipcRenderer.on("betterclaude:file-changed", (_e, { path: filePath, content }) => {
    const watched = settings.fileWatcher.watched || [];
    const idx = watched.findIndex((w) => w.path === filePath);
    if (idx === -1) return;
    const record = watched[idx];
    const synced = !!record.autoReattach && findAndReplaceInComposer(record.label, content);
    const next = [...watched];
    next[idx] = {
      ...record,
      lastDiskContent: content,
      stale: !synced,
      lastSyncedAt: synced ? Date.now() : record.lastSyncedAt,
    };
    settings.fileWatcher.watched = next;
    setSetting("fileWatcher.watched", next);
    notify(
      synced ? `${record.label} auto-synced from disk.` : `${record.label} changed on disk — re-insert it from Settings → File Watcher.`,
      { category: "plugin" }
    );
  });

  stopKonami = mountKonamiListener(async () => {
    setSetting("personality.easterEggs.konamiUnlocked", true);
    await selectTheme("secret-rainbow");
    notify("Secret theme unlocked!", { category: "achievement" });
    refreshAchievements();
    if (settings.motion.confetti) celebrate();
  });

  // --- Right-click radial quick-action menu ---
  function runRadialAction(id) {
    if (id === "settings") settingsPanel.open();
    else if (id === "shuffle-theme") {
      const ids = Object.keys(themes).filter((t) => t !== settings.appearance.activeTheme && t !== "secret-rainbow");
      if (ids.length) {
        const pick = ids[Math.floor(Math.random() * ids.length)];
        selectTheme(pick);
      }
    } else if (id === "zen-mode") setSetting("focusReading.zenMode", !settings.focusReading.zenMode);
    else if (id === "mute-sound") setSetting("sound.muted", !settings.sound.muted);
    else if (id === "command-palette") {
      indexedCommands().then((cmds) => {
        commandPalette.setCommands(cmds);
        commandPalette.toggle();
      });
    } else if (id === "surprise-me") surpriseMe();
  }

  // --- Click / hover sounds (Settings -> Sound & Haptics) ---
  // soundEngine.play() already no-ops instantly when pack is "off" (the
  // default) or the specific type is toggled off, so wiring these
  // unconditionally is cheap and safe. Uses Web Audio only — no DOM
  // mutation — so unlike the click ripple (see core/interaction-fx.js) this
  // is safe to fire even when the click opens a native <select> popup.
  document.addEventListener("click", () => {
    // The public auth screen is deliberately silent; the click tone is for
    // the BetterClaude workspace and is distracting during sign-in/OAuth.
    if (!document.body.classList.contains("bc-signed-out")) soundEngine.play("click");
  });
  let lastHoverSoundTarget = null;
  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest && e.target.closest('button, a, [role="button"], select, .bc-dock-btn');
    if (target && target !== lastHoverSoundTarget) {
      lastHoverSoundTarget = target;
      soundEngine.play("hover");
    } else if (!target) {
      lastHoverSoundTarget = null;
    }
  });

  // Web Audio's autoplay policy can leave the context "suspended" until a
  // real user gesture — this catches the very first one so a persisted
  // ambient soundscape (which starts automatically from saved settings on
  // bootstrap, with no gesture yet) reliably resumes instead of staying
  // silently muted for the rest of the session.
  document.addEventListener("pointerdown", () => {
    if (soundEngine.ctx && soundEngine.ctx.state === "suspended") soundEngine.ctx.resume();
  });

  // --- Vibe Bundles: mood picker, "Surprise Me", weather theme ---
  async function surpriseMe() {
    const bundle = pickRandomBundle(settings.appearance.activeTheme && VIBE_BUNDLES.find((b) => b.themeId === settings.appearance.activeTheme)?.id);
    await applyBundle(bundle, { setSetting, selectTheme });
    if (settings.motion.confetti) celebrate();
  }

  function openMiniGame() {
    let modal = document.getElementById("bc-minigame-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "bc-minigame-modal";
      modal.innerHTML = `<div class="bc-minigame-box"><button class="bc-minigame-close" data-bc-close>Close</button><div data-bc-game-container></div></div>`;
      document.body.appendChild(modal);
      modal.addEventListener("mousedown", (e) => { if (e.target === modal) closeMiniGame(); });
      modal.querySelector("[data-bc-close]").addEventListener("click", closeMiniGame);
    }
    modal.classList.add("bc-open");
    if (modal._gameHandle) modal._gameHandle.destroy();
    modal._gameHandle = mountSnakeGame(modal.querySelector("[data-bc-game-container]"));
  }

  function closeMiniGame() {
    const modal = document.getElementById("bc-minigame-modal");
    if (!modal) return;
    modal.classList.remove("bc-open");
    if (modal._gameHandle) {
      modal._gameHandle.destroy();
      modal._gameHandle = null;
    }
  }

  // --- Snake while Claude is working ---
  // claude.ai exposes no "is generating" flag we can read. What it does do,
  // for exactly the duration of a response, is swap the composer's send
  // button for a stop button — so that button's presence is the signal.
  //
  // A single selector here would be a silent-failure trap: if claude.ai
  // renames one testid the game simply never appears, nothing throws, and
  // every automated check still reports green. Hence a union of the
  // plausible hooks (testid first, then aria-labels). None of them is
  // verified against the live site as of this change — the union exists
  // precisely because of that, and STOP_BUTTON_SELECTORS is the single place
  // to fix if the popup ever stops showing up.
  const STOP_BUTTON_SELECTORS = [
    '[data-testid="stop-button"]',
    'button[data-testid="stop-response"]',
    'button[aria-label="Stop response"]',
    'button[aria-label*="stop response" i]',
    'button[aria-label*="stop generating" i]',
  ].join(",");

  const WAITING_POLL_MS = 400;

  function claudeIsWorking() {
    return !!document.querySelector(STOP_BUTTON_SELECTORS);
  }

  function openWaitingGame() {
    let panel = document.getElementById("bc-waiting-snake");
    if (panel && panel._gameHandle) return; // already up for this wait
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "bc-waiting-snake";
      panel.innerHTML = `
        <div class="bc-ws-head">
          <span class="bc-ws-title">While you wait…</span>
          <button class="bc-ws-close" data-bc-ws-close aria-label="Dismiss the game">✕</button>
        </div>
        <div data-bc-ws-container></div>`;
      document.body.appendChild(panel);
      // Dismissing marks only THIS wait as dismissed — waitingRunDismissed is
      // reset on the next not-working -> working edge, so the game returns
      // the next time Claude is thinking, which is the point of it.
      panel.querySelector("[data-bc-ws-close]").addEventListener("click", () => {
        waitingRunDismissed = true;
        closeWaitingGame();
      });
    }
    panel.classList.add("bc-open");
    // keyScope "element": this floats over a page whose composer is still
    // typeable, and Snake's WASD bindings would otherwise swallow real
    // typing (see ui/mini-game/snake.js).
    panel._gameHandle = mountSnakeGame(panel.querySelector("[data-bc-ws-container]"), { keyScope: "element" });
  }

  function closeWaitingGame() {
    const panel = document.getElementById("bc-waiting-snake");
    if (!panel) return;
    panel.classList.remove("bc-open");
    if (panel._gameHandle) {
      panel._gameHandle.destroy();
      panel._gameHandle = null;
    }
  }

  let waitingRunDismissed = false;
  let waitingShowAt = 0;
  let wasWorking = false;

  // Polled rather than folded into chromeObserver above: that observer fires
  // on every streamed token, and this only cares about a state edge.
  setInterval(() => {
    const working = claudeIsWorking();
    if (working && !wasWorking) {
      // A new response started — a previous dismissal doesn't carry over.
      waitingRunDismissed = false;
      const delay = (settings.playful && settings.playful.snakeDelayMs) || 0;
      waitingShowAt = Date.now() + delay;
    }
    wasWorking = working;

    if (!working) {
      closeWaitingGame();
      return;
    }
    if (settings.general && settings.general.enabled === false) return;
    if (!settings.playful || settings.playful.snakeWhileWaiting === false) return;
    if (waitingRunDismissed) return;
    if (Date.now() < waitingShowAt) return;
    openWaitingGame();
  }, WAITING_POLL_MS);

  // --- Auto-updater bridge ---
  let updateStatus = { state: "idle" };
  const updateStatusHandlers = [];
  ipcRenderer.on("betterclaude:update-status", (_e, status) => {
    updateStatus = status;
    updateStatusHandlers.forEach((cb) => cb(status));
  });

  // --- Cross-Device Clipboard Bridge bridge ---
  // The actual relay push/pull + OS clipboard read/write happens in
  // electron/main.js (Node/Electron-specific, mirrors the file watcher
  // split) — this side just mirrors live connection status for Settings ->
  // Clipboard Bridge and surfaces a notification whenever a synced item
  // actually lands, so syncing is never silent.
  let clipboardBridgeStatus = { state: "idle", lastError: null, lastSyncedAt: null };
  const clipboardBridgeStatusHandlers = [];
  ipcRenderer.on("betterclaude:clipboard-bridge-status", (_e, status) => {
    clipboardBridgeStatus = status;
    clipboardBridgeStatusHandlers.forEach((cb) => cb(status));
  });
  ipcRenderer.on("betterclaude:clipboard-synced", (_e, { deviceName }) => {
    notify(`Clipboard synced from ${deviceName || "another device"}.`, { category: "plugin" });
  });

  // --- Settings panel ---
  const panelHost = {
    getSettings: () => settings,
    setSetting,
    onSettingsChanged: (cb) => settingsChangedHandlers.push(cb),
    listThemeIds: () => Object.keys(themes),
    getThemesData: () => themes,
    listUserThemeIds: () => ipcRenderer.invoke("themes:list-user-ids"),
    notify,
    exportSettings: () => ipcRenderer.invoke("settings:export"),
    // Resulting settings arrive back through the normal
    // "betterclaude:settings-changed" broadcast main.js sends after
    // writing them, so there's nothing further to wire up here.
    importSettings: () => ipcRenderer.invoke("settings:import"),
    getUpdateStatus: () => updateStatus,
    onUpdateStatus: (cb) => updateStatusHandlers.push(cb),
    checkForUpdates: () => ipcRenderer.invoke("updater:check"),
    downloadUpdate: () => ipcRenderer.invoke("updater:download"),
    installUpdate: () => ipcRenderer.invoke("updater:install"),
    selectTheme,
    applyThemePreview: (id) => themeEngine.setTheme(id),
    applyCustomCSSPreview: (code) => themeEngine.setCustomCSS(code),
    applyAccentPreview: (hex) => themeEngine.setAccentColor(hex),
    // Live-applies a background patch and returns its WCAG contrast eval so the
    // panel can warn + suggest a scrim opacity before the setting is saved.
    applyBackgroundPreview: (patch) => themeEngine.setBackground(patch),
    importThemeFromUrl: async (url) => {
      const result = await ipcRenderer.invoke("themes:import-url", url);
      Object.assign(themes, result.themes);
      return result;
    },
    importThemeFromFile: async () => {
      const result = await ipcRenderer.invoke("themes:import-file");
      if (!result) return null;
      Object.assign(themes, result.themes);
      return result;
    },
    // Compiles the theme currently rendered on screen (bundled/imported
    // preset CSS + whatever the Appearance Editor/Custom CSS tabs have
    // layered on top) into one standalone theme file, so it round-trips
    // through Themes -> pick it again -> get the exact same look.
    saveCurrentAsNewTheme: async (name) => {
      const baseCSS = themes[settings.appearance.activeTheme] || "";
      const customCSS = settings.customCSS.code || "";
      const cssText = `/* BetterClaude theme: ${name} */\n${baseCSS}\n\n${customCSS}`;
      const result = await ipcRenderer.invoke("themes:save-user", name, cssText);
      Object.assign(themes, result.themes);
      return result;
    },
    deleteUserTheme: async (id) => {
      const updated = await ipcRenderer.invoke("themes:delete-user", id);
      Object.keys(themes).forEach((k) => delete themes[k]);
      Object.assign(themes, updated);
    },
    // Bundled buddy art can't be referenced as file:// from the claude.ai
    // document, so the main process hands it over pre-encoded.
    getBuddyThumbnail: (id) => ipcRenderer.invoke("buddies:get-thumbnail", id),
    listPlugins: async () => {
      const sources = await ipcRenderer.invoke("plugins:list-sources");
      return sources.map(({ id }) => {
        const loaded = pluginLoader.list().find((p) => p.id === id);
        return {
          id,
          name: loaded ? loaded.name : id,
          version: loaded ? loaded.version : "",
          enabled: settings.plugins.enabled[id] !== false,
        };
      });
    },
    togglePlugin: async (id, enabled) => {
      setSetting(`plugins.enabled.${id}`, enabled);
      if (enabled) {
        const sources = await ipcRenderer.invoke("plugins:list-sources");
        const found = sources.find((p) => p.id === id);
        if (found) {
          const moduleObj = loadPluginModule(found.path);
          pluginLoader.load(id, moduleObj);
        }
      } else {
        pluginLoader.unload(id);
      }
    },
    openPluginsFolder: () => ipcRenderer.invoke("plugins:open-folder"),
    mountCSSEditor: (container, opts) => cssEditor.mount(container, opts),

    // --- Skill Marketplace bridge ---
    refreshSkillsCache: () => ipcRenderer.invoke("skills:refresh-cache"),
    openSkillMarketplace: () => skillMarketplace.open(),
    revealSkill: (id) => ipcRenderer.invoke("skills:reveal", id),
    uninstallSkill: (id) => ipcRenderer.invoke("skills:uninstall", id),

    // --- Prompt Library bridge ---
    exportPromptLibrary: () => ipcRenderer.invoke("promptLibrary:export"),
    importPromptLibrary: () => ipcRenderer.invoke("promptLibrary:import"),

    // --- File Watcher bridge ---
    pickWatchedFile: async () => {
      const picked = await ipcRenderer.invoke("fileWatcher:pick-file");
      if (!picked) return null;
      const record = {
        id: `fw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        path: picked.path,
        label: picked.name,
        autoReattach: true,
        lastDiskContent: picked.content,
        stale: false,
        lastSyncedAt: null,
      };
      const next = [...(settings.fileWatcher.watched || []), record];
      settings.fileWatcher.watched = next;
      await setSetting("fileWatcher.watched", next);
      await ipcRenderer.invoke("fileWatcher:start", picked.path);
      return record;
    },
    stopWatchingFile: async (id) => {
      const record = (settings.fileWatcher.watched || []).find((w) => w.id === id);
      if (record) await ipcRenderer.invoke("fileWatcher:stop", record.path);
      const next = (settings.fileWatcher.watched || []).filter((w) => w.id !== id);
      settings.fileWatcher.watched = next;
      return setSetting("fileWatcher.watched", next);
    },
    insertWatchedFile: (id) => {
      const record = (settings.fileWatcher.watched || []).find((w) => w.id === id);
      if (!record) return false;
      const ok = insertFileBlock(record.label, record.lastDiskContent);
      if (ok) {
        const next = settings.fileWatcher.watched.map((w) => (w.id === id ? { ...w, stale: false, lastSyncedAt: Date.now() } : w));
        settings.fileWatcher.watched = next;
        setSetting("fileWatcher.watched", next);
      } else {
        notify("Couldn't find claude.ai's composer.");
      }
      return ok;
    },
    setAutoReattach: (id, autoReattach) => {
      const next = settings.fileWatcher.watched.map((w) => (w.id === id ? { ...w, autoReattach } : w));
      settings.fileWatcher.watched = next;
      return setSetting("fileWatcher.watched", next);
    },

    // --- Clipboard Bridge bridge ---
    getClipboardBridgeStatus: () => clipboardBridgeStatus,
    onClipboardBridgeStatus: (cb) => clipboardBridgeStatusHandlers.push(cb),
    pushClipboardNow: () => ipcRenderer.invoke("clipboardBridge:push-now"),
    testClipboardBridgeConnection: () => ipcRenderer.invoke("clipboardBridge:test-connection"),

    // --- Usage Analytics Dashboard bridge ---
    openAnalyticsDashboard: () => analyticsDashboard.open(),

    // --- Team/Shared Plugin Sync bridge ---
    syncTeamNow: () => ipcRenderer.invoke("teamSync:sync"),
    getTeamSyncDiff: (relPath) => ipcRenderer.invoke("teamSync:get-diff", relPath),
    applyTeamSyncFile: (relPath) => ipcRenderer.invoke("teamSync:apply-file", relPath),
    keepLocalTeamSyncFile: (relPath) => ipcRenderer.invoke("teamSync:keep-local", relPath),
    openTeamSyncFolder: () => ipcRenderer.invoke("teamSync:open-folder"),

    // --- Customize Everything bridge methods ---
    playSoundPreview: (type) => soundEngine.play(type),
    previewConfetti: () => celebrate(),
    notifyPreview: (category) => notify("This is what a notification looks like.", { category }),
    applyMood: async (mood) => {
      await setSetting("personality.mood", mood);
      const bundle = bundleForMood(mood);
      if (bundle) await applyBundle(bundle, { setSetting, selectTheme });
    },
    applyVibeBundle: async (bundleId) => {
      const bundle = VIBE_BUNDLES.find((b) => b.id === bundleId);
      if (bundle) await applyBundle(bundle, { setSetting, selectTheme });
    },
    surpriseMe: () => surpriseMe(),
    saveProfile: async (name) => {
      const { profiles, window, ...rest } = settings;
      const snapshot = JSON.parse(JSON.stringify(rest));
      const entry = {
        id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name,
        createdAt: Date.now(),
        snapshot,
      };
      await setSetting("profiles.list", [...(settings.profiles.list || []), entry]);
    },
    applyProfile: async (id) => {
      settings = await ipcRenderer.invoke("profiles:apply", id);
    },
    // No openMiniGame here on purpose: Settings no longer launches the game
    // (it only toggles the while-you-wait popup). Cmd+K -> "Play Snake"
    // still calls the local openMiniGame() directly.
    applyWeatherTheme: () => applyScheduledWeatherTheme(),
  };

  const settingsPanel = new SettingsPanel(panelHost);

  // --- Title bar ---
  // Inlined as a data URI (not a file:// src) since claude.ai's CSP img-src
  // policy doesn't allow file:// resources into the page.
  const logoSrc = "data:image/png;base64," + fs.readFileSync(path.join(__dirname, "../assets/logo-mark.png")).toString("base64");

  mountTitleBar({
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximizeToggle: () => ipcRenderer.invoke("window:maximize-toggle"),
    close: () => ipcRenderer.invoke("window:close"),
    toggleAlwaysOnTop: () => ipcRenderer.invoke("window:toggle-always-on-top"),
    isAlwaysOnTop: () => ipcRenderer.invoke("window:is-always-on-top"),
    openSettings: () => settingsPanel.toggle(),
    logoSrc,
  });

  // --- Menu / accelerator bridges from main.js ---
  ipcRenderer.on("betterclaude:toggle-settings", () => settingsPanel.toggle());
}

bootstrap().catch((err) => console.error("[BetterClaude] preload bootstrap failed", err));
