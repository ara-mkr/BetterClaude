/**
 * Shared geometry for the native macOS "hiddenInset" traffic lights and the
 * custom title bar's own layout, so the two can never drift apart. This is
 * the single source of truth for both:
 *   - main.js: passed straight into BrowserWindow's `trafficLightPosition`.
 *   - ui/title-bar.js: read (via `../electron/window-chrome`, since preload
 *     already crosses that boundary freely) to size the mac-only left
 *     spacer that keeps the logo/title from sitting under the real lights.
 *
 * Required by both electron/main.js (main process) and ui/title-bar.js
 * (loaded from electron/preload.js, which already requires modules from
 * both ../core and ../ui) — plain CommonJS, no Electron API surface here,
 * so it's safe to require from either side.
 */

// Height of the custom title bar (see ui/title-bar.css). Traffic lights are
// vertically centered within it.
const TITLE_BAR_HEIGHT = 38;

// Horizontal inset of the traffic-light cluster from the window's left
// edge — macOS convention for a comfortable hiddenInset bar.
const TRAFFIC_LIGHT_X = 14;

// Vertically centered in the custom bar.
const TRAFFIC_LIGHT_Y = Math.round(TITLE_BAR_HEIGHT / 2);

// Rendered footprint of macOS's own traffic-light cluster (three 12px dots
// with ~8px gaps between them). Electron doesn't expose this, so it's the
// standard system value also used by other native-titlebar Electron apps
// (VS Code, Slack) at this style/size, plus a hair of breathing room.
const TRAFFIC_LIGHT_CLUSTER_WIDTH = 52;

// Total width the custom bar's left side must reserve on macOS so nothing
// (logo button, title) renders underneath the real lights.
const TRAFFIC_LIGHT_RESERVED_WIDTH = TRAFFIC_LIGHT_X + TRAFFIC_LIGHT_CLUSTER_WIDTH;

module.exports = {
  TITLE_BAR_HEIGHT,
  TRAFFIC_LIGHT_X,
  TRAFFIC_LIGHT_Y,
  TRAFFIC_LIGHT_CLUSTER_WIDTH,
  TRAFFIC_LIGHT_RESERVED_WIDTH,
};
