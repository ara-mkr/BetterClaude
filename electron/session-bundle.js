/**
 * Team Sync 2.0 — Session Bundle export/import. Electron main-process only
 * (fs + child_process + adm-zip), same split as electron/team-sync.js.
 *
 * Reads two things, both local files the real `claude` CLI already wrote to
 * disk on its own — never claude.ai, never a credential store:
 *
 *   1. Session transcripts: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
 *      This is Claude Code's own on-disk log (JSON Lines; each line is an
 *      event — "user"/"assistant" carry a `message: {role, content}` in the
 *      Anthropic Messages API shape, plus `cwd`, `sessionId`, `timestamp`,
 *      `gitBranch`). Confirmed by inspecting real files on this machine
 *      before writing this module — see the encoding note on
 *      `encodeCwdToProjectSlug` below for the one assumption that couldn't be
 *      confirmed the same way.
 *   2. `git diff` / `git rev-parse` output for the project, via the system
 *      `git` binary — same approach as team-sync.js.
 *
 * This module never touches electron/claude-cli.js's pty session, never
 * reads Claude Code's config/credentials, and has no network calls.
 *
 * Redaction is enforced here, not just in the UI: exportSessionBundle()
 * re-scans every "include" session itself and throws SecretsFoundError
 * before writing anything if it finds a match the caller didn't already mark
 * "redact" or "exclude". There is no parameter that skips this.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");

const BUNDLE_VERSION = 1;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || "").trim() || `${cmd} failed`));
      else resolve(stdout);
    });
  });
}

function projectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Best-effort reproduction of how the real `claude` CLI names a project's
 * transcript directory: every character that isn't a letter or digit becomes
 * a dash. Confirmed against this machine's own `~/.claude/projects/` for
 * plain paths (e.g. `/Users/x/Documents/BetterClaude` ->
 * `-Users-x-Documents-BetterClaude`); no path containing a `.` was available
 * locally to confirm dot handling, so that part is an assumption. Because of
 * that, callers should treat the result as a first guess and confirm a match
 * by reading the `cwd` field back out of a candidate file (see
 * `listSessionsForCwd`), not trust the slug alone.
 */
function encodeCwdToProjectSlug(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

function readJsonlLines(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Torn or hand-edited line — skip it, same tolerance as the app's own
      // session history log.
    }
  }
  return out;
}

/**
 * All local Claude Code sessions recorded for `cwd`, newest first.
 *
 * Confirms each candidate file actually belongs to `cwd` by reading its own
 * `cwd` field back out, rather than trusting the directory-name encoding —
 * see the comment on encodeCwdToProjectSlug.
 */
function listSessionsForCwd(cwd) {
  const dir = path.join(projectsDir(), encodeCwdToProjectSlug(cwd));
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const sessions = [];
  for (const filename of entries) {
    const filePath = path.join(dir, filename);
    const sessionId = filename.replace(/\.jsonl$/, "");
    const lines = readJsonlLines(filePath);
    if (lines.length === 0) continue;

    const withCwd = lines.find((l) => typeof l.cwd === "string");
    if (withCwd && path.resolve(withCwd.cwd) !== path.resolve(cwd)) continue;

    let firstTimestamp = null;
    let lastTimestamp = null;
    let messageCount = 0;
    for (const l of lines) {
      if (typeof l.timestamp === "string") {
        if (!firstTimestamp) firstTimestamp = l.timestamp;
        lastTimestamp = l.timestamp;
      }
      if (l.type === "user" || l.type === "assistant") messageCount++;
    }

    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      // Leave at 0 — sort falls back to timestamp field order below.
    }

    sessions.push({ sessionId, filePath, firstTimestamp, lastTimestamp, messageCount, mtimeMs });
  }

  sessions.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return sessions;
}

// --- Redaction ------------------------------------------------------------

/**
 * Common secret shapes. Each pattern is matched against the raw transcript
 * text (JSON Lines, so a match inside a string value is still a plain
 * substring match). Deliberately conservative — false negatives on an exotic
 * key format are safer to accept than false positives that make every export
 * demand review of ordinary text, which teaches people to click through the
 * warning without reading it.
 */
const SECRET_PATTERNS = [
  { id: "aws-access-key", label: "AWS Access Key ID", re: /AKIA[0-9A-Z]{16}/g },
  { id: "gcp-api-key", label: "GCP API Key", re: /AIza[0-9A-Za-z\-_]{35}/g },
  { id: "anthropic-key", label: "Anthropic API Key", re: /sk-ant-[a-zA-Z0-9\-_]{20,}/g },
  { id: "openai-key", label: "OpenAI API Key", re: /sk-[A-Za-z0-9]{32,}/g },
  { id: "github-token", label: "GitHub Token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: "slack-token", label: "Slack Token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: "private-key-block", label: "Private Key Block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: "jwt", label: "JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    id: "env-secret-line",
    label: ".env-style secret assignment",
    re: /\b[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|APIKEY|PASSWORD|PWD|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*['"]?[^\s'"]{6,}['"]?/gi,
  },
];

function maskMatch(value) {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

/**
 * Scans raw transcript text for secret-shaped substrings.
 * Returns findings with a masked preview, never the raw matched text — the
 * scan result itself is shown in a UI and must not become a second copy of
 * the secret.
 */
function scanTextForSecrets(text) {
  const lines = text.split("\n");
  const findings = [];
  lines.forEach((line, idx) => {
    for (const pattern of SECRET_PATTERNS) {
      pattern.re.lastIndex = 0;
      let m;
      while ((m = pattern.re.exec(line))) {
        findings.push({
          patternId: pattern.id,
          label: pattern.label,
          line: idx + 1,
          preview: maskMatch(m[0]),
        });
        if (!pattern.re.global) break;
      }
    }
  });
  return findings;
}

function scanSessionFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  return scanTextForSecrets(text);
}

function scanSessions(sessionFiles) {
  const result = {};
  for (const { sessionId, filePath } of sessionFiles) {
    result[sessionId] = scanSessionFile(filePath);
  }
  return result;
}

/** Replaces every matched secret substring with a fixed, harmless placeholder. */
function redactText(text) {
  let redacted = text;
  let count = 0;
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    redacted = redacted.replace(pattern.re, () => {
      count++;
      return `[REDACTED:${pattern.id}]`;
    });
  }
  return { text: redacted, count };
}

class SecretsFoundError extends Error {
  constructor(sessionId, findings) {
    super(`Session ${sessionId} contains ${findings.length} possible secret(s) and must be redacted or excluded before export.`);
    this.name = "SecretsFoundError";
    this.sessionId = sessionId;
    this.findings = findings;
  }
}

// --- git helpers ------------------------------------------------------------

async function getGitCommit(cwd) {
  try {
    return (await run("git", ["-C", cwd, "rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}

async function getGitDiff(cwd) {
  try {
    const diff = await run("git", ["-C", cwd, "diff", "HEAD"]);
    return diff.trim() ? diff : null;
  } catch {
    return null;
  }
}

async function getClaudeCliVersion(binaryPath) {
  if (!binaryPath) return null;
  try {
    return (await run(binaryPath, ["--version"])).trim();
  } catch {
    return null;
  }
}

// --- Export -----------------------------------------------------------------

/**
 * Writes a .bcbundle (a zip file) to `destPath`.
 *
 * `sessions`: [{ sessionId, filePath, action }], action one of
 * "include" | "redact" | "exclude". For "include", this function re-scans
 * the file itself — a session cannot reach the zip with secrets in it no
 * matter what the caller believed the state was; this is the enforcement
 * point, not the UI.
 */
async function exportSessionBundle({ cwd, projectName, sessions, includeDiff, author, binaryPath, destPath }) {
  const zip = new AdmZip();
  const manifestSessions = [];

  for (const s of sessions) {
    if (s.action === "exclude") {
      manifestSessions.push({
        sessionId: s.sessionId,
        status: "excluded",
        messageCount: null,
        firstTimestamp: null,
        lastTimestamp: null,
        redactionCount: 0,
        reason: s.reason || "excluded by user",
      });
      continue;
    }

    const raw = fs.readFileSync(s.filePath, "utf8");
    const findings = scanTextForSecrets(raw);
    let finalText = raw;
    let status = "included";
    let redactionCount = 0;

    if (findings.length > 0) {
      if (s.action !== "redact") throw new SecretsFoundError(s.sessionId, findings);
      const result = redactText(raw);
      finalText = result.text;
      redactionCount = result.count;
      status = "redacted";
    }

    zip.addFile(`transcripts/${s.sessionId}.jsonl`, Buffer.from(finalText, "utf8"));
    manifestSessions.push({
      sessionId: s.sessionId,
      status,
      messageCount: s.messageCount ?? null,
      firstTimestamp: s.firstTimestamp ?? null,
      lastTimestamp: s.lastTimestamp ?? null,
      redactionCount,
      reason: null,
    });
  }

  let diffIncluded = false;
  if (includeDiff) {
    const diff = await getGitDiff(cwd);
    if (diff) {
      zip.addFile("diff.patch", Buffer.from(diff, "utf8"));
      diffIncluded = true;
    }
  }

  const manifest = {
    bundleVersion: BUNDLE_VERSION,
    projectName,
    generatedAt: new Date().toISOString(),
    cliVersion: await getClaudeCliVersion(binaryPath),
    gitCommit: await getGitCommit(cwd),
    author: author || null,
    diffIncluded,
    sessions: manifestSessions,
  };

  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  zip.writeZip(destPath);
  return manifest;
}

// --- Import -----------------------------------------------------------------

function readBundleManifest(bundlePath) {
  const zip = new AdmZip(bundlePath);
  const entry = zip.getEntry("manifest.json");
  if (!entry) throw new Error("Not a valid .bcbundle — missing manifest.json");
  return JSON.parse(zip.readAsText(entry));
}

/** Parsed message list for one session in a bundle, for the transcript viewer. */
function readBundleSessionMessages(bundlePath, sessionId) {
  const zip = new AdmZip(bundlePath);
  const entry = zip.getEntry(`transcripts/${sessionId}.jsonl`);
  if (!entry) throw new Error(`Session ${sessionId} is not present in this bundle (excluded, or wrong id).`);
  const text = zip.readAsText(entry);
  const lines = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // Skip a torn line, same tolerance as everywhere else in this module.
    }
  }
  return lines;
}

function readBundleDiff(bundlePath) {
  const zip = new AdmZip(bundlePath);
  const entry = zip.getEntry("diff.patch");
  return entry ? zip.readAsText(entry) : null;
}

/** Flattens a session's message text into plain lines, for "resume from here". */
function formatMessagesAsPlainText(messages, { maxChars = 20000 } = {}) {
  const parts = [];
  for (const m of messages) {
    if (m.type !== "user" && m.type !== "assistant") continue;
    const who = m.type === "user" ? "User" : "Claude";
    const content = m.message && m.message.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
    }
    if (text.trim()) parts.push(`${who}: ${text.trim()}`);
  }
  let joined = parts.join("\n\n");
  if (joined.length > maxChars) joined = `${joined.slice(0, maxChars)}\n\n[...truncated...]`;
  return joined;
}

module.exports = {
  BUNDLE_VERSION,
  encodeCwdToProjectSlug,
  listSessionsForCwd,
  SECRET_PATTERNS,
  scanTextForSecrets,
  scanSessions,
  redactText,
  SecretsFoundError,
  exportSessionBundle,
  readBundleManifest,
  readBundleSessionMessages,
  readBundleDiff,
  formatMessagesAsPlainText,
  getGitCommit,
};
