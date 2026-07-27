/**
 * One wrapped `claude` subprocess, attached to a real pseudo-terminal.
 *
 * A PTY (rather than piped stdio) is what makes the child behave exactly as if
 * the user had typed `claude` themselves: it sees a TTY, so it keeps colours,
 * cursor control, and its own interactive rendering.
 *
 * This class owns process lifecycle only. It does not inspect, parse, log, or
 * transmit anything flowing through it — bytes in, bytes out.
 */

import { EventEmitter } from 'node:events';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import type { ExitInfo } from '../types.js';

export interface ClaudeSessionOptions {
  /** Absolute path to the user's `claude` executable. */
  binaryPath: string;
  /** Arguments forwarded verbatim to `claude`. */
  args?: string[];
  /** Working directory for the child. Defaults to the app's cwd. */
  cwd?: string;
  cols: number;
  rows: number;
}

interface ClaudeSessionEvents {
  data: (chunk: string) => void;
  exit: (info: ExitInfo) => void;
}

export class PtySpawnError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = 'PtySpawnError';
    this.detail = detail;
  }
}

/**
 * Copies the current environment for the child.
 *
 * The environment is passed through essentially untouched — that is deliberate.
 * Whatever configures the user's normal `claude` (including anything auth-related
 * this app has no business knowing about) reaches the child unchanged, because we
 * neither read nor rewrite it. The single override is TERM, which must agree with
 * the emulator we render into.
 */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env['TERM'] = 'xterm-256color';
  return env;
}

export class ClaudeSession extends EventEmitter {
  private proc: IPty | null = null;
  private running = false;

  readonly cwd: string;
  readonly startedAt: Date;

  constructor(options: ClaudeSessionOptions) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.startedAt = new Date();

    try {
      this.proc = ptySpawn(options.binaryPath, options.args ?? [], {
        name: 'xterm-256color',
        cols: Math.max(1, options.cols),
        rows: Math.max(1, options.rows),
        cwd: this.cwd,
        env: childEnv(),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PtySpawnError(
        `Failed to start ${options.binaryPath} in a pseudo-terminal.`,
        detail,
      );
    }

    this.running = true;

    this.proc.onData((chunk) => {
      this.emit('data', chunk);
    });

    this.proc.onExit(({ exitCode, signal }) => {
      this.running = false;
      this.proc = null;
      this.emit('exit', { exitCode, signal });
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Forwards user keystrokes to the child verbatim. */
  write(data: string): void {
    if (!this.running || !this.proc) return;
    try {
      this.proc.write(data);
    } catch {
      // The child can exit between our liveness check and the write; that races
      // harmlessly, and the 'exit' event is what actually drives teardown.
    }
  }

  /** Tells the child its window changed size, so it can reflow and redraw. */
  resize(cols: number, rows: number): void {
    if (!this.running || !this.proc) return;
    try {
      this.proc.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      // Same race as write(): resizing a dead PTY throws and doesn't matter.
    }
  }

  /** Signals the child. Default SIGHUP mirrors closing a terminal window. */
  kill(signal?: string): void {
    if (!this.proc) return;
    try {
      this.proc.kill(signal);
    } catch {
      // Already gone.
    }
  }

  /** Kills the child and detaches all listeners. Safe to call more than once. */
  dispose(): void {
    this.kill();
    this.running = false;
    this.removeAllListeners();
  }

  override on<K extends keyof ClaudeSessionEvents>(
    event: K,
    listener: ClaudeSessionEvents[K],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof ClaudeSessionEvents>(
    event: K,
    ...args: Parameters<ClaudeSessionEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
