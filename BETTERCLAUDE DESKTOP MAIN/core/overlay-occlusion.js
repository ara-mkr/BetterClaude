/**
 * Native-pane occlusion guard.
 *
 * The embedded Claude Code pane is an Electron WebContentsView — a NATIVE view
 * composited on top of the window's web page. That is what makes it safe (its
 * pty bridge never shares a realm with remote content) and it is also its one
 * sharp edge: it sits above the page unconditionally, so it sits above
 * BetterClaude's own in-page overlays too. Open Settings while the pane is
 * showing and the panel renders *behind* it — no error, no z-index to fight,
 * just a settings panel the user cannot see or click.
 *
 * So the pane steps aside while any BetterClaude overlay is open, and comes
 * back when it closes. Detaching is not closing: the terminal and the child
 * `claude` process are untouched (see setCodeViewSuspended in
 * electron/main.js), and the pill stays active throughout, because from the
 * user's point of view the Code tab is still the tab they are on.
 *
 * WHY THIS IS NOT A LIST OF OVERLAY IDs. There are eight of them today
 * (settings, skill marketplace, prompt picker, command palette, diff viewer,
 * analytics dashboard, and two mini-games) and the ninth would be added by
 * someone who has never heard of this file. The test is behavioural instead:
 * a BetterClaude-owned body child that is interactive and covers a meaningful
 * share of the window is, by definition, something the user is meant to be
 * looking at. `pointer-events: none` is what separates a real overlay from the
 * always-present decorative ones — #bc-fx-canvas is full-window and would
 * otherwise suspend the pane permanently.
 *
 * DOM-only; the host supplies the suspend/resume side effects.
 */

const OWN_ID_PREFIXES = ["betterclaude-", "bc-"];

// Share of the viewport an overlay must cover to count as blocking. Low enough
// to catch a centred modal, high enough that the 46px title bar (interactive,
// always present, and never in the pane's way) doesn't trip it.
const BLOCKING_AREA_RATIO = 0.25;

function isOwnBodyChild(el) {
  const id = el.id || "";
  return OWN_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** True while a BetterClaude overlay is covering a meaningful part of the window. */
function anyBlockingOverlay() {
  if (!document.body) return false;
  const viewportArea = (window.innerWidth || 0) * (window.innerHeight || 0);
  if (viewportArea <= 0) return false;

  return Array.prototype.some.call(document.body.children, (el) => {
    if (!isOwnBodyChild(el)) return false;
    let style;
    try {
      style = getComputedStyle(el);
    } catch (_err) {
      return false;
    }
    if (style.display === "none" || style.visibility === "hidden") return false;
    // Decorative, non-interactive chrome never blocks anything.
    if (style.pointerEvents === "none") return false;
    const box = el.getBoundingClientRect();
    return box.width * box.height > viewportArea * BLOCKING_AREA_RATIO;
  });
}

/**
 * Watch for overlays opening and closing.
 *
 * Two observation scopes, both narrow:
 *   - <body> direct children, so a lazily-built overlay (the settings panel is
 *     only constructed on first open) is noticed the moment it is inserted.
 *   - the `class`/`style` attribute of each BetterClaude body child, which is
 *     how every one of these overlays actually opens — they toggle `bc-open`
 *     rather than being added and removed.
 *
 * Neither watches a subtree, so the cost does not scale with page content, and
 * an overlay re-rendering its own insides costs nothing.
 *
 * @param {Function} onChange Called with a boolean only when the state flips.
 */
function mountOverlayOcclusionGuard({ onChange } = {}) {
  if (typeof onChange !== "function") return { check() {}, unmount() {} };
  let last = null;
  let scheduled = null;
  let observer = null;
  const watched = new Set();

  function check() {
    const blocking = anyBlockingOverlay();
    if (blocking === last) return blocking;
    last = blocking;
    onChange(blocking);
    return blocking;
  }

  // A CSS transition can mean the overlay is still at zero size on the frame
  // its class changes, so re-check once it has settled as well as immediately.
  function checkSoon() {
    check();
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      check();
    }, 250);
  }

  function attach() {
    if (typeof MutationObserver !== "function" || !document.body) return;
    if (!observer) observer = new MutationObserver(() => { attach(); checkSoon(); });
    if (!watched.has(document.body)) {
      watched.add(document.body);
      observer.observe(document.body, { childList: true, subtree: false });
    }
    Array.prototype.forEach.call(document.body.children, (el) => {
      if (!isOwnBodyChild(el) || watched.has(el)) return;
      watched.add(el);
      observer.observe(el, { attributes: true, attributeFilter: ["class", "style"] });
    });
  }

  attach();
  check();

  return {
    check,
    checkSoon,
    unmount() {
      if (scheduled) clearTimeout(scheduled);
      scheduled = null;
      if (observer) observer.disconnect();
      observer = null;
      watched.clear();
    },
  };
}

module.exports = { mountOverlayOcclusionGuard, anyBlockingOverlay, BLOCKING_AREA_RATIO };
