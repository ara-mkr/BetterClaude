/**
 * claude.ai DOM adapter — the single place that knows what Anthropic's markup
 * looks like.
 *
 * WHY THIS EXISTS
 *
 * Until now, every module that needed a piece of claude.ai's DOM named it
 * inline: `core/theme-engine.js` had a SELECTORS map, `core/tokens.js` wrote
 * `nav:has([data-testid="pin-sidebar-toggle"])` eight separate times,
 * `core/layout-probe.js` had its own chain, `electron/preload.js` queried
 * `[data-testid="chat-input"]` directly. Each of those was ONE selector with no
 * alternative, and CSS/`querySelector` both fail silently when a selector stops
 * matching — so an Anthropic release doesn't break the app loudly, it quietly
 * turns features off. The 2026-08-19 audit (docs/dom-audit-2026-08-19.md) found
 * exactly that: the sidebar became `<aside aria-label="Sidebar">`, and every
 * sidebar rule in the app had been inert for some unknown number of releases.
 *
 * So this module inverts the arrangement. Callers ask for a NAMED TARGET —
 * `resolve("sidebar")` — and this file owns the ordered list of ways to find
 * one. Adding a new Anthropic shape is a one-line edit here instead of a
 * grep-and-hope across four files.
 *
 * THREE RULES, each of which is a bug we actually hit:
 *
 * 1. Every target has at least two strategies, and the last one is structural
 *    (geometry/containment) rather than nominal. A structural strategy keeps
 *    working across a rename, which is the change Anthropic makes most often.
 *
 * 2. No strategy may return one of BetterClaude's own nodes. The audit caught
 *    `layout-probe`'s `document.querySelector("nav")` fallback resolving to
 *    OUR settings-panel nav (`nav.bc-sp-nav`) — the only `<nav>` left in the
 *    document. That is worse than a miss: a miss degrades, a confident wrong
 *    answer styles and measures the wrong element while reporting success.
 *
 * 3. A total miss warns in one fixed, greppable format and returns null. It
 *    never throws. A selector can *throw* rather than miss — `querySelector`
 *    raises SyntaxError on a selector the engine can't parse, which is what an
 *    unsupported `:has()` does on older Chromium — and a resolver that dies
 *    takes the whole preload bootstrap with it.
 *
 * DOM-only and dependency-free (bar the ownership helper), so the browser
 * extension build gets the identical behaviour.
 */

const { OWN_ID_PREFIXES } = require("./top-strip-guard");

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

// Marker class applied to whichever element turns out to be claude.ai's app
// root. Declared here rather than further down because the ownership test
// below has to know about it before anything else can run.
const ROOT_MARKER_CLASS = "bc-claude-root";

/** True for a `bc-` class that really does mean "BetterClaude owns this". */
function isOwnClass(cls) {
  // ROOT_MARKER_CLASS is the one `bc-` class we put on an element that is
  // emphatically NOT ours — it means "this is claude.ai's root". Counting it as
  // ownership is catastrophic and non-obvious: the first resolution of a
  // document marks the root, and every subsequent one then rejects both that
  // root AND (because the test walks ancestors) every single element inside it,
  // so the app resolves everything correctly once and resolves nothing at all
  // from the first route change onward. Caught by the re-probe assertion in
  // scripts/audit-layout-probe.js rather than by reading, twice now.
  return String(cls).startsWith("bc-") && cls !== ROOT_MARKER_CLASS;
}

/**
 * True if `el` is BetterClaude's own chrome, or lives inside it.
 *
 * Near-identical to top-strip-guard's isOwnChrome, and deliberately a separate
 * function rather than a shared one: that guard is asking "would a click here
 * hit Claude's UI?", where the root marker is irrelevant, while this is asking
 * "may this element be returned as a claude.ai target?", where the marker must
 * be exempt. Merging them means one of the two questions gets the wrong answer.
 *
 * The walk stops before <body> and <html> because we set marker classes on body
 * itself (`bc-signed-out`, `bc-layout-*`); a walk that reached it would
 * classify every element on the page as ours.
 */
function isOwnNode(el) {
  if (!el || el.nodeType !== 1) return false;
  const stopAt = [document.body, document.documentElement];
  for (let n = el; n && n.nodeType === 1 && !stopAt.includes(n); n = n.parentElement) {
    const id = n.id || "";
    if (OWN_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) return true;
    // classList, not className: claude.ai renders SVG elements whose
    // .className is an SVGAnimatedString — string methods on it throw.
    const classes = n.classList;
    if (classes && Array.prototype.some.call(classes, isOwnClass)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

/**
 * Normalise a label for text-content matching.
 *
 * claude.ai draws its icons with a private-use-area icon font rendered INSIDE
 * the same element as the label, so the Home pill's `textContent` is
 * "\ue08aHome", not "Home". Every exact-match text heuristic must strip the PUA
 * range first or it silently matches nothing — this bit the audit script on its
 * own first run, and it is precisely the kind of failure that looks like "the
 * element is gone" when the element is right there.
 */
function normalizeLabel(raw) {
  return String(raw == null ? "" : raw)
    .replace(/[\uE000-\uF8FF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalised `aria-label` first, then normalised text. */
function labelOf(el) {
  if (!el || el.nodeType !== 1) return "";
  const aria = normalizeLabel(el.getAttribute && el.getAttribute("aria-label"));
  if (aria) return aria;
  return normalizeLabel(el.textContent);
}

// ---------------------------------------------------------------------------
// Query primitives — never throw, never return our own chrome
// ---------------------------------------------------------------------------

/**
 * `querySelectorAll` that survives an unparseable selector and filters out
 * BetterClaude's own DOM.
 *
 * `scope` is a hint, not a guarantee: several targets legitimately live outside
 * the app root (portalled dialogs), so a null scope falls back to `document`.
 */
function queryAll(selector, scope) {
  const root = scope && scope.querySelectorAll ? scope : document;
  let list;
  try {
    list = root.querySelectorAll(selector);
  } catch (_err) {
    // Unsupported/unparseable selector reads as "no match", not as a crash.
    return [];
  }
  return Array.prototype.filter.call(list, (el) => !isOwnNode(el));
}

function queryOne(selector, scope) {
  return queryAll(selector, scope)[0] || null;
}

/** Rendered box, or null for an element that generates none. */
function boxOf(el) {
  try {
    const r = el.getBoundingClientRect();
    if (!r || (r.width <= 0 && r.height <= 0)) return null;
    return r;
  } catch (_err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Structural finders (the strategies of last resort)
// ---------------------------------------------------------------------------

// Children of <body> that can never be the app root.
const NON_RENDERING_TAGS = new Set([
  "SCRIPT", "STYLE", "LINK", "META", "TITLE", "BASE", "TEMPLATE", "NOSCRIPT",
]);

/** Plausible hosts for claude.ai's app, among <body>'s children. */
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
 * Ranked by decisiveness, not by prettiness. "Contains the composer" beats
 * "has the most descendants" because a portalled dialog can briefly out-weigh
 * the shell in raw node count, while the composer only ever lives inside the
 * real app tree.
 *
 * Deliberately NOT ranked by rendered area: claude.ai's outermost shell wrapper
 * uses `display: contents` (verified live), which generates no box, so
 * area-based ranking would score the true root last — a plausible-looking
 * heuristic that fails only on the real site.
 */
function findAppRoot() {
  const candidates = rootCandidates();
  if (!candidates.length) return null;

  for (const id of ["root", "__next"]) {
    const match = candidates.find((el) => el.id === id);
    if (match) return { element: match, via: `body > #${id}`, tier: "primary" };
  }

  const composer = queryOne(COMPOSER_SELECTORS.join(","));
  if (composer) {
    const owner = candidates.find((el) => el.contains(composer));
    if (owner) return { element: owner, via: "contains composer", tier: "heuristic" };
  }

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
 * Structural sidebar detection: a tall, narrow, left-anchored column that
 * contains something only the sidebar contains.
 *
 * The containment test is what makes this safe. A bare "tall and narrow on the
 * left" test would also match a collapsed rail, a drag handle, or a skeleton
 * placeholder; requiring that the box actually holds the account button or the
 * mode switch means a match is the sidebar or nothing.
 */
function findSidebarStructurally(root) {
  const scope = root || document.body;
  if (!scope) return null;
  const anchor =
    queryOne('[data-testid="user-menu-button"]', scope) ||
    queryOne("[data-mode]", scope);
  if (!anchor) return null;

  const viewportH = window.innerHeight || 0;
  for (let el = anchor.parentElement; el && el !== document.body; el = el.parentElement) {
    if (isOwnNode(el)) return null;
    const box = boxOf(el);
    if (!box) continue;
    // A sidebar is a column: narrow, tall, and hard against the left edge.
    const tallEnough = box.height >= viewportH * 0.5;
    const narrowEnough = box.width > 0 && box.width <= 460;
    const leftAnchored = box.left <= 24;
    if (tallEnough && narrowEnough && leftAnchored) {
      return { element: el, via: `structural column ${Math.round(box.width)}x${Math.round(box.height)} at left`, tier: "heuristic" };
    }
  }
  return null;
}

/**
 * Lowest common ancestor of the mode pills, used when every nominal strategy
 * for the mode-switch container has missed.
 *
 * Derives the container from its contents rather than naming it, so it survives
 * a rename of the container itself — which is the more likely change, since the
 * pills carry the semantic attributes and the wrapper carries none.
 */
function findModeSwitchStructurally(root) {
  const pills = queryAll("button[data-mode], a[data-mode]", root || document);
  const named = queryAll("button, a, [role='tab']", root || document).filter((el) => {
    const label = labelOf(el);
    return label === "Home" || label === "Code";
  });
  const els = pills.length >= 2 ? pills : named;
  if (els.length < 2) return null;

  const chainOf = (el) => {
    const out = [];
    for (let n = el; n; n = n.parentElement) out.unshift(n);
    return out;
  };
  const chains = els.map(chainOf);
  let lca = null;
  for (let i = 0; i < chains[0].length; i += 1) {
    const node = chains[0][i];
    if (chains.every((c) => c[i] === node)) lca = node;
    else break;
  }
  if (!lca || lca === document.body || lca === document.documentElement) return null;
  return { element: lca, via: `common ancestor of ${els.length} mode controls`, tier: "heuristic" };
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

// Shared by findAppRoot() above and the composer target below, so the two can
// never disagree about what a composer is. `code-prompt-input` is the composer
// on Anthropic's own /code route — a signed-in route with no `chat-input`,
// which is exactly what broke the signed-out inference (see the audit, §5).
const COMPOSER_SELECTORS = [
  '[data-testid="chat-input"]',
  '[data-testid="code-prompt-input"]',
];

/**
 * Every region the injection layer depends on.
 *
 * `strategies` are tried in order. `tier` records HOW a target resolved, which
 * is the early-warning signal: a region that quietly drops from `primary` to
 * `fallback` still works today and is one Anthropic change from not resolving
 * at all. `required` marks the regions where a wrong answer is worse than no
 * answer, so geometry is suppressed rather than applied blind.
 */
const TARGETS = {
  appRoot: {
    label: "Application root",
    required: true,
    why: "Carries the containing-block transform that keeps Claude's fixed top chrome out of the title bar's band.",
    strategies: [{ find: () => findAppRoot() }],
  },

  sidebar: {
    label: "Sidebar (outer)",
    why: "Anchor for the sidebar theme rules, the width/order layout settings, and the horizontal offset of the embedded Code pane.",
    absenceIsNormal: ({ signedIn }) => !signedIn,
    strategies: [
      // Current build (2026-08-19). aria-label is Anthropic's own accessibility
      // contract, which makes it markedly more durable than a class or an id.
      { sel: 'aside[aria-label*="sidebar" i]', tier: "primary" },
      // Same element, found through the one child that has a testid, for the
      // case where the label is translated or dropped.
      { sel: 'aside:has([data-testid="sidebar"])', tier: "primary" },
      // Pre-2026-08 shape. Still `primary`, and the distinction matters: tier
      // records CONFIDENCE, not recency. This is an exact, Anthropic-authored
      // identifier that unambiguously names the sidebar — a build that reverts
      // to it is a build we fully recognise, not a degraded guess. Marking
      // known-good older shapes as `fallback` would report `partial` forever
      // on any revert, which is the cry-wolf failure this module already
      // learned once.
      { sel: 'nav:has([data-testid="pin-sidebar-toggle"])', tier: "primary" },
      // Class-based, so genuinely weaker: Tailwind-adjacent names churn.
      { sel: "aside.dframe-sidebar", tier: "fallback" },
      { sel: 'nav[aria-label*="sidebar" i]', tier: "fallback" },
      { find: (root) => findSidebarStructurally(root) },
    ],
  },

  sidebarInner: {
    label: "Sidebar content container",
    why: "The scrolling body of the sidebar; parent of the mode switch and the recents/projects lists.",
    absenceIsNormal: ({ signedIn }) => !signedIn,
    strategies: [
      { sel: '[data-testid="sidebar"]', tier: "primary" },
      { sel: "#frame-peek-popover", tier: "fallback" },
      // Structural: the tallest child of the sidebar that isn't the resize
      // handle or the 44px top row.
      {
        find: (root, ctx) => {
          const sidebar = ctx.get("sidebar");
          if (!sidebar) return null;
          let best = null;
          let bestH = 0;
          for (const child of sidebar.children) {
            const box = boxOf(child);
            if (!box || box.width < 80) continue;
            if (box.height > bestH) {
              best = child;
              bestH = box.height;
            }
          }
          return best ? { element: best, via: "tallest sidebar child", tier: "heuristic" } : null;
        },
      },
    ],
  },

  modeSwitch: {
    label: "Home / Code mode switch",
    why: "Anthropic's own segmented control. BetterClaude mounts its Code tab adjacent to it; it is never repurposed or intercepted.",
    absenceIsNormal: ({ signedIn }) => !signedIn,
    strategies: [
      // `data-segmented` + `data-pills` are developer-authored and semantic;
      // the surrounding Tailwind classes and the React `_r_*` ids are not.
      { sel: '[data-testid="sidebar"] [role="group"][data-segmented]', tier: "primary" },
      { sel: '[role="group"]:has(> [data-mode])', tier: "primary" },
      // ARIA tab semantics. Not what ships today, but it is the standard
      // shape and an exact contract if Anthropic moves to it — same reasoning
      // as the legacy sidebar selector above.
      { sel: '[role="tablist"]', tier: "primary" },
      { sel: '[data-testid="sidebar"] > [role="group"]', tier: "fallback" },
      { find: (root) => findModeSwitchStructurally(root) },
    ],
  },

  chatHeader: {
    label: "Content-area header",
    why: "Themed to match the app background. Must never match the header of an arbitrary panel — see the audit's stray-slab finding.",
    absenceIsNormal: () => true,
    strategies: [
      { sel: "main header", tier: "primary" },
      { sel: '[data-testid="page-header"]', tier: "fallback" },
      // css:false is load-bearing. A resolver tries strategies in order and
      // stops at the first hit, so a broad last-resort selector is harmless
      // here; a stylesheet has no such ordering — every selector in a list
      // applies at once. Emitting bare `header` into CSS is what painted the
      // theme background onto claude.ai's /code page header and left a stray
      // slab across the top of that surface (audit section 5).
      { sel: "header", tier: "fallback", css: false },
    ],
  },

  composer: {
    label: "Composer",
    why: "Insertion target for the prompt-library / file-sync features.",
    absenceIsNormal: ({ signedIn }) => !signedIn,
    strategies: [
      { sel: COMPOSER_SELECTORS.join(","), tier: "primary" },
      // Both are far too broad to paint unconditionally — every rich-text
      // field and every textarea on the page would match. Resolution-only.
      { sel: 'div[contenteditable="true"]', tier: "fallback", css: false },
      { sel: "main textarea", tier: "fallback", css: false },
    ],
  },

  accountButton: {
    label: "Account menu button",
    why: "The signed-in discriminator. Present on EVERY signed-in route including /code, which the composer is not.",
    absenceIsNormal: ({ signedIn }) => !signedIn,
    strategies: [
      { sel: '[data-testid="user-menu-button"]', tier: "primary" },
      { sel: 'button[aria-label*="account" i], button[aria-label*="profile" i]', tier: "fallback", css: false },
    ],
  },
};

// ---------------------------------------------------------------------------
// CSS bridge
// ---------------------------------------------------------------------------

/**
 * The same target, expressed as a CSS selector list.
 *
 * This is what removes the last class of single-point-of-failure selector from
 * the codebase. `core/tokens.js` used to write
 * `nav:has([data-testid="pin-sidebar-toggle"])` eight times by hand; when that
 * shape went away, all eight rules matched nothing and no runtime code was
 * involved to notice. Deriving the list from the same strategy table the
 * resolver uses means a stylesheet and a `querySelector` can never disagree
 * about what "the sidebar" is, and adding a new Anthropic shape fixes both at
 * once.
 *
 * Strategies flagged `css: false` are omitted — see the note on `chatHeader`.
 * Structural strategies have no selector and are skipped by construction; a
 * target whose only remaining answer is structural therefore contributes no
 * CSS, which is correct. Geometry that cannot be named cannot be styled, and
 * the `bc-miss-<target>` body class is how that case is handled instead.
 */
function cssSelectorList(name, { suffix = "" } = {}) {
  const target = TARGETS[name];
  if (!target) return "";
  return target.strategies
    .filter((st) => st.sel && st.css !== false)
    .map((st) => `${st.sel}${suffix}`)
    .join(",\n");
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The selectors a target would try, for the miss diagnostic. */
function attemptedSelectors(name) {
  const target = TARGETS[name];
  if (!target) return [];
  return target.strategies.map((s) => s.sel || "<structural heuristic>");
}

/**
 * Resolve one named target.
 *
 * @returns {{element: Element, via: string, tier: string}|null}
 */
function resolveTarget(name, { root = null, cache = null } = {}) {
  const target = TARGETS[name];
  if (!target) return null;
  const ctx = {
    get: (dep) => {
      if (cache && cache.has(dep)) {
        const hit = cache.get(dep);
        return hit ? hit.element : null;
      }
      const hit = resolveTarget(dep, { root, cache });
      return hit ? hit.element : null;
    },
  };

  for (const strategy of target.strategies) {
    let result = null;
    try {
      if (strategy.sel) {
        const el = queryOne(strategy.sel, root && root.querySelector ? root : document);
        if (el) result = { element: el, via: strategy.sel, tier: strategy.tier || "fallback" };
      } else if (strategy.find) {
        result = strategy.find(root, ctx);
      }
    } catch (_err) {
      // A strategy that throws reads as a miss and the next one is tried.
      result = null;
    }
    if (result && result.element && !isOwnNode(result.element)) return result;
  }
  return null;
}

/**
 * Resolve every target once.
 *
 * `signedIn` is derived from the account button rather than the composer.
 * That distinction is not cosmetic: Anthropic's /code route is signed in and
 * has no composer, so the old inference marked a signed-in route as signed-out,
 * applied the sign-in-page geometry branch, and unmounted the cursor FX and
 * companion there. See docs/dom-audit-2026-08-19.md §5.
 */
function resolveAll() {
  const cache = new Map();
  const rootHit = resolveTarget("appRoot", { cache });
  cache.set("appRoot", rootHit);
  const root = rootHit ? rootHit.element : null;

  Object.keys(TARGETS).forEach((name) => {
    if (name === "appRoot") return;
    cache.set(name, resolveTarget(name, { root, cache }));
  });

  const accountHit = cache.get("accountButton");
  const composerHit = cache.get("composer");
  const signedIn = !!(accountHit || composerHit);
  const context = { signedIn };

  const results = {};
  Object.keys(TARGETS).forEach((name) => {
    const target = TARGETS[name];
    const hit = cache.get(name) || null;
    const absenceIsNormal = target.absenceIsNormal || (() => false);
    results[name] = {
      key: name,
      label: target.label,
      required: !!target.required,
      why: target.why,
      found: !!hit,
      element: hit ? hit.element : null,
      via: hit ? hit.via : null,
      tier: hit ? hit.tier : null,
      absentOk: hit ? false : !!absenceIsNormal(context),
    };
  });

  return { root, signedIn, targets: results };
}

// ---------------------------------------------------------------------------
// Miss reporting
// ---------------------------------------------------------------------------

/**
 * One fixed, greppable line per missing target.
 *
 * The format is part of the contract — `[BetterClaude][inject-miss]` followed
 * by the target name and the selectors that were tried — so a user's console
 * paste is enough to identify which shape moved, without a repro. Deduped by
 * name: a target that is missing is one bug however many mutation bursts
 * rediscover it, and a warning repeated on every DOM change is
 * indistinguishable from noise.
 */
function createMissReporter({ warn = console.warn, maxWarnings = 12 } = {}) {
  const reported = new Set();
  let count = 0;
  return function reportMiss(name) {
    if (reported.has(name) || count >= maxWarnings) return;
    reported.add(name);
    count += 1;
    warn("[BetterClaude][inject-miss]", name, attemptedSelectors(name));
  };
}

// ---------------------------------------------------------------------------
// Startup self-check
// ---------------------------------------------------------------------------

/**
 * Run the adapter once against the live page and report pass/fail per target.
 *
 * Runs in packaged builds too. It costs one resolution pass at startup and is
 * the difference between a user reporting "the sidebar theme stopped working"
 * six releases late and reporting "it says inject-miss sidebar" immediately.
 */
function selfCheck({ log = console.log, warn = console.warn } = {}) {
  const { targets, signedIn } = resolveAll();
  const lines = [];
  let failures = 0;
  let degraded = 0;

  Object.keys(targets).forEach((name) => {
    const t = targets[name];
    if (t.found) {
      if (t.tier !== "primary") degraded += 1;
      lines.push(`  ${t.tier === "primary" ? "PASS" : "PASS*"} ${name} <- ${t.via}`);
    } else if (t.absentOk) {
      lines.push(`  n/a  ${name} (correctly absent here)`);
    } else {
      failures += 1;
      lines.push(`  FAIL ${name} (tried: ${attemptedSelectors(name).join(" | ")})`);
    }
  });

  const header =
    `[BetterClaude] DOM adapter self-check — ${failures} fail, ${degraded} via fallback, ` +
    `signedIn=${signedIn}`;
  if (failures) warn(`${header}\n${lines.join("\n")}`);
  else log(`${header}\n${lines.join("\n")}`);
  return { failures, degraded, signedIn, targets };
}

// ---------------------------------------------------------------------------
// SPA route watcher
// ---------------------------------------------------------------------------

/**
 * Fire a callback on every claude.ai route change.
 *
 * A MutationObserver alone does notice route changes — the DOM does change —
 * but only after the fact and mixed in with every other mutation, so a handler
 * that wants to run once per navigation has to debounce hard and still runs
 * late. History patching gives the exact event.
 *
 * `history.pushState`/`replaceState` are wrapped rather than replaced: the
 * original is always called first, with its return value passed through, so
 * claude.ai's own router is unaffected. Nothing here blocks, cancels, delays,
 * or rewrites a navigation — that would be intercepting Claude's routing, and
 * this app does not do that.
 */
function mountRouteWatcher({ onRouteChange, target = window } = {}) {
  if (typeof onRouteChange !== "function") return { unmount() {} };
  let lastPath = location.pathname + location.search;

  const fire = () => {
    const now = location.pathname + location.search;
    if (now === lastPath) return;
    lastPath = now;
    try {
      onRouteChange(now);
    } catch (err) {
      console.warn("[BetterClaude] route-change handler threw", err);
    }
  };

  const originals = {};
  ["pushState", "replaceState"].forEach((method) => {
    const original = history[method];
    if (typeof original !== "function") return;
    originals[method] = original;
    history[method] = function patched(...args) {
      const out = original.apply(this, args);
      fire();
      return out;
    };
  });

  target.addEventListener("popstate", fire);
  target.addEventListener("hashchange", fire);

  return {
    unmount() {
      Object.keys(originals).forEach((m) => { history[m] = originals[m]; });
      target.removeEventListener("popstate", fire);
      target.removeEventListener("hashchange", fire);
    },
  };
}

module.exports = {
  TARGETS,
  ROOT_MARKER_CLASS,
  COMPOSER_SELECTORS,
  isOwnNode,
  normalizeLabel,
  labelOf,
  queryAll,
  queryOne,
  boxOf,
  rootCandidates,
  findAppRoot,
  findSidebarStructurally,
  findModeSwitchStructurally,
  attemptedSelectors,
  cssSelectorList,
  resolveTarget,
  resolveAll,
  createMissReporter,
  selfCheck,
  mountRouteWatcher,
};
