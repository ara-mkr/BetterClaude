/**
 * Opt-in debug log.
 *
 * A TUI owns the screen, so console.log is useless for diagnosis — anything
 * printed is either erased by the next frame or corrupts the layout. Setting
 * BETTERCLAUDE_DEBUG=<path> appends timestamped lines to a file instead.
 *
 * Disabled by default, and it never records PTY payloads: call sites pass sizes
 * and state transitions, not the bytes flowing to or from the child.
 */

import { appendFileSync } from 'node:fs';

const target = process.env['BETTERCLAUDE_DEBUG'];
const started = Date.now();

export const debugEnabled = Boolean(target);

export function debug(event: string, fields: Record<string, unknown> = {}): void {
  if (!target) return;
  const elapsed = String(Date.now() - started).padStart(6, ' ');
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  try {
    appendFileSync(target, `${elapsed}ms ${event}${detail ? ' ' + detail : ''}\n`);
  } catch {
    // Diagnostics must never take the app down.
  }
}
