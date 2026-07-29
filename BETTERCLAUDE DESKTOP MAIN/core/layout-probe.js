/**
 * Claude UI structure probe — the version-awareness the injection layer
 * previously lacked.
 *
 * The problem this exists to solve: every injected rule in ui/title-bar.css
 * and every selector in core/theme-engine.js's SELECTORS map names a piece of
 * claude.ai's DOM by a shape Anthropic never promised to keep. When they
 * change it — which they do, without notice — those rules do not error. CSS
 * that matches nothing is silently valid, so the failure surfaces as
 * BetterClaude's chrome drifting out of alignment or sitting on top of real
 * UI. That is exactly how the Code tab became unclickable: not a z-index
 * fight, but an inset that stopped reaching the thing it was compensating for.
 *
 * This is not a hypothetical failure mode. core/theme-engine.js already
 * carries a comment about `:where(#__next, #root) *` matching NOTHING — the
 * entire theme text pipeline was silently inert on any build that didn't wrap
 * the app in one of those two ids. Same root cause, caught late, fixed
 * locally. This module is the general answer.
 *
 * It asks one question before anything is injected: do we still recognize the
 * page we are about to inject into? Three answers, and the middle one matters
 * most:
 *
 *   recognized   every region matched its primary selector.
 *   partial      every required region resolved, but at least one only via a
 *                fallback or the structural heuristic. Injection proceeds —
 *                degraded confidence is not a reason to strip the user's UI —
 *                but it is recorded, because "partial" is what "broken next
 *                release" looks like one release early.
 *   unrecognized a required region resolved to nothing. Geometry surgery is
 *                suppressed rather than applied blind (see the
 *                `bc-layout-unrecognized` rules in ui/title-bar.css).
 *
 * The central design choice is that the app root is found by *behaviour*, not
 * by name. `#root` and `#__next` are tried first because they are cheap and
 * currently correct, but the fallback asks "which child of <body> actually
 * contains the application?" — a question whose answer does not change when
 * Anthropic renames things. That is what makes `unrecognized` rare enough to
 * be a real signal: it now means "there is no app on this page" (a blank or
 * errored load, where there is also nothing to cover), not "they shipped a
 * new build".
 *
 * Read-only and warn-only with respect to Claude's DOM. The single mutation
 * it performs is additive and namespaced — a `bc-claude-root` marker class on
 * the detected root, so the stylesheets can target the element we *found*
 * instead of re-guessing its id. It never reads message content, intercepts
 * events, or touches anything outside layout structure.
 *
 * DOM-only and dependency-free, so it works unchanged in the browser
 * extension build.
 */

const { OWN_ID_PREFIXES } = require("./top-strip-guard");

// Marker class applied to whichever element turns out to be claude.ai's
// application root. Stylesheets should prefer `body > .bc-claude-root` over
// naming an id; see the rules in ui/title-bar.css.
const ROOT_MARKER_CLASS = "bc-claude-root";

// Body-level status classes. Exactly one is present at a time. Only the
// `unrecognized` one has styling consequences; the other two exist so the
// state is visible in devtools without opening the settings panel.
const STATUS_CLASSES = {
  recognized: "bc-layout-recognized",
  partial: "bc-layout-partial",
  unrecognized: "bc-layout-unrecognized",
};

// Children of <body> that can never be the app root. `template`/`noscript`
// are inert; the rest render nothing. Excluded up front so the
// descendant-count heuristic below isn't skewed by a large inlined <script>.
const NON_RENDERING_TAGS = new Set([
  "SCRIPT", "STYLE", "LINK", "META", "TITLE", "BASE", "TEMPLATE", "NOSCRIPT",
]);

/**
 * True if `el` is BetterClaude's own chrome (shallow — this node only).
 *
 * ROOT_MARKER_CLASS is explicitly exempt, and that exemption is load-bearing.
 * It is the one `bc-` class we put on an element that is emphatically NOT ours
 * — it means "this is claude.ai's root" — so counting it as ownership makes
 * the probe disqualify the very element it identified last time. The symptom
 * is nasty and was caught by scripts/audit-layout-probe.js rather than by
 * reading: the first probe of a document reports `recognized`, and every
 * subsequent one reports `unrecognized` (or worse, silently retargets to a
 * portal container that happens to be the next-busiest body child) — so the
 * app would appear to work until the first route change and then drop its
 * page geometry for the rest of the session.
 */
function isOwnNode(el) {
  if (!el || el.nodeType !== 1) return false;
  const id = el.id || "";
  if (OWN_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) return true;
  // classList, not className: claude.ai renders SVG elements whose .className
  // is an SVGAnimatedString — string methods on it throw. Same trap as
  // top-strip-guard.js's isOwnChrome.
  const classes = el.classList;
  if (!classes) return false;
  return Array.prototype.some.call(
    classes,
    (c) => c.startsWith("bc-") && c !== ROOT_MARKER_CLASS
  );
}

/**
 * Children of <body> that could plausibly host claude.ai's app.
 *
 * Repeatedly safe to call: isOwnNode() exempts ROOT_MARKER_CLASS, so a root
 * tagged by a previous probe is still a candidate for this one. See that
 * function for why the exemption matters — an earlier version of this module
 * tried to solve it by clearing the marker inside applyLayoutMarkers(), which
 * cannot work, because that runs strictly after the probe it was meant to
 * protect.
 */
function rootCandidates() {
  if (!document.body) return [];
  return Array.prototype.filter.call(
    document.body.children,
    (el) => !NON_RENDERING_TAGS.has(el.tagName) && !isOwnNode(el)
  );
}

/**
 * Locate claude.ai's application root.
 *
 * Returns `{ element, via, tier }` — tier "primary" for a known id,
 * "heuristic" for a structural match — or null if <body> holds no plausible
 * app root at all.
 *
 * The heuristic prefers "contains the composer" over "has the most
 * descendants" because the former is decisive: a portalled dialog can briefly
 * out-weigh the shell in raw node count, but Claude's composer only ever
 * lives inside the real app tree.
 *
 * Note on why this does NOT rank by rendered area: claude.ai's outermost
 * shell wrapper uses `display: contents` (verified live; documented in
 * ui/title-bar.css). A display:contents element generates no box, so
 * getBoundingClientRect() reports zeros — area-based ranking would score the
 * true root last, which is the kind of plausible-looking heuristic that fails
 * only on the real site.
 */
function findClaudeRoot() {
  const candidates = rootCandidates();
  if (!candidates.length) return null;

  // Fast path: the two ids claude.ai has actually shipped its root under.
  for (const id of ["root", "__next"]) {
    const match = candidates.find((el) => el.id === id);
    if (match) return { element: match, via: `body > #${id}`, tier: "primary" };
  }

  // Decisive structural signal: whoever contains the composer is the app.
  const composer = document.querySelector('[data-testid="chat-input"]');
  if (composer) {
    const owner = candidates.find((el) => el.contains(composer));
    if (owner) return { element: owner, via: "contains composer", tier: "heuristic" };
  }

  // Otherwise the busiest subtree. Correct on the signed-out marketing route,
  // where there is no composer to key off.
  let best = null;
  let bestCount = -1;
  for (const el of candidates) {
    const count = el.getElementsByTagName("*").length;
    if (count > bestCount) {
      best = el;
      bestCount = count;
    }
  }
  // A body child with no descendants is a stray marker div, not an app.
  if (!best || bestCount < 1) return null;
  return { element: best, via: `busiest body child (${bestCount} nodes)`, tier: "heuristic" };
}

/**
 * Locate claude.ai's top-level tab bar (Home / Chat / Code / …).
 *
 * Deliberately blind to how many tabs there are and what order they sit in:
 * this bug arrived *because* Anthropic added and reordered tabs, so any rule
 * of the form "the second one is Code" is the same mistake in a new place.
 * Each tier below identifies the *container* and asserts nothing about its
 * contents.
 *
 * Used for reporting and anchoring, never for repositioning Claude's own
 * chrome — the containing-block transform in ui/title-bar.css fixes the
 * coordinate space generically and does not need to find this at all.
 */
function findTopTabBar(root) {
  const scope = root || document.body;
  if (!scope) return null;

  const tablist = scope.querySelector('[role="tablist"]');
  if (tablist) return { element: tablist, via: '[role="tablist"]', tier: "primary" };

  // Two or more explicit tabs: their shared parent is the container by
  // construction, whatever it happens to be called.
  const tabs = scope.querySelectorAll('[role="tab"]');
  if (tabs.length >= 2 && tabs[0].parentElement) {
    return { element: tabs[0].parentElement, via: `${tabs.length}x [role="tab"]`, tier: "fallback" };
  }

  // Structural last resort: a nav-ish container in the top band of the
  // viewport holding several horizontally-laid-out controls. Bounded to the
  // top 25% so an in-conversation toolbar deep in the page cannot match.
  const band = Math.max((window.innerHeight || 0) * 0.25, 120);
  const containers = scope.querySelectorAll("nav, header, [class*='tab' i]");
  for (const el of containers) {
    const rect = el.getBoundingClientRect();
    if (rect.top > band || rect.width <= 0) continue;
    const controls = Array.prototype.filter.call(
      el.querySelectorAll("a, button"),
      (c) => c.getBoundingClientRect().width > 0
    );
    if (controls.length < 2) continue;
    // Horizontal row: at least two controls sharing a top edge within 4px.
    const tops = controls.map((c) => Math.round(c.getBoundingClientRect().top));
    const rowSize = Math.max(...tops.map((t) => tops.filter((o) => Math.abs(o - t) <= 4).length));
    if (rowSize >= 2) {
      return { element: el, via: `top-band row of ${rowSize} controls`, tier: "fallback" };
    }
  }
  return null;
}

/**
 * Regions the injection layer depends on.
 *
 * `required: true` means injected geometry is unsafe without it. Only the app
 * root qualifies: it is the element the containing-block transform and the
 * height clamps are applied to, so a wrong or missing answer there is the
 * difference between "insets the page" and "covers the page".
 *
 * The rest are advisory. A missing composer selector makes a feature inert,
 * which is a degradation; it does not put BetterClaude's chrome on top of
 * Claude's, so it must not be allowed to disable the user's whole UI.
 */
const REGIONS = [
  {
    key: "appRoot",
    label: "Application root",
    required: true,
    find: () => findClaudeRoot(),
    why: "Carries the containing-block transform that keeps Claude's fixed top chrome out of the title bar's band.",
  },
  {
    key: "topTabBar",
    label: "Top-level tab bar",
    required: false,
    find: (root) => findTopTabBar(root),
    why: "The surface that regressed when the Code tab moved into the reserved strip.",
  },
  {
    key: "composer",
    label: "Composer",
    required: false,
    find: () => {
      const el = document.querySelector('[data-testid="chat-input"]');
      return el ? { element: el, via: '[data-testid="chat-input"]', tier: "primary" } : null;
    },
    why: "Signed-in/signed-out discriminator and the insertion target for prompt/file features.",
  },
  {
    key: "sidebar",
    label: "Conversation sidebar",
    required: false,
    find: () => {
      const pinned = document.querySelector('nav:has([data-testid="pin-sidebar-toggle"])');
      if (pinned) return { element: pinned, via: 'nav:has([data-testid="pin-sidebar-toggle"])', tier: "primary" };
      const nav = document.querySelector("nav");
      return nav ? { element: nav, via: "first <nav>", tier: "fallback" } : null;
    },
    why: "Target of the sidebar width/position/pin layout settings.",
  },
];

/**
 * Run every region's detection and derive an overall status.
 *
 * The composer region is exempt from downgrading the status while signed out:
 * it is absent by design on the sign-in route, and reporting "partial" for a
 * correctly rendered sign-in page would train the reader to ignore the field —
 * which costs exactly the signal this whole module exists to provide.
 *
 * @returns {{status: string, regions: Array, root: Element|null, summary: string}}
 */
function probeLayout() {
  const rootResult = findClaudeRoot();
  const root = rootResult ? rootResult.element : null;

  const regions = REGIONS.map((region) => {
    let result = null;
    try {
      result = region.key === "appRoot" ? rootResult : region.find(root);
    } catch (err) {
      // A selector can throw rather than miss: querySelector raises
      // SyntaxError on a selector the engine cannot parse, which is what an
      // unsupported `:has()` would do on an older Chromium. A detector that
      // dies must read as "not found" — never take the probe, and with it the
      // entire preload bootstrap, down with it.
      result = null;
    }
    return {
      key: region.key,
      label: region.label,
      required: !!region.required,
      why: region.why,
      found: !!result,
      via: result ? result.via : null,
      tier: result ? result.tier : null,
      element: result ? result.element : null,
    };
  });

  const missingRequired = regions.filter((r) => r.required && !r.found);
  const composerRegion = regions.find((r) => r.key === "composer");
  const signedOut = !(composerRegion && composerRegion.found);
  const degraded = regions.filter(
    (r) => !(r.key === "composer" && signedOut) && (!r.found || r.tier !== "primary")
  );

  let status;
  if (missingRequired.length) status = "unrecognized";
  else if (degraded.length) status = "partial";
  else status = "recognized";

  const summary = regions
    .map((r) => `${r.key}=${r.found ? `${r.tier}:${r.via}` : "MISSING"}`)
    .join(" ");

  return { status, regions, root, summary };
}

/**
 * Apply the probe's conclusions to the DOM as markers.
 *
 * Two mutations, both additive and namespaced: the root marker class, and the
 * body status class the `bc-layout-unrecognized` rules in ui/title-bar.css key
 * off. Nothing here restyles, moves, or removes any of Claude's elements.
 */
function applyLayoutMarkers(probe) {
  // Clear any previous marker so exactly one element carries it. This is about
  // keeping the CSS selectors unambiguous, NOT about making the probe
  // re-runnable — isOwnNode()'s exemption handles that, and it has to, because
  // this function runs after the probe rather than before it.
  //
  // Whole-document scope rather than just the current candidates: after a soft
  // update the previous root may already be detached from <body>, and a marker
  // left on a detached node is harmless, whereas one left on a live sibling
  // would have `body > .bc-claude-root` styling two elements at once.
  document.querySelectorAll(`.${ROOT_MARKER_CLASS}`).forEach((el) => {
    el.classList.remove(ROOT_MARKER_CLASS);
  });
  if (probe.root) probe.root.classList.add(ROOT_MARKER_CLASS);

  if (document.body) {
    Object.values(STATUS_CLASSES).forEach((cls) => document.body.classList.remove(cls));
    document.body.classList.add(STATUS_CLASSES[probe.status] || STATUS_CLASSES.unrecognized);
  }
}

/**
 * Mounts the probe. Returns { check, checkSoon, getStatus, unmount }.
 *
 * Shaped deliberately like mountTopStripGuard's return value, and for the same
 * reason: no MutationObserver of its own. preload already runs one over the
 * app root (`chromeObserver` → syncContextualChrome), and a second observer on
 * the same subtree would double the work on every DOM change to save one call
 * site.
 *
 * Re-probing on DOM change (not only at bootstrap) is the entire point. A full
 * reload hands preload a brand-new realm and re-runs all of this, so cold
 * loads were never the risk; the gap was claude.ai soft-updating its shell in
 * place, which is precisely when a new Anthropic build first appears — with no
 * navigation event to hang re-detection off.
 *
 * @param {Function} onChange Called with the probe result only when the status
 *                            or region signature actually changes.
 * @param {boolean}  verbose  Log every transition (development builds).
 *                            Downgrades warn regardless of this flag.
 */
function mountLayoutProbe({ onChange = null, verbose = false, log = console.log, warn = console.warn } = {}) {
  let last = null;
  let scheduled = null;

  function check() {
    const probe = probeLayout();
    applyLayoutMarkers(probe);

    // Dedupe on the full signature, not just the status: a region quietly
    // switching from its primary selector to a fallback keeps the status at
    // "partial" but is exactly the early warning this module exists to give.
    const signature = `${probe.status}|${probe.summary}`;
    if (signature !== last) {
      const isFirstProbe = last === null;
      last = signature;
      if (probe.status === "unrecognized") {
        warn(
          "[BetterClaude] Claude UI structure: UNRECOGNIZED. No application root found under <body>, " +
            "so page-geometry injection is suppressed (see the bc-layout-unrecognized rules in " +
            `ui/title-bar.css). Regions: ${probe.summary}`
        );
      } else if (probe.status === "partial" && !isFirstProbe) {
        // Not warned on the very first probe: "partial" is the normal state on
        // the signed-out route and during the first frames of a cold load, so
        // warning there would cry wolf. A *transition* into partial
        // mid-session is the interesting event.
        warn(
          "[BetterClaude] Claude UI structure: PARTIALLY RECOGNIZED — at least one region resolved " +
            `via a fallback rather than its primary selector. Regions: ${probe.summary}`
        );
      } else if (verbose) {
        log(`[BetterClaude] Claude UI structure: ${probe.status.toUpperCase()}. Regions: ${probe.summary}`);
      }
      if (onChange) onChange(probe);
    }
    return probe;
  }

  // Same 250ms debounce as top-strip-guard, for the same reason: layout in the
  // top band settles a frame or two after a route change, so an immediate
  // probe can read a half-built tree and report a shape that never existed.
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

  return { check, checkSoon, getStatus: () => last, unmount };
}

module.exports = {
  mountLayoutProbe,
  probeLayout,
  applyLayoutMarkers,
  findClaudeRoot,
  findTopTabBar,
  rootCandidates,
  REGIONS,
  ROOT_MARKER_CLASS,
  STATUS_CLASSES,
};
