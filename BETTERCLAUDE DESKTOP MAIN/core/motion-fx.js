/**
 * Motion extras — DOM-only, no Node/Electron APIs (except LOADING_TIPS/
 * pickLoadingTip below, which are plain data/pure functions safe to require
 * from electron/main.js's Node context too, since main.js has no DOM and
 * never calls the canvas-based functions in this file).
 *
 * Owns: celebrate() confetti bursts (achievements/streak milestones),
 * mountParallax() (a subtle drift on BetterClaude's OWN overlays only —
 * never claude.ai's real page, which isn't ours to relayout), and
 * mountSeasonalDecoration() (opt-in snow/leaves, tied to calendar month).
 * Global animation speed/easing/transition-style CSS lives in
 * core/extras-css.js since that's pure CSS, not JS-driven motion.
 */

const { seasonForMonth } = require("./vibe-bundles");

const LOADING_TIPS = {
  real: [
    "Tip: Cmd/Ctrl+, opens BetterClaude Settings any time.",
    "Tip: Cmd/Ctrl+K opens the Command Palette.",
    "Tip: Right-click anywhere for a quick-action radial menu.",
    "Tip: Settings -> Widgets has a Pomodoro timer, sticky notes and more.",
    "Tip: The Shuffle button in Settings -> Themes picks a new cohesive look in one click.",
    "Tip: Type the Konami code (↑↑↓↓←→←→BA) for a surprise.",
  ],
  joke: [
    "Compiling excuses for why the sidebar moved…",
    "Reticulating splines. (There are no splines.)",
    "Feeding the mascot a byte of encouragement.",
    "Asking Claude nicely to hurry up.",
    "Polishing pixels that were already clean.",
    "Negotiating with the CSS cascade.",
  ],
};

// customTips: { real: string[], joke: string[] } — user-editable additions
// from Settings -> Playful, merged with the built-in pool rather than
// replacing it.
function pickLoadingTip(customTips) {
  const pool = [
    ...LOADING_TIPS.real,
    ...LOADING_TIPS.joke,
    ...((customTips && customTips.real) || []),
    ...((customTips && customTips.joke) || []),
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

function resizeCanvasToViewport(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// One-shot confetti burst — auto-cleans up its own canvas when done.
function celebrate({
  particleCount = 140,
  colors = ["#8b5cf6", "#f5c518", "#22c55e", "#ef4444", "#38bdf8"],
  durationMs = 2600,
} = {}) {
  if (typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  canvas.id = "bc-confetti-canvas";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  resizeCanvasToViewport(canvas, ctx);

  const particles = Array.from({ length: particleCount }, () => ({
    x: Math.random() * window.innerWidth,
    y: -20 - Math.random() * 200,
    vx: (Math.random() - 0.5) * 2,
    vy: Math.random() * 2 + 2,
    rot: Math.random() * 360,
    vr: (Math.random() - 0.5) * 10,
    size: Math.random() * 6 + 4,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));

  const start = performance.now();
  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.02;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot * Math.PI) / 180);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - elapsed / durationMs);
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    });
    if (elapsed < durationMs) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}

// Subtle vertical drift on a caller-supplied set of BetterClaude's own
// overlay elements, driven by scroll position of the main conversation pane.
// Returns an unmount function. `getTargets()` is called on every scroll tick
// so callers can mount this before their own elements exist yet.
function mountParallax(getTargets) {
  if (typeof document === "undefined") return () => {};
  let raf = null;
  const scrollEl = document.querySelector('main, [data-testid="conversation"]') || document.scrollingElement;
  const target = scrollEl || window;

  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const y = scrollEl ? scrollEl.scrollTop : window.scrollY || 0;
      const offset = Math.max(-8, Math.min(8, y * 0.02));
      (getTargets ? getTargets() : []).forEach((el) => {
        if (el) el.style.setProperty("--bc-parallax-y", `${offset.toFixed(1)}px`);
      });
    });
  };

  target.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    target.removeEventListener("scroll", onScroll);
    if (raf) cancelAnimationFrame(raf);
  };
}

const LEAF_COLORS = ["#d97706", "#b45309", "#a16207"];

function spawnSeasonalParticle(season, allowMidScreen) {
  return {
    x: Math.random() * window.innerWidth,
    y: allowMidScreen ? Math.random() * window.innerHeight : -10 - Math.random() * 40,
    vy: season === "winter" ? Math.random() * 0.6 + 0.3 : Math.random() * 0.8 + 0.5,
    vx: (Math.random() - 0.5) * 0.5,
    size: season === "winter" ? Math.random() * 3 + 2 : Math.random() * 5 + 4,
    rot: Math.random() * 360,
    vr: (Math.random() - 0.5) * 2,
    color: LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)],
  };
}

// Continuous, subtle, opt-in background decoration — only for the two
// seasons that read as an unambiguous "decoration" (snow/leaves) rather than
// forcing a spring/summer motif nobody asked for. Returns an unmount fn.
function mountSeasonalDecoration(monthIndex) {
  if (typeof document === "undefined") return () => {};
  const season = seasonForMonth(monthIndex);
  if (season !== "winter" && season !== "autumn") return () => {};

  const canvas = document.createElement("canvas");
  canvas.id = "bc-seasonal-canvas";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  resizeCanvasToViewport(canvas, ctx);
  const onResize = () => resizeCanvasToViewport(canvas, ctx);
  window.addEventListener("resize", onResize);

  const particles = Array.from({ length: 36 }, () => spawnSeasonalParticle(season, true));
  let rafId = null;

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach((p, i) => {
      p.y += p.vy;
      p.x += p.vx + Math.sin(p.y * 0.01) * 0.3;
      p.rot += p.vr;
      if (p.y > window.innerHeight + 10) particles[i] = spawnSeasonalParticle(season, false);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot * Math.PI) / 180);
      ctx.globalAlpha = 0.75;
      if (season === "winter") {
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(0, 0, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size, p.size * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  return () => {
    if (rafId) cancelAnimationFrame(rafId);
    window.removeEventListener("resize", onResize);
    canvas.remove();
  };
}

module.exports = {
  LOADING_TIPS,
  pickLoadingTip,
  celebrate,
  mountParallax,
  mountSeasonalDecoration,
};
