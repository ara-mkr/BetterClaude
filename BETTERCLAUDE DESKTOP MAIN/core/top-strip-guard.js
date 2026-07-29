/**
 * Reserved-strip collision guard.
 *
 * BetterClaude paints an opaque custom title bar across the top of the
 * window (ui/title-bar.css) and compensates by insetting claude.ai's page
 * out of that band. That compensation is the single most fragile assumption
 * in the whole injection layer, because it depends on where Anthropic
 * chooses to anchor Claude's own chrome — something they change without
 * notice and we cannot version against.
 *
 * It has already failed once in exactly the way this module is designed to
 * catch: `body { padding-top }` clears in-flow content but cannot move a
 * `position: fixed` element (fixed boxes resolve against the viewport, whose
 * origin is underneath our bar). When Claude's top-level tab bar moved into
 * that strip, the Code tab rendered under the bar and became unclickable —
 * silently, with no error anywhere, presenting as "BetterClaude broke Code".
 *
 * The structural fix for that specific failure is the containing-block
 * transform on the app root (see ui/title-bar.css). This module is the
 * seatbelt for the *next* one: it assumes no particular Claude DOM shape, it
 * just asks the browser a direct question — "if the user clicked here, in
 * the band we cover, what would they have hit?" — and reports any answer
 * that isn't ours. A future regression of this class then announces itself
 * by name instead of arriving as a mystery bug report.
 *
 * Deliberately warn-only. It never moves, hides, or restyles Claude's DOM: a
 * diagnostic that silently rearranges the page would just become the next
 * layer of undocumented compensation to debug through.
 *
 * DOM-only and dependency-free, so it works unchanged in the browser
 * extension build — though there it is inert by construction, since that
 * build mounts no title bar and so reserves a strip of height 0.
 */

// Every id BetterClaude mounts its own body-level chrome under starts with
// one of these, and every class we add starts with `bc-`. Anything else in
// the strip is, by elimination, claude.ai's.
const OWN_ID_PREFIXES = ["betterclaude-", "bc-"];

/**
 * True if `el` is BetterClaude's own chrome (or lives inside it).
 *
 * The walk deliberately stops before <body> and <html>: we set marker
 * classes on body itself (`bc-signed-out`), so a walk that reached it would
 * classify every element on the page as ours and the guard would report
 * nothing, forever — a silent false negative in the one component whose
 * entire job is to not be silent.
 */
function isOwnChrome(el) {
  const stopAt = [document.body, document.documentElement];
  for (let n = el; n && n.nodeType === 1 && !stopAt.includes(n); n = n.parentElement) {
    const id = n.id || "";
    if (OWN_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) return true;
    // classList rather than className: claude.ai renders SVG elements, whose
    // .className is an SVGAnimatedString, not a string — calling string
    // methods on it throws and would take the guard down with it.
    const classes = n.classList;
    if (classes && Array.prototype.some.call(classes, (c) => c.startsWith("bc-"))) return true;
  }
  return false;
}

/** Human-readable identity for a page element, for the warning text. */
function describeElement(el) {
  if (!el || el.nodeType !== 1) return "<unknown>";
  const parts = [el.tagName.toLowerCase()];
  if (el.id) parts.push(`#${el.id}`);
  const testid = el.getAttribute("data-testid");
  if (testid) parts.push(`[data-testid="${testid}"]`);
  const label = el.getAttribute("aria-label");
  if (label) parts.push(`[aria-label="${label}"]`);
  const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (text) parts.push(`"${text}"`);
  return parts.join(" ");
}

/**
 * Ask the browser what occupies the reserved strip.
 *
 * Uses elementsFromPoint rather than walking the tree and measuring
 * getBoundingClientRect(): hit-testing is both far cheaper (a handful of
 * probes instead of a full-document traversal on every route change) and
 * strictly more truthful, because it accounts for real paint order and
 * pointer-events instead of re-deriving them from computed styles.
 *
 * One consequence worth stating, because it looks like a gap and isn't:
 * elementsFromPoint skips `pointer-events: none` elements, so purely
 * decorative page content underneath our bar goes unreported. That is the
 * intended scope. The failure this guards against is *interactive* Claude
 * chrome becoming unreachable; a decoration the user could never click
 * either way is not a bug worth warning about.
 *
 * Only the topmost non-BetterClaude element per probe is reported. Every
 * ancestor up to the app root also contains the point, and listing them
 * would bury the one element that actually matters: the node that would
 * have received the click if our bar weren't in front of it.
 *
 * @param {number} height  Reserved strip height in px (0 disables).
 * @param {number} samples Horizontal probe count across the window.
 * @returns {Array<{element: Element, signature: string, x: number, y: number}>}
 */
function probeReservedStrip(height, samples = 9) {
  if (!height || height <= 0 || typeof document.elementsFromPoint !== "function") return [];

  const width = document.documentElement.clientWidth || window.innerWidth || 0;
  if (width <= 0) return [];

  // Three rows rather than one: chrome anchored to the strip's very top, or
  // riding its bottom edge, would slip between single-row probes.
  const rows = [0.25, 0.5, 0.75]
    .map((f) => Math.round(height * f))
    .map((y) => Math.min(Math.max(y, 1), Math.max(height - 1, 1)));

  const bySignature = new Map();
  for (let i = 0; i < samples; i += 1) {
    const x = Math.round(((i + 0.5) / samples) * width);
    for (const y of rows) {
      const stack = document.elementsFromPoint(x, y) || [];
      const hit = stack.find(
        (el) => el !== document.body && el !== document.documentElement && !isOwnChrome(el)
      );
      if (!hit) continue;
      const signature = describeElement(hit);
      if (!bySignature.has(signature)) bySignature.set(signature, { element: hit, signature, x, y });
    }
  }
  return [...bySignature.values()];
}

/**
 * Mounts the guard. Returns { check, checkSoon, unmount }.
 *
 * There is intentionally no MutationObserver here. preload already runs one
 * over claude.ai's app root (`chromeObserver`, which drives
 * syncContextualChrome), and a second observer on the same subtree would
 * double the work on every DOM change to save one call site — the caller
 * simply calls checkSoon() from the handler it already has.
 *
 * @param {() => number} getHeight    Current reserved strip height in px.
 * @param {boolean}      enabled      Off in packaged builds; see preload.
 * @param {Function}     warn         Injected for testability.
 * @param {number}       maxWarnings  Cap so a persistent collision can't
 *                                    flood the console on every route change.
 */
function mountTopStripGuard({ getHeight, enabled = true, warn = console.warn, maxWarnings = 5 } = {}) {
  const reported = new Set();
  let warnings = 0;
  let scheduled = null;

  function check() {
    if (!enabled || warnings >= maxWarnings) return [];
    const height = typeof getHeight === "function" ? getHeight() : 0;
    const collisions = probeReservedStrip(height);
    for (const collision of collisions) {
      // Dedupe by identity, not by occurrence: the same covered element is
      // one bug however many probes or route changes rediscover it.
      if (reported.has(collision.signature)) continue;
      reported.add(collision.signature);
      warnings += 1;
      warn(
        `[BetterClaude] Page content sits underneath the ${height}px title bar and cannot be ` +
          `clicked: ${collision.signature} (at ${collision.x},${collision.y}). ` +
          "Claude's own chrome has moved into the strip BetterClaude reserves. The app root's " +
          "containing-block transform in ui/title-bar.css should keep fixed-positioned chrome " +
          "out of this band — if this fired, something is escaping it (most likely an element " +
          "portalled to <body> rather than into the app root, which that transform cannot reach).",
        collision.element
      );
      if (warnings >= maxWarnings) break;
    }
    return collisions;
  }

  // Layout in the strip settles a frame or two after a route change, so an
  // immediate probe can read a half-built tree and report a transient node.
  function checkSoon() {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      check();
    }, 250);
  }

  function unmount() {
    if (scheduled) clearTimeout(scheduled);
    scheduled = null;
  }

  return { check, checkSoon, unmount };
}

module.exports = {
  mountTopStripGuard,
  probeReservedStrip,
  isOwnChrome,
  describeElement,
  OWN_ID_PREFIXES,
};
