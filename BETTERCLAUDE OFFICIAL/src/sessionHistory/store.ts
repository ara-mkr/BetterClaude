/**
 * Reads and writes the session history log.
 *
 * The file is append-only JSON Lines rather than one JSON array, for three
 * reasons that all matter more than tidiness:
 *
 *  1. Recording a session start is a single short append, which cannot leave an
 *     earlier record half-written the way a read-modify-write of a whole array
 *     can.
 *  2. A torn or hand-edited line costs the user that one line. Everything else
 *     still parses.
 *  3. Ending a session is another append, so a crash between start and end is
 *     not a lost record — it is a record with no end, which is the truth.
 *
 * Nothing in here can take the session down. Every filesystem call is wrapped;
 * a failure is written to the debug log and the wrapper carries on. History is a
 * convenience, and losing it must never cost someone their `claude` session.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { configDir, historyFile } from '../config/paths.js';
import { debug } from '../util/logger.js';
import {
  createEndEvent,
  createStartEvent,
  foldEvents,
  parseEvent,
  serialiseEvent,
  toEvents,
  type HistoryEvent,
  type SessionRecord,
  type StartEvent,
  type StartInput,
} from './types.js';

/**
 * Ceiling on how much of the log is ever read into memory. Compaction normally
 * keeps the file far below this; the cap exists so a file that grew by some
 * other route cannot make startup pathological.
 */
const MAX_READ_BYTES = 2_000_000;

/** Sessions whose start was recorded but whose end has not been written yet. */
const pending = new Map<string, StartEvent>();

export { historyFile };

/**
 * Reads the log, tolerating a file larger than we are willing to hold.
 *
 * When over the cap we keep the tail, then drop everything up to the first
 * newline — that discards the partial line the byte-offset read landed inside,
 * including any multi-byte character it split.
 */
function readRaw(): string {
  const target = historyFile();

  let size: number;
  try {
    size = statSync(target).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }

  if (size <= MAX_READ_BYTES) return readFileSync(target, 'utf8');

  const fd = openSync(target, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_READ_BYTES);
    const read = readSync(fd, buffer, 0, MAX_READ_BYTES, size - MAX_READ_BYTES);
    const text = buffer.subarray(0, read).toString('utf8');
    const firstNewline = text.indexOf('\n');
    return firstNewline === -1 ? '' : text.slice(firstNewline + 1);
  } finally {
    closeSync(fd);
  }
}

interface LoadedEvents {
  events: HistoryEvent[];
  /** Non-empty lines that did not survive parsing. */
  skipped: number;
  /** Non-empty lines seen, which is what compaction thresholds are measured in. */
  lines: number;
}

function loadEvents(): LoadedEvents {
  let text: string;
  try {
    text = readRaw();
  } catch (error) {
    debug('history:read-failed', { message: String(error) });
    return { events: [], skipped: 0, lines: 0 };
  }

  const events: HistoryEvent[] = [];
  let skipped = 0;
  let lines = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    lines++;

    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }

    const event = parseEvent(json);
    if (event) events.push(event);
    else skipped++;
  }

  if (skipped > 0) debug('history:skipped-lines', { skipped, lines });
  return { events, skipped, lines };
}

/**
 * All recorded sessions, newest first.
 *
 * `limit` trims the result for display; it does not delete anything. Pruning is
 * compaction's job.
 */
export function readSessions(limit?: number): SessionRecord[] {
  const records = foldEvents(loadEvents().events).reverse();
  return typeof limit === 'number' && limit > 0 ? records.slice(0, limit) : records;
}

function append(event: HistoryEvent): boolean {
  try {
    // 0o700 / 0o600: this is a record of where and when the user works, and is
    // nobody else's business. The modes only apply on creation.
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    appendFileSync(historyFile(), serialiseEvent(event), { mode: 0o600 });
    return true;
  } catch (error) {
    debug('history:append-failed', { message: String(error) });
    return false;
  }
}

/**
 * Records that a session started. Returns the event so the caller can hold on to
 * the id, or null if the write failed and there is nothing to close later.
 */
export function beginSession(input: StartInput): StartEvent | null {
  const event = createStartEvent(input);
  if (!append(event)) return null;
  pending.set(event.id, event);
  debug('history:begin', { id: event.id });
  return event;
}

/**
 * Records that a session ended. A no-op for an id that was never recorded or has
 * already been closed, so the several paths that race to end a session (the PTY
 * exit event, React unmount, and the process exit handler) can all call it.
 */
export function endSession(
  id: string,
  exit: { exitCode: number | null; signal: number | null },
): void {
  if (!pending.has(id)) return;
  pending.delete(id);
  append(createEndEvent(id, exit));
  debug('history:end', { id, exitCode: exit.exitCode });
}

/**
 * Closes anything still open, for the process-exit backstop. The exit code is
 * unknown on this path, which is recorded as null rather than guessed at.
 */
export function endAllPending(): void {
  for (const id of [...pending.keys()]) {
    endSession(id, { exitCode: null, signal: null });
  }
}

/** Only exported for tests, which need a clean slate between cases. */
export function resetPendingForTests(): void {
  pending.clear();
}

function compactThreshold(limit: number): number {
  // Two lines per session plus slack, so a log at exactly the retention limit
  // never triggers a rewrite on every launch.
  return limit * 2 + 64;
}

/**
 * Trims the log to the newest `limit` sessions, if it has grown enough to be
 * worth rewriting.
 *
 * The rewrite is atomic — temp file then rename — so an interrupted compaction
 * leaves the previous log intact rather than a truncated one.
 *
 * Two `betterclaude` processes compacting at the same instant can cost the loser
 * a record appended during the winner's read. That is accepted: compaction is
 * rare by construction, appends themselves do not race, and the worst case is
 * one missing history row.
 */
export function compact(limit: number): void {
  if (!Number.isFinite(limit) || limit <= 0) return;

  try {
    const { events, lines } = loadEvents();
    if (lines <= compactThreshold(limit)) return;

    const records = foldEvents(events);
    const keep = records.slice(Math.max(0, records.length - limit));

    const body = keep
      .flatMap((record) => toEvents(record))
      .map((event) => serialiseEvent(event))
      .join('');

    const directory = configDir();
    const target = historyFile();
    const temporary = path.join(directory, `.history.jsonl.${process.pid}.tmp`);

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(temporary, body, { mode: 0o600 });
      renameSync(temporary, target);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // The temp file may not exist; nothing to clean up.
      }
      throw error;
    }

    debug('history:compacted', { from: lines, kept: keep.length });
  } catch (error) {
    debug('history:compact-failed', { message: String(error) });
  }
}
