/**
 * Claude UI structure probe — the version-awareness gate in front of injection.
 *
 * The problem this exists to solve: every injected rule in ui/title-bar.css and
 * every selector in core/theme-engine.js's SELECTORS map names a piece of
 * claude.ai's DOM by a shape Anthropic never promised to keep. When they change
 * it — which they do, without notice — those rules do not error. CSS that
 * matches nothing is silently valid, so the failure surfaces as BetterClaude's
 * chrome drifting out of alignment, or as a whole feature quietly doing
 * nothing. The 2026-08-19 audit found the sidebar had become
 * `<aside aria-label="Sidebar">` and every sidebar rule in the app had been
 * inert for an unknown number of releases.
 *
 * This module answers one question before anything is injected: do we still
 * recognise the page we are about to inject into? Three answers, and the middle
 * one matters most:
 *
 *   recognized   every region matched an exact, Anthropic-authored identifier.
 *   partial      every required region resolved, but at least one only via a
 *                weaker selector or a structural heuristic. Injection proceeds —
 *                degraded confidence is not a reason to strip the user's UI —
 *                but it is recorded, because "partial" is what "broken next
 *                release" looks like one release early.
 *   unrecognized a required region resolved to nothing. Geometry surgery is
 *                suppressed rather than applied blind (see the
 *                `bc-layout-unrecognized` rules in ui/title-bar.css).
 *
 * WHERE THE SELECTORS LIVE. They are not here any more. core/claude-dom.js owns
 * every named target and its ordered strategy list; this file is the policy
 * layer on top: which targets are load-bearing, what a miss means in context,
 * and what to warn about. That split is the point — adding a new Anthropic
 * shape is now one line in the adapter, not a grep across four files, and every
 * other consumer (theme engine, preload, the embedded Code tab) resolves
 * through the same strategies instead of re-guessing.
 *
 * Read-only and warn-only with respect to Claude's DOM. The single mutation it
 * performs is additive and namespaced — a `bc-claude-root` marker class on the
 * detected root, plus a body status class — so the stylesheets can target the
 * element we *found* instead of re-guessing its id. It never reads message
 * content, intercepts events, or touches anything outside layout structure.
 *
 * DOM-only and dependency-free, so it works unchanged in the extension build.
 */

const {
  ROOT_MARKER_CLASS,
  findAppRoot,
  resolveTarget,
  resolveAll,
  createMissReporter,
  attemptedSelectors,
} = require("./claude-dom");

// Body-level status classes. Exactly one is present at a time. Only the
// `unrecognized` one has styling consequences; the other two exist so the state
// is visible in devtools without opening the settings panel.
const STATUS_CLASSES = {
  recognized: "bc-layout-recognized",
  partial: "bc-layout-partial",
  unrecognized: "bc-layout-unrecognized",
};

/**
 * Regions whose resolution decides the overall status.
 *
 * `required: true` means injected geometry is unsafe without it. Only the app
 * root qualifies: it is the element the containing-block transform and the
 * height clamps are applied to, so a wrong or missing answer there is the
 * difference between "insets the page" and "covers the page".
 *
 * The rest are advisory. A missing composer target makes a feature inert, which
 * is a degradation; it does not put BetterClaude's chrome on top of Claude's,
 * so it must not be allowed to disable the user's whole UI.
 *
 * Deliberately a SUBSET of the adapter's targets. `chatHeader` and
 * `sidebarInner` resolve through the same adapter but are not status-bearing:
 * they are cosmetic anchors, and letting a cosmetic miss pin the status at
 * `partial` is how a health signal stops being read.
 */
const STATUS_REGIONS = ["appRoot", "sidebar", "modeSwitch", "composer", "accountButton"];

/**
 * Locate claude.ai's application root.
 *
 * Kept exported (and re-exported from core/index.js) because the audit scripts
 * and the extension build call it directly. The implementation moved to
 * core/claude-dom.js so the root strategy list sits with every other target's.
 */
function findClaudeRoot() {
  return findAppRoot();
}

/**
 * Locate Anthropic's Home/Code mode switch.
 *
 * Named `findTopTabBar` for continuity with the callers that predate the
 * 2026-08-19 audit. The name is now a mild lie and the audit explains why: this
 * control is not a top-level tab bar at all, it is a segmented control inside
 * the sidebar. It is used for reporting and for anchoring BetterClaude's own
 * adjacent tab — never for repositioning or intercepting Claude's own chrome.
 */
function findTopTabBar(root) {
  return resolveTarget("modeSwitch", { root });
}

/**
 * Run every region's detection and derive an overall status.
 *
 * @returns {{status: string, regions: Array, root: Element|null, signedIn: boolean, summary: string}}
 */
function probeLayout() {
  const { root, signedIn, targets } = resolveAll();

  const regions = STATUS_REGIONS.map((key) => {
    const t = targets[key];
    return {
      key,
      label: t.label,
      required: t.required,
      why: t.why,
      found: t.found,
      via: t.via,
      tier: t.tier,
      absentOk: t.absentOk,
      element: t.element,
    };
  });

  const missingRequired = regions.filter((r) => r.required && !r.found);

  // Two distinct things degrade confidence, and conflating them produced a
  // permanent false `partial` once already:
  //
  //   found, but not via a primary selector — real signal. An exact identifier
  //                                stopped matching, so this region is one
  //                                Anthropic change from not resolving at all.
  //   not found at all           — only a signal when the region is supposed to
  //                                be there. A composer on the sign-in page is
  //                                correctly absent, and reporting it as
  //                                degraded means the field reads "partial"
  //                                forever and stops being worth reading.
  const degraded = regions.filter((r) => (r.found ? r.tier !== "primary" : !r.absentOk));

  let status;
  if (missingRequired.length) status = "unrecognized";
  else if (degraded.length) status = "partial";
  else status = "recognized";

  // "absent" and "MISSING" are deliberately different words: the first is a
  // region that is correctly not here, the second is one that should have been.
  // Reading a summary line is the main way this gets debugged, so the two must
  // not look alike.
  const summary = regions
    .map((r) => (r.found ? `${r.key}=${r.tier}:${r.via}` : `${r.key}=${r.absentOk ? "absent" : "MISSING"}`))
    .join(" ");

  return { status, regions, root, signedIn, summary };
}

/**
 * Apply the probe's conclusions to the DOM as markers.
 *
 * Additive and namespaced: the root marker class, the body status class the
 * `bc-layout-unrecognized` rules key off, a `bc-signed-out` class for the
 * contextual-chrome rules, and one `bc-miss-<target>` class per region that
 * should have resolved and didn't. That last set is what lets a stylesheet park
 * an injected control in a safe floating position instead of anchoring it into
 * a container that no longer exists — degradation expressed in CSS rather than
 * as a crash.
 *
 * Nothing here restyles, moves, or removes any of Claude's elements.
 */
function applyLayoutMarkers(probe) {
  // Clear any previous marker so exactly one element carries it. This is about
  // keeping the CSS selectors unambiguous, NOT about making the probe
  // re-runnable — the adapter's ROOT_MARKER_CLASS exemption handles that, and
  // it has to, because this function runs after the probe rather than before.
  //
  // Whole-document scope rather than just the current candidates: after a soft
  // update the previous root may already be detached from <body>, and a marker
  // left on a detached node is harmless, whereas one left on a live sibling
  // would have `body > .bc-claude-root` styling two elements at once.
  document.querySelectorAll(`.${ROOT_MARKER_CLASS}`).forEach((el) => {
    el.classList.remove(ROOT_MARKER_CLASS);
  });
  if (probe.root) probe.root.classList.add(ROOT_MARKER_CLASS);

  if (!document.body) return;
  const { classList } = document.body;

  Object.values(STATUS_CLASSES).forEach((cls) => classList.remove(cls));
  classList.add(STATUS_CLASSES[probe.status] || STATUS_CLASSES.unrecognized);

  // Signed-in state is now decided by the probe (account button OR composer),
  // not by the composer alone. Anthropic's /code route is signed in and has no
  // composer, so the old inference marked it signed-out, applied the sign-in
  // geometry branch, and unmounted the cursor FX there.
  classList.toggle("bc-signed-out", !probe.signedIn);

  probe.regions.forEach((r) => {
    classList.toggle(`bc-miss-${r.key}`, !r.found && !r.absentOk);
  });
}

/**
 * Mounts the probe. Returns { check, checkSoon, getStatus, unmount }.
 *
 * No MutationObserver of its own, deliberately. preload already runs one over
 * the app root (`chromeObserver` -> syncContextualChrome) and a route watcher
 * from core/claude-dom.js; a second observer on the same subtree would double
 * the work on every DOM change to save one call site.
 *
 * Re-probing on DOM change (not only at bootstrap) is the entire point. A full
 * reload hands preload a brand-new realm and re-runs all of this, so cold loads
 * were never the risk; the gap was claude.ai soft-updating its shell in place,
 * which is precisely when a new Anthropic build first appears — with no
 * navigation event to hang re-detection off.
 *
 * @param {Function} onChange Called with the probe result only when the status
 *                            or region signature actually changes.
 * @param {boolean}  verbose  Log every transition (development builds).
 *                            Downgrades warn regardless of this flag.
 */
function mountLayoutProbe({
  onChange = null,
  verbose = false,
  log = console.log,
  warn = console.warn,
  // A genuinely persistent condition is one bug however many route changes
  // rediscover it, and a warning repeated on every DOM mutation burst is
  // indistinguishable from noise. Learned the hard way — before the tab-bar
  // detector was shape-constrained, its false positive re-warned on every
  // navigation.
  maxWarnings = 5,
} = {}) {
  let last = null;
  let scheduled = null;
  let warnings = 0;
  const reportMiss = createMissReporter({ warn });

  function check() {
    const probe = probeLayout();
    applyLayoutMarkers(probe);

    // One `[BetterClaude][inject-miss]` line per target that should have been
    // there and wasn't. Deduped internally by target name, so this is safe to
    // call on every probe.
    probe.regions.forEach((r) => {
      if (!r.found && !r.absentOk) reportMiss(r.key);
    });

    // Dedupe on the full signature, not just the status: a region quietly
    // switching from an exact selector to a heuristic keeps the status at
    // "partial" but is exactly the early warning this module exists to give.
    const signature = `${probe.status}|${probe.summary}`;
    if (signature !== last) {
      const isFirstProbe = last === null;
      last = signature;
      const mayWarn = warnings < maxWarnings;
      if (probe.status !== "recognized" && mayWarn) warnings += 1;
      if (probe.status === "unrecognized" && mayWarn) {
        warn(
          "[BetterClaude] Claude UI structure: UNRECOGNIZED. No application root found under <body>, " +
            "so page-geometry injection is suppressed (see the bc-layout-unrecognized rules in " +
            `ui/title-bar.css). Regions: ${probe.summary}`
        );
      } else if (probe.status === "partial" && !isFirstProbe && mayWarn) {
        // Not warned on the very first probe: "partial" is the normal state on
        // the signed-out route and during the first frames of a cold load, so
        // warning there would cry wolf. A *transition* into partial mid-session
        // is the interesting event.
        warn(
          "[BetterClaude] Claude UI structure: PARTIALLY RECOGNIZED — at least one region resolved " +
            `via a weaker selector than its primary. Regions: ${probe.summary}`
        );
      } else if (verbose) {
        log(`[BetterClaude] Claude UI structure: ${probe.status.toUpperCase()}. Regions: ${probe.summary}`);
      }
      if (onChange) onChange(probe);
    }
    return probe;
  }

  // Layout in the top band settles a frame or two after a route change, so an
  // immediate probe can read a half-built tree and report a shape that never
  // existed.
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
  attemptedSelectors,
  STATUS_REGIONS,
  ROOT_MARKER_CLASS,
  STATUS_CLASSES,
};
