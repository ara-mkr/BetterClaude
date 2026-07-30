/**
 * Page-world driver for the embedded Claude Code terminal.
 *
 * Runs in the renderer's own realm (a plain <script> in
 * electron/code-window.html), NOT in the preload realm — so it has no
 * require(), no ipcRenderer, and no Node at all. Its entire connection to the
 * `claude` subprocess is `window.betterClaudeCode`, the contextBridge surface
 * exposed by electron/code-preload.js.
 *
 * Compliance: this file forwards keystrokes and paints bytes. It never inspects
 * or pattern-matches terminal output to trigger anything, and the only thing it
 * ever writes to the child is what xterm's onData hands it — the user's own
 * input, verbatim.
 */

(async function () {
  "use strict";

  const { Terminal, FitAddon } = window.BetterClaudeXterm;
  const api = window.betterClaudeCode;

  // Settings come over IPC, so they aren't available at parse time. Awaited
  // here (rather than read from a preloaded property) because the preload
  // exposes this bridge synchronously — see the comment on the
  // exposeInMainWorld call in electron/code-preload.js.
  const initialSettings = await api.getSettings();

  const shell = document.getElementById("bc-code-shell");
  const host = document.getElementById("bc-code-term");
  const cwdLabel = document.getElementById("bc-code-cwd");
  const folderBtn = document.getElementById("bc-code-folder-btn");
  const overlay = document.getElementById("bc-code-overlay");
  const overlayMsg = overlay.querySelector(".bc-code-overlay-msg");
  const overlayActions = overlay.querySelector(".bc-code-overlay-actions");

  /**
   * Fixed ANSI 16 for the terminal's own palette, in dark and light variants.
   *
   * A BetterClaude theme defines nine --bc-* colours (see THEME_VAR_DEFS in
   * core/theme-engine.js) — background, elevated, sidebar, text, muted, border,
   * two bubbles, danger. That is a chat palette, not a terminal one: there is
   * no theme-supplied "cyan" to map ANSI 6 onto. Deriving sixteen hues from
   * nine chat colours would invent colour the theme author never chose and,
   * worse, could easily land unreadable (a theme whose only saturated colour is
   * a pale accent would produce a nearly invisible green).
   *
   * So the ANSI 16 stay fixed and legible, while everything the theme genuinely
   * DOES define — background, foreground, cursor, selection, and the red slot,
   * which maps cleanly onto --bc-danger — is taken live from the theme below.
   * That is what makes a theme switch visibly restyle this window without
   * risking output nobody can read. Flagged in the report as a judgment call.
   */
  const ANSI_DARK = {
    black: "#3b3b47", red: "#f4787a", green: "#8ee08a", yellow: "#e8cf7d",
    blue: "#82a9f7", magenta: "#c79df0", cyan: "#7fd6d1", white: "#d9d5e6",
    brightBlack: "#6b6880", brightRed: "#ff9b9d", brightGreen: "#a9f0a5",
    brightYellow: "#f5e39b", brightBlue: "#a3c2ff", brightMagenta: "#dcbcff",
    brightCyan: "#a2e8e4", brightWhite: "#f6f4ff",
  };

  const ANSI_LIGHT = {
    black: "#2f2f38", red: "#c0392b", green: "#217a3d", yellow: "#8a6a12",
    blue: "#2b5fb8", magenta: "#7d3fa8", cyan: "#1f7a75", white: "#5c5a68",
    brightBlack: "#87859a", brightRed: "#e05548", brightGreen: "#2f9c52",
    brightYellow: "#a9821c", brightBlue: "#3d78d8", brightMagenta: "#9a55c9",
    brightCyan: "#2a9a94", brightWhite: "#1a1a20",
  };

  function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  /**
   * Perceived lightness of a colour, used only to decide which fixed ANSI set
   * reads better against the theme's background. Handles the #rgb/#rrggbb and
   * rgb()/rgba() forms themes actually ship; anything else is treated as dark,
   * which matches the app's own default palette.
   */
  function isLight(color) {
    let r, g, b;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color || "");
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
      const n = parseInt(h, 16);
      r = (n >> 16) & 0xff; g = (n >> 8) & 0xff; b = n & 0xff;
    } else {
      const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color || "");
      if (!rgb) return false;
      r = Number(rgb[1]); g = Number(rgb[2]); b = Number(rgb[3]);
    }
    // Rec. 601 luma, the same cheap approximation core/theme-engine.js uses to
    // decide dark vs light for a theme's background.
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 >= 0.5;
  }

  /** Builds an xterm ITheme from whatever the active BetterClaude theme is. */
  function themeFromCSSVars() {
    const bg = cssVar("--bc-bg", "#14101f");
    const fg = cssVar("--bc-text", "#ece7fb");
    const accent = cssVar("--bc-accent", "#6059e6");
    const danger = cssVar("--bc-danger", "#ef4444");
    const ansi = isLight(bg) ? ANSI_LIGHT : ANSI_DARK;

    return Object.assign({}, ansi, {
      background: bg,
      foreground: fg,
      cursor: accent,
      // The glyph drawn UNDER the block cursor: the background, so a cursor
      // sitting on a character stays readable instead of accent-on-accent.
      cursorAccent: bg,
      // xterm accepts 8-digit hex for selection, and a translucent accent is
      // what keeps selected text legible rather than blocking it out.
      selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}59` : "rgba(96,89,230,0.35)",
      red: danger,
      brightRed: danger,
    });
  }

  const term = new Terminal({
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    // scrollback of 5000 lines: enough to page back through a long build or
    // test run, without holding an unbounded buffer for a session left open.
    scrollback: 5000,
    fontFamily: cssVar("--bc-code-font", "SFMono-Regular, Menlo, Consolas, monospace"),
    fontSize: Number((initialSettings.codeWindow || {}).fontSizePx) || 13,
    theme: themeFromCSSVars(),
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(host);

  // --- Input: the user's own keystrokes, forwarded verbatim ---
  term.onData((data) => api.write(data));

  // --- Output: bytes from the child, painted and nothing else ---
  api.onData((chunk) => term.write(chunk));

  // --- Size: xterm and the pty must always agree ---
  let lastSize = { cols: 0, rows: 0 };

  function syncSize() {
    // proposeDimensions() returns undefined while the host has no layout yet
    // (window still hidden, or the element measured 0x0), and fit() would then
    // resize the terminal to NaN columns.
    const proposed = fitAddon.proposeDimensions();
    if (!proposed || !proposed.cols || !proposed.rows) return null;
    fitAddon.fit();
    const size = { cols: term.cols, rows: term.rows };
    // Only tell the child when the size actually changed. A resize is a SIGWINCH
    // to the CLI, which makes it redraw; firing one per resize *event* makes a
    // window drag flicker.
    if (size.cols !== lastSize.cols || size.rows !== lastSize.rows) {
      lastSize = size;
      api.resize(size.cols, size.rows);
    }
    return size;
  }

  // ResizeObserver rather than window.onresize: it also catches the layout
  // change when the settings panel opens/closes and when the status strip
  // reflows, neither of which fires a window resize event.
  const observer = new ResizeObserver(() => syncSize());
  observer.observe(host);

  // --- Session state / overlay ---
  function setState(state) {
    shell.dataset.state = state;
  }

  function hideOverlay() {
    overlay.dataset.visible = "false";
    overlayMsg.textContent = "";
    overlayActions.textContent = "";
  }

  function showOverlay(message, actions) {
    overlayMsg.textContent = message;
    overlayActions.textContent = "";
    (actions || []).forEach(({ label, primary, onClick }) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      if (primary) btn.className = "bc-code-primary";
      btn.addEventListener("click", onClick);
      overlayActions.appendChild(btn);
    });
    overlay.dataset.visible = "true";
  }

  function restart() {
    hideOverlay();
    term.reset();
    setState("starting");
    const size = syncSize() || lastSize;
    api.restart(size.cols || 100, size.rows || 30);
  }

  api.onStarted(({ cwd }) => {
    setState("running");
    cwdLabel.textContent = cwd;
    cwdLabel.title = cwd;
    hideOverlay();
    term.focus();
  });

  api.onExit(({ exitCode, signal }) => {
    setState("exited");
    const how = signal ? `signal ${signal}` : `exit code ${exitCode}`;
    showOverlay(`Claude Code ended (${how}).`, [
      { label: "Start a new session", primary: true, onClick: restart },
      { label: "Close window", onClick: () => api.closeWindow() },
    ]);
  });

  // A launch that never got off the ground: no `claude` on PATH, or the pty
  // backend failed to start. The real error text is shown as-is — a vague
  // "something went wrong" would leave the user with nothing to act on.
  api.onFatal(({ message }) => {
    setState("failed");
    showOverlay(message, [
      { label: "Try again", primary: true, onClick: restart },
      { label: "Close window", onClick: () => api.closeWindow() },
    ]);
  });

  api.onRestarting(({ cwd }) => {
    term.reset();
    setState("starting");
    cwdLabel.textContent = cwd;
    cwdLabel.title = cwd;
    hideOverlay();
  });

  // Live theme + font updates. The pty is untouched by any of this: the child
  // never learns the colours changed, so a theme switch cannot interrupt a
  // running session (acceptance criterion 6).
  api.onSettingsChanged((settings) => {
    term.options.theme = themeFromCSSVars();
    const fontFamily = cssVar("--bc-code-font", "SFMono-Regular, Menlo, Consolas, monospace");
    const fontSize = Number((settings.codeWindow || {}).fontSizePx) || 13;
    if (term.options.fontFamily !== fontFamily) term.options.fontFamily = fontFamily;
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
    // Font metrics change the cell size, which changes how many cols/rows fit.
    syncSize();
  });

  folderBtn.addEventListener("click", () => api.pickFolder());

  // Clicking anywhere in the terminal area should put focus back in the CLI —
  // after using the settings panel, the natural next action is to keep typing.
  host.addEventListener("mousedown", (e) => {
    // Don't steal focus from the overlay's own buttons.
    if (overlay.dataset.visible === "true") return;
    if (e.button === 0) term.focus();
  });

  // First paint: report the measured size so the main process can spawn the pty
  // at the right dimensions rather than at a guess it has to correct.
  requestAnimationFrame(() => {
    const size = syncSize() || { cols: 100, rows: 30 };
    lastSize = size;
    setState("starting");
    api.ready(size.cols, size.rows);
    term.focus();
  });
})();
