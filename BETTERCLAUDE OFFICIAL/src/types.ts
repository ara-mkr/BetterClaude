/**
 * Shared types for the wrapper layer.
 *
 * Nothing here models Claude's protocol, conversation content, or credentials —
 * these describe terminal cells and process lifecycle only.
 */

/** Visual attributes of a single terminal cell, expressed in Ink's vocabulary. */
export interface CellStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
}

/** A horizontal span of cells that share one style, collapsed into one string. */
export interface StyledRun extends CellStyle {
  text: string;
}

/** One rendered terminal line, as a list of styled runs. */
export type StyledRow = StyledRun[];

/** Where the child process believes the cursor is, in viewport coordinates. */
export interface CursorPosition {
  x: number;
  y: number;
  visible: boolean;
}

/** An immutable view of the virtual screen at one instant. */
export interface Snapshot {
  rows: StyledRow[];
  cursor: CursorPosition;
}

/** Lifecycle of a wrapped `claude` subprocess. */
export type SessionStatus = 'starting' | 'running' | 'exited' | 'error';

/** How a child process finished. */
export interface ExitInfo {
  exitCode: number;
  signal?: number | undefined;
}

export const emptySnapshot: Snapshot = {
  rows: [],
  cursor: { x: 0, y: 0, visible: false },
};
