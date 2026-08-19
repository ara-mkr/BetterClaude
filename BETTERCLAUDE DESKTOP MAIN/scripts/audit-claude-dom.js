#!/usr/bin/env electron
/**
 * Live claude.ai DOM audit — the "look before you inject" tool.
 *
 * scripts/audit-layout-probe.js proves core/layout-probe.js behaves correctly
 * against shapes we invent. It cannot tell us which shape Anthropic is
 * shipping. This does: it opens the real site in the app's own persisted
 * session and dumps the structure the injection layer has to key off.
 *
 *   npm run audit:dom            # audit the default routes
 *   npm run audit:dom -- --show  # ...with the window visible
 *
 * Output: docs/dom-audit-<date>.json (raw) — the human-readable
 * docs/dom-audit-<date>.md is written from it by hand, because the point of
 * that file is the conclusions, not the dump.
 *
 * Boundaries, restated here because this is the one script that touches the
 * live site:
 *   - Read-only. It never clicks, types, submits, or navigates anywhere the
 *     invocation didn't name.
 *   - It reuses the existing session cookie; it never reads, writes, copies or
 *     inspects any credential, token, or auth surface, and never drives a
 *     sign-in flow. If the session is signed out, it says so and audits the
 *     signed-out route instead.
 *   - Every string that could be user content is redacted in the renderer half
 *     (see scripts/audit-claude-dom-preload.js) before it reaches this process.
 */
const path = require("path");
const fs = require("fs");
const electron = require("electron");

// Same ELECTRON_RUN_AS_NODE guard as scripts/audit-layout-probe.js — see the
// long explanation there. In that mode `require("electron")` is a path string,
// not the API object, and everything below would die on `app` being undefined.
if (typeof electron === "string") {
  const { spawnSync } = require("child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electron, [__filename, ...process.argv.slice(2)], { stdio: "inherit", env });
  process.exit(child.status === null ? 1 : child.status);
}

const { app, BrowserWindow, ipcMain } = electron;

// Must match electron/main.js exactly. app.getName() picks the userData
// directory, and the persisted session below lives inside it — get this wrong
// and the audit runs against a blank profile, reports "signed out", and looks
// like a claude.ai change rather than a script bug.
app.setName("BetterClaude");

const SHOW = process.argv.includes("--show");
const ROUTES = (() => {
  const flagIndex = process.argv.indexOf("--routes");
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) return process.argv[flagIndex + 1].split(",");
  return ["https://claude.ai/new", "https://claude.ai/projects"];
})();

const OUT_DIR = path.join(__dirname, "..", "docs");
const SHOT_DIR = process.env.BC_AUDIT_SHOT_DIR || null;
const stamp = new Date().toISOString().slice(0, 10);

function once(channel) {
  return new Promise((resolve) => ipcMain.once(channel, (_e, payload) => resolve(payload)));
}

async function auditRoute(win, url) {
  await win.loadURL(url);
  win.webContents.send("audit:wait-for-app");
  const ready = await once("audit:app-ready");
  // Layout in the top band settles a frame or two after the app mounts — the
  // same reason core/layout-probe.js debounces by 250ms before probing.
  await new Promise((r) => setTimeout(r, 1500));
  win.webContents.send("audit:collect", { tag: url });
  const result = await once("audit:result");

  if (SHOT_DIR) {
    try {
      const image = await win.webContents.capturePage();
      const name = `${url.replace(/[^a-z0-9]+/gi, "-")}.png`;
      fs.writeFileSync(path.join(SHOT_DIR, name), image.toPNG());
    } catch (err) {
      console.warn("  (screenshot failed:", err.message, ")");
    }
  }
  return { url, ready, ...result };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: SHOW,
    webPreferences: {
      // The same persisted partition electron/main.js gives the real window,
      // which is the only reason this sees a signed-in app at all.
      partition: "persist:betterclaude",
      preload: path.join(__dirname, "audit-claude-dom-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on("preload-error", (_e, p, error) => {
    console.error("[audit] preload error", p, error);
  });

  const report = { generatedAt: new Date().toISOString(), electron: process.versions.electron, routes: [] };
  for (const url of ROUTES) {
    process.stdout.write(`[audit] ${url} ... `);
    try {
      const routeReport = await auditRoute(win, url);
      report.routes.push(routeReport);
      const signedIn = routeReport.ready && routeReport.ready.signedIn;
      console.log(signedIn ? "ok (signed in)" : "ok (SIGNED OUT — structural coverage will be partial)");
    } catch (err) {
      console.log("FAILED");
      report.routes.push({ url, ok: false, error: String((err && err.stack) || err) });
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `dom-audit-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`[audit] wrote ${outPath}`);

  win.destroy();
  app.quit();
});

app.on("window-all-closed", () => app.quit());
