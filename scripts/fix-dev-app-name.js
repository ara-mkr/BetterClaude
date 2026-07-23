/**
 * Dev-mode-only fixup: `app.setName("BetterClaude")` in electron/main.js
 * changes app.getName() (userData path, About panel, Menu role labels),
 * but NOT the macOS menu bar / Cmd-Tab / Dock label for an unpackaged app —
 * that's read straight from the local Electron.app's own Info.plist, which
 * ships as "Electron". Packaged builds (electron-builder) don't have this
 * problem; this only matters for `npm start`/`npm run dev`. Runs as a
 * postinstall hook since node_modules/electron gets reset on every install.
 */
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const plistPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "Info.plist"
);

const appPath = path.join(__dirname, "..", "node_modules", "electron", "dist", "Electron.app");

if (process.platform !== "darwin" || !fs.existsSync(plistPath)) {
  process.exit(0);
}

try {
  execFileSync("plutil", ["-replace", "CFBundleName", "-string", "BetterClaude", plistPath]);
  execFileSync("plutil", ["-replace", "CFBundleDisplayName", "-string", "BetterClaude", plistPath]);
  // CFBundleIdentifier stays "com.github.Electron" by default, which is
  // shared by every Electron dev project's node_modules on this machine.
  // macOS's Launch Services caches the Dock-hover / Cmd-Tab display name
  // per bundle identifier, so a stale "Electron" entry registered under
  // that shared ID (by this project or any other) keeps winning even after
  // the Info.plist edit above — give this copy its own identifier so it
  // gets its own LS cache entry instead of colliding with that one.
  execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", "com.betterclaude.dev", plistPath]);

  const lsregister =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  if (fs.existsSync(lsregister)) {
    execFileSync(lsregister, ["-f", appPath]);
  }
} catch (err) {
  console.warn("[BetterClaude] couldn't rename dev Electron.app (non-fatal):", err.message);
}
