/**
 * Custom title bar. DOM-only aside from the `host` callbacks it is given
 * (minimize/maximizeToggle/close/toggleAlwaysOnTop, and the nav-rail
 * onHome/onCode/onCli), which the Electron preload wires to IPC. A browser
 * extension has no window chrome to replace, so this module simply wouldn't be
 * mounted there.
 *
 * On macOS the window uses `titleBarStyle: "hiddenInset"` (see
 * electron/main.js), so the real system traffic lights are drawn by the OS
 * itself — this bar only reserves space for them (see TRAFFIC_LIGHT_RESERVED_WIDTH
 * below) and no longer hand-draws its own dots there. On Windows/Linux the
 * window is still `frame: false` with no native chrome at all, so the
 * hand-drawn dots (and their minimize/maximizeToggle/close IPC calls) stay.
 *
 * THE NAV RAIL
 *
 * The bar's left side carries the app's ONE navigation control: three small
 * icon-only buttons — Home / Code / CLI — in a fixed position that never moves
 * between modes. Every BetterClaude surface (claude.ai chat, the Code IDE pane,
 * the CLI terminal pane) is a native view composited BELOW this bar, so this
 * one rail stays visible and in the same spot in all three states. It replaces
 * three older, inconsistent controls: the in-page CLI pill that hopped between
 * claude.ai's segmented row / this bar / a floating box (core/code-tab.js), the
 * labelled Home/Code/CLI chip inside the IDE sidebar, and claude.ai's own
 * sidebar mode switch (hidden by ui/title-bar.css now that this covers it).
 *
 * Either way this bar remains mounted: it's the only way back into Settings
 * (the BetterClaude logo button opens the settings panel), which hiddenInset
 * and frame:false both remove the OS's own path to.
 */

const { TRAFFIC_LIGHT_RESERVED_WIDTH } = require("../electron/window-chrome");
const ICONS = require("../core/icons");

const TITLE_BAR_ID = "betterclaude-titlebar";
const IS_MAC = process.platform === "darwin";

// The three surfaces BetterClaude switches between, left-to-right. `mode` is
// the value passed to setNavMode() and the key host looks up for the click
// handler; the icon is a raw <svg> string from the shared set.
const NAV_ITEMS = [
  { mode: "home", icon: ICONS.CHAT, label: "Chat", title: "Claude chat" },
  { mode: "code", icon: ICONS.CODE_SLASH, label: "Code", title: "BetterClaude Code workspace" },
  { mode: "cli", icon: ICONS.TERMINAL, label: "CLI", title: "Claude Code CLI terminal" },
];

// Claude Code activity states that get a coloured status dot (electron/
// claude-activity.js). Anything else clears it.
const STATUS_STATES = new Set(["waiting", "stopped", "done"]);

function mountTitleBar(host) {
  if (document.getElementById(TITLE_BAR_ID)) return null;

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

  // The unified nav rail — three icon-only buttons, always here, always this
  // size and position regardless of which pane is on screen.
  const navHtml = `
    <div class="bc-tb-nav" role="group" aria-label="BetterClaude views">
      ${NAV_ITEMS.map(({ mode, icon, label, title }) => `
        <button class="bc-tb-nav-btn" type="button" data-bc-nav="${mode}" title="${title}" aria-label="${label}" aria-pressed="false">
          <span class="bc-tb-nav-icon" aria-hidden="true">${icon}</span>
        </button>`).join("")}
    </div>`;

  // Nav is centred by a draggable flex spacer on each side (NOT position:
  // absolute + transform — a transformed element's -webkit-app-region rectangle
  // is computed pre-transform, so the OS drag/no-drag hole ends up offset from
  // where the buttons actually paint and the clicks are eaten as window drags).
  bar.innerHTML = `
    ${leftHtml}
    <div class="bc-tb-drag bc-tb-spacer" data-bc-tb-drag></div>
    ${navHtml}
    <div class="bc-tb-drag bc-tb-spacer bc-tb-spacer-right" data-bc-tb-drag></div>
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

  // --- Nav rail wiring ---
  const navHandlers = { home: host.onHome, code: host.onCode, cli: host.onCli };
  const navButtons = Array.from(bar.querySelectorAll(".bc-tb-nav-btn"));
  for (const btn of navButtons) {
    btn.addEventListener("click", () => {
      const fn = navHandlers[btn.dataset.bcNav];
      if (typeof fn === "function") fn();
    });
  }

  let navMode = "home";
  function setNavMode(mode) {
    navMode = mode;
    for (const btn of navButtons) {
      const on = btn.dataset.bcNav === mode;
      btn.classList.toggle("bc-tb-nav-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  setNavMode("home");

  // The CLI pane can be switched off in Settings (codeWindow.tabEnabled) —
  // the tray item, app menu and accelerator keep it reachable, so the button
  // just hides rather than the terminal going away.
  function setCliEnabled(enabled) {
    const cli = navButtons.find((b) => b.dataset.bcNav === "cli");
    if (cli) cli.hidden = enabled === false;
  }

  // A small coloured dot at the top-right of one button, reflecting that
  // surface's Claude Code session: amber = waiting on your approval, red =
  // stopped/errored, green = a turn just finished. Any other state clears it.
  function setStatus(mode, state) {
    const btn = navButtons.find((b) => b.dataset.bcNav === mode);
    if (!btn) return;
    if (STATUS_STATES.has(state)) btn.dataset.navStatus = state;
    else delete btn.dataset.navStatus;
  }

  return { element: bar, setNavMode, getNavMode: () => navMode, setCliEnabled, setStatus };
}

module.exports = { mountTitleBar, TITLE_BAR_ID };
