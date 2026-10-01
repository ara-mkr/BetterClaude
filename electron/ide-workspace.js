/**
 * BetterClaude Code workspace providers.
 *
 * Main-process only. The IDE renderer receives validated metadata and file
 * contents through sender-scoped IPC; it never receives a Node or filesystem
 * capability. Paths are resolved below the selected project root and symlinks
 * are not followed while building the tree.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { once } = require("events");
const AdmZip = require("adm-zip");
const { CATALOG } = require("../core/vscode-catalog");

const MAX_TREE_ENTRIES = 700;
const MAX_TREE_DEPTH = 7;
const MAX_TEXT_BYTES = 1024 * 1024;
const SKIP_DIRECTORIES = new Set([".git", ".claude", "node_modules", ".next", "dist", "build"]);

function realDirectory(cwd) {
  const resolved = path.resolve(String(cwd || ""));
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Project folder is not a directory.");
  return fs.realpathSync(resolved);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeProjectPath(cwd, relativePath, { mustExist = true } = {}) {
  const root = realDirectory(cwd);
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("A relative project path is required.");
  }
  const target = path.resolve(root, relativePath);
  if (!isInside(root, target)) throw new Error("Path must stay inside the selected project.");
  if (mustExist) {
    const realTarget = fs.realpathSync(target);
    if (!isInside(root, realTarget)) throw new Error("Symlinked paths outside the project are not allowed.");
    return { root, target: realTarget };
  }
  const parent = fs.realpathSync(path.dirname(target));
  if (!isInside(root, parent)) throw new Error("The file parent must stay inside the selected project.");
  return { root, target };
}

function sortEntries(entries) {
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function listProjectTree(cwd) {
  const root = realDirectory(cwd);
  let count = 0;      // total entries (files + folders) — the walk's perf budget
  let fileCount = 0;  // files only — what the "Project files" stat actually means
  let truncated = false; // true once the walk stops early, so the count is a floor

  function walk(directory, depth) {
    if (depth > MAX_TREE_DEPTH) { truncated = true; return []; }
    if (count >= MAX_TREE_ENTRIES) { truncated = true; return []; }
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }

    const nodes = [];
    for (const entry of entries) {
      if (count >= MAX_TREE_ENTRIES) { truncated = true; break; }
      if (entry.name === ".DS_Store" || entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        count += 1;
        nodes.push({ name: entry.name, path: relative, kind: "folder", children: walk(absolute, depth + 1) });
      } else if (entry.isFile()) {
        count += 1;
        fileCount += 1;
        nodes.push({ name: entry.name, path: relative, kind: "file" });
      }
    }
    return sortEntries(nodes);
  }

  const nodes = walk(root, 0);
  // count is kept for backward compatibility; fileCount + truncated are what the
  // "Project files" stat reads so a large tree reports e.g. "612+" instead of a
  // flat, misleading "700" (the walk's MAX_TREE_ENTRIES cap) that counted
  // folders as files.
  return { root, nodes, count, fileCount, truncated };
}

function readFirstCwd(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(128 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const text = buffer.toString("utf8", 0, bytes);
    for (const line of text.split("\n").slice(0, 80)) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.cwd === "string") return parsed.cwd;
      } catch {
        // Ignore malformed or partial lines.
      }
    }
  } catch {
    // A session can be removed while the index is being refreshed.
  }
  return null;
}

function listProjectIndex(extraCwds = []) {
  const byCwd = new Map();
  for (const cwd of extraCwds) {
    try {
      const root = realDirectory(cwd);
      byCwd.set(root, { cwd: root, lastActivity: 0 });
    } catch {
      // Stale recent folder.
    }
  }

  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  try {
    for (const directory of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const folder = path.join(projectsRoot, directory.name);
      const transcripts = fs.readdirSync(folder).filter((name) => name.endsWith(".jsonl"));
      for (const filename of transcripts) {
        const filePath = path.join(folder, filename);
        const cwd = readFirstCwd(filePath);
        if (!cwd) continue;
        try {
          const root = realDirectory(cwd);
          const mtimeMs = fs.statSync(filePath).mtimeMs;
          const current = byCwd.get(root) || { cwd: root, lastActivity: 0 };
          current.lastActivity = Math.max(current.lastActivity, mtimeMs);
          byCwd.set(root, current);
          break;
        } catch {
          // Ignore projects whose folder no longer exists.
        }
      }
    }
  } catch {
    // The CLI may not have created ~/.claude/projects yet.
  }

  return Array.from(byCwd.values())
    .map(({ cwd, lastActivity }) => {
      let sessionCount = 0;
      try {
        const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
        const directory = path.join(projectsRoot, slug);
        sessionCount = fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl")).length;
      } catch {
        // A recent folder can have no transcript yet.
      }
      return {
        cwd,
        name: path.basename(cwd) || cwd,
        sessionCount,
        lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
      };
    })
    .sort((a, b) => (Date.parse(b.lastActivity || "") || 0) - (Date.parse(a.lastActivity || "") || 0));
}

function readProjectFile(cwd, relativePath) {
  const { root, target } = safeProjectPath(cwd, relativePath);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error("Only files can be opened in the editor.");
  if (stat.size > MAX_TEXT_BYTES) throw new Error("This file is too large for the embedded editor.");
  const buffer = fs.readFileSync(target);
  if (buffer.includes(0)) return { path: path.relative(root, target).split(path.sep).join("/"), binary: true, size: stat.size, mtimeMs: stat.mtimeMs, content: "" };
  return {
    path: path.relative(root, target).split(path.sep).join("/"),
    binary: false,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    content: buffer.toString("utf8"),
  };
}

function readProjectFiles(cwd, relativePaths) {
  if (!Array.isArray(relativePaths)) throw new Error("A list of project files is required.");
  return relativePaths.slice(0, 12).map((relativePath) => readProjectFile(cwd, relativePath));
}

function writeProjectFile(cwd, relativePath, content, expectedMtimeMs) {
  if (typeof content !== "string") throw new Error("File content must be text.");
  const { root, target } = safeProjectPath(cwd, relativePath);
  const current = fs.statSync(target);
  if (!current.isFile()) throw new Error("Only files can be saved from the editor.");
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) throw new Error("This file is too large to save from the embedded editor.");
  if (Number.isFinite(expectedMtimeMs) && Math.abs(current.mtimeMs - expectedMtimeMs) > 1) {
    return { ok: false, conflict: true, mtimeMs: current.mtimeMs };
  }
  fs.writeFileSync(target, content, "utf8");
  const updated = fs.statSync(target);
  return { ok: true, conflict: false, path: path.relative(root, target).split(path.sep).join("/"), mtimeMs: updated.mtimeMs };
}

function runFile(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 8000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// git push / gh pr create can take far longer than a status read — a separate
// generous budget so they aren't killed mid-network.
function runLong(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function getGitInfo(cwd) {
  const root = realDirectory(cwd);
  const [status, diffStat, branch, ahead, upstream] = await Promise.all([
    runFile("git", ["-C", root, "status", "--short"], root),
    // vs HEAD so staged + unstaged tracked edits both count — this is the
    // "what Claude changed since the last commit" number the SCM bar shows.
    runFile("git", ["-C", root, "diff", "--stat", "HEAD"], root),
    runFile("git", ["-C", root, "branch", "--show-current"], root),
    runFile("git", ["-C", root, "rev-list", "--count", "@{upstream}..HEAD"], root),
    runFile("git", ["-C", root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], root),
  ]);
  const statusLines = status.error ? [] : status.stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  return {
    isRepo: !status.error,
    branch: branch.error ? null : branch.stdout.trim() || null,
    changedFiles: statusLines.length,
    statusLines: statusLines.slice(0, 80),
    diffStat: diffStat.error ? "" : diffStat.stdout.trim(),
    ahead: ahead.error ? 0 : (parseInt(ahead.stdout.trim(), 10) || 0),
    hasUpstream: !upstream.error && !!upstream.stdout.trim(),
  };
}

/**
 * Open a pull request for the current branch: commit any pending work (only
 * when `commit` is set), push to origin, then run `gh pr create`. Every failure
 * mode returns { ok:false, error } — nothing here throws into the IPC layer.
 * `needsCommit:true` is a soft stop so the renderer can confirm the commit.
 */
async function createPullRequest(cwd, opts = {}) {
  const root = realDirectory(cwd);
  const gh = await runFile("gh", ["--version"], root);
  if (gh.error) {
    return { ok: false, error: "GitHub CLI (gh) isn't installed or on PATH. Install it from cli.github.com, then run `gh auth login`." };
  }
  const branchRes = await runFile("git", ["-C", root, "branch", "--show-current"], root);
  if (branchRes.error) return { ok: false, error: "This folder is not a Git repository." };
  const branch = branchRes.stdout.trim();
  if (!branch) return { ok: false, error: "You're on a detached HEAD — check out a branch first." };
  if (/^(main|master|develop|trunk)$/i.test(branch)) {
    return { ok: false, error: `You're on "${branch}". Create a feature branch before opening a pull request.` };
  }

  const steps = [];
  const status = await runFile("git", ["-C", root, "status", "--porcelain"], root);
  if (status.stdout.trim()) {
    if (!opts.commit) return { ok: false, needsCommit: true, branch, error: "You have uncommitted changes." };
    const add = await runLong("git", ["-C", root, "add", "-A"], root);
    if (add.error) return { ok: false, steps, error: `git add failed: ${(add.stderr || add.error.message || "").trim()}` };
    const message = String(opts.commitMessage || "").trim() || "Changes from BetterClaude Code";
    const commit = await runLong("git", ["-C", root, "commit", "-m", message], root);
    if (commit.error) return { ok: false, steps, error: `git commit failed: ${(commit.stderr || commit.error.message || "").trim()}` };
    steps.push("committed");
  }

  const push = await runLong("git", ["-C", root, "push", "-u", "origin", "HEAD"], root);
  if (push.error) return { ok: false, steps, error: `git push failed: ${(push.stderr || push.error.message || "").trim()}` };
  steps.push("pushed");
  if (opts.pushOnly) return { ok: true, steps, branch };

  const ghArgs = opts.web ? ["pr", "create", "--web", "--fill"] : ["pr", "create", "--fill"];
  const pr = await runLong("gh", ghArgs, root);
  // --web opens the browser and may exit non-zero once the tab is handed off;
  // only treat a non-web failure as fatal.
  if (pr.error && !opts.web) {
    const detail = (pr.stderr || pr.error.message || "").trim();
    if (/already exists/i.test(detail)) {
      const view = await runFile("gh", ["pr", "view", "--json", "url", "-q", ".url"], root);
      return { ok: true, steps, branch, url: view.error ? null : view.stdout.trim(), note: "PR already existed" };
    }
    return { ok: false, steps, error: `gh pr create failed: ${detail}` };
  }
  steps.push(opts.web ? "opened a PR draft in your browser" : "created the PR");
  const url = (String(pr.stdout || "").match(/https?:\/\/\S+/) || [])[0] || null;
  return { ok: true, steps, branch, url };
}

async function getGitDiff(cwd) {
  const root = realDirectory(cwd);
  const [unstaged, staged] = await Promise.all([
    runFile("git", ["-C", root, "--no-pager", "diff", "--no-ext-diff", "--unified=3", "--"], root),
    runFile("git", ["-C", root, "--no-pager", "diff", "--cached", "--no-ext-diff", "--unified=3", "--"], root),
  ]);
  const parts = [];
  if (!unstaged.error && unstaged.stdout.trim()) parts.push(unstaged.stdout.trimEnd());
  if (!staged.error && staged.stdout.trim()) parts.push(staged.stdout.trimEnd());
  return {
    isRepo: !unstaged.error || !staged.error,
    diff: parts.join("\n\n"),
  };
}

// Editors whose extension folders are worth showing in the Code workspace's
// Extensions panel — each keeps installs in `~/.<dir>/extensions/<publisher>.<name>-<version>[-platform-arch]`,
// one subfolder per installed extension, same layout VS Code popularized.
const EXTENSION_HOSTS = [
  { dir: ".vscode", label: "VS Code" },
  { dir: ".cursor", label: "Cursor" },
  { dir: ".antigravity", label: "Antigravity" },
  { dir: ".vscode-insiders", label: "VS Code Insiders" },
];
const MAX_ICON_BYTES = 64 * 1024;

function readExtensionIcon(extensionDir, iconRelativePath) {
  if (typeof iconRelativePath !== "string" || !iconRelativePath) return null;
  try {
    const iconPath = path.resolve(extensionDir, iconRelativePath);
    if (!isInside(extensionDir, iconPath)) return null;
    const stat = fs.statSync(iconPath);
    if (!stat.isFile() || stat.size > MAX_ICON_BYTES) return null;
    const ext = path.extname(iconPath).slice(1).toLowerCase();
    const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${fs.readFileSync(iconPath).toString("base64")}`;
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  const partsA = String(a || "0").split(".").map((part) => parseInt(part, 10) || 0);
  const partsB = String(b || "0").split(".").map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Real installed extensions for every locally installed VS Code-family editor
 * this machine has (VS Code, Cursor, Antigravity, ...), not a fixed sample.
 * Each install folder is `<publisher>.<name>-<version>[-<platform>-<arch>]`;
 * the version/platform suffix is stripped from the id using the package.json
 * itself as the source of truth, and the highest version per publisher.name
 * wins when the same extension is installed under more than one host.
 */
function listInstalledExtensions() {
  const byId = new Map();
  for (const { dir, label } of EXTENSION_HOSTS) {
    const extensionsRoot = path.join(os.homedir(), dir, "extensions");
    let entries;
    try {
      entries = fs.readdirSync(extensionsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const extensionDir = path.join(extensionsRoot, entry.name);
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf8"));
      } catch {
        continue;
      }
      if (!manifest.name || !manifest.publisher) continue;
      const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
      const existing = byId.get(id);
      // Every editor that has it, for the full IDE's import picker.
      const hosts = existing ? [...new Set([...existing.hosts, label])] : [label];
      if (existing && compareVersions(existing.version, manifest.version) >= 0) { existing.hosts = hosts; continue; }
      byId.set(id, {
        id,
        displayName: manifest.displayName || manifest.name,
        publisher: manifest.publisher,
        version: manifest.version || "0.0.0",
        description: manifest.description || "",
        host: label,
        hosts,
        icon: readExtensionIcon(extensionDir, manifest.icon),
      });
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }));
}

/* ---------------------------------------------------------------------- *
 * Extension marketplace (Browse + Install).
 *
 * The Installed half above reads disk; this half talks to the Open VSX
 * registry (open-vsx.org), the vendor-neutral mirror of the VS Code
 * marketplace that Cursor/VSCodium/every non-Microsoft editor already uses.
 * Search and metadata are plain GETs; Install downloads a .vsix (a zip whose
 * payload lives under `extension/`) and unpacks it into the same
 * ~/.<editor>/extensions/<publisher>.<name>-<version>/ layout listInstalled-
 * Extensions() reads back — so an installed extension immediately shows up in
 * the Installed tab with no special casing.
 * ---------------------------------------------------------------------- */

const OPEN_VSX_BASE = "https://open-vsx.org";
const MAX_VSIX_BYTES = 400 * 1024 * 1024;
const MAX_ICON_FETCH_BYTES = 64 * 1024;
// Publisher/name segments on open-vsx are lowercase alphanumerics plus dashes.
// Validating here keeps a crafted renderer payload from building registry URLs
// or filesystem paths outside the extensions folder.
const REGISTRY_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function assertRegistrySegment(value, label) {
  if (typeof value !== "string" || !REGISTRY_SEGMENT_RE.test(value)) {
    throw new Error(`Invalid extension ${label}.`);
  }
  return value;
}

function normalizeExtensionId(id) {
  const raw = String(id || "").trim().toLowerCase();
  const parts = raw.split(".");
  if (parts.length !== 2 || parts.some((part) => !REGISTRY_SEGMENT_RE.test(part))) return null;
  return { publisher: parts[0], name: parts[1], id: `${parts[0]}.${parts[1]}` };
}

async function fetchJson(url, { timeoutMs = 15000 } = {}) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "BetterClaude" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Registry returned ${response.status}`);
  return response.json();
}

/** Fetches an image URL and inlines it as a data: URI (CSP forbids remote img src). */
async function fetchIconDataUrl(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_ICON_FETCH_BYTES) return null;
    const type = response.headers.get("content-type") || "image/png";
    if (!/^image\/(png|jpeg|svg\+xml|webp)$/.test(type)) return null;
    return `data:${type};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

async function downloadToTempFile(url, bytesLabel) {
  const response = await fetch(url, { headers: { "user-agent": "BetterClaude" }, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_VSIX_BYTES) throw new Error(`${bytesLabel} is too large to install.`);
  fs.mkdtempSync(path.join(os.tmpdir(), "bc-ext-"));
  const tempFile = path.join(os.tmpdir(), `bc-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.vsix`);
  const fileStream = fs.createWriteStream(tempFile);
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > MAX_VSIX_BYTES) {
      fileStream.destroy();
      try { fs.rmSync(tempFile, { force: true }); } catch {}
      throw new Error(`${bytesLabel} is too large to install.`);
    }
    if (!fileStream.write(chunk)) await once(fileStream, "drain");
  }
  fileStream.end();
  await once(fileStream, "finish");
  return tempFile;
}

/**
 * The host folder installs land in: the first editor's extensions directory
 * this machine actually has (~/.vscode beats ~/.cursor beats ...), defaulting
 * to VS Code itself so a machine with none of these editors still gets a sane
 * target. The label is cosmetic — it names the host in the UI.
 */
function pickInstallHost() {
  for (const host of EXTENSION_HOSTS) {
    if (fs.existsSync(path.join(os.homedir(), host.dir))) return host;
  }
  return EXTENSION_HOSTS[0];
}

/** Where Install writes, as "~/.vscode/extensions" — shown on the button. */
function installDirLabel() {
  return `~/${pickInstallHost().dir}/extensions`;
}

async function readManifestEntry(extensionDir, hostLabel) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf8"));
  } catch {
    throw new Error("The downloaded extension has no readable package.json.");
  }
  if (!manifest.name || !manifest.publisher) throw new Error("The downloaded extension has an invalid manifest.");
  return {
    id: `${manifest.publisher}.${manifest.name}`.toLowerCase(),
    displayName: manifest.displayName || manifest.name,
    publisher: manifest.publisher,
    version: manifest.version || "0.0.0",
    description: manifest.description || "",
    host: hostLabel,
    icon: readExtensionIcon(extensionDir, manifest.icon),
  };
}

async function searchRegistryExtensions(query, { size = 30 } = {}) {
  const needle = String(query || "").trim().toLowerCase();

  // Empty box = the curated catalog, no network. Same contract as the themes
  // gallery: something useful before any request is made.
  const catalogEntries = () =>
    CATALOG.filter((entry) => !needle
      || entry.id.includes(needle)
      || entry.displayName.toLowerCase().includes(needle)
      || (entry.description || "").toLowerCase().includes(needle)
      || (entry.category || "").toLowerCase().includes(needle))
      .map(({ id, displayName, publisher, description, category }) => ({
        id, displayName, publisher, description, category,
        version: null, source: "catalog", downloads: null, icon: null,
      }));

  if (!needle) return catalogEntries();

  try {
    const url = `${OPEN_VSX_BASE}/api/-/search?query=${encodeURIComponent(needle)}&size=${Math.max(1, Math.min(50, size))}&sortBy=downloadCount`;
    const json = await fetchJson(url);
    const results = await Promise.all((Array.isArray(json.extensions) ? json.extensions : []).slice(0, size).map(async (item) => ({
      id: `${item.namespace}.${item.name}`.toLowerCase(),
      displayName: item.displayName || item.name,
      publisher: item.namespace,
      version: item.version || null,
      description: (item.description || "").slice(0, 240),
      category: "",
      source: "registry",
      downloads: typeof item.downloadCount === "number" ? item.downloadCount : null,
      icon: item.files && item.files.icon ? await fetchIconDataUrl(item.files.icon) : null,
    })));
    if (!results.length) return catalogEntries();
    return results;
  } catch {
    // Offline or registry unreachable: the curated catalog still answers.
    return catalogEntries();
  }
}

async function installExtension({ id }) {
  const parsed = normalizeExtensionId(id);
  if (!parsed) throw new Error("Extension ids look like <publisher>.<name>.");
  const host = pickInstallHost();
  const extensionsRoot = path.join(os.homedir(), host.dir, "extensions");

  const meta = await fetchJson(`${OPEN_VSX_BASE}/api/${encodeURIComponent(parsed.publisher)}/${encodeURIComponent(parsed.name)}`);
  const version = meta.version;
  if (!version) throw new Error("The registry did not report a version to install.");
  const downloadUrl = meta.files && meta.files.download;
  if (typeof downloadUrl !== "string" || !/^https:\/\//.test(downloadUrl)) throw new Error("No downloadable package was found for this extension.");

  const targetDir = path.join(extensionsRoot, `${parsed.id}-${version}`);
  if (fs.existsSync(targetDir)) {
    return { ok: true, alreadyInstalled: true, extension: await readManifestEntry(targetDir, host.label) };
  }

  const vsixPath = await downloadToTempFile(downloadUrl, "This extension");
  try {
    const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-vsix-"));
    try {
      // A .vsix is a zip whose payload lives under extension/. AdmZip is
      // already a project dependency (session-bundle.js); extraction is bounded
      // by MAX_VSIX_BYTES above rather than by trusting the archive.
      new AdmZip(vsixPath).extractAllTo(extractRoot, true);
      const payloadDir = path.join(extractRoot, "extension");
      if (!fs.existsSync(payloadDir)) throw new Error("The downloaded package had no extension payload.");
      fs.mkdirSync(extensionsRoot, { recursive: true });
      fs.cpSync(payloadDir, targetDir, { recursive: true });
    } finally {
      fs.rmSync(extractRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(vsixPath, { force: true });
  }

  return { ok: true, alreadyInstalled: false, extension: await readManifestEntry(targetDir, host.label) };
}

/**
 * Removes every on-disk version of `<id>-*` across all known hosts. Prefix
 * matching is safe because install folders are exactly
 * `<publisher>.<name>-<version>[-platform]` and the id itself is validated.
 */
function uninstallExtension(id) {
  const parsed = normalizeExtensionId(id);
  if (!parsed) throw new Error("Extension ids look like <publisher>.<name>.");
  const prefix = `${parsed.id}-`;
  let removed = 0;
  for (const { dir } of EXTENSION_HOSTS) {
    const extensionsRoot = path.join(os.homedir(), dir, "extensions");
    let entries;
    try {
      entries = fs.readdirSync(extensionsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const target = path.join(extensionsRoot, entry.name);
      // Belt and braces: never rm anything that isn't directly inside the
      // extensions root.
      if (path.dirname(target) !== extensionsRoot) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed += 1;
    }
  }
  if (!removed) throw new Error("That extension was not found in any local editor.");
  return { ok: true, removed };
}

module.exports = {
  MAX_TEXT_BYTES,
  createPullRequest,
  getGitDiff,
  getGitInfo,
  installExtension,
  installDirLabel,
  listInstalledExtensions,
  listProjectIndex,
  listProjectTree,
  readProjectFile,
  readProjectFiles,
  realDirectory,
  searchRegistryExtensions,
  safeProjectPath,
  uninstallExtension,
  writeProjectFile,
};
