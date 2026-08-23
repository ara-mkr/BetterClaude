const esbuild = require("esbuild");
const path = require("path");

const watch = process.argv.includes("--watch");

const commonOpts = {
  bundle: true,
  platform: "browser",
  target: "chrome120",
  logLevel: "info",
};

async function build() {
  const ctxCore = await esbuild.context({
    ...commonOpts,
    entryPoints: [path.join(__dirname, "core/index.js")],
    outfile: path.join(__dirname, "build/core.bundle.js"),
    format: "iife",
    globalName: "BetterClaudeCore",
  });

  const ctxEditor = await esbuild.context({
    ...commonOpts,
    entryPoints: [path.join(__dirname, "ui/settings-panel/css-editor.js")],
    outfile: path.join(__dirname, "build/css-editor.bundle.js"),
    format: "cjs",
  });

  // Terminal emulator for the embedded Claude Code window. IIFE + globalName,
  // not cjs like the editor above: this one is loaded by a <script> tag in
  // electron/code-window.html, which runs in the page world where there is no
  // require() (nodeIntegration is off, by design). The CSS imported by the
  // entry lands next to it as build/xterm.bundle.css.
  const ctxXterm = await esbuild.context({
    ...commonOpts,
    entryPoints: [path.join(__dirname, "ui/code-window/xterm-entry.js")],
    outfile: path.join(__dirname, "build/xterm.bundle.js"),
    format: "iife",
    globalName: "BetterClaudeXterm",
  });

  const ctxIdeEditor = await esbuild.context({
    ...commonOpts,
    entryPoints: [path.join(__dirname, "ui/code-window/ide-editor-entry.js")],
    outfile: path.join(__dirname, "build/ide-editor.bundle.js"),
    format: "iife",
    globalName: "BetterClaudeIDEEditor",
  });

  // Snake + the while-Claude-is-working popup for both Code windows. IIFE
  // global like the xterm bundle, because the pages that load it have no
  // require() (nodeIntegration off).
  const ctxSnake = await esbuild.context({
    ...commonOpts,
    entryPoints: [path.join(__dirname, "ui/code-window/snake-entry.js")],
    outfile: path.join(__dirname, "build/snake.bundle.js"),
    format: "iife",
    globalName: "BetterClaudeSnake",
  });

  if (watch) {
    await ctxCore.watch();
    await ctxEditor.watch();
    await ctxXterm.watch();
    await ctxIdeEditor.watch();
    await ctxSnake.watch();
    console.log("esbuild watching for changes...");
  } else {
    await ctxCore.rebuild();
    await ctxEditor.rebuild();
    await ctxXterm.rebuild();
    await ctxIdeEditor.rebuild();
    await ctxSnake.rebuild();
    await ctxCore.dispose();
    await ctxEditor.dispose();
    await ctxXterm.dispose();
    await ctxIdeEditor.dispose();
    await ctxSnake.dispose();
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
