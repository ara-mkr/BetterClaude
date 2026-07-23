/**
 * Design-token engine — the structural core of the customization system.
 * Pure functions only: no DOM, no Node/Electron APIs, so it's identical in
 * the Electron preload and a future browser-extension content script, and
 * trivially unit-testable from the §5 audit script.
 *
 * This module exists to prevent the spec's two named failure modes at the
 * source rather than by hoping users pick reasonable numbers:
 *   1. State bleed  -> every interactive family is a discrete state machine
 *      (default/hover/active/selected/disabled/focus) built here, never a
 *      single style with ad-hoc overrides.
 *   2. Extremes     -> radius is RELATIONAL to control height (§2.1) and every
 *      numeric input is clamped against engineered bounds (§2.2, §5.3).
 */

/* ------------------------------------------------------------------ *
 * Color math (hex + rgb()/rgba()/hsl()/hsla(); themes/vars are mostly
 * authored as 6-digit hex, but glassmorphism-style themes use translucent
 * rgba()/hsla() for --bc-bg-elevated / --bc-composer-bg / --bc-border, so the
 * parser has to understand those forms too or every translucent color is
 * silently scored as pure black (see relativeLuminance below).
 * ------------------------------------------------------------------ */

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1, g1, b1;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

// Parses rgb()/rgba()/hsl()/hsla() into {r,g,b,a}. Returns null if the string
// isn't one of those functional forms — parseHex delegates here for
// everything that isn't literal hex.
function parseFunctionalColor(str) {
  const s = (str || "").trim();
  let m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) {
    return {
      r: Math.max(0, Math.min(255, Number(m[1]))),
      g: Math.max(0, Math.min(255, Number(m[2]))),
      b: Math.max(0, Math.min(255, Number(m[3]))),
      a: m[4] != null ? Math.max(0, Math.min(1, Number(m[4]))) : 1,
    };
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) {
    const rgb = hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
    return {
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      a: m[4] != null ? Math.max(0, Math.min(1, Number(m[4]))) : 1,
    };
  }
  return null;
}

// parseColor is the general entry point: hex first (the common case), then
// rgb()/rgba()/hsl()/hsla(). Always returns {r,g,b,a} (a=1 for opaque hex) or
// null if the string genuinely can't be parsed as a color — callers MUST
// treat null as "unparseable", never silently coerce it to black (§ Defect 2).
function parseColor(value) {
  const hex = parseHex(value);
  if (hex) return { ...hex, a: 1 };
  return parseFunctionalColor(value);
}

// Hex-only parser. Kept as its own function (signature/behavior unchanged —
// returns {r,g,b} with no alpha, null on non-hex) because callers throughout
// this file and elsewhere already depend on that exact shape. Use parseColor
// above when the value might be rgb()/rgba()/hsl()/hsla().
function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const num = parseInt(h, 16);
  return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff };
}

function toHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

// Mix `hex` toward white (amount>0) or black (amount<0) by |amount| (0..1).
function shade(hex, amount) {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const target = amount >= 0 ? 255 : 0;
  const a = Math.abs(amount);
  return toHex({
    r: rgb.r + (target - rgb.r) * a,
    g: rgb.g + (target - rgb.g) * a,
    b: rgb.b + (target - rgb.b) * a,
  });
}

const lighten = (hex, amount) => shade(hex, Math.abs(amount));
const darken = (hex, amount) => shade(hex, -Math.abs(amount));

/* ------------------------------------------------------------------ *
 * WCAG contrast (§4.1 background/scrim, §5.2.4 auditor check)
 * ------------------------------------------------------------------ */

// Returns relative luminance for an OPAQUE color (hex, or rgb()/hsl() with no
// meaningful alpha). Returns NaN — never 0 — when `value` can't be parsed at
// all: a color that silently registers as pure black makes every downstream
// contrast check (contrastRatio, evaluateContrast, isDark determinations,
// the composer fg/placeholder pickers) lie about passing. NaN propagates
// through the ratio math below and always compares false against a
// threshold, so an unparseable color fails safe instead of failing silent;
// callers that need to distinguish "genuinely low contrast" from
// "unparseable" should check Number.isNaN(...) explicitly (see
// evaluateContrast's `unparseable` flag and scripts/audit.js).
//
// This does NOT alpha-composite: a translucent value's own r/g/b channels
// are used as-is. Compositing a translucent color over the surface it
// actually renders on (e.g. --bc-bg-elevated over --bc-bg) is a separate,
// deliberate step — see resolveOpaqueColor below — because relativeLuminance
// has no way to know what surface a given color sits on.
function relativeLuminance(value) {
  const rgb = parseColor(value);
  if (!rgb) return NaN;
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(rgb.r) + 0.7152 * chan(rgb.g) + 0.0722 * chan(rgb.b);
}

// Contrast ratio 1..21 between two opaque colors. Returns NaN (never a
// number that could look like a passing or failing ratio) if either color is
// unparseable, so a downstream `ratio >= threshold` check fails safe and
// Number.isNaN(ratio) lets callers report it as a distinct "unparseable"
// condition rather than an ordinary contrast failure.
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (Number.isNaN(la) || Number.isNaN(lb)) return NaN;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// Alpha-composite `fg` (with `alpha`) over opaque `bg` -> resulting opaque
// hex. Used to compute what text actually sits on once a scrim overlay of a
// given opacity is laid over a background color/image sample.
function compositeOver(fg, bg, alpha) {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return bg;
  const a = Math.max(0, Math.min(1, alpha));
  return toHex({
    r: f.r * a + b.r * (1 - a),
    g: f.g * a + b.g * (1 - a),
    b: f.b * a + b.b * (1 - a),
  });
}

// Resolve a color that may itself carry alpha (rgba()/hsla(), e.g. a
// glassmorphism theme's --bc-bg-elevated: rgba(255,228,235,0.08)) to the
// OPAQUE color it actually renders as, by compositing it over
// `underlyingHex` (assumed already-opaque — the real surface it sits on,
// e.g. --bc-bg). This is the fix for Defect 2: previously any rgba()/hsl()
// value fell through parseHex as null, so relativeLuminance silently scored
// it as pure black and every contrast check built on it "passed" by luck,
// not correctness. Returns null (never a fabricated color) if `value` can't
// be parsed at all — callers MUST treat null as "unparseable" and surface it
// loudly (see evaluateContrast / scripts/audit.js), not coerce it to a
// default.
function resolveOpaqueColor(value, underlyingHex) {
  const c = parseColor(value);
  if (!c) return null;
  if (c.a == null || c.a >= 0.999) return toHex(c);
  const under = parseColor(underlyingHex) || { r: 0, g: 0, b: 0, a: 1 };
  return toHex({
    r: c.r * c.a + under.r * (1 - c.a),
    g: c.g * c.a + under.g * (1 - c.a),
    b: c.b * c.a + under.b * (1 - c.a),
  });
}

const WCAG_AA_BODY = 4.5;
const WCAG_AA_LARGE = 3.0;

// Given text color over a base color and an optional scrim (color+opacity),
// return { ratio, passes, suggestedScrimOpacity }. When contrast fails, we
// search for the minimum scrim opacity that would make it pass rather than
// silently shipping unreadable text (§4.1).
function evaluateContrast(textColor, baseColor, scrim = null, threshold = WCAG_AA_BODY) {
  const effectiveBase = scrim
    ? compositeOver(scrim.color, baseColor, scrim.opacity)
    : baseColor;
  const ratio = contrastRatio(textColor, effectiveBase);
  // A NaN ratio means textColor/baseColor/scrim.color couldn't be parsed at
  // all (Defect 2) — report that loudly as `unparseable` instead of letting
  // `ratio >= threshold` silently evaluate to false and get reported as an
  // ordinary contrast failure indistinguishable from a real one.
  if (Number.isNaN(ratio)) {
    return { ratio: null, passes: false, unparseable: true };
  }
  const result = { ratio: Math.round(ratio * 100) / 100, passes: ratio >= threshold };
  if (!result.passes) {
    const scrimColor = (scrim && scrim.color) || (relativeLuminance(textColor) > 0.5 ? "#000000" : "#ffffff");
    for (let op = 0.05; op <= 1.0001; op += 0.05) {
      const b = compositeOver(scrimColor, baseColor, op);
      if (contrastRatio(textColor, b) >= threshold) {
        result.suggestedScrimColor = scrimColor;
        result.suggestedScrimOpacity = Math.round(op * 100) / 100;
        break;
      }
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Engineered bounds (§2.2, §5.3). Single source of truth shared by the
 * settings schema (clamp on load/import) and the audit script (extreme
 * -value checks), so the UI, persistence and auditor can never disagree
 * about what "too far" means.
 * ------------------------------------------------------------------ */

const BOUNDS = {
  // Multiplier on the base control size. Min keeps a 40x40 hit target and
  // stops label text clipping at the min font size; max keeps neighbors from
  // overflowing their region. Applied as a real size (padding/height/font),
  // never as a transform: scale() visual zoom.
  "appearanceEditor.sizeScale": { min: 0.85, max: 1.4, default: 1 },
  // Legacy alias kept so old saved files don't crash; folded into sizeScale.
  "appearanceEditor.buttonScale": { min: 0.85, max: 1.4, default: 1 },
  // Radius is no longer a free scalar; shape drives a ratio (see SHAPE_RATIOS).
  // The numeric radiusScale is retained only for migration and is clamped so a
  // hand-edited 999 can't reach the CSS.
  "appearanceEditor.radiusScale": { min: 0, max: 1, default: 1 },
  "fonts.baseSizePx": { min: 12, max: 20, default: 15 },
  "layout.sidebarWidthPx": { min: 180, max: 420, default: 280, nullable: true },
  "hud.opacity": { min: 0.2, max: 1, default: 0.92 },
  "hud.scale": { min: 0.7, max: 1.6, default: 1 },
  "background.opacity": { min: 0, max: 1, default: 1 },
  "background.scrimOpacity": { min: 0, max: 0.95, default: 0.35 },
  "background.blurPx": { min: 0, max: 40, default: 0 },
  // Image editor (crop/pan/zoom): offsetX/Y are CSS background-position
  // percentages, zoom is a size multiplier percentage (100 = fit as-is).
  "background.offsetX": { min: 0, max: 100, default: 50 },
  "background.offsetY": { min: 0, max: 100, default: 50 },
  "background.zoom": { min: 100, max: 300, default: 100 },
  "background.filter.brightness": { min: 0, max: 200, default: 100 },
  "background.filter.contrast": { min: 0, max: 200, default: 100 },
  "background.filter.saturate": { min: 0, max: 200, default: 100 },
  "background.filter.grayscale": { min: 0, max: 100, default: 0 },
  "background.filter.sepia": { min: 0, max: 100, default: 0 },
  "background.filter.hueRotate": { min: 0, max: 360, default: 0 },
  "background.rotation.intervalMinutes": { min: 15, max: 1440, default: 60 },
  "skillMarketplace.cacheTTLMinutes": { min: 15, max: 1440, default: 60 },
  "contextBudget.warnThresholdPercent": { min: 40, max: 95, default: 75 },
  "snapshots.intervalMinutes": { min: 5, max: 240, default: 30 },
  "fonts.lineHeight": { min: 1.1, max: 2.0, default: 1.5 },
  "fonts.letterSpacingPx": { min: -0.5, max: 3, default: 0 },
  "fonts.headingWeight": { min: 400, max: 900, default: 700 },
  // Master motion multiplier: 0 = fully off (all transitions/animations
  // instant), 1 = normal speed, 2 = double speed. Applied as a CSS
  // custom-property multiplier rather than a boolean so "slower, not just
  // on/off" is possible.
  "motion.speed": { min: 0, max: 2, default: 1 },
  "cursor.trailDensity": { min: 0.2, max: 1, default: 0.5 },
  "cursor.magneticStrength": { min: 0, max: 0.8, default: 0.4 },
  "sound.volume": { min: 0, max: 1, default: 0.6 },
  "sound.ambient.volume": { min: 0, max: 1, default: 0.3 },
  // Desktop has no rumble motor: this drives the visual micro-pulse
  // substitute described in core/interaction-fx.js, not real haptics.
  "sound.hapticsIntensity": { min: 0, max: 1, default: 0.5 },
  "focusReading.readingWidthPx": { min: 480, max: 1000, default: 680 },
};

function clampNumber(value, { min, max, default: dflt, nullable }) {
  if (nullable && (value == null)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/* ------------------------------------------------------------------ *
 * Shape / relational radius (§2.1)
 * ------------------------------------------------------------------ */

// User-facing shape selector maps to a radius-to-height ratio, never a raw
// pixel value. Every ratio is <= 0.5, so radius <= height/2 is guaranteed by
// construction: "pill" is the deliberate, valid end state, and there is no
// value that produces square corners on a rounded element or a lobed shape on
// a small one.
const SHAPE_RATIOS = { sharp: 0, soft: 0.16, rounded: 0.28, pill: 0.5 };
const SHAPE_ORDER = ["sharp", "soft", "rounded", "pill"];

function shapeRatio(shape) {
  if (typeof shape === "number") return Math.max(0, Math.min(0.5, shape));
  return SHAPE_RATIOS[shape] != null ? SHAPE_RATIOS[shape] : SHAPE_RATIOS.rounded;
}

// Relational radius in px for a known control height. Clamped to [0, h/2] so
// it can never exceed the pill threshold regardless of caller input (§2.1).
// minPx keeps a nominally-rounded control from looking sharp at tiny heights.
function relationalRadius(heightPx, shape, minPx = 0) {
  const h = Math.max(0, Number(heightPx) || 0);
  const ratio = shapeRatio(shape);
  const raw = h * ratio;
  const capped = Math.min(raw, h / 2);
  if (ratio === 0) return 0; // sharp stays sharp; don't force minPx
  return Math.max(Math.min(minPx, h / 2), capped);
}

/* ------------------------------------------------------------------ *
 * Size system (§2.2, §2.3) — real layout, not transform: scale()
 * ------------------------------------------------------------------ */

const SIZE_BASE = {
  controlHeightPx: 36, // base interactive control height at scale 1
  fontPx: 14,
  iconPx: 18,
  paddingRatio: 0.42, // horizontal padding as a fraction of control height
  minHitPx: 40, // WCAG 2.5.5 target size
  iconMinPx: 14,
  iconMaxPx: 24,
};

// Given a size scale (already clamped to BOUNDS), return concrete pixel
// tokens. Icon size scales with the control but is clamped to [14,24] so a
// big button never floats a tiny icon in padding and a max icon never
// collides with the label. Hit area is enforced >= 40px via padding even when
// the visible box is smaller.
function sizeTokens(scale = 1, base = SIZE_BASE) {
  const s = Number(scale) || 1;
  const controlHeight = Math.round(base.controlHeightPx * s);
  const font = Math.round(base.fontPx * s);
  const icon = Math.max(base.iconMinPx, Math.min(base.iconMaxPx, Math.round(base.iconPx * s)));
  const paddingX = Math.round(controlHeight * base.paddingRatio);
  // Extra invisible hit padding if the visible control is under the min target.
  const hitPadV = Math.max(0, Math.ceil((base.minHitPx - controlHeight) / 2));
  return {
    controlHeightPx: controlHeight,
    fontPx: font,
    iconPx: icon,
    paddingXPx: paddingX,
    // vertical padding derives from height to keep a fixed padding-to-height
    // ratio rather than a fixed pixel padding (§2.3).
    paddingYPx: Math.max(4, Math.round(controlHeight * 0.18)),
    hitPadVPx: hitPadV,
    effectiveHitPx: Math.max(base.minHitPx, controlHeight + hitPadV * 2),
  };
}

/* ------------------------------------------------------------------ *
 * State-machine token derivation (§1.1, §3)
 * ------------------------------------------------------------------ */

// The component families the spec wants themed independently (§3). Each gets
// its own token group so customizing one never cascades into another.
const COMPONENT_FAMILIES = [
  "btn-primary",
  "btn-secondary",
  "btn-ghost",
  "btn-destructive",
  "nav-item",
  "tab",
  "chip",
  "toggle",
  "input",
];

// Derived state colors from a single base + surface, per §3's rule:
// hover = base +8% lightness in dark mode / -8% in light mode, active a bit
// further, selected a tinted rest state, disabled desaturated toward surface.
// Any of these is individually overridable upstream by passing `overrides`.
function deriveStates(base, surface, { isDark = true, overrides = {} } = {}) {
  const dir = isDark ? 1 : -1;
  const states = {
    default: base,
    hover: shade(base, dir * 0.08),
    active: shade(base, dir * 0.14),
    selected: shade(base, dir * 0.05),
    disabled: compositeOver(base, surface, 0.4),
  };
  return { ...states, ...overrides };
}

/* ------------------------------------------------------------------ *
 * CSS generation — the shared scaffold every bundled + imported theme uses.
 * Emits: :root token groups, relational radius, focus-visible rings (always
 * present, contrast-enforced), and hover rules gated behind
 * @media (hover:hover) so touch taps never stick in hover (§1.2).
 * ------------------------------------------------------------------ */

// Pick a focus-ring color guaranteed to contrast against the surface it sits
// on, independent of the theme's accent choice (§1.1 accessibility rule).
function focusRingColor(accent, surface) {
  if (contrastRatio(accent, surface) >= 3) return accent;
  // Accent is too low-contrast on this surface: fall back to whichever of a
  // light/dark ring reads best.
  const light = "#ffffff";
  const dark = "#111111";
  return contrastRatio(light, surface) >= contrastRatio(dark, surface) ? light : dark;
}

/* ------------------------------------------------------------------ *
 * Hue-preserving accessible-color derivation (Defects 3 & 4). Used to
 * correct an authored color (muted text, link) that fails WCAG AA against
 * the surface(s) it renders on, by walking its LIGHTNESS toward the
 * lightness of a known-readable reference color (--bc-text) in small steps
 * — hue and saturation are held fixed, so the corrected color still reads as
 * "the same color, just readable" rather than being replaced outright. Mixes
 * in HSL space (not shade()'s RGB mix toward white/black) specifically so
 * hue is mathematically invariant across every step, not just approximately
 * preserved.
 * ------------------------------------------------------------------ */

function rgbToHsl({ r, g, b }) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = ((gn - bn) / d) % 6; break;
      case gn: h = (bn - rn) / d + 2; break;
      default: h = (rn - gn) / d + 4; break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

// Given `colorHex`, walk its lightness (hue/saturation fixed) toward
// `referenceHex`'s lightness in small steps until `passes(candidateHex)`
// returns true, or give up after 24 steps (12% of lightness range) and
// return `referenceHex` itself as the guaranteed-passing last resort (mirrors
// focusRingColor's "fall back to a color known to contrast" pattern above).
// Returns `colorHex` unchanged if either color is unparseable — this
// function corrects contrast, it doesn't paper over Defect 2's "unparseable"
// signal; callers/auditors are responsible for surfacing that separately.
function deriveAccessibleColor(colorHex, referenceHex, passes) {
  if (passes(colorHex)) return colorHex;
  const c = parseColor(colorHex);
  const ref = parseColor(referenceHex);
  if (!c || !ref) return colorHex;
  const hsl = rgbToHsl(c);
  const targetL = rgbToHsl(ref).l;
  const dir = targetL >= hsl.l ? 1 : -1;
  const STEP = 0.04;
  for (let i = 1; i <= 24; i++) {
    const l = Math.max(0, Math.min(1, hsl.l + dir * STEP * i));
    const candidate = toHex(hslToRgb(hsl.h, hsl.s, l));
    if (passes(candidate)) return candidate;
    if (l <= 0 || l >= 1) break;
  }
  return referenceHex;
}

// Shared "which button selectors does the scaffold itself paint a
// non-transparent background onto" list (Defect 1 fix). This is the SINGLE
// SOURCE OF TRUTH for that set: buildScaffoldCSS below builds its literal
// `button[...]` rules from it, and core/theme-engine.js imports it to build
// the `:not(...)` exclusion list on its "make every other button transparent"
// rule. Previously those two lists were maintained by hand in two files and
// drifted — theme-engine.js kept excluding `[class*="primary"]` after this
// scaffold stopped painting anything matching that selector, so buttons with
// an incidental Tailwind "primary" substring in their class list (e.g.
// claude.ai's own `hover:text-primary` utility class on plain icon buttons)
// received neither a transparent background nor an accent one and rendered
// with native light chrome under forced light theme text — a ~1:1 contrast
// button on every dark theme. Add a new painted selector here and BOTH files
// stay correct automatically; do not hardcode a parallel list anywhere else.
const SCAFFOLD_PAINTED_BUTTON_ATTRS = {
  primary: ['[data-testid*="send"]'],
  destructive: ['[aria-label*="delete" i]', '[aria-label*="remove" i]'],
};

/* ------------------------------------------------------------------ *
 * Composer tokens (§3, §4.1) — the composer card is themed independently
 * with its own bg/fg/border/placeholder rather than inheriting the generic
 * page text color, and its fg/placeholder are contrast-guaranteed AT
 * GENERATION TIME against its own bg rather than the page bg (a light theme
 * viewed while claude.ai itself renders in dark mode, or vice versa, would
 * otherwise force near-black/near-white body text onto a still-native card
 * background with ~1:1 contrast).
 * ------------------------------------------------------------------ */

// If the theme's natural text color already reads on the composer's own
// background, keep it (so themes that already pass aren't needlessly
// touched). Otherwise fall back to whichever of near-black/near-white wins,
// same pattern as focusRingColor above.
function pickComposerFg(composerBg, naturalText) {
  if (contrastRatio(naturalText, composerBg) >= WCAG_AA_BODY) return naturalText;
  const light = "#ffffff";
  const dark = "#111111";
  return contrastRatio(light, composerBg) >= contrastRatio(dark, composerBg) ? light : dark;
}

// Placeholder must clear AA-large (3:1) against the composer bg AND stay
// visibly distinct from the real composer fg (a placeholder that matches the
// real text color reads as "already typed something", not "empty field").
// Prefers the theme's own muted-text color and only searches further if it
// fails either bar.
function pickComposerPlaceholder(composerBg, composerFg, naturalMuted) {
  const distinctFromFg = (c) => contrastRatio(c, composerFg) >= 1.5;
  const passes = (c) => contrastRatio(c, composerBg) >= WCAG_AA_LARGE && distinctFromFg(c);
  if (passes(naturalMuted)) return naturalMuted;
  for (let amt = 0.05; amt <= 0.95; amt += 0.05) {
    const lighter = shade(naturalMuted, amt);
    if (passes(lighter)) return lighter;
    const darker = shade(naturalMuted, -amt);
    if (passes(darker)) return darker;
  }
  // Last resort: a mid-gray guaranteed to clear 3:1 against either a very
  // light or very dark composer bg while staying distinct from either
  // near-black or near-white fg.
  return relativeLuminance(composerBg) > 0.5 ? "#6b6b6b" : "#9a9a9a";
}

// Every element BetterClaude itself injects as a direct child of <body>
// (title bar, settings panel, HUD, plugin dock) — mounted as siblings of
// claude.ai's own app root, never inside it. Mirrors the identical constant
// in core/theme-engine.js (duplicated, not imported, to keep this module
// dependency-free per its "pure functions only" contract above); kept in
// sync manually since the injected-chrome id list rarely changes.
const OWN_CHROME_IDS = ["betterclaude-titlebar", "betterclaude-settings-panel", "betterclaude-hud", "betterclaude-plugin-dock"];
const OWN_CHROME_EXCLUDE = OWN_CHROME_IDS.map((id) => `:not(#${id}):not(#${id} *)`).join("");
// Scope for "every real element of the actual page". Previously
// `:where(#__next, #root) *`, which silently matched NOTHING (theme text
// color never applied, though bare-tag rules like `button` still worked)
// whenever claude.ai's build doesn't wrap its app in a #__next or #root
// element — that id pair was never verified against the live site (unlike
// the audited SELECTORS table in theme-engine.js) and isn't a contract to
// depend on. Excluding our own known injected containers from a plain
// `body *` is robust to that DOM detail changing entirely.
const PAGE_ROOT_SCOPE = `body *${OWN_CHROME_EXCLUDE}`;

/**
 * Build the full themed-page scaffold from a theme's --bc-* vars.
 * `scope` prefixes selectors so the same generator can target claude.ai's
 * page ("" scope) or, if ever needed, a sub-tree.
 */
function buildScaffoldCSS(vars = {}, opts = {}) {
  const name = opts.name || "Imported Theme";
  const isDark = opts.isDark != null ? opts.isDark : true;
  const shape = opts.shape || "rounded";

  const v = (key, fallback) => vars[key] || fallback;
  const bg = v("--bc-bg", "#14101f");
  const bgElevated = v("--bc-bg-elevated", "#1c1630");
  const bgSidebar = v("--bc-bg-sidebar", "#100c1c");
  const text = v("--bc-text", "#ece7fb");
  const textMuted = v("--bc-text-muted", "#a99bd1");
  const accent = v("--bc-accent", "#8b5cf6");
  const accentHover = v("--bc-accent-hover", shade(accent, isDark ? 0.14 : -0.14));
  const border = v("--bc-border", "#2c2347");
  const bubbleUser = v("--bc-bubble-user", "#2a1f4d");
  const bubbleAssistant = v("--bc-bubble-assistant", "transparent");
  const danger = v("--bc-danger", "#ef4444");

  const ring = focusRingColor(accent, bg);

  // Resolve possibly-translucent surfaces (glassmorphism themes author
  // --bc-bg-elevated / --bc-bg-sidebar / --bc-composer-bg as rgba(), e.g.
  // rose-glass.css) to the OPAQUE color they actually render as, by
  // compositing over --bc-bg — the real surface underneath every other
  // layer (Defect 2 fix: parseHex previously returned null for rgba(),
  // which made relativeLuminance silently score it as pure black, so
  // every contrast check built on it "passed" by luck rather than by
  // actually accounting for the alpha). Falls back to the raw value only if
  // it's genuinely unparseable — generation must not crash; scripts/audit.js
  // is responsible for failing loudly on an unparseable theme color.
  const bgSidebarOpaque = resolveOpaqueColor(bgSidebar, bg) || bgSidebar;
  const bgElevatedOpaque = resolveOpaqueColor(bgElevated, bg) || bgElevated;

  // Composer tokens (§3, §4.1) — derived from the palette LOCALS
  // (bgElevated/text/border/textMuted) above, never read back through v()
  // (which would freeze them on first generation: scripts/regen-themes.js
  // re-extracts every --bc-* var out of the CSS this function just emitted
  // and feeds it back in on the next run, so anything sourced via v() stops
  // tracking palette edits after generation #1).
  const composerBg = bgElevated;
  const composerBorder = border;
  const composerBgOpaque = resolveOpaqueColor(composerBg, bg) || composerBg;
  const composerFg = pickComposerFg(composerBgOpaque, text);
  const composerPlaceholder = pickComposerPlaceholder(composerBgOpaque, composerFg, textMuted);

  // Muted-text contrast correction (Defect 3): several bundled themes shipped
  // --bc-text-muted below WCAG AA body text (4.5:1) — as low as 2.55:1 on
  // one-dark — because the authored palette value was trusted as-is. Fixed
  // systematically here (never by hand-editing the palettes) by walking the
  // muted color's lightness toward --bc-text, hue preserved, until it clears
  // 4.5:1 against the WORST of every surface muted text actually renders on
  // (sidebar chat titles/timestamps, composer/panel muted copy): --bc-bg AND
  // --bc-bg-sidebar/--bc-bg-elevated.
  const mutedPasses = (hex) =>
    contrastRatio(hex, bg) >= WCAG_AA_BODY &&
    contrastRatio(hex, bgSidebarOpaque) >= WCAG_AA_BODY &&
    contrastRatio(hex, bgElevatedOpaque) >= WCAG_AA_BODY;
  const textMutedAccessible = deriveAccessibleColor(textMuted, text, mutedPasses);

  // Link color correction (Defect 4): `a { color: var(--bc-accent) }` used
  // the raw accent as body-copy link color — accent is chosen for brand
  // feel, not legibility, and measured as low as 2.48:1 (sakura-blossom)
  // against --bc-bg. --bc-link is a hue-preserving derivative of the accent,
  // corrected against --bc-bg (the surface links actually render on).
  // IMPORTANT: this only bakes a value for the theme's SHIPPED accent — a
  // user's live runtime accent override (setAccentColor in
  // core/theme-engine.js sets --bc-accent as an inline :root style, which
  // beats this stylesheet value) needs --bc-link recomputed too, which
  // setAccentColor does directly, mirroring how it already recomputes
  // --bc-focus-ring/--bc-border-focus on every accent change.
  const link = deriveAccessibleColor(accent, text, (hex) => contrastRatio(hex, bg) >= WCAG_AA_BODY);
  // Derived states reference the LIVE --bc-* vars via color-mix (Chrome 120
  // target) rather than baking a hex, so a user's runtime accent override
  // (an inline :root style) still propagates to every derived state. The mix
  // direction follows the theme's mode: brighten in dark, darken in light
  // (§3). default and hover are therefore always distinct AND always live.
  const towards = isDark ? "white" : "black";
  const mix = (base, pct) => `color-mix(in srgb, ${base} ${100 - pct}%, ${towards})`;

  // Fallback radius used only if the base layer (which carries the user's live
  // shape/size settings) isn't present — e.g. a theme previewed in isolation.
  // The real --bc-shape-ratio / --bc-control-height / --bc-radius are emitted
  // by buildBaseCSS so the live controls always win over the theme's palette
  // layer. We intentionally DON'T declare those three here (theme layer beats
  // base layer in the cascade), only reference them with a safe fallback.
  const fallbackRatio = shapeRatio(shape);
  const RADIUS = `var(--bc-radius, calc(2.4em * var(--bc-shape-ratio, ${fallbackRatio})))`;

  // Relational radius, expressed in CSS so it scales with control height and
  // is capped at height/2 by construction (ratio<=0.5). The browser also
  // proportionally caps any border-radius at half the box's shorter side, so
  // even native controls we don't size can't lobe.
  return `/* BetterClaude scaffold: ${name} */
:root {
  color-scheme: ${isDark ? "dark" : "light"};
  --bc-bg: ${bg};
  --bc-bg-elevated: ${bgElevated};
  --bc-bg-sidebar: ${bgSidebar};
  --bc-text: ${text};
  --bc-text-muted: ${textMutedAccessible};
  --bc-accent: ${accent};
  --bc-accent-hover: ${accentHover};
  --bc-link: ${link};
  --bc-border: ${border};
  --bc-danger: ${danger};
  --bc-bubble-user: ${bubbleUser};
  --bc-bubble-assistant: ${bubbleAssistant};

  /* Composer tokens (§3, §4.1) — the composer card is themed independently
     rather than inheriting the generic page text color; fg/placeholder are
     contrast-guaranteed against --bc-composer-bg at generation time. */
  --bc-composer-bg: ${composerBg};
  --bc-composer-fg: ${composerFg};
  --bc-composer-border: ${composerBorder};
  --bc-composer-placeholder: ${composerPlaceholder};

  /* Interactive state token groups (§1.1). default and hover are ALWAYS
     distinct values, and default falls back to the container surface — never
     to the hover value — so nothing renders permanently in its hover tint. */
  --btn-primary-bg-default: var(--bc-accent);
  --btn-primary-bg-hover: var(--bc-accent-hover, ${mix("var(--bc-accent)", 8)});
  --btn-primary-bg-active: ${mix("var(--bc-accent)", 14)};
  --btn-primary-bg-disabled: color-mix(in srgb, var(--bc-accent) 40%, var(--bc-bg));
  --btn-primary-fg: #ffffff;

  --btn-secondary-bg-default: transparent;
  --btn-secondary-bg-hover: color-mix(in srgb, var(--bc-text) 8%, transparent);
  --btn-secondary-bg-active: color-mix(in srgb, var(--bc-text) 14%, transparent);
  --btn-secondary-fg: var(--bc-text);

  --btn-destructive-bg-default: var(--bc-danger);
  --btn-destructive-bg-hover: ${mix("var(--bc-danger)", 8)};
  --btn-destructive-bg-active: ${mix("var(--bc-danger)", 14)};
  --btn-destructive-fg: #ffffff;

  --nav-item-bg-default: transparent;
  --nav-item-bg-hover: color-mix(in srgb, var(--bc-text) 6%, transparent);
  --nav-item-bg-selected: color-mix(in srgb, var(--bc-accent) 18%, transparent);
  --nav-item-fg-default: var(--bc-text-muted);
  --nav-item-fg-selected: var(--bc-text);

  --bc-focus-ring: ${ring};
  --bc-border-focus: ${ring};
}

body {
  background: var(--bc-bg) !important;
}
/* Text color, unlike background, has to reach every real leaf node: claude.ai
   sets color explicitly on almost every element (not just body), so a plain
   body-level rule never wins there. :where() keeps this at zero specificity
   so it still loses, as intended, to the button/nav-item/link foreground
   tokens declared further down (their own text needs to stay readable on a
   colored background, not flip to the generic body text color). Scoped via
   PAGE_ROOT_SCOPE (everything under <body> except our own injected chrome)
   rather than a claude.ai app-root id, which isn't guaranteed to exist. */
body, :where(${PAGE_ROOT_SCOPE}) {
  color: var(--bc-text) !important;
}

/* claude.ai's sidebar <nav> carries no stable class or testid of its own —
   only Tailwind utility classes that vary across builds — but it always
   contains the pin-sidebar-toggle button, which does have a stable testid.
   :has() lets us key off that real, verified hook instead of a guessed
   class name (the old "nav[class*='sidebar']" / "[data-testid='sidebar']"
   never matched anything on the live site). */
nav:has([data-testid="pin-sidebar-toggle"]) {
  background: var(--bc-bg-sidebar) !important;
  border-right: 1px solid var(--bc-border) !important;
}

header {
  background: var(--bc-bg) !important;
  border-color: var(--bc-border) !important;
}

/* Sidebar / settings nav items as a proper state machine (§1, §3): resting
   default is the container surface (never the hover tint), hover is gated to
   non-touch pointers, and the persistent selected/current item has its own
   token distinct from hover. */
nav:has([data-testid="pin-sidebar-toggle"]) a,
nav:has([data-testid="pin-sidebar-toggle"]) [role="button"] {
  background: var(--nav-item-bg-default) !important;
  color: var(--nav-item-fg-default) !important;
  border-radius: ${RADIUS} !important;
}
@media (hover: hover) and (pointer: fine) {
  nav:has([data-testid="pin-sidebar-toggle"]) a:hover,
  nav:has([data-testid="pin-sidebar-toggle"]) [role="button"]:hover {
    background: var(--nav-item-bg-hover) !important;
  }
}
nav:has([data-testid="pin-sidebar-toggle"]) a[aria-current],
nav:has([data-testid="pin-sidebar-toggle"]) a.active,
nav:has([data-testid="pin-sidebar-toggle"]) [aria-selected="true"] {
  background: var(--nav-item-bg-selected) !important;
  color: var(--nav-item-fg-selected) !important;
}

/* claude.ai's composer is a contentEditable ProseMirror div, not a
   <textarea> — "form textarea"/"textarea" never matched anything real.
   data-testid="chat-input" is the verified hook onto the actual element —
   but that element is only the inner text row (verified live: ~636px),
   narrower than the real rounded composer card wrapping it (~672px, its
   own native background, no stable testid to hook). A previous session
   painted a background/border/radius/width directly on this narrower node
   and shipped a "cut-off rectangle" behind the placeholder text — a second,
   mismatched rounded box that fell short of the real card's right edge.
   The real card IS reachable, just not by id: it's the nearest ancestor
   that directly contains this node, matched with :has(). Painting ONLY
   color there (no border-radius, no width) follows the real card's own
   native geometry instead of fighting it, while finally fixing its actual
   bug: claude.ai paints its own background on that card regardless of
   BetterClaude's page-wide text color, so a light BetterClaude theme's
   near-black text forced onto a still-dark native card (or vice versa) was
   landing at ~1.2:1 contrast — invisible. --bc-composer-* tokens are
   generated to guarantee contrast against EACH OTHER, not against the page
   bg (see pickComposerFg/pickComposerPlaceholder above). */
div:has(> [data-testid="chat-input"]) {
  background: var(--bc-composer-bg) !important;
  border-color: var(--bc-composer-border) !important;
}
[data-testid="chat-input"] {
  color: var(--bc-composer-fg) !important;
}
/* ProseMirror renders its placeholder either as a [data-placeholder]
   attribute-carrying node or an .is-empty node, with the visible text
   drawn via a ::before pseudo-element in most builds — cover both the
   pseudo-element and the plain element defensively since which one claude.ai
   uses isn't independently verified here. */
[data-testid="chat-input"] [data-placeholder]::before,
[data-testid="chat-input"][data-placeholder]::before,
[data-testid="chat-input"] .is-empty::before,
[data-testid="chat-input"].is-empty::before,
[data-testid="chat-input"] [data-placeholder],
[data-testid="chat-input"][data-placeholder] {
  color: var(--bc-composer-placeholder) !important;
}

/* All buttons: relational radius (never a raw px), resting state only.
   Excludes BetterClaude's own injected chrome (title bar, settings panel,
   HUD, plugin dock) — those have their own fixed styling (e.g. the title
   bar's circular traffic lights) and must never follow the page's shape
   preference. */
button${OWN_CHROME_EXCLUDE} {
  border-radius: ${RADIUS} !important;
}

/* Primary / send — DEFAULT state, resting. Hover is applied separately and
   only through a real :hover selector, gated to non-touch pointers.
   button[class*="primary"] is deliberately NOT used here: claude.ai's own
   buttons carry generic Tailwind utility classes like "hover:text-primary"
   on ordinary icon buttons (verified live on its Search button), so that
   substring match was silently mis-coloring unrelated buttons rather than
   doing nothing. data-testid*="send" has no confirmed match yet either —
   kept as a harmless no-op hook until a real one is found.
   These selectors are built from SCAFFOLD_PAINTED_BUTTON_ATTRS (defined
   above, exported below) rather than hardcoded here — that constant is THE
   list of "buttons this scaffold paints a non-transparent background onto",
   and core/theme-engine.js imports it to build the exact inverse: the
   :not(...) exclusion list on the rule that makes every OTHER button
   transparent. Editing this list here automatically keeps that rule in sync;
   do not hardcode a parallel selector list in theme-engine.js. */
button${SCAFFOLD_PAINTED_BUTTON_ATTRS.primary.join(", button")} {
  background: var(--btn-primary-bg-default) !important;
  color: var(--btn-primary-fg) !important;
}
button${SCAFFOLD_PAINTED_BUTTON_ATTRS.destructive.join(", button")} {
  background: var(--btn-destructive-bg-default) !important;
  color: var(--btn-destructive-fg) !important;
}

@media (hover: hover) and (pointer: fine) {
  button${SCAFFOLD_PAINTED_BUTTON_ATTRS.primary.join(":hover, button")}:hover {
    background: var(--btn-primary-bg-hover) !important;
  }
  button${SCAFFOLD_PAINTED_BUTTON_ATTRS.destructive.join(":hover, button")}:hover {
    background: var(--btn-destructive-bg-hover) !important;
  }
}

/* Pressed state works on touch and mouse alike (§1.2): default -> active ->
   default with no stuck hover. */
button${SCAFFOLD_PAINTED_BUTTON_ATTRS.primary.join(":active, button")}:active {
  background: var(--btn-primary-bg-active) !important;
}

/* Keyboard focus ring — ALWAYS present, contrast-enforced, independent of the
   theme's accent so it can't vanish on a low-contrast accent (§1.1).
   [data-testid="chat-input"] is excluded here and given its own rule below —
   see the comment above that selector: it's the narrower inner text row
   (~636px), not the real rounded composer card (~672px) around it, so the
   generic 2px offset used everywhere else draws a ring whose right edge
   lands short of the card's actual right wall — visually "cut off" against
   the real border. A larger offset pushes the ring out to roughly hug the
   real card's edge instead. */
button:focus-visible, a:focus-visible, textarea:focus-visible,
input:focus-visible, [tabindex]:focus-visible:not([data-testid="chat-input"]),
[role="tab"]:focus-visible {
  outline: 2px solid var(--bc-focus-ring) !important;
  outline-offset: 2px !important;
}
/* Plain :focus (not just :focus-visible) is covered too — contenteditable
   elements aren't natively focusable form controls, so Chromium's default
   UA outline for them can still apply on :focus even when :focus-visible's
   heuristic doesn't consider the interaction keyboard-driven. */
[data-testid="chat-input"]:focus,
[data-testid="chat-input"]:focus-visible {
  outline: none !important;
}

a { color: var(--bc-link) !important; }

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: var(--bc-bg); }
::-webkit-scrollbar-thumb { background: var(--bc-border); border-radius: 8px; }
@media (hover: hover) and (pointer: fine) {
  ::-webkit-scrollbar-thumb:hover { background: var(--bc-accent); }
}`;
}

// Extract the --bc-* variables declared in a theme's :root block. Used by the
// theme regenerator to rebuild the scaffold while preserving each theme's
// palette.
function extractThemeVars(cssText) {
  const out = {};
  const re = /(--bc-[a-z-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(cssText || "")) !== null) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

module.exports = {
  // color
  parseHex,
  parseColor,
  toHex,
  shade,
  lighten,
  darken,
  rgbToHsl,
  hslToRgb,
  // contrast
  relativeLuminance,
  contrastRatio,
  compositeOver,
  resolveOpaqueColor,
  evaluateContrast,
  WCAG_AA_BODY,
  WCAG_AA_LARGE,
  // bounds
  BOUNDS,
  clampNumber,
  // shape / radius
  SHAPE_RATIOS,
  SHAPE_ORDER,
  shapeRatio,
  relationalRadius,
  // size
  SIZE_BASE,
  sizeTokens,
  // states / css
  COMPONENT_FAMILIES,
  deriveStates,
  focusRingColor,
  deriveAccessibleColor,
  SCAFFOLD_PAINTED_BUTTON_ATTRS,
  pickComposerFg,
  pickComposerPlaceholder,
  buildScaffoldCSS,
  extractThemeVars,
};
