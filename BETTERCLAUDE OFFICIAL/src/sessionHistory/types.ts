/**
 * What the app is willing to remember about a session, and how the on-disk log
 * folds into it.
 *
 * This file is the whole privacy story of the feature. The types below are the
 * complete set of facts recorded about a session — when it ran, where, how it
 * ended. There is no field for prompts, responses, or anything the child printed,
 * and there could not be: the wrapper hands PTY bytes to a terminal emulator
 * without reading them, so it has nothing to write down even if it wanted to.
 *
 * The log is a sequence of events rather than a table of rows because a session
 * does not always end politely. A `start` is appended the moment the child
 * spawns; an `end` is appended when it exits. A session killed by SIGHUP leaves
 * a start with no end, which is recorded honestly as "interrupted" instead of
 * vanishing from the list.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Bumped only if the meaning of an existing field changes. */
export const HISTORY_EVENT_VERSION = 1;

export interface StartEvent {
  readonly v: number;
  readonly kind: 'start';
  readonly id: string;
  /** ISO-8601 UTC with millisecond precision, i.e. `Date.toISOString()`. */
  readonly startedAt: string;
  readonly cwd: string;
  readonly label: string;
  readonly pid: number | null;
  /** Wrapper version that wrote the line, so old records stay interpretable. */
  readonly app: string;
  /**
   * Arguments forwarded to `claude`. Absent unless the user opted in, because
   * `claude -p "some prompt"` would put conversation content in this file.
   */
  readonly args?: readonly string[];
}

export interface EndEvent {
  readonly v: number;
  readonly kind: 'end';
  readonly id: string;
  readonly endedAt: string;
  readonly exitCode: number | null;
  readonly signal: number | null;
}

export type HistoryEvent = StartEvent | EndEvent;

/** One session, after its start and end events have been folded together. */
export interface SessionRecord {
  readonly id: string;
  readonly startedAt: string;
  /** Null when the session never closed cleanly. */
  readonly endedAt: string | null;
  readonly cwd: string;
  readonly label: string;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: number | null;
  readonly app: string;
  readonly args: readonly string[] | null;
}

export type SessionOutcome = 'running' | 'ok' | 'failed' | 'interrupted';

export interface StartInput {
  readonly cwd: string;
  readonly pid: number | null;
  readonly app: string;
  readonly args?: readonly string[] | undefined;
  /** Injectable so tests do not depend on the clock or the UUID generator. */
  readonly id?: string;
  readonly startedAt?: Date;
}

/**
 * The short name shown in the sidebar.
 *
 * Deliberately the directory's basename and not the git repository name: reading
 * `.git/HEAD` would mean opening a file outside `~/.betterclaude-official/`, and
 * "this app touches exactly one directory" is worth more than a nicer label.
 */
export function deriveLabel(cwd: string): string {
  const base = path.basename(cwd);
  return base.length > 0 ? base : cwd;
}

export function createStartEvent(input: StartInput): StartEvent {
  const startedAt = input.startedAt ?? new Date();
  const base: StartEvent = {
    v: HISTORY_EVENT_VERSION,
    kind: 'start',
    id: input.id ?? randomUUID(),
    startedAt: startedAt.toISOString(),
    cwd: input.cwd,
    label: deriveLabel(input.cwd),
    pid: input.pid,
    app: input.app,
  };
  // Spread rather than an inline `args: undefined`, so the key is absent from
  // the JSON entirely when opting out rather than present and null.
  return input.args ? { ...base, args: [...input.args] } : base;
}

export function createEndEvent(
  id: string,
  exit: { exitCode: number | null; signal: number | null },
  endedAt: Date = new Date(),
): EndEvent {
  return {
    v: HISTORY_EVENT_VERSION,
    kind: 'end',
    id,
    endedAt: endedAt.toISOString(),
    exitCode: exit.exitCode,
    signal: exit.signal,
  };
}

export function serialiseEvent(event: HistoryEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
}

/**
 * Validates one parsed line.
 *
 * Returns undefined rather than throwing for anything malformed: a hand-edited
 * or half-written line should cost the user that one entry, not their history.
 */
export function parseEvent(raw: unknown): HistoryEvent | undefined {
  if (!isRecord(raw)) return undefined;

  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0) return undefined;

  const version = typeof raw['v'] === 'number' ? raw['v'] : HISTORY_EVENT_VERSION;

  if (raw['kind'] === 'start') {
    const startedAt = asTimestamp(raw['startedAt']);
    const cwd = raw['cwd'];
    if (!startedAt || typeof cwd !== 'string') return undefined;

    const label = raw['label'];
    const app = raw['app'];
    const event: StartEvent = {
      v: version,
      kind: 'start',
      id,
      startedAt,
      cwd,
      label: typeof label === 'string' && label.length > 0 ? label : deriveLabel(cwd),
      pid: asNullableNumber(raw['pid']),
      app: typeof app === 'string' ? app : '',
    };
    const args = asStringArray(raw['args']);
    return args ? { ...event, args } : event;
  }

  if (raw['kind'] === 'end') {
    const endedAt = asTimestamp(raw['endedAt']);
    if (!endedAt) return undefined;
    return {
      v: version,
      kind: 'end',
      id,
      endedAt,
      exitCode: asNullableNumber(raw['exitCode']),
      signal: asNullableNumber(raw['signal']),
    };
  }

  return undefined;
}

function toRecord(event: StartEvent): SessionRecord {
  return {
    id: event.id,
    startedAt: event.startedAt,
    endedAt: null,
    cwd: event.cwd,
    label: event.label,
    pid: event.pid,
    exitCode: null,
    signal: null,
    app: event.app,
    args: event.args ?? null,
  };
}

/**
 * Collapses the event log into one record per session, oldest first.
 *
 * A Map keeps insertion order, so records stay in the order their sessions
 * started; closing one later does not move it. An `end` with no matching `start`
 * is dropped, since there is nothing meaningful to show for it.
 */
export function foldEvents(events: Iterable<HistoryEvent>): SessionRecord[] {
  const byId = new Map<string, SessionRecord>();

  for (const event of events) {
    if (event.kind === 'start') {
      byId.set(event.id, toRecord(event));
      continue;
    }
    const existing = byId.get(event.id);
    if (!existing) continue;
    byId.set(event.id, {
      ...existing,
      endedAt: event.endedAt,
      exitCode: event.exitCode,
      signal: event.signal,
    });
  }

  return [...byId.values()];
}

/** Turns a folded record back into the lines that produced it, for compaction. */
export function toEvents(record: SessionRecord): HistoryEvent[] {
  const start: StartEvent = {
    v: HISTORY_EVENT_VERSION,
    kind: 'start',
    id: record.id,
    startedAt: record.startedAt,
    cwd: record.cwd,
    label: record.label,
    pid: record.pid,
    app: record.app,
  };
  const events: HistoryEvent[] = [record.args ? { ...start, args: record.args } : start];

  if (record.endedAt !== null) {
    events.push({
      v: HISTORY_EVENT_VERSION,
      kind: 'end',
      id: record.id,
      endedAt: record.endedAt,
      exitCode: record.exitCode,
      signal: record.signal,
    });
  }

  return events;
}

export function durationMs(record: SessionRecord): number | null {
  if (record.endedAt === null) return null;
  const start = Date.parse(record.startedAt);
  const end = Date.parse(record.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/**
 * How a session finished.
 *
 * `activeIds` are the sessions this process is running right now — a set rather
 * than one id, because panes mean several can be open at once. They are passed
 * in rather than inferred because on disk a live session is indistinguishable
 * from one that was killed: both are a start with no end.
 */
export function outcomeOf(
  record: SessionRecord,
  activeIds?: ReadonlySet<string> | null,
): SessionOutcome {
  if (record.endedAt === null) {
    return activeIds?.has(record.id) ? 'running' : 'interrupted';
  }
  if (record.signal !== null && record.signal !== 0) return 'failed';
  if (record.exitCode === null) return 'interrupted';
  return record.exitCode === 0 ? 'ok' : 'failed';
}
