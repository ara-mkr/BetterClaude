/**
 * Readable button labels on claude.ai's sign-in page.
 *
 * Every theme forces the page's text colour on the signed-out surface
 * (`body.bc-signed-out * { color: var(--bc-text) !important }` in core/tokens.js —
 * needed so Claude's dark utility colours don't land on a dark canvas). Claude's
 * buttons, though, paint their own fill layer. In a theme whose text colour is
 * also its button fill (High Contrast: white text, white primary fill) the
 * "Continue with email" label came out white on white, and on a grey fill a
 * white label could be too faint to read — buttons nobody could see to click.
 *
 * So, on the auth routes only (`body.bc-auth-route`, set by the layout probe),
 * each button's label colour is chosen from its ACTUAL painted fill: whichever
 * of near-black or white contrasts more. An inline `!important` beats the
 * stylesheet's `!important`, and a button with no opaque fill (it sits on the
 * page) is left to the theme's own text colour.
 *
 * DOM-only, so the browser-extension build can reuse it.
 */

const DARK = "#171717";
const LIGHT = "#ffffff";
const MARK = "data-bc-contrast";

function parseColor(css) {
  const m = /rgba?\(([^)]+)\)/.exec(css || "");
  if (!m) return null;
  const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
  if (p.length < 3 || p.some((n, i) => i < 3 && !Number.isFinite(n))) return null;
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 && Number.isFinite(p[3]) ? p[3] : 1 };
}

function luminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a, b) {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The label colour that reads best on `fill` ({r,g,b}): white or near-black. */
function labelColorFor(fill) {
  const l = luminance(fill);
  const white = contrastRatio(luminance({ r: 255, g: 255, b: 255 }), l);
  const dark = contrastRatio(luminance({ r: 23, g: 23, b: 23 }), l);
  return white >= dark ? LIGHT : DARK;
}

/**
 * The opaque colour a button is painted with: the topmost element inside it
 * (or the button itself) that is mostly opaque and covers most of its box.
 */
function paintedFill(button) {
  const box = button.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return null;
  const area = box.width * box.height;
  let fill = null;
  for (const el of [button, ...button.querySelectorAll("*")]) {
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
    let c;
    try { c = parseColor(getComputedStyle(el).backgroundColor); } catch { continue; }
    if (!c || c.a < 0.6) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < area * 0.6) continue;
    fill = c; // later in tree order paints on top
  }
  return fill;
}

function labelNodes(button) {
  return [button, ...button.querySelectorAll("*")].filter((el) => !el.closest("svg"));
}

function fixButton(button) {
  const fill = paintedFill(button);
  const nodes = labelNodes(button);
  if (!fill) {
    // Nothing opaque behind the label: hand it back to the theme.
    if (button.getAttribute(MARK)) {
      button.removeAttribute(MARK);
      for (const el of nodes) { el.style.removeProperty("color"); el.style.removeProperty("-webkit-text-fill-color"); }
    }
    return;
  }
  const want = labelColorFor(fill);
  if (button.getAttribute(MARK) === want) return;
  button.setAttribute(MARK, want);
  for (const el of nodes) {
    el.style.setProperty("color", want, "important");
    el.style.setProperty("-webkit-text-fill-color", want, "important");
  }
}

/** One pass over every button-like control under `root`. */
function fixAuthButtons(root) {
  const scope = root || document;
  for (const button of scope.querySelectorAll("button, a[role='button']")) fixButton(button);
}

/**
 * Keeps the sign-in page's buttons readable while `isActive()` is true (the
 * auth route is showing). One MutationObserver on <body>, coalesced to a frame;
 * a no-op everywhere else. Returns { run, schedule, unmount }.
 */
function mountAuthContrast({ isActive } = {}) {
  const active = typeof isActive === "function" ? isActive : () => !!(document.body && document.body.classList.contains("bc-auth-route"));
  let frame = 0;
  let observer = null;
  let headObserver = null;

  function run() {
    frame = 0;
    if (!document.body || !active()) return;
    fixAuthButtons(document.body);
  }

  function schedule() {
    if (frame || !active()) return;
    frame = requestAnimationFrame(run);
  }

  function attach() {
    if (observer || typeof MutationObserver !== "function" || !document.body) return;
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    // A theme change rewrites <head>'s stylesheet, not anything in <body>: the
    // buttons' fills change underneath labels that were chosen for the old
    // ones. Fills ease over ~200ms, so sample again once they have settled.
    if (document.head) {
      headObserver = new MutationObserver(() => { schedule(); setTimeout(schedule, 450); });
      headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    }
  }

  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach, { once: true });
  schedule();

  return {
    run,
    schedule,
    unmount() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (observer) observer.disconnect();
      if (headObserver) headObserver.disconnect();
      observer = null;
      headObserver = null;
    },
  };
}

module.exports = { mountAuthContrast, fixAuthButtons, labelColorFor, luminance, contrastRatio, parseColor };
