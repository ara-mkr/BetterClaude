/**
 * A headless terminal emulator that stands in for the screen `claude` thinks it
 * is drawing to.
 *
 * The wrapper never interprets or rewrites the child's output — it hands the raw
 * bytes to a real VT implementation and reads back the resulting grid. That keeps
 * `claude`'s own styling and layout intact instead of second-guessing it.
 */

// @xterm/headless is CommonJS and Node cannot statically detect its named
// exports, so `import { Terminal }` typechecks but throws at runtime. The default
// import is the interop-safe form.
import xtermHeadless from '@xterm/headless';
import type { Terminal as XTerm } from '@xterm/headless';
import type { Snapshot } from '../types.js';
import { snapshot } from './serialize.js';

const { Terminal } = xtermHeadless;

const SCROLLBACK_LINES = 5000;

/** Matches DEC private mode set/reset, e.g. `ESC [ ? 25 l`. */
const DEC_PRIVATE_MODE = /\x1b\[\?([0-9;]*)([hl])/g;

export class TerminalBuffer {
  private readonly term: XTerm;
  private cursorVisible = true;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols: Math.max(1, cols),
      rows: Math.max(1, rows),
      allowProposedApi: true,
      scrollback: SCROLLBACK_LINES,
    });
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /**
   * Feeds PTY output into the emulator.
   *
   * xterm parses asynchronously, so `done` — not the return of this call — is when
   * the grid actually reflects `data`. Snapshotting before then renders a stale
   * frame and makes the session look like it lags a keystroke behind.
   */
  write(data: string, done?: () => void): void {
    this.trackCursorVisibility(data);
    this.term.write(data, done);
  }

  resize(cols: number, rows: number): void {
    const nextCols = Math.max(1, cols);
    const nextRows = Math.max(1, rows);
    if (nextCols === this.term.cols && nextRows === this.term.rows) return;
    this.term.resize(nextCols, nextRows);
  }

  snapshot(): Snapshot {
    return snapshot(this.term, this.cursorVisible);
  }

  dispose(): void {
    this.term.dispose();
  }

  /**
   * xterm does not expose DECTCEM state publicly, so cursor visibility is tracked
   * by watching the byte stream. A sequence split across two PTY chunks is missed,
   * which costs at most one frame of a stray block cursor — not worth a parser.
   */
  private trackCursorVisibility(data: string): void {
    DEC_PRIVATE_MODE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DEC_PRIVATE_MODE.exec(data)) !== null) {
      const params = (match[1] ?? '').split(';');
      if (params.includes('25')) this.cursorVisible = match[2] === 'h';
    }
  }
}
