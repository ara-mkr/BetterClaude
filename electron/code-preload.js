/**
 * Preload for the embedded Claude Code window (electron/code-window.html).
 *
 * Separate from the main preload.js on the same grounds buddy-preload.js is:
 * that one is injected into claude.ai and carries the whole plugin/companion/
 * skill/analytics surface, none of which applies to a terminal. This one
 * carries exactly two things — the pty bridge, and the shared BetterClaude
 * chrome (title bar + appearance settings).
 *
 * Two realms are in play here, and the split is deliberate:
 *
 *   - THIS realm (preload) has Node and ipcRenderer. It mounts the chrome by
 *     touching the shared DOM directly, which is how electron/preload.js
 *     already mounts the title bar and settings panel; contextIsolation means
 *     preload shares the document but not the page's JS realm.
 *   - The PAGE realm (ui/code-window/terminal.js) has no Node at all —
 *     nodeIntegration is off. It drives xterm.js and reaches the subprocess
 *     only through the `betterClaudeCode` object exposed below. Every pty byte
 *     in either direction therefore crosses one narrow, enumerable bridge.
 *
 * Compliance: the bridge below has no method that reads a file, and none that
 * writes to the child except `write`, which forwards the user's own keystrokes
 * verbatim. Nothing here parses terminal output.
 */

const { contextBridge, ipcRenderer } = require("electron");
const path = require("path");
const fs = require("fs");

const { ThemeEngine } = require("../core/theme-engine");
const { mountTitleBar } = require("../ui/title-bar");
const { SettingsPanel } = require("../ui/settings-panel/panel");
const { injectStaticCSS } = require("./static-css");

// Set by electron/main.js via webPreferences.additionalArguments when the pane
// is a child view of the main window rather than a standalone BrowserWindow.
// Read from argv rather than a query string because it is available here, at
// preload start, before the page has run a single line — which is what lets the
// stylesheet decide on the very first frame whether to leave a 46px gap for a
// title bar that will never be mounted.
const IS_EMBEDDED = process.argv.includes("--bc-embedded");

// Appearance-only scope for this window's settings panel.
//
// The panel is the real one — same class, same section renderers, same
// persistence path — but a CLI window has no claude.ai document, so the
// sections that exist to manipulate one would render live-looking controls that
// do nothing here: Layout (claude.ai's sidebar/composer), Focus & Reading,
// Widgets, Buddies, Plugins, Skill Marketplace, Prompt Library, File Watcher,
// Clipboard Bridge, Team Sync, Analytics, Command Palette, Automations.
// Offering them would be worse than omitting them. The five kept are the ones
// that genuinely restyle THIS window, because they all write --bc-* variables:
//
//   Appearance         accent colour, settings import/export, updates, version
//   Themes             preset picker — the headline "restyle this window" path
//   Appearance Editor  per-element colour overrides
//   Custom CSS         raw CSS, which applies to this document too
//   Fonts              --bc-code-font drives the terminal's own font family
//
// Everything omitted here is still reachable in the main window, which is the
// full-surface Settings home. Flagged for review in the report.
const CODE_WINDOW_SECTIONS = [
  "Appearance",
  "Themes",
  "Appearance Editor",
  "Custom CSS",
  "Fonts",
];

// --- The pty bridge (page world) ---
//
// Exposed synchronously at module scope, NOT inside bootstrap() below. The page
// script (ui/code-window/terminal.js) is a plain <script> in the body, so it
// executes during parse — before DOMContentLoaded, and therefore before
// anything bootstrap() awaits. Exposing the bridge from inside that async
// function raced the page and lost: `window.betterClaudeCode` was still
// undefined when the terminal tried to read it, and the window came up blank
// with a TypeError. contextBridge calls belong on the synchronous path.
//
// Compliance: no method here reads a file, and the only one that writes to the
// child is `write`, which forwards the user's own keystrokes verbatim.
const settingsListeners = [];
const forward = (channel) => (cb) => {
  ipcRenderer.on(channel, (_e, payload) => cb(payload));
};

// Latest settings, published once the theme stylesheet is actually in the
// document. The page builds its terminal palette by reading computed --bc-*
// values, but it starts running at parse time — before bootstrap() has
// injected any stylesheet — so at construction it can only see fallbacks.
// Replaying the current value to every late subscriber (and to every
// already-registered one, in publishSettings) makes the two orders equivalent
// instead of leaving the terminal stuck on default colours whenever the page
// happens to win the race.
let latestSettings = null;

function publishSettings(settings) {
  latestSettings = settings;
  settingsListeners.forEach((cb) => cb(settings));
}

contextBridge.exposeInMainWorld("betterClaudeCode", {
  // Async rather than a preloaded value, for the same reason the bridge itself
  // is synchronous: the settings arrive over IPC, and the page is already
  // running by then. terminal.js awaits this before constructing the terminal.
  getSettings: () => ipcRenderer.invoke("settings:get"),

  // Renderer -> main. `ready` reports the measured grid so the first pty is
  // spawned at the right size; `restart` re-launches after an exit.
  ready: (cols, rows) => ipcRenderer.send("code:ready", { cols, rows }),
  restart: (cols, rows) => ipcRenderer.send("code:restart", { cols, rows }),
  // The ONLY path into the child's stdin. Nothing else in this file or in
  // main.js writes to it.
  write: (data) => ipcRenderer.send("code:input", String(data)),
  resize: (cols, rows) => ipcRenderer.send("code:resize", { cols, rows }),
  pickFolder: () => ipcRenderer.invoke("code:pick-folder"),
  closeWindow: () => ipcRenderer.invoke("code:window-close"),

  // main -> renderer.
  onData: forward("code:data"),
  onStarted: forward("code:started"),
  onExit: forward("code:exit"),
  onFatal: forward("code:fatal"),
  onRestarting: forward("code:restarting"),
  onSettingsChanged: (cb) => {
    settingsListeners.push(cb);
    if (latestSettings) cb(latestSettings);
  },
});

async function bootstrap() {
  await new Promise((resolve) => {
    if (document.readyState !== "loading") resolve();
    else document.addEventListener("DOMContentLoaded", resolve);
  });

  // Same lazy require, and the same reason, as in electron/preload.js:
  // @codemirror/view feature-detects against document.body at import time,
  // which is null before DOMContentLoaded. Needed here because the Custom CSS
  // section mounts the editor.
  const cssEditor = require("../build/css-editor.bundle.js");

  injectStaticCSS("betterclaude-squircle-css", path.join(__dirname, "../ui/squircle.css"));
  injectStaticCSS("betterclaude-titlebar-css", path.join(__dirname, "../ui/title-bar.css"));
  injectStaticCSS("betterclaude-panel-css", path.join(__dirname, "../ui/settings-panel/panel.css"));
  // overlays.css carries the shared popover/notification styling the colour
  // picker and the panel's toasts rely on.
  injectStaticCSS("betterclaude-overlays-css", path.join(__dirname, "../ui/overlays.css"));
  // Last, so this window's own layout wins over the shared chrome sheets.
  injectStaticCSS("betterclaude-code-window-css", path.join(__dirname, "../ui/code-window.css"));
  // `bc-embedded` removes the title-bar inset and the window-chrome affordances
  // in ui/code-window.css. Applied to <html> rather than <body> so it lands
  // before first paint — <body> may not exist yet at this point in bootstrap.
  if (IS_EMBEDDED) document.documentElement.classList.add("bc-embedded");

  let settings = await ipcRenderer.invoke("settings:get");
  const themes = await ipcRenderer.invoke("themes:get-all");

  // Update status is broadcast to every window, so this one can show the same
  // Appearance -> Updates box as the main window instead of an empty panel.
  let updateStatus = { state: "idle" };
  const updateStatusListeners = [];
  ipcRenderer.on("betterclaude:update-status", (_e, status) => {
    updateStatus = status;
    updateStatusListeners.forEach((cb) => cb(status));
  });

  // --- Theme ---
  // The real engine, driven exactly as the main window drives it, so a theme
  // switch here goes through the same code path rather than a second
  // implementation that could drift from it. applySettings() writes the theme
  // stylesheet, the --bc-* scaffold (including --bc-code-font and
  // --bc-ui-font), the custom CSS layer and the accent-derived variables.
  // Its claude.ai-specific selectors simply match nothing in this document.
  const themeEngine = new ThemeEngine({ presets: themes });
  themeEngine.applySettings(settings);
  // The stylesheet is in the document now, so the page can safely sample the
  // theme's --bc-* values for its terminal palette.
  publishSettings(settings);

  // --- Settings panel (appearance scope) ---
  const setSetting = async (keyPath, value) => {
    settings = await ipcRenderer.invoke("settings:set", keyPath, value);
    return settings;
  };

  // Cosmetic writes go through appearance:set-cosmetic, not settings:set, so
  // editing a colour here snapshots the active preset into a Custom appearance
  // exactly as it does in the main window — otherwise a tweak made from this
  // window would silently ride on top of a preset that is meant to stay
  // pristine (see the comment on that handler in electron/main.js).
  const setCosmetic = async (keyPath, value) => {
    settings = await ipcRenderer.invoke("appearance:set-cosmetic", keyPath, value);
    return settings;
  };

  const selectTheme = async (themeId) => {
    settings = await ipcRenderer.invoke("appearance:select-theme", themeId);
    return settings;
  };

  // Minimal toast. The main window's notify() routes through the full
  // notification system (categories, quiet hours, sounds); none of that is
  // wired up in this window, and a silent no-op would swallow the panel's
  // "Settings exported" / "Theme imported" confirmations.
  function notify(message) {
    const el = document.createElement("div");
    el.className = "bc-code-toast";
    el.textContent = message;
    Object.assign(el.style, {
      position: "fixed",
      bottom: "18px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      padding: "9px 16px",
      borderRadius: "10px",
      font: "12px var(--bc-ui-font, system-ui, sans-serif)",
      color: "var(--bc-text, #ece7fb)",
      background: "var(--bc-bg-elevated, #1c1630)",
      border: "1px solid var(--bc-border, #2c2347)",
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  const panelHost = {
    getSettings: () => settings,
    setSetting,
    onSettingsChanged: (cb) => settingsListeners.push(cb),
    notify,

    // Themes
    listThemeIds: () => Object.keys(themes),
    getThemesData: () => themes,
    listUserThemeIds: () => ipcRenderer.invoke("themes:list-user-ids"),
    selectTheme,
    applyThemePreview: (id) => themeEngine.setTheme(id),
    applyCustomCSSPreview: (code) => themeEngine.setCustomCSS(code),
    applyAccentPreview: (hex) => themeEngine.setAccentColor(hex),
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
    // Vibe bundles write several cosmetic keys at once; setCosmetic keeps that
    // on the Custom-appearance path like every other cosmetic write.
    applyVibeBundle: async (bundleId) => {
      const { VIBE_BUNDLES, applyBundle } = require("../core/vibe-bundles");
      const bundle = VIBE_BUNDLES.find((b) => b.id === bundleId);
      if (bundle) await applyBundle(bundle, { setSetting: setCosmetic, selectTheme });
    },
    surpriseMe: async () => {
      const { pickRandomBundle, applyBundle } = require("../core/vibe-bundles");
      const bundle = pickRandomBundle();
      if (bundle) await applyBundle(bundle, { setSetting: setCosmetic, selectTheme });
    },

    // Custom CSS editor
    mountCSSEditor: (container, opts) => cssEditor.mount(container, opts),

    // Appearance section: backup + updates + version line
    exportSettings: () => ipcRenderer.invoke("settings:export"),
    importSettings: () => ipcRenderer.invoke("settings:import"),
    getAppInfo: () => ipcRenderer.invoke("app:get-info"),
    getUpdateStatus: () => updateStatus,
    onUpdateStatus: (cb) => updateStatusListeners.push(cb),
    checkForUpdates: () => ipcRenderer.invoke("updater:check"),
    downloadUpdate: () => ipcRenderer.invoke("updater:download"),
    installUpdate: () => ipcRenderer.invoke("updater:install"),
    openReleasesPage: () => ipcRenderer.invoke("updater:open-releases"),
  };

  const settingsPanel = new SettingsPanel(panelHost, { sections: CODE_WINDOW_SECTIONS });

  ipcRenderer.on("betterclaude:settings-changed", (_e, updated) => {
    settings = updated;
    // CSS first, then notify: ui/code-window/terminal.js rebuilds its xterm
    // palette by reading computed --bc-* values, so it has to run after the new
    // stylesheet is in the document or it would sample the previous theme.
    themeEngine.applySettings(settings);
    publishSettings(settings);
  });

  // --- Title bar ---
  // The same component the main window mounts, with this window's own label and
  // window-control callbacks. The settings button is the component's existing
  // slot, not a second one bolted on here.
  const logoSrc = "data:image/png;base64," +
    fs.readFileSync(path.join(__dirname, "../assets/logo-mark.png")).toString("base64");

  if (IS_EMBEDDED) {
    // Embedded as the main window's second tab, so the window already has a
    // title bar directly above this pane — mounting a second one would draw two
    // stacked bars and, worse, a second drag region and a second set of window
    // controls for the same window.
    //
    // The settings affordance still has to exist: it is the only way into
    // themes/presets for this pane. It moves into the pane's own status row,
    // which is BetterClaude chrome that already sits at the top of the pane.
    const statusRow = document.getElementById("bc-code-status");
    if (statusRow) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = "bc-code-settings-btn";
      btn.title = "BetterClaude Settings (Cmd/Ctrl+,)";
      btn.setAttribute("aria-label", "BetterClaude Settings");
      const img = document.createElement("img");
      img.src = logoSrc;
      img.alt = "";
      btn.appendChild(img);
      btn.addEventListener("click", () => settingsPanel.toggle());
      statusRow.appendChild(btn);
    }
  } else {
    mountTitleBar({
      title: "BetterClaude · Code",
      logoSrc,
      // Sender-scoped channels: the existing `window:*` handlers are hard-wired
      // to the main window, so reusing them here would minimize or close
      // claude.ai instead of this pane.
      minimize: () => ipcRenderer.invoke("code:window-minimize"),
      maximizeToggle: () => ipcRenderer.invoke("code:window-maximize-toggle"),
      close: () => ipcRenderer.invoke("code:window-close"),
      openSettings: () => settingsPanel.toggle(),
    });
  }

  // Same accelerator the main window uses for Settings, so the shortcut means
  // the same thing in whichever window has focus.
  ipcRenderer.on("betterclaude:toggle-settings", () => settingsPanel.toggle());
}

bootstrap().catch((err) => console.error("[BetterClaude] code-window preload failed", err));
