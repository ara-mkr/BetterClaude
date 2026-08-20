/**
 * Main-content background customization (§4.1).
 *
 * Two halves, split so the CSS generation is pure/testable and the DOM apply
 * is a thin wrapper:
 *   - buildBackgroundCSS(bg)  -> stylesheet string (pure, no DOM)
 *   - applyBackground(bg, doc) -> injects/updates the style tag + returns a
 *     contrast evaluation the caller can surface as a warning
 *   - backgroundContrast(bg, textColor) -> WCAG check for the settings UI
 *
 * Guarantees the spec calls out:
 *   - Scoped to the main chat/content pane ONLY — never sidebar/header/modals
 *     — unless bg.unifyAllSurfaces is explicitly set.
 *   - An adjustable scrim/overlay sits between background and text, and the
 *     effective text contrast is computed & enforced (WCAG AA 4.5:1); when it
 *     fails we suggest a scrim opacity rather than silently shipping
 *     unreadable text.
 *   - prefers-reduced-motion falls back to a static frame for animated modes.
 *   - Uses background-attachment: local scoped to the scroll container (not
 *     fixed on the viewport) so long conversations still scroll smoothly.
 */

const {
  evaluateContrast,
  relativeLuminance,
  WCAG_AA_BODY,
  clampNumber,
  BOUNDS,
} = require("./tokens");

const BG_STYLE_ID = "betterclaude-background";

// The main chat pane. Kept narrow on purpose so the background never bleeds
// into the sidebar/header/overlays.
//
// `main` itself is just the outer shell — claude.ai's own DOM audit
// (core/claude-dom.js contentPane, "main .dframe-pane-primary") found the
// actual visible content column is a nested child of <main> that paints its
// OWN opaque background (retinted from our theme via the --bg-100 token
// bridge in core/tokens.js). That child renders as a normal in-flow
// descendant, which paints AFTER our ::before layer (z-index: -2) even
// though the layer sits behind <main>'s own box background — so scoping to
// bare `main` put the image directly behind an opaque div and it never
// showed up. Scoping to the real pane instead puts our ::before behind
// THAT element's background in the paint order, where it's actually
// visible. `main` is kept as a last-resort fallback for older/unknown
// builds where the pane-primary class doesn't exist.
const MAIN_PANE = 'main .dframe-pane-primary, main [class*="pane-primary" i], [data-testid="conversation"], [role="main"], main';

function fitToBackgroundProps(fit, position) {
  switch (fit) {
    case "contain":
      return `background-size: contain; background-repeat: no-repeat; background-position: ${position};`;
    case "tile":
      return `background-size: auto; background-repeat: repeat; background-position: ${position};`;
    case "center":
      return `background-size: auto; background-repeat: no-repeat; background-position: ${position};`;
    case "cover":
    default:
      return `background-size: cover; background-repeat: no-repeat; background-position: ${position};`;
  }
}

// Image editor (crop/pan/zoom/flip/filters) — all applied to the background
// LAYER itself (the ::before pseudo-element), never to real content, so
// they can't affect claude.ai's own DOM or text contrast/selection.
// - Pan reuses plain CSS background-position (the correct, native mechanism
//   for "which part of the image shows"), so it composes with cover/contain/
//   tile/center exactly the way a plain background-position: X% Y% always
//   has, no extra layer needed.
// - Zoom + flip are one `transform: scale()` — negative components flip,
//   and transform-origin follows the current pan point so zooming feels
//   anchored to whatever the user just centered rather than the layer's
//   geometric center.
// - Filters are a plain CSS `filter` on the same layer, independent of
//   pan/zoom/flip and of the scrim (::after) so the scrim's own contrast
//   math in backgroundContrast() below is unaffected by them.
function imageTransformCSS(bg) {
  const zoomScale = (bg.zoom || 100) / 100;
  const sx = zoomScale * (bg.flipH ? -1 : 1);
  const sy = zoomScale * (bg.flipV ? -1 : 1);
  const originX = bg.offsetX != null ? bg.offsetX : 50;
  const originY = bg.offsetY != null ? bg.offsetY : 50;
  return `transform: scale(${sx}, ${sy}); transform-origin: ${originX}% ${originY}%;`;
}

function imageFilterCSS(filter) {
  if (!filter) return "";
  const f = filter;
  return `filter: brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturate}%) `
    + `grayscale(${f.grayscale}%) sepia(${f.sepia}%) hue-rotate(${f.hueRotate}deg);`;
}

// Resolve the CSS `background` shorthand value for the chosen mode.
function backgroundValue(bg) {
  switch (bg.mode) {
    case "solid":
      return bg.color;
    case "gradient":
      return bg.gradient;
    case "image":
      return bg.imageDataUrl ? `url("${bg.imageDataUrl}")` : bg.color;
    default:
      return "transparent";
  }
}

function buildBackgroundCSS(bg = {}) {
  if (!bg || bg.mode === "off" || !bg.mode) return "";

  const opacity = clampNumber(bg.opacity, BOUNDS["background.opacity"]);
  const scrimOpacity = clampNumber(bg.scrimOpacity, BOUNDS["background.scrimOpacity"]);
  const blurPx = clampNumber(bg.blurPx, BOUNDS["background.blurPx"]);
  const scope = bg.unifyAllSurfaces ? "body, #__next" : MAIN_PANE;
  const value = backgroundValue(bg);
  // Image mode drives position from the numeric offsetX/offsetY editor
  // fields (percent) rather than the old free-text `position`, which only
  // ever supported CSS keywords like "center" and had no UI to change it.
  const imagePosition = bg.mode === "image" && bg.offsetX != null && bg.offsetY != null
    ? `${bg.offsetX}% ${bg.offsetY}%`
    : (bg.position || "center");
  const fitProps = bg.mode === "image" ? fitToBackgroundProps(bg.fit || "cover", imagePosition) : "";
  const imageTransform = bg.mode === "image" ? imageTransformCSS(bg) : "";
  const imageFilter = bg.mode === "image" ? imageFilterCSS(bg.filter) : "";
  const animate = bg.animated && bg.mode === "gradient";

  return `
/* --- BetterClaude main-pane background (scoped; sidebar/header untouched) --- */
${scope} {
  position: relative !important;
  isolation: isolate;
  ${bg.mode === "image" ? "overflow: hidden !important;" : ""}
}
/* Background layer behind content. background-attachment: local keeps an
   image pinned to THIS scroll container instead of the viewport, so scrolling
   a long conversation stays smooth (no fixed-viewport repaint). The
   overflow:hidden above (image mode only) keeps a zoomed/flipped layer's
   transform from bleeding past the pane's own edges. */
${scope} > .bc-bg-layer,
${scope}::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -2;
  pointer-events: none;
  background: ${value};
  ${fitProps}
  background-attachment: local;
  opacity: ${opacity};
  ${imageTransform}
  ${imageFilter}
  ${animate ? "animation: bc-bg-pan 24s ease-in-out infinite alternate;" : ""}
}
/* Scrim/overlay between background and text. Its opacity is what the contrast
   check is computed against. */
${scope}::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: ${bg.scrimColor || "#000000"};
  opacity: ${scrimOpacity};
  ${blurPx > 0 ? `backdrop-filter: blur(${blurPx}px); -webkit-backdrop-filter: blur(${blurPx}px);` : ""}
}
${animate ? `
@keyframes bc-bg-pan {
  from { background-position: 0% 50%; }
  to   { background-position: 100% 50%; }
}
/* Static frame for users who asked the OS to reduce motion (§4.1). */
@media (prefers-reduced-motion: reduce) {
  ${scope}::before { animation: none !important; }
}` : ""}
`.trim();
}

// Ensures/updates the injected style tag. `doc` defaults to the global
// document; passing it explicitly keeps the module DOM-agnostic for tests.
function applyBackground(bg = {}, doc = (typeof document !== "undefined" ? document : null)) {
  if (!doc) return null;
  let tag = doc.getElementById(BG_STYLE_ID);
  const css = buildBackgroundCSS(bg);
  if (!css) {
    if (tag) tag.textContent = "";
    return null;
  }
  if (!tag) {
    tag = doc.createElement("style");
    tag.id = BG_STYLE_ID;
    doc.head.appendChild(tag);
  }
  tag.textContent = css;
  return backgroundContrast(bg, readTextColor(doc));
}

function readTextColor(doc) {
  try {
    const c = getComputedStyle(doc.documentElement).getPropertyValue("--bc-text").trim();
    return c || "#ece7fb";
  } catch (_e) {
    return "#ece7fb";
  }
}

// Evaluate whether body text will meet WCAG AA over this background + scrim.
// For image mode the underlying pixels are unknown, so we conservatively
// evaluate against the scrim laid over the fallback color and additionally
// treat both extremes (scrim over pure black and pure white) — the caller
// gets a suggested scrim opacity when it fails.
function backgroundContrast(bg = {}, textColor = "#ece7fb") {
  if (!bg || bg.mode === "off") return { applicable: false, passes: true };
  const scrim = { color: bg.scrimColor || "#000000", opacity: clampNumber(bg.scrimOpacity, BOUNDS["background.scrimOpacity"]) };

  if (bg.mode === "image") {
    // Worst case: text over the lightest and darkest possible image regions,
    // each seen through the scrim. Both must pass for the image to be safe.
    const overWhite = evaluateContrast(textColor, "#ffffff", scrim, WCAG_AA_BODY);
    const overBlack = evaluateContrast(textColor, "#000000", scrim, WCAG_AA_BODY);
    const worst = overWhite.ratio <= overBlack.ratio ? overWhite : overBlack;
    return { applicable: true, ...worst };
  }

  const base = bg.mode === "gradient"
    // Gradient: sample nothing fancy — evaluate the declared solid `color` as a
    // representative midpoint. Good enough to catch obviously-unreadable combos.
    ? (bg.color || "#14101f")
    : (bg.color || "#14101f");
  return { applicable: true, ...evaluateContrast(textColor, base, scrim, WCAG_AA_BODY) };
}

module.exports = {
  BG_STYLE_ID,
  buildBackgroundCSS,
  applyBackground,
  backgroundContrast,
};
