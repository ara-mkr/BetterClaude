/**
 * Regenerates every bundled theme in themes/*.css from the single shared
 * scaffold in core/tokens.js, preserving each theme's --bc-* palette but
 * upgrading its selectors to the state-machine tokens, relational radius,
 * focus-visible rings and touch-gated hover the spec requires.
 *
 * This keeps ONE styling path: bundled, imported and generated themes are now
 * byte-for-byte the same scaffold with only their :root palette differing, so
 * the §5 auditor's static checks pass uniformly across all of them.
 *
 *   node scripts/regen-themes.js
 */
const fs = require("fs");
const path = require("path");
const { buildScaffoldCSS, extractThemeVars, relativeLuminance } = require("../core/tokens");

const THEMES_DIR = path.join(__dirname, "..", "themes");

function nameFromCss(css, fallback) {
  const m = /\/\*\s*BetterClaude[^:]*:\s*([^*]+?)\s*\*\//.exec(css);
  return m ? m[1].trim() : fallback;
}

function run() {
  const files = fs.readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
  let count = 0;
  files.forEach((file) => {
    const full = path.join(THEMES_DIR, file);
    const css = fs.readFileSync(full, "utf8");
    const vars = extractThemeVars(css);
    if (!vars["--bc-bg"]) {
      console.warn(`  skip ${file} (no --bc-bg found)`);
      return;
    }
    const name = nameFromCss(css, file.replace(/\.css$/, ""));
    const isDark = relativeLuminance(vars["--bc-bg"]) < 0.4;
    const out = buildScaffoldCSS(vars, { name, isDark }) + "\n";
    fs.writeFileSync(full, out, "utf8");
    count += 1;
    console.log(`  regenerated ${file} (${isDark ? "dark" : "light"})`);
  });
  console.log(`\nRegenerated ${count} theme(s).`);
}

run();
