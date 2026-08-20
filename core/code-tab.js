/**
 * BetterClaude's Code tab — the in-page half.
 *
 * Mounts one pill next to Anthropic's own Home / Code segmented control and
 * reports where the content area is, so the host can park the embedded
 * terminal pane exactly where claude.ai's own content would be. DOM-only: every
 * side effect arrives as a host callback, the same contract as
 * core/skill-marketplace.js and core/update-banner.js, so a browser extension
 * could mount this against a different transport unchanged.
 *
 * WHY A SEPARATE PILL RATHER THAN THE NATIVE "CODE" TAB
 *
 * The 2026-08-19 audit settled this by navigating to it: claude.ai's Code tab
 * is a routed Anthropic feature (`/code` ships code-prompt-input,
 * epitaxy-env-pill, pending-nav-frame — a whole product surface), driven by
 * their own `data-mode` state machine with a sliding indicator. It is not an
 * empty slot. Taking it over would mean intercepting their click handler,
 * breaking a real feature, and re-breaking on every release. So BetterClaude
 * adds its own pill beside theirs, styled to match, and never touches
 * Anthropic's two.
 *
 * WHY THE PANE DOES NOT COVER THE SIDEBAR
 *
 * Because the native pattern doesn't. Switching Home <-> Code on claude.ai
 * swaps the content area and leaves the sidebar in place. Matching that isn't
 * only cosmetic: if the embedded pane covered the whole window below the title
 * bar, it would cover the very control you need to switch back, and the only
 * remaining home for that control would be the title bar — where it is adjacent
 * to nothing and matches nothing. Keeping the sidebar visible is what lets the
 * switch live where the user already looks for it.
 *
 * SELF-HEALING
 *
 * mount() is idempotent and cheap, and the host calls it from the same handler
 * that already fires on every DOM mutation and every route change. claude.ai is
 * React: a re-render that rebuilds the pill container drops our child, and
 * without re-mounting the tab would vanish mid-session with no error. Rather
 * than fight React for ownership of its subtree, we simply put the pill back.
 */

const { resolveTarget, queryOne, boxOf } = require("./claude-dom");

const PILL_ID = "bc-code-tab-pill";

// NOT "Code". Anthropic's pill next door already says that, and a row reading
// "Home | Code | Code" is a coin flip for the user — the two do genuinely
// different things (theirs opens Anthropic's hosted Code surface; ours runs the
// `claude` CLI installed on this machine, in a local pty). "CLI" is the honest
// distinction, and it is short enough that adding a third pill to a 272px row
// still leaves all three labels readable. The full name is in the tooltip and
// the accessible label.
const PILL_LABEL = "CLI";

// Anthropic's pills are ~30px tall inside a 32px group. Matched here so ours
// sits on the same baseline rather than stretching the row.
const FLOATING_CLASS = "bc-code-tab-floating";

/**
 * Width the collapsed sidebar rail needs left clear, remembered across peeks.
 *
 * When claude.ai's sidebar is collapsed it becomes a narrow floating rail that
 * OVERLAPS the content column rather than displacing it — the content pane
 * reports left: 8 while the rail occupies 8..41. Our pane is an opaque native
 * view, so starting it at the content pane's own left edge would bury the rail
 * and, with it, the only control that expands the sidebar again.
 *
 * Remembered rather than re-measured every time because of hover-peek: pointing
 * at the collapsed rail makes claude.ai widen it to full width for as long as
 * the pointer is there, and the "Open sidebar" button we derive this from
 * becomes "Collapse sidebar" while that lasts. Re-measuring live made the
 * embedded pane lurch 250px sideways and back every time the pointer crossed
 * the rail. Keeping the last known allowance makes the geometry peek-stable,
 * and the value is harmless when the sidebar is expanded: Math.max below simply
 * ignores it, because the content pane's own left edge is already further right.
 */
let railAllowance = 0;

/**
 * Where the embedded pane should sit, in CSS pixels relative to the window's
 * content area (which is what the host's view bounds are measured in).
 *
 * `top` is the title bar's height rather than the sidebar's top: the pane is
 * content, and content starts below BetterClaude's bar.
 *
 * `left` comes from claude.ai's own content column, NOT from the sidebar's
 * right edge. Those are the same number while the sidebar is expanded and
 * wildly different while it is collapsed or peeking, and the content column is
 * the one that means "where Claude puts its content" — which is exactly the
 * question being asked. The sidebar is kept as a fallback for a build where the
 * content column can't be resolved, and 0 (full width) as the fallback to that,
 * since a pane that is too wide is recoverable and a pane positioned off-screen
 * is not.
 */
function measureContentArea({ titleBarHeight = 0, sidebarOnRight = false } = {}) {
  const top = Math.round(titleBarHeight);

  // Mirror image of the left-sidebar case below: the sidebar sits at the
  // window's right edge instead, so the content area runs from x:0 up to
  // wherever the sidebar's own left edge currently is, rather than from the
  // content pane's left edge out to the window's right edge. Anchored off the
  // sidebar itself (not contentPane) because contentPane's own box no longer
  // moves when the sidebar resizes in this configuration — it is the
  // fixed-width flex item taking up the leftover space, so its edges track
  // the window, not the sidebar.
  if (sidebarOnRight) {
    const sidebar = resolveTarget("sidebar");
    const sidebarBox = sidebar ? boxOf(sidebar.element) : null;
    const right = sidebarBox ? Math.round(sidebarBox.left) : window.innerWidth;
    return {
      x: 0,
      y: top,
      width: Math.max(0, right),
      height: Math.max(0, Math.round(window.innerHeight - top)),
      anchoredTo: sidebarBox ? "sidebar" : "window",
    };
  }

  const pane = resolveTarget("contentPane");
  const paneBox = pane ? boxOf(pane.element) : null;

  let left;
  if (paneBox) {
    left = Math.round(paneBox.left);
  } else {
    const sidebar = resolveTarget("sidebar");
    const sidebarBox = sidebar ? boxOf(sidebar.element) : null;
    left = sidebarBox ? Math.round(sidebarBox.right) : 0;
  }

  // Refresh the rail allowance only while the collapsed-state toggle is
  // actually showing, i.e. never during a peek.
  const collapsedToggle = queryOne('button[aria-label*="open sidebar" i]');
  if (collapsedToggle) {
    const toggleBox = boxOf(collapsedToggle);
    if (toggleBox) railAllowance = Math.round(toggleBox.right) + 8;
  }

  left = Math.max(0, left, railAllowance);
  return {
    x: left,
    y: top,
    width: Math.max(0, Math.round(window.innerWidth - left)),
    height: Math.max(0, Math.round(window.innerHeight - top)),
    anchoredTo: paneBox ? "contentPane" : "sidebar",
  };
}

/**
 * Build the pill. Deliberately a <button type="button"> with the same shape as
 * Anthropic's: assistive tech should read it as one more control in the same
 * group, because that is exactly what it is.
 */
function createPill({ onActivate }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = PILL_ID;
  btn.className = "bc-code-tab-pill";
  btn.setAttribute("aria-label", "BetterClaude Code (Claude Code CLI)");
  btn.title = "BetterClaude Code — runs the Claude Code CLI from this machine, in this window";
  btn.textContent = PILL_LABEL;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onActivate();
  });
  return btn;
}

/**
 * @param {Function} onActivate      User asked for the embedded Code pane.
 * @param {Function} onDeactivate    User asked for claude.ai back.
 * @param {Function} onLayout          Called with measureContentArea()'s result.
 * @param {number}   titleBarHeight    Height of BetterClaude's own title bar.
 * @param {Function} [getSidebarOnRight] Returns whether the "Sidebar position"
 *   setting currently reads "right". Read fresh on every sync rather than
 *   captured once, since the user can flip the setting while the pane is
 *   mounted (or open).
 */
function mountCodeTab({ onActivate, onDeactivate, onLayout, titleBarHeight = 0, getSidebarOnRight = () => false } = {}) {
  let active = false;
  let pill = null;
  let resizeObserver = null;
  let observedPane = null;
  let sidebarResizeObserver = null;
  let observedSidebar = null;

  // Publishing the same geometry repeatedly is free on this side but makes the
  // host re-apply view bounds on every mutation burst, so only changes go out.
  let lastPublished = "";
  function publishLayout() {
    if (!onLayout) return;
    // Nothing consumes these bounds while the pane is hidden — the host only
    // applies them to a visible view — and measuring is the expensive half of
    // this module (two getBoundingClientRect calls plus a document-wide
    // attribute-substring scan, each a forced synchronous layout). Since sync()
    // runs on claude.ai's mutation firehose, doing that work for a closed pane
    // was pure cost on every keystroke and every streamed token, for every user
    // whether or not they ever open the terminal.
    //
    // Correctness is preserved by setActive(): turning the pane on calls sync(),
    // which publishes before the host shows anything, so the first frame still
    // lands with current geometry rather than stale bounds.
    if (!active) return;
    const rect = measureContentArea({ titleBarHeight, sidebarOnRight: getSidebarOnRight() });
    const signature = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    if (signature === lastPublished) return;
    lastPublished = signature;
    onLayout(rect);
  }

  /**
   * Watch the content column's own box, not just the window's.
   *
   * The window-level resize event misses the two changes that matter most
   * here: the user dragging claude.ai's sidebar resize handle, and the collapse
   * toggle. Both move the content column's left edge without the window
   * changing size at all, and without this the pane would keep its old bounds
   * and either overlap the sidebar or leave a gap beside it.
   *
   * Re-resolved on every sync() because React can swap the column element
   * wholesale on a route change, which would otherwise leave the observer bound
   * to a detached node and silently stop tracking.
   */
  function watchLayout() {
    if (typeof ResizeObserver !== "function") return;
    const pane = resolveTarget("contentPane");
    const el = pane ? pane.element : null;
    if (el !== observedPane) {
      if (resizeObserver) resizeObserver.disconnect();
      observedPane = el;
      resizeObserver = null;
      if (el) {
        resizeObserver = new ResizeObserver(() => publishLayout());
        resizeObserver.observe(el);
      }
    }

    // With the sidebar on the right, contentPane's own box stays put as the
    // sidebar resizes (see measureContentArea's comment above) — the sidebar
    // element itself is what needs watching there.
    const sidebar = getSidebarOnRight() ? resolveTarget("sidebar") : null;
    const sidebarEl = sidebar ? sidebar.element : null;
    if (sidebarEl === observedSidebar) return;
    if (sidebarResizeObserver) sidebarResizeObserver.disconnect();
    observedSidebar = sidebarEl;
    sidebarResizeObserver = null;
    if (!sidebarEl) return;
    sidebarResizeObserver = new ResizeObserver(() => publishLayout());
    sidebarResizeObserver.observe(sidebarEl);
  }

  /**
   * Put the pill where it belongs, creating it if needed. Safe to call on every
   * mutation burst: the common path is two DOM reads and an early return.
   */
  function sync() {
    if (!pill) pill = createPill({ onActivate: () => setActive(!active) });

    const group = resolveTarget("modeSwitch");
    if (group) {
      pill.classList.remove(FLOATING_CLASS);
      // Appended, not inserted at an index. "After Code" is a position that
      // only exists if you assume the pill order, and the audit's six-pill
      // reshuffle case exists precisely because that assumption is the one
      // Anthropic keeps invalidating. Last is last whatever the order is.
      if (pill.parentElement !== group.element) group.element.appendChild(pill);
    } else if (pill.parentElement !== document.body) {
      // Safe fallback: the container is gone, so float the control instead of
      // dropping it. A user who cannot see the pane at all has lost a feature;
      // a user whose pill is in a slightly odd place has not. The
      // bc-miss-modeSwitch body class (set by core/layout-probe.js) is what
      // ui/title-bar.css keys the floating position off.
      pill.classList.add(FLOATING_CLASS);
      document.body.appendChild(pill);
    }

    pill.setAttribute("aria-pressed", active ? "true" : "false");
    pill.toggleAttribute("data-bc-active", active);
    watchLayout();
    publishLayout();
  }

  /**
   * Anthropic's own pills navigate claude.ai. If one is clicked while our pane
   * is showing, the user is asking for claude.ai back — so step aside rather
   * than leaving the pane parked on top of a route change they can't see.
   *
   * Listener is passive and on the capture phase purely so it observes the
   * click before React's own handler runs; it never calls preventDefault or
   * stopPropagation, so Anthropic's navigation happens exactly as it would
   * without us.
   */
  function onDocumentClick(event) {
    if (!active) return;
    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest(`#${PILL_ID}`)) return;

    // Must be a pill INSIDE Anthropic's own mode-switch container, not merely
    // any element carrying a data-mode attribute.
    //
    // `target.closest("[data-mode]")` alone looked precise and was catastrophic:
    // claude.ai also uses data-mode for the colour scheme (`div.cds-root
    // [data-mode="dark"]` wraps the app), so that test matched an ancestor of
    // essentially every element on the page — and the pane closed itself on the
    // user's next click ANYWHERE. It presented as the embedded pane refusing to
    // track the sidebar, because a hidden pane does not get new bounds; the
    // actual fault was three layers away from the symptom.
    const group = resolveTarget("modeSwitch");
    if (!group || !group.element.contains(target)) return;
    if (target.closest("[data-mode]")) setActive(false);
  }

  function setActive(next) {
    if (next === active) {
      // Re-activating an already-open pane focuses it rather than toggling it
      // off by accident — same "focus, don't duplicate" rule the standalone
      // window had.
      if (next && onActivate) onActivate();
      return;
    }
    active = next;
    document.body.classList.toggle("bc-code-tab-active", active);
    sync();
    if (active) {
      if (onActivate) onActivate();
    } else if (onDeactivate) {
      onDeactivate();
    }
  }

  document.addEventListener("click", onDocumentClick, { capture: true, passive: true });
  window.addEventListener("resize", publishLayout);
  sync();

  return {
    sync,
    setActive,
    isActive: () => active,
    publishLayout,
    unmount() {
      document.removeEventListener("click", onDocumentClick, { capture: true });
      window.removeEventListener("resize", publishLayout);
      if (resizeObserver) resizeObserver.disconnect();
      if (sidebarResizeObserver) sidebarResizeObserver.disconnect();
      if (pill && pill.parentElement) pill.parentElement.removeChild(pill);
      pill = null;
    },
  };
}

module.exports = { mountCodeTab, measureContentArea, PILL_ID, FLOATING_CLASS };
