/**
 * Agent Team Hub — the shared workspace that lets multiple `claude` sessions
 * in the Code pane work as one team.
 *
 * HOW THE AGENTS ACTUALLY TALK (important):
 *
 * Every session is a real Claude Code REPL with its own tools. Rather than
 * scraping terminal output (which this app deliberately never does) or adding
 * a second transport, the team communicates through FILES in a hub directory:
 *
 *   <project>/.bc-team/
 *     agents/<id>.json     identity + live status ("what I'm working on")
 *     messages/*.json      inter-agent chat, one message per file
 *     changes/<id>.json    per-agent work log ("what I've made")
 *     tasks.json           the shared task board ("who does what")
 *
 * Teammates spawned by BetterClaude are launched with --append-system-prompt
 * containing the protocol below, so each agent knows how to read the roster,
 * post messages, claim tasks and log its own file changes using its ordinary
 * Read/Write/Edit tools. BetterClaude then watches the hub with chokidar and:
 *
 *   - renders every change in the pane's Team sidebar, and
 *   - RELAYS: when a message addresses another live teammate, its text is
 *     delivered straight into that teammate's pty (bracketed-paste wrapped),
 *     which is what makes the conversation active rather than poll-based.
 *
 * Delivery-into-stdin is a deliberate exception to this app's "keystrokes
 * only" rule for pty input, and it applies ONLY to sessions explicitly created
 * as teammates (or that joined via the sidebar button) — plain sessions keep
 * the old guarantee untouched. The user opted in by building a team.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const HUB_DIRNAME = ".bc-team";

/** Short codenames handed out to teammates as they join, in order. */
const MEMBER_NAMES = [
  "Atlas", "Nova", "Orion", "Vega", "Ember", "Cipher",
  "Beacon", "Quill", "Slate", "Comet", "Onyx", "Rune",
];

function hubPathFor(cwd) {
  return path.join(cwd, HUB_DIRNAME);
}

function agentsDir(hub) { return path.join(hub, "agents"); }
function messagesDir(hub) { return path.join(hub, "messages"); }
function changesDir(hub) { return path.join(hub, "changes"); }
function tasksFile(hub) { return path.join(hub, "tasks.json"); }

function ensureHub(cwd) {
  const hub = hubPathFor(cwd);
  for (const dir of [hub, agentsDir(hub), messagesDir(hub), changesDir(hub)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(tasksFile(hub))) {
    writeJsonSafe(tasksFile(hub), { tasks: [] });
  }
  return hub;
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * The system-prompt appendix that teaches a freshly spawned teammate the
 * protocol. Kept tight on purpose: it rides along with every request the
 * agent makes, so it says exactly what is needed and nothing more.
 */
function buildTeamPrompt({ hub, id, name }) {
  return [
    "You are part of a BetterClaude agent team: other Claude Code sessions are",
    "working in parallel with you, possibly in this same repository.",
    "",
    `Your teammate id: ${id}`,
    `Your teammate name: ${name}`,
    `Team hub directory: ${hub}`,
    "",
    "Follow this coordination protocol exactly:",
    "",
    "1. STATUS — keep your status file current so teammates can see what you",
    `   are doing: ${path.join(agentsDir(hub), "<id>.json")} written as`,
    '   {"id":"...","name":"...","status":"working|idle|blocked|done",',
    '   "currentTask":"one line describing your current focus","updated":"<ISO>"}.',
    "   Update it whenever your focus changes. Never write other agents' files.",
    "",
    "2. MESSAGES — to talk to teammates write one JSON file per message into",
    `   ${messagesDir(hub)} named <ms>-<yourid>-to-<targetid|all>.json:`,
    '   {"from":"<yourid>","to":"<targetid|all>","kind":"chat|question|review|handoff|done",',
    '   "body":"what you want to say"}. The orchestrator delivers it instantly.',
    "   Check that folder after finishing any step; reply promptly to anything",
    "   addressed to you or to all.",
    "",
    "3. TASK BOARD — the shared plan lives at " + tasksFile(hub) + " as",
    '   {"tasks":[{"id","title","assignee","state":"todo|doing|done"}]}. To pick',
    "   up work: choose an unassigned todo task that matches your skills, set",
    "   assignee to your id and state to doing BEFORE starting it, and mark it",
    "   done when finished. Never grab a task another agent already holds;",
    "   message them instead.",
    "",
    "4. WORK LOG — after you create or edit files, record what you made in",
    `   ${path.join(changesDir(hub), "<id>.json")}:`,
    '   {"summary":"one line","files":[{"path":"+12/-3 or blank","note":"why"}],',
    '   "updated":"<ISO>"}. Keep the newest changes first.',
    "",
    "5. COORDINATION — before editing a file another teammate lists in their",
    "   work log, message them and wait for a handoff. Prefer small, reviewable",
    "   chunks, ask for review with kind:\"review\", and announce done work with",
    "   kind:\"done\". You can see everyone's files on disk; treat their",
    "   in-progress edits as theirs until they say otherwise.",
    "",
    "Stay in your lane, communicate early, and keep the board honest.",
  ].join("\n");
}

/** Onboarding prompt typed into an EXISTING session that joins mid-flight. */
function buildJoinPrompt({ hub, id, name }) {
  return [
    "[BetterClaude] You have just joined an agent team. Other Claude Code",
    "sessions are working alongside you. Your teammate id: " + id +
      ", name: " + name + ".",
    "",
    buildTeamPrompt({ hub, id, name }),
    "",
    "Acknowledge by updating your status file, then continue with whatever the",
    "user asks next.",
  ].join("\n");
}

// --- Reads used to build snapshots -----------------------------------------

function listMembersFromFiles(hub) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(agentsDir(hub), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const data = readJsonSafe(path.join(agentsDir(hub), entry.name), null);
    if (data && typeof data.id === "string") out.push(data);
  }
  return out;
}

function listMessages(hub, limit = 300) {
  let files = [];
  try {
    files = fs.readdirSync(messagesDir(hub)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  // Message filenames start with a millisecond timestamp, so lexical order is
  // chronological order.
  files.sort();
  const tail = files.slice(-limit);
  const out = [];
  for (const file of tail) {
    const data = readJsonSafe(path.join(messagesDir(hub), file), null);
    if (!data || typeof data.body !== "string") continue;
    out.push({
      id: file.replace(/\.json$/, ""),
      from: String(data.from || "unknown"),
      to: String(data.to || "all"),
      kind: String(data.kind || "chat"),
      body: data.body,
      ts: Number(data.ts) || Number.parseInt(file.split("-")[0], 10) || Date.now(),
    });
  }
  return out;
}

function listTasks(hub) {
  const data = readJsonSafe(tasksFile(hub), null);
  return data && Array.isArray(data.tasks)
    ? data.tasks.filter((t) => t && typeof t.title === "string")
    : [];
}

function listChanges(hub) {
  const out = {};
  let entries = [];
  try {
    entries = fs.readdirSync(changesDir(hub), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.replace(/\.json$/, "");
    const data = readJsonSafe(path.join(changesDir(hub), entry.name), null);
    if (data) out[id] = data;
  }
  return out;
}

// --- Writes driven from the Team sidebar ------------------------------------

function writeAgentFile(hub, member) {
  return writeJsonSafe(path.join(agentsDir(hub), `${member.id}.json`), {
    ...member,
    updated: new Date().toISOString(),
  });
}

/** Drops a roster entry entirely — used when a spawn fails before it began. */
function removeAgentFile(hub, memberId) {
  try {
    fs.rmSync(path.join(agentsDir(hub), `${memberId}.json`), { force: true });
  } catch {
    // Already gone or unreadable — nothing to clean up.
  }
}

function addMessage(hub, { from, to, kind, body }) {
  const ts = Date.now();
  const id = `${ts}-${from}-to-${to}`;
  const payload = { from, to, kind: kind || "chat", body: String(body || ""), ts };
  if (writeJsonSafe(path.join(messagesDir(hub), `${id}.json`), payload)) {
    return { id, ...payload };
  }
  return null;
}

function saveTasks(hub, tasks) {
  return writeJsonSafe(tasksFile(hub), { tasks });
}

// --- Watching ---------------------------------------------------------------

/**
 * Watches every known hub directory and calls `onChange()` (debounced) whenever
 * anything an agent could have touched changes: statuses, messages, the task
 * board, or work logs. Returns a disposer.
 */
function watchHubs(hubs, onChange) {
  let chokidar;
  try {
    chokidar = require("chokidar");
  } catch {
    return () => {};
  }
  const watchers = [];
  let timer = 0;
  const fire = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      try {
        onChange();
      } catch {
        // A broken handler must never take the watcher down with it.
      }
    }, 150);
  };
  for (const hub of hubs) {
    try {
      const watcher = chokidar.watch(
        [agentsDir(hub), messagesDir(hub), changesDir(hub), tasksFile(hub)],
        { ignoreInitial: true, depth: 2, awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 } }
      );
      watcher.on("add", fire);
      watcher.on("change", fire);
      watcher.on("unlink", fire);
      watcher.on("addDir", fire);
      watcher.on("unlinkDir", fire);
      watchers.push(watcher);
    } catch {
      // One unreadable hub shouldn't stop the others from being watched.
    }
  }
  return () => {
    clearTimeout(timer);
    timer = 0;
    for (const watcher of watchers) {
      try { watcher.close(); } catch { /* already closed */ }
    }
  };
}

// --- Git summary ------------------------------------------------------------

function runGit(cwd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

function parseNumstat(stdout) {
  const files = [];
  for (const line of String(stdout || "").split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    files.push({
      path: m[3],
      added: m[1] === "-" ? null : Number(m[1]),
      deleted: m[2] === "-" ? null : Number(m[2]),
    });
  }
  return files;
}

/**
 * What has actually changed on disk in `cwd`, straight from git: staged +
 * unstaged work versus HEAD, plus untracked new files. This is the ground
 * truth behind "see what the other sessions have made"; agents' own work logs
 * provide the per-teammate attribution.
 */
async function gitSummary(cwd) {
  const [branch, numstat, untracked] = await Promise.all([
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(cwd, ["diff", "--numstat", "HEAD"]),
    runGit(cwd, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  if (numstat === null && branch === null) return null;
  const files = parseNumstat(numstat);
  for (const line of String(untracked || "").split("\n")) {
    const p = line.trim();
    if (p && !p.startsWith(".bc-team")) files.push({ path: p, added: null, deleted: null, untracked: true });
  }
  return {
    branch: branch ? branch.trim() : null,
    files,
  };
}

module.exports = {
  HUB_DIRNAME,
  MEMBER_NAMES,
  addMessage,
  agentsDir,
  buildJoinPrompt,
  buildTeamPrompt,
  changesDir,
  ensureHub,
  gitSummary,
  hubPathFor,
  listChanges,
  listMembersFromFiles,
  listMessages,
  listTasks,
  messagesDir,
  newId,
  readJsonSafe,
  saveTasks,
  tasksFile,
  watchHubs,
  writeAgentFile,
  removeAgentFile,
  writeJsonSafe,
};
