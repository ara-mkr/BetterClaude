/**
 * Cursor & interaction effects — DOM-only, no Node/Electron APIs. Mirrors the
 * HUD class's mount/applySettings/unmount lifecycle (core/hud.js).
 *
 * Owns: cursor trail particles (sparkles/particles/comet, canvas overlay),
 * click ripple, "magnetic" pull on BetterClaude's OWN buttons (title bar,
 * settings panel, plugin dock — never claude.ai's own controls, so this
 * can't destabilize the real page), and a right-click radial quick-action
 * menu. Cursor SHAPE itself (default/dot/crosshair) is plain CSS and lives
 * in core/extras-css.js — this module only handles effects that need JS.
 */

// BetterClaude's own chrome only — see file header for why claude.ai's own
// buttons are deliberately excluded from the magnetic effect.
const MAGNETIC_TARGETS_SELECTOR =
  '#betterclaude-titlebar button, #betterclaude-settings-panel .bc-btn, ' +
  '#betterclaude-settings-panel .bc-sp-close, #betterclaude-plugin-dock .bc-dock-btn';

const MAGNETIC_RADIUS_PX = 70;
const MAX_PARTICLES = 220;

const ICONS = require("./icons");

const RADIAL_ACTIONS = [
  { id: "settings", label: "Settings", icon: ICONS.SETTINGS_GEAR },
  { id: "shuffle-theme", label: "Shuffle", icon: ICONS.SHUFFLE },
  { id: "zen-mode", label: "Zen", icon: ICONS.ZEN },
  { id: "mute-sound", label: "Mute", icon: ICONS.MUTE },
  { id: "command-palette", label: "Palette", icon: ICONS.COMMAND },
  { id: "surprise-me", label: "Surprise", icon: ICONS.SPARKLE },
];

class InteractionFX {
  constructor({ onRadialAction } = {}) {
    this.onRadialAction = onRadialAction || (() => {});
    this.settings = null;
    this.canvas = null;
    this.ctx = null;
    this.particles = [];
    this.rafId = null;
    this._radialEl = null;
    this._bound = {};
  }

  mount(settings) {
    this.settings = settings;
    this._ensureCanvas();

    this._bound.onMouseMove = (e) => this._onMouseMove(e);
    this._bound.onClick = (e) => this._onClick(e);
    this._bound.onContextMenu = (e) => this._onContextMenu(e);
    this._bound.onResize = () => this._resize();

    document.addEventListener("mousemove", this._bound.onMouseMove, { passive: true });
    document.addEventListener("click", this._bound.onClick, { passive: true });
    document.addEventListener("contextmenu", this._bound.onContextMenu);
    window.addEventListener("resize", this._bound.onResize);

    this._loop();
  }

  applySettings(settings) {
    this.settings = settings;
  }

  unmount() {
    if (this._bound.onMouseMove) document.removeEventListener("mousemove", this._bound.onMouseMove);
    if (this._bound.onClick) document.removeEventListener("click", this._bound.onClick);
    if (this._bound.onContextMenu) document.removeEventListener("contextmenu", this._bound.onContextMenu);
    if (this._bound.onResize) window.removeEventListener("resize", this._bound.onResize);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
      this.ctx = null;
    }
    this.particles = [];
    this._closeRadialMenu();
    this._resetMagnetic();
  }

  _ensureCanvas() {
    if (this.canvas) return;
    const canvas = document.createElement("canvas");
    canvas.id = "bc-fx-canvas";
    document.body.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this._resize();
  }

  _resize() {
    if (!this.canvas || !this.ctx) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _accent() {
    return (this.settings && this.settings.appearance && this.settings.appearance.accentColor) || "#8b5cf6";
  }

  _onMouseMove(e) {
    const cursor = this.settings && this.settings.cursor;
    if (!cursor) return;
    if (cursor.trail && cursor.trail !== "off") this._spawnTrail(e.clientX, e.clientY, cursor);
    if (cursor.magnetic) this._applyMagnetic(e.clientX, e.clientY, cursor);
  }

  _spawnTrail(x, y, cursor) {
    const density = cursor.trailDensity != null ? cursor.trailDensity : 0.5;
    if (Math.random() > density) return;
    const color = this._accent();
    const type = cursor.trail;
    if (type === "sparkles") {
      this.particles.push({
        x, y, vx: (Math.random() - 0.5) * 0.6, vy: -Math.random() * 1.2 - 0.3,
        life: 1, decay: 0.03, size: Math.random() * 2 + 1.5, color, shape: "star",
      });
    } else if (type === "particles") {
      this.particles.push({
        x, y, vx: (Math.random() - 0.5) * 1.4, vy: (Math.random() - 0.5) * 1.4,
        life: 1, decay: 0.025, size: Math.random() * 3 + 2, color, shape: "circle",
      });
    } else if (type === "comet") {
      this.particles.push({ x, y, vx: 0, vy: 0, life: 1, decay: 0.06, size: 6, color, shape: "circle" });
    }
    if (this.particles.length > MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    }
  }

  _onClick(e) {
    const cursor = this.settings && this.settings.cursor;
    if (!cursor || !cursor.ripple) return;
    // Never spawn on native popup-style controls: appending a DOM node
    // (below) mutates the page, and a mutation landing in the same click
    // that opens a <select>'s (or color/date/time/file input's) OS-native
    // popup makes Chromium immediately dismiss that popup — this is exactly
    // what made the Background type dropdown "disappear on click".
    if (e.target && e.target.closest && e.target.closest(
      "select, option, input[type='color'], input[type='date'], input[type='time'], input[type='file']"
    )) return;
    this._spawnRipple(e.clientX, e.clientY);
  }

  _spawnRipple(x, y) {
    const color = this._accent();
    // Deferred a frame as extra insurance: the DOM mutation then lands
    // after the click's own native handling has already settled, not
    // synchronously inside it.
    requestAnimationFrame(() => {
      const el = document.createElement("div");
      el.className = "bc-fx-ripple";
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.borderColor = color;
      document.body.appendChild(el);
      el.addEventListener("animationend", () => el.remove());
    });
  }

  _applyMagnetic(mouseX, mouseY, cursor) {
    const strength = cursor.magneticStrength != null ? cursor.magneticStrength : 0.4;
    const targets = document.querySelectorAll(MAGNETIC_TARGETS_SELECTOR);
    targets.forEach((el) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = mouseX - cx;
      const dy = mouseY - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < MAGNETIC_RADIUS_PX) {
        const pull = (1 - dist / MAGNETIC_RADIUS_PX) * strength;
        el.style.transform = `translate(${(dx * pull).toFixed(1)}px, ${(dy * pull).toFixed(1)}px)`;
      } else if (el.style.transform) {
        el.style.transform = "";
      }
    });
  }

  _resetMagnetic() {
    document.querySelectorAll(MAGNETIC_TARGETS_SELECTOR).forEach((el) => { el.style.transform = ""; });
  }

  _loop() {
    const draw = () => {
      const ctx = this.ctx;
      if (ctx && this.canvas) {
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.particles.forEach((p) => {
          p.x += p.vx;
          p.y += p.vy;
          p.life -= p.decay;
          ctx.globalAlpha = Math.max(0, p.life);
          ctx.fillStyle = p.color;
          ctx.strokeStyle = p.color;
          if (p.shape === "star") this._drawStar(ctx, p.x, p.y, p.size);
          else {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * Math.max(0.2, p.life), 0, Math.PI * 2);
            ctx.fill();
          }
        });
        ctx.globalAlpha = 1;
        this.particles = this.particles.filter((p) => p.life > 0);
      }
      this.rafId = requestAnimationFrame(draw);
    };
    this.rafId = requestAnimationFrame(draw);
  }

  _drawStar(ctx, x, y, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 2);
      ctx.moveTo(0, 0);
      ctx.lineTo(size * 2, 0);
    }
    ctx.stroke();
    ctx.restore();
  }

  _onContextMenu(e) {
    const cursor = this.settings && this.settings.cursor;
    if (!cursor || cursor.radialMenu === false) return;
    // Never hijack the composer/inputs — users need the native menu there
    // for cut/copy/paste. Also skip inside the Settings panel itself: its
    // z-index sits above this menu's (by design — see command palette's
    // comment in ui/overlays.css) so it would only render invisibly behind
    // the panel's backdrop, and every radial action is already one click
    // away in Settings anyway.
    if (e.target && e.target.closest && e.target.closest(
      'textarea, input, [contenteditable="true"], #betterclaude-settings-panel'
    )) return;
    e.preventDefault();
    this._openRadialMenu(e.clientX, e.clientY);
  }

  _openRadialMenu(x, y) {
    this._closeRadialMenu();
    const root = document.createElement("div");
    root.id = "bc-radial-menu";
    const radius = 80;
    // Items sit up to `radius` from center plus half their own 60px width/
    // height (see .bc-radial-item in ui/overlays.css) — clamp the anchor so
    // that full extent always stays inside the viewport. Without this,
    // right-clicking near any window edge (very plausible — it's a general
    // "anywhere on the page" menu, not scoped to one central area) pushed
    // items partly or fully off-screen and unreachable.
    const margin = radius + 30;
    const clampedX = Math.min(Math.max(x, margin), window.innerWidth - margin);
    const clampedY = Math.min(Math.max(y, margin), window.innerHeight - margin);
    root.style.left = `${clampedX}px`;
    root.style.top = `${clampedY}px`;
    RADIAL_ACTIONS.forEach((action, i) => {
      const angle = (i / RADIAL_ACTIONS.length) * Math.PI * 2 - Math.PI / 2;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bc-radial-item";
      btn.style.setProperty("--bc-radial-x", `${Math.round(Math.cos(angle) * radius)}px`);
      btn.style.setProperty("--bc-radial-y", `${Math.round(Math.sin(angle) * radius)}px`);
      btn.innerHTML = `<span class="bc-radial-icon">${action.icon}</span><span class="bc-radial-label">${action.label}</span>`;
      btn.addEventListener("click", () => {
        this.onRadialAction(action.id);
        this._closeRadialMenu();
      });
      root.appendChild(btn);
    });
    document.body.appendChild(root);
    this._radialEl = root;

    this._radialOutside = (ev) => { if (!root.contains(ev.target)) this._closeRadialMenu(); };
    this._radialEsc = (ev) => { if (ev.key === "Escape") this._closeRadialMenu(); };
    setTimeout(() => {
      document.addEventListener("pointerdown", this._radialOutside, true);
      document.addEventListener("keydown", this._radialEsc, true);
    }, 0);
  }

  _closeRadialMenu() {
    if (this._radialEl) {
      this._radialEl.remove();
      this._radialEl = null;
    }
    if (this._radialOutside) document.removeEventListener("pointerdown", this._radialOutside, true);
    if (this._radialEsc) document.removeEventListener("keydown", this._radialEsc, true);
  }
}

module.exports = { InteractionFX, RADIAL_ACTIONS, MAGNETIC_TARGETS_SELECTOR };
