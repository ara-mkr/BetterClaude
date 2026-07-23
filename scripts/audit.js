#!/usr/bin/env node
/**
 * Self-auditing check (§5). This is the "auditor" role made runnable: it does
 * NOT trust that the code was written correctly — it re-derives the spec's
 * guarantees from the actual generated CSS and the pure token functions, and
 * reports an itemized pass/fail with evidence.
 *
 * What it can verify headlessly (no browser needed):
 *   §1/§3  state separation .... every family has distinct default vs hover
 *                                 tokens; focus-visible exists; hover is gated.
 *   §2.1   relational radius .... radius <= height/2 at every shape + size.
 *   §2.3   icon/hit bounds ...... icon in [14,24]px, hit target >= 40px, across
 *                                 the whole size range.
 *   §4.1   contrast ............. body text meets WCAG AA over each theme, and
 *                                 failing backgrounds yield a scrim suggestion.
 *   §4.2   focus-mode unmount ... plugin detaches/restores nodes rather than
 *                                 dimming them.
 *   §5.3   graceful degradation . out-of-bounds saved state is clamped on load.
 *   static anti-patterns ....... no raw hex or raw-px radius in themed rules.
 *
 * What it CANNOT verify here (stated explicitly, never silently "passed"):
 *   live pixel screenshots, real React re-render behavior, and subjective
 *   aesthetics — those need the running app (§5.2.2) and are reported as
 *   UNVERIFIED-HERE.
 *
 *   node scripts/audit.js
 */
const fs = require("fs");
const path = require("path");
const tokens = require("../core/tokens");
const { mergeDefaults } = require("../core/settings-schema");
const { buildBackgroundCSS, backgroundContrast } = require("../core/background");

const ROOT = path.join(__dirname, "..");
const THEMES_DIR = path.join(ROOT, "themes");

const results = [];
function record(section, name, pass, evidence) {
  results.push({ section, name, pass, evidence });
}
function note(section, name, evidence) {
  results.push({ section, name, pass: "n/a", evidence });
}

// Comments are documentation, not code: strip them before any pattern match so
// a `:hover` or `opacity:0` written INSIDE a comment (e.g. describing what the
// code deliberately avoids) can't produce a false finding.
function stripCssComments(css) {
  return css.replace(/\/\*[^]*?\*\//g, "");
}
function stripJsComments(js) {
  return js.replace(/\/\*[^]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// Remove every `@media (hover: hover)...{ ... }` block via real brace matching
// (regex can't balance nested braces). Whatever `:hover` remains afterward is
// genuinely ungated.
function stripHoverMediaBlocks(css) {
  let out = css;
  let idx;
  while ((idx = out.indexOf("@media (hover: hover)")) !== -1) {
    const open = out.indexOf("{", idx);
    if (open === -1) break;
    let depth = 0, end = -1;
    for (let i = open; i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) break;
    out = out.slice(0, idx) + out.slice(end + 1);
  }
  return out;
}

// Split a theme into its :root block (where hex/token definitions are allowed)
// and the rest (selectors, where hardcoded hex / raw-px radius are the bug).
function splitRoot(css) {
  const start = css.indexOf(":root");
  if (start === -1) return { root: "", rules: css };
  let depth = 0, i = css.indexOf("{", start), end = -1;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  return { root: css.slice(start, end + 1), rules: css.slice(0, start) + css.slice(end + 1) };
}

/* ---------------- §5.2.1 static anti-pattern checks ---------------- */
function auditThemesStatic() {
  const files = fs.readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
  files.forEach((file) => {
    const css = fs.readFileSync(path.join(THEMES_DIR, file), "utf8");
    const { rules } = splitRoot(css);

    // Hardcoded hex outside the token :root block (scrollbar/# in var() is ok).
    const hexInRules = (rules.match(/#[0-9a-f]{3,6}\b/gi) || []);
    record("static", `${file}: no hardcoded hex in selectors`, hexInRules.length === 0,
      hexInRules.length ? `found ${hexInRules.slice(0, 3).join(", ")}` : "clean");

    // Raw-px border-radius in control rules (scrollbar's cosmetic px allowed).
    const radiusLines = (rules.match(/[^\n]*border-radius:[^\n]*/g) || []);
    const badRadius = radiusLines.filter((l) => /border-radius:\s*[\d.]+px/.test(l) && !/scrollbar/.test(l));
    record("§2.1", `${file}: radius is relational, not raw px`, badRadius.length === 0,
      badRadius.length ? badRadius[0].trim() : "uses var(--bc-radius)/relational");

    // focus-visible must exist.
    record("§1.1", `${file}: has focus-visible ring`, /:focus-visible/.test(css),
      /:focus-visible/.test(css) ? "present" : "MISSING");

    // Every :hover in a theme must sit inside an @media (hover: hover) block.
    // Strip comments first (a `:hover` in prose isn't a rule), then remove the
    // gated blocks by brace matching; any remaining :hover is ungated.
    const codeOnly = stripCssComments(css);
    const totalHover = (codeOnly.match(/:hover/g) || []).length;
    const ungated = (stripHoverMediaBlocks(codeOnly).match(/:hover/g) || []).length;
    record("§1.2", `${file}: all hover states touch-gated`, ungated === 0,
      `${totalHover - ungated}/${totalHover} hover rules gated`);

    // State separation: distinct default vs hover tokens present.
    const hasDefault = /--btn-primary-bg-default:/.test(css);
    const hasHover = /--btn-primary-bg-hover:/.test(css);
    record("§1/§3", `${file}: distinct default & hover tokens`, hasDefault && hasHover,
      hasDefault && hasHover ? "both defined" : "missing a state token");
  });
}

/* ---------------- §2.1 / §2.3 extreme-value checks ---------------- */
function auditExtremes() {
  const sizeB = tokens.BOUNDS["appearanceEditor.sizeScale"];
  const scales = [sizeB.min, 1, sizeB.max];
  const shapes = tokens.SHAPE_ORDER;
  let radiusOk = true, iconOk = true, hitOk = true;
  const failures = [];

  scales.forEach((scale) => {
    const st = tokens.sizeTokens(scale);
    if (st.iconPx < tokens.SIZE_BASE.iconMinPx || st.iconPx > tokens.SIZE_BASE.iconMaxPx) {
      iconOk = false; failures.push(`icon ${st.iconPx}px @scale ${scale}`);
    }
    if (st.effectiveHitPx < tokens.SIZE_BASE.minHitPx) {
      hitOk = false; failures.push(`hit ${st.effectiveHitPx}px @scale ${scale}`);
    }
    shapes.forEach((shape) => {
      const r = tokens.relationalRadius(st.controlHeightPx, shape);
      if (r > st.controlHeightPx / 2 + 1e-9) {
        radiusOk = false; failures.push(`radius ${r} > h/2 @${shape}/${scale}`);
      }
    });
  });

  record("§2.1", "radius <= height/2 at every shape & size", radiusOk,
    radiusOk ? `checked ${scales.length}×${shapes.length} combos` : failures.join("; "));
  record("§2.3", "icon within 14–24px across size range", iconOk,
    iconOk ? "ok" : failures.join("; "));
  record("§2.3", "hit target >= 40px across size range", hitOk,
    hitOk ? "ok" : failures.join("; "));

  // A hostile out-of-range radiusScale can't produce a lobed shape: shapeRatio
  // is always clamped to <= 0.5.
  const hostile = tokens.shapeRatio(999);
  record("§2.1", "shapeRatio clamps hostile input to <= 0.5", hostile <= 0.5,
    `shapeRatio(999) = ${hostile}`);
}

/* ---------------- §4.1 contrast checks ---------------- */
function auditContrast() {
  const files = fs.readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
  files.forEach((file) => {
    const css = fs.readFileSync(path.join(THEMES_DIR, file), "utf8");
    const vars = tokens.extractThemeVars(css);

    // Defect 2, "loud not silent": every --bc-* color value the theme
    // declares must be parseable (hex or rgb()/rgba()/hsl()/hsla()) — a
    // color this auditor can't evaluate must hard-FAIL the theme, never get
    // silently skipped/treated as black. "transparent" is a legitimate,
    // deliberate CSS keyword (--bc-bubble-assistant's default), not a color
    // to evaluate, so it's exempted explicitly rather than by accident.
    const unparseable = [];
    Object.entries(vars).forEach(([key, value]) => {
      if (value === "transparent" || /^var\(/.test(value)) return;
      if (!tokens.parseColor(value)) unparseable.push(`${key}: ${value}`);
    });
    record("§4.1", `${file}: every declared color is parseable`, unparseable.length === 0,
      unparseable.length ? `unparseable: ${unparseable.join(", ")}` : "all parse (hex/rgb/hsl)");
    if (unparseable.length) return; // can't evaluate contrast on a color we can't parse — don't fabricate ratios

    const text = vars["--bc-text"] || "#ffffff";
    const bg = vars["--bc-bg"] || "#000000";
    const ratio = tokens.contrastRatio(text, bg);
    record("§4.1", `${file}: body text >= 4.5:1`, ratio >= tokens.WCAG_AA_BODY,
      `${Math.round(ratio * 100) / 100}:1`);

    const ring = vars["--bc-focus-ring"] || vars["--bc-accent"] || "#ffffff";
    const ringRatio = tokens.contrastRatio(ring, bg);
    record("§1.1", `${file}: focus ring >= 3:1 on bg`, ringRatio >= 3,
      `${Math.round(ringRatio * 100) / 100}:1`);

    // Defect 2 fix: --bc-bg-elevated / --bc-composer-bg / --bc-bg-sidebar can
    // be translucent (rgba()/hsla(), glassmorphism themes like rose-glass)
    // — composite over the real underlying surface (--bc-bg) to get the
    // OPAQUE color actually rendered before running any contrast math on it,
    // rather than treating the translucent value as if it were opaque
    // (which silently mis-scores it — e.g. a near-white 8%-alpha pink reads
    // as bright when uncomposited, but composites to near-black over a dark
    // --bc-bg, and only the composited color is what's ever really on screen).
    const bgElevatedOpaque = tokens.resolveOpaqueColor(vars["--bc-bg-elevated"] || bg, bg) || bg;
    const bgSidebarOpaque = tokens.resolveOpaqueColor(vars["--bc-bg-sidebar"] || bg, bg) || bg;
    const textMuted = vars["--bc-text-muted"] || text;
    const composerBgOpaque = tokens.resolveOpaqueColor(vars["--bc-composer-bg"] || vars["--bc-bg-elevated"] || bg, bg) || bg;
    const composerFg = vars["--bc-composer-fg"] || text;
    const composerPlaceholder = vars["--bc-composer-placeholder"] || textMuted;

    // §4.1 composer contrast — the P0 class of bug (a nested native surface
    // painted independently of the page-wide --bc-text rule) that a check
    // only ever comparing --bc-text against --bc-bg could never catch.
    const composerRatio = tokens.contrastRatio(composerFg, composerBgOpaque);
    record("§4.1", `${file}: composer fg >= 4.5:1 on composer bg`, composerRatio >= tokens.WCAG_AA_BODY,
      `${Math.round(composerRatio * 100) / 100}:1`);

    const textOnElevatedRatio = tokens.contrastRatio(text, bgElevatedOpaque);
    record("§4.1", `${file}: body text >= 4.5:1 on bg-elevated`, textOnElevatedRatio >= tokens.WCAG_AA_BODY,
      `${Math.round(textOnElevatedRatio * 100) / 100}:1`);

    // Defect 3 — muted text (sidebar chat titles/timestamps, small body
    // text, so 4.5:1 is the correct bar) checked against every surface it
    // actually renders on: --bc-bg, --bc-bg-sidebar, --bc-bg-elevated.
    const mutedOnBgRatio = tokens.contrastRatio(textMuted, bg);
    record("§4.1", `${file}: muted text >= 4.5:1 on bg`, mutedOnBgRatio >= tokens.WCAG_AA_BODY,
      `${Math.round(mutedOnBgRatio * 100) / 100}:1`);

    const mutedOnSidebarRatio = tokens.contrastRatio(textMuted, bgSidebarOpaque);
    record("§4.1", `${file}: muted text >= 4.5:1 on bg-sidebar`, mutedOnSidebarRatio >= tokens.WCAG_AA_BODY,
      `${Math.round(mutedOnSidebarRatio * 100) / 100}:1`);

    const mutedOnElevatedRatio = tokens.contrastRatio(textMuted, bgElevatedOpaque);
    record("§4.1", `${file}: muted text >= 4.5:1 on bg-elevated`, mutedOnElevatedRatio >= tokens.WCAG_AA_BODY,
      `${Math.round(mutedOnElevatedRatio * 100) / 100}:1`);

    const placeholderRatio = tokens.contrastRatio(composerPlaceholder, composerBgOpaque);
    record("§4.1", `${file}: composer placeholder >= 3:1 on composer bg`, placeholderRatio >= tokens.WCAG_AA_LARGE,
      `${Math.round(placeholderRatio * 100) / 100}:1`);

    // P0 — button label foreground must clear WCAG AA against the button's
    // ACTUAL painted background (--bc-accent for primary, --bc-danger for
    // destructive), not just exist. Previously hardcoded #ffffff failed this
    // on 19/20 bundled themes (as low as 1.07:1 on high-contrast).
    const accent = vars["--bc-accent"] || bg;
    const danger = vars["--bc-danger"] || bg;
    const btnPrimaryFg = vars["--btn-primary-fg"] || "#ffffff";
    const btnDestructiveFg = vars["--btn-destructive-fg"] || "#ffffff";
    const btnPrimaryRatio = tokens.contrastRatio(btnPrimaryFg, accent);
    const btnDestructiveRatio = tokens.contrastRatio(btnDestructiveFg, danger);

    // pickButtonFg already picks the BETTER of near-white/near-black against
    // this exact accent/danger — if even the best of those two can't reach
    // 4.5:1, that's not a bug in the generated value (there IS no passing
    // choice for this accent), so it must not be reported as an ordinary
    // regression-style FAIL (which would make the audit permanently red for
    // a theme with an inherently mid-luminance accent, defeating the whole
    // check). Report it loudly as a distinct "best-available, short of AA"
    // note instead — never silently accept it AND never conflate it with an
    // actual defect (e.g. someone reverting to a hardcoded #ffffff, which
    // DOES have a passing alternative available and must still hard-fail).
    const bestPrimary = tokens.pickButtonFg(accent);
    if (bestPrimary.passes) {
      record("§4.1", `${file}: btn-primary-fg >= 4.5:1 on bc-accent`, btnPrimaryRatio >= tokens.WCAG_AA_BODY,
        `${Math.round(btnPrimaryRatio * 100) / 100}:1`);
    } else {
      // Even in the "no passing choice exists" case, the GENERATED value
      // must still equal the best available one (not silently regress to a
      // worse pick, e.g. a hand-reverted #ffffff when black would have been
      // closer) — verify that explicitly rather than trusting the note.
      const matchesBest = btnPrimaryFg.toLowerCase() === bestPrimary.color.toLowerCase();
      record("§4.1", `${file}: btn-primary-fg matches best-available pick`, matchesBest,
        matchesBest ? "matches" : `generated ${btnPrimaryFg} != best pick ${bestPrimary.color}`);
      note("§4.1", `${file}: btn-primary-fg is best-available (no white/black choice reaches 4.5:1 on this accent)`,
        `generated ${Math.round(btnPrimaryRatio * 100) / 100}:1, best possible ${bestPrimary.ratio}:1 on accent ${accent}`);
    }

    const bestDestructive = tokens.pickButtonFg(danger);
    if (bestDestructive.passes) {
      record("§4.1", `${file}: btn-destructive-fg >= 4.5:1 on bc-danger`, btnDestructiveRatio >= tokens.WCAG_AA_BODY,
        `${Math.round(btnDestructiveRatio * 100) / 100}:1`);
    } else {
      const matchesBestD = btnDestructiveFg.toLowerCase() === bestDestructive.color.toLowerCase();
      record("§4.1", `${file}: btn-destructive-fg matches best-available pick`, matchesBestD,
        matchesBestD ? "matches" : `generated ${btnDestructiveFg} != best pick ${bestDestructive.color}`);
      note("§4.1", `${file}: btn-destructive-fg is best-available (no white/black choice reaches 4.5:1 on this danger color)`,
        `generated ${Math.round(btnDestructiveRatio * 100) / 100}:1, best possible ${bestDestructive.ratio}:1 on danger ${danger}`);
    }

    // Defect 4 — `a { color: var(--bc-link) }` must clear body-text AA
    // against the page background it actually renders on.
    const link = vars["--bc-link"] || vars["--bc-accent"] || text;
    const linkRatio = tokens.contrastRatio(link, bg);
    record("§4.1", `${file}: link >= 4.5:1 on bg`, linkRatio >= tokens.WCAG_AA_BODY,
      `${Math.round(linkRatio * 100) / 100}:1`);

    // color-scheme must match the theme's own bg luminance (same threshold
    // regen-themes.js/theme-engine.js use), so claude.ai's own dark:/light:
    // native-surface variants track the theme rather than whatever mode
    // claude.ai happened to boot in (§4.1 systemic half of the fix).
    const expectedScheme = tokens.relativeLuminance(bg) < 0.4 ? "dark" : "light";
    const schemeMatch = new RegExp(`color-scheme:\\s*${expectedScheme}\\b`).test(css);
    record("§4.1", `${file}: color-scheme matches bg luminance (${expectedScheme})`, schemeMatch,
      schemeMatch ? `declares ${expectedScheme}` : "missing or mismatched color-scheme");
  });

  // Background feature: a deliberately-unreadable combo must fail AND suggest a
  // scrim, never silently pass.
  const bad = backgroundContrast({ mode: "solid", color: "#ffffff", scrimColor: "#000000", scrimOpacity: 0 }, "#eeeeee");
  record("§4.1", "unreadable background fails + suggests scrim",
    bad.passes === false && bad.suggestedScrimOpacity != null,
    `ratio ${bad.ratio}, suggest scrim ${bad.suggestedScrimOpacity}`);
  const good = backgroundContrast({ mode: "solid", color: "#101010", scrimColor: "#000", scrimOpacity: 0.2 }, "#ffffff");
  record("§4.1", "readable background passes", good.passes === true, `ratio ${good.ratio}`);

  // Background must be scoped to the main pane only.
  const bgCss = buildBackgroundCSS({ mode: "solid", color: "#123456" });
  const touchesSidebar = /sidebar/.test(bgCss.replace(/\/\*[^]*?\*\//g, "")); // ignore comments
  record("§4.1", "background scoped to main pane (not sidebar)", !touchesSidebar,
    touchesSidebar ? "leaks into sidebar" : "main-only");
}

/* ---------------- Defect 1: painted-button exclusion list can't drift ---------------- */
// Structural regression check for the stale-coupling bug: core/theme-engine.js's
// "make every other button transparent" rule must derive its :not(...)
// exclusion list from core/tokens.js's SCAFFOLD_PAINTED_BUTTON_ATTRS (the
// same list buildScaffoldCSS uses to decide which buttons get a painted
// background), not a hand-kept copy that can go stale the moment the
// scaffold's painted-button set changes.
function auditButtonPainting() {
  const engineSrc = fs.readFileSync(path.join(ROOT, "core", "theme-engine.js"), "utf8");
  const tokensSrc = fs.readFileSync(path.join(ROOT, "core", "tokens.js"), "utf8");
  // Strip comments first — both files deliberately DISCUSS the stale
  // `[class*="primary"]` selector in prose (that's the historical-context
  // documentation the fix comments require), so a raw text search would
  // false-fail on the explanation itself. Only live code should be checked.
  const engineCode = stripJsComments(engineSrc);
  const tokensCode = stripJsComments(tokensSrc);

  const importsSharedConstant = /SCAFFOLD_PAINTED_BUTTON_ATTRS/.test(engineCode);
  record("Defect1", "theme-engine.js derives its button exclusion list from tokens.js's shared constant",
    importsSharedConstant,
    importsSharedConstant ? "imports SCAFFOLD_PAINTED_BUTTON_ATTRS" : "no reference to SCAFFOLD_PAINTED_BUTTON_ATTRS found");

  const hasStaleExclusion = /\[class\*=["']primary["']\]/.test(engineCode);
  record("Defect1", "theme-engine.js does not hand-exclude button[class*=\"primary\"]",
    !hasStaleExclusion,
    hasStaleExclusion ? "stale [class*=\"primary\"] exclusion still present in live code" : "clean");

  const scaffoldPaintsPrimaryClass = /button\[class\*=["']primary["']\]/.test(tokensCode);
  record("Defect1", "tokens.js scaffold does not paint button[class*=\"primary\"]",
    !scaffoldPaintsPrimaryClass,
    scaffoldPaintsPrimaryClass ? "scaffold paints button[class*=\"primary\"] again — restore the theme-engine.js exclusion to match" : "scaffold doesn't paint that selector (exclusion correctly absent)");

  const exportsConstant = /SCAFFOLD_PAINTED_BUTTON_ATTRS\s*[,:]/.test(tokensSrc) && tokens.SCAFFOLD_PAINTED_BUTTON_ATTRS != null;
  record("Defect1", "tokens.js exports SCAFFOLD_PAINTED_BUTTON_ATTRS", exportsConstant,
    exportsConstant ? JSON.stringify(tokens.SCAFFOLD_PAINTED_BUTTON_ATTRS) : "not exported / undefined");
}

/* ---------------- §4.2 focus-mode unmount ---------------- */
function auditFocusMode() {
  const src = stripJsComments(fs.readFileSync(path.join(ROOT, "plugins", "focus-mode.claudeplugin.js"), "utf8"));
  const detaches = /\.remove\(\)/.test(src) && /insertBefore/.test(src) && /_restore/.test(src);
  record("§4.2", "focus mode detaches & restores nodes (not opacity)", detaches,
    detaches ? "detach/restore present" : "no unmount logic");
  const noOpacityHide = !/sidebar[^]*opacity:\s*0[^.\d]/.test(src);
  record("§4.2", "focus mode does NOT hide sidebar via opacity:0", noOpacityHide,
    noOpacityHide ? "clean" : "still using opacity");
  const hasShortcut = /keydown/.test(src) && /removeEventListener/.test(src);
  record("§4.2", "focus mode has reversible keyboard shortcut", hasShortcut,
    hasShortcut ? "keydown + cleanup" : "no shortcut");
}

/* ---------------- §5.3 graceful degradation ---------------- */
function auditPersistence() {
  const junk = mergeDefaults({
    appearanceEditor: { shape: "wobble", sizeScale: 999, radiusScale: -50 },
    fonts: { baseSizePx: 900 },
    layout: { sidebarWidthPx: 99999 },
    background: { mode: "hologram", scrimOpacity: 5, blurPx: -3 },
  });
  const checks = [
    ["shape", junk.appearanceEditor.shape === "rounded"],
    ["sizeScale", junk.appearanceEditor.sizeScale === 1.4],
    ["baseSizePx", junk.fonts.baseSizePx === 20],
    ["sidebarWidthPx", junk.layout.sidebarWidthPx === 420],
    ["background.mode", junk.background.mode === "off"],
    ["scrimOpacity", junk.background.scrimOpacity === 0.95],
    ["blurPx", junk.background.blurPx === 0],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([k]) => k);
  record("§5.3", "out-of-bounds saved state clamped on load", failed.length === 0,
    failed.length ? `not clamped: ${failed.join(", ")}` : "all 7 fields clamped");
}

function auditUnverifiable() {
  note("§5.2.2", "live screenshot/hover/focus visual diffs", "UNVERIFIED-HERE — needs running app (Playwright/Storybook)");
  note("§4.2", "React re-render behavior of detach/observer", "UNVERIFIED-HERE — needs live claude.ai DOM");
}

/* ---------------- run + report ---------------- */
auditThemesStatic();
auditExtremes();
auditContrast();
auditButtonPainting();
auditFocusMode();
auditPersistence();
auditUnverifiable();

const fails = results.filter((r) => r.pass === false);
const passes = results.filter((r) => r.pass === true);
const nas = results.filter((r) => r.pass === "n/a");

// Group compactly: collapse per-theme repeats into a count when all pass.
const bySection = {};
results.forEach((r) => { (bySection[r.section] = bySection[r.section] || []).push(r); });

console.log("\n=== BetterClaude Customization Audit (§5) ===\n");
Object.keys(bySection).forEach((section) => {
  const rs = bySection[section];
  const f = rs.filter((r) => r.pass === false);
  const p = rs.filter((r) => r.pass === true);
  const n = rs.filter((r) => r.pass === "n/a");
  const status = f.length ? "FAIL" : (p.length ? "PASS" : "INFO");
  console.log(`[${status}] ${section}  (${p.length} pass, ${f.length} fail${n.length ? `, ${n.length} n/a` : ""})`);
  f.forEach((r) => console.log(`   ✗ ${r.name} — ${r.evidence}`));
  n.forEach((r) => console.log(`   • ${r.name} — ${r.evidence}`));
});

console.log(`\nTotal: ${passes.length} passed, ${fails.length} failed, ${nas.length} unverifiable-here.\n`);
process.exit(fails.length ? 1 : 0);
