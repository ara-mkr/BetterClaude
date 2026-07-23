/**
 * Custom frameless title bar. DOM-only aside from the `host` callbacks it
 * is given (minimize/maximizeToggle/close/toggleAlwaysOnTop), which the
 * Electron preload wires to IPC. A browser extension has no window chrome
 * to replace, so this module simply wouldn't be mounted there.
 *
 * Styled to read as a native macOS title bar: traffic-light controls at
 * the left, a centered title, and BetterClaude's own actions (settings,
 * always-on-top) tucked on the right instead of mixed in with window
 * controls.
 */

const TITLE_BAR_ID = "betterclaude-titlebar";

function mountTitleBar(host) {
  if (document.getElementById(TITLE_BAR_ID)) return;

  const bar = document.createElement("div");
  bar.id = TITLE_BAR_ID;
  bar.innerHTML = `
    <div class="bc-tb-traffic" data-bc-tb-drag>
      <button class="bc-tb-dot bc-tb-dot-close" data-bc-tb-close title="Close"></button>
      <button class="bc-tb-dot bc-tb-dot-min" data-bc-tb-min title="Minimize"></button>
      <button class="bc-tb-dot bc-tb-dot-max" data-bc-tb-max title="Maximize"></button>
    </div>
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

  bar.querySelector("[data-bc-tb-min]").addEventListener("click", () => host.minimize());
  bar.querySelector("[data-bc-tb-max]").addEventListener("click", () => host.maximizeToggle());
  bar.querySelector("[data-bc-tb-close]").addEventListener("click", () => host.close());
  bar.querySelector("[data-bc-tb-settings]").addEventListener("click", () => host.openSettings());

  return bar;
}

module.exports = { mountTitleBar, TITLE_BAR_ID };
