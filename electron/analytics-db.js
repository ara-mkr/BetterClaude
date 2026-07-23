/**
 * Usage Analytics storage — Electron main-process only (fs + a WASM SQLite
 * engine), so this lives in electron/, not /core (same split as the search
 * index's per-conversation JSON files, which also live entirely in
 * electron/main.js). Uses sql.js (SQLite compiled to WebAssembly) rather
 * than a native addon like better-sqlite3: no native compilation/ABI
 * rebuild step against Electron's Node version, and — unlike a native
 * addon — the exact same engine can run in a browser extension later,
 * which matches this app's "core stays portable" goal even though this
 * particular file itself is Electron-side wiring.
 *
 * The whole database is one file, userData/analytics.sqlite, loaded into
 * memory at startup and flushed back to disk on a short debounce after
 * writes (plus on app quit) — sql.js has no incremental on-disk write mode,
 * so this mirrors how electron-store already treats its own JSON file.
 */

const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

let SQL = null;
let db = null;
let dbPath = null;
let dirty = false;
let saveTimer = null;

async function initAnalyticsDb(userDataDir) {
  if (db) return db;
  SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, "..", "node_modules", "sql.js", "dist", file),
  });
  dbPath = path.join(userDataDir, "analytics.sqlite");
  let bytes = null;
  try {
    bytes = fs.readFileSync(dbPath);
  } catch (_e) {
    // First run — no file yet, start with a fresh in-memory database.
  }
  db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      day TEXT NOT NULL,
      type TEXT NOT NULL,
      role TEXT,
      tokens INTEGER DEFAULT 0,
      model TEXT,
      project TEXT,
      pluginId TEXT,
      costUsd REAL DEFAULT 0
    );
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_events(day);");
  db.run("CREATE INDEX IF NOT EXISTS idx_usage_type ON usage_events(type);");
  return db;
}

function markDirty() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushToDisk();
  }, 5000);
}

function flushToDisk() {
  if (!db || !dirty) return;
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  dirty = false;
}

function logEvent(event) {
  if (!db) return;
  db.run(
    "INSERT INTO usage_events (ts, day, type, role, tokens, model, project, pluginId, costUsd) VALUES (?,?,?,?,?,?,?,?,?)",
    [
      event.ts,
      event.day,
      event.type,
      event.role || null,
      event.tokens || 0,
      event.model || null,
      event.project || null,
      event.pluginId || null,
      event.costUsd || 0,
    ]
  );
  markDirty();
}

function execAll(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryAnalytics({ from, to }) {
  const empty = { tokensByDay: [], messagesByDay: [], costByDay: [], topPlugins: [], topProjects: [], totals: { messages: 0, tokens: 0, costUsd: 0 } };
  if (!db) return empty;
  const range = "day >= ? AND day <= ?";
  const params = [from, to];

  const tokensByDay = execAll(`SELECT day, SUM(tokens) as tokens FROM usage_events WHERE ${range} AND type='message' GROUP BY day ORDER BY day`, params);
  const messagesByDay = execAll(`SELECT day, COUNT(*) as messages FROM usage_events WHERE ${range} AND type='message' GROUP BY day ORDER BY day`, params);
  const costByDay = execAll(`SELECT day, SUM(costUsd) as costUsd FROM usage_events WHERE ${range} AND type='message' GROUP BY day ORDER BY day`, params);
  const topPlugins = execAll(`SELECT pluginId, COUNT(*) as count FROM usage_events WHERE ${range} AND type='plugin' GROUP BY pluginId ORDER BY count DESC LIMIT 10`, params);
  const topProjects = execAll(`SELECT project, COUNT(*) as messages, SUM(tokens) as tokens FROM usage_events WHERE ${range} AND type='message' GROUP BY project ORDER BY messages DESC LIMIT 10`, params);
  const totalsRows = execAll(`SELECT COUNT(*) as messages, SUM(tokens) as tokens, SUM(costUsd) as costUsd FROM usage_events WHERE ${range} AND type='message'`, params);
  const totalsRow = totalsRows[0] || {};

  return {
    tokensByDay,
    messagesByDay,
    costByDay,
    topPlugins,
    topProjects,
    totals: { messages: totalsRow.messages || 0, tokens: totalsRow.tokens || 0, costUsd: totalsRow.costUsd || 0 },
  };
}

function exportRows({ from, to }) {
  if (!db) return [];
  return execAll(
    "SELECT ts, day, type, role, tokens, model, project, pluginId, costUsd FROM usage_events WHERE day >= ? AND day <= ? ORDER BY ts",
    [from, to]
  );
}

function clearAll() {
  if (!db) return;
  db.run("DELETE FROM usage_events");
  dirty = true;
  flushToDisk();
}

function shutdown() {
  flushToDisk();
}

module.exports = { initAnalyticsDb, logEvent, queryAnalytics, exportRows, clearAll, shutdown };
