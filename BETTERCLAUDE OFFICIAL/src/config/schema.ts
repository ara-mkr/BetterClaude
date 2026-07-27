/**
 * Shape, defaults, and validation for the app's own settings file.
 *
 * Two rules drive the design:
 *
 *  1. A broken config must never stop the app starting. Every invalid field
 *     falls back to its default and is reported, rather than throwing.
 *  2. Unknown keys are preserved. A config written by a newer version keeps its
 *     extra fields when an older version saves over it, so downgrading does not
 *     silently destroy settings.
 */

import { THEME_NAMES } from '../theme/themes.js';
import { encodeKeyName, isValidCommandKey, unsafeLeaderReason } from '../input/keymap.js';
import { MAX_PANES, ORIENTATIONS, type Orientation } from '../panes/layout.js';

export const CONFIG_VERSION = 3;

export interface KeymapConfig {
  quit: string;
  settings: string;
  reload: string;
  history: string;
  split: string;
  closePane: string;
  focusNext: string;
  toggleOrientation: string;
}

export interface PanesConfig {
  /** Side by side or stacked. One choice for the whole screen, not per split. */
  orientation: Orientation;
  /** Panes opened at launch. `--panes` overrides it for a single run. */
  startCount: number;
}

export interface HistoryConfig {
  /** Whether sessions are recorded at all. Metadata only, never content. */
  enabled: boolean;
  /** Show the sidebar from launch rather than waiting for the toggle. */
  sidebar: boolean;
  /** Sessions retained. Older ones are dropped when the log is compacted. */
  limit: number;
  /**
   * Store the arguments forwarded to `claude`. Off by default and deliberately
   * so: `claude -p "some prompt"` would put conversation content in the log.
   */
  recordArgs: boolean;
}

export interface Config {
  version: number;
  theme: string;
  frame: boolean;
  /** Human-readable key name, e.g. "ctrl+g". Stored as a name, not a raw byte. */
  leader: string;
  keymap: KeymapConfig;
  history: HistoryConfig;
  panes: PanesConfig;
}

/** What the settings screen cycles through; the file accepts any whole number. */
export const HISTORY_LIMIT_CHOICES: readonly number[] = [50, 100, 200, 500, 1000];
export const HISTORY_LIMIT_MIN = 1;
export const HISTORY_LIMIT_MAX = 100_000;

export const DEFAULT_CONFIG: Config = {
  version: CONFIG_VERSION,
  theme: 'terminal',
  frame: false,
  leader: 'ctrl+g',
  keymap: {
    quit: 'q',
    settings: ',',
    reload: 'r',
    history: 'h',
    split: 's',
    closePane: 'x',
    focusNext: 'o',
    toggleOrientation: 'v',
  },
  history: { enabled: true, sidebar: false, limit: 200, recordArgs: false },
  panes: { orientation: 'columns', startCount: 1 },
};

/**
 * Order matters. The clash check below resolves in favour of whichever action
 * comes first, so the pane actions are listed last: a config written before they
 * existed keeps its own bindings, and the newcomer is the one reported.
 */
export const KEYMAP_ACTIONS = [
  'quit',
  'settings',
  'reload',
  'history',
  'split',
  'closePane',
  'focusNext',
  'toggleOrientation',
] as const;
export type KeymapAction = (typeof KEYMAP_ACTIONS)[number];

export const ACTION_LABELS: Readonly<Record<KeymapAction, string>> = {
  quit: 'Quit',
  settings: 'Settings',
  reload: 'Reload config',
  history: 'History sidebar',
  split: 'Split (new pane)',
  closePane: 'Close pane',
  focusNext: 'Focus next pane',
  toggleOrientation: 'Flip split direction',
};

export interface ParseResult {
  config: Config;
  /** Human-readable descriptions of anything that had to be corrected. */
  problems: string[];
  /** Keys we did not recognise, carried through untouched on the next save. */
  unknown: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns a reason the value cannot be a leader, or undefined when it can. */
export function validateLeader(value: unknown): string | undefined {
  if (typeof value !== 'string') return '"leader" must be a string.';

  const name = value.trim().toLowerCase();
  const unsafe = unsafeLeaderReason(name);
  if (unsafe) return `"${name}" cannot be the leader key because it ${unsafe}.`;

  if (!encodeKeyName(name)) {
    return `"${name}" is not a recognised key name (expected something like "ctrl+g").`;
  }
  return undefined;
}

function parseKeymap(raw: unknown, problems: string[]): KeymapConfig {
  const keymap: KeymapConfig = { ...DEFAULT_CONFIG.keymap };
  if (raw === undefined) return keymap;

  if (!isRecord(raw)) {
    problems.push('"keymap" must be an object; using defaults.');
    return keymap;
  }

  for (const action of KEYMAP_ACTIONS) {
    const value = raw[action];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !isValidCommandKey(value)) {
      problems.push(
        `"keymap.${action}" must be a single printable character; using "${keymap[action]}".`,
      );
      continue;
    }
    keymap[action] = value;
  }

  // Two actions on one key means the second is unreachable. Better to say so
  // than to let the user wonder why a binding does nothing.
  const seen = new Map<string, KeymapAction>();
  for (const action of KEYMAP_ACTIONS) {
    const key = keymap[action];
    const owner = seen.get(key);
    if (owner) {
      // Resetting blindly would be a trap. A v1 config that bound an older
      // action to "h" collides with the new history default, so falling back to
      // that default would re-report the same clash on every single load.
      const fallback = DEFAULT_CONFIG.keymap[action];
      if (fallback !== key && !seen.has(fallback)) {
        problems.push(
          `"${key}" is bound to both ${owner} and ${action}; resetting ${action} to "${fallback}".`,
        );
        keymap[action] = fallback;
      } else {
        problems.push(
          `"${key}" is bound to both ${owner} and ${action}; ${action} is unreachable until you rebind it.`,
        );
      }
    }
    seen.set(keymap[action], action);
  }

  return keymap;
}

function parseHistory(raw: unknown, problems: string[]): HistoryConfig {
  const history: HistoryConfig = { ...DEFAULT_CONFIG.history };
  if (raw === undefined) return history;

  if (!isRecord(raw)) {
    problems.push('"history" must be an object; using defaults.');
    return history;
  }

  for (const flag of ['enabled', 'sidebar', 'recordArgs'] as const) {
    const value = raw[flag];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      problems.push(`"history.${flag}" must be true or false; using ${history[flag]}.`);
      continue;
    }
    history[flag] = value;
  }

  const limit = raw['limit'];
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit)) {
      problems.push(`"history.limit" must be a whole number; using ${history.limit}.`);
    } else if (limit < HISTORY_LIMIT_MIN || limit > HISTORY_LIMIT_MAX) {
      const clamped = Math.min(HISTORY_LIMIT_MAX, Math.max(HISTORY_LIMIT_MIN, limit));
      problems.push(
        `"history.limit" must be between ${HISTORY_LIMIT_MIN} and ${HISTORY_LIMIT_MAX}; using ${clamped}.`,
      );
      history.limit = clamped;
    } else {
      history.limit = limit;
    }
  }

  return history;
}

function parsePanes(raw: unknown, problems: string[]): PanesConfig {
  const panes: PanesConfig = { ...DEFAULT_CONFIG.panes };
  if (raw === undefined) return panes;

  if (!isRecord(raw)) {
    problems.push('"panes" must be an object; using defaults.');
    return panes;
  }

  const orientation = raw['orientation'];
  if (orientation !== undefined) {
    const name = typeof orientation === 'string' ? orientation.toLowerCase() : '';
    if (ORIENTATIONS.includes(name as Orientation)) {
      panes.orientation = name as Orientation;
    } else {
      problems.push(
        `"panes.orientation" must be one of ${ORIENTATIONS.join(', ')}; using "${panes.orientation}".`,
      );
    }
  }

  const startCount = raw['startCount'];
  if (startCount !== undefined) {
    if (typeof startCount !== 'number' || !Number.isInteger(startCount)) {
      problems.push(`"panes.startCount" must be a whole number; using ${panes.startCount}.`);
    } else if (startCount < 1 || startCount > MAX_PANES) {
      // Clamped rather than rejected: asking for more panes than exist is a
      // reasonable thing to have written, and the terminal gets the final say
      // on how many actually fit anyway.
      const clamped = Math.min(MAX_PANES, Math.max(1, startCount));
      problems.push(`"panes.startCount" must be between 1 and ${MAX_PANES}; using ${clamped}.`);
      panes.startCount = clamped;
    } else {
      panes.startCount = startCount;
    }
  }

  return panes;
}

/** Never throws. Returns a usable config plus a list of what was wrong. */
export function parseConfig(raw: unknown): ParseResult {
  const problems: string[] = [];
  const unknown: Record<string, unknown> = {};
  const config: Config = {
    ...DEFAULT_CONFIG,
    keymap: { ...DEFAULT_CONFIG.keymap },
    history: { ...DEFAULT_CONFIG.history },
    panes: { ...DEFAULT_CONFIG.panes },
  };

  if (!isRecord(raw)) {
    if (raw !== undefined) problems.push('Config root must be a JSON object; using defaults.');
    return { config, problems, unknown };
  }

  const known = new Set(['version', 'theme', 'frame', 'leader', 'keymap', 'history', 'panes']);
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) unknown[key] = value;
  }

  const version = raw['version'];
  if (typeof version === 'number') {
    config.version = version;
    if (version > CONFIG_VERSION) {
      problems.push(
        `Config version ${version} is newer than this build understands (${CONFIG_VERSION}); unknown settings are preserved.`,
      );
    }
  }

  const theme = raw['theme'];
  if (theme !== undefined) {
    if (typeof theme === 'string' && THEME_NAMES.includes(theme.toLowerCase())) {
      config.theme = theme.toLowerCase();
    } else {
      problems.push(`Unknown theme ${JSON.stringify(theme)}; using "${config.theme}".`);
    }
  }

  const frame = raw['frame'];
  if (frame !== undefined) {
    if (typeof frame === 'boolean') config.frame = frame;
    else problems.push('"frame" must be true or false; using false.');
  }

  const leader = raw['leader'];
  if (leader !== undefined) {
    const problem = validateLeader(leader);
    if (problem) problems.push(`${problem} Using "${config.leader}".`);
    else config.leader = String(leader).trim().toLowerCase();
  }

  config.keymap = parseKeymap(raw['keymap'], problems);
  config.history = parseHistory(raw['history'], problems);
  config.panes = parsePanes(raw['panes'], problems);

  return { config, problems, unknown };
}

/** Serialises for disk, putting unknown forward-compatible keys back. */
export function serialiseConfig(config: Config, unknown: Record<string, unknown>): string {
  return `${JSON.stringify({ ...unknown, ...config, version: CONFIG_VERSION }, null, 2)}\n`;
}
