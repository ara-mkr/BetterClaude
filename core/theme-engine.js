/**
 * Theme engine — DOM-only, no Node/Electron APIs.
 * Portable to a browser extension content script unchanged.
 */

const tokens = require("./tokens");
const { cssSelectorList } = require("./claude-dom");
const {
  buildScaffoldCSS,
  extractThemeVars,
  shapeRatio,
  sizeTokens,
  clampNumber,
  BOUNDS,
  focusRingColor,
  deriveAccessibleColor,
  contrastRatio,
  WCAG_AA_BODY,
  SCAFFOLD_PAINTED_BUTTON_ATTRS,
} = tokens;
const { applyBackground } = require("./background");

const THEME_STYLE_ID = "betterclaude-theme";
const CUSTOM_STYLE_ID = "betterclaude-custom-css";
const BASE_STYLE_ID = "betterclaude-base";

// Logical keys -> CSS selectors on claude.ai, used by layout "hide elements"
// and compact mode. Centralized here so both core and plugins can reference
// stable keys instead of hardcoding fragile selectors everywhere.
// Verified against the live site (2026-07-20): claude.ai's own DOM has none
// of the class names or testids these were originally guessed from (no
// "sidebar" class/testid, no <textarea>, no "message"/"composer"/"send"
// testid) — sidebar/composer below are the confirmed-working replacements.
// sidebarToggle and chatHeader happened to already match reality.
// suggestedPrompts is still unverified (couldn't find that surface live) —
// treat it as a guess until it's confirmed against a real "new chat" screen.
// Every entry that names a region core/claude-dom.js already models is derived
// from that adapter's strategy table rather than written out here, so a
// stylesheet and a querySelector can never disagree about what "the sidebar"
// is, and a new Anthropic shape is one edit in one file.
//
// The keys are stable regardless: `layout.hiddenElements` is persisted user
// data holding these names, so renaming one silently drops whatever the user
// had hidden.
const SELECTORS = {
  sidebar: cssSelectorList("sidebar"),
  // claude.ai's own pin/unpin control for the sidebar.
  //
  // KNOWN INERT on builds from ~2026-08 onward: the audit found no
  // `pin-sidebar-toggle` anywhere on the live site — the control was replaced
  // by "Collapse sidebar", which is a different affordance with different
  // consequences. Deliberately NOT retargeted at that button: this key is what
  // the "hide the sidebar pin" setting hides, and quietly repointing it would
  // make that setting remove the user's only way to collapse the sidebar. Left
  // naming the thing it actually means, so the setting is a no-op instead of a
  // surprise. See docs/dom-audit-2026-08-19.md section 2.
  sidebarPin: '[data-testid="pin-sidebar-toggle"]',
  sidebarToggle: 'button[aria-label*="sidebar" i], button[aria-label*="collapse sidebar" i]',
  // Was the bare tag selector `header`, which painted the theme background onto
  // whatever header the page happened to have — including the floating one on
  // Anthropic's /code surface, where it rendered as a stray slab across the
  // top. Now scoped to the content area, with a testid fallback.
  chatHeader: cssSelectorList("chatHeader"),
  composer: cssSelectorList("composer"),
  // Anthropic's Home/Code segmented control. Present so the "hide element"
  // setting can reach it and so ui/title-bar.css can measure against it; never
  // used to intercept or re-route it.
  modeSwitch: cssSelectorList("modeSwitch"),
  suggestedPrompts: '[data-testid="suggested-prompts"]',
};

// Every --bc-* variable a theme preset (bundled or imported) can define.
// Used both by the live "full variable" editor and by buildThemeCSSFromVars
// below to compile a JSON theme import into a real stylesheet. --bc-accent
// and --bc-accent-hover are intentionally excluded from the editable set:
// they're driven by the dedicated accentColor pipeline (an inline style on
// :root always wins over a stylesheet rule), so exposing them here would
// silently do nothing whenever the user also has an accent color set.
const THEME_VAR_DEFS = [
  { key: "--bc-bg", label: "Background", type: "color", default: "#14101f" },
  { key: "--bc-bg-elevated", label: "Composer / panel background", type: "color", default: "#1c1630" },
  { key: "--bc-bg-sidebar", label: "Sidebar background", type: "color", default: "#100c1c" },
  { key: "--bc-text", label: "Text", type: "color", default: "#ece7fb" },
  { key: "--bc-text-muted", label: "Muted text", type: "color", default: "#a99bd1" },
  { key: "--bc-border", label: "Borders", type: "color", default: "#2c2347" },
  { key: "--bc-bubble-user", label: "Your message bubble", type: "color", default: "#2a1f4d" },
  { key: "--bc-bubble-assistant", label: "Assistant message bubble", type: "color", default: "transparent" },
  { key: "--bc-danger", label: "Destructive / delete", type: "color", default: "#ef4444" },
];

// Compiles a vars-only theme (e.g. an imported .json theme, which has no
// selectors of its own) into a full stylesheet using the same
// selector/variable scaffold every bundled preset in themes/*.css now shares.
// Delegating to core/tokens.buildScaffoldCSS keeps ONE styling path: imported,
// generated and bundled themes all get the identical state-machine tokens,
// relational radius, focus-visible rings and touch-gated hover (§1, §2, §3).
// Guessing dark vs light from the background luminance lets derived hover/
// active states brighten (dark) or darken (light) correctly (§3).
function buildThemeCSSFromVars(vars = {}, name = "Imported Theme") {
  const merged = {};
  THEME_VAR_DEFS.forEach((d) => { merged[d.key] = vars[d.key] || d.default; });
  Object.assign(merged, vars);
  const isDark = tokens.relativeLuminance(merged["--bc-bg"] || "#14101f") < 0.4;
  return buildScaffoldCSS(merged, { name, isDark });
}

// Pure decision function for scheduled/automatic theme switching — no
// timers or DOM access, so it's trivially unit-testable and callable from
// either preload's setInterval loop or (should the schedule ever need to
// react instantly) an OS theme-change event handler.
// Returns a themeId to apply, or null if the schedule is off / incomplete.
function resolveScheduledTheme(schedule, { now = new Date(), isDarkOS = false } = {}) {
  if (!schedule || schedule.mode === "off" || !schedule.mode) return null;

  if (schedule.mode === "os") {
    return isDarkOS ? schedule.darkThemeId : schedule.lightThemeId;
  }

  if (schedule.mode === "time") {
    const toMinutes = (hhmm) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const lightMin = toMinutes(schedule.lightStart);
    const darkMin = toMinutes(schedule.darkStart);
    if (lightMin == null || darkMin == null) return null;

    // Typical schedules wrap past midnight (e.g. dark starts 19:00, light
    // starts 07:00 the next day) — darkMin > lightMin in that case, and the
    // dark window is "from darkStart to end of day, or before lightStart".
    // The non-wrapping case (darkMin < lightMin, e.g. dark 02:00-07:00) is a
    // plain same-day range.
    const inDarkWindow = darkMin > lightMin
      ? (nowMin >= darkMin || nowMin < lightMin)
      : (nowMin >= darkMin && nowMin < lightMin);
    return inDarkWindow ? schedule.darkThemeId : schedule.lightThemeId;
  }

  return null;
}

function lighten(hex, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const channel = (shift) => {
    const c = (num >> shift) & 0xff;
    return Math.max(0, Math.min(255, Math.round(c + (255 - c) * amount)));
  };
  const r = channel(16), g = channel(8), b = channel(0);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// Syncs claude.ai's OWN light/dark mode to the active BetterClaude theme
// (§4.1 systemic fix): painting the composer card alone only fixes the
// composer — every other native-background surface in claude.ai's own
// Tailwind-based UI has the identical latent bug (a native surface that
// tracks claude.ai's own dark/light mode, painted independently of
// BetterClaude's --bc-* text color).
//
// WHAT ACTUALLY DRIVES claude.ai's COLOR MODE (measured, not assumed)
//
// This used to toggle a `dark` class on <html> and stop there. A live probe
// of the shipped site (2026-08-19, build 2e4d689a34) settled what that was
// worth: claude.ai's stylesheets contain ZERO `.dark` class selectors and 41
// `[data-mode=...]` ones. The class toggle was a no-op against every rule on
// the page, so the "systemic fix" above never actually fired — which is the
// whole reason a LIGHT BetterClaude theme rendered as its near-black text
// forced on top of claude.ai's still-dark native surfaces. Unreadable, and
// the single largest source of "the theme doesn't apply properly".
//
// The real switch is the `data-mode` attribute, and it is NOT only on <html>:
// the probe found it re-declared on descendants too (`div.dframe-root.cds-root
// [data-mode="dark"]` wraps the whole app frame). A rule written as
// `[data-mode="dark"] .dframe-sidebar` matches off the NEAREST such ancestor,
// so flipping <html> alone leaves every one of those subtrees in the old mode.
// Every mode-carrying element has to move together.
//
// The one thing that must NOT move: claude.ai reuses `data-mode` for its
// Home/Code segmented control (`button.df-pill[data-mode="cowork"|"code"]`) —
// same attribute, entirely unrelated meaning. Rewriting those would retarget
// its navigation pills. Hence MODE_VALUES: only elements whose current value
// is literally "light" or "dark" are ever touched.
const DARK_LUMINANCE_THRESHOLD = 0.4;

// The only two values that mean "color mode". Anything else carrying
// data-mode (the cowork/code nav pills) is a different feature wearing the
// same attribute name and is left strictly alone.
const MODE_VALUES = new Set(["light", "dark"]);
const MODE_SELECTOR = '[data-mode="light"],[data-mode="dark"]';

// Captured once, the first time BetterClaude ever touches the page, so the
// master kill-switch can restore claude.ai's own original state exactly
// rather than guessing a default. Module-level (not per-ThemeEngine-instance)
// because <html> is a single shared DOM node regardless of how many
// ThemeEngine instances exist.
let _originalColorModeState = null;

// The mode we last applied, remembered so the observer below can re-assert it
// without needing the theme CSS again. null means "BetterClaude isn't managing
// the mode right now" (never applied, or restored by the kill-switch).
let _managedIsDark = null;
let _modeObserver = null;

function modeCarryingElements() {
  const out = [document.documentElement];
  // Descendants that re-declare the mode for their own subtree. Only ever
  // light/dark — the selector itself excludes the nav pills by value.
  document.querySelectorAll(MODE_SELECTOR).forEach((el) => {
    if (el !== document.documentElement) out.push(el);
  });
  return out;
}

function writeMode(isDark) {
  const value = isDark ? "dark" : "light";
  modeCarryingElements().forEach((el) => {
    // Never invent the attribute on an element that didn't have it; only
    // <html> is written unconditionally, because that's the documented root.
    if (el === document.documentElement || MODE_VALUES.has(el.getAttribute("data-mode"))) {
      if (el.getAttribute("data-mode") !== value) el.setAttribute("data-mode", value);
    }
  });
  document.documentElement.style.colorScheme = value;
  // Kept purely as a belt-and-braces hook for any future claude.ai build that
  // reintroduces a class-based switch, and because BetterClaude's own
  // stylesheets are free to key off it. Costs one classList write.
  document.documentElement.classList.toggle("dark", isDark);
}

// claude.ai is React and re-renders its app frame on navigation; a re-render
// rebuilds `div.dframe-root` with Anthropic's own data-mode baked back in, and
// without this the page would silently drift back to its boot mode mid-session
// — the same class of bug as the Code pill needing re-mounting. Rather than
// fight React for ownership, re-assert on mutation, exactly like core/code-tab.js.
function ensureModeObserver() {
  if (_modeObserver || typeof MutationObserver !== "function") return;
  let queued = false;
  _modeObserver = new MutationObserver((records) => {
    if (_managedIsDark === null || queued) return;
    // Only care about data-mode actually disagreeing with us — otherwise every
    // unrelated DOM mutation on a busy page would schedule a write.
    const wanted = _managedIsDark ? "dark" : "light";
    const stale = records.some((r) => {
      if (r.type === "attributes") {
        const v = r.target.getAttribute("data-mode");
        return MODE_VALUES.has(v) && v !== wanted;
      }
      return Array.from(r.addedNodes).some(
        (n) => n.nodeType === 1 && (MODE_VALUES.has(n.getAttribute && n.getAttribute("data-mode")) ||
          (n.querySelector && n.querySelector(MODE_SELECTOR)))
      );
    });
    if (!stale) return;
    queued = true;
    // Coalesce a mutation burst into one write, and stay out of the mutation
    // callback itself so our own attribute writes can't re-enter this handler.
    Promise.resolve().then(() => {
      queued = false;
      if (_managedIsDark !== null) writeMode(_managedIsDark);
    });
  });
  _modeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-mode"],
    subtree: true,
    childList: true,
  });
}

function syncClaudeColorMode(isDark) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (_originalColorModeState === null) {
    _originalColorModeState = {
      colorScheme: root.style.colorScheme || "",
      hadDarkClass: root.classList.contains("dark"),
      // The site's own boot mode, so the kill-switch restores what Anthropic
      // shipped rather than assuming "dark".
      dataMode: root.getAttribute("data-mode"),
    };
  }
  _managedIsDark = isDark;
  writeMode(isDark);
  ensureModeObserver();
}

// Restores claude.ai's own color-mode state exactly as it was before
// BetterClaude ever touched it. Called from the master kill-switch teardown
// path (electron/preload.js applyThemeState's disabled branch) so disabling
// BetterClaude reverts claude.ai to stock, not just to "light".
function restoreClaudeColorMode() {
  if (typeof document === "undefined" || _originalColorModeState === null) return;
  const root = document.documentElement;
  // Stop re-asserting FIRST — otherwise the observer sees the restore as drift
  // and immediately undoes it.
  _managedIsDark = null;
  if (_modeObserver) {
    _modeObserver.disconnect();
    _modeObserver = null;
  }
  root.style.colorScheme = _originalColorModeState.colorScheme;
  root.classList.toggle("dark", _originalColorModeState.hadDarkClass);
  const original = _originalColorModeState.dataMode;
  if (original === null) root.removeAttribute("data-mode");
  else {
    // Put every mode-carrying element back, not just <html> — the same set
    // syncClaudeColorMode moved. claude.ai keeps them in lockstep itself, so
    // the boot value of <html> is the correct value for all of them.
    root.setAttribute("data-mode", original);
    if (MODE_VALUES.has(original)) {
      document.querySelectorAll(MODE_SELECTOR).forEach((el) => {
        if (el !== root) el.setAttribute("data-mode", original);
      });
    }
  }
}

// Single source of truth for "what isDark means for this CSS's --bc-bg",
// shared by applySettings and setTheme so they can't drift on the threshold
// or on how isDark is derived from a theme's palette.
function syncClaudeColorModeFromThemeCSS(css) {
  const bg = extractThemeVars(css)["--bc-bg"];
  if (!bg) return;
  syncClaudeColorMode(tokens.relativeLuminance(bg) < DARK_LUMINANCE_THRESHOLD);
}

function ensureStyleTag(id) {
  let tag = document.getElementById(id);
  if (!tag) {
    tag = document.createElement("style");
    tag.id = id;
    document.head.appendChild(tag);
  }
  return tag;
}

// Non-chrome page-button selector, factored out because both the transparent
// -background rule and the real size system target the same set (everything
// except BetterClaude's own injected UI).
// The four container ids are excluded as DESCENDANTS (`#id *`) because the
// buttons inside them are the chrome. #bc-code-tab-pill is excluded as the
// ELEMENT itself: it is a button in its own right, mounted inside Anthropic's
// nav row, so the descendant form would never match it. Without this it was
// caught by the transparent-background rule below and lost its selected fill.
const PAGE_BTN = `button:not(#bc-code-tab-pill):not(#betterclaude-titlebar *):not(#betterclaude-settings-panel *):not(#betterclaude-hud *):not(#betterclaude-plugin-dock *)`;

// The exclusion list for the "make every other button transparent" rule
// below is built directly from tokens.SCAFFOLD_PAINTED_BUTTON_ATTRS — the
// SAME constant core/tokens.js's buildScaffoldCSS uses to build the
// `button[...]` rules that actually paint a background (send / delete /
// remove). This is the Defect 1 fix: this file used to hand-maintain its own
// `:not([class*="primary"]):not([data-testid*="send"])` list, which drifted
// from tokens.js the moment `button[class*="primary"]` was deliberately
// removed from the scaffold (see the comment on SCAFFOLD_PAINTED_BUTTON_ATTRS
// in tokens.js) — nobody updated the exclusion to match, so buttons with an
// incidental "primary" substring in their class list (claude.ai's own
// `hover:text-primary` utility class on plain icon buttons) received NEITHER
// a transparent background NOR an accent background: they kept claude.ai's
// native light chrome while the forced `color: var(--bc-text)` painted the
// theme's light text on top of it — a ~1:1 contrast button on every dark
// theme. Deriving this list from the shared constant instead of a hand-kept
// copy means the two can never drift again: add a newly-painted selector to
// SCAFFOLD_PAINTED_BUTTON_ATTRS in tokens.js and both the paint rule and this
// exclusion update together.
const PAINTED_BUTTON_ATTRS = [
  ...SCAFFOLD_PAINTED_BUTTON_ATTRS.primary,
  ...SCAFFOLD_PAINTED_BUTTON_ATTRS.destructive,
];
const PAINTED_BUTTON_EXCLUDE = PAINTED_BUTTON_ATTRS.map((attr) => `:not(${attr})`).join("");

// Every element BetterClaude itself injects as a direct child of <body>
// (title bar, settings panel, HUD, plugin dock) — all mounted as siblings of
// claude.ai's own app root, never inside it. Used to scope broad body-wide
// rules (text color, font) to "the actual page" without depending on
// claude.ai's app-root id, which isn't a stable contract (see PAGE_ROOT_SCOPE
// below). Wrapped in :where() by callers so it contributes zero specificity,
// same as the rules it used to gate via #__next/#root.
const OWN_CHROME_IDS = ["betterclaude-titlebar", "betterclaude-settings-panel", "betterclaude-hud", "betterclaude-plugin-dock"];
const OWN_CHROME_EXCLUDE = OWN_CHROME_IDS.map((id) => `:not(#${id}):not(#${id} *)`).join("");

// Scope for "every real element of the actual page". Originally
// `:where(#__next, #root) *`, which silently matched NOTHING (theme text
// color/font never applied, despite bare-tag rules like `button` still
// working) whenever claude.ai's build doesn't wrap its app in a #__next or
// #root element — unlike PAGE_BTN's selectors, that pair was never verified
// against the live site (see the SELECTORS audit note above) and isn't a
// stable contract to depend on. Excluding our own known injected containers
// from a plain `body *` is robust to that DOM detail changing entirely.
const PAGE_ROOT_SCOPE = `body *${OWN_CHROME_EXCLUDE}`;

function buildBaseCSS(settings) {
  const { layout, fonts } = settings;
  const ae = settings.appearanceEditor || {};
  // layout.hideSidebarPin is a first-class setting rather than a preseeded
  // entry in hiddenElements: hiddenElements is a user-editable array, and a
  // default that lives inside an array can't be told apart from a value the
  // user chose, so it would silently come back every time the array was
  // rewritten. Folding it in here keeps one code path for the CSS.
  const hiddenKeys = [
    ...(layout.hiddenElements || []),
    ...(layout.hideSidebarPin ? ["sidebarPin"] : []),
  ];
  const hideRules = [...new Set(hiddenKeys)]
    .map((key) => SELECTORS[key])
    .filter(Boolean)
    .map((sel) => `${sel} { display: none !important; }`)
    .join("\n");

  const hasCustomWidth = layout.sidebarWidthPx != null;

  // Shape + size are authoritative here (base layer carries the user's live
  // choices) and are referenced by the theme scaffold via var() fallbacks, so
  // these always win over a theme's palette layer. Both are clamped against
  // engineered bounds so a hand-edited/out-of-range value can't reach the CSS.
  const ratio = shapeRatio(ae.shape || "rounded");
  const sizeScale = clampNumber(
    ae.sizeScale != null ? ae.sizeScale : ae.buttonScale,
    BOUNDS["appearanceEditor.sizeScale"]
  );
  const st = sizeTokens(sizeScale);
  // Only reshape page buttons when the user actually moved the size control,
  // so default installs leave claude.ai's own button metrics untouched.
  const resizeButtons = Math.abs(sizeScale - 1) > 0.001;

  // Dyslexia mode is a typographic approximation (wider spacing + a rounded
  // sans fallback), not the real OpenDyslexic font file — see
  // ui/settings-panel/panel.js _renderFonts for the same caveat surfaced to
  // the user. It only ever WIDENS spacing/lowers density, never fights a
  // user's own larger explicit choices.
  const dyslexia = !!fonts.dyslexiaMode;
  const uiFontStack = dyslexia ? `'Comic Sans MS', 'Comic Neue', Verdana, ${fonts.uiFont}` : fonts.uiFont;
  const lineHeight = dyslexia ? Math.max(fonts.lineHeight, 1.6) : fonts.lineHeight;
  const letterSpacing = dyslexia ? Math.max(fonts.letterSpacingPx, 0.5) : fonts.letterSpacingPx;
  const headingFont = (fonts.headingFont || "").trim() || "var(--bc-ui-font)";

  return `
:root {
  ${hasCustomWidth ? `--bc-sidebar-width: ${layout.sidebarWidthPx}px;` : ""}
  --bc-ui-font: ${uiFontStack};
  --bc-code-font: ${fonts.codeFont};
  --bc-base-size: ${fonts.baseSizePx}px;
  --bc-line-height: ${lineHeight};
  --bc-letter-spacing: ${letterSpacing}px;
  --bc-font-weight: ${fonts.fontWeight};
  --bc-heading-font: ${headingFont};
  --bc-heading-weight: ${fonts.headingWeight};

  /* Relational radius + size tokens (§2.1, §2.3). radius = height * ratio,
     ratio in [0,0.5] => radius <= height/2 always. Icon clamped to
     ${tokens.SIZE_BASE.iconMinPx}-${tokens.SIZE_BASE.iconMaxPx}px. */
  --bc-shape-ratio: ${ratio};
  --bc-control-height: ${st.controlHeightPx}px;
  --bc-radius: calc(var(--bc-control-height) * var(--bc-shape-ratio));
  --bc-icon-size: ${st.iconPx}px;
  --bc-control-font: ${st.fontPx}px;
  --bc-control-pad-x: ${st.paddingXPx}px;
  --bc-control-pad-y: ${st.paddingYPx}px;
}
/* claude.ai sets font-family/size explicitly on almost every leaf node (its
   own webfont utility classes), so a plain "body { font-family }" rule never
   actually reaches visible text — inheritance only fills in properties
   nothing else declares. :where() matches every real descendant of the page
   (everything under <body> except BetterClaude's own injected chrome, see
   PAGE_ROOT_SCOPE) while contributing ZERO specificity, so this still loses,
   as intended, to the more specific code/heading overrides below and to
   claude.ai's own !important declarations (it has none), while beating
   everything else. */
body, :where(${PAGE_ROOT_SCOPE}) {
  font-family: var(--bc-ui-font) !important;
  font-size: var(--bc-base-size) !important;
  line-height: var(--bc-line-height) !important;
  letter-spacing: var(--bc-letter-spacing) !important;
  font-weight: var(--bc-font-weight) !important;
}
code, pre, kbd, samp {
  font-family: var(--bc-code-font) !important;
}
/* claude.ai's own nav/toolbar icons (sidebar entries, composer buttons, etc.)
   aren't SVGs — they're ligature glyphs from a private-use-area icon font
   (Anthropicons-Variable), set per-element via an inline, non-!important
   style="font-family: var(--font-anthropicons, ...)" on [data-cds="Icon"].
   The blanket rule above still beats that (author-stylesheet !important
   overrides inline non-!important, regardless of specificity), which was
   silently replacing every one of those glyphs with its .notdef fallback
   box — the "all icons look identical/missing" bug. Restore it explicitly. */
[data-cds="Icon"] {
  font-family: var(--font-anthropicons, Anthropicons-Variable) !important;
}
/* Same failure mode as the icon-font fix above, different property: claude.ai
   opts specific compact icon+label controls out of normal line-height via
   Tailwind's leading-none utility (line-height: 1), so a label's line box
   is exactly as tall as its text and sits flush with a fixed-size sibling
   icon — e.g. the model picker's "Sonnet 5 Low" trigger, whose label div is
   text-[14px] h-[14px] leading-none items-baseline next to its chevron.
   The blanket rule above still beats that (measured: computed line-height on
   that div was 22.5px, not the ~14px leading-none gives it), inflating the
   label inside a box that never grows to match — the text sinking below its
   icon rather than staying centered on it. Restore it explicitly.
   The actual text usually lives in a nested div (e.g. the ellipsis-clipping
   label inside the model picker's leading-none wrapper) that relies on
   inheriting line-height: 1 from its leading-none parent instead of
   declaring the utility itself. The blanket body rule above still wins over
   that inheritance (an explicit 0-specificity rule beats an inherited value
   regardless of specificity), re-inflating that inner div's line box past
   its fixed-height container and sinking the text again. Reach descendants
   too. */
.leading-none, .leading-none * {
  line-height: 1 !important;
}
/* Sub-pixel residue from the fix above: the label div's own box still lands
   ~0.5px lower than its fixed-size sibling icon (rounding in claude.ai's own
   layout math, not something a line-height fix can close), and glyph optics
   (no descender in most model names) read as sitting even lower than that.
   Nudge the model picker's label up slightly to compensate. */
[data-testid="model-selector-dropdown"] .leading-none {
  transform: translateY(-1px);
}
/* The model picker trigger's hover/open highlight is a separate absolutely-
   positioned inset-0 layer (class cds-btn-squish) sized to exactly match
   the button's own height, which only leaves ~15px of clearance to the
   composer card's bottom edge — tight enough to read as the glow touching
   the composer border. Inset it a few px on top/bottom so the highlight is
   visibly shorter than the button and sits clear of that edge. */
[data-testid="model-selector-dropdown"] .cds-btn-squish {
  top: 4px !important;
  bottom: 4px !important;
}
/* No "message" testid/class exists on the live site to scope this to, so it
   targets real headings anywhere in the app content instead. :where() keeps
   specificity at zero (matching the body rule above) and, crucially, keeps
   this from ever matching the <h2> section titles inside our OWN settings
   panel (see OWN_CHROME_EXCLUDE), which lives outside the app root as a
   sibling of it. */
:where(body h1${OWN_CHROME_EXCLUDE}), :where(body h2${OWN_CHROME_EXCLUDE}), :where(body h3${OWN_CHROME_EXCLUDE}) {
  font-family: var(--bc-heading-font) !important;
  font-weight: var(--bc-heading-weight) !important;
}
${hasCustomWidth ? `
${SELECTORS.sidebar} {
  width: var(--bc-sidebar-width) !important;
  min-width: var(--bc-sidebar-width) !important;
  max-width: var(--bc-sidebar-width) !important;
  /* claude.ai lays the sidebar out as a flex child; flex-basis wins over
     width/min-width/max-width whenever it's set to something other than
     "auto", which is what was collapsing it to a sliver. Pin flex-basis
     to the same value so the box model actually honors the width above. */
  flex: 0 0 var(--bc-sidebar-width) !important;
}
` : ""}
${layout.sidebarPosition === "right" ? `
${SELECTORS.sidebar} { order: 2 !important; }
/* Sidebar (and its account-switcher footer) moved to the right edge, so the
   left edge is plain main-pane again — undo #bc-companion's default
   sidebar-width offset (ui/overlays.css), which would otherwise land it in
   the middle of the content instead of flush against the now-empty corner. */
#bc-companion { left: 16px !important; }
` : ""}
/* Claude's own button variants already choose readable text color for
   their own background. We force a readable color on all descendant text
   (below) for our theme's dark surfaces, but that same override makes
   buttons whose native background is light (e.g. the logged-out landing
   page's primary CTA) render white-on-white. Only the buttons the scaffold
   itself re-skins with a forced background (PAINTED_BUTTON_ATTRS above —
   currently send / delete / remove) are excluded here; every other button
   gets its inherited background stripped so our forced text color sits on
   the page background instead of an invisible native one.
   Scoped away from our own injected chrome (title bar / settings panel /
   HUD) so it doesn't also blank out our own "bc-btn" buttons.
   PAINTED_BUTTON_EXCLUDE is derived from tokens.SCAFFOLD_PAINTED_BUTTON_ATTRS
   — the SAME list buildScaffoldCSS uses to decide which buttons get a
   painted background — specifically so this exclusion can never drift from
   what the scaffold actually paints again (Defect 1: a
   :not([class*="primary"]) exclusion here outlived the scaffold rule it
   was written for; the scaffold stopped painting button[class*="primary"]
   entirely once that substring match was found to mis-color ordinary
   Tailwind-classed icon buttons on claude.ai, but this file's exclusion list
   was never updated, so buttons matching that stale selector fell through
   both rules and rendered claude.ai's native light chrome under forced theme
   text — invisible white-on-white on every dark theme). */
${PAGE_BTN}${PAINTED_BUTTON_EXCLUDE} {
  background-color: transparent !important;
  /* Native signed-out controls may keep an explicit dark text utility after
     their light background is removed. Pin their foreground to the themed
     page text so Google/email sign-in remains readable on dark presets. */
  color: var(--bc-text) !important;
}
${PAGE_BTN}${PAINTED_BUTTON_EXCLUDE} :where(span, p, div) {
  color: var(--bc-text) !important;
}
${resizeButtons ? `
/* Real size system (§2.2/§2.3): resize through height/padding/font so layout
   actually reflows, hit area stays >= ${tokens.SIZE_BASE.minHitPx}px, and text
   never blurs — NOT transform: scale(), which changes visual size without
   reflow and can overlap neighbors or stick a tiny icon in a sea of padding. */
${PAGE_BTN} {
  min-height: var(--bc-control-height) !important;
  padding: var(--bc-control-pad-y) var(--bc-control-pad-x) !important;
  font-size: var(--bc-control-font) !important;
  /* keep the tap target >= 40px even when the visible box is smaller */
  min-width: ${st.effectiveHitPx}px;
}
${PAGE_BTN} svg {
  width: var(--bc-icon-size) !important;
  height: var(--bc-icon-size) !important;
}` : ""}
${layout.compactMode ? `
${SELECTORS.chatHeader} { padding: 4px 8px !important; min-height: 0 !important; }
[data-testid="message"] { padding-top: 4px !important; padding-bottom: 4px !important; }
` : ""}
${hideRules}
`.trim();
}

class ThemeEngine {
  constructor({ presets = {} } = {}) {
    this.presets = presets; // { themeId: cssString }
    this.settings = null;
  }

  registerPreset(id, css) {
    this.presets[id] = css;
  }

  applySettings(settings) {
    this.settings = settings;
    ensureStyleTag(BASE_STYLE_ID).textContent = buildBaseCSS(settings);

    const themeCSS = settings.appearance.activeTheme === "custom"
      ? settings.appearance.customThemeCSS || ""
      : this.presets[settings.appearance.activeTheme] || "";
    ensureStyleTag(THEME_STYLE_ID).textContent = themeCSS;
    syncClaudeColorModeFromThemeCSS(themeCSS);

    // Custom CSS always applied last so it can override the theme.
    ensureStyleTag(CUSTOM_STYLE_ID).textContent = settings.customCSS.code || "";

    // Inline style on :root beats a theme stylesheet's plain (non-!important)
    // `:root { --bc-accent: ... }` declaration, so the user's chosen accent
    // always wins over whatever the active theme preset shipped with.
    if (settings.appearance.accentColor) {
      this.setAccentColor(settings.appearance.accentColor);
    }

    // Main-pane background (§4.1), scoped away from sidebar/header/modals.
    // Applied after the theme so it reads the theme's --bc-text for its
    // contrast check. Returns a contrast eval the settings UI can surface.
    this.lastBackgroundContrast = applyBackground(settings.background || { mode: "off" });
  }

  setBackground(bgPatch) {
    if (!this.settings) return null;
    this.settings.background = Object.assign({}, this.settings.background, bgPatch);
    this.lastBackgroundContrast = applyBackground(this.settings.background);
    return this.lastBackgroundContrast;
  }

  setTheme(themeId) {
    if (!this.settings) return;
    this.settings.appearance.activeTheme = themeId;
    const themeCSS = themeId === "custom"
      ? this.settings.appearance.customThemeCSS || ""
      : this.presets[themeId] || "";
    ensureStyleTag(THEME_STYLE_ID).textContent = themeCSS;
    syncClaudeColorModeFromThemeCSS(themeCSS);
    if (this.settings.appearance.accentColor) {
      this.setAccentColor(this.settings.appearance.accentColor);
    }
  }

  setAccentColor(color) {
    if (!this.settings) return;
    this.settings.appearance.accentColor = color;
    document.documentElement.style.setProperty("--bc-accent", color);
    document.documentElement.style.setProperty("--bc-accent-hover", lighten(color, 0.18));
    // Some theme presets (e.g. High Contrast) bake a bespoke --bc-focus-ring
    // into their stylesheet rather than deriving it from --bc-accent, so a
    // user's live accent override never reached it — the old theme's focus
    // ring (e.g. bright yellow) stayed stuck on every focused control even
    // after every other accent-derived surface updated. Recomputing it here,
    // same contrast-safe logic the base scaffold uses, keeps it in sync.
    const rootStyle = getComputedStyle(document.documentElement);
    const bg = rootStyle.getPropertyValue("--bc-bg").trim() || "#14101f";
    const sidebar = rootStyle.getPropertyValue("--bc-bg-sidebar").trim() || bg;
    const elevated = rootStyle.getPropertyValue("--bc-bg-elevated").trim() || bg;
    const ring = focusRingColor(color, [
      bg,
      tokens.resolveOpaqueColor(sidebar, bg) || bg,
      tokens.resolveOpaqueColor(elevated, bg) || bg,
    ]);
    document.documentElement.style.setProperty("--bc-focus-ring", ring);
    document.documentElement.style.setProperty("--bc-border-focus", ring);
    // --bc-link (Defect 4) is likewise baked into the theme stylesheet at
    // generation time from that theme's SHIPPED accent, so it goes stale the
    // instant the user picks a custom accent here — same staleness bug the
    // focus-ring recompute above already exists to fix, so it gets the exact
    // same treatment: recompute the hue-preserving, contrast-corrected
    // derivative live and set it as an inline :root style, which beats the
    // theme stylesheet's `:root { --bc-link: ... }` declaration.
    const text = getComputedStyle(document.documentElement).getPropertyValue("--bc-text").trim() || "#ece7fb";
    const link = deriveAccessibleColor(color, text, (hex) => contrastRatio(hex, bg) >= WCAG_AA_BODY);
    document.documentElement.style.setProperty("--bc-link", link);
    // --btn-primary-fg has the SAME staleness problem, and it's the most
    // visible one: it's the label color on every accent-backed button, baked
    // at generation time against the theme's shipped accent. Left stale, a
    // user picking a light custom accent keeps the old dark-accent's white
    // label and gets white-on-light — the exact invisible-button bug this
    // token was introduced to fix, reintroduced at runtime. contrast-color()
    // would let CSS do this itself, but it only reached Chrome stable in 147,
    // well past this project's Chrome 120 target, so it has to be recomputed
    // here like the two above.
    // --btn-destructive-fg deliberately gets NO recompute: it derives from
    // --bc-danger, a fixed per-theme palette value the accent picker never
    // touches, so its generation-time value is always still correct.
    document.documentElement.style.setProperty("--btn-primary-fg", tokens.pickButtonFg(color).color);
    // Hover/pressed surfaces have their own luminance, so their labels must
    // be recalculated as well. Otherwise a light custom accent can make a
    // previously safe white label vanish the moment the button is hovered.
    const isDark = tokens.relativeLuminance(bg) < DARK_LUMINANCE_THRESHOLD;
    document.documentElement.style.setProperty("--btn-primary-fg-hover", tokens.pickButtonFg(lighten(color, 0.18)).color);
    document.documentElement.style.setProperty("--btn-primary-fg-active", tokens.pickButtonFg(tokens.shade(color, isDark ? 0.14 : -0.14)).color);

    // claude.ai's OWN accent tokens (the bridge built by
    // tokens.buildClaudeTokenBridge) are baked into the theme stylesheet from
    // that theme's SHIPPED accent, exactly like --bc-link and --btn-primary-fg
    // above — so they go stale the instant the user picks a custom accent, and
    // stale here means every native accent-filled surface in claude.ai keeps
    // the old color while BetterClaude's own chrome moves to the new one. Same
    // staleness class, same fix: recompute and set inline on :root, which beats
    // the stylesheet's declaration.
    //
    // --oncolor-* is the label color that sits ON those filled surfaces, so it
    // is recomputed from the SAME contrast pick as --btn-primary-fg. Leaving it
    // behind is the invisible-label bug in claude.ai's own buttons rather than
    // ours, which is harder to notice and identically bad.
    const accentBridge = {
      "--accent-pro-000": isDark ? lighten(color, 0.22) : tokens.shade(color, -0.12),
      "--accent-pro-100": color,
      "--accent-pro-200": tokens.shade(color, isDark ? -0.1 : -0.2),
      "--accent-pro-900": tokens.shade(color, -0.55),
      "--oncolor-100": tokens.pickButtonFg(color).color,
      "--oncolor-200": tokens.pickButtonFg(color).color,
      "--oncolor-300": tokens.pickButtonFg(color).color,
    };
    Object.entries(accentBridge).forEach(([name, value]) => {
      const triple = tokens.hslTriple(value);
      // An unparseable accent leaves claude.ai's own token in place (correct,
      // just untinted); writing an invalid triple would paint that surface
      // transparent, so a bad value must never reach the page.
      // "important" priority for the same reason the generated bridge carries
      // it (see tokens.buildClaudeTokenBridge): claude.ai declares these same
      // tokens under its own [data-mode] rules, and without the flag this
      // override loses the specificity tie-break and does nothing.
      if (triple) document.documentElement.style.setProperty(name, triple, "important");
    });
  }

  setCustomCSS(code) {
    if (!this.settings) return;
    this.settings.customCSS.code = code;
    ensureStyleTag(CUSTOM_STYLE_ID).textContent = code || "";
  }

  updateLayout(layoutPatch) {
    if (!this.settings) return;
    Object.assign(this.settings.layout, layoutPatch);
    ensureStyleTag(BASE_STYLE_ID).textContent = buildBaseCSS(this.settings);
  }

  updateFonts(fontsPatch) {
    if (!this.settings) return;
    Object.assign(this.settings.fonts, fontsPatch);
    ensureStyleTag(BASE_STYLE_ID).textContent = buildBaseCSS(this.settings);
  }
}

module.exports = {
  ThemeEngine,
  SELECTORS,
  THEME_STYLE_ID,
  CUSTOM_STYLE_ID,
  BASE_STYLE_ID,
  THEME_VAR_DEFS,
  buildThemeCSSFromVars,
  resolveScheduledTheme,
  // Small DOM helper other modules (core/extras-css.js consumers, etc.) can
  // reuse instead of duplicating the same "find or create a <style> tag"
  // bookkeeping.
  ensureStyleTag,
  // claude.ai's own color-mode sync (§4.1 systemic fix) — restoreClaudeColorMode
  // must be called from the master kill-switch teardown path.
  syncClaudeColorMode,
  restoreClaudeColorMode,
};
