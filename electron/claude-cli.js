/**
 * Locating and running the user's own `claude` CLI, for the embedded Code
 * window (electron/code-window.js).
 *
 * This is a deliberate CommonJS port of BETTERCLAUDE OFFICIAL's
 * src/pty/locateClaude.ts + src/pty/ClaudeSession.ts rather than an import
 * across the two folder trees: OFFICIAL is an ESM/TypeScript npm package with
 * its own build and its own node_modules, and the no-cross-folder-contamination
 * rule means neither track may reach into the other at runtime. The logic below
 * is behaviourally the same; keep the two in sync by hand if either changes.
 *
 * Compliance posture (identical to OFFICIAL's, and non-negotiable here):
 *   - This module looks for an *executable file* and nothing else. It never
 *     reads Claude Code's config directory, credential store, keychain entries
 *     or any auth state. The only relationship with Claude Code is "spawn the
 *     binary the user already installed and logged into".
 *   - The child's environment is inherited essentially untouched, so whatever
 *     already configures the user's `claude` reaches it unchanged — because we
 *     neither read nor rewrite it.
 *   - Bytes in, bytes out. Nothing flowing through the pty is parsed,
 *     inspected, logged or transmitted, and nothing is ever written into the
 *     child's stdin except the user's own keystrokes forwarded verbatim.
 */

const { accessSync, constants, statSync } = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { execFile } = require("child_process");

const IS_WINDOWS = process.platform === "win32";

const DOCS_URL = "https://docs.claude.com/en/docs/claude-code/overview";

class ClaudeNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaudeNotFoundError";
  }
}

class PtySpawnError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "PtySpawnError";
    this.detail = detail;
  }
}

function isExecutableFile(candidate) {
  try {
    // statSync follows symlinks, which matters: `claude` is commonly a symlink
    // into a version-managed install directory.
    if (!statSync(candidate).isFile()) return false;
    if (IS_WINDOWS) return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories checked after PATH. A GUI-launched app inherits a stripped PATH
 * (macOS hands a .app the bare `/usr/bin:/bin:/usr/sbin:/sbin` unless it was
 * started from a shell), which omits every usual user-level install location —
 * failing there with "not installed" would be actively misleading, and this
 * app is far more likely to be launched from the Dock than from a terminal.
 */
function fallbackDirs() {
  const home = os.homedir();
  if (IS_WINDOWS) {
    return [
      path.join(home, "AppData", "Local", "Programs"),
      path.join(home, "AppData", "Roaming", "npm"),
    ];
  }
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".asdf", "shims"),
    ...nvmBinDirs(home),
    "/usr/bin",
  ];
}

/** Every installed nvm Node's bin dir, newest-looking first. */
function nvmBinDirs(home) {
  const root = path.join(home, ".nvm", "versions", "node");
  try {
    return require("fs").readdirSync(root).sort().reverse().map((v) => path.join(root, v, "bin"));
  } catch {
    return [];
  }
}

// --- Login-shell PATH ---------------------------------------------------------
// A Dock-launched macOS app inherits launchd's bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin). Claude Code itself runs from there, but
// everything IT spawns — the Bash tool's `npm test`, project hooks, `gh`,
// `node` for an npm-installed claude — would not be found. So the user's real
// login-shell PATH is read once, the way a terminal would see it, and merged in.
const PATH_SENTINEL = "__BC_LOGIN_PATH__";
let loginPathPromise = null;

/**
 * Resolves the user's login-shell PATH (cached). Never rejects: any failure —
 * no $SHELL, a hung rc file, Windows — resolves to null and callers keep the
 * inherited PATH. Interactive rc files can print banners or prompt, so the
 * value is fenced by sentinels and stdin is closed.
 */
function resolveLoginPath({ timeoutMs = 4000 } = {}) {
  if (loginPathPromise) return loginPathPromise;
  loginPathPromise = new Promise((resolve) => {
    if (IS_WINDOWS) { resolve(null); return; }
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    let child;
    try {
      // `${PATH}` braced: bare `$PATH__BC…` would parse as one longer (unset)
      // variable name, since underscores are identifier characters.
      const script = "printf '%s' \"" + PATH_SENTINEL + "${PATH}" + PATH_SENTINEL + "\"";
      child = execFile(shell, ["-ilc", script], {
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: { ...process.env, TERM: "dumb" },
      }, (_error, stdout) => {
        const text = String(stdout || "");
        const start = text.indexOf(PATH_SENTINEL);
        const end = text.lastIndexOf(PATH_SENTINEL);
        if (start === -1 || end <= start) { resolve(null); return; }
        const value = text.slice(start + PATH_SENTINEL.length, end).trim();
        resolve(value || null);
      });
      if (child.stdin) child.stdin.end();
    } catch {
      resolve(null);
    }
  });
  return loginPathPromise;
}

function mergePathLists(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const dir of String(list || "").split(path.delimiter)) {
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(path.delimiter);
}

/**
 * Merges the login-shell PATH into this process's own PATH (login entries
 * first), so every later spawn — Claude Code, git, gh, the IDE shell — sees
 * what the user's terminal sees. Safe to call more than once.
 */
async function applyLoginShellPath() {
  const loginPath = await resolveLoginPath();
  if (loginPath) process.env.PATH = mergePathLists(loginPath, process.env.PATH);
  return process.env.PATH;
}

// --- Subscription environment -------------------------------------------------
// Variables that must never reach a Claude Code child the Code tab spawns:
//   - ANTHROPIC_API_KEY / _AUTH_TOKEN / _BASE_URL and the CLAUDE_CODE_USE_*
//     provider switches take precedence over the user's claude.ai login, which
//     would silently bill an API key instead of their subscription;
//   - ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL / _SMALL_FAST_MODEL rewrite
//     what the picker's opus/sonnet/haiku aliases resolve to;
//   - CLAUDECODE, CLAUDE_CODE_SESSION_ID, _ENTRYPOINT, _MESSAGING_*, host auth
//     refresh flags, CLAUDE_EFFORT … are set when BetterClaude itself is
//     launched from inside a Claude Code / Claude desktop session, and make the
//     child think it is a nested or SDK-hosted session.
// Rather than chase an ever-growing list, every ANTHROPIC_* and CLAUDE* name
// is dropped except the few that are the user's own configuration.
const KEEP_CLAUDE_ENV = new Set([
  "CLAUDE_CONFIG_DIR", // where the user's login + settings live
  "CLAUDE_CODE_OAUTH_TOKEN", // a subscription token from `claude setup-token`
  "CLAUDE_CODE_GIT_BASH_PATH", // Windows: which bash the Bash tool uses
]);

/**
 * The environment for a Claude Code child that must run on the user's own
 * subscription login. `binaryPath`'s directory is put on PATH so an
 * npm-installed `claude` (a `#!/usr/bin/env node` script) finds its node.
 */
function subscriptionEnv({ binaryPath = null, extra = null } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (/^(ANTHROPIC_|CLAUDE)/.test(key) && !KEEP_CLAUDE_ENV.has(key)) continue;
    env[key] = value;
  }
  const binDir = binaryPath ? path.dirname(binaryPath) : "";
  env.PATH = mergePathLists(binDir, env.PATH || "");
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  return env;
}

function executableNames() {
  if (!IS_WINDOWS) return ["claude"];
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return exts.map((ext) => `claude${ext.toLowerCase()}`);
}

function searchDirs(dirs, names) {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolves the absolute path to the `claude` executable the same way a shell
 * would — PATH first, in order — then the fallback directories above.
 *
 * @param {string} [explicit] User-supplied override, trusted over any search
 *   result so version-managed installs can be pinned.
 * @throws {ClaudeNotFoundError} when no executable can be found.
 */
function locateClaude(explicit) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (isExecutableFile(resolved)) return resolved;
    throw new ClaudeNotFoundError(
      `No executable found at the configured Claude Code path:\n  ${resolved}`
    );
  }

  const names = executableNames();

  const fromPath = searchDirs((process.env.PATH || "").split(path.delimiter), names);
  if (fromPath) return fromPath;

  const fromFallback = searchDirs(fallbackDirs(), names);
  if (fromFallback) return fromFallback;

  throw new ClaudeNotFoundError(
    [
      "Could not find the `claude` command on your PATH.",
      "",
      "BetterClaude is a UI wrapper — it does not include, install, or",
      "authenticate Claude Code. You need the real CLI installed and logged",
      "in first:",
      "",
      `  ${DOCS_URL}`,
      "",
      "Once `claude` runs on its own in your terminal, open this window again.",
    ].join("\n")
  );
}

/**
 * Copies the current environment for the child.
 *
 * Passed through essentially untouched, deliberately (see the compliance note
 * at the top of this file). The single override is TERM, which must agree with
 * the emulator we render into.
 */
/** Just TERM plus the caller's extras — what childEnv() lays over process.env. */
function childEnvOverrides(extra) {
  const env = { TERM: "xterm-256color" };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof key === "string" && typeof value === "string") env[key] = value;
    }
  }
  return env;
}

function childEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
  // Team sessions carry BC_TEAM_* variables pointing at their shared hub so
  // scripts/hooks inside the agent can find it without parsing the prompt.
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof key === "string" && typeof value === "string") env[key] = value;
    }
  }
  return env;
}

/**
 * One wrapped `claude` subprocess, attached to a real pseudo-terminal.
 *
 * A PTY (rather than piped stdio) is what makes the child behave exactly as if
 * the user had typed `claude` themselves: it sees a TTY, so it keeps colours,
 * cursor control, and its own interactive rendering. This class owns process
 * lifecycle only.
 *
 * Emits: "data" (string chunk), "exit" ({ exitCode, signal }).
 */
class ClaudeSession extends EventEmitter {
  constructor({ binaryPath, args = [], cwd, cols, rows, env, baseEnv = null }) {
    super();
    this.cwd = cwd || process.cwd();
    this.startedAt = new Date();
    this.proc = null;
    this.running = false;

    // Required lazily rather than at module load: node-pty is a native addon,
    // and a missing/unloadable binary must surface as this window's own
    // "couldn't start" screen, not as a main-process crash at import time that
    // takes the whole app down before any window exists.
    let ptySpawn;
    try {
      ptySpawn = require("node-pty").spawn;
    } catch (error) {
      throw new PtySpawnError(
        "BetterClaude's terminal backend (node-pty) could not be loaded.",
        error instanceof Error ? error.message : String(error)
      );
    }

    try {
      this.proc = ptySpawn(binaryPath, args, {
        name: "xterm-256color",
        cols: Math.max(1, cols),
        rows: Math.max(1, rows),
        cwd: this.cwd,
        // `baseEnv`: a caller-prepared environment (e.g. subscriptionEnv())
        // used as-is instead of this process's own, with TERM still forced.
        env: baseEnv ? { ...baseEnv, ...childEnvOverrides(env) } : childEnv(env),
      });
    } catch (error) {
      throw new PtySpawnError(
        `Failed to start ${binaryPath} in a pseudo-terminal.`,
        error instanceof Error ? error.message : String(error)
      );
    }

    this.running = true;

    this.proc.onData((chunk) => this.emit("data", chunk));

    this.proc.onExit(({ exitCode, signal }) => {
      this.running = false;
      this.proc = null;
      this.emit("exit", { exitCode, signal });
    });
  }

  get isRunning() {
    return this.running;
  }

  get pid() {
    return this.proc ? this.proc.pid : undefined;
  }

  /** Forwards the user's own keystrokes to the child verbatim. */
  write(data) {
    if (!this.running || !this.proc) return;
    try {
      this.proc.write(data);
    } catch {
      // The child can exit between our liveness check and the write; that
      // races harmlessly, and the "exit" event is what drives teardown.
    }
  }

  /** Tells the child its window changed size, so it can reflow and redraw. */
  resize(cols, rows) {
    if (!this.running || !this.proc) return;
    try {
      this.proc.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      // Same race as write(): resizing a dead PTY throws and doesn't matter.
    }
  }

  /** Signals the child. Default SIGHUP mirrors closing a terminal window. */
  kill(signal) {
    if (!this.proc) return;
    try {
      this.proc.kill(signal);
    } catch {
      // Already gone.
    }
  }

  /** Kills the child and detaches all listeners. Safe to call more than once. */
  dispose() {
    this.kill();
    this.running = false;
    this.removeAllListeners();
  }
}

/**
 * Lists the user's active Claude Code sessions — both interactive (running in
 * a real terminal somewhere on this machine) and background/cloud (dispatched
 * with `--bg`/`--cloud`) — via `claude agents --json --all`.
 *
 * One-shot and non-interactive, unlike everything else in this file: this is
 * metadata about what sessions exist, not a pty to attach to, so a plain
 * child process is the right tool rather than node-pty.
 *
 * Compliance posture unchanged from the rest of this file: this asks the
 * already-authenticated `claude` binary for its own session list, the same
 * way `--resume`'s interactive picker or `claude doctor` would. Nothing here
 * reads Claude Code's config, credentials, or keychain directly, and a
 * failure (binary missing, malformed output, timeout) resolves to an empty
 * list rather than throwing — this is supplementary data for a picker, never
 * something the primary spawn path depends on.
 */
function listAgentSessions(binaryPath) {
  return new Promise((resolve) => {
    execFile(binaryPath, ["agents", "--json", "--all"], { timeout: 8000 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
  });
}

module.exports = {
  ClaudeNotFoundError,
  ClaudeSession,
  DOCS_URL,
  PtySpawnError,
  applyLoginShellPath,
  listAgentSessions,
  locateClaude,
  resolveLoginPath,
  subscriptionEnv,
};
