#!/usr/bin/env electron
/**
 * Composer-fill audit — the regression guard for the "hard box inside the
 * chatbox" bug.
 *
 * The theme scaffold (core/tokens.js buildScaffoldCSS) used to paint the
 * composer's fill on claude.ai's editor node AND on up to three of its
 * ancestors. Those layers only cover the text row, 8px inside the real
 * rounded card, so on any theme whose fill differed from the card's own, a
 * second, hard-cornered rectangle sat inside the composer (and translucent
 * glass fills stacked). The fix paints the card and nothing else.
 *
 * This runs every generated theme (themes/*.css, plus runtime-built custom
 * themes) through real Chromium — the Electron already in devDependencies —
 * against a synthetic composer transcribed from the live DOM (2026-09-27),
 * native claude.ai styling included: the card's fill from bg-surface-3, its
 * 14px radius from rounded-composer, and the send button's fill on a nested
 * span inset half a pixel. For each theme x shape it asserts:
 *
 *   1. exactly one layer between the editor and the card paints a fill,
 *      and it is the card;
 *   2. that card keeps a non-zero radius, equal to its native one;
 *   3. the send button has exactly one fill (its own) and a radius of at
 *      least 6px, concentric with the card, even at shape "sharp";
 *   4. attachment chips inside the card keep their own fill;
 *   5. the editor text and toolbar text stay readable on the card
 *      (WCAG AA 4.5:1 against the card composited over the page).
 *
 * Two fallback structures are checked too: a card with only the
 * rounded-composer class (no data-cds), and a build with neither hook, where
 * the bounded-ancestor rules must still give the editor a readable fill.
 *
 *   npm run audit:composer
 */
const path = require("path");
const fs = require("fs");
const electron = require("electron");

// Started with ELECTRON_RUN_AS_NODE=1: relaunch as a real Electron app (see
// scripts/audit-layout-probe.js for why this is done in-script).
if (typeof electron === "string") {
  const { spawnSync } = require("child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electron, [__filename, ...process.argv.slice(2)], { stdio: "inherit", env });
  process.exit(child.status === null ? 1 : child.status);
}

const { app, BrowserWindow } = electron;
const tokens = require("../core/tokens");
const { buildBaseCSS, buildThemeCSSFromVars } = require("../core/theme-engine");
const { mergeDefaults } = require("../core/settings-schema");

const THEMES_DIR = path.join(__dirname, "..", "themes");
const SHAPES = ["sharp", "rounded", "pill"];
const AA = tokens.WCAG_AA_BODY || 4.5;
const MIN_BUTTON_RADIUS_PX = 6;

// claude.ai's own styling for the pieces involved, as measured live.
const NATIVE_CSS = `
  html.cds-root, .cds-root { --cds-surface-3: #20201f; }
  body { margin: 0; font: 15px sans-serif; }
  .bg-surface-3 { background-color: var(--cds-surface-3); }
  .rounded-composer { border-radius: 14px; }
  .rounded { border-radius: 8px; }
  .rounded-inherit { border-radius: inherit; }
  .relative { position: relative; }
  .absolute { position: absolute; }
  .inset-0 { inset: 0; }
  .inset-half { inset: 0.5px; }
  .z-under { z-index: -1; }
  .isolate { isolation: isolate; }
  .fill-brand { background-color: #c6613f; }
  .chip { display: inline-block; padding: 2px 8px; background-color: #30302e; border-radius: 8px; }
  .card { display: flex; flex-direction: column; gap: 6px; padding: 8px; width: 640px; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; }
  button { border: 0; padding: 0; }
  #send { width: 32px; height: 32px; }
`;

// The editor chain inside the card, as on the live page: four wrappers, then
// the ChatComposerEditor text row, then the ProseMirror editor.
const EDITOR = `
  <div class="relative">
    <div class="pb">
      <div class="relative">
        <div class="relative">
          <div data-cds="ChatComposerEditor">
            <div data-testid="chat-input" contenteditable="true" class="tiptap ProseMirror"><p>Refactor the auth middleware</p></div>
          </div>
        </div>
      </div>
      <div class="toolbar">
        <span><button id="plus" type="button">+</button> <span id="label">Opus 5.5 Medium</span></span>
        <button id="send" type="button" data-cds="Button" data-testid="chat-input-send" class="relative isolate rounded">
          <span class="absolute z-under rounded-[inherit] rounded-inherit inset-half cds-btn-squish"><span class="absolute inset-0 rounded-[inherit] rounded-inherit fill-brand"></span></span>
          <span>&uarr;</span>
        </button>
      </div>
    </div>
  </div>`;
const CHIPS = `<div id="chips"><span class="chip" id="chip">notes.md</span></div>`;

const CASES = [
  {
    name: "live shape (data-cds ChatComposer)",
    body: `<main><div class="sticky"><div data-cds="ChatComposer"><div id="card" class="card bg-surface-3 relative rounded-composer">${CHIPS}${EDITOR}</div></div></div></main>`,
    kind: "card",
  },
  {
    name: "class hook only (no data-cds)",
    body: `<main><div class="sticky"><div><div id="card" class="card bg-surface-3 relative rounded-composer">${CHIPS}${EDITOR}</div></div></div></main>`,
    kind: "card",
  },
  {
    name: "no card hook (fallback rules)",
    body: `<main><div class="sticky"><div><div id="card" class="card relative" style="border-radius:14px">${CHIPS}${EDITOR}</div></div></div></main>`,
    kind: "fallback",
  },
];

// Runs in the page: returns every measurement as opaque #rrggbb colours
// (resolved through a canvas, so color-mix()/color(srgb ...) values and
// translucent layers composite exactly as painted).
const MEASURE = `(() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const hex = (layers) => {
    ctx.clearRect(0, 0, 1, 1);
    layers.forEach((c) => { ctx.fillStyle = "#000"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); });
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
  };
  const alpha = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "rgba(0,0,0,0)"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[3]; };
  const bgOf = (el) => getComputedStyle(el).backgroundColor;
  const input = document.querySelector('[data-testid="chat-input"]');
  const card = document.getElementById("card");
  const painted = [];
  for (let el = input; el; el = el.parentElement) {
    if (alpha(bgOf(el)) > 0) painted.push(el === card ? "card" : el === input ? "chat-input" : (el.getAttribute("data-cds") || el.className || el.tagName.toLowerCase()));
    if (el === card) break;
  }
  const send = document.getElementById("send");
  const sendFills = [send, ...send.querySelectorAll("*")].filter((el) => alpha(bgOf(el)) > 0).map((el) => el === send ? "button" : el.className);
  const pageBg = getComputedStyle(document.body).backgroundColor;
  const under = [getComputedStyle(document.documentElement).backgroundColor, pageBg];
  const cardFill = hex([...under, bgOf(card)]);
  // The editor's own surface: the nearest painted layer at or above it.
  let surface = input;
  while (surface && alpha(bgOf(surface)) === 0 && surface !== card) surface = surface.parentElement;
  const editorFill = hex([...under, bgOf(card), bgOf(surface)]);
  return JSON.stringify({
    painted,
    cardRadius: getComputedStyle(card).borderTopLeftRadius,
    sendFills,
    sendRadius: parseFloat(getComputedStyle(send).borderTopLeftRadius),
    chipAlpha: alpha(bgOf(document.getElementById("chip"))),
    cardFill,
    editorFill,
    editorText: hex([editorFill, getComputedStyle(input).color]),
    labelText: hex([cardFill, getComputedStyle(document.getElementById("label")).color]),
  });
})()`;

function themeSources() {
  const files = fs.readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css")).sort();
  const list = files.map((f) => ({ name: f.replace(/\.css$/, ""), css: fs.readFileSync(path.join(THEMES_DIR, f), "utf8") }));
  // Custom themes are built at runtime, not read from disk — cover both
  // polarities through the same builder the Appearance editor uses.
  list.push({ name: "custom (dark defaults)", css: buildThemeCSSFromVars({}, "Custom Dark") });
  list.push({ name: "custom (light)", css: buildThemeCSSFromVars({ "--bc-bg": "#faf9f5", "--bc-bg-elevated": "#ffffff", "--bc-bg-sidebar": "#f0eee6", "--bc-text": "#141413", "--bc-text-muted": "#5e5d59", "--bc-border": "#d9d6cc" }, "Custom Light") });
  return list;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 400, webPreferences: { contextIsolation: true, sandbox: true } });
  const failures = [];
  let checks = 0;
  const themes = themeSources();
  for (const testCase of CASES) {
    await win.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html><html class="cds-root" data-mode="dark"><head><style>${NATIVE_CSS}</style><style id="betterclaude-base"></style><style id="betterclaude-theme"></style></head><body>${testCase.body}</body></html>`)}`);
    for (const theme of themes) {
      const light = /color-scheme:\s*light/.test(theme.css);
      for (const shape of SHAPES) {
        const settings = mergeDefaults({});
        settings.appearanceEditor = { ...(settings.appearanceEditor || {}), shape };
        const m = JSON.parse(await win.webContents.executeJavaScript(`(() => {
          document.documentElement.dataset.mode = ${JSON.stringify(light ? "light" : "dark")};
          document.getElementById("betterclaude-base").textContent = ${JSON.stringify(buildBaseCSS(settings))};
          document.getElementById("betterclaude-theme").textContent = ${JSON.stringify(theme.css)};
          return ${MEASURE};
        })()`));
        const where = `${testCase.name} · ${theme.name} · ${shape}`;
        const fail = (msg) => failures.push(`${where}: ${msg}`);
        checks += 1;
        if (testCase.kind === "card") {
          if (m.painted.length !== 1 || m.painted[0] !== "card") fail(`painted layers ${JSON.stringify(m.painted)} — expected only the card`);
          if (m.cardRadius !== "14px") fail(`card radius ${m.cardRadius} — expected its native 14px`);
        } else if (!m.painted.length) {
          fail("no layer paints the editor's fill");
        }
        if (m.sendFills.length !== 1 || m.sendFills[0] !== "button") fail(`send button fills ${JSON.stringify(m.sendFills)} — expected only the button`);
        if (!(m.sendRadius >= MIN_BUTTON_RADIUS_PX)) fail(`send button radius ${m.sendRadius}px — below ${MIN_BUTTON_RADIUS_PX}px`);
        if (m.chipAlpha === 0) fail("attachment chip lost its fill");
        const editorContrast = tokens.contrastRatio(m.editorText, m.editorFill);
        if (!(editorContrast >= AA)) fail(`editor text ${m.editorText} on ${m.editorFill} is ${editorContrast.toFixed(2)}:1`);
        const labelContrast = tokens.contrastRatio(m.labelText, m.cardFill);
        if (!(labelContrast >= AA)) fail(`toolbar text ${m.labelText} on ${m.cardFill} is ${labelContrast.toFixed(2)}:1`);
      }
    }
  }
  console.log(`composer-fill audit: ${themes.length} themes x ${SHAPES.length} shapes x ${CASES.length} structures = ${checks} renders`);
  if (failures.length) {
    console.log(`FAIL (${failures.length})`);
    failures.slice(0, 60).forEach((f) => console.log(`  - ${f}`));
    if (failures.length > 60) console.log(`  … and ${failures.length - 60} more`);
  } else {
    console.log("PASS — one painted card layer, native radius, single-fill rounded send button, chips intact, AA text");
  }
  win.destroy();
  app.exit(failures.length ? 1 : 0);
});
