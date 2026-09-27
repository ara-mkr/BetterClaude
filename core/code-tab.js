/**
 * BetterClaude's Code tab — the in-page half.
 *
 * Reports where claude.ai's content area is, so the host can park the embedded
 * terminal pane exactly where claude.ai's own content would be, and intercepts
 * claude.ai's own Home/Code control as a fallback. DOM-only: every side effect
 * arrives as a host callback, the same contract as core/skill-marketplace.js
 * and core/update-banner.js, so a browser extension could mount this against a
 * different transport unchanged.
 *
 * The visible Home / Code / CLI switch is NOT here anymore — it is the one nav
 * rail in the shared title bar (ui/title-bar.js), which stays put in every
 * mode. This module used to also mount an in-page pill that hopped between
 * claude.ai's segmented row, the title bar, and a floating box depending on the
 * route; `showPill` now defaults false and that path is dead. What remains is
 * the pane geometry measurement, split mode, and the native-click fallback.
 *
 * WHY THE BETTERCLAUDE IDE OWNS THE NATIVE "CODE" ACTION
 *
 * The 2026-08-19 audit showed that claude.ai's Code tab is a routed Anthropic
 * feature (`/code` ships code-prompt-input, epitaxy-env-pill, pending-nav-frame)
 * behind a private desktop-app gate. BetterClaude cannot reliably unlock that
 * route, so this module observes the semantic mode control and prevents only
 * the native Code navigation, opening the BetterClaude-owned IDE instead.
 * claude.ai's own segmented control is hidden by ui/title-bar.css now that the
 * rail covers it; this interception stays as belt-and-suspenders.
 *
 * WHY THE PANE DOES NOT COVER THE SIDEBAR
 *
 * Because the native pattern doesn't. Switching Home <-> Code on claude.ai
 * swaps the content area and leaves the sidebar in place. Matching that isn't
 * only cosmetic: it keeps this row — the app's one Home / Code / CLI switch —
 * visible and clickable while the CLI pane is open. The IDE pane is the
 * exception: it owns the full content area below the title bar, and its way
 * back is the title bar's Chat button (ui/title-bar.js), which sits above
 * every pane.
 *
 * SPLIT MODE (chat beside the pane)
 *
 * The sidebar staying visible means conversations stay one click away while
 * the CLI is up — but opening one used to navigate underneath the opaque
 * pane, rendering a chat nobody could see. Split mode fixes that: clicking a
 * sidebar conversation while the pane is showing squeezes claude.ai's content
 * column into its left half (inline styles, re-applied by sync()) and halves
 * the reported bounds so the pane occupies the right half. Navigating off the
 * conversation — Home, New chat, anything — ends the split and the pane takes
 * the full content area again.
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
const ICONS = require("./icons");

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
// Set instead of FLOATING_CLASS when the pill falls back into BetterClaude's
// own title bar (see the fallback branch in mount()).
const TITLEBAR_CLASS = "bc-code-tab-in-titlebar";
// Kept in sync with TITLE_BAR_ID in ui/title-bar.js. Not imported: that module
// requires electron/window-chrome.js, and core/ stays free of Electron deps so
// the same bundle can run as a browser extension content script.
const TITLE_BAR_ID = "betterclaude-titlebar";

// --- Split mode ---------------------------------------------------------------
//
// With the pane open, opening a conversation from claude.ai's sidebar used to
// navigate underneath an opaque native view — the chat rendered where nobody
// could see it. Split mode is the fix: the page's content column is squeezed
// into the LEFT half of its own area and the embedded pane is re-measured into
// the RIGHT half, so both are visible at once. Any navigation away from a
// conversation route ends the split and the pane takes the full content area
// again (the live wire rides along — it is part of the pane's own page).

const SPLIT_BODY_CLASS = "bc-code-split";
const SPLIT_PANE_CLASS = "bc-split-squeezed";

// The two href shapes claude.ai uses for a conversation, so what this detects
// as "a chat" is exactly what claude.ai itself links to as one.
const CHAT_LINK_SELECTOR = 'a[href*="/chat/"], a[href*="/conversation/"]';

function isConversationPath(pathname) {
  return /^\/(chat|conversation)\//.test(pathname || "");
}

// Inline rather than stylesheet-driven because the element being squeezed is
// one claude-dom resolves at runtime (`.dframe-pane-primary` today); keying a
// rule off body class would still need these same declarations somewhere, and
// inline survives React swapping classes around it until the next re-render,
// which sync() re-applies over anyway. `flex` covers main being a flex row;
// width/max-width cover plain block layout; min-width:0 lets the column
// actually shrink below its content's preferred measure instead of
// overflowing and pushing the split point sideways.
const SQUEEZE_PROPERTIES = [
  ["width", "50%"],
  ["max-width", "50%"],
  ["flex", "0 1 50%"],
  ["min-width", "0"],
];

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
function measureBaseContentArea({ titleBarHeight = 0, sidebarOnRight = false } = {}) {
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
 * Where the embedded pane should sit, optionally halved for split mode.
 *
 * The half is cut from the FULL content rectangle, never from the pane's
 * measured box: once the split squeeze is applied the content column's own
 * width is already 50%, and halving that would walk the pane's left edge
 * rightward a quarter at a time on every re-measure. Deriving the split point
 * from the rect's origin + window width keeps it pinned no matter how the
 * squeeze has resized the column underneath.
 *
 * The chat always takes the left half and the pane the right — including with
 * the sidebar docked right, where mirroring would need margin hacks against
 * layout internals this module deliberately doesn't model. Both halves stay
 * fully usable either way.
 */
function measureContentArea({ titleBarHeight = 0, sidebarOnRight = false, split = false } = {}) {
  const base = measureBaseContentArea({ titleBarHeight, sidebarOnRight });
  if (!split || base.width <= 1) return base;
  const half = Math.round(base.width / 2);
  return {
    x: base.x + half,
    y: base.y,
    width: base.width - half,
    height: base.height,
    anchoredTo: base.anchoredTo,
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
  // Icon + label, matching the shape of Anthropic's own pills next door (each
  // is a small leading glyph followed by a text label). The terminal glyph is
  // what makes this pill readable at a glance as "the command-line one" rather
  // than a third word to parse; the label stays because "CLI" is the honest
  // distinction from their Code pill, and the icon is aria-hidden so assistive
  // tech still reads the one accessible name set above.
  btn.innerHTML =
    `<span class="bc-code-tab-pill-icon" aria-hidden="true">${ICONS.TERMINAL}</span>` +
    `<span class="bc-code-tab-pill-label">${PILL_LABEL}</span>`;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onActivate();
  });
  return btn;
}

/** * @param {Function} onActivate      User asked for the embedded CLI pane.
 * @param {Function} onDeactivate    User asked for claude.ai back.
 * @param {Function} onLayout         Called with measureContentArea()'s result.
 * @param {Function} onNativeCode     User clicked Anthropic's native Code mode; BetterClaude owns that surface.
 * @param {Function} onNativeHome     User clicked Anthropic's native Home mode.
 * @param {number}   titleBarHeight    Height of BetterClaude's own title bar.
 * @param {Function} [getSidebarOnRight] Returns whether the "Sidebar position"

 *   setting currently reads "right". Read fresh on every sync rather than
 *   captured once, since the user can flip the setting while the pane is
 *   mounted (or open).
 */
function mountCodeTab({ onActivate, onDeactivate, onLayout, onNativeCode, onNativeHome, titleBarHeight = 0, getSidebarOnRight = () => false, showPill = false } = {}) {
  let active = false;
  let split = false;
  // Where a clicked sidebar chat is ABOUT to route. React Router navigates on
  // pushState some time after the click returns, so between setSplit(true) and
  // the route actually landing, location.pathname still names the OLD page —
  // and the naive "am I still on a conversation?" test in sync() would read
  // that gap as "user left" and tear the split back down every single time.
  // Remembering the target closes the gap; the timer below keeps a click that
  // never navigates from pinning the split shut forever.
  let splitPendingPath = null;
  let splitPendingTimer = null;
  let pillVisible = showPill !== false;
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
    const rect = measureContentArea({ titleBarHeight, sidebarOnRight: getSidebarOnRight(), split });
    const signature = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    if (signature === lastPublished) return;
    lastPublished = signature;
    onLayout(rect);
  }

  /**
   * Enter or leave split mode. The body class and the content column's inline
   * squeeze are applied by sync() (below), which this calls — one place owns
   * the DOM so a React re-render that drops either marker is repaired by the
   * same self-healing pass that re-mounts the pill.
   */
  function setSplit(next) {
    if (next === split) return;
    split = next;
    if (!next && splitPendingTimer) {
      clearTimeout(splitPendingTimer);
      splitPendingTimer = null;
    }
    if (next) lastPublished = "";
    document.body.classList.toggle(SPLIT_BODY_CLASS, split);
    sync();
  }

  /**
   * Constrain claude.ai's content column to its half of the window while split
   * mode is showing. Idempotent and cheap: four style writes against an
   * element sync() was resolving anyway.
   */
  function applySplitSqueeze() {
    const pane = resolveTarget("contentPane");
    const el = pane ? pane.element : null;
    if (!el) return;
    if (active && split) {
      for (const [prop, value] of SQUEEZE_PROPERTIES) el.style.setProperty(prop, value, "important");
      el.classList.add(SPLIT_PANE_CLASS);
    } else {
      for (const [prop] of SQUEEZE_PROPERTIES) el.style.removeProperty(prop);
      el.classList.remove(SPLIT_PANE_CLASS);
    }
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
    // Leaving a conversation ends the split. This is the "click off the chat"
    // exit: Home, New chat, picking a project — any navigation off /chat/ or
    // /conversation/ — puts the pane back over the full content area. sync()
    // runs on every mutation burst, so React's re-render after the navigation
    // repairs the state here even without the route-change hook preload adds.
    if (split) {
      const path = window.location.pathname;
      if (isConversationPath(path)) {
        // Landed (or already sitting) on a conversation — the pending target
        // has done its job.
        splitPendingPath = null;
      } else if (!splitPendingPath) {
        // Not on a conversation and none in flight: the user clicked off.
        // When a pending target DOES exist, the click has happened but React
        // Router's pushState hasn't landed yet — hold the split open for the
        // gap, with the timeout in the click handler as the backstop for a
        // navigation that never arrives.
        setSplit(false);
        return;
      }
    }
    if (!pillVisible) {
      if (pill && pill.parentElement) pill.parentElement.removeChild(pill);
      pill = null;
      watchLayout();
      applySplitSqueeze();
      publishLayout();
      return;
    }
    if (!pill) pill = createPill({ onActivate: () => setActive(!active) });

    const group = resolveTarget("modeSwitch");
    if (group) {
      pill.classList.remove(FLOATING_CLASS);
      // Appended, not inserted at an index. "After Code" is a position that
      // only exists if you assume the pill order, and the audit's six-pill
      // reshuffle case exists precisely because that assumption is the one
      // Anthropic keeps invalidating. Last is last whatever the order is.
      if (pill.parentElement !== group.element) {
        pill.classList.remove(TITLEBAR_CLASS);
        group.element.appendChild(pill);
      }
    } else {
      // FALLBACK — Anthropic's pill row is not on this render.
      //
      // This is not the rare case the old comment assumed. claude.ai ships the
      // Home/Code segmented group conditionally (measured live: zero
      // `[data-segmented]` nodes on /new), so the fallback IS the normal state
      // on those routes, and where it puts the pill matters as much as the
      // primary placement does.
      //
      // It used to float at `top: var(--bc-tb-h) + 8px; left: 12px` on the
      // claim that the spot was "clear of Claude's own chrome on every route
      // the audit covered". That is no longer true and was the whole "Claude is
      // fried / weird overlap" bug: claude.ai now paints its own brand wordmark
      // at (12,46,50,44) — `div.df-titlebar-brand` > `span.font-voice`, the
      // word "Claude" — and the floating pill landed exactly on top of it, so
      // the two texts rendered through each other.
      //
      // Chasing a new "empty" coordinate inside claude.ai's layout would just
      // reschedule the same bug for their next redesign. So the fallback moves
      // into the one region whose emptiness BetterClaude controls: its OWN
      // title bar, which already reserves a wide drag spacer and is mounted on
      // every route. Inserted before the settings button so the row reads
      // [CLI] [gear], and it stays a real member of .bc-tb-controls rather than
      // a floating overlay, so it cannot cover anything by construction.
      const controls = document.querySelector(`#${TITLE_BAR_ID} .bc-tb-controls`);
      if (controls) {
        if (pill.parentElement !== controls) {
          pill.classList.remove(FLOATING_CLASS);
          pill.classList.add(TITLEBAR_CLASS);
          controls.insertBefore(pill, controls.firstChild);
        }
      } else if (pill.parentElement !== document.body) {
        // No BetterClaude title bar either (the extension build mounts none).
        // Float as a last resort, but below claude.ai's brand row rather than
        // through it — see the floating rules in ui/title-bar.css.
        pill.classList.remove(TITLEBAR_CLASS);
        pill.classList.add(FLOATING_CLASS);
        document.body.appendChild(pill);
      }
    }

    pill.setAttribute("aria-pressed", active ? "true" : "false");
    pill.toggleAttribute("data-bc-active", active);
    watchLayout();
    applySplitSqueeze();
    publishLayout();
  }

  /**
 * Anthropic's own Home / Code controls are observed on the capture phase so
 * BetterClaude can prevent only the restricted native Code route before React's
 * click handler runs. Home is never cancelled; it only detaches BetterClaude's
 * views so Claude.ai remains visible.
   */
  function onDocumentClick(event) {
    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest(`#${PILL_ID}`)) return;

    // Split entry: a conversation opened from the sidebar while the pane is
    // showing becomes side-by-side instead of navigating underneath an opaque
    // native view. The navigation itself is never cancelled — claude.ai routes
    // to the chat as normal, and split mode just re-homes the pane into the
    // other half. Sidebar containment is checked so links elsewhere on the
    // page keep behaving normally, with a degrade-open fallback when the
    // sidebar can't be resolved: every /chat/ link on claude.ai lives in that
    // rail anyway, and missing the split is worse than over-triggering it.
    const chatLink = target.closest(CHAT_LINK_SELECTOR);
    if (chatLink && active) {
      const sidebar = resolveTarget("sidebar");
      if (!sidebar || sidebar.element.contains(chatLink)) {
        try {
          splitPendingPath = new URL(chatLink.href).pathname;
        } catch {
          splitPendingPath = null;
        }
        if (splitPendingTimer) clearTimeout(splitPendingTimer);
        // If the navigation never lands (dead link, interrupted by another
        // click), the remembered target would otherwise hold the split open on
        // a page that isn't a conversation. Two seconds is far longer than
        // React Router needs and far shorter than "stuck".
        splitPendingTimer = setTimeout(() => {
          splitPendingPath = null;
          splitPendingTimer = null;
          sync();
        }, 2000);
        setSplit(true);
      }
      return;
    }

    // Match only the semantic mode values. The same data-mode attribute is
    // also used by claude.ai for light/dark color mode, so a bare
    // target.closest("[data-mode]") would treat every page click as a tab
    // click. If the audited mode-switch group exists, require the control to
    // belong to it; the exact-value fallback keeps the native Code entry point
    // working during a shell transition while that group is being rebuilt.
    const nativeMode = target.closest('[data-mode="code"], [data-mode="cowork"], [data-mode="home"]');
    if (!nativeMode) return;
    const group = resolveTarget("modeSwitch");
    if (group && !group.element.contains(nativeMode)) return;
    const mode = nativeMode.getAttribute("data-mode");

    if (mode === "code" && onNativeCode) {
      if (active) setActive(false);
      // BetterClaude owns the Code surface. Stop Anthropic's restricted /code
      // route before its React handler can navigate there.
      event.preventDefault();
      event.stopPropagation();
      onNativeCode();
      return;
    }
    if (mode === "cowork" || mode === "home") {
      if (active) setActive(false);
      // Do not prevent Home navigation; just detach any BetterClaude view that
      // would otherwise remain composited above the page.
      if (onNativeHome) onNativeHome();
    }
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
    if (!active && split) setSplit(false);
    document.body.classList.toggle("bc-code-tab-active", active);
    sync();
    if (active) {
      // Opening the pane while a conversation is on screen starts side-by-side
      // — the same contract as clicking a chat with the pane open, and it also
      // covers adopting a pane that outlived a claude.ai reload mid-conversation
      // (preload re-activates from code-tab:get-state without any click).
      // Called after sync() so the split bounds are published before the host
      // is asked to show anything.
      if (isConversationPath(window.location.pathname)) setSplit(true);
      if (onActivate) onActivate();
    } else if (onDeactivate) {
      onDeactivate();
    }
  }

  document.addEventListener("click", onDocumentClick, { capture: true });
  window.addEventListener("resize", publishLayout);
  sync();

  return {
    sync,
    setActive,
    isSplit: () => split,
    setPillVisible(next) {
      pillVisible = next !== false;
      sync();
    },
    isActive: () => active,
    publishLayout,
    unmount() {
      document.removeEventListener("click", onDocumentClick, { capture: true });
      window.removeEventListener("resize", publishLayout);
      if (resizeObserver) resizeObserver.disconnect();
      if (sidebarResizeObserver) sidebarResizeObserver.disconnect();
      if (splitPendingTimer) clearTimeout(splitPendingTimer);
      applySplitSqueeze();
      document.body.classList.remove(SPLIT_BODY_CLASS);
      if (pill && pill.parentElement) pill.parentElement.removeChild(pill);
      pill = null;
    },
  };
}

module.exports = { mountCodeTab, measureContentArea, PILL_ID, FLOATING_CLASS, TITLEBAR_CLASS };
