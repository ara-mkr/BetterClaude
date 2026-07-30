/**
 * Bundle entry for the terminal emulator used by the embedded Claude Code
 * window (electron/code-window.html).
 *
 * Bundled through esbuild into build/xterm.bundle.js rather than <script>-ing
 * node_modules directly, for the same reason ui/settings-panel/css-editor.js is
 * (see esbuild.config.js): build/*.bundle.js is an explicit entry in
 * package.json's electron-builder `files` list, so the packaged app has a
 * deterministic path to it, and the renderer gets one plain global instead of
 * depending on how a given npm layout happens to expose its UMD builds.
 *
 * Exposed as a global (IIFE + globalName) because code-window.html loads this
 * with a <script> tag from the page world, which has no require() — that's the
 * point: nodeIntegration is off, and the page reaches the pty only through the
 * contextBridge surface in electron/code-preload.js.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

// xterm's own stylesheet (cursor, selection, viewport geometry). Imported here
// so esbuild emits it as build/xterm.bundle.css next to the JS, keeping the two
// halves of the dependency versioned together.
import "@xterm/xterm/css/xterm.css";

export { Terminal, FitAddon };
