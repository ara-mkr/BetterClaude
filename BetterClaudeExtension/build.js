/**
 * Build script for the extension: bundles the *same* core/ and ui/ sources
 * the Electron app uses (no fork, no duplication) into browser-loadable
 * IIFE bundles under dist/, and copies the static assets referenced by
 * manifest.json. Nothing under core/ or ui/ is modified for this build —
 * that portability is exactly what BetterClaude's file-layout convention
 * (see the top-of-file comments in core/index.js and electron/preload.js)
 * was designed for.
 */
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "dist");
const watch = process.argv.includes("--watch");

const commonOpts = { bundle: true, platform: "browser", target: "chrome120", logLevel: "info" };

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, filter);
    else if (!filter || filter(entry.name)) fs.copyFileSync(s, d);
  }
}

function bundlePlugins() {
  const pluginsDir = path.join(ROOT, "plugins");
  const files = fs.readdirSync(pluginsDir).filter((f) => f.endsWith(".claudeplugin.js"));
  return files.map((file) => {
    const id = file.replace(/\.claudeplugin\.js$/, "");
    const globalName = `BCPlugin_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    return esbuild.build({
      ...commonOpts,
      entryPoints: [path.join(pluginsDir, file)],
      outfile: path.join(OUT, "plugins", `${id}.bundle.js`),
      format: "iife",
      globalName,
      footer: { js: `window.BetterClaudePlugins = window.BetterClaudePlugins || {}; window.BetterClaudePlugins[${JSON.stringify(id)}] = ${globalName};` },
    });
  });
}

async function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  await Promise.all([
    esbuild.build({
      ...commonOpts,
      entryPoints: [path.join(ROOT, "core/index.js")],
      outfile: path.join(OUT, "core.bundle.js"),
      format: "iife",
      globalName: "BetterClaudeCore",
    }),
    esbuild.build({
      ...commonOpts,
      entryPoints: [path.join(ROOT, "ui/settings-panel/panel.js")],
      outfile: path.join(OUT, "settings-panel.bundle.js"),
      format: "iife",
      globalName: "BetterClaudeSettingsPanel",
    }),
    esbuild.build({
      ...commonOpts,
      entryPoints: [path.join(ROOT, "ui/settings-panel/css-editor.js")],
      outfile: path.join(OUT, "css-editor.bundle.js"),
      format: "iife",
      globalName: "BetterClaudeCssEditor",
    }),
    esbuild.build({
      ...commonOpts,
      entryPoints: [path.join(ROOT, "ui/mini-game/snake.js")],
      outfile: path.join(OUT, "snake.bundle.js"),
      format: "iife",
      globalName: "BetterClaudeSnake",
    }),
    esbuild.build({
      ...commonOpts,
      entryPoints: [path.join(__dirname, "background/service-worker.js")],
      outfile: path.join(OUT, "service-worker.bundle.js"),
      format: "iife",
    }),
    ...bundlePlugins(),
  ]);

  // Static assets referenced directly (CSS by path, themes/plugins read as text).
  copyDir(path.join(ROOT, "ui"), path.join(OUT, "ui"), (name) => name.endsWith(".css"));
  copyDir(path.join(ROOT, "themes"), path.join(OUT, "themes"), (name) => name.endsWith(".css"));
  copyDir(path.join(ROOT, "assets"), path.join(OUT, "assets"));

  // background/service-worker.js's fetchBundledThemes() has no directory-
  // listing API for extension resources, so record the id list once here.
  const themeIds = fs.readdirSync(path.join(ROOT, "themes")).filter((f) => f.endsWith(".css")).map((f) => f.replace(/\.css$/, ""));
  fs.writeFileSync(path.join(OUT, "themes", "_manifest.json"), JSON.stringify(themeIds));

  console.log("BetterClaudeExtension build complete ->", OUT);
}

if (watch) {
  // esbuild.build() above already does one-shot bundling; simplest correct
  // watch mode for this small extra build step is a full rebuild loop on
  // fs change events rather than wiring incremental contexts per-plugin.
  const chokidar = require("chokidar");
  build().catch((err) => { console.error(err); process.exit(1); });
  chokidar
    .watch([path.join(ROOT, "core"), path.join(ROOT, "ui"), path.join(ROOT, "themes"), path.join(ROOT, "plugins")], { ignoreInitial: true })
    .on("all", () => build().catch((err) => console.error(err)));
  console.log("Watching core/ ui/ themes/ plugins/ for changes...");
} else {
  build().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
