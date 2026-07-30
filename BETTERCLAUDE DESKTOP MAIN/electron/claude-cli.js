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
    path.join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
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
function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
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
  constructor({ binaryPath, args = [], cwd, cols, rows }) {
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
        env: childEnv(),
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

module.exports = {
  ClaudeNotFoundError,
  ClaudeSession,
  DOCS_URL,
  PtySpawnError,
  locateClaude,
};
