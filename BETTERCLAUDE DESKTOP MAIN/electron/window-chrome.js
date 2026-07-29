/**
 * Shared geometry for the native macOS "hiddenInset" traffic lights and the
 * custom title bar's own layout, so the two can never drift apart. This is
 * the single source of truth for all three consumers:
 *   - main.js: passed straight into BrowserWindow's `trafficLightPosition`.
 *   - ui/title-bar.js: read (via `../electron/window-chrome`, since preload
 *     already crosses that boundary freely) to size the mac-only left
 *     spacer that keeps the logo/title from sitting under the real lights.
 *   - electron/preload.js: substitutes TITLE_BAR_HEIGHT into every static
 *     stylesheet's `__BC_TITLE_BAR_HEIGHT__` placeholder at injection time,
 *     which is what lets ui/title-bar.css and ui/settings-panel/panel.css
 *     size themselves off this constant instead of re-typing the number.
 *     Stylesheets must never hardcode the bar's height again — that drift
 *     is what let Claude's top chrome end up underneath the bar.
 *
 * Required by both electron/main.js (main process) and ui/title-bar.js
 * (loaded from electron/preload.js, which already requires modules from
 * both ../core and ../ui) — plain CommonJS, no Electron API surface here,
 * so it's safe to require from either side.
 */

// Height of the custom title bar, and therefore the exact amount of the
// window that page content must be inset by to clear it.
//
// This is now genuinely the single source of truth the file header claims.
// It previously read 38 while ui/title-bar.css hardcoded `46px` in eight
// separate places and ui/settings-panel/panel.css hardcoded it a ninth
// time — nothing imported this constant at all, so it silently described a
// bar that hadn't existed for some time, and TRAFFIC_LIGHT_Y below was
// being derived from the stale number. The stylesheets no longer carry the
// literal: they write `__BC_TITLE_BAR_HEIGHT__`, which
// electron/preload.js's injectStaticCSS substitutes from this constant as
// each sheet is injected (surfacing it to CSS as the --bc-tb-h custom
// property). Changing this value now really does move everything at once.
const TITLE_BAR_HEIGHT = 46;

// Horizontal inset of the traffic-light cluster from the window's left
// edge — macOS convention for a comfortable hiddenInset bar.
const TRAFFIC_LIGHT_X = 14;

// Vertical inset of the traffic-light cluster, in px from the window's top
// edge.
//
// Deliberately a tuned literal rather than a formula over TITLE_BAR_HEIGHT.
// macOS positions the cluster by its top-LEFT corner, not its center, so
// `TITLE_BAR_HEIGHT / 2` was never the centering formula it claimed to be —
// it just happened to land somewhere acceptable. Re-deriving it from the
// corrected 46px height would drop the real system lights 4px down the
// window as a side effect of fixing the height drift: a visible change
// nobody asked for. 19 is the value the shipped bar is tuned against (what
// the old expression evaluated to), so this is a no-op at runtime. If the
// bar's height ever changes, re-tune this by eye rather than by arithmetic.
const TRAFFIC_LIGHT_Y = 19;

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
