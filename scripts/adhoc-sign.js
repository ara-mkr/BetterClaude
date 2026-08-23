/**
 * Ad-hoc code signing for macOS builds.
 *
 * electron-builder (v26) skips macOS signing entirely when no Developer ID
 * identity is configured. That leaves the repacked .app carrying the stock
 * Electron bundle signature, whose CodeResources no longer match the files
 * actually in the bundle — `codesign --verify` fails with "code has no
 * resources but signature indicates they must be present", and Apple Silicon
 * refuses to launch it with the infamous "BetterClaude is damaged" dialog
 * (0.3.x DMGs shipped with exactly this bug).
 *
 * This afterPack hook runs after the .app is assembled and before the DMG is
 * produced, and re-signs the whole bundle ad-hoc (`codesign --sign -`): no
 * identity, no notarization, but an internally consistent signature, which is
 * the minimum macOS arm64 requires to consider an app runnable at all.
 */
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  console.log(`[adhoc-sign] signed ${appPath}`);
};
