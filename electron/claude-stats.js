/**
 * Claude Code usage stats: the same numbers as the CLI's `/stats` screen and
 * the desktop app's Code home card (sessions, messages, total tokens, active
 * days, peak hour, favourite model, a day heatmap).
 *
 * Source of truth is Claude Code's own data, never anything BetterClaude logs:
 *   - `<config>/stats-cache.json`: the CLI's rolled-up history up to its
 *     `lastComputedDate`. Transcripts older than `cleanupPeriodDays` (30 by
 *     default) are deleted, so this file is the only record of older days.
 *     Read only; the CLI owns it.
 *   - `<config>/projects/<slug>/*.jsonl` (+ `<session>/subagents/agent-*.jsonl`)
 *     for every day after that, aggregated with the CLI's rules (CLI 2.1.286):
 *     a message is a `user` or `assistant` line; sidechain lines only count
 *     inside subagent files; subagent files add tokens (and tool calls on days
 *     that already have activity) but no messages or sessions; a session
 *     belongs to the UTC day of its first message and its local start hour
 *     feeds the peak hour; tokens are input + output + cache read + cache
 *     creation; `<synthetic>` (API error lines) is not a model.
 *
 * Parsing ~2 GB of transcripts is slow, so per-file results are memoised by
 * (size, mtime) in a JSON file the caller names, and this module runs in a
 * utility process (claude-stats-worker.js), never on Electron's main thread.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const MEMO_VERSION = 1;
const SYNTHETIC_MODEL = "<synthetic>";

// Token sizes the CLI's own /stats fun facts use.
const BOOKS = [
  { name: "The Little Prince", tokens: 22000 },
  { name: "The Old Man and the Sea", tokens: 35000 },
  { name: "Animal Farm", tokens: 39000 },
  { name: "The Great Gatsby", tokens: 62000 },
  { name: "Brave New World", tokens: 83000 },
  { name: "The Hobbit", tokens: 123000 },
  { name: "Pride and Prejudice", tokens: 156000 },
  { name: "Dune", tokens: 244000 },
  { name: "Moby-Dick", tokens: 268000 },
  { name: "A Game of Thrones", tokens: 381000 },
  { name: "Don Quixote", tokens: 520000 },
  { name: "The Lord of the Rings", tokens: 576000 },
  { name: "War and Peace", tokens: 730000 },
];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const utcDay = (date) => date.toISOString().slice(0, 10);
const unsafeKey = (key) => key in Object.prototype;

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function readStatsCache(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "stats-cache.json"), "utf8"));
    if (!isPlainObject(raw) || !Array.isArray(raw.dailyActivity) || !Array.isArray(raw.dailyModelTokens)) return null;
    if (!DAY_RE.test(raw.lastComputedDate || "")) return null;
    return {
      lastComputedDate: raw.lastComputedDate,
      dailyActivity: raw.dailyActivity.filter((d) => d && DAY_RE.test(d.date)),
      dailyModelTokens: raw.dailyModelTokens.filter((d) => d && DAY_RE.test(d.date) && isPlainObject(d.tokensByModel)),
      modelUsage: isPlainObject(raw.modelUsage) ? raw.modelUsage : {},
      hourCounts: isPlainObject(raw.hourCounts) ? raw.hourCounts : {},
    };
  } catch {
    return null;
  }
}

/** Every transcript the CLI's stats read: top-level sessions plus subagents. */
function listTranscripts(dir) {
  const root = path.join(dir, "projects");
  const files = [];
  let projects = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return files; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    let entries = [];
    try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push({ file: path.join(projectDir, entry.name), subagent: false });
      } else if (entry.isDirectory()) {
        const subDir = path.join(projectDir, entry.name, "subagents");
        let subs = [];
        try { subs = fs.readdirSync(subDir, { withFileTypes: true }); } catch { continue; }
        for (const sub of subs) {
          if (sub.isFile() && sub.name.startsWith("agent-") && sub.name.endsWith(".jsonl")) {
            files.push({ file: path.join(subDir, sub.name), subagent: true });
          }
        }
      }
    }
  }
  return files;
}

/**
 * One transcript's contribution for days on/after `fromDate` (null = all):
 * { session: {day, hour, duration} | null, days: {date: {messages, tools,
 * tokens{model:n}, usage{model:[in,out,cacheRead,cacheCreate]}}} }.
 */
async function parseTranscript(file, subagent, fromDate) {
  const entries = [];
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line || line.indexOf('"timestamp"') === -1) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || (entry.type !== "user" && entry.type !== "assistant")) continue;
    if (!subagent && entry.isSidechain) continue;
    entries.push({ type: entry.type, timestamp: entry.timestamp, message: entry.type === "assistant" ? entry.message : null });
  }
  const out = { session: null, days: {} };
  if (!entries.length) return out;
  const start = new Date(entries[0].timestamp);
  const end = new Date(entries[entries.length - 1].timestamp);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out;
  const startDay = utcDay(start);
  if (!subagent && (!fromDate || startDay >= fromDate)) {
    out.session = { day: startDay, hour: start.getHours(), duration: end - start };
  }
  for (const entry of entries) {
    const at = new Date(entry.timestamp);
    if (Number.isNaN(at.getTime())) continue;
    const key = utcDay(at);
    if (fromDate && key < fromDate) continue;
    const day = out.days[key] || (out.days[key] = { messages: 0, tools: 0, tokens: {}, usage: {} });
    if (!subagent) day.messages++;
    if (entry.type !== "assistant") continue;
    const message = entry.message || {};
    if (Array.isArray(message.content)) {
      for (const block of message.content) if (block && block.type === "tool_use") day.tools++;
    }
    const usage = message.usage;
    const model = message.model || "unknown";
    if (!usage || model === SYNTHETIC_MODEL || unsafeKey(model)) continue;
    const parts = [num(usage.input_tokens), num(usage.output_tokens), num(usage.cache_read_input_tokens), num(usage.cache_creation_input_tokens)];
    const total = parts[0] + parts[1] + parts[2] + parts[3];
    if (total > 0) day.tokens[model] = (day.tokens[model] || 0) + total;
    const u = day.usage[model] || (day.usage[model] = [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) u[i] += parts[i];
  }
  return out;
}

function loadMemo(memoPath, fromDate) {
  if (memoPath) {
    try {
      const memo = JSON.parse(fs.readFileSync(memoPath, "utf8"));
      if (memo && memo.version === MEMO_VERSION && memo.fromDate === fromDate && isPlainObject(memo.files)) return memo;
    } catch { /* first run */ }
  }
  return { version: MEMO_VERSION, fromDate, files: {} };
}

function saveMemo(memoPath, memo) {
  if (!memoPath) return;
  try {
    fs.mkdirSync(path.dirname(memoPath), { recursive: true });
    const tmp = `${memoPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(memo), { mode: 0o600 });
    fs.renameSync(tmp, memoPath);
  } catch { /* a cold scan next time is the only cost */ }
}

/**
 * Raw per-day data: { days: Map(date -> {messages, sessions, tools, tokens{model:n}}),
 * usage{model:[in,out,cacheRead,cacheCreate]}, hours[24] (all time),
 * sessionHours[{day,hour}] (scanned days only) }.
 */
async function collect({ dir = configDir(), memoPath = null } = {}) {
  const cache = readStatsCache(dir);
  let fromDate = null;
  if (cache) {
    const next = new Date(`${cache.lastComputedDate}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    fromDate = utcDay(next);
  }
  const days = new Map();
  const dayOf = (key) => {
    if (!days.has(key)) days.set(key, { messages: 0, sessions: 0, tools: 0, tokens: {} });
    return days.get(key);
  };
  const usage = {};
  const hours = new Array(24).fill(0);
  const sessionHours = [];

  if (cache) {
    for (const d of cache.dailyActivity) {
      const day = dayOf(d.date);
      day.messages += num(d.messageCount);
      day.sessions += num(d.sessionCount);
      day.tools += num(d.toolCallCount);
    }
    for (const d of cache.dailyModelTokens) {
      const day = dayOf(d.date);
      for (const [model, n] of Object.entries(d.tokensByModel)) if (!unsafeKey(model)) day.tokens[model] = (day.tokens[model] || 0) + num(n);
    }
    for (const [model, u] of Object.entries(cache.modelUsage)) {
      if (unsafeKey(model) || !isPlainObject(u)) continue;
      usage[model] = [num(u.inputTokens), num(u.outputTokens), num(u.cacheReadInputTokens), num(u.cacheCreationInputTokens)];
    }
    for (const [h, n] of Object.entries(cache.hourCounts)) {
      const hour = parseInt(h, 10);
      if (hour >= 0 && hour < 24) hours[hour] += num(n);
    }
  }

  const memo = loadMemo(memoPath, fromDate);
  const nextFiles = {};
  const results = [];
  for (const { file, subagent } of listTranscripts(dir)) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (fromDate && utcDay(stat.mtime) < fromDate) continue;
    const hit = memo.files[file];
    let result;
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) result = hit.result;
    else {
      try { result = await parseTranscript(file, subagent, fromDate); } catch { continue; }
    }
    nextFiles[file] = { size: stat.size, mtimeMs: stat.mtimeMs, result };
    results.push({ subagent, result });
  }
  saveMemo(memoPath, { version: MEMO_VERSION, fromDate, files: nextFiles });

  // Sessions first: a subagent's tool calls only count on a day its parent
  // sessions already put on the board (the CLI's rule).
  results.sort((a, b) => Number(a.subagent) - Number(b.subagent));
  for (const { subagent, result } of results) {
    if (result.session) {
      dayOf(result.session.day).sessions++;
      hours[result.session.hour]++;
      sessionHours.push({ day: result.session.day, hour: result.session.hour });
    }
    for (const [key, d] of Object.entries(result.days)) {
      const known = days.has(key);
      const day = dayOf(key);
      day.messages += d.messages;
      if (!subagent || known) day.tools += d.tools;
      for (const [model, n] of Object.entries(d.tokens)) day.tokens[model] = (day.tokens[model] || 0) + n;
      for (const [model, u] of Object.entries(d.usage)) {
        const into = usage[model] || (usage[model] = [0, 0, 0, 0]);
        for (let i = 0; i < 4; i++) into[i] += u[i];
      }
    }
  }
  return { days, usage, hours, sessionHours };
}

function shiftDay(key, delta) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return utcDay(d);
}

function summarizeRange(raw, rangeDays, today) {
  const since = rangeDays ? shiftDay(today, -(rangeDays - 1)) : null;
  let sessions = 0;
  let messages = 0;
  let tokens = 0;
  let activeDays = 0;
  const modelTokens = {};
  const daily = [];
  for (const [key, d] of raw.days) {
    if ((since && key < since) || key > today) continue;
    sessions += d.sessions;
    messages += d.messages;
    const dayTokens = Object.values(d.tokens).reduce((a, b) => a + b, 0);
    tokens += dayTokens;
    if (d.messages > 0) activeDays++;
    for (const [model, n] of Object.entries(d.tokens)) modelTokens[model] = (modelTokens[model] || 0) + n;
    daily.push({ date: key, messages: d.messages, tokens: dayTokens });
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  // All time uses the CLI's own hour counts; a window only has the hours of
  // the sessions scanned from transcripts inside it.
  let hours = raw.hours;
  if (since) {
    hours = new Array(24).fill(0);
    for (const s of raw.sessionHours) if (s.day >= since) hours[s.hour]++;
  }
  let peakHour = null;
  hours.forEach((n, h) => { if (n > 0 && (peakHour === null || n > hours[peakHour])) peakHour = h; });

  const models = Object.entries(modelTokens)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([model, n]) => {
      // Input/output splits only exist as all-time totals.
      const u = !since ? raw.usage[model] : null;
      return { model, tokens: n, share: tokens ? n / tokens : 0, input: u ? u[0] : null, output: u ? u[1] : null };
    });

  const book = [...BOOKS].reverse().find((b) => tokens >= b.tokens * 2) || null;
  return {
    sessions,
    messages,
    tokens,
    activeDays,
    peakHour,
    favoriteModel: models.length ? models[0].model : null,
    models,
    daily,
    since,
    funFact: book ? { book: book.name, times: Math.floor(tokens / book.tokens) } : null,
  };
}

/** The payload the Code tab draws: { today, computedAt, ranges: { all, d30, d7 } }. */
async function computeStats(opts = {}) {
  const raw = await collect(opts);
  const today = utcDay(new Date());
  return {
    today,
    computedAt: Date.now(),
    ranges: {
      all: summarizeRange(raw, 0, today),
      d30: summarizeRange(raw, 30, today),
      d7: summarizeRange(raw, 7, today),
    },
  };
}

module.exports = { computeStats, collect, parseTranscript, readStatsCache, listTranscripts };
