/**
 * Usage HUD — DOM-only, no Node/Electron APIs.
 * Builds a draggable, corner-snapping overlay showing live token usage.
 *
 * Live-update strategy: the host (electron/preload or a future extension
 * content script) is responsible for calling `hud.update(usage)` whenever
 * it detects new content, typically via a MutationObserver watching the
 * chat container plus a short polling interval as a fallback while
 * streaming (DOM mutations during streaming can be very rapid/batched).
 * See core/token-counter.js for why this is DOM-scraping based.
 */

const HUD_ROOT_ID = "betterclaude-hud";

const CORNER_MARGIN = 16;

function formatResetTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `resets ${time} today`;
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (d.toDateString() === tomorrow.toDateString()) return `resets ${time} tomorrow`;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `resets ${date}, ${time}`;
}

// Single source of truth for keeping the HUD's whole footprint (not just
// its top-left origin) within the viewport, accounting for its own
// width/height. Used by both applyPosition (mount/settings-apply/resize)
// and _onDragMove (live drag) so their bounds math can't drift apart.
function clampToViewport(x, y, size) {
  const maxX = Math.max(CORNER_MARGIN, window.innerWidth - size.width - CORNER_MARGIN);
  const maxY = Math.max(CORNER_MARGIN, window.innerHeight - size.height - CORNER_MARGIN);
  return {
    x: Math.min(Math.max(x, CORNER_MARGIN), maxX),
    y: Math.min(Math.max(y, CORNER_MARGIN), maxY),
  };
}

function cornerToPosition(corner, size) {
  const { innerWidth: w, innerHeight: h } = window;
  const positions = {
    "top-left": { x: CORNER_MARGIN, y: CORNER_MARGIN },
    "top-right": { x: w - size.width - CORNER_MARGIN, y: CORNER_MARGIN },
    "bottom-left": { x: CORNER_MARGIN, y: h - size.height - CORNER_MARGIN },
    "bottom-right": { x: w - size.width - CORNER_MARGIN, y: h - size.height - CORNER_MARGIN },
  };
  return positions[corner] || positions["bottom-right"];
}

class HUD {
  constructor({ onPositionChange, onDismiss } = {}) {
    this.onPositionChange = onPositionChange || (() => {});
    this.onDismiss = onDismiss || (() => {});
    this.el = null;
    this.dragState = null;
  }

  mount(settings) {
    if (this.el) return this.el;

    const root = document.createElement("div");
    root.id = HUD_ROOT_ID;
    root.innerHTML = `
      <button class="bc-hud-close" data-bc-hud-close title="Hide usage HUD (Settings -> Usage HUD to bring back)">&#10005;</button>
      <div class="bc-hud-drag" data-bc-drag>
        <span class="bc-hud-title">Usage (est.)</span>
      </div>
      <div class="bc-hud-row">
        <span class="bc-hud-pct" data-bc-pct>0.0%</span>
      </div>
      <div class="bc-hud-row bc-hud-sub">
        <span data-bc-used>0</span> used &middot; <span data-bc-remaining>0</span> left
      </div>
      <div class="bc-hud-row bc-hud-sub">
        last msg: <span data-bc-last>0</span> tok
      </div>
      <div class="bc-hud-bar"><div class="bc-hud-bar-fill" data-bc-bar></div></div>
      <div class="bc-hud-account" data-bc-account>
        <div class="bc-hud-divider"></div>
        <div class="bc-hud-row bc-hud-account-row">
          <span class="bc-hud-account-label">Session</span>
          <span data-bc-session-pct>&mdash;</span>
        </div>
        <div class="bc-hud-bar"><div class="bc-hud-bar-fill" data-bc-session-bar></div></div>
        <div class="bc-hud-row bc-hud-sub" data-bc-session-reset></div>
        <div class="bc-hud-row bc-hud-account-row">
          <span class="bc-hud-account-label">Weekly</span>
          <span data-bc-weekly-pct>&mdash;</span>
        </div>
        <div class="bc-hud-bar"><div class="bc-hud-bar-fill" data-bc-weekly-bar></div></div>
        <div class="bc-hud-row bc-hud-sub" data-bc-weekly-reset></div>
      </div>
    `;
    document.body.appendChild(root);
    this.el = root;

    root.querySelector("[data-bc-hud-close]").addEventListener("click", (e) => {
      e.stopPropagation();
      this.setVisible(false);
      this.onDismiss();
    });

    this.applyVisualSettings(settings.hud);
    this.applyPosition(settings.hud);
    this._wireDrag(settings);

    return root;
  }

  unmount() {
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }

  setVisible(visible) {
    if (this.el) this.el.style.display = visible ? "flex" : "none";
  }

  applyVisualSettings(hudSettings) {
    if (!this.el) return;
    this.el.style.opacity = String(hudSettings.opacity ?? 0.92);
    this.el.style.transform = `scale(${hudSettings.scale ?? 1})`;
    this.el.style.display = hudSettings.enabled ? "flex" : "none";
    const account = this.el.querySelector("[data-bc-account]");
    if (account) account.style.display = hudSettings.showAccountUsage === false ? "none" : "block";
  }

  applyPosition(hudSettings) {
    if (!this.el) return;
    const size = { width: this.el.offsetWidth || 180, height: this.el.offsetHeight || 110 };
    const pos = (hudSettings.x != null && hudSettings.y != null)
      ? { x: hudSettings.x, y: hudSettings.y }
      : cornerToPosition(hudSettings.corner, size);
    // A saved drag position (hudSettings.x/y) can predate content that
    // changes the HUD's height (e.g. the account-usage rows toggling on/off),
    // so re-clamp on every apply rather than only at drag time — otherwise a
    // previously-valid position can push newly added rows off-screen.
    const clamped = clampToViewport(pos.x, pos.y, size);
    this.el.style.left = `${clamped.x}px`;
    this.el.style.top = `${clamped.y}px`;
  }

  update(usage) {
    if (!this.el) return;
    const pct = this.el.querySelector("[data-bc-pct]");
    const used = this.el.querySelector("[data-bc-used]");
    const remaining = this.el.querySelector("[data-bc-remaining]");
    const last = this.el.querySelector("[data-bc-last]");
    const bar = this.el.querySelector("[data-bc-bar]");

    pct.textContent = `${usage.percentUsed.toFixed(2)}%`;
    used.textContent = usage.usedTokens.toLocaleString();
    remaining.textContent = usage.remainingTokens.toLocaleString();
    last.textContent = usage.lastMessageTokens.toLocaleString();
    bar.style.width = `${Math.min(100, usage.percentUsed)}%`;

    if (usage.percentUsed >= 90) bar.dataset.bcLevel = "critical";
    else if (usage.percentUsed >= 70) bar.dataset.bcLevel = "warning";
    else bar.dataset.bcLevel = "ok";
  }

  /** Real plan-level usage from core/account-usage.js — { session, weekly },
   *  either of which may be null if the account/plan doesn't expose it. */
  updateAccountUsage(usage) {
    if (!this.el || !usage) return;
    this._updateAccountLimit("session", usage.session);
    this._updateAccountLimit("weekly", usage.weekly);
  }

  _updateAccountLimit(prefix, limit) {
    const pctEl = this.el.querySelector(`[data-bc-${prefix}-pct]`);
    const barEl = this.el.querySelector(`[data-bc-${prefix}-bar]`);
    const resetEl = this.el.querySelector(`[data-bc-${prefix}-reset]`);
    if (!limit) {
      pctEl.textContent = "—";
      barEl.style.width = "0%";
      resetEl.textContent = "";
      return;
    }
    pctEl.textContent = `${limit.percent.toFixed(2)}%`;
    barEl.style.width = `${Math.min(100, limit.percent)}%`;
    resetEl.textContent = formatResetTime(limit.resetsAt);
    if (limit.percent >= 90) barEl.dataset.bcLevel = "critical";
    else if (limit.percent >= 70) barEl.dataset.bcLevel = "warning";
    else barEl.dataset.bcLevel = "ok";
  }

  _wireDrag(settings) {
    const handle = this.el.querySelector("[data-bc-drag]");
    handle.addEventListener("mousedown", (e) => {
      const rect = this.el.getBoundingClientRect();
      this.dragState = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
      document.addEventListener("mousemove", this._onDragMove);
      document.addEventListener("mouseup", this._onDragEnd);
    });

    this._onDragMove = (e) => {
      if (!this.dragState) return;
      const rawX = e.clientX - this.dragState.offsetX;
      const rawY = e.clientY - this.dragState.offsetY;
      const size = { width: this.el.offsetWidth || 180, height: this.el.offsetHeight || 110 };
      const { x, y } = clampToViewport(rawX, rawY, size);
      this.el.style.left = `${x}px`;
      this.el.style.top = `${y}px`;
    };

    this._onDragEnd = () => {
      if (!this.dragState) return;
      this.dragState = null;
      document.removeEventListener("mousemove", this._onDragMove);
      document.removeEventListener("mouseup", this._onDragEnd);
      const rect = this.el.getBoundingClientRect();
      this.onPositionChange({ x: Math.round(rect.left), y: Math.round(rect.top) });
    };
  }
}

module.exports = { HUD, HUD_ROOT_ID };
