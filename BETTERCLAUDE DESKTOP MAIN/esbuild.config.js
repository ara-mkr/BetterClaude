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

  if (watch) {
    await ctxCore.watch();
    await ctxEditor.watch();
    console.log("esbuild watching for changes...");
  } else {
    await ctxCore.rebuild();
    await ctxEditor.rebuild();
    await ctxCore.dispose();
    await ctxEditor.dispose();
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
