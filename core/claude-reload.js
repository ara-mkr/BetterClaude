/**
 * claude.ai's own "refresh to update" prompt — detection and reporting.
 *
 * SCOPE, because the name invites the wrong assumption: this has nothing to do
 * with BetterClaude's own updates. Those come from electron-updater over GitHub
 * Releases and surface through core/update-banner.js, which is a BetterClaude
 * surface with BetterClaude buttons. THIS module is about Anthropic's own
 * in-page prompt asking the user to reload claude.ai because a new build of the
 * web app has shipped. The two must never be confused by the code or by the
 * user, so nothing here renders anything, and the log line it emits is tagged
 * `[BetterClaude][claude-reload-prompt]` rather than anything mentioning
 * "update".
 *
 * WHAT IT DOES NOT DO, and this is a hard constraint rather than an omission:
 * it never clicks the prompt, never hides it, never dismisses it, and never
 * intercepts, delays, or blocks the reload. Anthropic's reload is Anthropic's
 * to perform; a wrapper that swallowed it would leave the user on a stale build
 * with no way to know. Detection here is purely observational.
 *
 * WHY DETECTION IS NOT THE RECOVERY MECHANISM
 *
 * The 2026-08-19 audit could not capture this prompt's real markup: no update
 * was pending during the audit window, and one cannot be forced. 21 candidate
 * containers matched the right *shapes* on /new and none carried
 * refresh/reload copy. So every pattern below is an educated guess, and a
 * recovery path built on a guessed selector is a recovery path that fails
 * exactly when it is needed.
 *
 * Recovery therefore does not depend on this module at all. Re-injection hangs
 * off Electron's `dom-ready`/`did-finish-load` on the main webContents (see
 * electron/main.js), which fire whether or not anyone recognised what caused
 * the reload — including a reload the user triggered by hand, one Anthropic's
 * service worker performed, or a crash recovery. This module's entire job is to
 * make the prompt *observable*: the first time a real one appears in front of a
 * real user, it prints its own structure so the next version of this file can
 * stop guessing.
 *
 * DOM-only and dependency-free, so the extension build gets it unchanged.
 */

const { normalizeLabel, queryAll } = require("./claude-dom");

// Containers an in-page notice plausibly uses. Ordered widest-to-narrowest so
// the log shows the most semantic match first when several fire.
const CANDIDATE_CONTAINERS = [
  '[role="alert"]',
  '[role="status"]',
  "[aria-live]",
  '[data-testid*="update" i]',
  '[data-testid*="refresh" i]',
  '[data-testid*="reload" i]',
  '[class*="toast" i]',
  '[class*="banner" i]',
];

// Copy patterns. English-only and therefore incomplete by construction — a
// localized client would say none of this. That is a known limitation and the
// reason the structural half above exists too: a `[role="alert"]` that appeared
// and stayed is worth logging even when we cannot read it.
const COPY_PATTERNS = [
  /\bnew version\b/i,
  /\brefresh\b.{0,30}\bupdate\b/i,
  /\bupdate\b.{0,30}\brefresh\b/i,
  /\breload\b.{0,30}\b(update|version|page)\b/i,
  /\brestart\b.{0,30}\b(update|apply)\b/i,
  /\bout of date\b/i,
  /\bupdate available\b/i,
];

/** A compact, PII-free description of a node, for the diagnostic line. */
function describeForLog(el) {
  const parts = [el.tagName.toLowerCase()];
  if (el.id) parts.push(`#${el.id}`);
  const testid = el.getAttribute("data-testid");
  if (testid) parts.push(`[data-testid="${testid}"]`);
  const role = el.getAttribute("role");
  if (role) parts.push(`[role="${role}"]`);
  const live = el.getAttribute("aria-live");
  if (live) parts.push(`[aria-live="${live}"]`);
  const classes = Array.prototype.slice.call(el.classList || [], 0, 4);
  if (classes.length) parts.push(`.${classes.join(".")}`);
  return parts.join("");
}

/**
 * Scan for a prompt.
 *
 * Returns `{ element, matchedBy, signature }` or null. `matchedBy` records
 * whether the copy or only the container shape matched, because those are
 * different levels of confidence and the log should say which one it had.
 */
function findReloadPrompt() {
  for (const selector of CANDIDATE_CONTAINERS) {
    for (const el of queryAll(selector)) {
      // Bounded: a notice is a short strip of text. Reading further would mean
      // walking into conversation content, which this app does not do.
      const text = normalizeLabel(el.textContent).slice(0, 200);
      if (!text || text.length > 200) continue;
      const pattern = COPY_PATTERNS.find((re) => re.test(text));
      if (!pattern) continue;
      return {
        element: el,
        matchedBy: `copy:${pattern.source}`,
        signature: `${describeForLog(el)} via ${selector}`,
      };
    }
  }
  return null;
}

// Containers claude.ai portals overlay content into. These sit OUTSIDE the app
// root, which is the whole reason this module needs an observer of its own.
const PORTAL_CONTAINERS = ["#portal-root", "[data-base-ui-portal]"];

/**
 * Watch for the prompt and report it once.
 *
 * THIS ONE DOES NEED ITS OWN OBSERVER, unlike core/layout-probe.js and
 * core/top-strip-guard.js, which deliberately piggyback on the observer preload
 * already runs. That observer is scoped to claude.ai's app root — correctly, to
 * avoid a self-feeding loop over our own body-level chrome — and an in-page
 * notice is exactly the kind of thing React portals to `#portal-root` or a
 * `[data-base-ui-portal]` container, both of which are siblings of the app root
 * rather than descendants. Verified by planting a synthetic banner during QA:
 * appended to <body>, it produced no mutation the app-root observer could see,
 * and the detector never ran.
 *
 * Cost is bounded deliberately: <body> is watched for DIRECT children only (no
 * subtree — that would be the entire page), and each portal container is
 * watched with subtree, which is cheap because a portal holds one overlay at a
 * time. The callback only schedules a debounced scan.
 *
 * @param {Function} onDetected Called once per distinct prompt signature.
 * @param {Function} warn       Injected for testability.
 */
function mountClaudeReloadWatch({ onDetected = null, warn = console.warn } = {}) {
  const seen = new Set();
  let observer = null;
  let scheduled = null;
  const observed = new Set();

  function check() {
    let hit = null;
    try {
      hit = findReloadPrompt();
    } catch (_err) {
      // A detector that throws must read as "nothing found". It is a
      // diagnostic; it may not be the thing that breaks the page.
      return null;
    }
    if (!hit || seen.has(hit.signature)) return hit;
    seen.add(hit.signature);
    warn(
      "[BetterClaude][claude-reload-prompt] claude.ai appears to be asking for a page reload " +
        "(this is Anthropic's own prompt, NOT a BetterClaude update). BetterClaude does not " +
        "intercept it; injected UI re-applies automatically once the reload completes. " +
        `Matched ${hit.matchedBy} on ${hit.signature}`
    );
    if (onDetected) onDetected({ matchedBy: hit.matchedBy, signature: hit.signature });
    return hit;
  }

  // Layout and content settle a frame or two after a portal mounts, so an
  // immediate scan can read a half-built node. Same 250ms as the other watchers.
  function checkSoon() {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      check();
    }, 250);
  }

  /**
   * (Re)attach to <body> and to every portal container currently present.
   * Portal containers are created lazily by claude.ai, so this re-runs from the
   * body-level callback — a new portal root arrives as a body child addition,
   * which is precisely what that observer sees.
   */
  function attach() {
    if (typeof MutationObserver !== "function" || !document.body) return;
    if (!observer) observer = new MutationObserver(() => { attach(); checkSoon(); });
    if (!observed.has(document.body)) {
      observed.add(document.body);
      observer.observe(document.body, { childList: true, subtree: false });
    }
    PORTAL_CONTAINERS.forEach((selector) => {
      queryAll(selector).forEach((el) => {
        if (observed.has(el)) return;
        observed.add(el);
        observer.observe(el, { childList: true, subtree: true });
      });
    });
  }

  attach();

  function unmount() {
    if (scheduled) clearTimeout(scheduled);
    scheduled = null;
    if (observer) observer.disconnect();
    observer = null;
    observed.clear();
  }

  return { check, checkSoon, findReloadPrompt, unmount };
}

module.exports = {
  mountClaudeReloadWatch,
  findReloadPrompt,
  CANDIDATE_CONTAINERS,
  COPY_PATTERNS,
};
