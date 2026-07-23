/**
 * Extras stylesheet — a second, pure CSS builder alongside
 * core/theme-engine.js's buildBaseCSS, covering everything that isn't
 * palette/shape: cursor style, reading mode, contrast boost, frosted-glass
 * overlays, motion speed/easing for BetterClaude's OWN overlays (settings
 * panel, HUD, popovers, command palette, mascot — never claude.ai's own
 * page transitions, which aren't ours to intercept), and mood tinting.
 *
 * DOM-only consumers (preload.js) inject the result into a single
 * "betterclaude-extras" style tag positioned after the theme tag and before
 * customCSS, via core/theme-engine.js's ensureStyleTag, so hand-written
 * Custom CSS keeps having the final word (same invariant the theme system
 * already guarantees for base/theme/background).
 *
 * The one exception is core/tokens.js-safe `--bc-danger` color-blind-safe
 * substitution: that's applied as an INLINE style (applyColorBlindSafeVars
 * below), the same trick setAccentColor uses, because the theme layer
 * re-declares --bc-danger on every theme switch and a plain stylesheet rule
 * would just lose that race.
 */

const { clampNumber, BOUNDS } = require("./tokens");

// Selectors for BetterClaude's OWN floating chrome — deliberately never
// includes claude.ai's own page elements, matching the scoping rule the rest
// of this system already follows (e.g. background.js's MAIN_PANE, theme-
// engine's PAGE_BTN carve-outs).
const OVERLAY_SELECTORS = `
#betterclaude-settings-panel, #betterclaude-settings-panel *,
#betterclaude-hud, .bc-dock-btn, .bc-color-popover,
#bc-command-palette-overlay, #bc-command-palette-overlay *,
#bc-companion, #bc-radial-menu, #bc-radial-menu *
`.trim();

function svgCursorUrl(svg, hx, hy) {
  const encoded = encodeURIComponent(svg).replace(/'/g, "%27").replace(/"/g, "%22");
  return `url("data:image/svg+xml,${encoded}") ${hx} ${hy}, auto`;
}

function dotCursorSvg(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="6" fill="${color}" stroke="#ffffff" stroke-width="1.5"/></svg>`;
}

function cursorCSS(cursor = {}, accentColor = "#8b5cf6") {
  const style = cursor.style || "default";
  if (style === "default") return "";
  const value = style === "crosshair" ? "crosshair" : svgCursorUrl(dotCursorSvg(accentColor), 9, 9);
  return `
/* Cursor style: ${style}. Left off text-entry surfaces on purpose — a
   decorative cursor over a textarea would fight the text-edit affordance. */
body, a, button, [role="button"], summary, label {
  cursor: ${value} !important;
}
textarea, input, [contenteditable="true"] {
  cursor: text !important;
}
`;
}

function readingModeCSS(focusReading = {}, fonts = {}) {
  if (!focusReading.readingMode) return "";
  const width = clampNumber(focusReading.readingWidthPx, BOUNDS["focusReading.readingWidthPx"]);
  const font = (focusReading.readingFont || "").trim() || fonts.uiFont || "system-ui";
  return `
/* Reading mode: narrower measure + a legibility-first contrast boost.
   Always boosts contrast while active — that's the point of the mode,
   distinct from the general appearance.contrastBoost toggle below. */
body.bc-reading-mode main, body.bc-reading-mode [data-testid="conversation"],
body.bc-reading-mode [data-testid="composer"] {
  max-width: ${width}px !important;
  margin-left: auto !important;
  margin-right: auto !important;
}
body.bc-reading-mode [data-testid="message"] {
  font-family: ${font} !important;
  filter: contrast(1.15);
}
`;
}

function contrastBoostCSS(enabled) {
  if (!enabled) return "";
  return `
/* General accessibility contrast boost — layers on top of any theme. */
body, #__next { font-weight: 500 !important; }
${'[data-testid="message"], [data-testid="composer"], textarea'} {
  border-width: 2px !important;
}
button:focus-visible, a:focus-visible, textarea:focus-visible,
input:focus-visible, [tabindex]:focus-visible {
  outline-width: 3px !important;
}
`;
}

function glassPanelsCSS(enabled) {
  if (!enabled) return "";
  return `
/* Frosted-glass overlays — BetterClaude's own chrome only. */
#betterclaude-settings-panel .bc-sp-content,
#betterclaude-settings-panel .bc-sp-sidebar,
#betterclaude-hud, .bc-color-popover, .bc-dock-btn, #betterclaude-plugin-dock,
#bc-command-palette-overlay .bc-cp-box, #bc-companion {
  backdrop-filter: blur(14px) saturate(1.3);
  -webkit-backdrop-filter: blur(14px) saturate(1.3);
  background-color: color-mix(in srgb, var(--bc-bg-elevated, #1c1630) 72%, transparent) !important;
}
`;
}

// Underline/weight is the redundant non-color affordance for destructive
// actions; the actual color substitution is applied via inline style
// (applyColorBlindSafeVars) so it isn't lost to theme-CSS re-declaration.
function colorBlindSafeCSS(enabled) {
  if (!enabled) return "";
  return `
button[class*="destructive"], button[class*="danger"],
button[aria-label*="delete" i], button[aria-label*="remove" i] {
  text-decoration: underline;
  text-underline-offset: 2px;
  font-weight: 600;
}
`;
}

function motionCSS(motion = {}) {
  const speed = clampNumber(motion.speed, BOUNDS["motion.speed"]);
  const durationMs = speed <= 0 ? 0 : Math.round(220 / speed);
  const curve = motion.easing === "bouncy"
    ? "cubic-bezier(0.34, 1.56, 0.64, 1)"
    : "cubic-bezier(0.4, 0, 0.2, 1)";

  return `
:root {
  --bc-overlay-duration: ${durationMs}ms;
  --bc-overlay-easing: ${curve};
}
${OVERLAY_SELECTORS} {
  transition-duration: ${durationMs}ms !important;
  transition-timing-function: ${curve} !important;
}
${speed <= 0 ? `${OVERLAY_SELECTORS} { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }` : ""}
${!motion.overrideReducedMotion ? `
@media (prefers-reduced-motion: reduce) {
  ${OVERLAY_SELECTORS} {
    transition-duration: 0ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}` : ""}
`;
}

// Subtle saturation/brightness nudge only — never a full re-theme. The mood
// itself is just a friendlier entry point onto the same Vibe Bundle table
// (core/vibe-bundles.js) that already re-themes properly when applied.
function moodTintCSS() {
  return `
[data-bc-mood="energetic"] { filter: saturate(1.08); }
[data-bc-mood="calm"] { filter: saturate(0.94) brightness(1.01); }
[data-bc-mood="focused"] { filter: saturate(0.97) contrast(1.02); }
[data-bc-mood="playful"] { filter: saturate(1.12) hue-rotate(2deg); }
`;
}

// Zen Mode = the existing Focus Mode plugin (sidebar/chrome DOM detachment,
// see plugins/focus-mode.claudeplugin.js + preload's syncZenModeWithFocusPlugin)
// PLUS these two additionally hidden, so only the conversation is visible.
// Unconditional (not gated behind a settings flag in here) because the
// `body.bc-zen-mode` class itself is the toggle.
const ZEN_MODE_CSS = `
body.bc-zen-mode #betterclaude-hud,
body.bc-zen-mode #betterclaude-plugin-dock {
  display: none !important;
}
`;

function buildExtrasCSS(settings = {}) {
  const parts = [
    cursorCSS(settings.cursor, settings.appearance && settings.appearance.accentColor),
    readingModeCSS(settings.focusReading, settings.fonts),
    contrastBoostCSS(settings.appearance && settings.appearance.contrastBoost),
    glassPanelsCSS(settings.appearance && settings.appearance.glassPanels),
    colorBlindSafeCSS(settings.appearance && settings.appearance.colorBlindSafe),
    motionCSS(settings.motion),
    moodTintCSS(),
    ZEN_MODE_CSS,
  ];
  return parts.filter(Boolean).join("\n").trim();
}

// Okabe-Ito "vermillion" — a red substitute that stays visually distinct
// from green/blue for deuteranopia, protanopia AND tritanopia at once,
// which is the whole reason a single universal toggle is used instead of
// three separate per-condition simulations.
const COLOR_BLIND_SAFE_DANGER = "#D55E00";

// Inline style on :root beats a stylesheet rule regardless of injection
// order — the same reason ThemeEngine.setAccentColor uses inline style
// rather than a CSS custom-property rule (core/theme-engine.js).
function applyColorBlindSafeVars(enabled, doc = (typeof document !== "undefined" ? document : null)) {
  if (!doc) return;
  if (enabled) {
    doc.documentElement.style.setProperty("--bc-danger", COLOR_BLIND_SAFE_DANGER);
  } else {
    doc.documentElement.style.removeProperty("--bc-danger");
  }
}

module.exports = {
  buildExtrasCSS,
  applyColorBlindSafeVars,
  COLOR_BLIND_SAFE_DANGER,
  svgCursorUrl,
  dotCursorSvg,
  OVERLAY_SELECTORS,
};
