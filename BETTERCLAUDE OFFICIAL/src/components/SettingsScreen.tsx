/**
 * Settings editor.
 *
 * Key handling lives in a pure reducer rather than in the component, so App can
 * keep every keystroke decision in one place: while this screen has focus the
 * bytes belong to us, and the moment it closes they go straight back to the
 * child untouched.
 *
 * Edits apply to a draft. Nothing reaches disk until the user saves, and closing
 * with Esc discards — including the live theme preview.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/ThemeContext.js';
import { THEMES, THEME_NAMES } from '../theme/themes.js';
import { displayPath } from '../config/paths.js';
import {
  ACTION_LABELS,
  HISTORY_LIMIT_CHOICES,
  KEYMAP_ACTIONS,
  type Config,
  type KeymapAction,
} from '../config/schema.js';
import { MAX_PANES, ORIENTATIONS, type Orientation } from '../panes/layout.js';
import { SAFE_LEADERS, decodeKey, isValidCommandKey } from '../input/keymap.js';

type HistoryRowId = 'historyEnabled' | 'historySidebar' | 'historyLimit' | 'historyArgs';
type PaneRowId = 'panesOrientation' | 'panesStart';
type RowId = 'theme' | 'frame' | 'leader' | HistoryRowId | PaneRowId | KeymapAction;

interface Row {
  readonly id: RowId;
  readonly label: string;
  readonly kind: 'cycle' | 'toggle' | 'key';
}

const ROWS: readonly Row[] = [
  { id: 'theme', label: 'Theme', kind: 'cycle' },
  { id: 'frame', label: 'Border frame', kind: 'toggle' },
  { id: 'leader', label: 'Leader key', kind: 'cycle' },
  ...KEYMAP_ACTIONS.map((action) => ({
    id: action,
    label: ACTION_LABELS[action],
    kind: 'key' as const,
  })),
  { id: 'panesOrientation', label: 'Split direction', kind: 'cycle' },
  { id: 'panesStart', label: 'Panes on launch', kind: 'cycle' },
  { id: 'historyEnabled', label: 'Record history', kind: 'toggle' },
  { id: 'historySidebar', label: 'Sidebar on launch', kind: 'toggle' },
  { id: 'historyLimit', label: 'Keep sessions', kind: 'cycle' },
  { id: 'historyArgs', label: 'Record claude args', kind: 'toggle' },
];

/** How the two orientations are described to someone who has not split yet. */
const ORIENTATION_LABELS: Readonly<Record<Orientation, string>> = {
  columns: 'columns (side by side)',
  rows: 'rows (stacked)',
};

export interface SettingsState {
  draft: Config;
  index: number;
  /** True while waiting for the user to press the key they want to bind. */
  capturing: boolean;
  message: string | null;
}

export type SettingsOutcome =
  | { kind: 'state'; state: SettingsState }
  | { kind: 'save'; config: Config }
  | { kind: 'close' };

export function createSettingsState(config: Config): SettingsState {
  return {
    draft: {
      ...config,
      keymap: { ...config.keymap },
      history: { ...config.history },
      panes: { ...config.panes },
    },
    index: 0,
    capturing: false,
    message: null,
  };
}

function cycle(values: readonly string[], current: string, delta: number): string {
  const at = values.indexOf(current);
  // An unrecognised current value starts the cycle from the beginning rather
  // than throwing the user back to index -1.
  const base = at === -1 ? 0 : at;
  const next = (((base + delta) % values.length) + values.length) % values.length;
  return values[next] ?? current;
}

function cycleNumber(values: readonly number[], current: number, delta: number): number {
  const at = values.indexOf(current);
  if (at === -1) {
    // A hand-edited limit is not one of the offered values. Step to the nearest
    // one in the direction pressed rather than snapping to the front of the
    // list, which would silently discard a number the user chose deliberately.
    const ascending = [...values].sort((a, b) => a - b);
    const next =
      delta >= 0
        ? ascending.find((value) => value > current)
        : [...ascending].reverse().find((value) => value < current);
    return next ?? current;
  }
  const index = (((at + delta) % values.length) + values.length) % values.length;
  return values[index] ?? current;
}

/** Leader choices, always including whatever is configured now. */
function leaderChoices(current: string): readonly string[] {
  return SAFE_LEADERS.includes(current) ? SAFE_LEADERS : [current, ...SAFE_LEADERS];
}

function move(state: SettingsState, delta: number): SettingsOutcome {
  const next = Math.min(ROWS.length - 1, Math.max(0, state.index + delta));
  return { kind: 'state', state: { ...state, index: next, message: null } };
}

function changeValue(state: SettingsState, delta: number): SettingsState {
  const row = ROWS[state.index];
  if (!row) return state;
  const draft: Config = {
    ...state.draft,
    keymap: { ...state.draft.keymap },
    history: { ...state.draft.history },
    panes: { ...state.draft.panes },
  };

  switch (row.id) {
    case 'panesOrientation':
      draft.panes.orientation = cycle(
        ORIENTATIONS,
        draft.panes.orientation,
        delta,
      ) as Orientation;
      break;
    case 'panesStart':
      // Clamped rather than wrapped: stepping past the last pane back round to
      // one would read as the setting having been reset.
      draft.panes.startCount = Math.min(
        MAX_PANES,
        Math.max(1, draft.panes.startCount + (delta >= 0 ? 1 : -1)),
      );
      break;
    case 'theme':
      draft.theme = cycle(THEME_NAMES, draft.theme, delta);
      break;
    case 'frame':
      draft.frame = !draft.frame;
      break;
    case 'leader':
      draft.leader = cycle(leaderChoices(draft.leader), draft.leader, delta);
      break;
    case 'historyEnabled':
      draft.history.enabled = !draft.history.enabled;
      break;
    case 'historySidebar':
      draft.history.sidebar = !draft.history.sidebar;
      break;
    case 'historyLimit':
      draft.history.limit = cycleNumber(HISTORY_LIMIT_CHOICES, draft.history.limit, delta);
      break;
    case 'historyArgs':
      draft.history.recordArgs = !draft.history.recordArgs;
      break;
    default:
      return { ...state, message: 'Press Enter to rebind this key.' };
  }

  return { ...state, draft, message: null };
}

function bindKey(state: SettingsState, key: string): SettingsState {
  const row = ROWS[state.index];
  if (!row || row.kind !== 'key') return { ...state, capturing: false };

  const action = row.id as KeymapAction;
  const clash = KEYMAP_ACTIONS.find(
    (other) => other !== action && state.draft.keymap[other] === key,
  );

  if (clash) {
    return {
      ...state,
      capturing: false,
      message: `"${key}" is already bound to ${ACTION_LABELS[clash]}.`,
    };
  }

  return {
    ...state,
    draft: { ...state.draft, keymap: { ...state.draft.keymap, [action]: key } },
    capturing: false,
    message: `${ACTION_LABELS[action]} is now "${key}".`,
  };
}

/**
 * Interprets one keystroke.
 *
 * @param defaults Used by the "restore defaults" action, passed in so this file
 *                 does not have to decide what a default is.
 */
export function reduceSettings(
  state: SettingsState,
  data: string,
  defaults: Config,
): SettingsOutcome {
  const key = decodeKey(data);
  if (!key) return { kind: 'state', state };

  if (state.capturing) {
    if (key.type === 'escape') {
      return {
        kind: 'state',
        state: { ...state, capturing: false, message: 'Rebind cancelled.' },
      };
    }
    if (key.type === 'char' && isValidCommandKey(key.value)) {
      return { kind: 'state', state: bindKey(state, key.value) };
    }
    return {
      kind: 'state',
      state: {
        ...state,
        message: 'That key cannot be a command key. Pick a printable character.',
      },
    };
  }

  switch (key.type) {
    case 'escape':
      return { kind: 'close' };
    case 'up':
      return move(state, -1);
    case 'down':
      return move(state, 1);
    case 'left':
      return { kind: 'state', state: changeValue(state, -1) };
    case 'right':
      return { kind: 'state', state: changeValue(state, 1) };
    case 'enter': {
      const row = ROWS[state.index];
      if (row?.kind === 'key') {
        return { kind: 'state', state: { ...state, capturing: true, message: null } };
      }
      return { kind: 'state', state: changeValue(state, 1) };
    }
    case 'char':
      switch (key.value) {
        case 'k':
          return move(state, -1);
        case 'j':
          return move(state, 1);
        case 'h':
          return { kind: 'state', state: changeValue(state, -1) };
        case 'l':
          return { kind: 'state', state: changeValue(state, 1) };
        case 's':
          return { kind: 'save', config: state.draft };
        case 'd':
          return {
            kind: 'state',
            state: {
              ...state,
              draft: {
                ...defaults,
                keymap: { ...defaults.keymap },
                history: { ...defaults.history },
                panes: { ...defaults.panes },
              },
              message: 'Defaults restored — press s to save.',
            },
          };
        default:
          return { kind: 'state', state };
      }
    default:
      return { kind: 'state', state };
  }
}

function valueOf(row: Row, draft: Config): string {
  switch (row.id) {
    case 'theme':
      return THEMES[draft.theme]?.label ?? draft.theme;
    case 'frame':
      return draft.frame ? 'on' : 'off';
    case 'leader':
      return draft.leader;
    case 'panesOrientation':
      return ORIENTATION_LABELS[draft.panes.orientation];
    case 'panesStart':
      return String(draft.panes.startCount);
    case 'historyEnabled':
      return draft.history.enabled ? 'on' : 'off';
    case 'historySidebar':
      return draft.history.sidebar ? 'on' : 'off';
    case 'historyLimit':
      return String(draft.history.limit);
    case 'historyArgs':
      // Spelt out rather than a bare "on": this is the one setting that can put
      // conversation content on disk, and it should say so where it is toggled.
      return draft.history.recordArgs ? 'on — may include prompts' : 'off';
    default:
      return `"${draft.keymap[row.id as KeymapAction]}"`;
  }
}

interface SettingsScreenProps {
  state: SettingsState;
  cols: number;
  rows: number;
  configPath: string;
  problems: readonly string[];
  dirty: boolean;
}

export function SettingsScreen({
  state,
  cols,
  rows,
  configPath,
  problems,
  dirty,
}: SettingsScreenProps): React.ReactElement {
  const theme = useTheme();

  return (
    // Clipped rather than allowed to overflow: the row list is long enough now
    // that a short terminal would otherwise push the status bar off-screen and
    // desync the whole frame.
    <Box flexDirection="column" width={cols} height={rows} paddingX={1} overflow="hidden">
      <Box
        flexDirection="column"
        borderStyle={theme.borderStyle}
        borderColor={theme.border}
        paddingX={1}
      >
        <Text bold color={theme.accent}>
          {`Settings${dirty ? ' •' : ''}`}
        </Text>

        <Box flexDirection="column" marginTop={1}>
          {ROWS.map((row, index) => {
            const selected = index === state.index;
            const capturing = selected && state.capturing;
            return (
              <Box key={row.id}>
                <Text color={selected ? theme.accent : theme.text}>{selected ? '❯ ' : '  '}</Text>
                <Box width={20}>
                  <Text
                    color={selected ? theme.text : theme.secondary}
                    dimColor={!selected && theme.dimSecondary}
                  >
                    {row.label}
                  </Text>
                </Box>
                {capturing ? (
                  <Text color={theme.status.starting}>press a key…</Text>
                ) : (
                  <Text color={selected ? theme.accent : theme.text}>
                    {row.kind === 'key'
                      ? valueOf(row, state.draft)
                      : `‹ ${valueOf(row, state.draft)} ›`}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>

        <Box marginTop={1}>
          <Text color={theme.secondary} dimColor={theme.dimSecondary} wrap="truncate">
            {displayPath(configPath)}
          </Text>
        </Box>

        {problems.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {problems.slice(0, 3).map((problem, index) => (
              <Text key={index} color={theme.status.error} wrap="truncate">
                {`! ${problem}`}
              </Text>
            ))}
          </Box>
        ) : null}

        {state.message ? (
          <Box marginTop={1}>
            <Text color={theme.status.starting} wrap="truncate">
              {state.message}
            </Text>
          </Box>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.secondary} dimColor={theme.dimSecondary} wrap="truncate">
          ↑↓ move · ←→ change · enter rebind · s save · d defaults · esc close
        </Text>
      </Box>
    </Box>
  );
}
