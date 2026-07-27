/**
 * The serialisable half of a pane.
 *
 * Kept apart from PaneSet so components can describe what they render without
 * importing the module that owns PTYs — `PaneGrid` should not drag `node-pty`
 * into its import graph just to name its own props.
 *
 * Everything here is immutable and replaced wholesale on change. That is what
 * lets `SessionPanel`'s memo hold: a repaint of pane 2 hands pane 1 back the
 * identical `frame` object, so pane 1 does not re-reconcile a single cell.
 */

import type { ExitInfo, SessionStatus, Snapshot } from '../types.js';

export type PaneId = string;

export interface PaneView {
  readonly id: PaneId;
  /** The child's screen as of the last repaint. */
  readonly frame: Snapshot;
  readonly status: SessionStatus;
  readonly startedAt: Date | null;
  readonly cwd: string;
  /** How the child finished, once it has. Null while it is still running. */
  readonly exit: ExitInfo | null;
  /** Set only when the PTY could not be created at all. */
  readonly spawnError: { readonly message: string; readonly detail: string } | null;
  /**
   * History record this pane opened, so the sidebar can mark it live. Null when
   * recording is off or the append failed.
   */
  readonly recordId: string | null;
}

/** Ids of the history records this process currently has open. */
export function liveRecordIds(views: readonly PaneView[]): Set<string> {
  const ids = new Set<string>();
  for (const view of views) {
    if (view.status === 'running' && view.recordId) ids.add(view.recordId);
  }
  return ids;
}

export function runningCount(views: readonly PaneView[]): number {
  return views.reduce((total, view) => total + (view.status === 'running' ? 1 : 0), 0);
}
