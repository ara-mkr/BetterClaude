/**
 * "While you wait" Snake for BetterClaude's Code surfaces.
 *
 * The main claude.ai window has had this since the feature shipped (see
 * electron/preload.js): whenever Claude is generating, a small dismissable
 * board floats in the corner, and it vanishes on its own when the answer
 * lands. This is the same idea for the two windows where waiting also
 * happens — the IDE workspace (its Claude chat panel) and the embedded CLI
 * pane — because until now none of the playful settings applied to Code at
 * all.
 *
 * Runs in the PAGE world of either window (bundled into
 * build/snake.bundle.js as window.BetterClaudeSnake), so it has DOM only:
 * settings come in through a `readConfig()` callback the host keeps fresh,
 * and the actual game is ui/mini-game/snake.js mounted with
 * keyScope "element" — identical to the main-window popup, for the same
 * reason: WASD must never swallow typing that belongs to the composer or
 * terminal underneath.
 */

const PANEL_ID = "bc-waiting-snake";

// Self-contained styles rather than a shared sheet: this file loads in two
// different documents whose own stylesheets are unrelated, and the popup is
// small enough that duplicating overlays.css would be worse than owning its
// rules outright. Scoped under #bc-waiting-snake so nothing leaks.
const STYLES = `
#${PANEL_ID} {
  position: fixed; right: 14px; bottom: 44px; z-index: 2147483600;
  display: none; flex-direction: column; gap: 8px;
  min-width: 240px; padding: 10px 12px 12px;
  border: 1px solid var(--bc-border, #3a2e5c); border-radius: 12px;
  background: var(--bc-bg-elevated, #1c1630);
  color: var(--bc-text, #ece7fb);
  box-shadow: 0 12px 32px rgba(0,0,0,.4);
  font-family: var(--bc-ui-font, -apple-system, sans-serif);
}
#${PANEL_ID}.bc-open { display: flex; animation: bc-ws-pop 200ms ease; }
@keyframes bc-ws-pop { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
#${PANEL_ID} .bc-ws-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
#${PANEL_ID} .bc-ws-title { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--bc-text-muted, #a99bd1); }
#${PANEL_ID} .bc-ws-close { display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 6px; color: var(--bc-text-muted, #a99bd1); background: transparent; cursor: pointer; font-size: 11px; line-height: 1; }
#${PANEL_ID} .bc-ws-close:hover { color: var(--bc-text, #ece7fb); background: var(--bc-border, #3a2e5c); }
#${PANEL_ID} .bc-snake-score { font: 13px var(--bc-ui-font, -apple-system, sans-serif); color: var(--bc-text, #ece7fb); }
#${PANEL_ID} .bc-snake-canvas { border-radius: 8px; border: 1px solid var(--bc-border, #3a2e5c); }
#${PANEL_ID} .bc-snake-hint { font: 11px var(--bc-ui-font, -apple-system, sans-serif); color: var(--bc-text-muted, #a99bd1); max-width: 230px; }
`;

/**
 * @param {object} opts
 * @param {Function} opts.readConfig  Returns the current knobs, re-read on
 *   every edge so a settings change applies without reopening anything:
 *   { masterEnabled, snakeWhileWaiting, snakeDelayMs }.
 * @param {Function} [opts.mountGame] Game factory; defaults to the shared
 *   bundle global. Injectable for tests.
 * @returns {{ setWorking(next:boolean): void }}
 */
function createWaitingSnake({ readConfig, mountGame } = {}) {
  const mount = mountGame || ((container, options) => window.BetterClaudeSnake.mountSnakeGame(container, options));

  let panel = null;
  let game = null;
  let working = false;
  let dismissedThisRun = false;
  let showAt = Infinity;
  let pollTimer = null;

  function openPanel() {
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      panel.innerHTML = `
        <div class="bc-ws-head">
          <span class="bc-ws-title">While you wait…</span>
          <button class="bc-ws-close" type="button" aria-label="Dismiss the game">✕</button>
        </div>
        <div data-bc-ws-container></div>`;
      document.body.appendChild(panel);
      // Dismissing covers THIS wait only — the next working edge clears it,
      // which is what makes the popup self-returning like the main window's.
      panel.querySelector(".bc-ws-close").addEventListener("click", () => {
        dismissedThisRun = true;
        closePanel();
      });
    }
    const container = panel.querySelector("[data-bc-ws-container]");
    if (!game) game = mount(container, { keyScope: "element" });
    panel.classList.add("bc-open");
  }

  function closePanel() {
    if (!panel) return;
    panel.classList.remove("bc-open");
    if (game) {
      game.destroy();
      game = null;
    }
  }

  function tick() {
    if (!working) return;
    const config = readConfig ? readConfig() : {};
    if (config.masterEnabled === false || config.snakeWhileWaiting === false) return;
    if (dismissedThisRun || Date.now() < showAt) return;
    openPanel();
  }

  function setWorking(next) {
    const was = working;
    working = !!next;
    if (working && !was) {
      // New wait: previous dismissals do not carry over, and the configured
      // delay keeps quick answers from flashing a board up and down.
      dismissedThisRun = false;
      const config = readConfig ? readConfig() : {};
      const delay = Number(config.snakeDelayMs);
      showAt = Date.now() + (Number.isFinite(delay) && delay >= 0 ? delay : 2000);
      if (!pollTimer) pollTimer = setInterval(tick, 300);
    }
    if (!working) {
      closePanel(); // the answer landed — the board goes away on its own
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
  }

  return { setWorking };
}

module.exports = { createWaitingSnake };
