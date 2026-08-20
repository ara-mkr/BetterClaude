/**
 * `npm run dev` entry point. Keeps esbuild rebuilding core/css-editor
 * bundles in watch mode and Electron running side by side, so editing
 * source no longer means quit-and-relaunch by hand:
 *   - core/**, ui/settings-panel/css-editor.js -> esbuild watch rebuilds
 *     build/*.bundle.js, which electron/main.js's dev auto-reload (see
 *     startDevAutoReload there) picks up and reloads the window for.
 *   - electron/main.js and other main-process-only files -> that same
 *     auto-reload does a full app.relaunch() instead, since the main
 *     process can't hot-swap itself.
 * Killing this script (Ctrl+C) tears down both child processes.
 */
const { spawn } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

const esbuildWatch = spawn(process.execPath, [path.join(root, "esbuild.config.js"), "--watch"], {
  cwd: root,
  stdio: "inherit",
});

let electronProc = null;
let shuttingDown = false;

function startElectron() {
  const electronBin = require("electron");
  electronProc = spawn(electronBin, [root, "--dev"], {
    cwd: root,
    stdio: "inherit",
  });
  electronProc.on("exit", (code) => {
    electronProc = null;
    if (!shuttingDown) shutdown(code || 0);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electronProc) electronProc.kill();
  esbuildWatch.kill();
  process.exit(code || 0);
}

esbuildWatch.on("exit", (code) => {
  if (!shuttingDown) shutdown(code || 0);
});

// esbuild.config.js logs synchronously and does its first rebuild before
// entering watch mode, but there's no clean "ready" signal to hook — a
// short delay is simpler than parsing its stdout and the first build is
// near-instant anyway.
setTimeout(startElectron, 800);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
