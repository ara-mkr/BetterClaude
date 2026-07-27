/**
 * Owns every live pane: one PTY, one emulator, and one history record each.
 *
 * Deliberately not a React component and not a hook. The things a pane is made
 * of — a subprocess, a VT parser, an open log record — are mutable, long-lived,
 * and must survive every re-render the chrome causes. Holding them here and
 * pushing an immutable `PaneView[]` at React keeps that distinction honest, and
 * makes the whole lifecycle testable without mounting anything.
 *
 * One frame clock for all panes, not one each. Three panes with three throttlers
 * would be ninety React updates a second between them; a shared clock with a
 * per-pane dirty flag keeps repaint cost flat no matter how many panes are open.
 * Panes that did not change are handed back the identical view object, so their
 * memoised panels skip reconciliation entirely.
 */

import { ClaudeSession, PtySpawnError } from '../pty/ClaudeSession.js';
import { TerminalBuffer } from '../vt/TerminalBuffer.js';
import { createThrottler, type Throttler } from '../util/throttle.js';
import { beginSession, endSession } from '../sessionHistory/store.js';
import { debug } from '../util/logger.js';
import { emptySnapshot, type ExitInfo } from '../types.js';
import type { Layout } from './layout.js';
import type { PaneId, PaneView } from './types.js';

export interface PaneRecordingOptions {
  readonly enabled: boolean;
  readonly recordArgs: boolean;
}

export interface PaneSetOptions {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly appVersion: string;
  readonly recording: PaneRecordingOptions;
  readonly frameIntervalMs: number;
  /** Called with a fresh array whenever anything a pane renders from changes. */
  readonly onViews: (views: PaneView[]) => void;
  /** Called after a child exits, once its view already says so. */
  readonly onExit: (id: PaneId, info: ExitInfo) => void;
}

export interface PaneSize {
  readonly cols: number;
  readonly rows: number;
}

interface PaneRuntime {
  readonly id: PaneId;
  session: ClaudeSession | null;
  buffer: TerminalBuffer | null;
  /** Set when bytes have arrived that the current view does not yet show. */
  dirty: boolean;
  view: PaneView;
}

export class PaneSet {
  private readonly options: PaneSetOptions;
  private readonly runtimes: PaneRuntime[] = [];
  private readonly throttler: Throttler;
  private sequence = 0;
  private disposed = false;

  constructor(options: PaneSetOptions) {
    this.options = options;
    this.throttler = createThrottler(() => {
      this.snapshotDirty();
      this.emit();
    }, options.frameIntervalMs);
  }

  get count(): number {
    return this.runtimes.length;
  }

  get runningCount(): number {
    return this.runtimes.reduce(
      (total, runtime) => total + (runtime.view.status === 'running' ? 1 : 0),
      0,
    );
  }

  views(): PaneView[] {
    return this.runtimes.map((runtime) => runtime.view);
  }

  indexOf(id: PaneId): number {
    return this.runtimes.findIndex((runtime) => runtime.id === id);
  }

  /**
   * Starts a pane at the given size and returns its id.
   *
   * A PTY that fails to spawn still produces a pane — one in the `error` state,
   * holding the reason. That keeps the caller's bookkeeping simple, and lets a
   * failure inside a split show up in the pane that failed rather than taking
   * down the sessions running beside it.
   */
  spawn(size: PaneSize): PaneId {
    this.sequence += 1;
    const id: PaneId = `pane-${this.sequence}`;

    const runtime: PaneRuntime = {
      id,
      session: null,
      buffer: null,
      dirty: false,
      view: {
        id,
        frame: emptySnapshot,
        status: 'starting',
        startedAt: null,
        cwd: this.options.cwd,
        exit: null,
        spawnError: null,
        recordId: null,
      },
    };
    this.runtimes.push(runtime);

    const cols = Math.max(1, size.cols);
    const rows = Math.max(1, size.rows);
    const buffer = new TerminalBuffer(cols, rows);

    let session: ClaudeSession;
    try {
      session = new ClaudeSession({
        binaryPath: this.options.binaryPath,
        args: [...this.options.args],
        cwd: this.options.cwd,
        cols,
        rows,
      });
    } catch (error) {
      debug('pane:spawn-error', { id, message: String(error) });
      buffer.dispose();
      runtime.view = {
        ...runtime.view,
        status: 'error',
        spawnError:
          error instanceof PtySpawnError
            ? { message: error.message, detail: error.detail }
            : { message: 'Could not start the claude subprocess.', detail: String(error) },
      };
      this.emit();
      return id;
    }

    runtime.buffer = buffer;
    runtime.session = session;

    // Appended before the first byte is read, so a session that dies instantly
    // still leaves a trace. One record per pane — the store keys its open
    // records by id and was built for exactly this.
    let recordId: string | null = null;
    if (this.options.recording.enabled) {
      const started = beginSession({
        cwd: this.options.cwd,
        pid: session.pid ?? null,
        app: this.options.appVersion,
        args: this.options.recording.recordArgs ? [...this.options.args] : undefined,
        startedAt: session.startedAt,
      });
      if (started) recordId = started.id;
    }

    runtime.view = {
      ...runtime.view,
      status: 'running',
      startedAt: session.startedAt,
      recordId,
    };

    session.on('data', (chunk) => {
      // Snapshot from the parse-complete callback, never after write() returns:
      // xterm parses asynchronously and would otherwise hand back a stale grid.
      buffer.write(chunk, () => {
        runtime.dirty = true;
        this.throttler.trigger();
      });
    });

    session.on('exit', (info) => {
      debug('pane:exit', { id, exitCode: info.exitCode });
      this.handleExit(runtime, info);
    });

    this.emit();
    return id;
  }

  /**
   * Closes a pane and forgets it.
   *
   * The buffer is disposed here and not on exit, because an exited pane keeps
   * its last frame on screen until the user dismisses it.
   */
  close(id: PaneId): boolean {
    const index = this.indexOf(id);
    if (index === -1) return false;

    const [runtime] = this.runtimes.splice(index, 1);
    if (!runtime) return false;

    this.teardown(runtime);
    this.emit();
    return true;
  }

  write(id: PaneId, data: string): void {
    const runtime = this.runtimes.find((candidate) => candidate.id === id);
    if (!runtime || runtime.view.status !== 'running') return;
    runtime.session?.write(data);
  }

  /**
   * Resizes every pane to its box.
   *
   * Emulator and PTY move together and in that order, then a snapshot is forced
   * so the new geometry is on screen in the same frame rather than waiting for
   * the child to redraw of its own accord.
   */
  applyLayout(layout: Layout): void {
    if (this.disposed) return;

    this.runtimes.forEach((runtime, index) => {
      const box = layout.panes[index];
      if (!box) return;
      const cols = Math.max(1, box.cols);
      const rows = Math.max(1, box.rows);
      runtime.buffer?.resize(cols, rows);
      runtime.session?.resize(cols, rows);
      if (runtime.buffer) runtime.dirty = true;
    });

    this.snapshotDirty();
    this.emit();
  }

  /** Kills every child without waiting for exit events. For quitting. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.throttler.dispose();
    for (const runtime of this.runtimes) this.teardown(runtime);
    this.runtimes.length = 0;
  }

  private handleExit(runtime: PaneRuntime, info: ExitInfo): void {
    if (this.disposed) return;

    // Any snapshot the child's final output already queued should land before
    // the pane freezes, otherwise the placeholder shows a frame short.
    this.throttler.flush();
    this.snapshotDirty();

    if (runtime.view.recordId) {
      endSession(runtime.view.recordId, {
        exitCode: info.exitCode,
        signal: info.signal ?? null,
      });
    }

    runtime.session = null;
    runtime.view = { ...runtime.view, status: 'exited', exit: info, recordId: null };
    this.emit();
    this.options.onExit(runtime.id, info);
  }

  private teardown(runtime: PaneRuntime): void {
    runtime.session?.dispose();
    runtime.buffer?.dispose();
    runtime.session = null;
    runtime.buffer = null;
    // Unmount and a quit chord can both beat the PTY's own exit event. The store
    // ignores an id it has already closed, so whichever path arrives first wins
    // and the other is a no-op. The exit code is genuinely unknown on this path
    // and is recorded as null rather than guessed at.
    if (runtime.view.recordId) {
      endSession(runtime.view.recordId, { exitCode: null, signal: null });
      runtime.view = { ...runtime.view, recordId: null };
    }
  }

  private snapshotDirty(): void {
    for (const runtime of this.runtimes) {
      if (!runtime.dirty || !runtime.buffer) continue;
      runtime.dirty = false;
      try {
        runtime.view = { ...runtime.view, frame: runtime.buffer.snapshot() };
      } catch (error) {
        debug('pane:frame-error', { id: runtime.id, message: String(error) });
      }
    }
  }

  private emit(): void {
    if (this.disposed) return;
    this.options.onViews(this.views());
  }
}
