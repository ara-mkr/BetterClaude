var BetterClaudeCore = (() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // core/tokens.js
  var require_tokens = __commonJS({
    "core/tokens.js"(exports, module) {
      function hslToRgb(h, s, l) {
        h = (h % 360 + 360) % 360;
        s = Math.max(0, Math.min(1, s));
        l = Math.max(0, Math.min(1, l));
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(h / 60 % 2 - 1));
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
      function parseFunctionalColor(str) {
        const s = (str || "").trim();
        let m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
        if (m) {
          return {
            r: Math.max(0, Math.min(255, Number(m[1]))),
            g: Math.max(0, Math.min(255, Number(m[2]))),
            b: Math.max(0, Math.min(255, Number(m[3]))),
            a: m[4] != null ? Math.max(0, Math.min(1, Number(m[4]))) : 1
          };
        }
        m = /^hsla?\(\s*([\d.]+)(?:deg)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
        if (m) {
          const rgb = hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
          return {
            r: rgb.r,
            g: rgb.g,
            b: rgb.b,
            a: m[4] != null ? Math.max(0, Math.min(1, Number(m[4]))) : 1
          };
        }
        return null;
      }
      function parseColor(value) {
        const hex = parseHex(value);
        if (hex) return { ...hex, a: 1 };
        return parseFunctionalColor(value);
      }
      function parseHex(hex) {
        const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || "").trim());
        if (!m) return null;
        let h = m[1];
        if (h.length === 3) h = h.split("").map((c) => c + c).join("");
        const num = parseInt(h, 16);
        return { r: num >> 16 & 255, g: num >> 8 & 255, b: num & 255 };
      }
      function toHex({ r, g, b }) {
        const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
        return `#${c(r)}${c(g)}${c(b)}`;
      }
      function shade(hex, amount) {
        const rgb = parseHex(hex);
        if (!rgb) return hex;
        const target = amount >= 0 ? 255 : 0;
        const a = Math.abs(amount);
        return toHex({
          r: rgb.r + (target - rgb.r) * a,
          g: rgb.g + (target - rgb.g) * a,
          b: rgb.b + (target - rgb.b) * a
        });
      }
      var lighten = (hex, amount) => shade(hex, Math.abs(amount));
      var darken = (hex, amount) => shade(hex, -Math.abs(amount));
      function relativeLuminance(value) {
        const rgb = parseColor(value);
        if (!rgb) return NaN;
        const chan = (v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * chan(rgb.r) + 0.7152 * chan(rgb.g) + 0.0722 * chan(rgb.b);
      }
      function contrastRatio(a, b) {
        const la = relativeLuminance(a);
        const lb = relativeLuminance(b);
        if (Number.isNaN(la) || Number.isNaN(lb)) return NaN;
        const lighter = Math.max(la, lb);
        const darker = Math.min(la, lb);
        return (lighter + 0.05) / (darker + 0.05);
      }
      function compositeOver(fg, bg, alpha) {
        const f = parseColor(fg);
        const b = parseColor(bg);
        if (!f || !b) return bg;
        const a = Math.max(0, Math.min(1, alpha));
        return toHex({
          r: f.r * a + b.r * (1 - a),
          g: f.g * a + b.g * (1 - a),
          b: f.b * a + b.b * (1 - a)
        });
      }
      function resolveOpaqueColor(value, underlyingHex) {
        const c = parseColor(value);
        if (!c) return null;
        if (c.a == null || c.a >= 0.999) return toHex(c);
        const under = parseColor(underlyingHex) || { r: 0, g: 0, b: 0, a: 1 };
        return toHex({
          r: c.r * c.a + under.r * (1 - c.a),
          g: c.g * c.a + under.g * (1 - c.a),
          b: c.b * c.a + under.b * (1 - c.a)
        });
      }
      var WCAG_AA_BODY = 4.5;
      var WCAG_AA_LARGE = 3;
      function evaluateContrast(textColor, baseColor, scrim = null, threshold = WCAG_AA_BODY) {
        const effectiveBase = scrim ? compositeOver(scrim.color, baseColor, scrim.opacity) : baseColor;
        const ratio = contrastRatio(textColor, effectiveBase);
        if (Number.isNaN(ratio)) {
          return { ratio: null, passes: false, unparseable: true };
        }
        const result = { ratio: Math.round(ratio * 100) / 100, passes: ratio >= threshold };
        if (!result.passes) {
          const scrimColor = scrim && scrim.color || (relativeLuminance(textColor) > 0.5 ? "#000000" : "#ffffff");
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
      var BOUNDS = {
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
        "fonts.lineHeight": { min: 1.1, max: 2, default: 1.5 },
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
        "focusReading.readingWidthPx": { min: 480, max: 1e3, default: 680 }
      };
      function clampNumber(value, { min, max, default: dflt, nullable }) {
        if (nullable && value == null) return null;
        const n = Number(value);
        if (!Number.isFinite(n)) return dflt;
        return Math.max(min, Math.min(max, n));
      }
      var SHAPE_RATIOS = { sharp: 0, soft: 0.16, rounded: 0.28, pill: 0.5 };
      var SHAPE_ORDER = ["sharp", "soft", "rounded", "pill"];
      function shapeRatio(shape) {
        if (typeof shape === "number") return Math.max(0, Math.min(0.5, shape));
        return SHAPE_RATIOS[shape] != null ? SHAPE_RATIOS[shape] : SHAPE_RATIOS.rounded;
      }
      function relationalRadius(heightPx, shape, minPx = 0) {
        const h = Math.max(0, Number(heightPx) || 0);
        const ratio = shapeRatio(shape);
        const raw = h * ratio;
        const capped = Math.min(raw, h / 2);
        if (ratio === 0) return 0;
        return Math.max(Math.min(minPx, h / 2), capped);
      }
      var SIZE_BASE = {
        controlHeightPx: 36,
        // base interactive control height at scale 1
        fontPx: 14,
        iconPx: 18,
        paddingRatio: 0.42,
        // horizontal padding as a fraction of control height
        minHitPx: 40,
        // WCAG 2.5.5 target size
        iconMinPx: 14,
        iconMaxPx: 24
      };
      function sizeTokens(scale = 1, base = SIZE_BASE) {
        const s = Number(scale) || 1;
        const controlHeight = Math.round(base.controlHeightPx * s);
        const font = Math.round(base.fontPx * s);
        const icon = Math.max(base.iconMinPx, Math.min(base.iconMaxPx, Math.round(base.iconPx * s)));
        const paddingX = Math.round(controlHeight * base.paddingRatio);
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
          effectiveHitPx: Math.max(base.minHitPx, controlHeight + hitPadV * 2)
        };
      }
      var COMPONENT_FAMILIES = [
        "btn-primary",
        "btn-secondary",
        "btn-ghost",
        "btn-destructive",
        "nav-item",
        "tab",
        "chip",
        "toggle",
        "input"
      ];
      function deriveStates(base, surface, { isDark = true, overrides = {} } = {}) {
        const dir = isDark ? 1 : -1;
        const states = {
          default: base,
          hover: shade(base, dir * 0.08),
          active: shade(base, dir * 0.14),
          selected: shade(base, dir * 0.05),
          disabled: compositeOver(base, surface, 0.4)
        };
        return { ...states, ...overrides };
      }
      function focusRingColor(accent, surface) {
        const surfaces = (Array.isArray(surface) ? surface : [surface]).filter(Boolean);
        const floor = (color) => Math.min(...surfaces.map((s) => contrastRatio(color, s)));
        if (floor(accent) >= 3) return accent;
        const light = "#ffffff";
        const dark = "#111111";
        return floor(light) >= floor(dark) ? light : dark;
      }
      var PICK_BUTTON_FG_NEAR_DARK = "#111111";
      var PICK_BUTTON_FG_PURE_DARK = "#000000";
      var PICK_BUTTON_FG_NEAR_LIGHT = "#ffffff";
      var PICK_BUTTON_FG_PURE_LIGHT = "#ffffff";
      function buildFgRamp(nearHex, pureHex, steps = 4) {
        const near = parseHex(nearHex);
        const pure = parseHex(pureHex);
        const out = [];
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          out.push(toHex({
            r: near.r + (pure.r - near.r) * t,
            g: near.g + (pure.g - near.g) * t,
            b: near.b + (pure.b - near.b) * t
          }));
        }
        return out;
      }
      var PICK_BUTTON_FG_DARK_RAMP = buildFgRamp(PICK_BUTTON_FG_NEAR_DARK, PICK_BUTTON_FG_PURE_DARK);
      var PICK_BUTTON_FG_LIGHT_RAMP = buildFgRamp(PICK_BUTTON_FG_NEAR_LIGHT, PICK_BUTTON_FG_PURE_LIGHT);
      function bestOnRamp(ramp, bg) {
        for (const c of ramp) {
          const r = contrastRatio(c, bg);
          if (r >= WCAG_AA_BODY) return { color: c, ratio: r };
        }
        let best = null;
        for (const c of ramp) {
          const r = contrastRatio(c, bg);
          if (!best || r > best.ratio) best = { color: c, ratio: r };
        }
        return best;
      }
      function pickButtonFg(bg) {
        const darkBest = bestOnRamp(PICK_BUTTON_FG_DARK_RAMP, bg);
        const lightBest = bestOnRamp(PICK_BUTTON_FG_LIGHT_RAMP, bg);
        const darkPasses = darkBest.ratio >= WCAG_AA_BODY;
        const lightPasses = lightBest.ratio >= WCAG_AA_BODY;
        let best;
        if (darkPasses && lightPasses) {
          best = darkBest.ratio >= lightBest.ratio ? darkBest : lightBest;
        } else if (darkPasses) {
          best = darkBest;
        } else if (lightPasses) {
          best = lightBest;
        } else {
          best = darkBest.ratio >= lightBest.ratio ? darkBest : lightBest;
        }
        return {
          color: best.color,
          ratio: Number.isNaN(best.ratio) ? null : Math.round(best.ratio * 100) / 100,
          passes: best.ratio >= WCAG_AA_BODY
        };
      }
      function rgbToHsl({ r, g, b }) {
        const rn = r / 255, gn = g / 255, bn = b / 255;
        const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
        const l = (max + min) / 2;
        let h = 0, s = 0;
        const d = max - min;
        if (d !== 0) {
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          switch (max) {
            case rn:
              h = (gn - bn) / d % 6;
              break;
            case gn:
              h = (bn - rn) / d + 2;
              break;
            default:
              h = (rn - gn) / d + 4;
              break;
          }
          h *= 60;
          if (h < 0) h += 360;
        }
        return { h, s, l };
      }
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
      var SCAFFOLD_PAINTED_BUTTON_ATTRS = {
        primary: ['[data-testid*="send"]'],
        destructive: ['[aria-label*="delete" i]', '[aria-label*="remove" i]']
      };
      function pickComposerFg(composerBg, naturalText) {
        if (contrastRatio(naturalText, composerBg) >= WCAG_AA_BODY) return naturalText;
        const light = "#ffffff";
        const dark = "#111111";
        return contrastRatio(light, composerBg) >= contrastRatio(dark, composerBg) ? light : dark;
      }
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
        return relativeLuminance(composerBg) > 0.5 ? "#6b6b6b" : "#9a9a9a";
      }
      var OWN_CHROME_IDS = ["betterclaude-titlebar", "betterclaude-settings-panel", "betterclaude-hud", "betterclaude-plugin-dock"];
      var OWN_CHROME_EXCLUDE = OWN_CHROME_IDS.map((id) => `:not(#${id}):not(#${id} *)`).join("");
      var PAGE_ROOT_SCOPE = `body *${OWN_CHROME_EXCLUDE}`;
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
        const btnPrimaryFg = pickButtonFg(accent);
        const btnDestructiveFg = pickButtonFg(danger);
        const bgSidebarOpaque = resolveOpaqueColor(bgSidebar, bg) || bgSidebar;
        const bgElevatedOpaque = resolveOpaqueColor(bgElevated, bg) || bgElevated;
        const ring = focusRingColor(accent, [bg, bgSidebarOpaque, bgElevatedOpaque]);
        const composerBg = bgElevated;
        const composerBorder = border;
        const composerBgOpaque = resolveOpaqueColor(composerBg, bg) || composerBg;
        const composerFg = pickComposerFg(composerBgOpaque, text);
        const composerPlaceholder = pickComposerPlaceholder(composerBgOpaque, composerFg, textMuted);
        const mutedPasses = (hex) => contrastRatio(hex, bg) >= WCAG_AA_BODY && contrastRatio(hex, bgSidebarOpaque) >= WCAG_AA_BODY && contrastRatio(hex, bgElevatedOpaque) >= WCAG_AA_BODY;
        const textMutedAccessible = deriveAccessibleColor(textMuted, text, mutedPasses);
        const link = deriveAccessibleColor(accent, text, (hex) => contrastRatio(hex, bg) >= WCAG_AA_BODY);
        const towards = isDark ? "white" : "black";
        const mix = (base, pct) => `color-mix(in srgb, ${base} ${100 - pct}%, ${towards})`;
        const fallbackRatio = shapeRatio(shape);
        const RADIUS = `var(--bc-radius, calc(2.4em * var(--bc-shape-ratio, ${fallbackRatio})))`;
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

  /* Composer tokens (\xA73, \xA74.1) \u2014 the composer card is themed independently
     rather than inheriting the generic page text color; fg/placeholder are
     contrast-guaranteed against --bc-composer-bg at generation time. */
  --bc-composer-bg: ${composerBg};
  --bc-composer-fg: ${composerFg};
  --bc-composer-border: ${composerBorder};
  --bc-composer-placeholder: ${composerPlaceholder};

  /* Interactive state token groups (\xA71.1). default and hover are ALWAYS
     distinct values, and default falls back to the container surface \u2014 never
     to the hover value \u2014 so nothing renders permanently in its hover tint. */
  --btn-primary-bg-default: var(--bc-accent);
  --btn-primary-bg-hover: var(--bc-accent-hover, ${mix("var(--bc-accent)", 8)});
  --btn-primary-bg-active: ${mix("var(--bc-accent)", 14)};
  --btn-primary-bg-disabled: color-mix(in srgb, var(--bc-accent) 40%, var(--bc-bg));
  /* Contrast-safe button label (P0 fix): picked from near-white/near-black
     against the theme's SHIPPED --bc-accent at generation time (pickButtonFg
     above), replacing a hardcoded #ffffff that failed WCAG AA on 19/20
     bundled themes (as low as 1.07:1 on high-contrast's #ffff00 accent).
     KNOWN GAP: this is a baked value, not a live CSS expression \u2014 a user's
     runtime accent override (ThemeEngine.setAccentColor writes --bc-accent as
     an inline :root style in core/theme-engine.js, which this project does
     not touch) will NOT cause this to recompute, and would re-create the
     exact same stale-white-text bug at runtime. contrast-color()/
     color-contrast() would let the browser recompute this against the LIVE
     --bc-accent with no JS at all, but neither is reliably available at this
     project's stated Chrome 120+ target (contrast-color() only reached
     stable at Chrome 147). setAccentColor must be taught to recompute
     --btn-primary-fg/--btn-destructive-fg itself, the same way it already
     recomputes --bc-focus-ring/--bc-border-focus on every accent change. */
  --btn-primary-fg: ${btnPrimaryFg.color};
  --btn-primary-fg-hover: ${pickButtonFg(accentHover).color};
  --btn-primary-fg-active: ${pickButtonFg(shade(accent, isDark ? 0.14 : -0.14)).color};

  --btn-secondary-bg-default: transparent;
  --btn-secondary-bg-hover: color-mix(in srgb, var(--bc-text) 8%, transparent);
  --btn-secondary-bg-active: color-mix(in srgb, var(--bc-text) 14%, transparent);
  --btn-secondary-fg: var(--bc-text);

  --btn-destructive-bg-default: var(--bc-danger);
  --btn-destructive-bg-hover: ${mix("var(--bc-danger)", 8)};
  --btn-destructive-bg-active: ${mix("var(--bc-danger)", 14)};
  /* See --btn-primary-fg above: same fix, same known runtime-override gap,
     picked against --bc-danger instead of --bc-accent. */
  --btn-destructive-fg: ${btnDestructiveFg.color};
  --btn-destructive-fg-hover: ${pickButtonFg(shade(danger, isDark ? 0.08 : -0.08)).color};
  --btn-destructive-fg-active: ${pickButtonFg(shade(danger, isDark ? 0.14 : -0.14)).color};

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
/* Text color has to reach every real leaf node: Claude's signed-out page
   assigns dark utility colors directly to its headings and Google button.
   On a dark preset, a zero-specificity :where() rule loses that cascade and
   leaves dark text on our dark canvas. Scope this direct selector away from
   injected BetterClaude chrome; the intentional button/link rules below are
   more specific and still own their colored foregrounds. */
body, ${PAGE_ROOT_SCOPE} {
  color: var(--bc-text) !important;
}
/* Claude's signed-out build can ship an inline-important foreground utility.
   Keep a deliberately simple, unambiguous fallback selector as the last
   line of defense: an invalid/unsupported complex :not() selector must
   never make a login page unreadable. Later component rules still override
   this for primary/destructive buttons and links. */
body.bc-signed-out * {
  color: var(--bc-text) !important;
}

/* claude.ai's sidebar <nav> carries no stable class or testid of its own \u2014
   only Tailwind utility classes that vary across builds \u2014 but it always
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

/* Sidebar / settings nav items as a proper state machine (\xA71, \xA73): resting
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
   <textarea> \u2014 "form textarea"/"textarea" never matched anything real.
   data-testid="chat-input" is the verified hook onto the actual element \u2014
   but that element is only the inner text row (verified live: ~636px),
   narrower than the real rounded composer card wrapping it (~672px, its
   own native background, no stable testid to hook). A previous session
   painted a background/border/radius/width directly on this narrower node
   and shipped a "cut-off rectangle" behind the placeholder text \u2014 a second,
   mismatched rounded box that fell short of the real card's right edge.
   The real card IS reachable, just not by id: it's the nearest ancestor
   that directly contains this node, matched with :has(). Painting ONLY
   color there (no border-radius, no width) follows the real card's own
   native geometry instead of fighting it, while finally fixing its actual
   bug: claude.ai paints its own background on that card regardless of
   BetterClaude's page-wide text color, so a light BetterClaude theme's
   near-black text forced onto a still-dark native card (or vice versa) was
   landing at ~1.2:1 contrast \u2014 invisible. --bc-composer-* tokens are
   generated to guarantee contrast against EACH OTHER, not against the page
   bg (see pickComposerFg/pickComposerPlaceholder above).

   SINGLE-POINT-OF-FAILURE FIX: the ONLY verified hook is the testid on the
   inner text row \u2014 "the paintable card is its direct parent <div>" was never
   checked against the live site. If the real card is a grandparent, isn't a
   <div>, or an extra wrapper sits in between, the old direct-child-only rule
   matches nothing and the whole composer fix silently no-ops while every
   automated check still reports green. Two independent layers of defense
   replace that single guess:

   1. A small, BOUNDED set of ancestor selectors, not just the direct parent.
      Each one is restricted three ways so it can't runaway to a full-pane
      wrapper (the "cut-off rectangle"'s inverse failure mode \u2014 painting a
      container far bigger than the real card):
        - Tag-restricted to div/form only: claude.ai's own body/html elements
          can never match a div:has(...)/form:has(...) selector by
          construction, no :not() needed for those.
        - Depth-bounded via chained '>' child combinators (1, 2, then 3 hops
          up from the testid node) instead of a bare unrestricted :has()
          descendant search \u2014 CSS has no "nth ancestor" combinator, so
          stacking '> * > *' chains is the closest equivalent to "search only
          the next few levels", which keeps the match close to the real
          composer instead of walking arbitrarily far up the tree to the
          nearest div that happens to contain it (which could be the entire
          chat pane).
        - :not(:has(nav)) on every rule: a legitimate composer card never
          also contains the entire sidebar nav element \u2014 any ancestor that
          does is structurally the app shell, not the card, so it's excluded
          outright regardless of depth.
      Rules are listed most-specific (direct parent) first; since a single
      real ancestor node can only ever satisfy exactly one depth (it's either
      1, 2, or 3 hops from the testid node, never more than one), "most
      specific wins" here just means the closest true ancestor is the one
      that actually matches \u2014 the deeper rules exist purely to reach a real
      card that turns out to sit further up. Multiple rules CAN match
      different ancestor nodes at once (e.g. both the true parent and a
      wrapper two levels up) \u2014 that's harmless by construction because every
      rule paints only background/border-color (never border-width, radius,
      or an explicit box size, same restriction as the original single
      rule), so stacked same-color fills on nested divs produce one seamless
      region, not a second mismatched box.
   2. A same-color safety net directly on the verified
      [data-testid="chat-input"] node itself: --bc-composer-bg is now
      painted there too, not just --bc-composer-fg. Reasoning, stated
      explicitly: CSS can't express "only apply this if the card selector
      above matched nothing" \u2014 so the choice is between always painting it
      (safe: unreadable text, a P0, can never happen even if every ancestor
      selector above misses) or never painting it (unsafe: one wrong DOM
      assumption away from silently shipping invisible text again, the exact
      bug this whole fix exists to prevent). The fail-safe choice is to
      always paint it. This does NOT reintroduce the old "cut-off rectangle"
      bug: that bug came from also setting a mismatched
      border/border-radius/width on the narrow inner node, drawing a
      visibly separate box short of the real card's edge. Here only a flat
      background (no border, no radius, no width) is set, using the SAME
      --bc-composer-bg token as the ancestor rules \u2014 when an ancestor rule
      also matches, the two same-color fills merge seamlessly (no visible
      seam, nothing narrower drawn on top); when every ancestor rule misses,
      this is the only thing standing between the user and unreadable text,
      so it degrades to "background is native-card-sized instead of
      full-card-sized" (a P2 cosmetic mismatch) rather than "text is
      invisible" (a P0). */
div:has(> [data-testid="chat-input"]):not(:has(nav)),
div:has(> * > [data-testid="chat-input"]):not(:has(nav)),
div:has(> * > * > [data-testid="chat-input"]):not(:has(nav)),
form:has(> [data-testid="chat-input"]):not(:has(nav)),
form:has(> * > [data-testid="chat-input"]):not(:has(nav)),
form:has(> * > * > [data-testid="chat-input"]):not(:has(nav)) {
  background: var(--bc-composer-bg) !important;
  border-color: var(--bc-composer-border) !important;
  /* Whichever of these ancestors is the real card, claude.ai insets it
     slightly from the outer rounded card it sits in \u2014 so a square-cornered
     fill here draws a visibly sharp rectangle inside a rounded box (verified
     on a live "new chat" screen). Round it for the same reason as the
     chat-input rule below. Still no border-width and no explicit size, so
     this cannot recreate the old "cut-off rectangle" (that came from a
     mismatched border + width, neither of which is set here), and stacked
     same-color fills on nested ancestors still merge into one region. */
  border-radius: ${RADIUS} !important;
}
[data-testid="chat-input"] {
  /* Safety net (see comment above): same --bc-composer-bg as the card rules
     above, flat fill only \u2014 no border, no width \u2014 so it merges seamlessly
     when an ancestor rule also matched, and still guarantees readable text
     when none of them did.
     The one exception to "flat fill only" is the radius below. The old
     hard-square fill read as a distinct sharp-cornered rectangle sitting
     inside the rounded composer card whenever it was even slightly lighter
     or darker than that card \u2014 the "rectangle inside the chatbox" bug.
     Adding ONLY a radius (still no border, no width, no explicit size)
     cannot reintroduce the original "cut-off rectangle" bug: that one came
     from a mismatched border + width drawing a visibly separate box short of
     the card's right edge, neither of which is set here. Worst case the
     corners round slightly more or less than the native card's \u2014 cosmetic,
     and strictly closer to it than square corners were. */
  background: var(--bc-composer-bg) !important;
  color: var(--bc-composer-fg) !important;
  border-radius: ${RADIUS} !important;
}
/* ProseMirror renders its placeholder either as a [data-placeholder]
   attribute-carrying node or an .is-empty node, with the visible text
   drawn via a ::before pseudo-element in most builds \u2014 cover both the
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

/* The "Claude is AI and can make mistakes" strip under the composer.
   claude.ai wraps it in a div carrying its own "bg-bg-100" utility \u2014 an
   OPAQUE fill (measured live: rgb(32, 32, 31)) that is invisible in the
   stock app only because it happens to equal the stock page background.
   Against any BetterClaude theme it stops matching and reads as a solid box
   sitting behind the warning, which is not what the real app looks like.
   Three things are corrected here, all measured on the live element:
     - background -> transparent, so the line floats on the page like it does
       in the stock app instead of sitting in a slab;
     - font-size -> 12px. Its "text-xs" (0.75rem = 12px) was being overridden
       to 15px by this scaffold's own base font-size rule, which is why the
       small print wasn't small. An explicit px value is used rather than an
       em/rem so it can't drift with the user's base-size setting \u2014 this is
       fine print, not body copy;
     - color -> the muted token, since claude.ai's own "text-text-500" muting
       loses to the scaffold's forced page text color.
   Scoped through :has() to the sticky container that actually holds the
   composer, so it can only ever match the strip attached to the composer and
   not some other small centered text elsewhere in the app. Both the
   "text-xs" and "text-center" hooks are listed because either utility alone
   is enough to identify it if claude.ai drops the other.
   NOTE: no backticks anywhere in this comment \u2014 it sits inside a template
   literal, where one stray backtick silently ends the string and breaks the
   entire module. */
[class*="sticky"]:has([data-testid="chat-input"]) > div[class*="text-xs"]${OWN_CHROME_EXCLUDE},
[class*="sticky"]:has([data-testid="chat-input"]) > div[class*="text-center"]${OWN_CHROME_EXCLUDE} {
  background: transparent !important;
  background-color: transparent !important;
  border: none !important;
  color: var(--bc-text-muted) !important;
  font-size: 12px !important;
}
/* The link inside the strip is a page element too, so the same page-wide
   forced text color lands on it directly and the muting above would stop at
   the wrapper. OWN_CHROME_EXCLUDE is carried here for the same reason as
   above: without it this selector loses to that rule's ID-heavy
   specificity, and the declaration would sit in the stylesheet doing
   nothing \u2014 measured, not assumed (the computed color stayed the full page
   text color until the exclusion was appended). No hex literal is written
   in this comment on purpose: it ships inside every generated theme file,
   and the audit rejects hardcoded hex there. */
[class*="sticky"]:has([data-testid="chat-input"]) > div[class*="text-xs"] a${OWN_CHROME_EXCLUDE},
[class*="sticky"]:has([data-testid="chat-input"]) > div[class*="text-center"] a${OWN_CHROME_EXCLUDE} {
  color: var(--bc-text-muted) !important;
  font-size: 12px !important;
}

/* Popovers that open UPWARD out of the composer (the model picker is the
   one users hit constantly). Measured live: the menu's bottom edge landed at
   y=775 with the trigger at y=779 \u2014 a 4px gap \u2014 which put the menu's lower
   border flush against the composer card it opens out of, so the two boxes
   read as one welded shape instead of a menu floating above a card.
   Only elements the popper has actually placed above their trigger are
   touched (data-side="top"), so menus that open downward, sideways, or from
   anywhere else in the app keep their native offset.
   The transform goes on the menu CONTENT, not on the popper wrapper: the
   wrapper is what the positioning logic owns, and overwriting its transform
   is how you break placement entirely. The content's own transform was
   measured as "none", so this is a purely visual nudge that leaves every
   anchor calculation untouched. */
[role="menu"][data-side="top"],
[role="listbox"][data-side="top"] {
  transform: translateY(-8px) !important;
}

/* All buttons: relational radius (never a raw px), resting state only.
   Excludes BetterClaude's own injected chrome (title bar, settings panel,
   HUD, plugin dock) \u2014 those have their own fixed styling (e.g. the title
   bar's circular traffic lights) and must never follow the page's shape
   preference. */
button${OWN_CHROME_EXCLUDE} {
  border-radius: ${RADIUS} !important;
}

/* Primary / send \u2014 DEFAULT state, resting. Hover is applied separately and
   only through a real :hover selector, gated to non-touch pointers.
   button[class*="primary"] is deliberately NOT used here: claude.ai's own
   buttons carry generic Tailwind utility classes like "hover:text-primary"
   on ordinary icon buttons (verified live on its Search button), so that
   substring match was silently mis-coloring unrelated buttons rather than
   doing nothing. data-testid*="send" has no confirmed match yet either \u2014
   kept as a harmless no-op hook until a real one is found.
   These selectors are built from SCAFFOLD_PAINTED_BUTTON_ATTRS (defined
   above, exported below) rather than hardcoded here \u2014 that constant is THE
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
    color: var(--btn-primary-fg-hover) !important;
  }
  button${SCAFFOLD_PAINTED_BUTTON_ATTRS.destructive.join(":hover, button")}:hover {
    background: var(--btn-destructive-bg-hover) !important;
    color: var(--btn-destructive-fg-hover) !important;
  }
}

/* Pressed state works on touch and mouse alike (\xA71.2): default -> active ->
   default with no stuck hover. */
button${SCAFFOLD_PAINTED_BUTTON_ATTRS.primary.join(":active, button")}:active {
  background: var(--btn-primary-bg-active) !important;
  color: var(--btn-primary-fg-active) !important;
}
button${SCAFFOLD_PAINTED_BUTTON_ATTRS.destructive.join(":active, button")}:active {
  background: var(--btn-destructive-bg-active) !important;
  color: var(--btn-destructive-fg-active) !important;
}

/* Keyboard focus ring \u2014 ALWAYS present, contrast-enforced, independent of the
   theme's accent so it can't vanish on a low-contrast accent (\xA71.1).
   [data-testid="chat-input"] is excluded here and given its own rule below \u2014
   see the comment above that selector: it's the narrower inner text row
   (~636px), not the real rounded composer card (~672px) around it, so the
   generic 2px offset used everywhere else draws a ring whose right edge
   lands short of the card's actual right wall \u2014 visually "cut off" against
   the real border. A larger offset pushes the ring out to roughly hug the
   real card's edge instead. */
button:focus-visible, a:focus-visible, textarea:focus-visible,
input:focus-visible, [tabindex]:focus-visible:not([data-testid="chat-input"]),
[role="tab"]:focus-visible {
  outline: 2px solid var(--bc-focus-ring) !important;
  outline-offset: 2px !important;
}
/* Plain :focus (not just :focus-visible) is covered too \u2014 contenteditable
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
      function extractThemeVars(cssText) {
        const out = {};
        const re = /(--bc-[a-z-]+|--btn-(?:primary|destructive)-fg(?:-(?:hover|active))?)\s*:\s*([^;]+);/gi;
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
        pickButtonFg,
        SCAFFOLD_PAINTED_BUTTON_ATTRS,
        pickComposerFg,
        pickComposerPlaceholder,
        buildScaffoldCSS,
        extractThemeVars
      };
    }
  });

  // core/background.js
  var require_background = __commonJS({
    "core/background.js"(exports, module) {
      var {
        evaluateContrast,
        relativeLuminance,
        WCAG_AA_BODY,
        clampNumber,
        BOUNDS
      } = require_tokens();
      var BG_STYLE_ID = "betterclaude-background";
      var MAIN_PANE = 'main, [data-testid="conversation"], [role="main"]';
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
        return `filter: brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturate}%) grayscale(${f.grayscale}%) sepia(${f.sepia}%) hue-rotate(${f.hueRotate}deg);`;
      }
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
        const imagePosition = bg.mode === "image" && bg.offsetX != null && bg.offsetY != null ? `${bg.offsetX}% ${bg.offsetY}%` : bg.position || "center";
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
/* Static frame for users who asked the OS to reduce motion (\xA74.1). */
@media (prefers-reduced-motion: reduce) {
  ${scope}::before { animation: none !important; }
}` : ""}
`.trim();
      }
      function applyBackground(bg = {}, doc = typeof document !== "undefined" ? document : null) {
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
      function backgroundContrast(bg = {}, textColor = "#ece7fb") {
        if (!bg || bg.mode === "off") return { applicable: false, passes: true };
        const scrim = { color: bg.scrimColor || "#000000", opacity: clampNumber(bg.scrimOpacity, BOUNDS["background.scrimOpacity"]) };
        if (bg.mode === "image") {
          const overWhite = evaluateContrast(textColor, "#ffffff", scrim, WCAG_AA_BODY);
          const overBlack = evaluateContrast(textColor, "#000000", scrim, WCAG_AA_BODY);
          const worst = overWhite.ratio <= overBlack.ratio ? overWhite : overBlack;
          return { applicable: true, ...worst };
        }
        const base = bg.mode === "gradient" ? bg.color || "#14101f" : bg.color || "#14101f";
        return { applicable: true, ...evaluateContrast(textColor, base, scrim, WCAG_AA_BODY) };
      }
      module.exports = {
        BG_STYLE_ID,
        buildBackgroundCSS,
        applyBackground,
        backgroundContrast
      };
    }
  });

  // core/theme-engine.js
  var require_theme_engine = __commonJS({
    "core/theme-engine.js"(exports, module) {
      var tokens = require_tokens();
      var {
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
        SCAFFOLD_PAINTED_BUTTON_ATTRS
      } = tokens;
      var { applyBackground } = require_background();
      var THEME_STYLE_ID = "betterclaude-theme";
      var CUSTOM_STYLE_ID = "betterclaude-custom-css";
      var BASE_STYLE_ID = "betterclaude-base";
      var SELECTORS = {
        sidebar: 'nav:has([data-testid="pin-sidebar-toggle"])',
        // claude.ai's own pin/unpin control for the sidebar (the pin glyph near the
        // top-right of the nav). Same verified testid the sidebar selector above
        // hangs off — hiding this key never breaks that, because :has() matches a
        // display:none child just fine.
        sidebarPin: '[data-testid="pin-sidebar-toggle"]',
        sidebarToggle: 'button[aria-label*="sidebar" i]',
        chatHeader: "header",
        composer: '[data-testid="chat-input"]',
        suggestedPrompts: '[data-testid="suggested-prompts"]'
      };
      var THEME_VAR_DEFS = [
        { key: "--bc-bg", label: "Background", type: "color", default: "#14101f" },
        { key: "--bc-bg-elevated", label: "Composer / panel background", type: "color", default: "#1c1630" },
        { key: "--bc-bg-sidebar", label: "Sidebar background", type: "color", default: "#100c1c" },
        { key: "--bc-text", label: "Text", type: "color", default: "#ece7fb" },
        { key: "--bc-text-muted", label: "Muted text", type: "color", default: "#a99bd1" },
        { key: "--bc-border", label: "Borders", type: "color", default: "#2c2347" },
        { key: "--bc-bubble-user", label: "Your message bubble", type: "color", default: "#2a1f4d" },
        { key: "--bc-bubble-assistant", label: "Assistant message bubble", type: "color", default: "transparent" },
        { key: "--bc-danger", label: "Destructive / delete", type: "color", default: "#ef4444" }
      ];
      function buildThemeCSSFromVars(vars = {}, name = "Imported Theme") {
        const merged = {};
        THEME_VAR_DEFS.forEach((d) => {
          merged[d.key] = vars[d.key] || d.default;
        });
        Object.assign(merged, vars);
        const isDark = tokens.relativeLuminance(merged["--bc-bg"] || "#14101f") < 0.4;
        return buildScaffoldCSS(merged, { name, isDark });
      }
      function resolveScheduledTheme(schedule, { now = /* @__PURE__ */ new Date(), isDarkOS = false } = {}) {
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
          const inDarkWindow = darkMin > lightMin ? nowMin >= darkMin || nowMin < lightMin : nowMin >= darkMin && nowMin < lightMin;
          return inDarkWindow ? schedule.darkThemeId : schedule.lightThemeId;
        }
        return null;
      }
      function lighten(hex, amount) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex);
        if (!m) return hex;
        const num = parseInt(m[1], 16);
        const channel = (shift) => {
          const c = num >> shift & 255;
          return Math.max(0, Math.min(255, Math.round(c + (255 - c) * amount)));
        };
        const r = channel(16), g = channel(8), b = channel(0);
        return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, "0")}`;
      }
      var DARK_LUMINANCE_THRESHOLD = 0.4;
      var _originalColorModeState = null;
      function syncClaudeColorMode(isDark) {
        if (typeof document === "undefined") return;
        const root = document.documentElement;
        if (_originalColorModeState === null) {
          _originalColorModeState = {
            colorScheme: root.style.colorScheme || "",
            hadDarkClass: root.classList.contains("dark")
          };
        }
        root.style.colorScheme = isDark ? "dark" : "light";
        root.classList.toggle("dark", isDark);
      }
      function restoreClaudeColorMode() {
        if (typeof document === "undefined" || _originalColorModeState === null) return;
        const root = document.documentElement;
        root.style.colorScheme = _originalColorModeState.colorScheme;
        root.classList.toggle("dark", _originalColorModeState.hadDarkClass);
      }
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
      var PAGE_BTN = `button:not(#betterclaude-titlebar *):not(#betterclaude-settings-panel *):not(#betterclaude-hud *):not(#betterclaude-plugin-dock *)`;
      var PAINTED_BUTTON_ATTRS = [
        ...SCAFFOLD_PAINTED_BUTTON_ATTRS.primary,
        ...SCAFFOLD_PAINTED_BUTTON_ATTRS.destructive
      ];
      var PAINTED_BUTTON_EXCLUDE = PAINTED_BUTTON_ATTRS.map((attr) => `:not(${attr})`).join("");
      var OWN_CHROME_IDS = ["betterclaude-titlebar", "betterclaude-settings-panel", "betterclaude-hud", "betterclaude-plugin-dock"];
      var OWN_CHROME_EXCLUDE = OWN_CHROME_IDS.map((id) => `:not(#${id}):not(#${id} *)`).join("");
      var PAGE_ROOT_SCOPE = `body *${OWN_CHROME_EXCLUDE}`;
      function buildBaseCSS(settings) {
        const { layout, fonts } = settings;
        const ae = settings.appearanceEditor || {};
        const hiddenKeys = [
          ...layout.hiddenElements || [],
          ...layout.hideSidebarPin ? ["sidebarPin"] : []
        ];
        const hideRules = [...new Set(hiddenKeys)].map((key) => SELECTORS[key]).filter(Boolean).map((sel) => `${sel} { display: none !important; }`).join("\n");
        const hasCustomWidth = layout.sidebarWidthPx != null;
        const ratio = shapeRatio(ae.shape || "rounded");
        const sizeScale = clampNumber(
          ae.sizeScale != null ? ae.sizeScale : ae.buttonScale,
          BOUNDS["appearanceEditor.sizeScale"]
        );
        const st = sizeTokens(sizeScale);
        const resizeButtons = Math.abs(sizeScale - 1) > 1e-3;
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

  /* Relational radius + size tokens (\xA72.1, \xA72.3). radius = height * ratio,
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
   actually reaches visible text \u2014 inheritance only fills in properties
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
   aren't SVGs \u2014 they're ligature glyphs from a private-use-area icon font
   (Anthropicons-Variable), set per-element via an inline, non-!important
   style="font-family: var(--font-anthropicons, ...)" on [data-cds="Icon"].
   The blanket rule above still beats that (author-stylesheet !important
   overrides inline non-!important, regardless of specificity), which was
   silently replacing every one of those glyphs with its .notdef fallback
   box \u2014 the "all icons look identical/missing" bug. Restore it explicitly. */
[data-cds="Icon"] {
  font-family: var(--font-anthropicons, Anthropicons-Variable) !important;
}
/* Same failure mode as the icon-font fix above, different property: claude.ai
   opts specific compact icon+label controls out of normal line-height via
   Tailwind's leading-none utility (line-height: 1), so a label's line box
   is exactly as tall as its text and sits flush with a fixed-size sibling
   icon \u2014 e.g. the model picker's "Sonnet 5 Low" trigger, whose label div is
   text-[14px] h-[14px] leading-none items-baseline next to its chevron.
   The blanket rule above still beats that (measured: computed line-height on
   that div was 22.5px, not the ~14px leading-none gives it), inflating the
   label inside a box that never grows to match \u2014 the text sinking below its
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
   composer card's bottom edge \u2014 tight enough to read as the glow touching
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
   left edge is plain main-pane again \u2014 undo #bc-companion's default
   sidebar-width offset (ui/overlays.css), which would otherwise land it in
   the middle of the content instead of flush against the now-empty corner. */
#bc-companion { left: 16px !important; }
` : ""}
/* Claude's own button variants already choose readable text color for
   their own background. We force a readable color on all descendant text
   (below) for our theme's dark surfaces, but that same override makes
   buttons whose native background is light (e.g. the logged-out landing
   page's primary CTA) render white-on-white. Only the buttons the scaffold
   itself re-skins with a forced background (PAINTED_BUTTON_ATTRS above \u2014
   currently send / delete / remove) are excluded here; every other button
   gets its inherited background stripped so our forced text color sits on
   the page background instead of an invisible native one.
   Scoped away from our own injected chrome (title bar / settings panel /
   HUD) so it doesn't also blank out our own "bc-btn" buttons.
   PAINTED_BUTTON_EXCLUDE is derived from tokens.SCAFFOLD_PAINTED_BUTTON_ATTRS
   \u2014 the SAME list buildScaffoldCSS uses to decide which buttons get a
   painted background \u2014 specifically so this exclusion can never drift from
   what the scaffold actually paints again (Defect 1: a
   :not([class*="primary"]) exclusion here outlived the scaffold rule it
   was written for; the scaffold stopped painting button[class*="primary"]
   entirely once that substring match was found to mis-color ordinary
   Tailwind-classed icon buttons on claude.ai, but this file's exclusion list
   was never updated, so buttons matching that stale selector fell through
   both rules and rendered claude.ai's native light chrome under forced theme
   text \u2014 invisible white-on-white on every dark theme). */
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
/* Real size system (\xA72.2/\xA72.3): resize through height/padding/font so layout
   actually reflows, hit area stays >= ${tokens.SIZE_BASE.minHitPx}px, and text
   never blurs \u2014 NOT transform: scale(), which changes visual size without
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
      var ThemeEngine = class {
        constructor({ presets = {} } = {}) {
          this.presets = presets;
          this.settings = null;
        }
        registerPreset(id, css) {
          this.presets[id] = css;
        }
        applySettings(settings) {
          this.settings = settings;
          ensureStyleTag(BASE_STYLE_ID).textContent = buildBaseCSS(settings);
          const themeCSS = settings.appearance.activeTheme === "custom" ? settings.appearance.customThemeCSS || "" : this.presets[settings.appearance.activeTheme] || "";
          ensureStyleTag(THEME_STYLE_ID).textContent = themeCSS;
          syncClaudeColorModeFromThemeCSS(themeCSS);
          ensureStyleTag(CUSTOM_STYLE_ID).textContent = settings.customCSS.code || "";
          if (settings.appearance.accentColor) {
            this.setAccentColor(settings.appearance.accentColor);
          }
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
          const themeCSS = themeId === "custom" ? this.settings.appearance.customThemeCSS || "" : this.presets[themeId] || "";
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
          const rootStyle = getComputedStyle(document.documentElement);
          const bg = rootStyle.getPropertyValue("--bc-bg").trim() || "#14101f";
          const sidebar = rootStyle.getPropertyValue("--bc-bg-sidebar").trim() || bg;
          const elevated = rootStyle.getPropertyValue("--bc-bg-elevated").trim() || bg;
          const ring = focusRingColor(color, [
            bg,
            tokens.resolveOpaqueColor(sidebar, bg) || bg,
            tokens.resolveOpaqueColor(elevated, bg) || bg
          ]);
          document.documentElement.style.setProperty("--bc-focus-ring", ring);
          document.documentElement.style.setProperty("--bc-border-focus", ring);
          const text = getComputedStyle(document.documentElement).getPropertyValue("--bc-text").trim() || "#ece7fb";
          const link = deriveAccessibleColor(color, text, (hex) => contrastRatio(hex, bg) >= WCAG_AA_BODY);
          document.documentElement.style.setProperty("--bc-link", link);
          document.documentElement.style.setProperty("--btn-primary-fg", tokens.pickButtonFg(color).color);
          const isDark = tokens.relativeLuminance(bg) < DARK_LUMINANCE_THRESHOLD;
          document.documentElement.style.setProperty("--btn-primary-fg-hover", tokens.pickButtonFg(lighten(color, 0.18)).color);
          document.documentElement.style.setProperty("--btn-primary-fg-active", tokens.pickButtonFg(tokens.shade(color, isDark ? 0.14 : -0.14)).color);
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
      };
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
        restoreClaudeColorMode
      };
    }
  });

  // core/compose-insert.js
  var require_compose_insert = __commonJS({
    "core/compose-insert.js"(exports, module) {
      function findComposer(root = document) {
        return root.querySelector(
          '[data-testid="chat-input"], [data-testid="composer"] textarea, form textarea, textarea, [contenteditable="true"][role="textbox"]'
        );
      }
      function isTextArea(composer) {
        return composer && composer.tagName === "TEXTAREA";
      }
      function getComposerText(composer) {
        if (!composer) return "";
        return isTextArea(composer) ? composer.value : composer.innerText || composer.textContent || "";
      }
      function emitInput(composer, value) {
        let event;
        try {
          event = new InputEvent("input", { bubbles: true, inputType: "insertText", data: value });
        } catch (_e) {
          event = new Event("input", { bubbles: true });
        }
        composer.dispatchEvent(event);
      }
      function setComposerText(composer, value) {
        composer.focus();
        if (isTextArea(composer)) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
          nativeSetter.call(composer, value);
          emitInput(composer, value);
          return;
        }
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
        const wrote = document.execCommand && document.execCommand("insertText", false, value);
        if (!wrote) {
          composer.textContent = value;
          emitInput(composer, value);
        }
      }
      function insertIntoComposer(text, { append = true, root = document } = {}) {
        const composer = findComposer(root);
        if (!composer) return false;
        const current = getComposerText(composer);
        const nextValue = append && current ? `${current}
${text}` : text;
        setComposerText(composer, nextValue);
        return true;
      }
      function waitForComposer({ root = document, timeoutMs = 8e3, intervalMs = 150 } = {}) {
        return new Promise((resolve) => {
          const existing = findComposer(root);
          if (existing) {
            resolve(existing);
            return;
          }
          const start = Date.now();
          const timer = setInterval(() => {
            const found = findComposer(root);
            if (found) {
              clearInterval(timer);
              resolve(found);
            } else if (Date.now() - start > timeoutMs) {
              clearInterval(timer);
              resolve(null);
            }
          }, intervalMs);
        });
      }
      module.exports = {
        findComposer,
        getComposerText,
        setComposerText,
        insertIntoComposer,
        waitForComposer
      };
    }
  });

  // core/plugin-loader.js
  var require_plugin_loader = __commonJS({
    "core/plugin-loader.js"(exports, module) {
      var DOCK_ID = "betterclaude-plugin-dock";
      var DOCK_STYLE_ID = "betterclaude-plugin-dock-style";
      var { insertIntoComposer } = require_compose_insert();
      var dragSrcPluginId = null;
      function reorderDockChildren(dock, order) {
        if (!dock || !order || !order.length) return;
        const byId = /* @__PURE__ */ new Map();
        Array.from(dock.children).forEach((child) => {
          if (child.dataset && child.dataset.bcPluginId) byId.set(child.dataset.bcPluginId, child);
        });
        order.forEach((id) => {
          const child = byId.get(id);
          if (child) dock.appendChild(child);
        });
      }
      function ensureDock() {
        let dock = document.getElementById(DOCK_ID);
        if (!dock) {
          dock = document.createElement("div");
          dock.id = DOCK_ID;
          document.body.appendChild(dock);
        }
        if (!document.getElementById(DOCK_STYLE_ID)) {
          const style = document.createElement("style");
          style.id = DOCK_STYLE_ID;
          style.textContent = `
      #${DOCK_ID} {
        position: fixed;
        /* claude.ai's own "Focus Mode" button sits at roughly top:44px,
           right:16px in the composer header \u2014 the same corner this dock
           used to claim, so the two painted on top of each other. Dropping
           below it clears that native control instead of covering it. */
        top: 88px;
        right: 16px;
        z-index: 2147482900;
        display: flex;
        gap: 8px;
      }
      #${DOCK_ID} .bc-dock-btn {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.15);
        background: rgba(20,16,31,0.85);
        color: #ece7fb;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      @media (hover: hover) and (pointer: fine) {
        #${DOCK_ID} .bc-dock-btn:hover {
          background: rgba(139,92,246,0.35);
          border-color: rgba(139,92,246,0.5);
        }
      }
      #${DOCK_ID} .bc-dock-btn.bc-active {
        background: var(--bc-accent, #8b5cf6);
        border-color: var(--bc-accent, #8b5cf6);
        color: var(--btn-primary-fg, #fff);
      }
      #${DOCK_ID} .bc-dock-btn svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
    `;
          document.head.appendChild(style);
        }
        return dock;
      }
      function createPluginAPI({ id, themeEngine, getSettings, setSetting, host }) {
        const injectedStyleId = `betterclaude-plugin-style-${id}`;
        const dockButtons = [];
        return {
          id,
          insertIntoComposer(text, options) {
            return insertIntoComposer(text, options);
          },
          injectCSS(css) {
            let tag = document.getElementById(injectedStyleId);
            if (!tag) {
              tag = document.createElement("style");
              tag.id = injectedStyleId;
              document.head.appendChild(tag);
            }
            tag.textContent = css;
          },
          removeCSS() {
            const tag = document.getElementById(injectedStyleId);
            if (tag) tag.remove();
          },
          /**
           * Adds an icon button to the shared plugin toolbar dock (top-right,
           * below the title bar) instead of a plugin-owned `position: fixed`
           * element. `icon` is a small inline SVG string (stroke: currentColor,
           * so it follows the active theme's text color); `label` doubles as the
           * title/aria-label. Returns { setActive(bool), remove() }.
           */
          mountToolbarButton({ icon, label, active = false, onClick } = {}) {
            const dock = ensureDock();
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "bc-dock-btn";
            btn.innerHTML = icon || "";
            btn.dataset.bcPluginId = id;
            if (label) {
              btn.title = label;
              btn.setAttribute("aria-label", label);
            }
            if (active) btn.classList.add("bc-active");
            if (onClick) btn.addEventListener("click", (e) => onClick(e));
            btn.draggable = true;
            btn.addEventListener("dragstart", (e) => {
              dragSrcPluginId = id;
              btn.classList.add("bc-dragging");
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", id);
              }
            });
            btn.addEventListener("dragend", () => btn.classList.remove("bc-dragging"));
            btn.addEventListener("dragover", (e) => {
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            });
            btn.addEventListener("drop", (e) => {
              e.preventDefault();
              const draggedId = dragSrcPluginId;
              if (!draggedId || draggedId === id) return;
              const draggedEl = dock.querySelector(`[data-bc-plugin-id="${draggedId}"]`);
              if (!draggedEl) return;
              dock.insertBefore(draggedEl, btn);
              const newOrder = Array.from(dock.children).map((c) => c.dataset.bcPluginId).filter(Boolean);
              setSetting("cursor.dockOrder", newOrder);
            });
            dock.appendChild(btn);
            dockButtons.push(btn);
            const settings = getSettings();
            reorderDockChildren(dock, settings.cursor && settings.cursor.dockOrder);
            return {
              el: btn,
              setActive(isActive) {
                btn.classList.toggle("bc-active", !!isActive);
              },
              remove() {
                btn.remove();
                const idx = dockButtons.indexOf(btn);
                if (idx >= 0) dockButtons.splice(idx, 1);
                if (dock.children.length === 0) dock.remove();
              }
            };
          },
          /** Register a value under settings.plugins.data[id][key], persisted by the host. */
          registerSetting(key, defaultValue) {
            const settings = getSettings();
            const pluginData = settings.plugins.data && settings.plugins.data[id] || {};
            if (!(key in pluginData)) {
              setSetting(`plugins.data.${id}.${key}`, defaultValue);
              return defaultValue;
            }
            return pluginData[key];
          },
          getSetting(key) {
            const settings = getSettings();
            const pluginData = settings.plugins.data && settings.plugins.data[id] || {};
            return pluginData[key];
          },
          setSetting(key, value) {
            setSetting(`plugins.data.${id}.${key}`, value);
          },
          getTheme() {
            return themeEngine.settings ? themeEngine.settings.appearance.activeTheme : null;
          },
          /** DOM query helper scoped to document, exposed so plugins don't need `window`. */
          query(selector) {
            return document.querySelector(selector);
          },
          queryAll(selector) {
            return Array.from(document.querySelectorAll(selector));
          },
          /** Minimal toast/notification affordance shared by plugins. */
          notify(message, { timeout = 3e3 } = {}) {
            host.notify ? host.notify(message, { timeout }) : console.log(`[BetterClaude:${id}]`, message);
          },
          /** Host calls this on unload as a safety net for buttons a plugin forgot to remove(). */
          _removeDockButtons() {
            const dock = document.getElementById(DOCK_ID);
            dockButtons.splice(0).forEach((btn) => btn.remove());
            if (dock && dock.children.length === 0) dock.remove();
          }
        };
      }
      var PluginLoader = class {
        constructor({ themeEngine, getSettings, setSetting, host = {} }) {
          this.themeEngine = themeEngine;
          this.getSettings = getSettings;
          this.setSetting = setSetting;
          this.host = host;
          this.loaded = /* @__PURE__ */ new Map();
        }
        /** moduleObj is the already-evaluated {name, version, onLoad, onUnload}. */
        load(id, moduleObj) {
          if (this.loaded.has(id)) this.unload(id);
          const api = createPluginAPI({
            id,
            themeEngine: this.themeEngine,
            getSettings: this.getSettings,
            setSetting: this.setSetting,
            host: this.host
          });
          try {
            moduleObj.onLoad && moduleObj.onLoad(api);
            this.loaded.set(id, { module: moduleObj, api });
            return true;
          } catch (err) {
            console.error(`[BetterClaude] plugin "${id}" failed to load`, err);
            return false;
          }
        }
        unload(id) {
          const entry = this.loaded.get(id);
          if (!entry) return;
          try {
            entry.module.onUnload && entry.module.onUnload();
          } catch (err) {
            console.error(`[BetterClaude] plugin "${id}" threw during onUnload`, err);
          }
          entry.api.removeCSS();
          entry.api._removeDockButtons();
          this.loaded.delete(id);
        }
        unloadAll() {
          Array.from(this.loaded.keys()).forEach((id) => this.unload(id));
        }
        list() {
          return Array.from(this.loaded.entries()).map(([id, entry]) => ({
            id,
            name: entry.module.name,
            version: entry.module.version
          }));
        }
        isLoaded(id) {
          return this.loaded.has(id);
        }
      };
      module.exports = { PluginLoader, createPluginAPI };
    }
  });

  // core/settings-schema.js
  var require_settings_schema = __commonJS({
    "core/settings-schema.js"(exports, module) {
      var DEFAULT_SETTINGS = {
        general: {
          // Master kill-switch: when false, all BetterClaude theming/chrome/
          // plugins are torn down and the app reverts to stock claude.ai. Kept
          // separate from `appearance` so it's trivial to check first, before
          // any other section is even consulted.
          enabled: true
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
            mode: "off",
            // "off" | "time" | "os" | "season"
            lightThemeId: "arctic-light",
            darkThemeId: "betterclaude-default",
            lightStart: "07:00",
            darkStart: "19:00"
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
            lon: null
          }
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
          radiusScale: 1
        },
        background: {
          // Customizable background for the MAIN CHAT PANE ONLY (§4.1) — never the
          // sidebar, top bar, or modals unless unifyAllSurfaces is set.
          mode: "off",
          // "off" | "solid" | "gradient" | "image"
          color: "#11121a",
          gradient: "linear-gradient(135deg, #191a25, #11121a)",
          imageDataUrl: "",
          // data: URI so it survives without file:// access under CSP
          fit: "cover",
          // "cover" | "contain" | "tile" | "center"
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
            hueRotate: 0
          },
          opacity: 1,
          // Scrim between background and text; contrast is enforced against this.
          scrimColor: "#000000",
          scrimOpacity: 0.35,
          blurPx: 0,
          animated: false,
          // respected only when prefers-reduced-motion is not set
          unifyAllSurfaces: false,
          // Rotates through a small pool of saved background snapshots on a timer.
          // Each pool entry is a subset of this same object's shape (mode/color/
          // gradient/imageDataUrl/fit) — scrim/opacity/blur stay global.
          rotation: {
            enabled: false,
            intervalMinutes: 60,
            pool: []
          }
        },
        customCSS: {
          code: ""
        },
        fonts: {
          uiFont: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
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
          dyslexiaMode: false
        },
        layout: {
          // null = don't touch claude.ai's own sidebar width at all; a number
          // forces that width. The Layout section's slider writes a number as soon
          // as it's dragged, and a "Use claude.ai's default width" button puts it
          // back to null — it used to sit disabled behind a separate "recommended"
          // checkbox, which read as the control being permanently locked.
          sidebarWidthPx: null,
          // claude.ai's own pin/collapse toggle for the sidebar. Hidden by default
          // because this app wants the sidebar left open at a chosen width (chat
          // titles and section names visible) rather than collapsed to an icon
          // rail. Hidden with display:none rather than removed, specifically
          // because theme-engine's sidebar selector reaches the <nav> THROUGH this
          // button (`nav:has([data-testid="pin-sidebar-toggle"])`) — :has() still
          // matches a display:none child, so all sidebar theming survives; actually
          // deleting the node would silently un-theme the entire sidebar.
          hideSidebarPin: true,
          sidebarPosition: "left",
          // "left" | "right"
          compactMode: false,
          hiddenElements: [],
          // array of element keys, see core/theme-engine.js SELECTORS
          // Superset of compactMode: "compact" keeps compactMode's existing CSS
          // path, "spacious" is new (extra breathing room), "comfortable" is the
          // default (today's normal spacing).
          density: "comfortable",
          // "compact" | "comfortable" | "spacious"
          // View + pin state for the Widget Gallery (settings -> Widgets) — the
          // one surface in this app that's fully ours to relayout, unlike
          // claude.ai's own conversation view.
          widgetGalleryView: "grid",
          // "grid" | "list" | "card"
          pinnedWidgets: []
        },
        plugins: {
          // pluginId -> boolean enabled
          enabled: {
            "markdown-plus": false,
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
            "goal-tracker": false
          },
          data: {}
        },
        playful: {
          // Snake is no longer something you sit and play inside the settings
          // panel. It surfaces where waiting actually happens: while Claude is
          // generating a response, as a dismissable corner popup (see
          // electron/preload.js mountWaitingGame). Dismissing it with the X only
          // dismisses THAT wait — it comes back on the next one, which is the
          // point of it.
          snakeWhileWaiting: false,
          // How long Claude has to stay busy before the popup appears. Short
          // answers finish well inside this, so the game never flashes up and
          // vanishes on a one-line reply.
          snakeDelayMs: 2e3
        },
        keyboardShortcuts: {
          toggleSettings: "CommandOrControl+,",
          toggleAlwaysOnTop: "CommandOrControl+Shift+T",
          openPromptPicker: "CommandOrControl+Shift+P",
          // Opens (or focuses) the embedded Claude Code window. A menu accelerator,
          // not a globalShortcut — it should only fire while BetterClaude has focus,
          // unlike the prompt picker.
          openCodeWindow: "CommandOrControl+Shift+K"
        },
        // Native File Watcher Sync — "attach" inserts the file's content as a
        // labeled fenced code block (core/file-sync-indicator.js), not a fake of
        // claude.ai's own native upload UI. "stale" means the disk file changed
        // since it was last inserted and auto-reattach couldn't (or wasn't asked
        // to) find-and-replace it in an unsent composer.
        fileWatcher: {
          enabled: false,
          // { id, path, label, autoReattach, lastDiskContent, stale, lastSyncedAt }
          // The composer marker is derived from `label` (see core/file-sync-
          // indicator.js's marker()), not stored separately.
          watched: []
        },
        // Usage Analytics Dashboard — off by default, like the other background-
        // logging features (skillMarketplace). Historical charts are built from
        // usage events logged locally as you go (electron/analytics-db.js, a WASM
        // SQLite database under userData/analytics.sqlite).
        analytics: {
          enabled: false
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
          manifest: {},
          // relPath -> { hash, kind: "plugin"|"theme" }
          conflicts: [],
          // { relPath, kind, filename } — both repo and local changed since last sync
          pendingUpdates: []
          // { relPath, kind, filename } — only populated when autoApply is false
        },
        // In-app updates via GitHub Releases (electron-updater). ON by default,
        // unlike the other network features here: this one only ever contacts the
        // project's own release feed, downloads nothing without an explicit click
        // (autoDownload is forced false in electron/main.js), and a user who
        // can't discover updates is a user stuck on a build with known bugs.
        updates: {
          autoCheck: true,
          // Version string the user pressed "Later" on, so the in-app banner
          // stays dismissed for THAT version but reappears for the next one.
          // Deliberately not a plain boolean — a permanent "never show updates"
          // flag is what `autoCheck: false` already is.
          dismissedVersion: null
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
          lastSyncedAt: null
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
          installed: {}
        },
        promptLibrary: {
          enabled: false,
          // { id, title, body, tags: [], folder, shortcut, createdAt, updatedAt }
          prompts: [],
          folders: []
        },
        cursor: {
          style: "default",
          // "default" | "dot" | "crosshair"
          trail: "off",
          // "off" | "sparkles" | "particles" | "comet"
          trailDensity: 0.5,
          ripple: false,
          magnetic: false,
          magneticStrength: 0.4,
          // Right-click quick-action menu (replaces claude.ai's own context menu
          // with a small radial of BetterClaude actions).
          radialMenu: false,
          // User-chosen order for the plugin dock icons; empty = load order.
          dockOrder: []
        },
        sound: {
          pack: "off",
          // "off" | "8bit" | "minimal" | "soft" — all procedural (Web Audio), no shipped audio files
          muted: false,
          volume: 0.6,
          perType: {
            click: false,
            hover: false,
            notification: false,
            achievement: false
          },
          ambient: {
            track: "off",
            // "off" | "rain" | "cafe" | "lofi" — procedurally generated noise
            volume: 0.3
          },
          // Visual micro-pulse substitute — desktop has no rumble motor.
          hapticsIntensity: 0.5
        },
        motion: {
          speed: 1,
          // 0 = fully off .. 1 = normal .. 2 = double speed
          transition: "fade",
          // "fade" | "slide" | "zoom" | "none" — applied to BetterClaude's own overlays
          easing: "smooth",
          // "smooth" | "bouncy"
          // false (default) = respect the OS "reduce motion" preference; true =
          // play full motion regardless. There's no separate "respect" flag —
          // respecting the system setting is just the absence of this override.
          overrideReducedMotion: false,
          confetti: false,
          parallax: false,
          seasonalDecorations: false
        },
        notifications: {
          style: "banner",
          // "banner" | "popup" | "badge"
          dnd: {
            enabled: false,
            start: "22:00",
            end: "08:00"
          },
          // Per-category on/off + custom color/icon. achievement/update are the
          // only two that may bypass DND (see core/notifications.js PRIORITY).
          types: {
            theme: { enabled: false, color: "#8b5cf6", icon: "" },
            plugin: { enabled: false, color: "#8b5cf6", icon: "" },
            achievement: { enabled: false, color: "#f5c518", icon: "" },
            update: { enabled: false, color: "#22c55e", icon: "" }
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
            intervalMinutes: 15
          }
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
          readingFont: ""
          // empty = inherit fonts.uiFont
        },
        personality: {
          // Keep the app's first-run surface focused on Claude itself; the mascot
          // is opt-in.
          companionEnabled: false,
          userName: "",
          statusMessage: "",
          greetingStyle: "timeOfDay",
          // "timeOfDay" | "streak" | "name"
          mood: null,
          // "energetic" | "calm" | "focused" | "playful" | null
          streak: { count: 0, lastActiveDate: "" },
          achievements: [],
          // unlocked achievement ids, see core/companion.js CATALOG
          // User-added entries merged into core/motion-fx.js's built-in
          // LOADING_TIPS pool (real + joke), shown while claude.ai's page loads.
          customLoadingTips: { real: [], joke: [] },
          // Konami-code unlock gate for themes/secret-rainbow.css.
          easterEggs: { konamiUnlocked: false }
        },
        commandPalette: {
          // Bounded to "set setting X to value Y" (no arbitrary code execution).
          customCommands: []
          // [{id, label, settingPath, value}]
        },
        profiles: {
          // Also backs the "Time Capsule" feature — same snapshot/restore
          // primitive, just named/framed differently in the UI.
          list: []
          // [{id, name, icon, createdAt, snapshot}]
        },
        automations: {
          // Curated, reliable toggles rather than a free-form rule builder.
          zenMutesSound: false,
          achievementBurstsConfetti: false,
          focusPausesAmbient: false
        },
        buddies: {
          // Master switch. Off by default so a fresh install doesn't drop a
          // character onto the user's desktop uninvited; when off, the overlay
          // window is destroyed rather than merely hidden (see electron/main.js).
          enabled: false,
          // When off, the buddy stays on its static idle frame no matter what
          // Claude is doing — see core/buddies.js for the registry.
          animations: true,
          // id -> enabled. Per-buddy so each can be toggled independently once
          // there is more than one; only the registered ids are ever consulted.
          perBuddy: { astronaut: true },
          // Screen coordinates of the overlay. null = "not placed yet", which the
          // main process resolves to the primary display's bottom-right corner.
          // Re-clamped against the live displays on every show, so unplugging a
          // monitor can't strand the buddy off-screen.
          position: { x: null, y: null }
        },
        window: {
          width: 1280,
          height: 860,
          x: void 0,
          y: void 0,
          alwaysOnTop: false
        },
        // Embedded Claude Code window (electron/main.js's createCodeWindow +
        // electron/claude-cli.js). Nothing here is auth-related and nothing here is
        // read from Claude Code's own config — these are BetterClaude's own three
        // preferences for the window it draws around the CLI.
        codeWindow: {
          // Directory the last session was started in, so reopening lands back in
          // the project the user was working on rather than at $HOME every time.
          // Re-validated with statSync before use (a stored folder can be renamed or
          // deleted between sessions), falling back to $HOME.
          lastCwd: null,
          // Escape hatch for a version-managed or non-standard install that isn't on
          // the PATH a GUI app inherits. null = resolve `claude` the way a shell
          // would. This is a path to an EXECUTABLE, never to a config or credential
          // file.
          claudePath: null,
          // Terminal font size in px. Separate from fonts.baseSizePx (which sizes
          // claude.ai's prose): a comfortable reading size for chat is usually too
          // large for a terminal that has to fit 100+ columns. The font FAMILY is
          // shared — it reuses fonts.codeFont, so picking a coding font in Settings
          // applies here too.
          fontSizePx: 13
        }
      };
      function isPlainObject(v) {
        return v && typeof v === "object" && !Array.isArray(v);
      }
      function deepMerge(defaults, stored) {
        if (!isPlainObject(defaults)) return stored !== void 0 ? stored : defaults;
        const out = { ...defaults };
        if (!isPlainObject(stored)) return out;
        for (const key of Object.keys(stored)) {
          out[key] = isPlainObject(defaults[key]) ? deepMerge(defaults[key], stored[key]) : stored[key];
        }
        return out;
      }
      function getBounds() {
        try {
          return require_tokens().BOUNDS;
        } catch (_e) {
          return {};
        }
      }
      function getAtPath(obj, keyPath) {
        return keyPath.split(".").reduce((o, k) => o == null ? void 0 : o[k], obj);
      }
      function setAtPath(obj, keyPath, value) {
        const parts = keyPath.split(".");
        const last = parts.pop();
        const parent = parts.reduce((o, k) => o[k] = o[k] || {}, obj);
        parent[last] = value;
      }
      function clampSettings(settings) {
        const bounds = getBounds();
        Object.entries(bounds).forEach(([keyPath, spec]) => {
          const current = getAtPath(settings, keyPath);
          if (current === void 0) return;
          const clamped = spec.nullable && current == null ? null : (() => {
            const n = Number(current);
            if (!Number.isFinite(n)) return spec.default;
            return Math.max(spec.min, Math.min(spec.max, n));
          })();
          setAtPath(settings, keyPath, clamped);
        });
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
    }
  });

  // core/extras-css.js
  var require_extras_css = __commonJS({
    "core/extras-css.js"(exports, module) {
      var { clampNumber, BOUNDS } = require_tokens();
      var OVERLAY_SELECTORS = `
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
/* Cursor style: ${style}. Left off text-entry surfaces on purpose \u2014 a
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
   Always boosts contrast while active \u2014 that's the point of the mode,
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
/* General accessibility contrast boost \u2014 layers on top of any theme. */
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
/* Frosted-glass overlays \u2014 BetterClaude's own chrome only. */
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
        const curve = motion.easing === "bouncy" ? "cubic-bezier(0.34, 1.56, 0.64, 1)" : "cubic-bezier(0.4, 0, 0.2, 1)";
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
      function moodTintCSS() {
        return `
[data-bc-mood="energetic"] { filter: saturate(1.08); }
[data-bc-mood="calm"] { filter: saturate(0.94) brightness(1.01); }
[data-bc-mood="focused"] { filter: saturate(0.97) contrast(1.02); }
[data-bc-mood="playful"] { filter: saturate(1.12) hue-rotate(2deg); }
`;
      }
      var ZEN_MODE_CSS = `
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
          ZEN_MODE_CSS
        ];
        return parts.filter(Boolean).join("\n").trim();
      }
      var COLOR_BLIND_SAFE_DANGER = "#D55E00";
      function applyColorBlindSafeVars(enabled, doc = typeof document !== "undefined" ? document : null) {
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
        OVERLAY_SELECTORS
      };
    }
  });

  // core/icons.js
  var require_icons = __commonJS({
    "core/icons.js"(exports, module) {
      var ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
      module.exports = {
        WARNING: `<svg ${ATTRS}><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4"/><path d="M12 17h.01"/></svg>`,
        FLAME: `<svg ${ATTRS}><path d="M12 2c1 3-2 4.5-2 7.5a4 4 0 0 0 8 0c0-1.5-.6-2.3-1-3 .8 3-1 4.5-2 3 .6-2-1-3.5-1-5-1 1-2 2.5-2 4.5-1-1-1-4 0-7z"/><path d="M8.5 14.5a3.5 3.5 0 1 0 7 0c0-1-.5-1.8-1-2.5-.3 1.5-1.3 2-1.5 1-1 1-1.5 0-1-1.5-1.6.7-2.5 1.8-3.5 3z"/></svg>`,
        SPARKLE: `<svg ${ATTRS}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/></svg>`,
        SHUFFLE: `<svg ${ATTRS}><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`,
        MUTE: `<svg ${ATTRS}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`,
        ZEN: `<svg ${ATTRS}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>`,
        COMMAND: `<svg ${ATTRS}><path d="M9 3.5A2.5 2.5 0 1 0 6.5 6H9v3H6.5A2.5 2.5 0 1 0 9 11.5V9h6v2.5a2.5 2.5 0 1 0 2.5-2.5H15V6h2.5A2.5 2.5 0 1 0 15 3.5V6H9V3.5z"/></svg>`,
        SETTINGS_GEAR: `<svg ${ATTRS}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9V9c.2.6.8 1 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
        TIMER: `<svg ${ATTRS}><path d="M9 2h6"/><path d="M12 8v4l2.5 1.5"/><circle cx="12" cy="13" r="8"/></svg>`,
        QUOTE: `<svg ${ATTRS}><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6A8.4 8.4 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8v.5z"/></svg>`,
        NOTE: `<svg ${ATTRS}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/></svg>`,
        CLOCK: `<svg ${ATTRS}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
        TARGET: `<svg ${ATTRS}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>`,
        BOLT: `<svg ${ATTRS}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>`,
        BOOK: `<svg ${ATTRS}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
        UPLOAD: `<svg ${ATTRS}><path d="M12 16V4"/><path d="M6 9l6-6 6 6"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>`,
        FLIP_H: `<svg ${ATTRS}><path d="M12 3v18"/><path d="M17 8l3 4-3 4"/><path d="M7 8l-3 4 3 4"/></svg>`
      };
    }
  });

  // core/interaction-fx.js
  var require_interaction_fx = __commonJS({
    "core/interaction-fx.js"(exports, module) {
      var MAGNETIC_TARGETS_SELECTOR = "#betterclaude-titlebar button, #betterclaude-settings-panel .bc-btn, #betterclaude-settings-panel .bc-sp-close, #betterclaude-plugin-dock .bc-dock-btn";
      var MAGNETIC_RADIUS_PX = 70;
      var MAX_PARTICLES = 220;
      var ICONS = require_icons();
      var RADIAL_ACTIONS = [
        { id: "settings", label: "Settings", icon: ICONS.SETTINGS_GEAR },
        { id: "shuffle-theme", label: "Shuffle", icon: ICONS.SHUFFLE },
        { id: "zen-mode", label: "Zen", icon: ICONS.ZEN },
        { id: "mute-sound", label: "Mute", icon: ICONS.MUTE },
        { id: "command-palette", label: "Palette", icon: ICONS.COMMAND },
        { id: "surprise-me", label: "Surprise", icon: ICONS.SPARKLE }
      ];
      var InteractionFX = class {
        constructor({ onRadialAction } = {}) {
          this.onRadialAction = onRadialAction || (() => {
          });
          this.settings = null;
          this.canvas = null;
          this.ctx = null;
          this.particles = [];
          this.rafId = null;
          this._radialEl = null;
          this._bound = {};
        }
        mount(settings) {
          this.settings = settings;
          this._ensureCanvas();
          this._bound.onMouseMove = (e) => this._onMouseMove(e);
          this._bound.onClick = (e) => this._onClick(e);
          this._bound.onContextMenu = (e) => this._onContextMenu(e);
          this._bound.onResize = () => this._resize();
          document.addEventListener("mousemove", this._bound.onMouseMove, { passive: true });
          document.addEventListener("click", this._bound.onClick, { passive: true });
          document.addEventListener("contextmenu", this._bound.onContextMenu);
          window.addEventListener("resize", this._bound.onResize);
          this._loop();
        }
        applySettings(settings) {
          this.settings = settings;
        }
        unmount() {
          if (this._bound.onMouseMove) document.removeEventListener("mousemove", this._bound.onMouseMove);
          if (this._bound.onClick) document.removeEventListener("click", this._bound.onClick);
          if (this._bound.onContextMenu) document.removeEventListener("contextmenu", this._bound.onContextMenu);
          if (this._bound.onResize) window.removeEventListener("resize", this._bound.onResize);
          if (this.rafId) cancelAnimationFrame(this.rafId);
          this.rafId = null;
          if (this.canvas) {
            this.canvas.remove();
            this.canvas = null;
            this.ctx = null;
          }
          this.particles = [];
          this._closeRadialMenu();
          this._resetMagnetic();
        }
        _ensureCanvas() {
          if (this.canvas) return;
          const canvas = document.createElement("canvas");
          canvas.id = "bc-fx-canvas";
          document.body.appendChild(canvas);
          this.canvas = canvas;
          this.ctx = canvas.getContext("2d");
          this._resize();
        }
        _resize() {
          if (!this.canvas || !this.ctx) return;
          const dpr = window.devicePixelRatio || 1;
          this.canvas.width = Math.round(window.innerWidth * dpr);
          this.canvas.height = Math.round(window.innerHeight * dpr);
          this.canvas.style.width = `${window.innerWidth}px`;
          this.canvas.style.height = `${window.innerHeight}px`;
          this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        _accent() {
          return this.settings && this.settings.appearance && this.settings.appearance.accentColor || "#8b5cf6";
        }
        _onMouseMove(e) {
          const cursor = this.settings && this.settings.cursor;
          if (!cursor) return;
          if (cursor.trail && cursor.trail !== "off") this._spawnTrail(e.clientX, e.clientY, cursor);
          if (cursor.magnetic) this._applyMagnetic(e.clientX, e.clientY, cursor);
        }
        _spawnTrail(x, y, cursor) {
          const density = cursor.trailDensity != null ? cursor.trailDensity : 0.5;
          if (Math.random() > density) return;
          const color = this._accent();
          const type = cursor.trail;
          if (type === "sparkles") {
            this.particles.push({
              x,
              y,
              vx: (Math.random() - 0.5) * 0.6,
              vy: -Math.random() * 1.2 - 0.3,
              life: 1,
              decay: 0.03,
              size: Math.random() * 2 + 1.5,
              color,
              shape: "star"
            });
          } else if (type === "particles") {
            this.particles.push({
              x,
              y,
              vx: (Math.random() - 0.5) * 1.4,
              vy: (Math.random() - 0.5) * 1.4,
              life: 1,
              decay: 0.025,
              size: Math.random() * 3 + 2,
              color,
              shape: "circle"
            });
          } else if (type === "comet") {
            this.particles.push({ x, y, vx: 0, vy: 0, life: 1, decay: 0.06, size: 6, color, shape: "circle" });
          }
          if (this.particles.length > MAX_PARTICLES) {
            this.particles.splice(0, this.particles.length - MAX_PARTICLES);
          }
        }
        _onClick(e) {
          const cursor = this.settings && this.settings.cursor;
          if (!cursor || !cursor.ripple) return;
          if (e.target && e.target.closest && e.target.closest(
            "select, option, input[type='color'], input[type='date'], input[type='time'], input[type='file']"
          )) return;
          this._spawnRipple(e.clientX, e.clientY);
        }
        _spawnRipple(x, y) {
          const color = this._accent();
          requestAnimationFrame(() => {
            const el = document.createElement("div");
            el.className = "bc-fx-ripple";
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
            el.style.borderColor = color;
            document.body.appendChild(el);
            el.addEventListener("animationend", () => el.remove());
          });
        }
        _applyMagnetic(mouseX, mouseY, cursor) {
          const strength = cursor.magneticStrength != null ? cursor.magneticStrength : 0.4;
          const targets = document.querySelectorAll(MAGNETIC_TARGETS_SELECTOR);
          targets.forEach((el) => {
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dx = mouseX - cx;
            const dy = mouseY - cy;
            const dist = Math.hypot(dx, dy);
            if (dist < MAGNETIC_RADIUS_PX) {
              const pull = (1 - dist / MAGNETIC_RADIUS_PX) * strength;
              el.style.transform = `translate(${(dx * pull).toFixed(1)}px, ${(dy * pull).toFixed(1)}px)`;
            } else if (el.style.transform) {
              el.style.transform = "";
            }
          });
        }
        _resetMagnetic() {
          document.querySelectorAll(MAGNETIC_TARGETS_SELECTOR).forEach((el) => {
            el.style.transform = "";
          });
        }
        _loop() {
          const draw = () => {
            const ctx = this.ctx;
            if (ctx && this.canvas) {
              ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
              this.particles.forEach((p) => {
                p.x += p.vx;
                p.y += p.vy;
                p.life -= p.decay;
                ctx.globalAlpha = Math.max(0, p.life);
                ctx.fillStyle = p.color;
                ctx.strokeStyle = p.color;
                if (p.shape === "star") this._drawStar(ctx, p.x, p.y, p.size);
                else {
                  ctx.beginPath();
                  ctx.arc(p.x, p.y, p.size * Math.max(0.2, p.life), 0, Math.PI * 2);
                  ctx.fill();
                }
              });
              ctx.globalAlpha = 1;
              this.particles = this.particles.filter((p) => p.life > 0);
            }
            this.rafId = requestAnimationFrame(draw);
          };
          this.rafId = requestAnimationFrame(draw);
        }
        _drawStar(ctx, x, y, size) {
          ctx.save();
          ctx.translate(x, y);
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            ctx.rotate(Math.PI / 2);
            ctx.moveTo(0, 0);
            ctx.lineTo(size * 2, 0);
          }
          ctx.stroke();
          ctx.restore();
        }
        _onContextMenu(e) {
          const cursor = this.settings && this.settings.cursor;
          if (!cursor || cursor.radialMenu === false) return;
          if (e.target && e.target.closest && e.target.closest(
            'textarea, input, [contenteditable="true"], #betterclaude-settings-panel'
          )) return;
          e.preventDefault();
          this._openRadialMenu(e.clientX, e.clientY);
        }
        _openRadialMenu(x, y) {
          this._closeRadialMenu();
          const root = document.createElement("div");
          root.id = "bc-radial-menu";
          const radius = 80;
          const margin = radius + 30;
          const clampedX = Math.min(Math.max(x, margin), window.innerWidth - margin);
          const clampedY = Math.min(Math.max(y, margin), window.innerHeight - margin);
          root.style.left = `${clampedX}px`;
          root.style.top = `${clampedY}px`;
          RADIAL_ACTIONS.forEach((action, i) => {
            const angle = i / RADIAL_ACTIONS.length * Math.PI * 2 - Math.PI / 2;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "bc-radial-item";
            btn.style.setProperty("--bc-radial-x", `${Math.round(Math.cos(angle) * radius)}px`);
            btn.style.setProperty("--bc-radial-y", `${Math.round(Math.sin(angle) * radius)}px`);
            btn.innerHTML = `<span class="bc-radial-icon">${action.icon}</span><span class="bc-radial-label">${action.label}</span>`;
            btn.addEventListener("click", () => {
              this.onRadialAction(action.id);
              this._closeRadialMenu();
            });
            root.appendChild(btn);
          });
          document.body.appendChild(root);
          this._radialEl = root;
          this._radialOutside = (ev) => {
            if (!root.contains(ev.target)) this._closeRadialMenu();
          };
          this._radialEsc = (ev) => {
            if (ev.key === "Escape") this._closeRadialMenu();
          };
          setTimeout(() => {
            document.addEventListener("pointerdown", this._radialOutside, true);
            document.addEventListener("keydown", this._radialEsc, true);
          }, 0);
        }
        _closeRadialMenu() {
          if (this._radialEl) {
            this._radialEl.remove();
            this._radialEl = null;
          }
          if (this._radialOutside) document.removeEventListener("pointerdown", this._radialOutside, true);
          if (this._radialEsc) document.removeEventListener("keydown", this._radialEsc, true);
        }
      };
      module.exports = { InteractionFX, RADIAL_ACTIONS, MAGNETIC_TARGETS_SELECTOR };
    }
  });

  // core/sound-engine.js
  var require_sound_engine = __commonJS({
    "core/sound-engine.js"(exports, module) {
      var SoundEngine = class {
        constructor() {
          this.ctx = null;
          this.masterGain = null;
          this.analyser = null;
          this.settings = null;
          this.ambientNodes = null;
          this.ambientTrack = "off";
        }
        _ensureContext() {
          if (this.ctx) return this.ctx;
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtx) return null;
          this.ctx = new AudioCtx();
          this.masterGain = this.ctx.createGain();
          this.analyser = this.ctx.createAnalyser();
          this.analyser.fftSize = 256;
          this.masterGain.connect(this.analyser);
          this.analyser.connect(this.ctx.destination);
          return this.ctx;
        }
        applySettings(settings) {
          this.settings = settings;
          const s = settings.sound || {};
          if (this.masterGain) {
            this.masterGain.gain.value = s.muted ? 0 : s.volume != null ? s.volume : 0.6;
          }
          const wantTrack = s.muted ? "off" : s.ambient && s.ambient.track || "off";
          if (wantTrack !== this.ambientTrack) {
            this.stopAmbient();
            if (wantTrack !== "off") this.startAmbient(wantTrack, s.ambient && s.ambient.volume || 0.3);
          } else if (this.ambientNodes && s.ambient) {
            this._setAmbientVolume(s.ambient.volume);
          }
        }
        /** type: "click" | "hover" | "notification" | "achievement" */
        play(type) {
          const s = this.settings && this.settings.sound;
          if (!s || s.muted || !s.pack || s.pack === "off") return;
          if (s.perType && s.perType[type] === false) return;
          const ctx = this._ensureContext();
          if (!ctx) return;
          if (ctx.state === "suspended") ctx.resume();
          const vol = (s.volume != null ? s.volume : 0.6) * 0.5;
          const presets = {
            "8bit": {
              click: { freq: 440, type: "square", duration: 0.05 },
              hover: { freq: 660, type: "square", duration: 0.03 },
              notification: { freq: 523, type: "square", duration: 0.12 },
              achievement: { freq: 784, type: "square", duration: 0.18 }
            },
            minimal: {
              click: { freq: 800, type: "sine", duration: 0.04 },
              hover: { freq: 900, type: "sine", duration: 0.02 },
              notification: { freq: 660, type: "sine", duration: 0.1 },
              achievement: { freq: 880, type: "sine", duration: 0.15 }
            },
            soft: {
              click: { freq: 300, type: "sine", duration: 0.09, filterFreq: 800 },
              hover: { freq: 350, type: "sine", duration: 0.06, filterFreq: 700 },
              notification: { freq: 400, type: "sine", duration: 0.2, filterFreq: 900 },
              achievement: { freq: 500, type: "sine", duration: 0.3, filterFreq: 1200 }
            }
          };
          const preset = presets[s.pack] && presets[s.pack][type] || presets.minimal[type] || presets.minimal.click;
          this._tone(ctx, { ...preset, volume: vol });
        }
        _tone(ctx, { freq, type = "sine", duration = 0.08, volume = 0.3, filterFreq = null }) {
          const osc = ctx.createOscillator();
          osc.type = type;
          osc.frequency.value = freq;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(volume, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(1e-4, ctx.currentTime + duration);
          let tail = osc;
          if (filterFreq) {
            const filter = ctx.createBiquadFilter();
            filter.type = "lowpass";
            filter.frequency.value = filterFreq;
            tail.connect(filter);
            tail = filter;
          }
          tail.connect(gain);
          gain.connect(this.masterGain || ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + duration + 0.03);
        }
        _createNoiseBuffer(ctx, seconds = 4) {
          const bufferSize = Math.floor(seconds * ctx.sampleRate);
          const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
          return buffer;
        }
        /** track: "rain" | "cafe" | "lofi" — all procedurally generated, no assets. */
        startAmbient(track, volume = 0.3) {
          const ctx = this._ensureContext();
          if (!ctx || track === "off") return;
          if (ctx.state === "suspended") ctx.resume();
          this.stopAmbient();
          const noiseSrc = ctx.createBufferSource();
          noiseSrc.buffer = this._createNoiseBuffer(ctx);
          noiseSrc.loop = true;
          const filter = ctx.createBiquadFilter();
          const gain = ctx.createGain();
          gain.gain.value = volume;
          const lfo = ctx.createOscillator();
          const lfoGain = ctx.createGain();
          if (track === "rain") {
            filter.type = "bandpass";
            filter.frequency.value = 3200;
            filter.Q.value = 0.6;
            lfo.frequency.value = 0.15;
            lfoGain.gain.value = volume * 0.35;
          } else if (track === "cafe") {
            filter.type = "lowpass";
            filter.frequency.value = 900;
            lfo.frequency.value = 0.08;
            lfoGain.gain.value = volume * 0.2;
          } else {
            filter.type = "lowpass";
            filter.frequency.value = 1400;
            lfo.frequency.value = 0.05;
            lfoGain.gain.value = volume * 0.15;
          }
          lfo.connect(lfoGain);
          lfoGain.connect(gain.gain);
          noiseSrc.connect(filter);
          filter.connect(gain);
          gain.connect(this.masterGain || ctx.destination);
          const extraOscs = [];
          if (track === "lofi") {
            [220, 277.18].forEach((freq, i) => {
              const osc = ctx.createOscillator();
              osc.type = "sine";
              osc.frequency.value = freq;
              osc.detune.value = i === 0 ? -6 : 6;
              const oGain = ctx.createGain();
              oGain.gain.value = volume * 0.25;
              osc.connect(oGain);
              oGain.connect(this.masterGain || ctx.destination);
              osc.start();
              extraOscs.push(osc);
            });
          }
          noiseSrc.start();
          lfo.start();
          this.ambientNodes = {
            stop: () => {
              try {
                noiseSrc.stop();
              } catch (_e) {
              }
              try {
                lfo.stop();
              } catch (_e) {
              }
              extraOscs.forEach((o) => {
                try {
                  o.stop();
                } catch (_e) {
                }
              });
            },
            gainNode: gain
          };
          this.ambientTrack = track;
        }
        _setAmbientVolume(volume) {
          if (this.ambientNodes && this.ambientNodes.gainNode) {
            this.ambientNodes.gainNode.gain.value = volume != null ? volume : 0.3;
          }
        }
        stopAmbient() {
          if (this.ambientNodes) {
            this.ambientNodes.stop();
            this.ambientNodes = null;
          }
          this.ambientTrack = "off";
        }
        // 0..1 live amplitude — the only real "audio present" signal this app
        // has, used to pulse a dock button ring rather than faking reactivity to
        // audio that was never actually playing.
        getAmplitude() {
          if (!this.analyser) return 0;
          const data = new Uint8Array(this.analyser.frequencyBinCount);
          this.analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          return sum / data.length / 255;
        }
        pulse(el, intensity = 0.5) {
          if (!el) return;
          const s = this.settings && this.settings.sound;
          const haptics = s && s.hapticsIntensity != null ? s.hapticsIntensity : 0.5;
          const strength = Math.max(0, Math.min(1, intensity * haptics));
          if (strength <= 0) return;
          el.style.setProperty("--bc-haptic-strength", strength.toFixed(2));
          el.classList.add("bc-haptic-pulse");
          setTimeout(() => el.classList.remove("bc-haptic-pulse"), 220);
        }
      };
      module.exports = { SoundEngine };
    }
  });

  // core/vibe-bundles.js
  var require_vibe_bundles = __commonJS({
    "core/vibe-bundles.js"(exports, module) {
      var VIBE_BUNDLES = [
        {
          id: "cyberpunk-pulse",
          label: "Cyberpunk Pulse",
          themeId: "cyberpunk-neon",
          shape: "sharp",
          cursorStyle: "crosshair",
          cursorTrail: "comet",
          soundPack: "8bit",
          easing: "bouncy",
          transition: "slide",
          mood: "energetic",
          featured: true
        },
        {
          id: "cottagecore-calm",
          label: "Cottagecore Calm",
          themeId: "forest-light",
          shape: "soft",
          cursorStyle: "dot",
          cursorTrail: "sparkles",
          soundPack: "soft",
          easing: "smooth",
          transition: "fade",
          mood: "calm",
          featured: true
        },
        {
          id: "y2k-vaporwave",
          label: "Y2K Vaporwave",
          themeId: "vaporwave",
          shape: "pill",
          cursorStyle: "dot",
          cursorTrail: "particles",
          soundPack: "minimal",
          easing: "bouncy",
          transition: "zoom",
          mood: "playful",
          featured: true
        },
        {
          id: "brutalist-mono",
          label: "Brutalist Mono",
          themeId: "high-contrast",
          shape: "sharp",
          cursorStyle: "default",
          cursorTrail: "off",
          soundPack: "off",
          easing: "smooth",
          transition: "none",
          mood: "focused",
          featured: true
        },
        {
          id: "hacker-terminal",
          label: "Hacker Terminal",
          themeId: "hacker-green",
          shape: "sharp",
          cursorStyle: "crosshair",
          cursorTrail: "off",
          soundPack: "8bit",
          easing: "smooth",
          transition: "fade",
          mood: "focused",
          featured: false
        },
        {
          id: "sakura-dream",
          label: "Sakura Dream",
          themeId: "sakura-blossom",
          shape: "rounded",
          cursorStyle: "dot",
          cursorTrail: "sparkles",
          soundPack: "soft",
          easing: "smooth",
          transition: "fade",
          mood: "calm",
          featured: false
        },
        {
          id: "midnight-tokyo",
          label: "Midnight Tokyo",
          themeId: "tokyo-night",
          shape: "rounded",
          cursorStyle: "dot",
          cursorTrail: "comet",
          soundPack: "minimal",
          easing: "bouncy",
          transition: "slide",
          mood: "energetic",
          featured: false
        }
      ];
      function getBundle(id) {
        return VIBE_BUNDLES.find((b) => b.id === id) || null;
      }
      function featuredBundles() {
        return VIBE_BUNDLES.filter((b) => b.featured);
      }
      function pickRandomBundle(excludeId) {
        const candidates = VIBE_BUNDLES.filter((b) => b.id !== excludeId);
        const pool = candidates.length ? candidates : VIBE_BUNDLES;
        return pool[Math.floor(Math.random() * pool.length)];
      }
      function bundlesForMood(mood) {
        return VIBE_BUNDLES.filter((b) => b.mood === mood);
      }
      function bundleForMood(mood) {
        return bundlesForMood(mood)[0] || null;
      }
      var SEASON_BUNDLE_IDS = {
        winter: "midnight-tokyo",
        spring: "sakura-dream",
        summer: "y2k-vaporwave",
        autumn: "cottagecore-calm"
      };
      function seasonForMonth(monthIndex) {
        if ([11, 0, 1].includes(monthIndex)) return "winter";
        if ([2, 3, 4].includes(monthIndex)) return "spring";
        if ([5, 6, 7].includes(monthIndex)) return "summer";
        return "autumn";
      }
      function bundleForSeason(monthIndex) {
        return getBundle(SEASON_BUNDLE_IDS[seasonForMonth(monthIndex)]);
      }
      async function applyBundle(bundle, { setSetting, selectTheme, applyBundlePreview } = {}) {
        if (!bundle || !setSetting) return;
        if (selectTheme) await selectTheme(bundle.themeId);
        else await setSetting("appearance.activeTheme", bundle.themeId);
        if (applyBundlePreview && !selectTheme) applyBundlePreview(bundle);
        await setSetting("appearanceEditor.shape", bundle.shape);
        await setSetting("cursor.style", bundle.cursorStyle);
        await setSetting("cursor.trail", bundle.cursorTrail);
        await setSetting("sound.pack", bundle.soundPack);
        await setSetting("motion.easing", bundle.easing);
        await setSetting("motion.transition", bundle.transition);
      }
      module.exports = {
        VIBE_BUNDLES,
        getBundle,
        featuredBundles,
        pickRandomBundle,
        bundlesForMood,
        bundleForMood,
        seasonForMonth,
        bundleForSeason,
        applyBundle
      };
    }
  });

  // core/motion-fx.js
  var require_motion_fx = __commonJS({
    "core/motion-fx.js"(exports, module) {
      var { seasonForMonth } = require_vibe_bundles();
      var LOADING_TIPS = {
        real: [
          "Tip: Cmd/Ctrl+, opens BetterClaude Settings any time.",
          "Tip: Cmd/Ctrl+K opens the Command Palette.",
          "Tip: Right-click anywhere for a quick-action radial menu.",
          "Tip: Settings -> Widgets has a Pomodoro timer, sticky notes and more.",
          "Tip: The Shuffle button in Settings -> Themes picks a new cohesive look in one click.",
          "Tip: Type the Konami code (\u2191\u2191\u2193\u2193\u2190\u2192\u2190\u2192BA) for a surprise."
        ],
        joke: [
          "Compiling excuses for why the sidebar moved\u2026",
          "Reticulating splines. (There are no splines.)",
          "Feeding the mascot a byte of encouragement.",
          "Asking Claude nicely to hurry up.",
          "Polishing pixels that were already clean.",
          "Negotiating with the CSS cascade."
        ]
      };
      function pickLoadingTip(customTips) {
        const pool = [
          ...LOADING_TIPS.real,
          ...LOADING_TIPS.joke,
          ...customTips && customTips.real || [],
          ...customTips && customTips.joke || []
        ];
        return pool[Math.floor(Math.random() * pool.length)];
      }
      function resizeCanvasToViewport(canvas, ctx) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(window.innerWidth * dpr);
        canvas.height = Math.round(window.innerHeight * dpr);
        canvas.style.width = `${window.innerWidth}px`;
        canvas.style.height = `${window.innerHeight}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      function celebrate({
        particleCount = 140,
        colors = ["#8b5cf6", "#f5c518", "#22c55e", "#ef4444", "#38bdf8"],
        durationMs = 2600
      } = {}) {
        if (typeof document === "undefined") return;
        const canvas = document.createElement("canvas");
        canvas.id = "bc-confetti-canvas";
        document.body.appendChild(canvas);
        const ctx = canvas.getContext("2d");
        resizeCanvasToViewport(canvas, ctx);
        const particles = Array.from({ length: particleCount }, () => ({
          x: Math.random() * window.innerWidth,
          y: -20 - Math.random() * 200,
          vx: (Math.random() - 0.5) * 2,
          vy: Math.random() * 2 + 2,
          rot: Math.random() * 360,
          vr: (Math.random() - 0.5) * 10,
          size: Math.random() * 6 + 4,
          color: colors[Math.floor(Math.random() * colors.length)]
        }));
        const start = performance.now();
        function frame(now) {
          const elapsed = now - start;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          particles.forEach((p) => {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.02;
            p.rot += p.vr;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot * Math.PI / 180);
            ctx.fillStyle = p.color;
            ctx.globalAlpha = Math.max(0, 1 - elapsed / durationMs);
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            ctx.restore();
          });
          if (elapsed < durationMs) requestAnimationFrame(frame);
          else canvas.remove();
        }
        requestAnimationFrame(frame);
      }
      function mountParallax(getTargets) {
        if (typeof document === "undefined") return () => {
        };
        let raf = null;
        const scrollEl = document.querySelector('main, [data-testid="conversation"]') || document.scrollingElement;
        const target = scrollEl || window;
        const onScroll = () => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = null;
            const y = scrollEl ? scrollEl.scrollTop : window.scrollY || 0;
            const offset = Math.max(-8, Math.min(8, y * 0.02));
            (getTargets ? getTargets() : []).forEach((el) => {
              if (el) el.style.setProperty("--bc-parallax-y", `${offset.toFixed(1)}px`);
            });
          });
        };
        target.addEventListener("scroll", onScroll, { passive: true });
        return () => {
          target.removeEventListener("scroll", onScroll);
          if (raf) cancelAnimationFrame(raf);
        };
      }
      var LEAF_COLORS = ["#d97706", "#b45309", "#a16207"];
      function spawnSeasonalParticle(season, allowMidScreen) {
        return {
          x: Math.random() * window.innerWidth,
          y: allowMidScreen ? Math.random() * window.innerHeight : -10 - Math.random() * 40,
          vy: season === "winter" ? Math.random() * 0.6 + 0.3 : Math.random() * 0.8 + 0.5,
          vx: (Math.random() - 0.5) * 0.5,
          size: season === "winter" ? Math.random() * 3 + 2 : Math.random() * 5 + 4,
          rot: Math.random() * 360,
          vr: (Math.random() - 0.5) * 2,
          color: LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)]
        };
      }
      function mountSeasonalDecoration(monthIndex) {
        if (typeof document === "undefined") return () => {
        };
        const season = seasonForMonth(monthIndex);
        if (season !== "winter" && season !== "autumn") return () => {
        };
        const canvas = document.createElement("canvas");
        canvas.id = "bc-seasonal-canvas";
        document.body.appendChild(canvas);
        const ctx = canvas.getContext("2d");
        resizeCanvasToViewport(canvas, ctx);
        const onResize = () => resizeCanvasToViewport(canvas, ctx);
        window.addEventListener("resize", onResize);
        const particles = Array.from({ length: 36 }, () => spawnSeasonalParticle(season, true));
        let rafId = null;
        function frame() {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          particles.forEach((p, i) => {
            p.y += p.vy;
            p.x += p.vx + Math.sin(p.y * 0.01) * 0.3;
            p.rot += p.vr;
            if (p.y > window.innerHeight + 10) particles[i] = spawnSeasonalParticle(season, false);
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot * Math.PI / 180);
            ctx.globalAlpha = 0.75;
            if (season === "winter") {
              ctx.fillStyle = "#ffffff";
              ctx.beginPath();
              ctx.arc(0, 0, p.size, 0, Math.PI * 2);
              ctx.fill();
            } else {
              ctx.fillStyle = p.color;
              ctx.beginPath();
              ctx.ellipse(0, 0, p.size, p.size * 0.6, 0, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.restore();
          });
          rafId = requestAnimationFrame(frame);
        }
        rafId = requestAnimationFrame(frame);
        return () => {
          if (rafId) cancelAnimationFrame(rafId);
          window.removeEventListener("resize", onResize);
          canvas.remove();
        };
      }
      module.exports = {
        LOADING_TIPS,
        pickLoadingTip,
        celebrate,
        mountParallax,
        mountSeasonalDecoration
      };
    }
  });

  // core/companion.js
  var require_companion = __commonJS({
    "core/companion.js"(exports, module) {
      var { FLAME } = require_icons();
      var ACHIEVEMENTS = [
        { id: "first-launch", label: "Hello, BetterClaude", description: "Opened BetterClaude for the first time.", check: (s) => s.launches >= 1 },
        { id: "streak-3", label: "Getting Warmed Up", description: "Reached a 3-day streak.", check: (s) => s.streakCount >= 3 },
        { id: "streak-7", label: "One Week Strong", description: "Reached a 7-day streak.", check: (s) => s.streakCount >= 7 },
        { id: "theme-explorer", label: "Theme Explorer", description: "Tried 3 different themes.", check: (s) => s.themesTried >= 3 },
        { id: "plugin-tinkerer", label: "Plugin Tinkerer", description: "Enabled 3 plugins at once.", check: (s) => s.pluginsEnabledCount >= 3 },
        { id: "night-owl", label: "Night Owl", description: "Used BetterClaude after midnight.", check: (s) => !!s.usedAfterMidnight },
        { id: "konami", label: "Cheat Code", description: "Found the secret input sequence.", check: (s) => !!s.konamiUnlocked }
      ];
      function checkAchievements(stats, alreadyUnlocked = []) {
        const unlocked = new Set(alreadyUnlocked);
        const newlyUnlocked = [];
        ACHIEVEMENTS.forEach((a) => {
          if (!unlocked.has(a.id) && a.check(stats)) {
            unlocked.add(a.id);
            newlyUnlocked.push(a.id);
          }
        });
        return { allUnlocked: Array.from(unlocked), newlyUnlocked };
      }
      function toDateStr(d) {
        return d.toISOString().slice(0, 10);
      }
      function incrementStreak(streak, todayStr = toDateStr(/* @__PURE__ */ new Date())) {
        const prev = streak || { count: 0, lastActiveDate: "" };
        if (prev.lastActiveDate === todayStr) return { count: prev.count || 0, lastActiveDate: todayStr, bumped: false };
        const today = /* @__PURE__ */ new Date(`${todayStr}T00:00:00Z`);
        const yesterday = new Date(today);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        const continuedStreak = prev.lastActiveDate === toDateStr(yesterday);
        const count = continuedStreak ? (prev.count || 0) + 1 : 1;
        return { count, lastActiveDate: todayStr, bumped: true };
      }
      function buildGreeting({ name, streakCount = 0, hour, style = "timeOfDay" } = {}) {
        const h = hour != null ? hour : (/* @__PURE__ */ new Date()).getHours();
        const timeGreeting = h < 5 || h >= 22 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
        const namePart = style !== "timeOfDay" && name && name.trim() ? `, ${name.trim()}` : "";
        const streakPart = style === "streak" && streakCount > 1 ? ` \u2014 ${streakCount} day streak!` : "";
        return `${timeGreeting}${namePart}${streakPart}`;
      }
      function buildCompanionSvg() {
        return `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><circle cx="24" cy="24" r="20" fill="#8b5cf6"/><circle cx="17" cy="22" r="2.6" fill="#14101f"/><circle cx="31" cy="22" r="2.6" fill="#14101f"/><path d="M17 30q7 6 14 0" stroke="#14101f" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`;
      }
      var Companion = class {
        constructor() {
          this.el = null;
          this._bubbleTimeout = null;
          this._reactTimeout = null;
        }
        mount(settings) {
          if (this.el) return this.el;
          const root = document.createElement("div");
          root.id = "bc-companion";
          root.innerHTML = `
      <div class="bc-companion-bubble" data-bc-bubble hidden></div>
      <div class="bc-companion-face" data-bc-face></div>
      <div class="bc-companion-streak" data-bc-streak hidden></div>
    `;
          document.body.appendChild(root);
          this.el = root;
          this.update(settings);
          return root;
        }
        update(settings) {
          if (!this.el) return;
          const personality = settings.personality || {};
          this.el.style.display = personality.companionEnabled === false ? "none" : "flex";
          this.el.querySelector("[data-bc-face]").innerHTML = buildCompanionSvg();
          const streakEl = this.el.querySelector("[data-bc-streak]");
          const count = personality.streak && personality.streak.count || 0;
          if (count > 1) {
            streakEl.hidden = false;
            streakEl.innerHTML = `${FLAME}<span>${count}</span>`;
          } else {
            streakEl.hidden = true;
          }
        }
        say(text, { timeoutMs = 4500 } = {}) {
          if (!this.el || !text) return;
          const bubble = this.el.querySelector("[data-bc-bubble]");
          bubble.textContent = text;
          bubble.hidden = false;
          clearTimeout(this._bubbleTimeout);
          this._bubbleTimeout = setTimeout(() => {
            bubble.hidden = true;
          }, timeoutMs);
        }
        react(kind = "happy", { durationMs = 1500 } = {}) {
          if (!this.el) return;
          const face = this.el.querySelector("[data-bc-face]");
          face.classList.add(`bc-companion-${kind}`);
          clearTimeout(this._reactTimeout);
          this._reactTimeout = setTimeout(() => face.classList.remove(`bc-companion-${kind}`), durationMs);
        }
        unmount() {
          if (this.el) {
            this.el.remove();
            this.el = null;
          }
          clearTimeout(this._bubbleTimeout);
          clearTimeout(this._reactTimeout);
        }
      };
      module.exports = {
        ACHIEVEMENTS,
        checkAchievements,
        incrementStreak,
        buildGreeting,
        buildCompanionSvg,
        Companion
      };
    }
  });

  // core/buddies.js
  var require_buddies = __commonJS({
    "core/buddies.js"(exports, module) {
      var BUDDY_CANVAS = { width: 640, height: 360 };
      var BUDDY_HIT_BOX = { left: 0.3, top: 0.05, right: 0.7, bottom: 0.95 };
      var BUDDIES = [
        {
          id: "astronaut",
          label: "Astronaut",
          description: "Taps away at a keyboard, ponders, then blasts off \u2014 on repeat while Claude works.",
          // Paths are relative to resources/buddies/<id>/.
          assets: {
            idle: "astronaut-idle.png",
            typing: "astronaut-typing.webm",
            thinking: "astronaut-thinking.webm",
            blastoff: "astronaut-blastoff.webm",
            // Played only while the buddy is held, so it is deliberately outside
            // `cycle`. Opens on a startled take, then settles into a run.
            drag: "astronaut-drag.webm"
          },
          // Order of the working-state loop. Advanced by each clip's `ended` event,
          // never by a timer, so it stays correct if clip durations drift.
          cycle: ["typing", "thinking", "blastoff"]
        }
      ];
      function listBuddies() {
        return BUDDIES.slice();
      }
      function getBuddy(id) {
        return BUDDIES.find((b) => b.id === id) || null;
      }
      function resolveActiveBuddy(settings) {
        const cfg = settings && settings.buddies || {};
        if (!cfg.enabled) return null;
        const perBuddy = cfg.perBuddy || {};
        return BUDDIES.find((b) => perBuddy[b.id] === true) || null;
      }
      module.exports = {
        BUDDIES,
        BUDDY_CANVAS,
        BUDDY_HIT_BOX,
        listBuddies,
        getBuddy,
        resolveActiveBuddy
      };
    }
  });

  // core/command-palette.js
  var require_command_palette = __commonJS({
    "core/command-palette.js"(exports, module) {
      function fuzzyScore(query, text) {
        if (!query) return 0;
        const q = query.toLowerCase();
        const t = (text || "").toLowerCase();
        let qi = 0;
        let score = 0;
        let consecutive = 0;
        for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
          if (t[ti] === q[qi]) {
            score += 1 + consecutive * 2;
            if (ti === 0 || /[\s\-_/:.]/.test(t[ti - 1])) score += 3;
            consecutive += 1;
            qi += 1;
          } else {
            consecutive = 0;
          }
        }
        return qi === q.length ? score : -1;
      }
      function scoreCommand(query, cmd) {
        const fields = [cmd.label, cmd.group, cmd.keywords].filter(Boolean);
        return Math.max(...fields.map((f) => fuzzyScore(query, f)), -1);
      }
      var CommandPalette = class {
        constructor({ onExecute } = {}) {
          this.onExecute = onExecute || (() => {
          });
          this.el = null;
          this.commands = [];
          this._filtered = [];
          this._activeIndex = 0;
          this._asyncSource = null;
          this._asyncDebounce = null;
          this._queryToken = 0;
        }
        // fn(query) resolves extra commands (e.g. matching chats) to merge in
        // once the user has typed something — see core/semantic-search.js for
        // the same underlying query this reuses.
        setAsyncSource(fn) {
          this._asyncSource = fn;
        }
        mount() {
          if (this.el) return this.el;
          const overlay = document.createElement("div");
          overlay.id = "bc-command-palette-overlay";
          overlay.innerHTML = `
      <div class="bc-cp-box">
        <input type="text" class="bc-cp-input" placeholder="Type a command\u2026" data-bc-cp-input />
        <div class="bc-cp-list" data-bc-cp-list></div>
      </div>
    `;
          document.body.appendChild(overlay);
          this.el = overlay;
          overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) this.close();
          });
          const input = overlay.querySelector("[data-bc-cp-input]");
          input.addEventListener("input", () => this._renderList(input.value));
          input.addEventListener("keydown", (e) => this._onInputKeydown(e));
          return overlay;
        }
        setCommands(commands) {
          this.commands = commands || [];
        }
        open() {
          if (!this.el) this.mount();
          this.el.classList.add("bc-open");
          const input = this.el.querySelector("[data-bc-cp-input]");
          input.value = "";
          this._renderList("");
          setTimeout(() => input.focus(), 0);
        }
        close() {
          if (this.el) this.el.classList.remove("bc-open");
          clearTimeout(this._asyncDebounce);
        }
        toggle() {
          if (this.el && this.el.classList.contains("bc-open")) this.close();
          else this.open();
        }
        _renderList(query) {
          const q = query.trim();
          this._lastQuery = q;
          if (!q) {
            this._filtered = this.commands.slice(0, 200);
          } else {
            this._filtered = this.commands.map((cmd) => ({ cmd, score: scoreCommand(q, cmd) })).filter((entry) => entry.score >= 0).sort((a, b) => b.score - a.score).map((entry) => entry.cmd);
          }
          this._paint();
          if (q && this._asyncSource) {
            clearTimeout(this._asyncDebounce);
            const token = this._queryToken += 1;
            this._asyncDebounce = setTimeout(() => {
              Promise.resolve(this._asyncSource(q)).then((extra) => {
                if (token !== this._queryToken || this._lastQuery !== q || !extra || extra.length === 0) return;
                this._filtered = [...this._filtered, ...extra];
                this._paint();
              }).catch(() => {
              });
            }, 250);
          }
        }
        _paint() {
          const list = this.el.querySelector("[data-bc-cp-list]");
          list.innerHTML = "";
          this._activeIndex = 0;
          if (this._filtered.length === 0) {
            const empty = document.createElement("div");
            empty.className = "bc-cp-empty";
            empty.textContent = "No matching commands.";
            list.appendChild(empty);
            return;
          }
          this._filtered.forEach((cmd, i) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = `bc-cp-item${i === 0 ? " bc-active" : ""}`;
            const label = document.createElement("span");
            label.className = "bc-cp-item-label";
            label.textContent = cmd.label;
            item.appendChild(label);
            if (cmd.group) {
              const group = document.createElement("span");
              group.className = "bc-cp-item-group";
              group.textContent = cmd.group;
              item.appendChild(group);
            }
            item.addEventListener("click", () => this._run(cmd));
            list.appendChild(item);
          });
        }
        _onInputKeydown(e) {
          const items = Array.from(this.el.querySelectorAll(".bc-cp-item"));
          if (e.key === "ArrowDown") {
            e.preventDefault();
            this._activeIndex = Math.min(items.length - 1, this._activeIndex + 1);
            this._highlight(items);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            this._activeIndex = Math.max(0, this._activeIndex - 1);
            this._highlight(items);
          } else if (e.key === "Enter") {
            e.preventDefault();
            const cmd = this._filtered[this._activeIndex];
            if (cmd) this._run(cmd);
          } else if (e.key === "Escape") {
            this.close();
          }
        }
        _highlight(items) {
          items.forEach((el, i) => el.classList.toggle("bc-active", i === this._activeIndex));
          if (items[this._activeIndex]) items[this._activeIndex].scrollIntoView({ block: "nearest" });
        }
        _run(cmd) {
          this.close();
          this.onExecute(cmd);
        }
        unmount() {
          if (this.el) {
            this.el.remove();
            this.el = null;
          }
        }
      };
      var KONAMI_SEQUENCE = [
        "ArrowUp",
        "ArrowUp",
        "ArrowDown",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "ArrowLeft",
        "ArrowRight",
        "b",
        "a"
      ];
      function mountKonamiListener(onUnlock) {
        let idx = 0;
        const handler = (e) => {
          const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
          if (key === KONAMI_SEQUENCE[idx]) {
            idx += 1;
            if (idx === KONAMI_SEQUENCE.length) {
              idx = 0;
              onUnlock();
            }
          } else {
            idx = key === KONAMI_SEQUENCE[0] ? 1 : 0;
          }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
      }
      module.exports = { CommandPalette, mountKonamiListener, KONAMI_SEQUENCE, fuzzyScore };
    }
  });

  // core/weather.js
  var require_weather = __commonJS({
    "core/weather.js"(exports, module) {
      var { getBundle } = require_vibe_bundles();
      function mapWeatherCodeToBundleId(code, isDay = true) {
        if (code === 0) return isDay ? "y2k-vaporwave" : "midnight-tokyo";
        if (code >= 1 && code <= 3) return isDay ? "sakura-dream" : "midnight-tokyo";
        if (code === 45 || code === 48) return "brutalist-mono";
        if (code >= 51 && code <= 67 || code >= 80 && code <= 82) return "cottagecore-calm";
        if (code >= 71 && code <= 77 || code === 85 || code === 86) return "midnight-tokyo";
        if (code >= 95) return "cyberpunk-pulse";
        return "cottagecore-calm";
      }
      function mapWeatherCodeToBundle(code, isDay = true) {
        return getBundle(mapWeatherCodeToBundleId(code, isDay));
      }
      module.exports = { mapWeatherCodeToBundleId, mapWeatherCodeToBundle };
    }
  });

  // core/notifications.js
  var require_notifications = __commonJS({
    "core/notifications.js"(exports, module) {
      var PRIORITY = {
        theme: false,
        plugin: false,
        achievement: true,
        update: true
      };
      function toMinutes(hhmm) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
        return m ? Number(m[1]) * 60 + Number(m[2]) : null;
      }
      function isWithinDnd(dnd, now = /* @__PURE__ */ new Date()) {
        if (!dnd || !dnd.enabled) return false;
        const startMin = toMinutes(dnd.start);
        const endMin = toMinutes(dnd.end);
        if (startMin == null || endMin == null) return false;
        const nowMin = now.getHours() * 60 + now.getMinutes();
        return startMin > endMin ? nowMin >= startMin || nowMin < endMin : nowMin >= startMin && nowMin < endMin;
      }
      function shouldSuppress(notifications, category, now = /* @__PURE__ */ new Date()) {
        const types = notifications && notifications.types || {};
        const typeConfig = types[category];
        if (typeConfig && typeConfig.enabled === false) return true;
        const dnd = notifications && notifications.dnd;
        if (isWithinDnd(dnd, now) && !PRIORITY[category]) return true;
        return false;
      }
      function notificationStyleClass(style) {
        return { banner: "bc-toast-banner", popup: "bc-toast-popup", badge: "bc-toast-badge" }[style] || "bc-toast-banner";
      }
      module.exports = { PRIORITY, isWithinDnd, shouldSuppress, notificationStyleClass };
    }
  });

  // core/skill-marketplace.js
  var require_skill_marketplace = __commonJS({
    "core/skill-marketplace.js"(exports, module) {
      function escapeHtml(str) {
        return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
      var SkillMarketplaceOverlay = class {
        constructor(host) {
          this.host = host;
          this.el = null;
          this.items = [];
          this.selected = null;
          this.query = "";
          this.sort = "stars";
          this.minStars = 0;
          this._searchTimer = null;
        }
        mount() {
          if (this.el) return this.el;
          const overlay = document.createElement("div");
          overlay.id = "bc-skill-marketplace-overlay";
          overlay.innerHTML = `
      <div class="bc-skm-box">
        <div class="bc-skm-header">
          <input type="text" class="bc-skm-search" placeholder="Search claude-skill repos\u2026" data-bc-skm-search />
          <select class="bc-skm-sort" data-bc-skm-sort>
            <option value="stars">Most stars</option>
            <option value="updated">Recently updated</option>
          </select>
          <input type="number" min="0" class="bc-skm-stars" placeholder="Min \u2605" data-bc-skm-stars />
          <button type="button" class="bc-btn bc-btn-secondary" data-bc-skm-refresh>Search GitHub</button>
          <button type="button" class="bc-skm-close" data-bc-skm-close title="Close">\u2715</button>
        </div>
        <div class="bc-skm-body">
          <div class="bc-skm-list" data-bc-skm-list></div>
          <div class="bc-skm-detail" data-bc-skm-detail>
            <div class="bc-skm-empty">Select a skill to preview its README.</div>
          </div>
        </div>
      </div>
    `;
          document.body.appendChild(overlay);
          this.el = overlay;
          overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) this.close();
          });
          overlay.querySelector("[data-bc-skm-close]").addEventListener("click", () => this.close());
          overlay.querySelector("[data-bc-skm-refresh]").addEventListener("click", () => this.runSearch());
          const search = overlay.querySelector("[data-bc-skm-search]");
          search.addEventListener("input", () => {
            this.query = search.value;
            clearTimeout(this._searchTimer);
            this._searchTimer = setTimeout(() => this.runSearch(), 450);
          });
          search.addEventListener("keydown", (e) => {
            if (e.key === "Escape") this.close();
            if (e.key === "Enter") {
              clearTimeout(this._searchTimer);
              this.runSearch();
            }
          });
          const sort = overlay.querySelector("[data-bc-skm-sort]");
          sort.addEventListener("change", () => {
            this.sort = sort.value;
            this.runSearch();
          });
          const stars = overlay.querySelector("[data-bc-skm-stars]");
          stars.addEventListener("change", () => {
            this.minStars = Number(stars.value) || 0;
            this.runSearch();
          });
          return overlay;
        }
        open() {
          if (!this.el) this.mount();
          this.el.classList.add("bc-open");
          const search = this.el.querySelector("[data-bc-skm-search]");
          setTimeout(() => search.focus(), 0);
          this.items = this.host.getCachedItems() || [];
          this._renderList();
        }
        close() {
          if (this.el) this.el.classList.remove("bc-open");
        }
        toggle() {
          if (this.el && this.el.classList.contains("bc-open")) this.close();
          else this.open();
        }
        async runSearch() {
          const list = this.el.querySelector("[data-bc-skm-list]");
          list.innerHTML = `<div class="bc-skm-loading">Searching GitHub\u2026</div>`;
          try {
            const { items } = await this.host.searchSkills({ query: this.query, sort: this.sort, minStars: this.minStars });
            this.items = items;
            this._renderList();
          } catch (err) {
            list.innerHTML = `<div class="bc-skm-error">${escapeHtml(err.message || String(err))}</div>`;
          }
        }
        _renderList() {
          const list = this.el.querySelector("[data-bc-skm-list]");
          list.innerHTML = "";
          if (this.items.length === 0) {
            list.innerHTML = `<div class="bc-skm-empty">No skills loaded yet \u2014 try a search, or hit "Search GitHub".</div>`;
            return;
          }
          const installedMap = this.host.getInstalledMap() || {};
          this.items.forEach((item) => {
            const installed = installedMap[item.id];
            const updateAvailable = !!(installed && item.pushedAt && new Date(item.pushedAt).getTime() > installed.installedAt);
            const card = document.createElement("div");
            card.className = `bc-skm-card${this.selected && this.selected.id === item.id ? " bc-active" : ""}`;
            card.innerHTML = `
        <div class="bc-skm-card-title">${escapeHtml(item.fullName)}</div>
        <div class="bc-skm-card-desc">${escapeHtml(item.description || "No description.")}</div>
        <div class="bc-skm-card-meta">
          <span>\u2605 ${item.stars}</span>
          <span>${(item.topics || []).slice(0, 3).map(escapeHtml).join(", ")}</span>
          ${installed ? `<span class="bc-skm-badge${updateAvailable ? " bc-skm-badge-update" : ""}">${updateAvailable ? "Update available" : "Installed"}</span>` : ""}
        </div>
      `;
            card.addEventListener("click", () => this.select(item));
            list.appendChild(card);
          });
        }
        async select(item) {
          this.selected = item;
          this._renderList();
          const detail = this.el.querySelector("[data-bc-skm-detail]");
          detail.innerHTML = `<div class="bc-skm-loading">Loading README\u2026</div>`;
          let readme = null;
          let readmeError = null;
          try {
            readme = await this.host.getReadme({ owner: item.owner, repo: item.repo });
          } catch (err) {
            readmeError = err.message || String(err);
          }
          if (this.selected !== item) return;
          detail.innerHTML = "";
          const header = document.createElement("div");
          header.className = "bc-skm-detail-header";
          header.innerHTML = `<h3>${escapeHtml(item.fullName)}</h3><p>${escapeHtml(item.description || "")}</p>`;
          detail.appendChild(header);
          const installedMap = this.host.getInstalledMap() || {};
          const installed = installedMap[item.id];
          const actions = document.createElement("div");
          actions.className = "bc-skm-detail-actions";
          const installBtn = document.createElement("button");
          installBtn.className = "bc-btn";
          installBtn.textContent = installed ? "Reinstall" : "Install";
          installBtn.addEventListener("click", async () => {
            installBtn.disabled = true;
            installBtn.textContent = "Installing\u2026";
            try {
              await this.host.installSkill(item);
              this.host.notify && this.host.notify(`Installed "${item.fullName}" \u2014 upload it via claude.ai Settings \u2192 Capabilities.`);
              this._renderList();
            } catch (err) {
              this.host.notify && this.host.notify(`Install failed: ${err.message}`);
            } finally {
              installBtn.disabled = false;
              installBtn.textContent = (this.host.getInstalledMap() || {})[item.id] ? "Reinstall" : "Install";
            }
          });
          actions.appendChild(installBtn);
          if (installed) {
            const revealBtn = document.createElement("button");
            revealBtn.className = "bc-btn bc-btn-secondary";
            revealBtn.textContent = "Reveal in folder";
            revealBtn.addEventListener("click", () => this.host.revealSkill(item.id));
            actions.appendChild(revealBtn);
          }
          detail.appendChild(actions);
          const readmeBox = document.createElement("pre");
          readmeBox.className = "bc-skm-readme";
          readmeBox.textContent = readmeError ? `Couldn't load README: ${readmeError}` : readme || "No README available.";
          detail.appendChild(readmeBox);
        }
        unmount() {
          if (this.el) {
            this.el.remove();
            this.el = null;
          }
        }
      };
      module.exports = { SkillMarketplaceOverlay };
    }
  });

  // core/prompt-vars.js
  var require_prompt_vars = __commonJS({
    "core/prompt-vars.js"(exports, module) {
      var VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
      function extractVariables(body) {
        const seen = /* @__PURE__ */ new Set();
        const out = [];
        let m;
        VAR_RE.lastIndex = 0;
        while ((m = VAR_RE.exec(body || "")) !== null) {
          if (!seen.has(m[1])) {
            seen.add(m[1]);
            out.push(m[1]);
          }
        }
        return out;
      }
      function fillTemplate(body, values = {}) {
        return String(body || "").replace(VAR_RE, (match, name) => Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
      }
      module.exports = { extractVariables, fillTemplate, VAR_RE };
    }
  });

  // core/prompt-picker.js
  var require_prompt_picker = __commonJS({
    "core/prompt-picker.js"(exports, module) {
      var { extractVariables, fillTemplate } = require_prompt_vars();
      function escapeHtml(str) {
        return String(str == null ? "" : str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
      var PromptPicker = class {
        constructor(host) {
          this.host = host;
          this.el = null;
          this._filtered = [];
          this._activeIndex = 0;
          this._capturedSelection = "";
        }
        mount() {
          if (this.el) return this.el;
          const overlay = document.createElement("div");
          overlay.id = "bc-prompt-picker-overlay";
          overlay.innerHTML = `<div class="bc-pp-box" data-bc-pp-box></div>`;
          document.body.appendChild(overlay);
          this.el = overlay;
          overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) this.close();
          });
          return overlay;
        }
        // promptId: optional — used by the global per-prompt keyboard shortcut to
        // jump straight to one prompt's fill form instead of the search list.
        open(promptId) {
          this._capturedSelection = window.getSelection && window.getSelection().toString() || "";
          if (!this.el) this.mount();
          this.el.classList.add("bc-open");
          const prompt = promptId && this.host.getPrompts().find((p) => p.id === promptId);
          if (prompt) this._selectPrompt(prompt);
          else this._showList("");
        }
        close() {
          if (this.el) this.el.classList.remove("bc-open");
        }
        toggle() {
          if (this.el && this.el.classList.contains("bc-open")) this.close();
          else this.open();
        }
        _showList(query) {
          const box = this.el.querySelector("[data-bc-pp-box]");
          box.innerHTML = `
      <input type="text" class="bc-pp-input" placeholder="Search prompts\u2026" data-bc-pp-input />
      <div class="bc-pp-list" data-bc-pp-list></div>
    `;
          const input = box.querySelector("[data-bc-pp-input]");
          input.value = query || "";
          input.addEventListener("input", () => this._renderList(input.value));
          input.addEventListener("keydown", (e) => this._onInputKeydown(e));
          setTimeout(() => input.focus(), 0);
          this._renderList(query || "");
        }
        _renderList(query) {
          const list = this.el.querySelector("[data-bc-pp-list]");
          if (!list) return;
          list.innerHTML = "";
          const q = query.trim().toLowerCase();
          const prompts = this.host.getPrompts() || [];
          this._filtered = prompts.filter((p) => {
            if (!q) return true;
            return (p.title || "").toLowerCase().includes(q) || (p.folder || "").toLowerCase().includes(q) || (p.tags || []).some((t) => t.toLowerCase().includes(q));
          });
          this._activeIndex = 0;
          if (this._filtered.length === 0) {
            list.innerHTML = `<div class="bc-pp-empty">No prompts found. Add some in Settings \u2192 Prompt Library.</div>`;
            return;
          }
          this._filtered.forEach((p, i) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = `bc-pp-item${i === 0 ? " bc-active" : ""}`;
            const tagsLabel = (p.tags || []).join(", ");
            item.innerHTML = `
        <span class="bc-pp-item-title">${escapeHtml(p.title)}</span>
        <span class="bc-pp-item-meta">${escapeHtml(p.folder || "General")}${tagsLabel ? ` \xB7 ${escapeHtml(tagsLabel)}` : ""}</span>
      `;
            item.addEventListener("click", () => this._selectPrompt(p));
            list.appendChild(item);
          });
        }
        _onInputKeydown(e) {
          const items = Array.from(this.el.querySelectorAll(".bc-pp-item"));
          if (e.key === "ArrowDown") {
            e.preventDefault();
            this._activeIndex = Math.min(items.length - 1, this._activeIndex + 1);
            this._highlight(items);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            this._activeIndex = Math.max(0, this._activeIndex - 1);
            this._highlight(items);
          } else if (e.key === "Enter") {
            e.preventDefault();
            const p = this._filtered[this._activeIndex];
            if (p) this._selectPrompt(p);
          } else if (e.key === "Escape") {
            this.close();
          }
        }
        _highlight(items) {
          items.forEach((el, i) => el.classList.toggle("bc-active", i === this._activeIndex));
          if (items[this._activeIndex]) items[this._activeIndex].scrollIntoView({ block: "nearest" });
        }
        _selectPrompt(prompt) {
          const vars = extractVariables(prompt.body);
          if (vars.length === 0) {
            this._insert(prompt.body, { promptId: prompt.id, values: {} });
            return;
          }
          this._renderForm(prompt, vars);
        }
        _renderForm(prompt, vars) {
          const box = this.el.querySelector("[data-bc-pp-box]");
          box.innerHTML = `
      <div class="bc-pp-form-header">${escapeHtml(prompt.title)}</div>
      <div class="bc-pp-form" data-bc-pp-form></div>
      <div class="bc-pp-form-actions">
        <button type="button" class="bc-pp-form-cancel" data-bc-pp-cancel>Back</button>
        <button type="button" class="bc-pp-form-save" data-bc-pp-insert>Insert</button>
      </div>
    `;
          const form = box.querySelector("[data-bc-pp-form]");
          const inputs = {};
          vars.forEach((name) => {
            const row = document.createElement("label");
            row.className = "bc-pp-form-row";
            const labelEl = document.createElement("span");
            labelEl.textContent = `{{${name}}}`;
            const input = document.createElement("textarea");
            input.rows = 2;
            input.dataset.varName = name;
            row.appendChild(labelEl);
            row.appendChild(input);
            form.appendChild(row);
            inputs[name] = input;
            if (name === "selection") {
              input.value = this._capturedSelection || "";
            } else if (name === "clipboard") {
              if (navigator.clipboard && navigator.clipboard.readText) {
                navigator.clipboard.readText().then((text) => {
                  input.value = text || "";
                }).catch(() => {
                });
              }
            }
          });
          box.querySelector("[data-bc-pp-cancel]").addEventListener("click", () => this._showList(""));
          box.querySelector("[data-bc-pp-insert]").addEventListener("click", () => {
            const values = {};
            vars.forEach((name) => {
              values[name] = inputs[name].value;
            });
            this._insert(fillTemplate(prompt.body, values), { promptId: prompt.id, values });
          });
          const first = form.querySelector("textarea");
          if (first) setTimeout(() => first.focus(), 0);
        }
        // `meta` (optional) is {promptId, values} — used only by the Macro
        // Recorder's capture hook (electron/preload.js) to record this insertion
        // as a re-resolvable prompt step rather than opaque literal text.
        _insert(text, meta) {
          const ok = this.host.insertIntoComposer(text);
          if (ok && meta && this.host.onInsert) this.host.onInsert({ ...meta, filledText: text });
          this.close();
          if (!ok && this.host.notify) this.host.notify("Couldn't find claude.ai's composer.");
        }
        unmount() {
          if (this.el) {
            this.el.remove();
            this.el = null;
          }
        }
      };
      module.exports = { PromptPicker };
    }
  });

  // node_modules/diff/lib/diff/base.js
  var require_base = __commonJS({
    "node_modules/diff/lib/diff/base.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports["default"] = Diff;
      function Diff() {
      }
      Diff.prototype = {
        /*istanbul ignore start*/
        /*istanbul ignore end*/
        diff: function diff(oldString, newString) {
          var _options$timeout;
          var options = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {};
          var callback = options.callback;
          if (typeof options === "function") {
            callback = options;
            options = {};
          }
          var self = this;
          function done(value) {
            value = self.postProcess(value, options);
            if (callback) {
              setTimeout(function() {
                callback(value);
              }, 0);
              return true;
            } else {
              return value;
            }
          }
          oldString = this.castInput(oldString, options);
          newString = this.castInput(newString, options);
          oldString = this.removeEmpty(this.tokenize(oldString, options));
          newString = this.removeEmpty(this.tokenize(newString, options));
          var newLen = newString.length, oldLen = oldString.length;
          var editLength = 1;
          var maxEditLength = newLen + oldLen;
          if (options.maxEditLength != null) {
            maxEditLength = Math.min(maxEditLength, options.maxEditLength);
          }
          var maxExecutionTime = (
            /*istanbul ignore start*/
            (_options$timeout = /*istanbul ignore end*/
            options.timeout) !== null && _options$timeout !== void 0 ? _options$timeout : Infinity
          );
          var abortAfterTimestamp = Date.now() + maxExecutionTime;
          var bestPath = [{
            oldPos: -1,
            lastComponent: void 0
          }];
          var newPos = this.extractCommon(bestPath[0], newString, oldString, 0, options);
          if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
            return done(buildValues(self, bestPath[0].lastComponent, newString, oldString, self.useLongestToken));
          }
          var minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
          function execEditLength() {
            for (var diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
              var basePath = (
                /*istanbul ignore start*/
                void 0
              );
              var removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
              if (removePath) {
                bestPath[diagonalPath - 1] = void 0;
              }
              var canAdd = false;
              if (addPath) {
                var addPathNewPos = addPath.oldPos - diagonalPath;
                canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
              }
              var canRemove = removePath && removePath.oldPos + 1 < oldLen;
              if (!canAdd && !canRemove) {
                bestPath[diagonalPath] = void 0;
                continue;
              }
              if (!canRemove || canAdd && removePath.oldPos < addPath.oldPos) {
                basePath = self.addToPath(addPath, true, false, 0, options);
              } else {
                basePath = self.addToPath(removePath, false, true, 1, options);
              }
              newPos = self.extractCommon(basePath, newString, oldString, diagonalPath, options);
              if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
                return done(buildValues(self, basePath.lastComponent, newString, oldString, self.useLongestToken));
              } else {
                bestPath[diagonalPath] = basePath;
                if (basePath.oldPos + 1 >= oldLen) {
                  maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
                }
                if (newPos + 1 >= newLen) {
                  minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
                }
              }
            }
            editLength++;
          }
          if (callback) {
            (function exec() {
              setTimeout(function() {
                if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
                  return callback();
                }
                if (!execEditLength()) {
                  exec();
                }
              }, 0);
            })();
          } else {
            while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
              var ret = execEditLength();
              if (ret) {
                return ret;
              }
            }
          }
        },
        /*istanbul ignore start*/
        /*istanbul ignore end*/
        addToPath: function addToPath(path, added, removed, oldPosInc, options) {
          var last = path.lastComponent;
          if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
            return {
              oldPos: path.oldPos + oldPosInc,
              lastComponent: {
                count: last.count + 1,
                added,
                removed,
                previousComponent: last.previousComponent
              }
            };
          } else {
            return {
              oldPos: path.oldPos + oldPosInc,
              lastComponent: {
                count: 1,
                added,
                removed,
                previousComponent: last
              }
            };
          }
        },
        /*istanbul ignore start*/
        /*istanbul ignore end*/
        extractCommon: function extractCommon(basePath, newString, oldString, diagonalPath, options) {
          var newLen = newString.length, oldLen = oldString.length, oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
          while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldString[oldPos + 1], newString[newPos + 1], options)) {
            newPos++;
            oldPos++;
            commonCount++;
            if (options.oneChangePerToken) {
              basePath.lastComponent = {
                count: 1,
                previousComponent: basePath.lastComponent,
                added: false,
                removed: false
              };
            }
          }
          if (commonCount && !options.oneChangePerToken) {
            basePath.lastComponent = {
              count: commonCount,
              previousComponent: basePath.lastComponent,
              added: false,
              removed: false
            };
          }
          basePath.oldPos = oldPos;
          return newPos;
        },
        /*istanbul ignore start*/
        /*istanbul ignore end*/
        equals: function equals(left, right, options) {
          if (options.comparator) {
            return options.comparator(left, right);
          } else {
            return left === right || options.ignoreCase && left.toLowerCase() === right.toLowerCase();
          }
        },
        /*istanbul ignore start*/
        /*istanbul ignore end*/
        removeEmpty: function removeEmpty(array) {
          var ret = [];
          for (var i = 0; i < array.length; i++) {
            if (array[i]) {
              ret.push(array[i]);
            }
          }
          return ret;
        },
        /*istanbul ignore start*/
        /*istanbul ignore end*/
        castInput: function castInput(value) {
          return value;
        },
        /*istanbul ignore start*/
        /*istanbul ignore end*/
        tokenize: function tokenize(value) {
          return Array.from(value);
        },
        /*istanbul ignore start*/
        /*istanbul ignore end*/
        join: function join(chars) {
          return chars.join("");
        },
        /*istanbul ignore start*/
        /*istanbul ignore end*/
        postProcess: function postProcess(changeObjects) {
          return changeObjects;
        }
      };
      function buildValues(diff, lastComponent, newString, oldString, useLongestToken) {
        var components = [];
        var nextComponent;
        while (lastComponent) {
          components.push(lastComponent);
          nextComponent = lastComponent.previousComponent;
          delete lastComponent.previousComponent;
          lastComponent = nextComponent;
        }
        components.reverse();
        var componentPos = 0, componentLen = components.length, newPos = 0, oldPos = 0;
        for (; componentPos < componentLen; componentPos++) {
          var component = components[componentPos];
          if (!component.removed) {
            if (!component.added && useLongestToken) {
              var value = newString.slice(newPos, newPos + component.count);
              value = value.map(function(value2, i) {
                var oldValue = oldString[oldPos + i];
                return oldValue.length > value2.length ? oldValue : value2;
              });
              component.value = diff.join(value);
            } else {
              component.value = diff.join(newString.slice(newPos, newPos + component.count));
            }
            newPos += component.count;
            if (!component.added) {
              oldPos += component.count;
            }
          } else {
            component.value = diff.join(oldString.slice(oldPos, oldPos + component.count));
            oldPos += component.count;
          }
        }
        return components;
      }
    }
  });

  // node_modules/diff/lib/diff/character.js
  var require_character = __commonJS({
    "node_modules/diff/lib/diff/character.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.characterDiff = void 0;
      exports.diffChars = diffChars;
      var _base = _interopRequireDefault(require_base());
      function _interopRequireDefault(obj) {
        return obj && obj.__esModule ? obj : { "default": obj };
      }
      var characterDiff = (
        /*istanbul ignore start*/
        exports.characterDiff = /*istanbul ignore end*/
        new /*istanbul ignore start*/
        _base[
          /*istanbul ignore start*/
          "default"
          /*istanbul ignore end*/
        ]()
      );
      function diffChars(oldStr, newStr, options) {
        return characterDiff.diff(oldStr, newStr, options);
      }
    }
  });

  // node_modules/diff/lib/util/string.js
  var require_string = __commonJS({
    "node_modules/diff/lib/util/string.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.hasOnlyUnixLineEndings = hasOnlyUnixLineEndings;
      exports.hasOnlyWinLineEndings = hasOnlyWinLineEndings;
      exports.longestCommonPrefix = longestCommonPrefix;
      exports.longestCommonSuffix = longestCommonSuffix;
      exports.maximumOverlap = maximumOverlap;
      exports.removePrefix = removePrefix;
      exports.removeSuffix = removeSuffix;
      exports.replacePrefix = replacePrefix;
      exports.replaceSuffix = replaceSuffix;
      function longestCommonPrefix(str1, str2) {
        var i;
        for (i = 0; i < str1.length && i < str2.length; i++) {
          if (str1[i] != str2[i]) {
            return str1.slice(0, i);
          }
        }
        return str1.slice(0, i);
      }
      function longestCommonSuffix(str1, str2) {
        var i;
        if (!str1 || !str2 || str1[str1.length - 1] != str2[str2.length - 1]) {
          return "";
        }
        for (i = 0; i < str1.length && i < str2.length; i++) {
          if (str1[str1.length - (i + 1)] != str2[str2.length - (i + 1)]) {
            return str1.slice(-i);
          }
        }
        return str1.slice(-i);
      }
      function replacePrefix(string, oldPrefix, newPrefix) {
        if (string.slice(0, oldPrefix.length) != oldPrefix) {
          throw Error(
            /*istanbul ignore start*/
            "string ".concat(
              /*istanbul ignore end*/
              JSON.stringify(string),
              " doesn't start with prefix "
            ).concat(JSON.stringify(oldPrefix), "; this is a bug")
          );
        }
        return newPrefix + string.slice(oldPrefix.length);
      }
      function replaceSuffix(string, oldSuffix, newSuffix) {
        if (!oldSuffix) {
          return string + newSuffix;
        }
        if (string.slice(-oldSuffix.length) != oldSuffix) {
          throw Error(
            /*istanbul ignore start*/
            "string ".concat(
              /*istanbul ignore end*/
              JSON.stringify(string),
              " doesn't end with suffix "
            ).concat(JSON.stringify(oldSuffix), "; this is a bug")
          );
        }
        return string.slice(0, -oldSuffix.length) + newSuffix;
      }
      function removePrefix(string, oldPrefix) {
        return replacePrefix(string, oldPrefix, "");
      }
      function removeSuffix(string, oldSuffix) {
        return replaceSuffix(string, oldSuffix, "");
      }
      function maximumOverlap(string1, string2) {
        return string2.slice(0, overlapCount(string1, string2));
      }
      function overlapCount(a, b) {
        var startA = 0;
        if (a.length > b.length) {
          startA = a.length - b.length;
        }
        var endB = b.length;
        if (a.length < b.length) {
          endB = a.length;
        }
        var map = Array(endB);
        var k = 0;
        map[0] = 0;
        for (var j = 1; j < endB; j++) {
          if (b[j] == b[k]) {
            map[j] = map[k];
          } else {
            map[j] = k;
          }
          while (k > 0 && b[j] != b[k]) {
            k = map[k];
          }
          if (b[j] == b[k]) {
            k++;
          }
        }
        k = 0;
        for (var i = startA; i < a.length; i++) {
          while (k > 0 && a[i] != b[k]) {
            k = map[k];
          }
          if (a[i] == b[k]) {
            k++;
          }
        }
        return k;
      }
      function hasOnlyWinLineEndings(string) {
        return string.includes("\r\n") && !string.startsWith("\n") && !string.match(/[^\r]\n/);
      }
      function hasOnlyUnixLineEndings(string) {
        return !string.includes("\r\n") && string.includes("\n");
      }
    }
  });

  // node_modules/diff/lib/diff/word.js
  var require_word = __commonJS({
    "node_modules/diff/lib/diff/word.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.diffWords = diffWords;
      exports.diffWordsWithSpace = diffWordsWithSpace;
      exports.wordWithSpaceDiff = exports.wordDiff = void 0;
      var _base = _interopRequireDefault(require_base());
      var _string = require_string();
      function _interopRequireDefault(obj) {
        return obj && obj.__esModule ? obj : { "default": obj };
      }
      var extendedWordChars = "a-zA-Z0-9_\\u{C0}-\\u{FF}\\u{D8}-\\u{F6}\\u{F8}-\\u{2C6}\\u{2C8}-\\u{2D7}\\u{2DE}-\\u{2FF}\\u{1E00}-\\u{1EFF}";
      var tokenizeIncludingWhitespace = new RegExp(
        /*istanbul ignore start*/
        "[".concat(
          /*istanbul ignore end*/
          extendedWordChars,
          "]+|\\s+|[^"
        ).concat(extendedWordChars, "]"),
        "ug"
      );
      var wordDiff = (
        /*istanbul ignore start*/
        exports.wordDiff = /*istanbul ignore end*/
        new /*istanbul ignore start*/
        _base[
          /*istanbul ignore start*/
          "default"
          /*istanbul ignore end*/
        ]()
      );
      wordDiff.equals = function(left, right, options) {
        if (options.ignoreCase) {
          left = left.toLowerCase();
          right = right.toLowerCase();
        }
        return left.trim() === right.trim();
      };
      wordDiff.tokenize = function(value) {
        var options = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {};
        var parts;
        if (options.intlSegmenter) {
          if (options.intlSegmenter.resolvedOptions().granularity != "word") {
            throw new Error('The segmenter passed must have a granularity of "word"');
          }
          parts = Array.from(options.intlSegmenter.segment(value), function(segment) {
            return (
              /*istanbul ignore end*/
              segment.segment
            );
          });
        } else {
          parts = value.match(tokenizeIncludingWhitespace) || [];
        }
        var tokens = [];
        var prevPart = null;
        parts.forEach(function(part) {
          if (/\s/.test(part)) {
            if (prevPart == null) {
              tokens.push(part);
            } else {
              tokens.push(tokens.pop() + part);
            }
          } else if (/\s/.test(prevPart)) {
            if (tokens[tokens.length - 1] == prevPart) {
              tokens.push(tokens.pop() + part);
            } else {
              tokens.push(prevPart + part);
            }
          } else {
            tokens.push(part);
          }
          prevPart = part;
        });
        return tokens;
      };
      wordDiff.join = function(tokens) {
        return tokens.map(function(token, i) {
          if (i == 0) {
            return token;
          } else {
            return token.replace(/^\s+/, "");
          }
        }).join("");
      };
      wordDiff.postProcess = function(changes, options) {
        if (!changes || options.oneChangePerToken) {
          return changes;
        }
        var lastKeep = null;
        var insertion = null;
        var deletion = null;
        changes.forEach(function(change) {
          if (change.added) {
            insertion = change;
          } else if (change.removed) {
            deletion = change;
          } else {
            if (insertion || deletion) {
              dedupeWhitespaceInChangeObjects(lastKeep, deletion, insertion, change);
            }
            lastKeep = change;
            insertion = null;
            deletion = null;
          }
        });
        if (insertion || deletion) {
          dedupeWhitespaceInChangeObjects(lastKeep, deletion, insertion, null);
        }
        return changes;
      };
      function diffWords(oldStr, newStr, options) {
        if (
          /*istanbul ignore start*/
          /*istanbul ignore end*/
          (options === null || options === void 0 ? void 0 : options.ignoreWhitespace) != null && !options.ignoreWhitespace
        ) {
          return diffWordsWithSpace(oldStr, newStr, options);
        }
        return wordDiff.diff(oldStr, newStr, options);
      }
      function dedupeWhitespaceInChangeObjects(startKeep, deletion, insertion, endKeep) {
        if (deletion && insertion) {
          var oldWsPrefix = deletion.value.match(/^\s*/)[0];
          var oldWsSuffix = deletion.value.match(/\s*$/)[0];
          var newWsPrefix = insertion.value.match(/^\s*/)[0];
          var newWsSuffix = insertion.value.match(/\s*$/)[0];
          if (startKeep) {
            var commonWsPrefix = (
              /*istanbul ignore start*/
              (0, /*istanbul ignore end*/
              /*istanbul ignore start*/
              _string.longestCommonPrefix)(oldWsPrefix, newWsPrefix)
            );
            startKeep.value = /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _string.replaceSuffix)(startKeep.value, newWsPrefix, commonWsPrefix);
            deletion.value = /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _string.removePrefix)(deletion.value, commonWsPrefix);
            insertion.value = /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _string.removePrefix)(insertion.value, commonWsPrefix);
          }
          if (endKeep) {
            var commonWsSuffix = (
              /*istanbul ignore start*/
              (0, /*istanbul ignore end*/
              /*istanbul ignore start*/
              _string.longestCommonSuffix)(oldWsSuffix, newWsSuffix)
            );
            endKeep.value = /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _string.replacePrefix)(endKeep.value, newWsSuffix, commonWsSuffix);
            deletion.value = /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _string.removeSuffix)(deletion.value, commonWsSuffix);
            insertion.value = /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _string.removeSuffix)(insertion.value, commonWsSuffix);
          }
        } else if (insertion) {
          if (startKeep) {
            insertion.value = insertion.value.replace(/^\s*/, "");
          }
          if (endKeep) {
            endKeep.value = endKeep.value.replace(/^\s*/, "");
          }
        } else if (startKeep && endKeep) {
          var newWsFull = endKeep.value.match(/^\s*/)[0], delWsStart = deletion.value.match(/^\s*/)[0], delWsEnd = deletion.value.match(/\s*$/)[0];
          var newWsStart = (
            /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _string.longestCommonPrefix)(newWsFull, delWsStart)
          );
          deletion.value = /*istanbul ignore start*/
          (0, /*istanbul ignore end*/
          /*istanbul ignore start*/
          _string.removePrefix)(deletion.value, newWsStart);
          var newWsEnd = (
            /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _string.longestCommonSuffix)(
              /*istanbul ignore start*/
              (0, /*istanbul ignore end*/
              /*istanbul ignore start*/
              _string.removePrefix)(newWsFull, newWsStart),
              delWsEnd
            )
          );
          deletion.value = /*istanbul ignore start*/
          (0, /*istanbul ignore end*/
          /*istanbul ignore start*/
          _string.removeSuffix)(deletion.value, newWsEnd);
          endKeep.value = /*istanbul ignore start*/
          (0, /*istanbul ignore end*/
          /*istanbul ignore start*/
          _string.replacePrefix)(endKeep.value, newWsFull, newWsEnd);
          startKeep.value = /*istanbul ignore start*/
          (0, /*istanbul ignore end*/
          /*istanbul ignore start*/
          _string.replaceSuffix)(startKeep.value, newWsFull, newWsFull.slice(0, newWsFull.length - newWsEnd.length));
        } else if (endKeep) {
          var endKeepWsPrefix = endKeep.value.match(/^\s*/)[0];
          var deletionWsSuffix = deletion.value.match(/\s*$/)[0];
          var overlap = (
            /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _string.maximumOverlap)(deletionWsSuffix, endKeepWsPrefix)
          );
          deletion.value = /*istanbul ignore start*/
          (0, /*istanbul ignore end*/
          /*istanbul ignore start*/
          _string.removeSuffix)(deletion.value, overlap);
        } else if (startKeep) {
          var startKeepWsSuffix = startKeep.value.match(/\s*$/)[0];
          var deletionWsPrefix = deletion.value.match(/^\s*/)[0];
          var _overlap = (
            /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _string.maximumOverlap)(startKeepWsSuffix, deletionWsPrefix)
          );
          deletion.value = /*istanbul ignore start*/
          (0, /*istanbul ignore end*/
          /*istanbul ignore start*/
          _string.removePrefix)(deletion.value, _overlap);
        }
      }
      var wordWithSpaceDiff = (
        /*istanbul ignore start*/
        exports.wordWithSpaceDiff = /*istanbul ignore end*/
        new /*istanbul ignore start*/
        _base[
          /*istanbul ignore start*/
          "default"
          /*istanbul ignore end*/
        ]()
      );
      wordWithSpaceDiff.tokenize = function(value) {
        var regex = new RegExp(
          /*istanbul ignore start*/
          "(\\r?\\n)|[".concat(
            /*istanbul ignore end*/
            extendedWordChars,
            "]+|[^\\S\\n\\r]+|[^"
          ).concat(extendedWordChars, "]"),
          "ug"
        );
        return value.match(regex) || [];
      };
      function diffWordsWithSpace(oldStr, newStr, options) {
        return wordWithSpaceDiff.diff(oldStr, newStr, options);
      }
    }
  });

  // node_modules/diff/lib/util/params.js
  var require_params = __commonJS({
    "node_modules/diff/lib/util/params.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.generateOptions = generateOptions;
      function generateOptions(options, defaults) {
        if (typeof options === "function") {
          defaults.callback = options;
        } else if (options) {
          for (var name in options) {
            if (options.hasOwnProperty(name)) {
              defaults[name] = options[name];
            }
          }
        }
        return defaults;
      }
    }
  });

  // node_modules/diff/lib/diff/line.js
  var require_line = __commonJS({
    "node_modules/diff/lib/diff/line.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.diffLines = diffLines;
      exports.diffTrimmedLines = diffTrimmedLines;
      exports.lineDiff = void 0;
      var _base = _interopRequireDefault(require_base());
      var _params = require_params();
      function _interopRequireDefault(obj) {
        return obj && obj.__esModule ? obj : { "default": obj };
      }
      var lineDiff = (
        /*istanbul ignore start*/
        exports.lineDiff = /*istanbul ignore end*/
        new /*istanbul ignore start*/
        _base[
          /*istanbul ignore start*/
          "default"
          /*istanbul ignore end*/
        ]()
      );
      lineDiff.tokenize = function(value, options) {
        if (options.stripTrailingCr) {
          value = value.replace(/\r\n/g, "\n");
        }
        var retLines = [], linesAndNewlines = value.split(/(\n|\r\n)/);
        if (!linesAndNewlines[linesAndNewlines.length - 1]) {
          linesAndNewlines.pop();
        }
        for (var i = 0; i < linesAndNewlines.length; i++) {
          var line = linesAndNewlines[i];
          if (i % 2 && !options.newlineIsToken) {
            retLines[retLines.length - 1] += line;
          } else {
            retLines.push(line);
          }
        }
        return retLines;
      };
      lineDiff.equals = function(left, right, options) {
        if (options.ignoreWhitespace) {
          if (!options.newlineIsToken || !left.includes("\n")) {
            left = left.trim();
          }
          if (!options.newlineIsToken || !right.includes("\n")) {
            right = right.trim();
          }
        } else if (options.ignoreNewlineAtEof && !options.newlineIsToken) {
          if (left.endsWith("\n")) {
            left = left.slice(0, -1);
          }
          if (right.endsWith("\n")) {
            right = right.slice(0, -1);
          }
        }
        return (
          /*istanbul ignore start*/
          _base[
            /*istanbul ignore start*/
            "default"
            /*istanbul ignore end*/
          ].prototype.equals.call(this, left, right, options)
        );
      };
      function diffLines(oldStr, newStr, callback) {
        return lineDiff.diff(oldStr, newStr, callback);
      }
      function diffTrimmedLines(oldStr, newStr, callback) {
        var options = (
          /*istanbul ignore start*/
          (0, /*istanbul ignore end*/
          /*istanbul ignore start*/
          _params.generateOptions)(callback, {
            ignoreWhitespace: true
          })
        );
        return lineDiff.diff(oldStr, newStr, options);
      }
    }
  });

  // node_modules/diff/lib/diff/sentence.js
  var require_sentence = __commonJS({
    "node_modules/diff/lib/diff/sentence.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.diffSentences = diffSentences;
      exports.sentenceDiff = void 0;
      var _base = _interopRequireDefault(require_base());
      function _interopRequireDefault(obj) {
        return obj && obj.__esModule ? obj : { "default": obj };
      }
      var sentenceDiff = (
        /*istanbul ignore start*/
        exports.sentenceDiff = /*istanbul ignore end*/
        new /*istanbul ignore start*/
        _base[
          /*istanbul ignore start*/
          "default"
          /*istanbul ignore end*/
        ]()
      );
      sentenceDiff.tokenize = function(value) {
        return value.split(/(\S.+?[.!?])(?=\s+|$)/);
      };
      function diffSentences(oldStr, newStr, callback) {
        return sentenceDiff.diff(oldStr, newStr, callback);
      }
    }
  });

  // node_modules/diff/lib/diff/css.js
  var require_css = __commonJS({
    "node_modules/diff/lib/diff/css.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.cssDiff = void 0;
      exports.diffCss = diffCss;
      var _base = _interopRequireDefault(require_base());
      function _interopRequireDefault(obj) {
        return obj && obj.__esModule ? obj : { "default": obj };
      }
      var cssDiff = (
        /*istanbul ignore start*/
        exports.cssDiff = /*istanbul ignore end*/
        new /*istanbul ignore start*/
        _base[
          /*istanbul ignore start*/
          "default"
          /*istanbul ignore end*/
        ]()
      );
      cssDiff.tokenize = function(value) {
        return value.split(/([{}:;,]|\s+)/);
      };
      function diffCss(oldStr, newStr, callback) {
        return cssDiff.diff(oldStr, newStr, callback);
      }
    }
  });

  // node_modules/diff/lib/diff/json.js
  var require_json = __commonJS({
    "node_modules/diff/lib/diff/json.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.canonicalize = canonicalize;
      exports.diffJson = diffJson;
      exports.jsonDiff = void 0;
      var _base = _interopRequireDefault(require_base());
      var _line = require_line();
      function _interopRequireDefault(obj) {
        return obj && obj.__esModule ? obj : { "default": obj };
      }
      function _typeof(o) {
        "@babel/helpers - typeof";
        return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
          return typeof o2;
        } : function(o2) {
          return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
        }, _typeof(o);
      }
      var jsonDiff = (
        /*istanbul ignore start*/
        exports.jsonDiff = /*istanbul ignore end*/
        new /*istanbul ignore start*/
        _base[
          /*istanbul ignore start*/
          "default"
          /*istanbul ignore end*/
        ]()
      );
      jsonDiff.useLongestToken = true;
      jsonDiff.tokenize = /*istanbul ignore start*/
      _line.lineDiff.tokenize;
      jsonDiff.castInput = function(value, options) {
        var undefinedReplacement = options.undefinedReplacement, _options$stringifyRep = (
          /*istanbul ignore end*/
          options.stringifyReplacer
        ), stringifyReplacer = _options$stringifyRep === void 0 ? function(k, v) {
          return (
            /*istanbul ignore end*/
            typeof v === "undefined" ? undefinedReplacement : v
          );
        } : _options$stringifyRep;
        return typeof value === "string" ? value : JSON.stringify(canonicalize(value, null, null, stringifyReplacer), stringifyReplacer, "  ");
      };
      jsonDiff.equals = function(left, right, options) {
        return (
          /*istanbul ignore start*/
          _base[
            /*istanbul ignore start*/
            "default"
            /*istanbul ignore end*/
          ].prototype.equals.call(jsonDiff, left.replace(/,([\r\n])/g, "$1"), right.replace(/,([\r\n])/g, "$1"), options)
        );
      };
      function diffJson(oldObj, newObj, options) {
        return jsonDiff.diff(oldObj, newObj, options);
      }
      function canonicalize(obj, stack, replacementStack, replacer, key) {
        stack = stack || [];
        replacementStack = replacementStack || [];
        if (replacer) {
          obj = replacer(key, obj);
        }
        var i;
        for (i = 0; i < stack.length; i += 1) {
          if (stack[i] === obj) {
            return replacementStack[i];
          }
        }
        var canonicalizedObj;
        if ("[object Array]" === Object.prototype.toString.call(obj)) {
          stack.push(obj);
          canonicalizedObj = new Array(obj.length);
          replacementStack.push(canonicalizedObj);
          for (i = 0; i < obj.length; i += 1) {
            canonicalizedObj[i] = canonicalize(obj[i], stack, replacementStack, replacer, key);
          }
          stack.pop();
          replacementStack.pop();
          return canonicalizedObj;
        }
        if (obj && obj.toJSON) {
          obj = obj.toJSON();
        }
        if (
          /*istanbul ignore start*/
          _typeof(
            /*istanbul ignore end*/
            obj
          ) === "object" && obj !== null
        ) {
          stack.push(obj);
          canonicalizedObj = {};
          replacementStack.push(canonicalizedObj);
          var sortedKeys = [], _key;
          for (_key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, _key)) {
              sortedKeys.push(_key);
            }
          }
          sortedKeys.sort();
          for (i = 0; i < sortedKeys.length; i += 1) {
            _key = sortedKeys[i];
            canonicalizedObj[_key] = canonicalize(obj[_key], stack, replacementStack, replacer, _key);
          }
          stack.pop();
          replacementStack.pop();
        } else {
          canonicalizedObj = obj;
        }
        return canonicalizedObj;
      }
    }
  });

  // node_modules/diff/lib/diff/array.js
  var require_array = __commonJS({
    "node_modules/diff/lib/diff/array.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.arrayDiff = void 0;
      exports.diffArrays = diffArrays;
      var _base = _interopRequireDefault(require_base());
      function _interopRequireDefault(obj) {
        return obj && obj.__esModule ? obj : { "default": obj };
      }
      var arrayDiff = (
        /*istanbul ignore start*/
        exports.arrayDiff = /*istanbul ignore end*/
        new /*istanbul ignore start*/
        _base[
          /*istanbul ignore start*/
          "default"
          /*istanbul ignore end*/
        ]()
      );
      arrayDiff.tokenize = function(value) {
        return value.slice();
      };
      arrayDiff.join = arrayDiff.removeEmpty = function(value) {
        return value;
      };
      function diffArrays(oldArr, newArr, callback) {
        return arrayDiff.diff(oldArr, newArr, callback);
      }
    }
  });

  // node_modules/diff/lib/patch/line-endings.js
  var require_line_endings = __commonJS({
    "node_modules/diff/lib/patch/line-endings.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.isUnix = isUnix;
      exports.isWin = isWin;
      exports.unixToWin = unixToWin;
      exports.winToUnix = winToUnix;
      function _typeof(o) {
        "@babel/helpers - typeof";
        return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
          return typeof o2;
        } : function(o2) {
          return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
        }, _typeof(o);
      }
      function ownKeys(e, r) {
        var t = Object.keys(e);
        if (Object.getOwnPropertySymbols) {
          var o = Object.getOwnPropertySymbols(e);
          r && (o = o.filter(function(r2) {
            return Object.getOwnPropertyDescriptor(e, r2).enumerable;
          })), t.push.apply(t, o);
        }
        return t;
      }
      function _objectSpread(e) {
        for (var r = 1; r < arguments.length; r++) {
          var t = null != arguments[r] ? arguments[r] : {};
          r % 2 ? ownKeys(Object(t), true).forEach(function(r2) {
            _defineProperty(e, r2, t[r2]);
          }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function(r2) {
            Object.defineProperty(e, r2, Object.getOwnPropertyDescriptor(t, r2));
          });
        }
        return e;
      }
      function _defineProperty(obj, key, value) {
        key = _toPropertyKey(key);
        if (key in obj) {
          Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
        } else {
          obj[key] = value;
        }
        return obj;
      }
      function _toPropertyKey(t) {
        var i = _toPrimitive(t, "string");
        return "symbol" == _typeof(i) ? i : i + "";
      }
      function _toPrimitive(t, r) {
        if ("object" != _typeof(t) || !t) return t;
        var e = t[Symbol.toPrimitive];
        if (void 0 !== e) {
          var i = e.call(t, r || "default");
          if ("object" != _typeof(i)) return i;
          throw new TypeError("@@toPrimitive must return a primitive value.");
        }
        return ("string" === r ? String : Number)(t);
      }
      function unixToWin(patch) {
        if (Array.isArray(patch)) {
          return patch.map(unixToWin);
        }
        return (
          /*istanbul ignore start*/
          _objectSpread(_objectSpread(
            {},
            /*istanbul ignore end*/
            patch
          ), {}, {
            hunks: patch.hunks.map(function(hunk) {
              return _objectSpread(_objectSpread(
                {},
                /*istanbul ignore end*/
                hunk
              ), {}, {
                lines: hunk.lines.map(function(line, i) {
                  var _hunk$lines;
                  return (
                    /*istanbul ignore end*/
                    line.startsWith("\\") || line.endsWith("\r") || /*istanbul ignore start*/
                    (_hunk$lines = /*istanbul ignore end*/
                    hunk.lines[i + 1]) !== null && _hunk$lines !== void 0 && /*istanbul ignore start*/
                    _hunk$lines.startsWith("\\") ? line : line + "\r"
                  );
                })
              });
            })
          })
        );
      }
      function winToUnix(patch) {
        if (Array.isArray(patch)) {
          return patch.map(winToUnix);
        }
        return (
          /*istanbul ignore start*/
          _objectSpread(_objectSpread(
            {},
            /*istanbul ignore end*/
            patch
          ), {}, {
            hunks: patch.hunks.map(function(hunk) {
              return _objectSpread(_objectSpread(
                {},
                /*istanbul ignore end*/
                hunk
              ), {}, {
                lines: hunk.lines.map(function(line) {
                  return (
                    /*istanbul ignore end*/
                    line.endsWith("\r") ? line.substring(0, line.length - 1) : line
                  );
                })
              });
            })
          })
        );
      }
      function isUnix(patch) {
        if (!Array.isArray(patch)) {
          patch = [patch];
        }
        return !patch.some(function(index) {
          return (
            /*istanbul ignore end*/
            index.hunks.some(function(hunk) {
              return (
                /*istanbul ignore end*/
                hunk.lines.some(function(line) {
                  return (
                    /*istanbul ignore end*/
                    !line.startsWith("\\") && line.endsWith("\r")
                  );
                })
              );
            })
          );
        });
      }
      function isWin(patch) {
        if (!Array.isArray(patch)) {
          patch = [patch];
        }
        return patch.some(function(index) {
          return (
            /*istanbul ignore end*/
            index.hunks.some(function(hunk) {
              return (
                /*istanbul ignore end*/
                hunk.lines.some(function(line) {
                  return (
                    /*istanbul ignore end*/
                    line.endsWith("\r")
                  );
                })
              );
            })
          );
        }) && patch.every(function(index) {
          return (
            /*istanbul ignore end*/
            index.hunks.every(function(hunk) {
              return (
                /*istanbul ignore end*/
                hunk.lines.every(function(line, i) {
                  var _hunk$lines2;
                  return (
                    /*istanbul ignore end*/
                    line.startsWith("\\") || line.endsWith("\r") || /*istanbul ignore start*/
                    ((_hunk$lines2 = /*istanbul ignore end*/
                    hunk.lines[i + 1]) === null || _hunk$lines2 === void 0 ? void 0 : (
                      /*istanbul ignore start*/
                      _hunk$lines2.startsWith("\\")
                    ))
                  );
                })
              );
            })
          );
        });
      }
    }
  });

  // node_modules/diff/lib/patch/parse.js
  var require_parse = __commonJS({
    "node_modules/diff/lib/patch/parse.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.parsePatch = parsePatch;
      function parsePatch(uniDiff) {
        var diffstr = uniDiff.split(/\n/), list = [], i = 0;
        function parseIndex() {
          var index = {};
          list.push(index);
          while (i < diffstr.length) {
            var line = diffstr[i];
            if (/^(\-\-\-|\+\+\+|@@)\s/.test(line)) {
              break;
            }
            var header = /^(?:Index:|diff(?: -r \w+)+)\s+(.+?)\s*$/.exec(line);
            if (header) {
              index.index = header[1];
            }
            i++;
          }
          parseFileHeader(index);
          parseFileHeader(index);
          index.hunks = [];
          while (i < diffstr.length) {
            var _line = diffstr[i];
            if (/^(Index:\s|diff\s|\-\-\-\s|\+\+\+\s|===================================================================)/.test(_line)) {
              break;
            } else if (/^@@/.test(_line)) {
              index.hunks.push(parseHunk());
            } else if (_line) {
              throw new Error("Unknown line " + (i + 1) + " " + JSON.stringify(_line));
            } else {
              i++;
            }
          }
        }
        function parseFileHeader(index) {
          var fileHeader = /^(---|\+\+\+)\s+(.*)\r?$/.exec(diffstr[i]);
          if (fileHeader) {
            var keyPrefix = fileHeader[1] === "---" ? "old" : "new";
            var data = fileHeader[2].split("	", 2);
            var fileName = data[0].replace(/\\\\/g, "\\");
            if (/^".*"$/.test(fileName)) {
              fileName = fileName.substr(1, fileName.length - 2);
            }
            index[keyPrefix + "FileName"] = fileName;
            index[keyPrefix + "Header"] = (data[1] || "").trim();
            i++;
          }
        }
        function parseHunk() {
          var chunkHeaderIndex = i, chunkHeaderLine = diffstr[i++], chunkHeader = chunkHeaderLine.split(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
          var hunk = {
            oldStart: +chunkHeader[1],
            oldLines: typeof chunkHeader[2] === "undefined" ? 1 : +chunkHeader[2],
            newStart: +chunkHeader[3],
            newLines: typeof chunkHeader[4] === "undefined" ? 1 : +chunkHeader[4],
            lines: []
          };
          if (hunk.oldLines === 0) {
            hunk.oldStart += 1;
          }
          if (hunk.newLines === 0) {
            hunk.newStart += 1;
          }
          var addCount = 0, removeCount = 0;
          for (; i < diffstr.length && (removeCount < hunk.oldLines || addCount < hunk.newLines || /*istanbul ignore start*/
          (_diffstr$i = /*istanbul ignore end*/
          diffstr[i]) !== null && _diffstr$i !== void 0 && /*istanbul ignore start*/
          _diffstr$i.startsWith("\\")); i++) {
            var _diffstr$i;
            var operation = diffstr[i].length == 0 && i != diffstr.length - 1 ? " " : diffstr[i][0];
            if (operation === "+" || operation === "-" || operation === " " || operation === "\\") {
              hunk.lines.push(diffstr[i]);
              if (operation === "+") {
                addCount++;
              } else if (operation === "-") {
                removeCount++;
              } else if (operation === " ") {
                addCount++;
                removeCount++;
              }
            } else {
              throw new Error(
                /*istanbul ignore start*/
                "Hunk at line ".concat(
                  /*istanbul ignore end*/
                  chunkHeaderIndex + 1,
                  " contained invalid line "
                ).concat(diffstr[i])
              );
            }
          }
          if (!addCount && hunk.newLines === 1) {
            hunk.newLines = 0;
          }
          if (!removeCount && hunk.oldLines === 1) {
            hunk.oldLines = 0;
          }
          if (addCount !== hunk.newLines) {
            throw new Error("Added line count did not match for hunk at line " + (chunkHeaderIndex + 1));
          }
          if (removeCount !== hunk.oldLines) {
            throw new Error("Removed line count did not match for hunk at line " + (chunkHeaderIndex + 1));
          }
          return hunk;
        }
        while (i < diffstr.length) {
          parseIndex();
        }
        return list;
      }
    }
  });

  // node_modules/diff/lib/util/distance-iterator.js
  var require_distance_iterator = __commonJS({
    "node_modules/diff/lib/util/distance-iterator.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports["default"] = _default;
      function _default(start, minLine, maxLine) {
        var wantForward = true, backwardExhausted = false, forwardExhausted = false, localOffset = 1;
        return function iterator() {
          if (wantForward && !forwardExhausted) {
            if (backwardExhausted) {
              localOffset++;
            } else {
              wantForward = false;
            }
            if (start + localOffset <= maxLine) {
              return start + localOffset;
            }
            forwardExhausted = true;
          }
          if (!backwardExhausted) {
            if (!forwardExhausted) {
              wantForward = true;
            }
            if (minLine <= start - localOffset) {
              return start - localOffset++;
            }
            backwardExhausted = true;
            return iterator();
          }
        };
      }
    }
  });

  // node_modules/diff/lib/patch/apply.js
  var require_apply = __commonJS({
    "node_modules/diff/lib/patch/apply.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.applyPatch = applyPatch;
      exports.applyPatches = applyPatches;
      var _string = require_string();
      var _lineEndings = require_line_endings();
      var _parse = require_parse();
      var _distanceIterator = _interopRequireDefault(require_distance_iterator());
      function _interopRequireDefault(obj) {
        return obj && obj.__esModule ? obj : { "default": obj };
      }
      function applyPatch(source, uniDiff) {
        var options = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {};
        if (typeof uniDiff === "string") {
          uniDiff = /*istanbul ignore start*/
          (0, /*istanbul ignore end*/
          /*istanbul ignore start*/
          _parse.parsePatch)(uniDiff);
        }
        if (Array.isArray(uniDiff)) {
          if (uniDiff.length > 1) {
            throw new Error("applyPatch only works with a single input.");
          }
          uniDiff = uniDiff[0];
        }
        if (options.autoConvertLineEndings || options.autoConvertLineEndings == null) {
          if (
            /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _string.hasOnlyWinLineEndings)(source) && /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _lineEndings.isUnix)(uniDiff)
          ) {
            uniDiff = /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _lineEndings.unixToWin)(uniDiff);
          } else if (
            /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _string.hasOnlyUnixLineEndings)(source) && /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _lineEndings.isWin)(uniDiff)
          ) {
            uniDiff = /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _lineEndings.winToUnix)(uniDiff);
          }
        }
        var lines = source.split("\n"), hunks = uniDiff.hunks, compareLine = options.compareLine || function(lineNumber, line2, operation, patchContent) {
          return (
            /*istanbul ignore end*/
            line2 === patchContent
          );
        }, fuzzFactor = options.fuzzFactor || 0, minLine = 0;
        if (fuzzFactor < 0 || !Number.isInteger(fuzzFactor)) {
          throw new Error("fuzzFactor must be a non-negative integer");
        }
        if (!hunks.length) {
          return source;
        }
        var prevLine = "", removeEOFNL = false, addEOFNL = false;
        for (var i = 0; i < hunks[hunks.length - 1].lines.length; i++) {
          var line = hunks[hunks.length - 1].lines[i];
          if (line[0] == "\\") {
            if (prevLine[0] == "+") {
              removeEOFNL = true;
            } else if (prevLine[0] == "-") {
              addEOFNL = true;
            }
          }
          prevLine = line;
        }
        if (removeEOFNL) {
          if (addEOFNL) {
            if (!fuzzFactor && lines[lines.length - 1] == "") {
              return false;
            }
          } else if (lines[lines.length - 1] == "") {
            lines.pop();
          } else if (!fuzzFactor) {
            return false;
          }
        } else if (addEOFNL) {
          if (lines[lines.length - 1] != "") {
            lines.push("");
          } else if (!fuzzFactor) {
            return false;
          }
        }
        function applyHunk(hunkLines, toPos2, maxErrors2) {
          var hunkLinesI = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : 0;
          var lastContextLineMatched = arguments.length > 4 && arguments[4] !== void 0 ? arguments[4] : true;
          var patchedLines = arguments.length > 5 && arguments[5] !== void 0 ? arguments[5] : [];
          var patchedLinesLength = arguments.length > 6 && arguments[6] !== void 0 ? arguments[6] : 0;
          var nConsecutiveOldContextLines = 0;
          var nextContextLineMustMatch = false;
          for (; hunkLinesI < hunkLines.length; hunkLinesI++) {
            var hunkLine = hunkLines[hunkLinesI], operation = hunkLine.length > 0 ? hunkLine[0] : " ", content = hunkLine.length > 0 ? hunkLine.substr(1) : hunkLine;
            if (operation === "-") {
              if (compareLine(toPos2 + 1, lines[toPos2], operation, content)) {
                toPos2++;
                nConsecutiveOldContextLines = 0;
              } else {
                if (!maxErrors2 || lines[toPos2] == null) {
                  return null;
                }
                patchedLines[patchedLinesLength] = lines[toPos2];
                return applyHunk(hunkLines, toPos2 + 1, maxErrors2 - 1, hunkLinesI, false, patchedLines, patchedLinesLength + 1);
              }
            }
            if (operation === "+") {
              if (!lastContextLineMatched) {
                return null;
              }
              patchedLines[patchedLinesLength] = content;
              patchedLinesLength++;
              nConsecutiveOldContextLines = 0;
              nextContextLineMustMatch = true;
            }
            if (operation === " ") {
              nConsecutiveOldContextLines++;
              patchedLines[patchedLinesLength] = lines[toPos2];
              if (compareLine(toPos2 + 1, lines[toPos2], operation, content)) {
                patchedLinesLength++;
                lastContextLineMatched = true;
                nextContextLineMustMatch = false;
                toPos2++;
              } else {
                if (nextContextLineMustMatch || !maxErrors2) {
                  return null;
                }
                return lines[toPos2] && (applyHunk(hunkLines, toPos2 + 1, maxErrors2 - 1, hunkLinesI + 1, false, patchedLines, patchedLinesLength + 1) || applyHunk(hunkLines, toPos2 + 1, maxErrors2 - 1, hunkLinesI, false, patchedLines, patchedLinesLength + 1)) || applyHunk(hunkLines, toPos2, maxErrors2 - 1, hunkLinesI + 1, false, patchedLines, patchedLinesLength);
              }
            }
          }
          patchedLinesLength -= nConsecutiveOldContextLines;
          toPos2 -= nConsecutiveOldContextLines;
          patchedLines.length = patchedLinesLength;
          return {
            patchedLines,
            oldLineLastI: toPos2 - 1
          };
        }
        var resultLines = [];
        var prevHunkOffset = 0;
        for (var _i = 0; _i < hunks.length; _i++) {
          var hunk = hunks[_i];
          var hunkResult = (
            /*istanbul ignore start*/
            void 0
          );
          var maxLine = lines.length - hunk.oldLines + fuzzFactor;
          var toPos = (
            /*istanbul ignore start*/
            void 0
          );
          for (var maxErrors = 0; maxErrors <= fuzzFactor; maxErrors++) {
            toPos = hunk.oldStart + prevHunkOffset - 1;
            var iterator = (
              /*istanbul ignore start*/
              (0, /*istanbul ignore end*/
              /*istanbul ignore start*/
              _distanceIterator[
                /*istanbul ignore start*/
                "default"
                /*istanbul ignore end*/
              ])(toPos, minLine, maxLine)
            );
            for (; toPos !== void 0; toPos = iterator()) {
              hunkResult = applyHunk(hunk.lines, toPos, maxErrors);
              if (hunkResult) {
                break;
              }
            }
            if (hunkResult) {
              break;
            }
          }
          if (!hunkResult) {
            return false;
          }
          for (var _i2 = minLine; _i2 < toPos; _i2++) {
            resultLines.push(lines[_i2]);
          }
          for (var _i3 = 0; _i3 < hunkResult.patchedLines.length; _i3++) {
            var _line = hunkResult.patchedLines[_i3];
            resultLines.push(_line);
          }
          minLine = hunkResult.oldLineLastI + 1;
          prevHunkOffset = toPos + 1 - hunk.oldStart;
        }
        for (var _i4 = minLine; _i4 < lines.length; _i4++) {
          resultLines.push(lines[_i4]);
        }
        return resultLines.join("\n");
      }
      function applyPatches(uniDiff, options) {
        if (typeof uniDiff === "string") {
          uniDiff = /*istanbul ignore start*/
          (0, /*istanbul ignore end*/
          /*istanbul ignore start*/
          _parse.parsePatch)(uniDiff);
        }
        var currentIndex = 0;
        function processIndex() {
          var index = uniDiff[currentIndex++];
          if (!index) {
            return options.complete();
          }
          options.loadFile(index, function(err, data) {
            if (err) {
              return options.complete(err);
            }
            var updatedContent = applyPatch(data, index, options);
            options.patched(index, updatedContent, function(err2) {
              if (err2) {
                return options.complete(err2);
              }
              processIndex();
            });
          });
        }
        processIndex();
      }
    }
  });

  // node_modules/diff/lib/patch/create.js
  var require_create = __commonJS({
    "node_modules/diff/lib/patch/create.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.createPatch = createPatch;
      exports.createTwoFilesPatch = createTwoFilesPatch;
      exports.formatPatch = formatPatch;
      exports.structuredPatch = structuredPatch;
      var _line = require_line();
      function _typeof(o) {
        "@babel/helpers - typeof";
        return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
          return typeof o2;
        } : function(o2) {
          return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
        }, _typeof(o);
      }
      function _toConsumableArray(arr) {
        return _arrayWithoutHoles(arr) || _iterableToArray(arr) || _unsupportedIterableToArray(arr) || _nonIterableSpread();
      }
      function _nonIterableSpread() {
        throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
      }
      function _unsupportedIterableToArray(o, minLen) {
        if (!o) return;
        if (typeof o === "string") return _arrayLikeToArray(o, minLen);
        var n = Object.prototype.toString.call(o).slice(8, -1);
        if (n === "Object" && o.constructor) n = o.constructor.name;
        if (n === "Map" || n === "Set") return Array.from(o);
        if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return _arrayLikeToArray(o, minLen);
      }
      function _iterableToArray(iter) {
        if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter);
      }
      function _arrayWithoutHoles(arr) {
        if (Array.isArray(arr)) return _arrayLikeToArray(arr);
      }
      function _arrayLikeToArray(arr, len) {
        if (len == null || len > arr.length) len = arr.length;
        for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
        return arr2;
      }
      function ownKeys(e, r) {
        var t = Object.keys(e);
        if (Object.getOwnPropertySymbols) {
          var o = Object.getOwnPropertySymbols(e);
          r && (o = o.filter(function(r2) {
            return Object.getOwnPropertyDescriptor(e, r2).enumerable;
          })), t.push.apply(t, o);
        }
        return t;
      }
      function _objectSpread(e) {
        for (var r = 1; r < arguments.length; r++) {
          var t = null != arguments[r] ? arguments[r] : {};
          r % 2 ? ownKeys(Object(t), true).forEach(function(r2) {
            _defineProperty(e, r2, t[r2]);
          }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function(r2) {
            Object.defineProperty(e, r2, Object.getOwnPropertyDescriptor(t, r2));
          });
        }
        return e;
      }
      function _defineProperty(obj, key, value) {
        key = _toPropertyKey(key);
        if (key in obj) {
          Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
        } else {
          obj[key] = value;
        }
        return obj;
      }
      function _toPropertyKey(t) {
        var i = _toPrimitive(t, "string");
        return "symbol" == _typeof(i) ? i : i + "";
      }
      function _toPrimitive(t, r) {
        if ("object" != _typeof(t) || !t) return t;
        var e = t[Symbol.toPrimitive];
        if (void 0 !== e) {
          var i = e.call(t, r || "default");
          if ("object" != _typeof(i)) return i;
          throw new TypeError("@@toPrimitive must return a primitive value.");
        }
        return ("string" === r ? String : Number)(t);
      }
      function structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
        if (!options) {
          options = {};
        }
        if (typeof options === "function") {
          options = {
            callback: options
          };
        }
        if (typeof options.context === "undefined") {
          options.context = 4;
        }
        if (options.newlineIsToken) {
          throw new Error("newlineIsToken may not be used with patch-generation functions, only with diffing functions");
        }
        if (!options.callback) {
          return diffLinesResultToPatch(
            /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _line.diffLines)(oldStr, newStr, options)
          );
        } else {
          var _options = (
            /*istanbul ignore end*/
            options
          ), _callback = _options.callback;
          (0, /*istanbul ignore end*/
          /*istanbul ignore start*/
          _line.diffLines)(
            oldStr,
            newStr,
            /*istanbul ignore start*/
            _objectSpread(_objectSpread(
              {},
              /*istanbul ignore end*/
              options
            ), {}, {
              callback: function callback(diff) {
                var patch = diffLinesResultToPatch(diff);
                _callback(patch);
              }
            })
          );
        }
        function diffLinesResultToPatch(diff) {
          if (!diff) {
            return;
          }
          diff.push({
            value: "",
            lines: []
          });
          function contextLines(lines) {
            return lines.map(function(entry) {
              return " " + entry;
            });
          }
          var hunks = [];
          var oldRangeStart = 0, newRangeStart = 0, curRange = [], oldLine = 1, newLine = 1;
          var _loop = function _loop2() {
            var current = diff[i], lines = current.lines || splitLines(current.value);
            current.lines = lines;
            if (current.added || current.removed) {
              var _curRange;
              if (!oldRangeStart) {
                var prev = diff[i - 1];
                oldRangeStart = oldLine;
                newRangeStart = newLine;
                if (prev) {
                  curRange = options.context > 0 ? contextLines(prev.lines.slice(-options.context)) : [];
                  oldRangeStart -= curRange.length;
                  newRangeStart -= curRange.length;
                }
              }
              (_curRange = /*istanbul ignore end*/
              curRange).push.apply(
                /*istanbul ignore start*/
                _curRange,
                /*istanbul ignore start*/
                _toConsumableArray(
                  /*istanbul ignore end*/
                  lines.map(function(entry) {
                    return (current.added ? "+" : "-") + entry;
                  })
                )
              );
              if (current.added) {
                newLine += lines.length;
              } else {
                oldLine += lines.length;
              }
            } else {
              if (oldRangeStart) {
                if (lines.length <= options.context * 2 && i < diff.length - 2) {
                  var _curRange2;
                  (_curRange2 = /*istanbul ignore end*/
                  curRange).push.apply(
                    /*istanbul ignore start*/
                    _curRange2,
                    /*istanbul ignore start*/
                    _toConsumableArray(
                      /*istanbul ignore end*/
                      contextLines(lines)
                    )
                  );
                } else {
                  var _curRange3;
                  var contextSize = Math.min(lines.length, options.context);
                  (_curRange3 = /*istanbul ignore end*/
                  curRange).push.apply(
                    /*istanbul ignore start*/
                    _curRange3,
                    /*istanbul ignore start*/
                    _toConsumableArray(
                      /*istanbul ignore end*/
                      contextLines(lines.slice(0, contextSize))
                    )
                  );
                  var _hunk = {
                    oldStart: oldRangeStart,
                    oldLines: oldLine - oldRangeStart + contextSize,
                    newStart: newRangeStart,
                    newLines: newLine - newRangeStart + contextSize,
                    lines: curRange
                  };
                  hunks.push(_hunk);
                  oldRangeStart = 0;
                  newRangeStart = 0;
                  curRange = [];
                }
              }
              oldLine += lines.length;
              newLine += lines.length;
            }
          };
          for (var i = 0; i < diff.length; i++) {
            _loop();
          }
          for (
            var _i = 0, _hunks = (
              /*istanbul ignore end*/
              hunks
            );
            /*istanbul ignore start*/
            _i < _hunks.length;
            /*istanbul ignore start*/
            _i++
          ) {
            var hunk = (
              /*istanbul ignore start*/
              _hunks[_i]
            );
            for (var _i2 = 0; _i2 < hunk.lines.length; _i2++) {
              if (hunk.lines[_i2].endsWith("\n")) {
                hunk.lines[_i2] = hunk.lines[_i2].slice(0, -1);
              } else {
                hunk.lines.splice(_i2 + 1, 0, "\\ No newline at end of file");
                _i2++;
              }
            }
          }
          return {
            oldFileName,
            newFileName,
            oldHeader,
            newHeader,
            hunks
          };
        }
      }
      function formatPatch(diff) {
        if (Array.isArray(diff)) {
          return diff.map(formatPatch).join("\n");
        }
        var ret = [];
        if (diff.oldFileName == diff.newFileName) {
          ret.push("Index: " + diff.oldFileName);
        }
        ret.push("===================================================================");
        ret.push("--- " + diff.oldFileName + (typeof diff.oldHeader === "undefined" ? "" : "	" + diff.oldHeader));
        ret.push("+++ " + diff.newFileName + (typeof diff.newHeader === "undefined" ? "" : "	" + diff.newHeader));
        for (var i = 0; i < diff.hunks.length; i++) {
          var hunk = diff.hunks[i];
          if (hunk.oldLines === 0) {
            hunk.oldStart -= 1;
          }
          if (hunk.newLines === 0) {
            hunk.newStart -= 1;
          }
          ret.push("@@ -" + hunk.oldStart + "," + hunk.oldLines + " +" + hunk.newStart + "," + hunk.newLines + " @@");
          ret.push.apply(ret, hunk.lines);
        }
        return ret.join("\n") + "\n";
      }
      function createTwoFilesPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
        var _options2;
        if (typeof options === "function") {
          options = {
            callback: options
          };
        }
        if (!/*istanbul ignore start*/
        ((_options2 = /*istanbul ignore end*/
        options) !== null && _options2 !== void 0 && /*istanbul ignore start*/
        _options2.callback)) {
          var patchObj = structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options);
          if (!patchObj) {
            return;
          }
          return formatPatch(patchObj);
        } else {
          var _options3 = (
            /*istanbul ignore end*/
            options
          ), _callback2 = _options3.callback;
          structuredPatch(
            oldFileName,
            newFileName,
            oldStr,
            newStr,
            oldHeader,
            newHeader,
            /*istanbul ignore start*/
            _objectSpread(_objectSpread(
              {},
              /*istanbul ignore end*/
              options
            ), {}, {
              callback: function callback(patchObj2) {
                if (!patchObj2) {
                  _callback2();
                } else {
                  _callback2(formatPatch(patchObj2));
                }
              }
            })
          );
        }
      }
      function createPatch(fileName, oldStr, newStr, oldHeader, newHeader, options) {
        return createTwoFilesPatch(fileName, fileName, oldStr, newStr, oldHeader, newHeader, options);
      }
      function splitLines(text) {
        var hasTrailingNl = text.endsWith("\n");
        var result = text.split("\n").map(function(line) {
          return (
            /*istanbul ignore end*/
            line + "\n"
          );
        });
        if (hasTrailingNl) {
          result.pop();
        } else {
          result.push(result.pop().slice(0, -1));
        }
        return result;
      }
    }
  });

  // node_modules/diff/lib/util/array.js
  var require_array2 = __commonJS({
    "node_modules/diff/lib/util/array.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.arrayEqual = arrayEqual;
      exports.arrayStartsWith = arrayStartsWith;
      function arrayEqual(a, b) {
        if (a.length !== b.length) {
          return false;
        }
        return arrayStartsWith(a, b);
      }
      function arrayStartsWith(array, start) {
        if (start.length > array.length) {
          return false;
        }
        for (var i = 0; i < start.length; i++) {
          if (start[i] !== array[i]) {
            return false;
          }
        }
        return true;
      }
    }
  });

  // node_modules/diff/lib/patch/merge.js
  var require_merge = __commonJS({
    "node_modules/diff/lib/patch/merge.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.calcLineCount = calcLineCount;
      exports.merge = merge;
      var _create = require_create();
      var _parse = require_parse();
      var _array = require_array2();
      function _toConsumableArray(arr) {
        return _arrayWithoutHoles(arr) || _iterableToArray(arr) || _unsupportedIterableToArray(arr) || _nonIterableSpread();
      }
      function _nonIterableSpread() {
        throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
      }
      function _unsupportedIterableToArray(o, minLen) {
        if (!o) return;
        if (typeof o === "string") return _arrayLikeToArray(o, minLen);
        var n = Object.prototype.toString.call(o).slice(8, -1);
        if (n === "Object" && o.constructor) n = o.constructor.name;
        if (n === "Map" || n === "Set") return Array.from(o);
        if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return _arrayLikeToArray(o, minLen);
      }
      function _iterableToArray(iter) {
        if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) return Array.from(iter);
      }
      function _arrayWithoutHoles(arr) {
        if (Array.isArray(arr)) return _arrayLikeToArray(arr);
      }
      function _arrayLikeToArray(arr, len) {
        if (len == null || len > arr.length) len = arr.length;
        for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
        return arr2;
      }
      function calcLineCount(hunk) {
        var _calcOldNewLineCount = (
          /*istanbul ignore end*/
          calcOldNewLineCount(hunk.lines)
        ), oldLines = _calcOldNewLineCount.oldLines, newLines = _calcOldNewLineCount.newLines;
        if (oldLines !== void 0) {
          hunk.oldLines = oldLines;
        } else {
          delete hunk.oldLines;
        }
        if (newLines !== void 0) {
          hunk.newLines = newLines;
        } else {
          delete hunk.newLines;
        }
      }
      function merge(mine, theirs, base) {
        mine = loadPatch(mine, base);
        theirs = loadPatch(theirs, base);
        var ret = {};
        if (mine.index || theirs.index) {
          ret.index = mine.index || theirs.index;
        }
        if (mine.newFileName || theirs.newFileName) {
          if (!fileNameChanged(mine)) {
            ret.oldFileName = theirs.oldFileName || mine.oldFileName;
            ret.newFileName = theirs.newFileName || mine.newFileName;
            ret.oldHeader = theirs.oldHeader || mine.oldHeader;
            ret.newHeader = theirs.newHeader || mine.newHeader;
          } else if (!fileNameChanged(theirs)) {
            ret.oldFileName = mine.oldFileName;
            ret.newFileName = mine.newFileName;
            ret.oldHeader = mine.oldHeader;
            ret.newHeader = mine.newHeader;
          } else {
            ret.oldFileName = selectField(ret, mine.oldFileName, theirs.oldFileName);
            ret.newFileName = selectField(ret, mine.newFileName, theirs.newFileName);
            ret.oldHeader = selectField(ret, mine.oldHeader, theirs.oldHeader);
            ret.newHeader = selectField(ret, mine.newHeader, theirs.newHeader);
          }
        }
        ret.hunks = [];
        var mineIndex = 0, theirsIndex = 0, mineOffset = 0, theirsOffset = 0;
        while (mineIndex < mine.hunks.length || theirsIndex < theirs.hunks.length) {
          var mineCurrent = mine.hunks[mineIndex] || {
            oldStart: Infinity
          }, theirsCurrent = theirs.hunks[theirsIndex] || {
            oldStart: Infinity
          };
          if (hunkBefore(mineCurrent, theirsCurrent)) {
            ret.hunks.push(cloneHunk(mineCurrent, mineOffset));
            mineIndex++;
            theirsOffset += mineCurrent.newLines - mineCurrent.oldLines;
          } else if (hunkBefore(theirsCurrent, mineCurrent)) {
            ret.hunks.push(cloneHunk(theirsCurrent, theirsOffset));
            theirsIndex++;
            mineOffset += theirsCurrent.newLines - theirsCurrent.oldLines;
          } else {
            var mergedHunk = {
              oldStart: Math.min(mineCurrent.oldStart, theirsCurrent.oldStart),
              oldLines: 0,
              newStart: Math.min(mineCurrent.newStart + mineOffset, theirsCurrent.oldStart + theirsOffset),
              newLines: 0,
              lines: []
            };
            mergeLines(mergedHunk, mineCurrent.oldStart, mineCurrent.lines, theirsCurrent.oldStart, theirsCurrent.lines);
            theirsIndex++;
            mineIndex++;
            ret.hunks.push(mergedHunk);
          }
        }
        return ret;
      }
      function loadPatch(param, base) {
        if (typeof param === "string") {
          if (/^@@/m.test(param) || /^Index:/m.test(param)) {
            return (
              /*istanbul ignore start*/
              (0, /*istanbul ignore end*/
              /*istanbul ignore start*/
              _parse.parsePatch)(param)[0]
            );
          }
          if (!base) {
            throw new Error("Must provide a base reference or pass in a patch");
          }
          return (
            /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _create.structuredPatch)(void 0, void 0, base, param)
          );
        }
        return param;
      }
      function fileNameChanged(patch) {
        return patch.newFileName && patch.newFileName !== patch.oldFileName;
      }
      function selectField(index, mine, theirs) {
        if (mine === theirs) {
          return mine;
        } else {
          index.conflict = true;
          return {
            mine,
            theirs
          };
        }
      }
      function hunkBefore(test, check) {
        return test.oldStart < check.oldStart && test.oldStart + test.oldLines < check.oldStart;
      }
      function cloneHunk(hunk, offset) {
        return {
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart + offset,
          newLines: hunk.newLines,
          lines: hunk.lines
        };
      }
      function mergeLines(hunk, mineOffset, mineLines, theirOffset, theirLines) {
        var mine = {
          offset: mineOffset,
          lines: mineLines,
          index: 0
        }, their = {
          offset: theirOffset,
          lines: theirLines,
          index: 0
        };
        insertLeading(hunk, mine, their);
        insertLeading(hunk, their, mine);
        while (mine.index < mine.lines.length && their.index < their.lines.length) {
          var mineCurrent = mine.lines[mine.index], theirCurrent = their.lines[their.index];
          if ((mineCurrent[0] === "-" || mineCurrent[0] === "+") && (theirCurrent[0] === "-" || theirCurrent[0] === "+")) {
            mutualChange(hunk, mine, their);
          } else if (mineCurrent[0] === "+" && theirCurrent[0] === " ") {
            var _hunk$lines;
            (_hunk$lines = /*istanbul ignore end*/
            hunk.lines).push.apply(
              /*istanbul ignore start*/
              _hunk$lines,
              /*istanbul ignore start*/
              _toConsumableArray(
                /*istanbul ignore end*/
                collectChange(mine)
              )
            );
          } else if (theirCurrent[0] === "+" && mineCurrent[0] === " ") {
            var _hunk$lines2;
            (_hunk$lines2 = /*istanbul ignore end*/
            hunk.lines).push.apply(
              /*istanbul ignore start*/
              _hunk$lines2,
              /*istanbul ignore start*/
              _toConsumableArray(
                /*istanbul ignore end*/
                collectChange(their)
              )
            );
          } else if (mineCurrent[0] === "-" && theirCurrent[0] === " ") {
            removal(hunk, mine, their);
          } else if (theirCurrent[0] === "-" && mineCurrent[0] === " ") {
            removal(hunk, their, mine, true);
          } else if (mineCurrent === theirCurrent) {
            hunk.lines.push(mineCurrent);
            mine.index++;
            their.index++;
          } else {
            conflict(hunk, collectChange(mine), collectChange(their));
          }
        }
        insertTrailing(hunk, mine);
        insertTrailing(hunk, their);
        calcLineCount(hunk);
      }
      function mutualChange(hunk, mine, their) {
        var myChanges = collectChange(mine), theirChanges = collectChange(their);
        if (allRemoves(myChanges) && allRemoves(theirChanges)) {
          if (
            /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _array.arrayStartsWith)(myChanges, theirChanges) && skipRemoveSuperset(their, myChanges, myChanges.length - theirChanges.length)
          ) {
            var _hunk$lines3;
            (_hunk$lines3 = /*istanbul ignore end*/
            hunk.lines).push.apply(
              /*istanbul ignore start*/
              _hunk$lines3,
              /*istanbul ignore start*/
              _toConsumableArray(
                /*istanbul ignore end*/
                myChanges
              )
            );
            return;
          } else if (
            /*istanbul ignore start*/
            (0, /*istanbul ignore end*/
            /*istanbul ignore start*/
            _array.arrayStartsWith)(theirChanges, myChanges) && skipRemoveSuperset(mine, theirChanges, theirChanges.length - myChanges.length)
          ) {
            var _hunk$lines4;
            (_hunk$lines4 = /*istanbul ignore end*/
            hunk.lines).push.apply(
              /*istanbul ignore start*/
              _hunk$lines4,
              /*istanbul ignore start*/
              _toConsumableArray(
                /*istanbul ignore end*/
                theirChanges
              )
            );
            return;
          }
        } else if (
          /*istanbul ignore start*/
          (0, /*istanbul ignore end*/
          /*istanbul ignore start*/
          _array.arrayEqual)(myChanges, theirChanges)
        ) {
          var _hunk$lines5;
          (_hunk$lines5 = /*istanbul ignore end*/
          hunk.lines).push.apply(
            /*istanbul ignore start*/
            _hunk$lines5,
            /*istanbul ignore start*/
            _toConsumableArray(
              /*istanbul ignore end*/
              myChanges
            )
          );
          return;
        }
        conflict(hunk, myChanges, theirChanges);
      }
      function removal(hunk, mine, their, swap) {
        var myChanges = collectChange(mine), theirChanges = collectContext(their, myChanges);
        if (theirChanges.merged) {
          var _hunk$lines6;
          (_hunk$lines6 = /*istanbul ignore end*/
          hunk.lines).push.apply(
            /*istanbul ignore start*/
            _hunk$lines6,
            /*istanbul ignore start*/
            _toConsumableArray(
              /*istanbul ignore end*/
              theirChanges.merged
            )
          );
        } else {
          conflict(hunk, swap ? theirChanges : myChanges, swap ? myChanges : theirChanges);
        }
      }
      function conflict(hunk, mine, their) {
        hunk.conflict = true;
        hunk.lines.push({
          conflict: true,
          mine,
          theirs: their
        });
      }
      function insertLeading(hunk, insert, their) {
        while (insert.offset < their.offset && insert.index < insert.lines.length) {
          var line = insert.lines[insert.index++];
          hunk.lines.push(line);
          insert.offset++;
        }
      }
      function insertTrailing(hunk, insert) {
        while (insert.index < insert.lines.length) {
          var line = insert.lines[insert.index++];
          hunk.lines.push(line);
        }
      }
      function collectChange(state) {
        var ret = [], operation = state.lines[state.index][0];
        while (state.index < state.lines.length) {
          var line = state.lines[state.index];
          if (operation === "-" && line[0] === "+") {
            operation = "+";
          }
          if (operation === line[0]) {
            ret.push(line);
            state.index++;
          } else {
            break;
          }
        }
        return ret;
      }
      function collectContext(state, matchChanges) {
        var changes = [], merged = [], matchIndex = 0, contextChanges = false, conflicted = false;
        while (matchIndex < matchChanges.length && state.index < state.lines.length) {
          var change = state.lines[state.index], match = matchChanges[matchIndex];
          if (match[0] === "+") {
            break;
          }
          contextChanges = contextChanges || change[0] !== " ";
          merged.push(match);
          matchIndex++;
          if (change[0] === "+") {
            conflicted = true;
            while (change[0] === "+") {
              changes.push(change);
              change = state.lines[++state.index];
            }
          }
          if (match.substr(1) === change.substr(1)) {
            changes.push(change);
            state.index++;
          } else {
            conflicted = true;
          }
        }
        if ((matchChanges[matchIndex] || "")[0] === "+" && contextChanges) {
          conflicted = true;
        }
        if (conflicted) {
          return changes;
        }
        while (matchIndex < matchChanges.length) {
          merged.push(matchChanges[matchIndex++]);
        }
        return {
          merged,
          changes
        };
      }
      function allRemoves(changes) {
        return changes.reduce(function(prev, change) {
          return prev && change[0] === "-";
        }, true);
      }
      function skipRemoveSuperset(state, removeChanges, delta) {
        for (var i = 0; i < delta; i++) {
          var changeContent = removeChanges[removeChanges.length - delta + i].substr(1);
          if (state.lines[state.index + i] !== " " + changeContent) {
            return false;
          }
        }
        state.index += delta;
        return true;
      }
      function calcOldNewLineCount(lines) {
        var oldLines = 0;
        var newLines = 0;
        lines.forEach(function(line) {
          if (typeof line !== "string") {
            var myCount = calcOldNewLineCount(line.mine);
            var theirCount = calcOldNewLineCount(line.theirs);
            if (oldLines !== void 0) {
              if (myCount.oldLines === theirCount.oldLines) {
                oldLines += myCount.oldLines;
              } else {
                oldLines = void 0;
              }
            }
            if (newLines !== void 0) {
              if (myCount.newLines === theirCount.newLines) {
                newLines += myCount.newLines;
              } else {
                newLines = void 0;
              }
            }
          } else {
            if (newLines !== void 0 && (line[0] === "+" || line[0] === " ")) {
              newLines++;
            }
            if (oldLines !== void 0 && (line[0] === "-" || line[0] === " ")) {
              oldLines++;
            }
          }
        });
        return {
          oldLines,
          newLines
        };
      }
    }
  });

  // node_modules/diff/lib/patch/reverse.js
  var require_reverse = __commonJS({
    "node_modules/diff/lib/patch/reverse.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.reversePatch = reversePatch;
      function _typeof(o) {
        "@babel/helpers - typeof";
        return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o2) {
          return typeof o2;
        } : function(o2) {
          return o2 && "function" == typeof Symbol && o2.constructor === Symbol && o2 !== Symbol.prototype ? "symbol" : typeof o2;
        }, _typeof(o);
      }
      function ownKeys(e, r) {
        var t = Object.keys(e);
        if (Object.getOwnPropertySymbols) {
          var o = Object.getOwnPropertySymbols(e);
          r && (o = o.filter(function(r2) {
            return Object.getOwnPropertyDescriptor(e, r2).enumerable;
          })), t.push.apply(t, o);
        }
        return t;
      }
      function _objectSpread(e) {
        for (var r = 1; r < arguments.length; r++) {
          var t = null != arguments[r] ? arguments[r] : {};
          r % 2 ? ownKeys(Object(t), true).forEach(function(r2) {
            _defineProperty(e, r2, t[r2]);
          }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function(r2) {
            Object.defineProperty(e, r2, Object.getOwnPropertyDescriptor(t, r2));
          });
        }
        return e;
      }
      function _defineProperty(obj, key, value) {
        key = _toPropertyKey(key);
        if (key in obj) {
          Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
        } else {
          obj[key] = value;
        }
        return obj;
      }
      function _toPropertyKey(t) {
        var i = _toPrimitive(t, "string");
        return "symbol" == _typeof(i) ? i : i + "";
      }
      function _toPrimitive(t, r) {
        if ("object" != _typeof(t) || !t) return t;
        var e = t[Symbol.toPrimitive];
        if (void 0 !== e) {
          var i = e.call(t, r || "default");
          if ("object" != _typeof(i)) return i;
          throw new TypeError("@@toPrimitive must return a primitive value.");
        }
        return ("string" === r ? String : Number)(t);
      }
      function reversePatch(structuredPatch) {
        if (Array.isArray(structuredPatch)) {
          return structuredPatch.map(reversePatch).reverse();
        }
        return (
          /*istanbul ignore start*/
          _objectSpread(_objectSpread(
            {},
            /*istanbul ignore end*/
            structuredPatch
          ), {}, {
            oldFileName: structuredPatch.newFileName,
            oldHeader: structuredPatch.newHeader,
            newFileName: structuredPatch.oldFileName,
            newHeader: structuredPatch.oldHeader,
            hunks: structuredPatch.hunks.map(function(hunk) {
              return {
                oldLines: hunk.newLines,
                oldStart: hunk.newStart,
                newLines: hunk.oldLines,
                newStart: hunk.oldStart,
                lines: hunk.lines.map(function(l) {
                  if (l.startsWith("-")) {
                    return (
                      /*istanbul ignore start*/
                      "+".concat(
                        /*istanbul ignore end*/
                        l.slice(1)
                      )
                    );
                  }
                  if (l.startsWith("+")) {
                    return (
                      /*istanbul ignore start*/
                      "-".concat(
                        /*istanbul ignore end*/
                        l.slice(1)
                      )
                    );
                  }
                  return l;
                })
              };
            })
          })
        );
      }
    }
  });

  // node_modules/diff/lib/convert/dmp.js
  var require_dmp = __commonJS({
    "node_modules/diff/lib/convert/dmp.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.convertChangesToDMP = convertChangesToDMP;
      function convertChangesToDMP(changes) {
        var ret = [], change, operation;
        for (var i = 0; i < changes.length; i++) {
          change = changes[i];
          if (change.added) {
            operation = 1;
          } else if (change.removed) {
            operation = -1;
          } else {
            operation = 0;
          }
          ret.push([operation, change.value]);
        }
        return ret;
      }
    }
  });

  // node_modules/diff/lib/convert/xml.js
  var require_xml = __commonJS({
    "node_modules/diff/lib/convert/xml.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.convertChangesToXML = convertChangesToXML;
      function convertChangesToXML(changes) {
        var ret = [];
        for (var i = 0; i < changes.length; i++) {
          var change = changes[i];
          if (change.added) {
            ret.push("<ins>");
          } else if (change.removed) {
            ret.push("<del>");
          }
          ret.push(escapeHTML(change.value));
          if (change.added) {
            ret.push("</ins>");
          } else if (change.removed) {
            ret.push("</del>");
          }
        }
        return ret.join("");
      }
      function escapeHTML(s) {
        var n = s;
        n = n.replace(/&/g, "&amp;");
        n = n.replace(/</g, "&lt;");
        n = n.replace(/>/g, "&gt;");
        n = n.replace(/"/g, "&quot;");
        return n;
      }
    }
  });

  // node_modules/diff/lib/index.js
  var require_lib = __commonJS({
    "node_modules/diff/lib/index.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      Object.defineProperty(exports, "Diff", {
        enumerable: true,
        get: function get() {
          return _base["default"];
        }
      });
      Object.defineProperty(exports, "applyPatch", {
        enumerable: true,
        get: function get() {
          return _apply.applyPatch;
        }
      });
      Object.defineProperty(exports, "applyPatches", {
        enumerable: true,
        get: function get() {
          return _apply.applyPatches;
        }
      });
      Object.defineProperty(exports, "canonicalize", {
        enumerable: true,
        get: function get() {
          return _json.canonicalize;
        }
      });
      Object.defineProperty(exports, "convertChangesToDMP", {
        enumerable: true,
        get: function get() {
          return _dmp.convertChangesToDMP;
        }
      });
      Object.defineProperty(exports, "convertChangesToXML", {
        enumerable: true,
        get: function get() {
          return _xml.convertChangesToXML;
        }
      });
      Object.defineProperty(exports, "createPatch", {
        enumerable: true,
        get: function get() {
          return _create.createPatch;
        }
      });
      Object.defineProperty(exports, "createTwoFilesPatch", {
        enumerable: true,
        get: function get() {
          return _create.createTwoFilesPatch;
        }
      });
      Object.defineProperty(exports, "diffArrays", {
        enumerable: true,
        get: function get() {
          return _array.diffArrays;
        }
      });
      Object.defineProperty(exports, "diffChars", {
        enumerable: true,
        get: function get() {
          return _character.diffChars;
        }
      });
      Object.defineProperty(exports, "diffCss", {
        enumerable: true,
        get: function get() {
          return _css.diffCss;
        }
      });
      Object.defineProperty(exports, "diffJson", {
        enumerable: true,
        get: function get() {
          return _json.diffJson;
        }
      });
      Object.defineProperty(exports, "diffLines", {
        enumerable: true,
        get: function get() {
          return _line.diffLines;
        }
      });
      Object.defineProperty(exports, "diffSentences", {
        enumerable: true,
        get: function get() {
          return _sentence.diffSentences;
        }
      });
      Object.defineProperty(exports, "diffTrimmedLines", {
        enumerable: true,
        get: function get() {
          return _line.diffTrimmedLines;
        }
      });
      Object.defineProperty(exports, "diffWords", {
        enumerable: true,
        get: function get() {
          return _word.diffWords;
        }
      });
      Object.defineProperty(exports, "diffWordsWithSpace", {
        enumerable: true,
        get: function get() {
          return _word.diffWordsWithSpace;
        }
      });
      Object.defineProperty(exports, "formatPatch", {
        enumerable: true,
        get: function get() {
          return _create.formatPatch;
        }
      });
      Object.defineProperty(exports, "merge", {
        enumerable: true,
        get: function get() {
          return _merge.merge;
        }
      });
      Object.defineProperty(exports, "parsePatch", {
        enumerable: true,
        get: function get() {
          return _parse.parsePatch;
        }
      });
      Object.defineProperty(exports, "reversePatch", {
        enumerable: true,
        get: function get() {
          return _reverse.reversePatch;
        }
      });
      Object.defineProperty(exports, "structuredPatch", {
        enumerable: true,
        get: function get() {
          return _create.structuredPatch;
        }
      });
      var _base = _interopRequireDefault(require_base());
      var _character = require_character();
      var _word = require_word();
      var _line = require_line();
      var _sentence = require_sentence();
      var _css = require_css();
      var _json = require_json();
      var _array = require_array();
      var _apply = require_apply();
      var _parse = require_parse();
      var _merge = require_merge();
      var _reverse = require_reverse();
      var _create = require_create();
      var _dmp = require_dmp();
      var _xml = require_xml();
      function _interopRequireDefault(obj) {
        return obj && obj.__esModule ? obj : { "default": obj };
      }
    }
  });

  // core/diff-viewer.js
  var require_diff_viewer = __commonJS({
    "core/diff-viewer.js"(exports, module) {
      var { diffWords } = require_lib();
      var DiffViewer = class {
        constructor() {
          this.el = null;
        }
        mount() {
          if (this.el) return this.el;
          const overlay = document.createElement("div");
          overlay.id = "bc-diff-viewer-overlay";
          overlay.innerHTML = `
      <div class="bc-dv-box">
        <div class="bc-dv-header">
          <strong>Compare Responses</strong>
          <button type="button" class="bc-dv-close" data-bc-dv-close title="Close">\u2715</button>
        </div>
        <div class="bc-dv-inputs">
          <textarea class="bc-dv-textarea" placeholder="Response A" data-bc-dv-a></textarea>
          <textarea class="bc-dv-textarea" placeholder="Response B" data-bc-dv-b></textarea>
        </div>
        <button type="button" class="bc-btn" data-bc-dv-run>Diff</button>
        <div class="bc-dv-result" data-bc-dv-result></div>
      </div>
    `;
          document.body.appendChild(overlay);
          this.el = overlay;
          overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) this.close();
          });
          overlay.querySelector("[data-bc-dv-close]").addEventListener("click", () => this.close());
          overlay.querySelector("[data-bc-dv-run]").addEventListener("click", () => this._runDiff());
          return overlay;
        }
        // { a, b } optionally prefills a side — e.g. from the fork-buttons layer's
        // "Copy for compare" affordance, so the user doesn't have to paste by hand.
        open({ a, b } = {}) {
          if (!this.el) this.mount();
          this.el.classList.add("bc-open");
          if (a != null) this.el.querySelector("[data-bc-dv-a]").value = a;
          if (b != null) this.el.querySelector("[data-bc-dv-b]").value = b;
        }
        close() {
          if (this.el) this.el.classList.remove("bc-open");
        }
        toggle() {
          if (this.el && this.el.classList.contains("bc-open")) this.close();
          else this.open();
        }
        _runDiff() {
          const a = this.el.querySelector("[data-bc-dv-a]").value;
          const b = this.el.querySelector("[data-bc-dv-b]").value;
          const result = this.el.querySelector("[data-bc-dv-result]");
          result.innerHTML = "";
          diffWords(a, b).forEach((part) => {
            const span = document.createElement("span");
            span.textContent = part.value;
            if (part.added) span.className = "bc-dv-added";
            else if (part.removed) span.className = "bc-dv-removed";
            result.appendChild(span);
          });
        }
        unmount() {
          if (this.el) {
            this.el.remove();
            this.el = null;
          }
        }
      };
      module.exports = { DiffViewer };
    }
  });

  // core/file-sync-indicator.js
  var require_file_sync_indicator = __commonJS({
    "core/file-sync-indicator.js"(exports, module) {
      var { findComposer, getComposerText, setComposerText, insertIntoComposer } = require_compose_insert();
      function guessCodeFenceLang(filename) {
        const ext = (filename.split(".").pop() || "").toLowerCase();
        const map = {
          js: "javascript",
          jsx: "jsx",
          ts: "typescript",
          tsx: "tsx",
          py: "python",
          rb: "ruby",
          go: "go",
          rs: "rust",
          java: "java",
          c: "c",
          cpp: "cpp",
          cs: "csharp",
          php: "php",
          sh: "bash",
          json: "json",
          yml: "yaml",
          yaml: "yaml",
          md: "markdown",
          html: "html",
          css: "css",
          sql: "sql"
        };
        return map[ext] || "";
      }
      function marker(label) {
        return `--- ${label} (watched by BetterClaude) ---`;
      }
      function buildFileBlock(label, content) {
        const lang = guessCodeFenceLang(label);
        return `${marker(label)}
\`\`\`${lang}
${content}
\`\`\``;
      }
      function findAndReplaceInComposer(label, newContent, root = document) {
        const composer = findComposer(root);
        if (!composer) return false;
        const value = getComposerText(composer);
        const head = marker(label);
        const startIdx = value.indexOf(head);
        if (startIdx === -1) return false;
        const fenceStart = value.indexOf("```", startIdx);
        if (fenceStart === -1) return false;
        const fenceEnd = value.indexOf("```", fenceStart + 3);
        const blockEnd = fenceEnd === -1 ? value.length : fenceEnd + 3;
        const newBlock = buildFileBlock(label, newContent);
        const nextValue = value.slice(0, startIdx) + newBlock + value.slice(blockEnd);
        setComposerText(composer, nextValue);
        return true;
      }
      function insertFileBlock(label, content) {
        return insertIntoComposer(buildFileBlock(label, content), { append: true });
      }
      module.exports = { buildFileBlock, findAndReplaceInComposer, insertFileBlock, marker, guessCodeFenceLang };
    }
  });

  // core/clipboard-bridge.js
  var require_clipboard_bridge = __commonJS({
    "core/clipboard-bridge.js"(exports, module) {
      var CHANNEL_SALT = "betterclaude-clipboard-bridge:channel";
      var KEY_SALT = "betterclaude-clipboard-bridge:key";
      var PBKDF2_ITERATIONS = 1e5;
      function toBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
        return typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
      }
      function fromBase64(b64) {
        const binary = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }
      function subtle() {
        const c = globalThis.crypto;
        if (!c || !c.subtle) throw new Error("WebCrypto is unavailable in this context.");
        return c.subtle;
      }
      async function deriveChannelId(passphrase) {
        const digest = await subtle().digest("SHA-256", new TextEncoder().encode(CHANNEL_SALT + passphrase));
        return toBase64(digest).replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
      }
      async function deriveKey(passphrase) {
        const baseKey = await subtle().importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
        return subtle().deriveKey(
          { name: "PBKDF2", salt: new TextEncoder().encode(KEY_SALT), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
          baseKey,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        );
      }
      async function encryptText(plainText, passphrase) {
        const key = await deriveKey(passphrase);
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await subtle().encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plainText));
        return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
      }
      async function decryptText({ iv, ciphertext }, passphrase) {
        const key = await deriveKey(passphrase);
        const plainBuffer = await subtle().decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(ciphertext));
        return new TextDecoder().decode(plainBuffer);
      }
      module.exports = { deriveChannelId, deriveKey, encryptText, decryptText };
    }
  });

  // core/analytics-charts.js
  var require_analytics_charts = __commonJS({
    "core/analytics-charts.js"(exports, module) {
      var PALETTE = ["#8b5cf6", "#22c55e", "#f59e0b", "#ef4444", "#38bdf8", "#f472b6", "#a3e635", "#fb923c"];
      function setupCanvas(canvas, widthCss, heightCss) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = widthCss * dpr;
        canvas.height = heightCss * dpr;
        canvas.style.width = `${widthCss}px`;
        canvas.style.height = `${heightCss}px`;
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, widthCss, heightCss);
        return ctx;
      }
      function renderLineChart(canvas, { labels, series }, { width = 640, height = 220, color = "#8b5cf6" } = {}) {
        const ctx = setupCanvas(canvas, width, height);
        const padding = { top: 16, right: 16, bottom: 28, left: 44 };
        const plotW = width - padding.left - padding.right;
        const plotH = height - padding.top - padding.bottom;
        ctx.font = "10px -apple-system, sans-serif";
        ctx.textAlign = "left";
        if (!labels || labels.length === 0) {
          ctx.fillStyle = "rgba(236,231,251,0.65)";
          ctx.fillText("No data in this range.", padding.left, height / 2);
          return;
        }
        const maxVal = Math.max(1, ...series);
        const stepX = labels.length > 1 ? plotW / (labels.length - 1) : 0;
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.fillStyle = "rgba(236,231,251,0.65)";
        for (let i = 0; i <= 4; i += 1) {
          const y = padding.top + plotH - plotH * i / 4;
          ctx.beginPath();
          ctx.moveTo(padding.left, y);
          ctx.lineTo(padding.left + plotW, y);
          ctx.stroke();
          ctx.fillText(String(Math.round(maxVal * i / 4)), 4, y + 3);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        series.forEach((val, i) => {
          const x = padding.left + stepX * i;
          const y = padding.top + plotH - plotH * val / maxVal;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.fillStyle = color;
        series.forEach((val, i) => {
          const x = padding.left + stepX * i;
          const y = padding.top + plotH - plotH * val / maxVal;
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.fillStyle = "rgba(236,231,251,0.65)";
        const showIdx = /* @__PURE__ */ new Set([0, labels.length - 1, Math.floor(labels.length / 2)]);
        showIdx.forEach((i) => {
          const x = padding.left + stepX * i;
          ctx.fillText(labels[i], Math.max(padding.left, Math.min(x - 14, width - 40)), height - 8);
        });
      }
      function renderBarChart(canvas, { labels, values }, { width = 640, height = 220 } = {}) {
        const ctx = setupCanvas(canvas, width, height);
        const padding = { top: 16, right: 16, bottom: 44, left: 16 };
        const plotW = width - padding.left - padding.right;
        const plotH = height - padding.top - padding.bottom;
        ctx.font = "10px -apple-system, sans-serif";
        if (!labels || labels.length === 0) {
          ctx.fillStyle = "rgba(236,231,251,0.65)";
          ctx.textAlign = "left";
          ctx.fillText("No data in this range.", padding.left, height / 2);
          return;
        }
        const maxVal = Math.max(1, ...values);
        const gap = 8;
        const barW = Math.max(4, (plotW - gap * (labels.length - 1)) / labels.length);
        const rotateLabels = labels.length > 6;
        labels.forEach((label, i) => {
          const val = values[i] || 0;
          const barH = maxVal > 0 ? plotH * val / maxVal : 0;
          const x = padding.left + i * (barW + gap);
          const y = padding.top + plotH - barH;
          ctx.fillStyle = PALETTE[i % PALETTE.length];
          ctx.fillRect(x, y, barW, barH);
          ctx.fillStyle = "rgba(236,231,251,0.9)";
          ctx.textAlign = "center";
          ctx.fillText(String(val), x + barW / 2, y - 4);
          ctx.fillStyle = "rgba(236,231,251,0.85)";
          ctx.save();
          ctx.translate(x + barW / 2, height - padding.bottom + 10);
          if (rotateLabels) ctx.rotate(-Math.PI / 4);
          ctx.textAlign = rotateLabels ? "right" : "center";
          const truncated = label.length > 16 ? `${label.slice(0, 15)}\u2026` : label;
          ctx.fillText(truncated, 0, 0);
          ctx.restore();
        });
      }
      module.exports = { renderLineChart, renderBarChart, PALETTE };
    }
  });

  // core/analytics-dashboard.js
  var require_analytics_dashboard = __commonJS({
    "core/analytics-dashboard.js"(exports, module) {
      var { renderBarChart } = require_analytics_charts();
      function isoDay(date) {
        return date.toISOString().slice(0, 10);
      }
      function presetRange(days) {
        const to = /* @__PURE__ */ new Date();
        const from = /* @__PURE__ */ new Date();
        from.setDate(from.getDate() - (days - 1));
        return { from: isoDay(from), to: isoDay(to) };
      }
      var AnalyticsDashboard = class {
        constructor(host) {
          this.host = host;
          this.el = null;
          this.range = presetRange(30);
          this.data = null;
        }
        mount() {
          if (this.el) return this.el;
          const overlay = document.createElement("div");
          overlay.id = "bc-analytics-overlay";
          overlay.innerHTML = `
      <div class="bc-an-box">
        <div class="bc-an-header">
          <strong>Usage Analytics</strong>
          <button type="button" class="bc-dv-close" data-bc-an-close title="Close">\u2715</button>
        </div>
        <div class="bc-an-controls">
          <div class="bc-an-presets" data-bc-an-presets>
            <button type="button" data-range="7">7d</button>
            <button type="button" data-range="30">30d</button>
            <button type="button" data-range="90">90d</button>
            <button type="button" data-range="3650">All</button>
          </div>
          <label class="bc-an-date-label">From <input type="date" data-bc-an-from></label>
          <label class="bc-an-date-label">To <input type="date" data-bc-an-to></label>
          <span class="bc-an-spacer"></span>
          <button type="button" class="bc-btn bc-btn-secondary" data-bc-an-export-csv>Export CSV</button>
          <button type="button" class="bc-btn bc-btn-secondary" data-bc-an-clear>Clear all data</button>
        </div>
        <div class="bc-an-body" data-bc-an-body>
          <div class="bc-an-totals" data-bc-an-totals></div>
          <div class="bc-an-chart-block bc-an-chart-wide">
            <div class="bc-an-chart-title"><span>Most-used skills/plugins</span><button type="button" class="bc-an-png" data-bc-an-png="plugins">PNG</button></div>
            <canvas data-bc-an-canvas="plugins"></canvas>
          </div>
        </div>
      </div>
    `;
          document.body.appendChild(overlay);
          this.el = overlay;
          overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) this.close();
          });
          overlay.querySelector("[data-bc-an-close]").addEventListener("click", () => this.close());
          overlay.querySelectorAll("[data-bc-an-presets] button").forEach((btn) => {
            btn.addEventListener("click", () => {
              this.range = presetRange(Number(btn.dataset.range));
              this._syncInputs();
              this._refresh();
            });
          });
          overlay.querySelector("[data-bc-an-export-csv]").addEventListener("click", async () => {
            const path = await this.host.exportCsv(this.range);
            if (path && this.host.notify) this.host.notify(`Exported to ${path}`);
          });
          overlay.querySelector("[data-bc-an-clear]").addEventListener("click", async () => {
            await this.host.clearAnalytics();
            this._refresh();
          });
          overlay.querySelectorAll("[data-bc-an-png]").forEach((btn) => {
            btn.addEventListener("click", () => this._exportPng(btn.dataset.bcAnPng));
          });
          return overlay;
        }
        _syncInputs() {
          this.el.querySelector("[data-bc-an-from]").value = this.range.from;
          this.el.querySelector("[data-bc-an-to]").value = this.range.to;
        }
        open() {
          if (!this.el) this.mount();
          this._syncInputs();
          this.el.classList.add("bc-open");
          const fromInput = this.el.querySelector("[data-bc-an-from]");
          const toInput = this.el.querySelector("[data-bc-an-to]");
          fromInput.onchange = () => {
            this.range = { ...this.range, from: fromInput.value };
            this._refresh();
          };
          toInput.onchange = () => {
            this.range = { ...this.range, to: toInput.value };
            this._refresh();
          };
          this._refresh();
        }
        close() {
          if (this.el) this.el.classList.remove("bc-open");
        }
        toggle() {
          if (this.el && this.el.classList.contains("bc-open")) this.close();
          else this.open();
        }
        async _refresh() {
          const body = this.el.querySelector("[data-bc-an-body]");
          body.classList.add("bc-an-loading");
          try {
            this.data = await this.host.queryAnalytics(this.range);
          } catch (err) {
            if (this.host.notify) this.host.notify(`Couldn't load analytics: ${err.message}`);
            this.data = null;
          }
          body.classList.remove("bc-an-loading");
          this._render();
        }
        _render() {
          const totalsEl = this.el.querySelector("[data-bc-an-totals]");
          totalsEl.innerHTML = "";
          if (!this.data) {
            totalsEl.textContent = "No data yet \u2014 usage is logged as you use claude.ai with BetterClaude running (Settings \u2192 Usage Analytics).";
            return;
          }
          const pluginTicks = this.data.topPlugins.reduce((sum, r) => sum + (r.count || 0), 0);
          [
            ["Plugins tracked", String(this.data.topPlugins.length)],
            ["Activity ticks", pluginTicks.toLocaleString()]
          ].forEach(([label, value]) => {
            const tile = document.createElement("div");
            tile.className = "bc-an-tile";
            const valueEl = document.createElement("div");
            valueEl.className = "bc-an-tile-value";
            valueEl.textContent = value;
            const labelEl = document.createElement("div");
            labelEl.className = "bc-an-tile-label";
            labelEl.textContent = label;
            tile.appendChild(valueEl);
            tile.appendChild(labelEl);
            totalsEl.appendChild(tile);
          });
          renderBarChart(this.el.querySelector('[data-bc-an-canvas="plugins"]'), {
            labels: this.data.topPlugins.map((r) => r.pluginId),
            values: this.data.topPlugins.map((r) => r.count || 0)
          }, { width: 900 });
        }
        _exportPng(key) {
          const canvas = this.el.querySelector(`[data-bc-an-canvas="${key}"]`);
          if (!canvas) return;
          const dataUrl = canvas.toDataURL("image/png");
          Promise.resolve(this.host.savePng(dataUrl, `betterclaude-${key}-${this.range.from}_${this.range.to}.png`)).then((path) => {
            if (path && this.host.notify) this.host.notify(`Saved to ${path}`);
          });
        }
        unmount() {
          if (this.el) {
            this.el.remove();
            this.el = null;
          }
        }
      };
      module.exports = { AnalyticsDashboard, presetRange };
    }
  });

  // core/update-banner.js
  var require_update_banner = __commonJS({
    "core/update-banner.js"(exports, module) {
      var BANNER_ID = "betterclaude-update-banner";
      var UpdateBanner = class {
        constructor({ onDownload, onInstall, onDismiss, onOpenReleases } = {}) {
          this.onDownload = onDownload || (() => {
          });
          this.onInstall = onInstall || (() => {
          });
          this.onDismiss = onDismiss || (() => {
          });
          this.onOpenReleases = onOpenReleases || (() => {
          });
          this.el = null;
          this.showErrors = false;
          this.status = { state: "idle" };
          this.dismissedVersion = null;
        }
        mount() {
          if (this.el) return this.el;
          const node = document.createElement("div");
          node.id = BANNER_ID;
          node.setAttribute("role", "status");
          node.setAttribute("aria-live", "polite");
          document.body.appendChild(node);
          this.el = node;
          return node;
        }
        destroy() {
          if (this.el) this.el.remove();
          this.el = null;
        }
        // Called on every betterclaude:update-status broadcast, and again
        // whenever settings change (dismissedVersion may have moved).
        update(status, { dismissedVersion = null } = {}) {
          this.status = status || { state: "idle" };
          this.dismissedVersion = dismissedVersion;
          this.render();
        }
        // A manual "Check now" opts this session into seeing failures inline;
        // background checks stay silent so a flaky network can't nag.
        setShowErrors(value) {
          this.showErrors = !!value;
        }
        _shouldShow() {
          const { state, version } = this.status;
          if (state === "available") return version !== this.dismissedVersion;
          if (state === "downloading" || state === "downloaded") return true;
          if (state === "error") return this.showErrors;
          return false;
        }
        render() {
          if (!this.el) return;
          if (!this._shouldShow()) {
            this.el.classList.remove("bc-open");
            this.el.innerHTML = "";
            return;
          }
          const { state, version, notes, percent, error } = this.status;
          this.el.innerHTML = "";
          this.el.classList.add("bc-open");
          const text = document.createElement("div");
          text.className = "bc-update-text";
          const title = document.createElement("strong");
          const blurb = document.createElement("span");
          blurb.className = "bc-update-blurb";
          if (state === "error") {
            title.textContent = "Update check failed";
            blurb.textContent = error || "Couldn't reach the update server.";
          } else if (state === "downloaded") {
            title.textContent = `Version ${version || ""} ready`.trim();
            blurb.textContent = "Restart to finish installing.";
          } else if (state === "downloading") {
            title.textContent = `Downloading v${version || ""}`.trim();
            blurb.textContent = `${percent || 0}%`;
          } else {
            title.textContent = `Update available: v${version}`;
            blurb.textContent = notes || "New version available";
          }
          text.appendChild(title);
          text.appendChild(blurb);
          this.el.appendChild(text);
          if (state === "downloading") {
            const track = document.createElement("div");
            track.className = "bc-update-progress";
            const fill = document.createElement("div");
            fill.className = "bc-update-progress-fill";
            fill.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
            track.appendChild(fill);
            this.el.appendChild(track);
          }
          const actions = document.createElement("div");
          actions.className = "bc-update-actions";
          if (state === "available") {
            actions.appendChild(this._button("Download & Install", "bc-update-primary", () => this.onDownload()));
            actions.appendChild(this._button("Later", "bc-update-ghost", () => {
              this.onDismiss(version);
              this.dismissedVersion = version;
              this.render();
            }));
          } else if (state === "downloaded") {
            actions.appendChild(this._button("Restart & Install", "bc-update-primary", () => this.onInstall()));
            actions.appendChild(this._button("Later", "bc-update-ghost", () => {
              this.status = { state: "idle" };
              this.render();
            }));
          } else if (state === "error") {
            actions.appendChild(this._button("Open Releases", "bc-update-primary", () => this.onOpenReleases()));
            actions.appendChild(this._button("Dismiss", "bc-update-ghost", () => {
              this.showErrors = false;
              this.render();
            }));
          }
          if (actions.childNodes.length) this.el.appendChild(actions);
        }
        _button(label, className, onClick) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `bc-update-btn ${className}`;
          btn.textContent = label;
          btn.addEventListener("click", onClick);
          return btn;
        }
      };
      module.exports = { UpdateBanner, BANNER_ID };
    }
  });

  // core/top-strip-guard.js
  var require_top_strip_guard = __commonJS({
    "core/top-strip-guard.js"(exports, module) {
      var OWN_ID_PREFIXES = ["betterclaude-", "bc-"];
      function isOwnChrome(el) {
        const stopAt = [document.body, document.documentElement];
        for (let n = el; n && n.nodeType === 1 && !stopAt.includes(n); n = n.parentElement) {
          const id = n.id || "";
          if (OWN_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) return true;
          const classes = n.classList;
          if (classes && Array.prototype.some.call(classes, (c) => c.startsWith("bc-"))) return true;
        }
        return false;
      }
      function describeElement(el) {
        if (!el || el.nodeType !== 1) return "<unknown>";
        const parts = [el.tagName.toLowerCase()];
        if (el.id) parts.push(`#${el.id}`);
        const testid = el.getAttribute("data-testid");
        if (testid) parts.push(`[data-testid="${testid}"]`);
        const label = el.getAttribute("aria-label");
        if (label) parts.push(`[aria-label="${label}"]`);
        const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
        if (text) parts.push(`"${text}"`);
        return parts.join(" ");
      }
      function probeReservedStrip(height, samples = 9) {
        if (!height || height <= 0 || typeof document.elementsFromPoint !== "function") return [];
        const width = document.documentElement.clientWidth || window.innerWidth || 0;
        if (width <= 0) return [];
        const rows = [0.25, 0.5, 0.75].map((f) => Math.round(height * f)).map((y) => Math.min(Math.max(y, 1), Math.max(height - 1, 1)));
        const bySignature = /* @__PURE__ */ new Map();
        for (let i = 0; i < samples; i += 1) {
          const x = Math.round((i + 0.5) / samples * width);
          for (const y of rows) {
            const stack = document.elementsFromPoint(x, y) || [];
            const hit = stack.find(
              (el) => el !== document.body && el !== document.documentElement && !isOwnChrome(el)
            );
            if (!hit) continue;
            const signature = describeElement(hit);
            if (!bySignature.has(signature)) bySignature.set(signature, { element: hit, signature, x, y });
          }
        }
        return [...bySignature.values()];
      }
      function mountTopStripGuard({ getHeight, enabled = true, warn = console.warn, maxWarnings = 5 } = {}) {
        const reported = /* @__PURE__ */ new Set();
        let warnings = 0;
        let scheduled = null;
        function check() {
          if (!enabled || warnings >= maxWarnings) return [];
          const height = typeof getHeight === "function" ? getHeight() : 0;
          const collisions = probeReservedStrip(height);
          for (const collision of collisions) {
            if (reported.has(collision.signature)) continue;
            reported.add(collision.signature);
            warnings += 1;
            warn(
              `[BetterClaude] Page content sits underneath the ${height}px title bar and cannot be clicked: ${collision.signature} (at ${collision.x},${collision.y}). Claude's own chrome has moved into the strip BetterClaude reserves. The app root's containing-block transform in ui/title-bar.css should keep fixed-positioned chrome out of this band \u2014 if this fired, something is escaping it (most likely an element portalled to <body> rather than into the app root, which that transform cannot reach).`,
              collision.element
            );
            if (warnings >= maxWarnings) break;
          }
          return collisions;
        }
        function checkSoon() {
          if (scheduled) return;
          scheduled = setTimeout(() => {
            scheduled = null;
            check();
          }, 250);
        }
        function unmount() {
          if (scheduled) clearTimeout(scheduled);
          scheduled = null;
        }
        return { check, checkSoon, unmount };
      }
      module.exports = {
        mountTopStripGuard,
        probeReservedStrip,
        isOwnChrome,
        describeElement,
        OWN_ID_PREFIXES
      };
    }
  });

  // core/layout-probe.js
  var require_layout_probe = __commonJS({
    "core/layout-probe.js"(exports, module) {
      var { OWN_ID_PREFIXES } = require_top_strip_guard();
      var ROOT_MARKER_CLASS = "bc-claude-root";
      var STATUS_CLASSES = {
        recognized: "bc-layout-recognized",
        partial: "bc-layout-partial",
        unrecognized: "bc-layout-unrecognized"
      };
      var NON_RENDERING_TAGS = /* @__PURE__ */ new Set([
        "SCRIPT",
        "STYLE",
        "LINK",
        "META",
        "TITLE",
        "BASE",
        "TEMPLATE",
        "NOSCRIPT"
      ]);
      function isOwnNode(el) {
        if (!el || el.nodeType !== 1) return false;
        const id = el.id || "";
        if (OWN_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) return true;
        const classes = el.classList;
        if (!classes) return false;
        return Array.prototype.some.call(
          classes,
          (c) => c.startsWith("bc-") && c !== ROOT_MARKER_CLASS
        );
      }
      function rootCandidates() {
        if (!document.body) return [];
        return Array.prototype.filter.call(
          document.body.children,
          (el) => !NON_RENDERING_TAGS.has(el.tagName) && !isOwnNode(el)
        );
      }
      function findClaudeRoot() {
        const candidates = rootCandidates();
        if (!candidates.length) return null;
        for (const id of ["root", "__next"]) {
          const match = candidates.find((el) => el.id === id);
          if (match) return { element: match, via: `body > #${id}`, tier: "primary" };
        }
        const composer = document.querySelector('[data-testid="chat-input"]');
        if (composer) {
          const owner = candidates.find((el) => el.contains(composer));
          if (owner) return { element: owner, via: "contains composer", tier: "heuristic" };
        }
        let best = null;
        let bestCount = -1;
        for (const el of candidates) {
          const count = el.getElementsByTagName("*").length;
          if (count > bestCount) {
            best = el;
            bestCount = count;
          }
        }
        if (!best || bestCount < 1) return null;
        return { element: best, via: `busiest body child (${bestCount} nodes)`, tier: "heuristic" };
      }
      function findTopTabBar(root) {
        const scope = root || document.body;
        if (!scope) return null;
        const tablist = scope.querySelector('[role="tablist"]');
        if (tablist) return { element: tablist, via: '[role="tablist"]', tier: "primary" };
        const tabs = scope.querySelectorAll('[role="tab"]');
        if (tabs.length >= 2 && tabs[0].parentElement) {
          return { element: tabs[0].parentElement, via: `${tabs.length}x [role="tab"]`, tier: "fallback" };
        }
        const band = Math.max((window.innerHeight || 0) * 0.25, 120);
        const sidebar = document.querySelector('nav[aria-label*="sidebar" i]') || document.querySelector('nav:has([data-testid="pin-sidebar-toggle"])');
        const containers = scope.querySelectorAll("nav, header, [role='navigation'], [class*='tab' i]");
        for (const el of containers) {
          if (sidebar && (el === sidebar || sidebar.contains(el) || el.contains(sidebar))) continue;
          const rect = el.getBoundingClientRect();
          if (rect.top > band || rect.width <= 0) continue;
          if (rect.height > 96 || rect.width < 200 || rect.width < rect.height * 3) continue;
          const controls = Array.prototype.filter.call(
            el.querySelectorAll("a, button"),
            (c) => c.getBoundingClientRect().width > 0
          );
          if (controls.length < 2) continue;
          const tops = controls.map((c) => Math.round(c.getBoundingClientRect().top));
          const rowSize = Math.max(...tops.map((t) => tops.filter((o) => Math.abs(o - t) <= 4).length));
          if (rowSize >= 2) {
            return { element: el, via: `top-band row of ${rowSize} controls`, tier: "fallback" };
          }
        }
        return null;
      }
      var REGIONS = [
        {
          key: "appRoot",
          label: "Application root",
          required: true,
          find: () => findClaudeRoot(),
          why: "Carries the containing-block transform that keeps Claude's fixed top chrome out of the title bar's band."
        },
        {
          key: "topTabBar",
          label: "Top-level tab bar",
          required: false,
          // Absence is always fine. Verified live against the current build: it ships
          // NO top-level tab bar at all — no [role="tablist"], no [role="tab"], no
          // <header> — and every top-band control lives inside the left sidebar. So
          // "not found" is the correct, healthy answer here, and treating it as a
          // degradation would report `partial` on a working app in perpetuity.
          // Whether Anthropic reverted the tab bar, gates it per account, or only
          // shows it on other routes, this region can only ever be informational.
          absenceIsNormal: () => true,
          find: (root) => findTopTabBar(root),
          why: "The surface that regressed when the Code tab moved into the reserved strip. Absent in the current build."
        },
        {
          key: "composer",
          label: "Composer",
          required: false,
          // Absent by design on the sign-in route.
          absenceIsNormal: ({ signedOut }) => signedOut,
          find: () => {
            const el = document.querySelector('[data-testid="chat-input"]');
            return el ? { element: el, via: '[data-testid="chat-input"]', tier: "primary" } : null;
          },
          why: "Signed-in/signed-out discriminator and the insertion target for prompt/file features."
        },
        {
          key: "sidebar",
          label: "Conversation sidebar",
          required: false,
          // Signed in, the sidebar always exists; its absence there is a real signal.
          absenceIsNormal: ({ signedOut }) => signedOut,
          find: () => {
            const pinned = document.querySelector('nav:has([data-testid="pin-sidebar-toggle"])');
            if (pinned) return { element: pinned, via: 'nav:has([data-testid="pin-sidebar-toggle"])', tier: "primary" };
            const nav = document.querySelector("nav");
            return nav ? { element: nav, via: "first <nav>", tier: "fallback" } : null;
          },
          why: "Target of the sidebar width/position/pin layout settings."
        }
      ];
      function probeLayout() {
        const rootResult = findClaudeRoot();
        const root = rootResult ? rootResult.element : null;
        const regions = REGIONS.map((region) => {
          let result = null;
          try {
            result = region.key === "appRoot" ? rootResult : region.find(root);
          } catch (err) {
            result = null;
          }
          return {
            key: region.key,
            label: region.label,
            required: !!region.required,
            absenceIsNormal: region.absenceIsNormal || (() => false),
            why: region.why,
            found: !!result,
            via: result ? result.via : null,
            tier: result ? result.tier : null,
            element: result ? result.element : null
          };
        });
        const missingRequired = regions.filter((r) => r.required && !r.found);
        const composerRegion = regions.find((r) => r.key === "composer");
        const signedOut = !(composerRegion && composerRegion.found);
        const context = { signedOut };
        regions.forEach((r) => {
          r.absentOk = r.found ? false : r.absenceIsNormal(context);
        });
        const degraded = regions.filter((r) => r.found ? r.tier !== "primary" : !r.absentOk);
        let status;
        if (missingRequired.length) status = "unrecognized";
        else if (degraded.length) status = "partial";
        else status = "recognized";
        const summary = regions.map((r) => {
          if (r.found) return `${r.key}=${r.tier}:${r.via}`;
          return `${r.key}=${r.absentOk ? "absent" : "MISSING"}`;
        }).join(" ");
        return { status, regions, root, summary };
      }
      function applyLayoutMarkers(probe) {
        document.querySelectorAll(`.${ROOT_MARKER_CLASS}`).forEach((el) => {
          el.classList.remove(ROOT_MARKER_CLASS);
        });
        if (probe.root) probe.root.classList.add(ROOT_MARKER_CLASS);
        if (document.body) {
          Object.values(STATUS_CLASSES).forEach((cls) => document.body.classList.remove(cls));
          document.body.classList.add(STATUS_CLASSES[probe.status] || STATUS_CLASSES.unrecognized);
        }
      }
      function mountLayoutProbe({
        onChange = null,
        verbose = false,
        log = console.log,
        warn = console.warn,
        // Same cap, and the same reasoning, as top-strip-guard's: a genuinely
        // persistent condition is one bug however many route changes rediscover it,
        // and a warning repeated on every DOM mutation burst is indistinguishable
        // from noise. Learned the hard way — before the tab-bar detector was
        // shape-constrained, its false positive re-warned on every navigation.
        maxWarnings = 5
      } = {}) {
        let last = null;
        let scheduled = null;
        let warnings = 0;
        function check() {
          const probe = probeLayout();
          applyLayoutMarkers(probe);
          const signature = `${probe.status}|${probe.summary}`;
          if (signature !== last) {
            const isFirstProbe = last === null;
            last = signature;
            const mayWarn = warnings < maxWarnings;
            if (probe.status !== "recognized" && mayWarn) warnings += 1;
            if (probe.status === "unrecognized" && mayWarn) {
              warn(
                `[BetterClaude] Claude UI structure: UNRECOGNIZED. No application root found under <body>, so page-geometry injection is suppressed (see the bc-layout-unrecognized rules in ui/title-bar.css). Regions: ${probe.summary}`
              );
            } else if (probe.status === "partial" && !isFirstProbe && mayWarn) {
              warn(
                `[BetterClaude] Claude UI structure: PARTIALLY RECOGNIZED \u2014 at least one region resolved via a fallback rather than its primary selector. Regions: ${probe.summary}`
              );
            } else if (verbose) {
              log(`[BetterClaude] Claude UI structure: ${probe.status.toUpperCase()}. Regions: ${probe.summary}`);
            }
            if (onChange) onChange(probe);
          }
          return probe;
        }
        function checkSoon() {
          if (scheduled) return;
          scheduled = setTimeout(() => {
            scheduled = null;
            check();
          }, 250);
        }
        function unmount() {
          if (scheduled) clearTimeout(scheduled);
          scheduled = null;
        }
        return { check, checkSoon, getStatus: () => last, unmount };
      }
      module.exports = {
        mountLayoutProbe,
        probeLayout,
        applyLayoutMarkers,
        findClaudeRoot,
        findTopTabBar,
        rootCandidates,
        REGIONS,
        ROOT_MARKER_CLASS,
        STATUS_CLASSES
      };
    }
  });

  // core/index.js
  var require_index = __commonJS({
    "core/index.js"(exports, module) {
      var {
        ThemeEngine,
        SELECTORS,
        THEME_VAR_DEFS,
        buildThemeCSSFromVars,
        resolveScheduledTheme,
        ensureStyleTag
      } = require_theme_engine();
      var { PluginLoader } = require_plugin_loader();
      var { DEFAULT_SETTINGS, mergeDefaults } = require_settings_schema();
      var tokens = require_tokens();
      var { applyBackground, buildBackgroundCSS } = require_background();
      var extrasCss = require_extras_css();
      var { InteractionFX } = require_interaction_fx();
      var { SoundEngine } = require_sound_engine();
      var motionFx = require_motion_fx();
      var companion = require_companion();
      var buddies = require_buddies();
      var { CommandPalette, mountKonamiListener, KONAMI_SEQUENCE, fuzzyScore } = require_command_palette();
      var vibeBundles = require_vibe_bundles();
      var weather = require_weather();
      var notifications = require_notifications();
      var { findComposer, insertIntoComposer, waitForComposer } = require_compose_insert();
      var { SkillMarketplaceOverlay } = require_skill_marketplace();
      var { extractVariables, fillTemplate } = require_prompt_vars();
      var { PromptPicker } = require_prompt_picker();
      var { DiffViewer } = require_diff_viewer();
      var { buildFileBlock, findAndReplaceInComposer, insertFileBlock } = require_file_sync_indicator();
      var { deriveChannelId, deriveKey, encryptText, decryptText } = require_clipboard_bridge();
      var { renderLineChart, renderBarChart } = require_analytics_charts();
      var { AnalyticsDashboard, presetRange } = require_analytics_dashboard();
      var { UpdateBanner, BANNER_ID } = require_update_banner();
      var { mountTopStripGuard, probeReservedStrip } = require_top_strip_guard();
      var {
        mountLayoutProbe,
        probeLayout,
        applyLayoutMarkers,
        findClaudeRoot,
        findTopTabBar
      } = require_layout_probe();
      module.exports = {
        ThemeEngine,
        SELECTORS,
        THEME_VAR_DEFS,
        buildThemeCSSFromVars,
        resolveScheduledTheme,
        ensureStyleTag,
        tokens,
        applyBackground,
        buildBackgroundCSS,
        PluginLoader,
        DEFAULT_SETTINGS,
        mergeDefaults,
        // Customize Everything additions:
        extrasCss,
        InteractionFX,
        SoundEngine,
        motionFx,
        companion,
        buddies,
        CommandPalette,
        mountKonamiListener,
        KONAMI_SEQUENCE,
        fuzzyScore,
        vibeBundles,
        weather,
        notifications,
        // Productivity modules: Skill Marketplace, Prompt Library.
        findComposer,
        insertIntoComposer,
        waitForComposer,
        SkillMarketplaceOverlay,
        extractVariables,
        fillTemplate,
        PromptPicker,
        DiffViewer,
        buildFileBlock,
        findAndReplaceInComposer,
        insertFileBlock,
        deriveChannelId,
        deriveKey,
        encryptText,
        decryptText,
        renderLineChart,
        renderBarChart,
        AnalyticsDashboard,
        presetRange,
        // In-app updates (GitHub Releases feed; transport supplied by the host).
        UpdateBanner,
        BANNER_ID,
        // Diagnostic: warns when claude.ai's own chrome ends up underneath the
        // custom title bar. Inert in the extension build, which reserves no strip.
        mountTopStripGuard,
        probeReservedStrip,
        // Version-aware injection gate: decides whether claude.ai's current DOM is
        // recognizable enough to apply page geometry to, and tags the app root the
        // geometry rules target. Unlike the guard above, this is load-bearing in
        // packaged builds — it is what makes an unknown layout degrade instead of
        // getting injected over blind.
        mountLayoutProbe,
        probeLayout,
        applyLayoutMarkers,
        findClaudeRoot,
        findTopTabBar
      };
    }
  });
  return require_index();
})();
