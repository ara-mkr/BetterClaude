/**
 * Custom title bar. DOM-only aside from the `host` callbacks it is given
 * (minimize/maximizeToggle/close/toggleAlwaysOnTop), which the Electron
 * preload wires to IPC. A browser extension has no window chrome to
 * replace, so this module simply wouldn't be mounted there.
 *
 * On macOS the window uses `titleBarStyle: "hiddenInset"` (see
 * electron/main.js), so the real system traffic lights are drawn by the OS
 * itself — this bar only reserves space for them (see TRAFFIC_LIGHT_RESERVED_WIDTH
 * below) and no longer hand-draws its own dots there. On Windows/Linux the
 * window is still `frame: false` with no native chrome at all, so the
 * hand-drawn dots (and their minimize/maximizeToggle/close IPC calls) stay.
 *
 * Either way this bar remains mounted: it's the only way back into Settings
 * (the BetterClaude logo button opens the settings panel), which hiddenInset
 * and frame:false both remove the OS's own path to.
 */

const { TRAFFIC_LIGHT_RESERVED_WIDTH } = require("../electron/window-chrome");

const TITLE_BAR_ID = "betterclaude-titlebar";
const IS_MAC = process.platform === "darwin";

function mountTitleBar(host) {
  if (document.getElementById(TITLE_BAR_ID)) return;

  const bar = document.createElement("div");
  bar.id = TITLE_BAR_ID;
  // Single source of truth with main.js's trafficLightPosition (see
  // electron/window-chrome.js) — read by title-bar.css so the reserved
  // gutter and the actual native-light inset can't drift apart.
  bar.style.setProperty("--bc-tb-traffic-reserved", `${TRAFFIC_LIGHT_RESERVED_WIDTH}px`);

  // Windows/Linux: no native window chrome at all, so the bar hand-draws
  // its own traffic-light-styled dots wired to window IPC. macOS: an empty
  // drag spacer sized to TRAFFIC_LIGHT_RESERVED_WIDTH so the real system
  // lights (drawn by the OS on top of the page) have clear room and nothing
  // in the bar renders underneath them.
  const leftHtml = IS_MAC
    ? `<div class="bc-tb-traffic-spacer" data-bc-tb-drag></div>`
    : `<div class="bc-tb-traffic" data-bc-tb-drag>
        <button class="bc-tb-dot bc-tb-dot-close" data-bc-tb-close title="Close"></button>
        <button class="bc-tb-dot bc-tb-dot-min" data-bc-tb-min title="Minimize"></button>
        <button class="bc-tb-dot bc-tb-dot-max" data-bc-tb-max title="Maximize"></button>
      </div>`;

  bar.innerHTML = `
    ${leftHtml}
    <div class="bc-tb-drag bc-tb-center" data-bc-tb-drag>
      <span class="bc-tb-title">BetterClaude</span>
    </div>
    <div class="bc-tb-controls">
      <button class="bc-tb-btn bc-tb-logo-btn" data-bc-tb-settings title="BetterClaude Settings (Cmd/Ctrl+,)">
        ${host.logoSrc ? `<img class="bc-tb-logo" src="${host.logoSrc}" alt="Settings" />` : ""}
      </button>
    </div>
  `;
  document.body.prepend(bar);

  if (!IS_MAC) {
    bar.querySelector("[data-bc-tb-min]").addEventListener("click", () => host.minimize());
    bar.querySelector("[data-bc-tb-max]").addEventListener("click", () => host.maximizeToggle());
    bar.querySelector("[data-bc-tb-close]").addEventListener("click", () => host.close());
  }
  bar.querySelector("[data-bc-tb-settings]").addEventListener("click", () => host.openSettings());

  return bar;
}

module.exports = { mountTitleBar, TITLE_BAR_ID };
