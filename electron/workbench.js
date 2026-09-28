/**
 * The full-IDE engine: a local VS Code workbench server (VSCodium's REH-web
 * build of VS Code OSS — see docs/ADR-0001-full-ide-workbench.md).
 *
 * Owns everything outside the renderer: finding the release asset for this
 * platform, the opt-in download (sha256-verified against VSCodium's published
 * checksum, then unpacked into userData), and the server process itself —
 * 127.0.0.1 only, a random port, a connection token that is never logged,
 * never put in argv, and never put in a URL (it reaches the view as the
 * `vscode-tkn` cookie VS Code's server accepts), a scrubbed environment, and
 * restart-with-backoff if it dies.
 *
 * A factory rather than a module that requires electron, so the download and
 * lifecycle can be exercised from plain Node: main.js passes userData, the
 * environment builder and a logger.
 */

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { Readable } = require("stream");
const AdmZip = require("adm-zip");

const RELEASES_URL = "https://api.github.com/repos/VSCodium/vscodium/releases/latest";
const ASSET_PREFIX = "vscodium-reh-web";
const RESTART_WINDOW_MS = 60000;
const RESTART_LIMIT = 5;
const READY_TIMEOUT_MS = 30000;
const KILL_GRACE_MS = 3000;
const OPEN_VSX_API = "https://open-vsx.org/api";
// Codex's darwin-arm64 build alone is 236 MB.
const MAX_VSIX_BYTES = 600 * 1024 * 1024;
const CLI_TIMEOUT_MS = 10 * 60 * 1000;
// publisher.name as Open VSX spells them (namespaces keep their case: Google.geminicodeassist).
const EXTENSION_ID_RE = /^([a-z0-9][a-z0-9_-]*)\.([a-z0-9][a-z0-9_-]*)$/i;

/** VSCodium's name for this platform's build, or null if it has none. */
function platformTag(platform = process.platform, arch = process.arch) {
  const os = { darwin: "darwin", win32: "win32", linux: "linux" }[platform];
  const cpu = { arm64: "arm64", x64: "x64" }[arch];
  return os && cpu ? `${os}-${cpu}` : null;
}

/**
 * Loaded into the server with `node --require` (written to <root>/parent-watch.cjs
 * — .cjs because the engine's package.json says "type": "module"). The server
 * runs detached in its own process group so stop() can take its extension hosts
 * and terminals down with it; the flip side was that a crash or a force-quit
 * of BetterClaude left the whole group running with nobody to stop it. This
 * ends the group as soon as BetterClaude's main process is gone. The variable
 * is dropped at once so the extension hosts VS Code forks (which inherit
 * execArgv) load the file but find nothing to watch.
 */
const PARENT_WATCH = `"use strict";
const parent = Number(process.env.BC_PARENT_PID);
delete process.env.BC_PARENT_PID;
if (parent > 0) {
  const gone = () => {
    if (process.platform !== "win32" && process.ppid !== parent) return true;
    try { process.kill(parent, 0); return false; } catch (e) { return e.code !== "EPERM"; }
  };
  setInterval(() => {
    if (!gone()) return;
    try { if (process.platform !== "win32") process.kill(-process.pid, "SIGTERM"); } catch {}
    process.exit(0);
  }, 2000).unref();
}
`;

/** The token (or anything shaped like it) out of a line before it is logged. */
function scrub(line) {
  return String(line).replace(/(tkn=|connection-token[= ]|vscode-tkn=)[^\s&"']+/gi, "$1<redacted>");
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => hash.update(d)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * The package.json inside a .vsix (a zip). bsdtar — tar on macOS and Windows
 * 10+ — reads the one entry without loading the archive (Codex's is 236 MB);
 * adm-zip covers a GNU tar. null when it isn't an extension package.
 */
function readVsixManifest(file) {
  const parse = (text) => {
    try {
      const pkg = JSON.parse(text);
      return pkg && typeof pkg.publisher === "string" && typeof pkg.name === "string" ? pkg : null;
    } catch {
      return null;
    }
  };
  return new Promise((resolve) => {
    execFile("tar", ["-xOf", file, "extension/package.json"], { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (!err) { resolve(parse(String(stdout))); return; }
      try { resolve(parse(new AdmZip(file).readAsText("extension/package.json"))); } catch { resolve(null); }
    });
  });
}

function freePort(port = 0) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      const { port: bound } = srv.address();
      srv.close(() => resolve(bound));
    });
  });
}

/**
 * First-party extensions shipped as the engine's own built-ins (its
 * extensions/ folder, next to git and markdown): always on, not
 * uninstallable, never fetched from a gallery. Copied in before each start,
 * only when a file differs. Flat folders (package.json + extension.js).
 */
function syncBuiltinExtensions(engineDir, builtins) {
  for (const { name, dir } of builtins) {
    const dest = path.join(engineDir, "extensions", name);
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
    const current = files.every((f) => {
      try { return fs.readFileSync(path.join(dir, f)).equals(fs.readFileSync(path.join(dest, f))); } catch { return false; }
    });
    if (current) continue;
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    // read + write rather than copyFile: the source may sit inside app.asar.
    files.forEach((f) => fs.writeFileSync(path.join(dest, f), fs.readFileSync(path.join(dir, f))));
  }
}

function createWorkbench({ userDataDir, buildEnv = () => ({ ...process.env }), log = () => {}, fetchImpl = fetch, builtinExtensions = [] } = {}) {
  const root = path.join(userDataDir, "workbench");
  const paths = {
    root,
    engines: path.join(root, "engine"),
    manifest: path.join(root, "engine.json"),
    token: path.join(root, "connection-token"),
    port: path.join(root, "port"),
    serverData: path.join(root, "server-data"),
    userData: path.join(root, "user-data"),
    extensions: path.join(root, "extensions"),
  };

  let install = null; // in-flight install Promise
  let server = null; // { child, port, ready, startedAt }
  let starting = null;
  let stopping = false;
  let restarts = [];
  const listeners = new Set();
  const emit = (event) => listeners.forEach((fn) => { try { fn(event); } catch {} });

  function readManifest() {
    try {
      const m = JSON.parse(fs.readFileSync(paths.manifest, "utf8"));
      return m && m.version && fs.existsSync(m.dir) ? m : null;
    } catch {
      return null;
    }
  }

  function status() {
    const m = readManifest();
    return {
      supported: !!platformTag(),
      installed: !!m,
      version: m ? m.version : null,
      installing: !!install,
      running: !!(server && server.ready),
      extensionsDir: paths.extensions,
    };
  }

  /** The latest release's asset for this platform: {version, name, size, url, sha256Url}. */
  async function latestAsset() {
    const tag = platformTag();
    if (!tag) throw new Error(`No VSCodium server build for ${process.platform}-${process.arch}.`);
    const res = await fetchImpl(RELEASES_URL, { headers: { accept: "application/vnd.github+json", "user-agent": "BetterClaude" } });
    if (!res.ok) throw new Error(`Could not reach GitHub releases (HTTP ${res.status}).`);
    const rel = await res.json();
    const name = `${ASSET_PREFIX}-${tag}-${rel.tag_name}.tar.gz`;
    const asset = (rel.assets || []).find((a) => a.name === name);
    const sum = (rel.assets || []).find((a) => a.name === `${name}.sha256`);
    if (!asset || !sum) throw new Error(`Release ${rel.tag_name} has no ${name} (or its .sha256).`);
    return { version: rel.tag_name, name, size: asset.size, url: asset.browser_download_url, sha256Url: sum.browser_download_url, source: "github.com/VSCodium/vscodium/releases" };
  }

  /** A published .sha256 file's digest (the first word: some list a file name after it). */
  async function fetchSha256(url) {
    const res = await fetchImpl(url, { headers: { "user-agent": "BetterClaude" } });
    if (!res.ok) throw new Error(`Could not fetch the checksum (HTTP ${res.status}).`);
    const digest = String(await res.text()).trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("The published checksum is not a sha256.");
    return digest;
  }

  /**
   * Stream `url` into `file`, hashing on the way: {sha256, received, total}.
   * `limit` refuses anything larger, declared or actual.
   * onProgress({phase: "download", received, total}).
   */
  async function downloadHashed(url, file, { onProgress = () => {}, sizeHint = 0, limit = Infinity } = {}) {
    const res = await fetchImpl(url, { headers: { "user-agent": "BetterClaude" } });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
    const total = Number(res.headers.get("content-length")) || sizeHint || 0;
    const tooBig = () => new Error(`That download is over the ${Math.round(limit / 1e6)} MB BetterClaude allows.`);
    if (total > limit) throw tooBig();
    const hash = crypto.createHash("sha256");
    let received = 0;
    let lastEmit = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      const body = Readable.fromWeb(res.body);
      const fail = (err) => { out.destroy(); reject(err); };
      body.on("data", (chunk) => {
        received += chunk.length;
        if (received > limit) { body.destroy(tooBig()); return; }
        hash.update(chunk);
        const now = Date.now();
        if (now - lastEmit > 250) { lastEmit = now; onProgress({ phase: "download", received, total }); }
      });
      body.on("error", fail);
      out.on("error", fail);
      out.on("finish", resolve);
      body.pipe(out);
    });
    return { sha256: hash.digest("hex"), received, total };
  }

  /**
   * Download, verify and unpack `asset` (from latestAsset — the caller shows
   * its size and source and only calls this after the user agreed).
   * onProgress({phase, received, total}).
   */
  function installEngine(asset, onProgress = () => {}) {
    if (install) return install;
    install = (async () => {
      fs.mkdirSync(paths.engines, { recursive: true });
      const tarball = path.join(paths.root, `${asset.name}.downloading`);
      const staging = path.join(paths.engines, `.staging-${Date.now()}`);
      try {
        const expected = await fetchSha256(asset.sha256Url);
        const { sha256: actual, received, total } = await downloadHashed(asset.url, tarball, { onProgress, sizeHint: asset.size });
        onProgress({ phase: "verify", received, total });
        if (actual !== expected) throw new Error("The download's checksum does not match VSCodium's published sha256 — discarded.");

        onProgress({ phase: "unpack", received, total });
        fs.mkdirSync(staging, { recursive: true });
        await new Promise((resolve, reject) => {
          execFile("tar", ["-xzf", tarball, "-C", staging], { maxBuffer: 16 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
        });
        // Either the files sit at the archive root or under one folder.
        const top = fs.readdirSync(staging).filter((n) => !n.startsWith("."));
        const content = top.length === 1 && fs.statSync(path.join(staging, top[0])).isDirectory() ? path.join(staging, top[0]) : staging;
        const dir = path.join(paths.engines, asset.version);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(content, dir);
        const manifest = { version: asset.version, asset: asset.name, sha256: expected, dir, installedAt: new Date().toISOString() };
        fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2));
        onProgress({ phase: "done", received, total });
        return manifest;
      } finally {
        fs.rmSync(tarball, { force: true });
        fs.rmSync(staging, { recursive: true, force: true });
      }
    })().finally(() => { install = null; });
    return install;
  }

  /** The engine's launcher script (bin/<serverApplicationName>[.cmd]). */
  function serverBinary(dir) {
    const bin = path.join(dir, "bin");
    const names = fs.existsSync(bin) ? fs.readdirSync(bin) : [];
    const pick = names.find((n) => (process.platform === "win32" ? /server\.cmd$/i.test(n) : /server$/.test(n)));
    if (!pick) throw new Error("The installed engine has no server launcher in bin/.");
    return path.join(bin, pick);
  }

  /**
   * How to run the engine: its bundled node on out/server-main.js — all the
   * bin/ launcher does — so node itself leads the process group and can load
   * the parent watch. The launcher is the fallback for an unexpected layout.
   */
  function engineCommand(dir, nodeArgs = []) {
    const node = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
    const main = path.join(dir, "out", "server-main.js");
    if (fs.existsSync(node) && fs.existsSync(main)) return { command: node, args: [...nodeArgs, main] };
    return { command: serverBinary(dir), args: [] };
  }

  /**
   * An update leaves the previous build in engine/; keep only the installed
   * one. Compared as canonical paths: the userData folder's spelling can
   * differ in case from what's on disk, and a plain string compare would
   * throw away the engine in use.
   */
  function pruneEngines(keepDir) {
    let root;
    let keep;
    try {
      root = fs.realpathSync.native(paths.engines);
      keep = fs.realpathSync.native(keepDir);
    } catch {
      return;
    }
    if (path.dirname(keep) !== root) return;
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (name.startsWith(".") || dir === keep) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  function writeParentWatch() {
    const file = path.join(paths.root, "parent-watch.cjs");
    let current = null;
    try { current = fs.readFileSync(file, "utf8"); } catch {}
    if (current !== PARENT_WATCH) fs.writeFileSync(file, PARENT_WATCH);
    return file;
  }

  function ensureToken() {
    fs.mkdirSync(paths.root, { recursive: true });
    let token = "";
    try { token = fs.readFileSync(paths.token, "utf8").trim(); } catch {}
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
      token = crypto.randomBytes(32).toString("base64url");
      fs.writeFileSync(paths.token, token, { mode: 0o600 });
    }
    try { fs.chmodSync(paths.token, 0o600); } catch {}
    return token;
  }

  /**
   * The port this profile's server listens on: random, picked once, then
   * reused. VS Code keys its per-remote state by host:port — workspace trust,
   * open editors, recent folders — so a new port on every start made each
   * restart forget all of it. Taken by something else now: a new random one,
   * kept in turn.
   */
  async function stablePort() {
    let saved = 0;
    try { saved = Number(fs.readFileSync(paths.port, "utf8").trim()); } catch {}
    if (Number.isInteger(saved) && saved >= 1024 && saved <= 65535) {
      try { return await freePort(saved); } catch { /* in use: pick another */ }
    }
    const port = await freePort();
    try { fs.writeFileSync(paths.port, String(port)); } catch {}
    return port;
  }

  async function start() {
    if (server && server.ready) return { port: server.port };
    if (starting) return starting;
    const manifest = readManifest();
    if (!manifest) throw new Error("The full IDE engine is not installed.");
    stopping = false;
    starting = (async () => {
      const token = ensureToken();
      const port = await stablePort();
      [paths.serverData, paths.userData, paths.extensions].forEach((d) => fs.mkdirSync(d, { recursive: true }));
      if (!install) pruneEngines(manifest.dir);
      syncBuiltinExtensions(manifest.dir, builtinExtensions);
      const args = [
        "--host", "127.0.0.1",
        "--port", String(port),
        "--connection-token-file", paths.token,
        "--server-data-dir", paths.serverData,
        "--user-data-dir", paths.userData,
        "--extensions-dir", paths.extensions,
        "--telemetry-level", "off",
        "--accept-server-license-terms",
      ];
      const engine = engineCommand(manifest.dir, ["--require", writeParentWatch()]);
      const child = spawn(engine.command, [...engine.args, ...args], {
        cwd: manifest.dir,
        env: { ...buildEnv({ port }), BC_PARENT_PID: String(process.pid) },
        detached: process.platform !== "win32", // its own process group, killed as one
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const entry = { child, port, ready: false, startedAt: Date.now() };
      server = entry;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The IDE engine did not start in time.")), READY_TIMEOUT_MS);
        const onLine = (chunk) => {
          String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => {
            log(`[workbench] ${scrub(line)}`);
            if (!entry.ready && /listening on|Web UI available/i.test(line)) {
              entry.ready = true;
              clearTimeout(timer);
              resolve();
            }
          });
        };
        child.stdout.on("data", onLine);
        child.stderr.on("data", onLine);
        child.on("error", (err) => { clearTimeout(timer); reject(err); });
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          const wasReady = entry.ready;
          if (server === entry) server = null;
          if (!wasReady) reject(new Error(`The IDE engine exited during startup (${signal || code}).`));
          // Per server: a stop() followed by a fresh start() resets `stopping`
          // before the old one has exited, and its exit is not a crash.
          if (stopping || entry.stopped) return;
          emit({ type: "exited", code, signal });
          // Crash: restart with backoff, a bounded number of times per minute.
          const now = Date.now();
          restarts = restarts.filter((t) => now - t < RESTART_WINDOW_MS);
          if (wasReady && restarts.length < RESTART_LIMIT) {
            const delay = 1000 * 2 ** restarts.length;
            restarts.push(now);
            setTimeout(() => { if (!stopping) start().then((s) => emit({ type: "restarted", port: s.port })).catch((e) => emit({ type: "failed", message: e.message })); }, delay);
          } else if (wasReady) {
            emit({ type: "failed", message: "The IDE engine keeps crashing — stopped restarting it." });
          }
        });
      });
      emit({ type: "ready", port });
      return { port };
    })().catch((err) => {
      stop();
      // Taken between stablePort()'s check and the bind, or otherwise
      // unusable: the next start picks a fresh port.
      fs.rmSync(paths.port, { force: true });
      throw err;
    }).finally(() => { starting = null; });
    return starting;
  }

  function stop() {
    stopping = true;
    const entry = server;
    server = null;
    if (entry) entry.stopped = true;
    if (!entry || entry.child.exitCode !== null) return;
    const { child } = entry;
    const kill = (sig) => {
      try {
        if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
        else process.kill(-child.pid, sig); // the whole group: server + extension hosts
      } catch {}
    };
    kill("SIGTERM");
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) kill("SIGKILL"); }, KILL_GRACE_MS).unref();
  }

  /**
   * The engine's own copy of the extension-webview host pages. VS Code web
   * loads every webview from https://<uuid>.vscode-cdn.net (its product
   * config inlines that Microsoft CDN, even pointing at another build); the
   * view's session serves those requests from here instead — offline, and the
   * same build as the workbench.
   */
  function webviewPreDir() {
    const m = readManifest();
    return m ? path.join(m.dir, "out", "vs", "workbench", "contrib", "webview", "browser", "pre") : null;
  }

  /** Origin + token for the view (the token goes into a cookie, never a URL). */
  function connection() {
    if (!server || !server.ready) return null;
    return { origin: `http://127.0.0.1:${server.port}`, token: ensureToken() };
  }

  // -------------------------------------------------------------------------
  // Extensions. The workbench's own Extensions view installs through VS
  // Code's installer; these are the installs BetterClaude performs itself (an
  // import from another editor, a .vsix the user picks), through the engine's
  // own CLI so the result is exactly what that view would have produced.
  // -------------------------------------------------------------------------
  let cliQueue = Promise.resolve();

  /**
   * The engine's CLI — what `bin/codium-server --install-extension …` runs —
   * on this workbench's folders. One call at a time: two installs writing
   * the same extensions.json together could drop one. Output is scrubbed.
   */
  function runCli(args, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
    const run = () => new Promise((resolve, reject) => {
      const manifest = readManifest();
      if (!manifest) { reject(new Error("The full IDE engine is not installed.")); return; }
      [paths.serverData, paths.userData, paths.extensions].forEach((d) => fs.mkdirSync(d, { recursive: true }));
      const engine = engineCommand(manifest.dir);
      const argv = [...engine.args, "--extensions-dir", paths.extensions, "--server-data-dir", paths.serverData, "--user-data-dir", paths.userData, ...args];
      execFile(engine.command, argv, { cwd: manifest.dir, env: buildEnv({}), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const out = scrub(stdout || "").trim();
        const errText = scrub(stderr || "").trim();
        if (!err) { resolve({ stdout: out, stderr: errText }); return; }
        const lines = `${errText}\n${out}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        reject(new Error(lines.slice(-2).join(" ") || err.message));
      });
    });
    const result = cliQueue.then(run, run);
    cliQueue = result.catch(() => {});
    return result;
  }

  /** What the IDE has installed, [{id, version}] (built-ins aside). */
  async function listExtensions() {
    const { stdout } = await runCli(["--list-extensions", "--show-versions"], { timeoutMs: 60000 });
    return stdout.split(/\r?\n/)
      .map((line) => /^([\w-]+\.[\w-]+)@(\S+)$/.exec(line.trim()))
      .filter(Boolean)
      .map((m) => ({ id: m[1].toLowerCase(), version: m[2] }));
  }

  /**
   * The newest Open VSX build of namespace.name for this platform, else its
   * universal one; null if neither exists. Never the bare /latest: for a
   * platform-specific extension that answers with any platform's build
   * (Codex: alpine-arm64), and a stale universal one can sit beside current
   * platform builds (Claude Code: 2.1.89 universal, 2.1.283 darwin-arm64).
   */
  async function openVsxLatest(namespace, name) {
    const base = `${OPEN_VSX_API}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
    for (const target of [platformTag(), "universal"].filter(Boolean)) {
      const res = await fetchImpl(`${base}/${target}/latest`, { headers: { accept: "application/json", "user-agent": "BetterClaude" } });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`Open VSX answered HTTP ${res.status}.`);
      const meta = await res.json();
      if (meta && !meta.error && meta.files && typeof meta.files.download === "string") return meta;
    }
    return null;
  }

  /**
   * Install publisher.name from Open VSX: the build openVsxLatest picks,
   * checked against the sha256 Open VSX publishes beside it, then handed to
   * the engine's CLI. Resolves with the publisher and its verified state for
   * the caller to show, or {ok:false, notFound:true} when Open VSX has no
   * build for this platform. onProgress({phase: "download"|"install", …}).
   */
  async function installFromOpenVsx(id, onProgress = () => {}) {
    const m = EXTENSION_ID_RE.exec(String(id || "").trim());
    if (!m) throw new Error("Extension ids look like publisher.name.");
    const wanted = `${m[1]}.${m[2]}`.toLowerCase();
    const meta = await openVsxLatest(m[1], m[2]);
    if (!meta) return { ok: false, id: wanted, notFound: true };
    const got = `${meta.namespace}.${meta.name}`.toLowerCase();
    if (got !== wanted) throw new Error(`Open VSX answered with ${got} for ${wanted}.`);
    if (typeof meta.files.sha256 !== "string") throw new Error("Open VSX publishes no sha256 for this build, so it can't be verified.");
    const expected = await fetchSha256(meta.files.sha256);
    const downloads = path.join(paths.root, "downloads");
    fs.mkdirSync(downloads, { recursive: true });
    const file = path.join(downloads, `${crypto.randomBytes(8).toString("hex")}.vsix`);
    try {
      const { sha256 } = await downloadHashed(meta.files.download, file, { onProgress, limit: MAX_VSIX_BYTES });
      if (sha256 !== expected) throw new Error("The download does not match Open VSX's published sha256 — discarded.");
      onProgress({ phase: "install" });
      await runCli(["--install-extension", file, "--force"]);
    } finally {
      fs.rmSync(file, { force: true });
    }
    return {
      ok: true,
      id: got,
      displayName: meta.displayName || meta.name,
      version: meta.version,
      target: meta.targetPlatform,
      publisher: (meta.publishedBy && meta.publishedBy.loginName) || meta.namespace,
      verified: meta.verified === true,
      preRelease: meta.preRelease === true,
      sha256: expected,
    };
  }

  /** Install a .vsix the user chose; what it is comes from its own package.json. */
  async function installVsix(file, onProgress = () => {}) {
    if (typeof file !== "string" || !path.isAbsolute(file) || !/\.vsix$/i.test(file)) throw new Error("Choose a .vsix file.");
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("Choose a .vsix file.");
    if (stat.size > MAX_VSIX_BYTES) throw new Error(`That package is over the ${Math.round(MAX_VSIX_BYTES / 1e6)} MB BetterClaude allows.`);
    const pkg = await readVsixManifest(file);
    if (!pkg) throw new Error("That file isn't a VS Code extension package.");
    const sha256 = await sha256File(file);
    onProgress({ phase: "install" });
    await runCli(["--install-extension", file, "--force"]);
    return { ok: true, id: `${pkg.publisher}.${pkg.name}`.toLowerCase(), displayName: pkg.displayName || pkg.name, version: pkg.version || null, sha256 };
  }

  /** Each installed extension's manifest basics, from the engine's own extensions.json. */
  function installedManifests() {
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(path.join(paths.extensions, "extensions.json"), "utf8")); } catch {}
    return (Array.isArray(entries) ? entries : []).map((entry) => {
      const rel = entry && typeof entry.relativeLocation === "string" ? entry.relativeLocation : null;
      if (!rel || rel.includes("..") || path.isAbsolute(rel)) return null;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(paths.extensions, rel, "package.json"), "utf8"));
        return { id: `${pkg.publisher}.${pkg.name}`.toLowerCase(), displayName: pkg.displayName || pkg.name, version: pkg.version, engine: (pkg.engines && pkg.engines.vscode) || "*" };
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  /**
   * The newest engine release against the installed one, and which installed
   * extensions its VS Code version would not satisfy (engines.vscode) — so
   * an update never quietly disables one.
   */
  async function checkEngineUpdate() {
    const asset = await latestAsset();
    const current = readManifest();
    const newer = !current || compareVersions(asset.version, current.version) > 0;
    const breaks = installedManifests().filter((ext) => engineSatisfies(ext.engine, asset.version) === false);
    return { current: current ? current.version : null, latest: asset.version, name: asset.name, size: asset.size, source: asset.source, newer, breaks };
  }

  /** Remove the engine (not the extensions or settings, which the next install reuses). */
  async function uninstallEngine() {
    if (install) throw new Error("The engine is still installing.");
    stop();
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(paths.manifest, { force: true });
    fs.rmSync(paths.engines, { recursive: true, force: true });
    return status();
  }

  return {
    paths,
    status,
    latestAsset,
    installEngine,
    uninstallEngine,
    checkEngineUpdate,
    start,
    stop,
    connection,
    webviewPreDir,
    runCli,
    listExtensions,
    installFromOpenVsx,
    installVsix,
    installedManifests,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/** Numeric dotted-version order ("1.135.06055" < "1.136.00012"). */
function compareVersions(a, b) {
  const pa = String(a || "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/**
 * Whether an engines.vscode range admits `version`, read the way VS Code's
 * extension validator reads it: *, ^x.y.z, >=x.y.z, an exact x.y.z, and x
 * wildcards. null for any other form (unknown, so no warning).
 */
function engineSatisfies(range, version) {
  const r = String(range || "*").trim();
  if (r === "*" || r === "") return true;
  const m = /^(\^|>=)?\s*(\d+|x)\.(\d+|x)\.(\d+|x)(?:-.*)?$/i.exec(r);
  if (!m) return null;
  const have = String(version).split(".").map((n) => parseInt(n, 10) || 0);
  const want = [m[2], m[3], m[4]].map((p) => (/x/i.test(p) ? null : parseInt(p, 10)));
  const caret = m[1] === "^";
  const cmp = () => {
    for (let i = 0; i < 3; i += 1) {
      const w = want[i] === null ? 0 : want[i];
      if ((have[i] || 0) !== w) return (have[i] || 0) - w;
    }
    return 0;
  };
  if (m[1] === ">=") return cmp() >= 0;
  // VS Code: anything below 1.0.0 that isn't an exact pin runs on 1.x.
  if (have[0] === 1 && want[0] === 0 && (caret || want.includes(null))) return true;
  if (caret) return want[0] === 0 ? have[0] === 0 && have[1] === want[1] && cmp() >= 0 : have[0] === want[0] && cmp() >= 0;
  return want.every((w, i) => w === null || (have[i] || 0) === w);
}

module.exports = { createWorkbench, platformTag, scrub, engineSatisfies, compareVersions };
