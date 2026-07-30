/**
 * Postinstall fixup: make node-pty's `spawn-helper` executable.
 *
 * node-pty ships prebuilt N-API binaries under prebuilds/<platform>-<arch>/,
 * which is what lets it load under Electron with no rebuild step at all. But
 * the npm tarball does not preserve the executable bit on `spawn-helper`, the
 * small launcher node-pty exec()s on Unix to hand the child its controlling
 * terminal. It arrives as 0644.
 *
 * The failure this causes is a genuinely unhelpful one: `require("node-pty")`
 * succeeds, the addon loads, and every spawn then throws
 * `posix_spawnp failed.` with nothing pointing at a permission bit. Confirmed
 * on macOS arm64 with node-pty 1.1.0 (2026-07-29).
 *
 * Runs as a postinstall hook because node_modules is reset by every install,
 * so this has to be reapplied each time rather than fixed once by hand.
 * Windows has no spawn-helper (ConPTY does this in-process), so it no-ops.
 */
const fs = require("fs");
const path = require("path");

if (process.platform === "win32") process.exit(0);

const ptyRoot = path.join(__dirname, "..", "node_modules", "node-pty");
// Both locations node-pty's own lib/utils.js loadNativeModule() searches, so a
// source-built install (build/Release) is covered as well as a prebuilt one.
const candidates = [
  path.join(ptyRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  path.join(ptyRoot, "build", "Release", "spawn-helper"),
  path.join(ptyRoot, "build", "Debug", "spawn-helper"),
];

for (const helper of candidates) {
  try {
    if (!fs.existsSync(helper)) continue;
    const mode = fs.statSync(helper).mode;
    // Already executable by the owner — leave the exact mode alone rather than
    // forcing 0755 over whatever a source build produced.
    if (mode & fs.constants.S_IXUSR) continue;
    fs.chmodSync(helper, 0o755);
    console.log(`[BetterClaude] made node-pty's spawn-helper executable: ${helper}`);
  } catch (err) {
    // Never fail the install over this. If it stays 0644 the Code window shows
    // its own "couldn't start the terminal" screen with the real error, which
    // is a better outcome than a broken `npm install` for someone who may not
    // even use that window.
    console.warn(`[BetterClaude] could not chmod ${helper}: ${err.message}`);
  }
}
