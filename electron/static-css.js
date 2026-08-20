/**
 * Injecting BetterClaude's own static stylesheets into a document, with the
 * shared geometry constants substituted in.
 *
 * Extracted from electron/preload.js so the second preload (electron/
 * code-preload.js, for the embedded Claude Code window) mounts the same
 * title bar and settings panel against the same numbers. A copy-pasted
 * substitution table in a second preload is precisely the drift this
 * mechanism exists to prevent: ui/title-bar.css once hardcoded `46px` in
 * eight places and panel.css a ninth while electron/window-chrome.js still
 * said 38, and nothing imported the constant at all.
 */

const fs = require("fs");
const { TITLE_BAR_HEIGHT } = require("./window-chrome");

// Geometry the main process and the injected stylesheets must agree on
// byte-for-byte. Rather than typing the number in both places, the sheets
// carry a `__BC_*__` placeholder substituted from the shared constant as the
// sheet is injected. Add an entry here to expose another constant to CSS;
// never re-type one in a stylesheet.
const CSS_SUBSTITUTIONS = {
  __BC_TITLE_BAR_HEIGHT__: String(TITLE_BAR_HEIGHT),
};

/**
 * Idempotent by id, matching core/theme-engine.js's ensureStyleTag(). A full
 * reload cannot double-inject — Electron gives preload a brand-new realm and a
 * brand-new document per navigation, so the previous tags are gone with the
 * previous document — but "cannot happen today" is a weak guarantee to hang a
 * stacking bug on: nothing structurally prevents a second bootstrap() in one
 * document, and the failure mode is silent. Duplicate <style> tags don't error,
 * they just quietly re-apply every rule at a later cascade position, so the
 * last-injected copy wins and any later override loses. Reusing the node keeps
 * exactly one copy of each sheet whatever the caller does.
 */
function injectStaticCSS(id, filePath) {
  const tag = document.getElementById(id) || document.createElement("style");
  tag.id = id;
  let css = fs.readFileSync(filePath, "utf8");
  // split/join rather than String.replace with a /g regex: these values are
  // plain integers today, but a substituted value containing `$&` or `$1`
  // would be silently reinterpreted as a replacement pattern by replace().
  for (const [token, value] of Object.entries(CSS_SUBSTITUTIONS)) {
    css = css.split(token).join(value);
  }
  tag.textContent = css;
  // Only attach when it isn't already in the tree. appendChild() on a
  // connected node is a move, not a copy, so re-appending wouldn't duplicate
  // anything — but it would relocate the sheet to the end of <head> and
  // silently reorder the cascade relative to the sheets injected after it.
  if (!tag.isConnected) document.head.appendChild(tag);
}

module.exports = { CSS_SUBSTITUTIONS, injectStaticCSS };
