#!/usr/bin/env electron
/**
 * Layout-probe audit — the companion to scripts/audit.js for the one thing
 * that script explicitly cannot check.
 *
 * audit.js is pure Node and says so: it verifies the token math and the
 * generated CSS, and honestly reports anything needing a browser as
 * UNVERIFIED-HERE. core/layout-probe.js is entirely browser-shaped — it asks
 * real layout questions (getBoundingClientRect, `:has()` support,
 * display:contents boxes) whose answers a DOM stub would have to fake, and a
 * faked answer would only prove the stub agrees with itself.
 *
 * So this runs in real Chromium, under the Electron already in
 * devDependencies — no new dependency, and the same engine version that ships.
 * Each case below is a synthetic <body> standing in for a claude.ai shape,
 * including the ones we cannot reach by hand: an app root Anthropic has
 * renamed, and a page with no app at all. Those are exactly the paths that
 * would otherwise stay untested until they happened in production.
 *
 *   npm run audit:layout
 */
const path = require("path");
const fs = require("fs");
const electron = require("electron");

const BUNDLE = path.join(__dirname, "../build/core.bundle.js");

// Re-exec as a real Electron app when we've been started with
// ELECTRON_RUN_AS_NODE=1 set in the environment.
//
// In that mode Electron boots as plain Node: there is no browser process, and
// `require("electron")` resolves to the *path string* of the binary rather than
// the API object — so `app` is undefined and this script dies on a confusing
// "Cannot read properties of undefined" with no hint that the environment is
// the cause. Some editor terminals and CI runners export it globally.
//
// The string that breaks the normal path is exactly the binary needed to fix
// it, so relaunch through it with the variable stripped. Done in-script rather
// than as `env -u ...` in the npm script because that syntax is POSIX-only and
// this repo also builds for Windows.
if (typeof electron === "string") {
  const { spawnSync } = require("child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env,
  });
  process.exit(child.status === null ? 1 : child.status);
}

const { app, BrowserWindow } = electron;

// Each case is a synthetic <body> plus the status and root the probe must
// report. Driving this off the real bundle rather than the source module also
// proves core/index.js actually re-exports the probe — a missing export there
// would leave the shipped extension build silently without version-awareness
// while the source looked fine.
const CASES = [
  {
    // THE CURRENT SHAPE, transcribed from docs/dom-audit-2026-08-19.md.
    // <aside aria-label="Sidebar">, a [role="group"][data-segmented] of
    // [data-mode] pills inside [data-testid="sidebar"], and no ARIA tab
    // semantics anywhere. Every one of those is different from what this
    // fixture asserted before the audit, which is the point: the old fixture
    // described a claude.ai that had already stopped existing, and passed.
    name: "Current shape (2026-08): aside sidebar + df-pills mode switch",
    body: `<div id="root">
             <div style="display:contents">
               <aside aria-label="Sidebar">
                 <div><a aria-label="Home" href="/new"></a><button aria-label="Collapse sidebar"></button></div>
                 <div id="frame-peek-popover" data-testid="sidebar">
                   <div role="group" data-segmented="true" data-pills="2">
                     <button data-mode="cowork" aria-label="Home" data-active="true">&#xE08A;Home</button>
                     <button data-mode="code" aria-label="Code">&#xE048;Code</button>
                   </div>
                   <button data-testid="user-menu-button">account</button>
                 </div>
               </aside>
               <main><header>chat header</header><div data-testid="chat-input">composer</div></main>
             </div>
           </div>`,
    status: "recognized",
    rootId: "root",
    expectSignedIn: true,
    expectSidebarVia: 'aside[aria-label*="sidebar" i]',
    expectMarkedHeader: 1,
  },
  {
    // The pre-2026-08 shape. Must ALSO read `recognized`, not `partial`:
    // an exact Anthropic-authored identifier we still recognise is not a
    // degraded guess, and reporting `partial` on a revert would re-create the
    // cry-wolf failure this module already learned once.
    name: "Legacy shape (pre-2026-08): nav sidebar + role=tablist",
    body: `<div id="root">
             <div role="tablist"><button role="tab">Home</button><button role="tab">Code</button></div>
             <nav><button data-testid="pin-sidebar-toggle">pin</button>
                  <button data-testid="user-menu-button">account</button></nav>
             <main><header>chat header</header><div data-testid="chat-input">composer</div></main>
           </div>`,
    status: "recognized",
    rootId: "root",
    expectSignedIn: true,
    expectSidebarVia: 'nav:has([data-testid="pin-sidebar-toggle"])',
  },
  {
    // REGRESSION TEST for the sharpest finding of the 2026-08-19 audit: on the
    // live app the ONLY <nav> left in the document is BetterClaude's own
    // settings-panel nav, and the old `first <nav>` fallback resolved the
    // sidebar to it. That is worse than a miss — a miss degrades, a confident
    // wrong answer measures and styles our own chrome while reporting success.
    // The sidebar here must resolve to the <aside>, never to nav.bc-sp-nav.
    name: "Our own settings-panel nav is the only <nav> - must not adopt it",
    body: `<div id="betterclaude-settings-panel">
             <nav class="bc-sp-nav"><button class="bc-sp-nav-item">Appearance</button></nav>
           </div>
           <div id="root">
             <aside aria-label="Sidebar">
               <div id="frame-peek-popover" data-testid="sidebar">
                 <div role="group" data-segmented="true">
                   <button data-mode="cowork" data-active="true">Home</button>
                   <button data-mode="code">Code</button>
                 </div>
                 <button data-testid="user-menu-button">account</button>
               </div>
             </aside>
             <main><header>h</header><div data-testid="chat-input">composer</div></main>
           </div>`,
    status: "recognized",
    rootId: "root",
    expectSignedIn: true,
    expectSidebarVia: 'aside[aria-label*="sidebar" i]',
  },
  {
    // REGRESSION TEST for the /code route: signed in, full sidebar, and NO
    // [data-testid="chat-input"] anywhere. The old composer-presence check
    // inferred signed-OUT here, which applied the sign-in-page geometry branch
    // (body padding zeroed, root translated, clip boundary removed) and
    // unmounted the cursor FX on a route the user is signed into.
    name: "Anthropic /code route: signed in with no composer",
    body: `<div id="root">
             <aside aria-label="Sidebar">
               <div id="frame-peek-popover" data-testid="sidebar">
                 <div role="group" data-segmented="true">
                   <button data-mode="cowork">Home</button>
                   <button data-mode="code" data-active="true">Code</button>
                 </div>
                 <button data-testid="user-menu-button">account</button>
               </div>
             </aside>
             <main><header>h</header><div data-testid="code-prompt-input">code composer</div></main>
           </div>`,
    status: "recognized",
    rootId: "root",
    expectSignedIn: true,
  },
  {
    // The scenario the whole module exists for: Anthropic renames the root.
    // Everything else is present and exact, so the ONLY thing that may degrade
    // the status is the root having been found structurally.
    name: "Root renamed (no #root/#__next) - heuristic must still find the app",
    body: `<div id="app-shell-v3">
             <aside aria-label="Sidebar">
               <div data-testid="sidebar">
                 <div role="group" data-segmented="true">
                   <button data-mode="cowork" data-active="true">Home</button>
                   <button data-mode="code">Code</button>
                 </div>
                 <button data-testid="user-menu-button">account</button>
               </div>
             </aside>
             <main><header>h</header><div data-testid="chat-input">composer</div></main>
           </div>`,
    status: "partial",
    rootId: "app-shell-v3",
    expectSignedIn: true,
  },
  {
    // display:contents generates no box, so a rect/area-based heuristic would
    // score this root at zero and pick the sibling decoy instead.
    name: "Renamed root with display:contents + a portal decoy sibling",
    body: `<div id="shell" style="display:contents">
             <div data-testid="chat-input">composer</div>
           </div>
           <div id="portal-root"><div><div>dialog</div></div></div>`,
    status: "partial",
    rootId: "shell",
    expectSignedIn: true,
  },
  {
    // Signed out: sidebar, mode switch, composer and account button are all
    // correctly absent, so nothing is degraded and the honest answer is
    // `recognized`. This previously asserted `partial`, which meant the health
    // field read "degraded" on a perfectly rendered sign-in page — exactly the
    // reading that trains someone to ignore the signal.
    name: "Signed-out marketing route - correctly absent is not degraded",
    body: `<div id="root">
             <div><div>marketing copy</div></div>
           </div>`,
    status: "recognized",
    rootId: "root",
    expectSignedIn: false,
  },
  {
    // Pill count and order deliberately different from every case above. A
    // detector keyed on "2 pills" or "Code is second" passes those and fails
    // here; this is the regression test for the next reshuffle.
    name: "Six pills, reordered, Code last",
    body: `<div id="root">
             <aside aria-label="Sidebar">
               <div data-testid="sidebar">
                 <div role="group" data-segmented="true" data-pills="6">
                   <button data-mode="projects">Projects</button>
                   <button data-mode="cowork" data-active="true">Home</button>
                   <button data-mode="chat">Chat</button>
                   <button data-mode="artifacts">Artifacts</button>
                   <button data-mode="scheduled">Scheduled</button>
                   <button data-mode="code">Code</button>
                 </div>
                 <button data-testid="user-menu-button">account</button>
               </div>
             </aside>
             <main><header>h</header><div data-testid="chat-input">composer</div></main>
           </div>`,
    status: "recognized",
    rootId: "root",
    expectSignedIn: true,
  },
  {
    // Sidebar renamed AND stripped of its label, so every nominal strategy
    // misses and only the structural column heuristic can answer. It must
    // still resolve, and the status must drop to `partial` to say so.
    name: "Sidebar renamed and unlabelled - structural tier must carry it",
    body: `<div id="root">
             <div class="shell-rail-v9" style="position:fixed;left:0;top:0;width:288px;height:900px">
               <div data-testid="sidebar">
                 <div role="group" data-segmented="true">
                   <button data-mode="cowork" data-active="true">Home</button>
                   <button data-mode="code">Code</button>
                 </div>
                 <button data-testid="user-menu-button">account</button>
               </div>
             </div>
             <main><header>h</header><div data-testid="chat-input">composer</div></main>
           </div>`,
    status: "partial",
    rootId: "root",
    expectSignedIn: true,
  },
  {
    name: "No app at all (blank/error page) - must report unrecognized",
    body: `<!-- nothing -->`,
    status: "unrecognized",
    rootId: null,
  },
  {
    name: "Only BetterClaude's own chrome present - must not adopt our own node",
    body: `<div id="betterclaude-titlebar">bar</div><div class="bc-toast">toast</div>`,
    status: "unrecognized",
    rootId: null,
  },
];

const results = [];
function record(name, pass, evidence) {
  results.push({ name, pass, evidence });
}

async function run() {
  if (!fs.existsSync(BUNDLE)) {
    console.error(`Missing ${BUNDLE}. Run \`npm run build:core\` first.`);
    app.exit(1);
    return;
  }
  const bundle = fs.readFileSync(BUNDLE, "utf8");

  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: false },
  });

  for (const testCase of CASES) {
    // A fresh document per case so no state leaks between them — a stale
    // bc-claude-root marker carrying over is itself a failure mode the module
    // documents, and reusing a document could turn it into a false pass.
    await win.loadURL(`data:text/html,${encodeURIComponent(`<body>${testCase.body}</body>`)}`);
    const out = await win.webContents.executeJavaScript(`(() => {
      ${bundle}
      const probe = BetterClaudeCore.probeLayout();
      BetterClaudeCore.applyLayoutMarkers(probe);
      const marked = document.querySelectorAll(".bc-claude-root");
      return {
        status: probe.status,
        summary: probe.summary,
        rootId: probe.root ? (probe.root.id || "(no id)") : null,
        markerCount: marked.length,
        markerMatchesRoot: marked.length === 1 && marked[0] === probe.root,
        bodyStatusClasses: Array.from(document.body.classList).filter((c) => c.startsWith("bc-layout-")),
        signedIn: probe.signedIn,
        signedOutClass: document.body.classList.contains("bc-signed-out"),
        missClasses: Array.from(document.body.classList).filter((c) => c.startsWith("bc-miss-")),
        sidebarVia: (probe.regions.find((r) => r.key === "sidebar") || {}).via || null,
        markedHeaders: document.querySelectorAll(".bc-chat-header").length,
        // Re-probe in the same document: proves the stale-marker trap that
        // isOwnNode() exempts ROOT_MARKER_CLASS for is actually handled, not
        // just described. Compares the resolved ROOT and not only the status,
        // because the first version of this check compared status alone and
        // reported PASS on a case that had silently retargeted the root to a
        // portal container — same status, wrong element, no signal.
        secondPass: (() => {
          const again = BetterClaudeCore.probeLayout();
          BetterClaudeCore.applyLayoutMarkers(again);
          return {
            status: again.status,
            rootId: again.root ? (again.root.id || "(no id)") : null,
            sameRoot: again.root === probe.root,
            markedHeaders: document.querySelectorAll(".bc-chat-header").length,
          };
        })(),
      };
    })()`);

    const statusOk = out.status === testCase.status;
    record(
      `${testCase.name} -> status`,
      statusOk,
      statusOk ? out.status : `expected ${testCase.status}, got ${out.status} (${out.summary})`
    );

    const rootOk = testCase.rootId === null ? out.rootId === null : out.rootId === testCase.rootId;
    record(
      `${testCase.name} -> root`,
      rootOk,
      rootOk ? String(out.rootId) : `expected root #${testCase.rootId}, got ${out.rootId}`
    );

    // Exactly one marker, on the element the probe actually returned.
    const markerOk = testCase.rootId === null
      ? out.markerCount === 0
      : out.markerCount === 1 && out.markerMatchesRoot;
    record(
      `${testCase.name} -> single root marker`,
      markerOk,
      `markerCount=${out.markerCount} matchesRoot=${out.markerMatchesRoot}`
    );

    // Exactly one body status class, always.
    const bodyClassOk = out.bodyStatusClasses.length === 1
      && out.bodyStatusClasses[0] === `bc-layout-${testCase.status}`;
    record(
      `${testCase.name} -> single body status class`,
      bodyClassOk,
      out.bodyStatusClasses.join(",") || "(none)"
    );

    // Signed-in inference. Asserted separately from status because it drives a
    // different consequence: `bc-signed-out` swaps the geometry branch and
    // unmounts the cursor FX, so getting it wrong on a signed-in route is a
    // visible regression even while the status reads healthy.
    if (Object.prototype.hasOwnProperty.call(testCase, "expectSignedIn")) {
      const signedInOk =
        out.signedIn === testCase.expectSignedIn && out.signedOutClass === !testCase.expectSignedIn;
      record(
        `${testCase.name} -> signed-in inference`,
        signedInOk,
        `signedIn=${out.signedIn} bc-signed-out=${out.signedOutClass} (expected signedIn=${testCase.expectSignedIn})`
      );
    }

    // WHICH strategy answered, not merely that something did. A case can report
    // the right status while having resolved a region to the wrong element —
    // the settings-panel-nav trap does exactly that — so the cases that exist
    // to pin down a specific resolution path assert the path.
    if (testCase.expectSidebarVia) {
      const viaOk = out.sidebarVia === testCase.expectSidebarVia;
      record(
        `${testCase.name} -> sidebar resolved via expected strategy`,
        viaOk,
        viaOk ? out.sidebarVia : `expected "${testCase.expectSidebarVia}", got "${out.sidebarVia}"`
      );
    }

    // Marker stability. A marker class we put on one of CLAUDE's elements must
    // survive the next probe: if the ownership test does not exempt it, the
    // second pass classifies the marked element as BetterClaude chrome, refuses
    // to resolve it, and strips the mark — so the styling oscillates on every
    // mutation and appears simply not to work. Both markers this codebase has
    // ever added hit exactly that, which is why it is asserted rather than
    // trusted.
    if (testCase.expectMarkedHeader != null) {
      const markerOk2 = out.markedHeaders === testCase.expectMarkedHeader
        && out.secondPass.markedHeaders === testCase.expectMarkedHeader;
      record(
        `${testCase.name} -> chat-header marker stable across re-probe`,
        markerOk2,
        `first=${out.markedHeaders} second=${out.secondPass.markedHeaders} (expected ${testCase.expectMarkedHeader})`
      );
    }

    // Idempotence: probing twice must return the same status AND the same
    // element. This is the check that catches a marker from pass 1 making the
    // real root invisible to pass 2 — i.e. the app losing its page geometry on
    // the first route change after load.
    const stableOk = out.secondPass.status === out.status && out.secondPass.sameRoot;
    record(
      `${testCase.name} -> stable across re-probe`,
      stableOk,
      stableOk
        ? `stable (${out.secondPass.status}, same root)`
        : `first=${out.status}/#${out.rootId} second=${out.secondPass.status}/#${out.secondPass.rootId} sameRoot=${out.secondPass.sameRoot}`
    );
  }

  win.destroy();

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== layout-probe audit ===\n");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n        ${r.evidence}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  console.log(
    "\nUNVERIFIED-HERE: whether the injected chrome is clickable in pixels - see\n" +
      "the smoke-test checklist. Real claude.ai markup is no longer unverified:\n" +
      "run `npm run audit:dom`, which drives the live site in the app's own session.\n"
  );
  app.exit(failed.length ? 1 : 0);
}

app.whenReady().then(run).catch((err) => {
  console.error(err);
  app.exit(1);
});
