/**
 * Platform-agnostic settings shape + defaults.
 * No Node/Electron APIs here — usable from a browser extension content
 * script as-is, and from the Electron main process for schema defaults.
 */

const DEFAULT_SETTINGS = {
  general: {
    // Master kill-switch: when false, all BetterClaude theming/chrome/
    // plugins are torn down and the app reverts to stock claude.ai. Kept
    // separate from `appearance` so it's trivial to check first, before
    // any other section is even consulted.
    enabled: true,
  },
  appearance: {
    // Fresh installs open on the product identity theme. Existing stored
    // activeTheme values are deep-merged over this fallback and remain intact.
    activeTheme: "betterclaude-default",
    // "custom" keeps a frozen copy of the preset that was active when the
    // user first adjusted a cosmetic control. This makes the state honest:
    // a preset card always means its untouched defaults, while manual work
    // is visibly a separate Custom appearance.
    customThemeBase: null,
    customThemeCSS: "",
    accentColor: "#6059e6",
    // Theme ids the user has starred, shown pinned to the top of the
    // Themes grid. Ids only — resolved against whatever theme set
    // (builtin + imported) is loaded at render time.
    favoriteThemes: [],
    // Automatic theme switching. "off" leaves activeTheme in full manual
    // control; "time" swaps between lightThemeId/darkThemeId at the given
    // HH:MM boundaries; "os" follows the OS light/dark setting. In either
    // automatic mode, activeTheme itself is left untouched in storage so
    // switching back to "off" cleanly restores the manually-picked theme.
    schedule: {
      mode: "off", // "off" | "time" | "os" | "season"
      lightThemeId: "arctic-light",
      darkThemeId: "betterclaude-default",
      lightStart: "07:00",
      darkStart: "19:00",
    },
    // One universal Okabe-Ito-based substitution rather than three separate
    // per-condition simulations: that palette was designed to already read
    // safely for deuteranopia/protanopia/tritanopia at once, so a single
    // toggle is both simpler and more honest than faking three modes.
    colorBlindSafe: false,
    // Independent of any theme's own contrast: boosts text weight, border
    // strength and focus-ring thickness on top of whatever theme is active.
    contrastBoost: false,
    // Frosted-glass backdrop-filter on BetterClaude's own overlays (settings
    // panel, HUD, plugin popovers) — never claude.ai's own page chrome.
    glassPanels: false,
    weatherTheme: {
      enabled: false,
      lat: null,
      lon: null,
    },
  },
  appearanceEditor: {
    // No-code visual overrides, keyed by the same --bc-* CSS variable names
    // the theme system already uses. Rendered into customCSS.code (inside
    // marker comments) so it stays in sync with the Custom CSS tab instead
    // of being a second, competing styling mechanism.
    colors: {},
    // Shape drives radius as a ratio of control height (§2.1), never a raw
    // pixel value: "sharp" | "soft" | "rounded" | "pill". Every ratio is
    // <= 0.5 so radius <= height/2 is guaranteed — no square-cornered
    // "rounded" buttons and no lobed shapes.
    shape: "rounded",
    // Real size multiplier applied through height/padding/font (reflow), not
    // transform: scale(). Bounded so text can't clip and neighbors can't
    // overflow (§2.2).
    sizeScale: 1,
    // Deprecated, kept so old settings files still load. buttonScale folds
    // into sizeScale; radiusScale is superseded by `shape`.
    buttonScale: 1,
    radiusScale: 1,
  },
  background: {
    // Customizable background for the MAIN CHAT PANE ONLY (§4.1) — never the
    // sidebar, top bar, or modals unless unifyAllSurfaces is set.
    mode: "off", // "off" | "solid" | "gradient" | "image"
    color: "#11121a",
    gradient: "linear-gradient(135deg, #191a25, #11121a)",
    imageDataUrl: "", // data: URI so it survives without file:// access under CSP
    fit: "cover", // "cover" | "contain" | "tile" | "center"
    position: "center",
    // Pan (percent, CSS background-position-x/y semantics) + zoom (percent,
    // 100 = no zoom) for the image editor's drag-to-reposition/zoom controls.
    // Independent of `fit`/`position` above, which stay as the fallback for
    // gradient/solid or a saved snapshot from before the editor existed.
    offsetX: 50,
    offsetY: 50,
    zoom: 100,
    flipH: false,
    flipV: false,
    // Color filters applied to the image layer only (never the scrim/text).
    // Values are the literal CSS filter() function arguments; 100 is always
    // "unchanged" for the percentage ones so a fresh image looks untouched.
    filter: {
      brightness: 100,
      contrast: 100,
      saturate: 100,
      grayscale: 0,
      sepia: 0,
      hueRotate: 0,
    },
    opacity: 1,
    // Scrim between background and text; contrast is enforced against this.
    scrimColor: "#000000",
    scrimOpacity: 0.35,
    blurPx: 0,
    animated: false, // respected only when prefers-reduced-motion is not set
    unifyAllSurfaces: false,
    // Rotates through a small pool of saved background snapshots on a timer.
    // Each pool entry is a subset of this same object's shape (mode/color/
    // gradient/imageDataUrl/fit) — scrim/opacity/blur stay global.
    rotation: {
      enabled: false,
      intervalMinutes: 60,
      pool: [],
    },
  },
  customCSS: {
    code: "",
  },
  fonts: {
    uiFont: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
    codeFont: "SFMono-Regular, Menlo, Consolas, monospace",
    baseSizePx: 15,
    lineHeight: 1.5,
    letterSpacingPx: 0,
    // Empty = inherit uiFont. Applied to markdown h1-h3 in assistant
    // responses only, so body text keeps the separately-chosen uiFont.
    headingFont: "",
    headingWeight: 700,
    // Body text weight as a real variable-font axis, not a bold/regular
    // binary. font-variation-settings falls back harmlessly on fonts
    // without a wght axis.
    fontWeight: 400,
    // Typographic approximation (wider letter/line spacing + a rounded
    // sans-serif fallback stack), not the actual OpenDyslexic font binary.
    dyslexiaMode: false,
  },
  layout: {
    // null = don't touch claude.ai's own sidebar width at all. Forcing a
    // fixed pixel width (even one that "sounds" reasonable) can trip
    // claude.ai's own responsive/collapse logic and drop it into an
    // icon-only rail with no chat names — so this only kicks in once a
    // user explicitly picks a width in Settings -> Layout.
    sidebarWidthPx: null,
    sidebarPosition: "left", // "left" | "right"
    compactMode: false,
    hiddenElements: [], // array of element keys, see core/theme-engine.js SELECTORS
    // Superset of compactMode: "compact" keeps compactMode's existing CSS
    // path, "spacious" is new (extra breathing room), "comfortable" is the
    // default (today's normal spacing).
    density: "comfortable", // "compact" | "comfortable" | "spacious"
    // View + pin state for the Widget Gallery (settings -> Widgets) — the
    // one surface in this app that's fully ours to relayout, unlike
    // claude.ai's own conversation view.
    widgetGalleryView: "grid", // "grid" | "list" | "card"
    pinnedWidgets: [],
  },
  plugins: {
    // pluginId -> boolean enabled
    enabled: {
      "markdown-plus": true,
      // Off by default: this floats over the bottom-left corner unprompted,
      // which overlaps the sidebar. Users can flip it on from Settings ->
      // Plugins if they want the canned-prompt shortcuts.
      "quick-prompts": false,
      "focus-mode": false,
      // Off by default: adds a floating icon button unprompted, same
      // rationale as quick-prompts above.
      "snippet-library": false,
      // New widget plugins (Settings -> Widgets gallery), each adds a dock
      // button — off by default for the same reason quick-prompts/
      // snippet-library are: nobody asked for an extra floating icon yet.
      "pomodoro-timer": false,
      "quote-of-the-day": false,
      "sticky-notes": false,
      "world-clock": false,
      "goal-tracker": false,
    },
    data: {},
  },
  keyboardShortcuts: {
    toggleSettings: "CommandOrControl+,",
    toggleAlwaysOnTop: "CommandOrControl+Shift+T",
    openPromptPicker: "CommandOrControl+Shift+P",
  },
  // Native File Watcher Sync — "attach" inserts the file's content as a
  // labeled fenced code block (core/file-sync-indicator.js), not a fake of
  // claude.ai's own native upload UI. "stale" means the disk file changed
  // since it was last inserted and auto-reattach couldn't (or wasn't asked
  // to) find-and-replace it in an unsent composer.
  fileWatcher: {
    enabled: true,
    // { id, path, label, autoReattach, lastDiskContent, stale, lastSyncedAt }
    // The composer marker is derived from `label` (see core/file-sync-
    // indicator.js's marker()), not stored separately.
    watched: [],
  },
  // Usage Analytics Dashboard — off by default, like the other background-
  // logging features (skillMarketplace). Historical charts are built from
  // usage events logged locally as you go (electron/analytics-db.js, a WASM
  // SQLite database under userData/analytics.sqlite).
  analytics: {
    enabled: false,
  },
  // Team/Shared Plugin Sync — off by default. Points at a git repo of
  // *.claudeplugin.js / theme *.css files (electron/team-sync.js shells out
  // to the system `git` to clone/pull it), copied into the same userData/
  // plugins and userData/themes directories any manually-added plugin or
  // theme already lives in. manifest tracks the hash last applied per repo
  // file so a later sync can tell "repo changed" apart from "the user
  // edited their local copy" — see electron/team-sync.js's classify().
  // intervalMinutes: 0 = manual sync only ("Sync now" in Settings).
  teamSync: {
    enabled: false,
    repoUrl: "",
    branch: "main",
    intervalMinutes: 0,
    autoApply: true,
    lastSyncedAt: null,
    lastSyncError: null,
    manifest: {}, // relPath -> { hash, kind: "plugin"|"theme" }
    conflicts: [], // { relPath, kind, filename } — both repo and local changed since last sync
    pendingUpdates: [], // { relPath, kind, filename } — only populated when autoApply is false
  },
  // Cross-Device Clipboard Bridge — off by default (it's both a network
  // feature and one that reads/writes the OS clipboard). Payloads are
  // end-to-end encrypted with a key derived from `passphrase` before ever
  // leaving the device (see core/clipboard-bridge.js) — relayUrl points at
  // a self-hosted relay (reference implementation: scripts/clipboard-relay-
  // server.js) or any HTTP endpoint speaking the same tiny put/pull
  // protocol, and only ever sees ciphertext. Connection status is polled
  // live (electron/main.js), never persisted beyond lastSyncedAt.
  clipboardBridge: {
    enabled: false,
    relayUrl: "",
    passphrase: "",
    deviceName: "",
    pollIntervalSeconds: 5,
    ttlMinutes: 5,
    lastSyncedAt: null,
  },
  // GitHub-backed catalog of public Claude Skill repos. Off by default (it's
  // a network feature that hits api.github.com) — see ui/settings-panel/
  // sections/skill-marketplace.js. "Install" only ever downloads SKILL.md +
  // assets to a local folder; claude.ai has no public API to register a
  // Skill programmatically, so BetterClaude never attempts that.
  skillMarketplace: {
    enabled: false,
    githubToken: "",
    cacheTTLMinutes: 60,
    // Last catalog fetch, refreshed by electron/main.js's skills:refresh-cache
    // handler. items: raw (trimmed) GitHub search-result objects.
    cache: { items: [], fetchedAt: null },
    // installId ("<owner>-<repo>") -> { owner, repo, branch, commitSha, installedAt, path }
    installed: {},
  },
  promptLibrary: {
    enabled: true,
    // { id, title, body, tags: [], folder, shortcut, createdAt, updatedAt }
    prompts: [],
    folders: [],
  },
  cursor: {
    style: "default", // "default" | "dot" | "crosshair"
    trail: "off", // "off" | "sparkles" | "particles" | "comet"
    trailDensity: 0.5,
    ripple: true,
    magnetic: false,
    magneticStrength: 0.4,
    // Right-click quick-action menu (replaces claude.ai's own context menu
    // with a small radial of BetterClaude actions).
    radialMenu: true,
    // User-chosen order for the plugin dock icons; empty = load order.
    dockOrder: [],
  },
  sound: {
    pack: "off", // "off" | "8bit" | "minimal" | "soft" — all procedural (Web Audio), no shipped audio files
    muted: false,
    volume: 0.6,
    perType: {
      click: true,
      hover: false,
      notification: true,
      achievement: true,
    },
    ambient: {
      track: "off", // "off" | "rain" | "cafe" | "lofi" — procedurally generated noise
      volume: 0.3,
    },
    // Visual micro-pulse substitute — desktop has no rumble motor.
    hapticsIntensity: 0.5,
  },
  motion: {
    speed: 1, // 0 = fully off .. 1 = normal .. 2 = double speed
    transition: "fade", // "fade" | "slide" | "zoom" | "none" — applied to BetterClaude's own overlays
    easing: "smooth", // "smooth" | "bouncy"
    // false (default) = respect the OS "reduce motion" preference; true =
    // play full motion regardless. There's no separate "respect" flag —
    // respecting the system setting is just the absence of this override.
    overrideReducedMotion: false,
    confetti: true,
    parallax: false,
    seasonalDecorations: false,
  },
  notifications: {
    style: "banner", // "banner" | "popup" | "badge"
    dnd: {
      enabled: false,
      start: "22:00",
      end: "08:00",
    },
    // Per-category on/off + custom color/icon. achievement/update are the
    // only two that may bypass DND (see core/notifications.js PRIORITY).
    types: {
      theme: { enabled: true, color: "#8b5cf6", icon: "" },
      plugin: { enabled: true, color: "#8b5cf6", icon: "" },
      achievement: { enabled: true, color: "#f5c518", icon: "" },
      update: { enabled: true, color: "#22c55e", icon: "" },
    },
    // Smart Notification Digest — off by default. When on, background
    // task-completion notifications (Team Sync applied files, clipboard
    // synced, skill installed, etc. — anything passed a `category`)
    // are queued instead of shown one at a time, then flushed as one native
    // OS notification per interval summarizing what changed. Failures always
    // bypass the queue (electron/preload.js's notify() `urgent` option) and
    // fire immediately as both an in-page toast and a native notification —
    // this only changes *routine* completions, never error visibility.
    digest: {
      enabled: false,
      intervalMinutes: 15,
    },
  },
  focusReading: {
    // Layers on top of the existing Focus Mode plugin's own `active` flag
    // (settings.plugins.data["focus-mode"].active) rather than
    // re-implementing DOM detachment: Zen Mode = Focus Mode + dock/HUD hidden.
    zenMode: false,
    readingMode: false,
    readingWidthPx: 680,
    // Reading mode always applies a contrast boost while active (legibility
    // is the point) — the general, independent toggle for everyday use
    // lives at appearance.contrastBoost.
    readingFont: "", // empty = inherit fonts.uiFont
  },
  personality: {
    // Keep the app's first-run surface focused on Claude itself; the mascot
    // is opt-in from Settings -> Personality & Fun.
    companionEnabled: false,
    userName: "",
    statusMessage: "",
    greetingStyle: "timeOfDay", // "timeOfDay" | "streak" | "name"
    mood: null, // "energetic" | "calm" | "focused" | "playful" | null
    streak: { count: 0, lastActiveDate: "" },
    achievements: [], // unlocked achievement ids, see core/companion.js CATALOG
    avatar: { shape: "circle", color: "#8b5cf6", accessory: "none" },
    // User-added entries merged into core/motion-fx.js's built-in
    // LOADING_TIPS pool (real + joke), shown while claude.ai's page loads.
    customLoadingTips: { real: [], joke: [] },
    // Konami-code unlock gate for themes/secret-rainbow.css.
    easterEggs: { konamiUnlocked: false },
  },
  commandPalette: {
    // Bounded to "set setting X to value Y" (no arbitrary code execution).
    customCommands: [], // [{id, label, settingPath, value}]
  },
  profiles: {
    // Also backs the "Time Capsule" feature — same snapshot/restore
    // primitive, just named/framed differently in the UI.
    list: [], // [{id, name, icon, createdAt, snapshot}]
  },
  automations: {
    // Curated, reliable toggles rather than a free-form rule builder.
    zenMutesSound: false,
    achievementBurstsConfetti: true,
    focusPausesAmbient: true,
  },
  window: {
    width: 1280,
    height: 860,
    x: undefined,
    y: undefined,
    alwaysOnTop: false,
  },
};

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

// Deep merge so newly-added nested keys (e.g. a new entry under
// plugins.enabled, or a new field under appearance.schedule) still get
// their default value for installs that have an on-disk settings file
// predating that key, instead of silently vanishing because the old
// one-level-deep merge let `stored`'s object fully replace `out`'s.
// Arrays and primitives still take `stored`'s value wholesale — merging
// arrays element-by-element isn't meaningful for things like
// hiddenElements/favoriteThemes.
function deepMerge(defaults, stored) {
  if (!isPlainObject(defaults)) return stored !== undefined ? stored : defaults;
  const out = { ...defaults };
  if (!isPlainObject(stored)) return out;
  for (const key of Object.keys(stored)) {
    out[key] = isPlainObject(defaults[key]) ? deepMerge(defaults[key], stored[key]) : stored[key];
  }
  return out;
}

// BOUNDS lives in core/tokens.js so the UI (live slider min/max), the auditor
// (extreme-value checks) and this load-time clamp can never disagree about
// what "too far" is. Required lazily to keep settings-schema import-cheap and
// dependency-light for the Electron main process.
function getBounds() {
  try {
    return require("./tokens").BOUNDS;
  } catch (_e) {
    return {};
  }
}

function getAtPath(obj, keyPath) {
  return keyPath.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setAtPath(obj, keyPath, value) {
  const parts = keyPath.split(".");
  const last = parts.pop();
  const parent = parts.reduce((o, k) => (o[k] = o[k] || {}), obj);
  parent[last] = value;
}

// Clamp every bounded numeric setting to its engineered range so a manually
// edited settings file, an out-of-bounds imported theme/settings blob, or an
// old-schema value can never reintroduce the extreme-value bugs this whole
// system exists to prevent (§5.3). Non-finite values fall back to the default.
function clampSettings(settings) {
  const bounds = getBounds();
  Object.entries(bounds).forEach(([keyPath, spec]) => {
    const current = getAtPath(settings, keyPath);
    if (current === undefined) return; // key absent -> leave default in place
    const clamped = spec.nullable && current == null
      ? null
      : (() => {
          const n = Number(current);
          if (!Number.isFinite(n)) return spec.default;
          return Math.max(spec.min, Math.min(spec.max, n));
        })();
    setAtPath(settings, keyPath, clamped);
  });
  // Enum fields: fall back to default if a stored value is unrecognized.
  const ae = settings.appearanceEditor;
  if (ae && !["sharp", "soft", "rounded", "pill"].includes(ae.shape)) ae.shape = "rounded";
  const bg = settings.background;
  if (bg && !["off", "solid", "gradient", "image"].includes(bg.mode)) bg.mode = "off";
  if (bg && !["cover", "contain", "tile", "center"].includes(bg.fit)) bg.fit = "cover";

  const appearance = settings.appearance;
  if (appearance && appearance.schedule && !["off", "time", "os", "season"].includes(appearance.schedule.mode)) {
    appearance.schedule.mode = "off";
  }
  const cursor = settings.cursor;
  if (cursor) {
    if (!["default", "dot", "crosshair"].includes(cursor.style)) cursor.style = "default";
    if (!["off", "sparkles", "particles", "comet"].includes(cursor.trail)) cursor.trail = "off";
  }
  const sound = settings.sound;
  if (sound) {
    if (!["off", "8bit", "minimal", "soft"].includes(sound.pack)) sound.pack = "off";
    if (sound.ambient && !["off", "rain", "cafe", "lofi"].includes(sound.ambient.track)) sound.ambient.track = "off";
  }
  const motion = settings.motion;
  if (motion) {
    if (!["fade", "slide", "zoom", "none"].includes(motion.transition)) motion.transition = "fade";
    if (!["smooth", "bouncy"].includes(motion.easing)) motion.easing = "smooth";
  }
  const notifications = settings.notifications;
  if (notifications && !["banner", "popup", "badge"].includes(notifications.style)) notifications.style = "banner";
  const layout = settings.layout;
  if (layout) {
    if (!["compact", "comfortable", "spacious"].includes(layout.density)) layout.density = "comfortable";
    if (!["grid", "list", "card"].includes(layout.widgetGalleryView)) layout.widgetGalleryView = "grid";
  }
  const personality = settings.personality;
  if (personality) {
    if (!["timeOfDay", "streak", "name"].includes(personality.greetingStyle)) personality.greetingStyle = "timeOfDay";
    if (personality.mood != null && !["energetic", "calm", "focused", "playful"].includes(personality.mood)) {
      personality.mood = null;
    }
  }
  if (settings.skillMarketplace && !Array.isArray(settings.skillMarketplace.cache?.items)) {
    settings.skillMarketplace.cache = { items: [], fetchedAt: null };
  }
  if (settings.promptLibrary && !Array.isArray(settings.promptLibrary.prompts)) settings.promptLibrary.prompts = [];
  if (settings.fileWatcher && !Array.isArray(settings.fileWatcher.watched)) settings.fileWatcher.watched = [];
  if (settings.teamSync) {
    if (!Array.isArray(settings.teamSync.conflicts)) settings.teamSync.conflicts = [];
    if (!Array.isArray(settings.teamSync.pendingUpdates)) settings.teamSync.pendingUpdates = [];
    if (typeof settings.teamSync.manifest !== "object" || settings.teamSync.manifest === null || Array.isArray(settings.teamSync.manifest)) {
      settings.teamSync.manifest = {};
    }
  }
  return settings;
}

function mergeDefaults(stored) {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!stored || typeof stored !== "object") return defaults;
  return clampSettings(deepMerge(defaults, stored));
}

module.exports = { DEFAULT_SETTINGS, mergeDefaults, clampSettings };
