/**
 * Team/Shared Plugin Sync — Electron main-process only (child_process +
 * fs), so this lives in electron/, not /core, same split as electron/
 * analytics-db.js. Shells out to the system `git` binary (clone once, then
 * fetch + hard-reset on every subsequent sync) rather than a JS git
 * library — this app already keeps dependencies light, and a real git repo
 * is exactly what the spec asks for, so this is a thin wrapper rather than
 * a from-scratch git implementation.
 *
 * The cloned repo (userData/team-sync/<slug>/) is always force-reset to
 * match the remote branch tip — it's a read-only mirror we scan, not
 * something a user edits directly, so there's nothing to "merge" at that
 * level. The actual local-vs-repo conflict the spec asks for happens one
 * level up, when copying a matched file from the clone into the real
 * install location (userData/plugins/ or userData/themes/) that the user's
 * own edits might already have touched — see classify() below.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || "").trim() || `${cmd} failed`));
      else resolve(stdout);
    });
  });
}

function slugifyRepoUrl(url) {
  const slug = String(url || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 80);
  return slug || "repo";
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Clones (first run) or fetches + hard-resets (every run after) a repo
// into teamSyncDir/<slug>. Returns the clone's absolute path.
async function syncRepo({ repoUrl, branch, teamSyncDir }) {
  if (!repoUrl) throw new Error("Set a repo URL first.");
  const slug = slugifyRepoUrl(repoUrl);
  const dest = path.join(teamSyncDir, slug);
  const branchArg = branch && branch.trim() ? branch.trim() : "main";

  if (fs.existsSync(path.join(dest, ".git"))) {
    await run("git", ["-C", dest, "fetch", "--depth", "1", "origin", branchArg]);
    await run("git", ["-C", dest, "reset", "--hard", `origin/${branchArg}`]);
  } else {
    fs.mkdirSync(teamSyncDir, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    await run("git", ["clone", "--depth", "1", "--branch", branchArg, repoUrl, dest]);
  }
  return dest;
}

// Recursively finds files matching any of `exts` under `dir`, skipping .git.
function walkFiles(dir, exts) {
  const results = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.some((ext) => entry.name.endsWith(ext))) {
        results.push({ relPath: path.relative(dir, full), absPath: full, filename: entry.name });
      }
    }
  }
  walk(dir);
  return results;
}

// Classifies one repo file against the corresponding local install path and
// the manifest hash recorded the last time this app applied it:
//   "new"              — nothing installed locally yet, safe to apply
//   "in-sync"          — local content already matches the repo exactly
//   "update-available" — local matches what we last applied; repo moved on,
//                        the user hasn't touched their copy — safe to apply
//   "local-edited"     — repo hasn't changed since last sync, but the local
//                        copy has (the user customized it) — not a
//                        conflict, nothing new to apply
//   "conflict"         — both the repo AND the local copy changed since the
//                        last sync — needs an explicit decision
function classify({ repoContent, localPath, manifestHash }) {
  const repoHash = sha256(repoContent);
  if (!fs.existsSync(localPath)) return { status: "new", repoHash };

  const localContent = fs.readFileSync(localPath, "utf8");
  const localHash = sha256(localContent);
  if (localHash === repoHash) return { status: "in-sync", repoHash, localHash };
  if (manifestHash && localHash === manifestHash) return { status: "update-available", repoHash, localHash, localContent };
  if (manifestHash && repoHash === manifestHash) return { status: "local-edited", repoHash, localHash };
  return { status: "conflict", repoHash, localHash, localContent };
}

module.exports = { syncRepo, walkFiles, classify, sha256, slugifyRepoUrl };
