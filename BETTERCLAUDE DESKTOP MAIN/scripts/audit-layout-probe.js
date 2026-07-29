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
    name: "Current layout (#root + tablist + composer)",
    body: `<div id="root">
             <div style="display:contents">
               <div role="tablist"><button role="tab">Home</button><button role="tab">Code</button></div>
               <nav><button data-testid="pin-sidebar-toggle">pin</button></nav>
               <div data-testid="chat-input">composer</div>
             </div>
           </div>`,
    status: "recognized",
    rootId: "root",
  },
  {
    name: "Next.js-style root (#__next)",
    body: `<div id="__next">
             <div role="tablist"><button role="tab">Home</button></div>
             <nav><button data-testid="pin-sidebar-toggle">pin</button></nav>
             <div data-testid="chat-input">composer</div>
           </div>`,
    status: "recognized",
    rootId: "__next",
  },
  {
    // The scenario the whole module exists for: Anthropic renames the root.
    // Before this work, every geometry rule keyed on #root/#__next silently
    // matched nothing here and the title bar covered the page.
    name: "Root renamed (no #root/#__next) - heuristic must still find the app",
    body: `<div id="app-shell-v3">
             <div role="tablist"><button role="tab">Home</button><button role="tab">Code</button></div>
             <nav><button data-testid="pin-sidebar-toggle">pin</button></nav>
             <div data-testid="chat-input">composer</div>
           </div>`,
    status: "partial",
    rootId: "app-shell-v3",
  },
  {
    // display:contents generates no box, so a rect/area-based heuristic would
    // score this root at zero and pick the sibling decoy instead.
    name: "Renamed root with display:contents + a portal decoy sibling",
    body: `<div id="shell" style="display:contents">
             <div role="tablist"><button role="tab">Home</button></div>
             <div data-testid="chat-input">composer</div>
           </div>
           <div id="portal-root"><div><div>dialog</div></div></div>`,
    status: "partial",
    rootId: "shell",
  },
  {
    name: "Signed-out marketing route (no composer) - must not read as broken",
    body: `<div id="root">
             <header><a href="/a">Product</a><a href="/b">Pricing</a></header>
             <div><div>marketing copy</div></div>
           </div>`,
    status: "partial",
    rootId: "root",
  },
  {
    // Tab count and order are deliberately different from every case above.
    // A detector keyed on "4 tabs" or "Code is second" passes those and fails
    // here; this is the regression test for the next reshuffle.
    name: "Six tabs, reordered, Code last",
    body: `<div id="root">
             <div role="tablist">
               <button role="tab">Projects</button><button role="tab">Home</button>
               <button role="tab">Chat</button><button role="tab">Cowork</button>
               <button role="tab">Artifacts</button><button role="tab">Code</button>
             </div>
             <nav><button data-testid="pin-sidebar-toggle">pin</button></nav>
             <div data-testid="chat-input">composer</div>
           </div>`,
    status: "recognized",
    rootId: "root",
  },
  {
    // REGRESSION TEST for a false positive found by running the real app.
    // This is the shape claude.ai actually ships today: no [role=tablist], no
    // [role=tab], no <header> — just a tall fixed left sidebar whose Home /
    // Search / pin cluster sits in the top ~60px of the window.
    //
    // The structural tab-bar tier used to match that sidebar and report a
    // `fallback` tier for topTabBar, which pinned the status at `partial` on a
    // completely healthy UI and re-warned on every route change. Both halves
    // of the fix are asserted here: the sidebar must not be mistaken for a tab
    // bar, and a build with no tab bar at all must still read `recognized`.
    name: "Real current shape: tall left sidebar, NO tab bar - must be recognized",
    body: `<div id="root">
             <nav aria-label="Sidebar" style="position:fixed;left:0;top:0;width:272px;height:1200px">
               <div style="display:flex;gap:4px">
                 <a aria-label="Home" href="/new" style="width:68px;height:20px"></a>
                 <button aria-label="Search" style="width:24px;height:24px"></button>
                 <button data-testid="pin-sidebar-toggle" style="width:24px;height:24px"></button>
               </div>
               <a aria-label="New chat" href="/new" style="width:271px;height:32px"></a>
             </nav>
             <div data-testid="chat-input">composer</div>
           </div>`,
    status: "recognized",
    rootId: "root",
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
    "\nUNVERIFIED-HERE: real claude.ai markup (needs a signed-in session), and\n" +
      "whether the Code tab is clickable in pixels - see the smoke-test checklist.\n"
  );
  app.exit(failed.length ? 1 : 0);
}

app.whenReady().then(run).catch((err) => {
  console.error(err);
  app.exit(1);
});
