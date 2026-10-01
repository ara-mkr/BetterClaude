/**
 * Utility-process entry for electron/claude-stats.js: a cold scan parses
 * every Claude Code transcript (~2 GB on a busy machine), which would stall
 * the main process. main.js forks this per request ({ memoPath }) and gets
 * back { ok, stats } or { ok:false, error }.
 */
const { computeStats } = require("./claude-stats");

process.parentPort.once("message", async (event) => {
  const { memoPath } = (event && event.data) || {};
  try {
    const stats = await computeStats({ memoPath: typeof memoPath === "string" ? memoPath : null });
    process.parentPort.postMessage({ ok: true, stats });
  } catch (error) {
    process.parentPort.postMessage({ ok: false, error: (error && error.message) || String(error) });
  }
});
