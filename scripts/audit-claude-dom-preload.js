/**
 * Renderer half of the live claude.ai DOM audit (scripts/audit-claude-dom.js).
 *
 * Runs as a preload against the REAL claude.ai, in the app's persisted
 * session, so what it reports is the actual shipped DOM rather than a
 * synthetic fixture. scripts/audit-layout-probe.js already covers the
 * synthetic side — it proves core/layout-probe.js behaves correctly against
 * shapes we invent. This covers the half that fixture can never answer: what
 * shape Anthropic is shipping *today*.
 *
 * Two rules govern everything below, and both are about not exporting the
 * user's data into a file that ends up in a public repo:
 *
 *   1. Developer-authored identifiers (data-testid, class tokens, ids, roles)
 *      are captured verbatim. They are Anthropic's markup, they are what the
 *      adapter has to key off, and they carry no user content.
 *   2. Anything that could be user content — text nodes, aria-labels — is run
 *      through safeText(), which emits the string ONLY if every word in it is
 *      in a fixed vocabulary of UI-chrome words. Everything else is reduced to
 *      `<redacted:N>`, preserving the fact that text exists and how long it is
 *      without ever recording a conversation title or a project name.
 *
 * Nothing here writes to the page, clicks anything, reads storage, or touches
 * an auth surface. It measures and reports.
 */
const { ipcRenderer } = require("electron");

// Words that can appear verbatim in the report. Deliberately a closed list:
// an allowlist fails safe (an unrecognised label is redacted), whereas a
// denylist of "things that look like chat titles" fails open on the first
// title nobody thought of.
const CHROME_WORDS = new Set(
  (
    "home code chat cowork new search projects project artifacts artifact scheduled dispatch " +
    "customize beta view all pinned chats and tasks instructions memory context files knowledge " +
    "settings share reload refresh update updated version restart later dismiss upgrade pro max " +
    "free sidebar toggle pin unpin close menu open back forward help feedback account profile log " +
    "out sign in available now to a is the please page app click here apply install got it dismiss " +
    "sonnet opus haiku extra model send stop attach voice dictate skills type for star favorite " +
    "rename delete archive export copy edit add remove more options actions panel tab tabs of on off " +
    "recents starred library usage plan team workspace org organization keyboard shortcuts theme " +
    "light dark system notification notifications connectors integrations mcp tools agent agents " +
    "1 2 3 4 5 6 7 8 9 0"
  ).split(/\s+/)
);

// claude.ai draws its icons with a private-use-area icon font rendered inside
// the same element as the label, so `button.textContent` is "\ue08aHome", not
// "Home". Every text comparison in this file goes through here first —
// forgetting it is why an exact-match text heuristic silently finds nothing.
function normalizeText(raw) {
  return String(raw == null ? "" : raw)
    .replace(/[\uE000-\uF8FF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeText(raw, max = 60) {
  const t = normalizeText(raw);
  if (!t) return "";
  if (t.length <= max) {
    const words = t
      .toLowerCase()
      .replace(/[^a-z0-9+· -]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (words.length && words.every((w) => CHROME_WORDS.has(w))) return t;
  }
  return `<redacted:${t.length}>`;
}

function rectOf(el) {
  try {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  } catch {
    return null;
  }
}

// Tailwind means a single element can carry 40+ class tokens. Capped, and the
// count is reported alongside so a truncated list is never mistaken for a
// short one.
function classInfo(el) {
  const list = el.classList;
  if (!list || !list.length) return { count: 0, sample: [] };
  return { count: list.length, sample: Array.prototype.slice.call(list, 0, 8) };
}

function describe(el) {
  if (!el || el.nodeType !== 1) return null;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    testid: el.getAttribute("data-testid"),
    role: el.getAttribute("role"),
    ariaLabel: el.hasAttribute("aria-label") ? safeText(el.getAttribute("aria-label")) : null,
    ariaSelected: el.getAttribute("aria-selected"),
    ariaCurrent: el.getAttribute("aria-current"),
    href: el.tagName === "A" ? (el.getAttribute("href") || "").split("?")[0] : null,
    dataAttrs: Array.prototype.filter
      .call(el.attributes || [], (a) => a.name.startsWith("data-") && a.name !== "data-testid")
      .slice(0, 8)
      .map((a) => `${a.name}=${safeText(a.value, 24)}`),
    classes: classInfo(el),
    rect: rectOf(el),
    text: safeText(el.textContent, 40),
  };
}

/** Ancestor chain as a compact, selector-ish path. */
function pathOf(el, depth = 7) {
  const parts = [];
  let n = el;
  while (n && n.nodeType === 1 && parts.length < depth && n !== document.documentElement) {
    let seg = n.tagName.toLowerCase();
    if (n.id) seg += `#${n.id}`;
    const tid = n.getAttribute("data-testid");
    if (tid) seg += `[data-testid="${tid}"]`;
    const role = n.getAttribute("role");
    if (role) seg += `[role="${role}"]`;
    parts.unshift(seg);
    n = n.parentElement;
  }
  return parts.join(" > ");
}

function q(sel) {
  try {
    return document.querySelector(sel);
  } catch {
    return null;
  }
}
function qa(sel) {
  try {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  } catch {
    return [];
  }
}

/** Every distinct data-testid on the page, with one representative sample. */
function testidInventory() {
  const map = new Map();
  qa("[data-testid]").forEach((el) => {
    const key = el.getAttribute("data-testid");
    if (!map.has(key)) map.set(key, { testid: key, count: 0, sample: null, path: null });
    const entry = map.get(key);
    entry.count += 1;
    if (!entry.sample) {
      entry.sample = describe(el);
      entry.path = pathOf(el);
    }
  });
  return [...map.values()].sort((a, b) => a.testid.localeCompare(b.testid));
}

/** Elements whose own label reads exactly "Home" or "Code" (the new tabs). */
function tabCandidates() {
  const wanted = /^(home|code|chat|cowork|instructions|memory|context|scheduled|files|knowledge)$/i;
  return qa("a, button, [role='tab'], [role='link'], [data-mode]")
    .filter((el) => {
      const t = normalizeText(el.textContent);
      const al = normalizeText(el.getAttribute("aria-label"));
      return wanted.test(t) || wanted.test(al);
    })
    .slice(0, 20)
    .map((el) => ({
      label: safeText(el.textContent || el.getAttribute("aria-label")),
      ...describe(el),
      path: pathOf(el),
      parent: describe(el.parentElement),
      parentPath: el.parentElement ? pathOf(el.parentElement) : null,
      grandparent: describe(el.parentElement && el.parentElement.parentElement),
    }));
}

/**
 * Lowest common ancestor of the Home/Code controls — i.e. the actual tab-bar
 * container, whatever Anthropic calls it. Derived rather than guessed, because
 * a guessed container is exactly the single-point-of-failure selector this
 * whole exercise exists to remove.
 */
function commonAncestorOf(labels) {
  const els = qa("a, button, [role='tab'], [data-mode]").filter(
    (el) => labels.test(normalizeText(el.textContent)) || labels.test(normalizeText(el.getAttribute("aria-label")))
  );
  if (els.length < 2) return null;
  const chain = (el) => {
    const out = [];
    for (let n = el; n; n = n.parentElement) out.unshift(n);
    return out;
  };
  const chains = els.map(chain);
  let lca = null;
  for (let i = 0; i < chains[0].length; i += 1) {
    const node = chains[0][i];
    if (chains.every((c) => c[i] === node)) lca = node;
    else break;
  }
  if (!lca) return null;
  return {
    ...describe(lca),
    path: pathOf(lca),
    childCount: lca.children.length,
    children: Array.prototype.slice.call(lca.children, 0, 8).map(describe),
    parent: describe(lca.parentElement),
    parentPath: lca.parentElement ? pathOf(lca.parentElement) : null,
    computed: (() => {
      const cs = getComputedStyle(lca);
      return {
        position: cs.position,
        display: cs.display,
        flexDirection: cs.flexDirection,
        zIndex: cs.zIndex,
      };
    })(),
  };
}

/** Candidate "reload to update" prompts. Structure only — copy is redacted. */
function updatePromptCandidates() {
  const hits = [];
  const re = /(refresh|reload|restart|new version|update available|out of date)/i;
  qa("[role='alert'], [role='status'], [aria-live], [class*='toast' i], [class*='banner' i], [data-testid*='update' i], [data-testid*='refresh' i]").forEach(
    (el) => {
      hits.push({ how: "structural", ...describe(el), path: pathOf(el), matchesCopy: re.test(el.textContent || "") });
    }
  );
  // Text sweep, bounded to small leaf-ish nodes so this can't walk the whole
  // conversation looking for the word "update".
  qa("button, a, div, span").forEach((el) => {
    if (hits.length > 40) return;
    const t = (el.textContent || "").trim();
    if (t.length > 80 || !re.test(t)) return;
    if (el.querySelector("button, a")) return;
    hits.push({ how: "copy-match", ...describe(el), path: pathOf(el) });
  });
  return hits.slice(0, 40);
}

function survey() {
  const bodyChildren = document.body
    ? Array.prototype.slice.call(document.body.children).map((el) => ({
        ...describe(el),
        descendants: el.getElementsByTagName("*").length,
        computedDisplay: getComputedStyle(el).display,
        computedPosition: getComputedStyle(el).position,
      }))
    : [];

  const navs = qa("nav").map((el) => ({ ...describe(el), path: pathOf(el), childCount: el.children.length }));

  return {
    url: location.href.split("?")[0],
    ts: new Date().toISOString(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    supports: {
      hasSelector: (() => {
        try {
          document.querySelector(":has(*)");
          return true;
        } catch {
          return false;
        }
      })(),
    },
    bodyChildren,
    landmarks: {
      navs,
      headers: qa("header").map((el) => ({ ...describe(el), path: pathOf(el) })),
      asides: qa("aside").map((el) => ({ ...describe(el), path: pathOf(el) })),
      mains: qa("main").map((el) => ({ ...describe(el), path: pathOf(el) })),
      tablists: qa("[role='tablist']").map((el) => ({ ...describe(el), path: pathOf(el) })),
      tabs: qa("[role='tab']").map((el) => ({ ...describe(el), path: pathOf(el) })),
      dialogs: qa("[role='dialog']").map((el) => ({ ...describe(el), path: pathOf(el) })),
    },
    tabCandidates: tabCandidates(),
    tabBarContainer: commonAncestorOf(/^(home|code)$/i),
    rightPanelContainer: commonAncestorOf(/^(instructions|memory|context|scheduled)$/i),
    modeSwitch: (() => {
      // The live shape as of the audit: a [role="group"] of [data-mode] pills
      // inside [data-testid="sidebar"]. Captured explicitly so a future run
      // shows at a glance whether this specific shape still holds.
      const g = q('[data-testid="sidebar"] [role="group"]');
      if (!g) return null;
      return {
        ...describe(g),
        path: pathOf(g),
        pills: Array.prototype.slice.call(g.children).map((c) => ({
          ...describe(c),
          mode: c.getAttribute("data-mode"),
          active: c.hasAttribute("data-active"),
        })),
      };
    })(),
    composer: (() => {
      const el = q('[data-testid="chat-input"]') || q('div[contenteditable="true"]') || q("textarea");
      return el ? { ...describe(el), path: pathOf(el) } : null;
    })(),
    sidebarProbes: {
      byAriaLabel: (() => {
        const el = q('nav[aria-label*="sidebar" i]');
        return el ? { ...describe(el), path: pathOf(el) } : null;
      })(),
      byPinToggle: (() => {
        const el = q('nav:has([data-testid="pin-sidebar-toggle"])');
        return el ? { ...describe(el), path: pathOf(el) } : null;
      })(),
      firstNav: navs[0] || null,
    },
    testids: testidInventory(),
    updatePromptCandidates: updatePromptCandidates(),
  };
}

// The probe the shipping app actually uses, run against this same live page.
// Required from ../core the same way electron/preload.js requires it, so the
// report reflects the code path that actually ships rather than a re-import of
// the bundle (which is an IIFE and exports nothing to require()).
function runShippedProbe() {
  try {
    const { probeLayout, findTopTabBar } = require("../core/layout-probe");
    const probe = probeLayout();
    const tabBar = findTopTabBar(probe.root);
    return {
      status: probe.status,
      summary: probe.summary,
      regions: probe.regions.map(({ key, found, tier, via, required, absentOk }) => ({
        key,
        found,
        tier,
        via,
        required,
        absentOk,
      })),
      findTopTabBar: tabBar ? { via: tabBar.via, tier: tabBar.tier, described: describe(tabBar.element) } : null,
    };
  } catch (err) {
    return { error: String((err && err.stack) || err) };
  }
}

ipcRenderer.on("audit:collect", (_e, { tag }) => {
  let payload;
  try {
    payload = { tag, ok: true, survey: survey(), shippedProbe: runShippedProbe() };
  } catch (err) {
    payload = { tag, ok: false, error: String((err && err.stack) || err) };
  }
  ipcRenderer.send("audit:result", payload);
});

ipcRenderer.on("audit:wait-for-app", () => {
  const deadline = Date.now() + 30000;
  const tick = () => {
    const ready = !!document.querySelector('[data-testid="chat-input"]') || !!document.querySelector("nav");
    if (ready || Date.now() > deadline) {
      ipcRenderer.send("audit:app-ready", { ready, signedIn: !!document.querySelector('[data-testid="chat-input"]') });
      return;
    }
    setTimeout(tick, 400);
  };
  tick();
});
