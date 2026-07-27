/**
 * The session history sidebar.
 *
 * Two states, and the difference matters for where keystrokes go:
 *
 *  - *visible* — the panel is drawn, but every key still reaches `claude`. This
 *    is the state you leave it in while working, so it can never eat a keystroke.
 *  - *focused* — the panel takes arrow keys for browsing. Entered on purpose,
 *    left with Esc, and the panel stays visible afterwards.
 *
 * Key handling lives in a pure reducer here rather than in App, matching how the
 * settings screen works: App keeps one decision — which surface owns the bytes —
 * and each surface decides what its own keys mean.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/ThemeContext.js';
import { decodeKey } from '../input/keymap.js';
import {
  durationMs,
  outcomeOf,
  type SessionOutcome,
  type SessionRecord,
} from '../sessionHistory/types.js';

/**
 * Below this the sidebar is not offered at all. Splitting an 80-column terminal
 * leaves `claude` too narrow to lay itself out, and a broken child pane is a far
 * worse outcome than a missing panel.
 */
export const MIN_COLS_FOR_SIDEBAR = 72;
const SIDEBAR_MIN_WIDTH = 18;
const SIDEBAR_MAX_WIDTH = 28;

/** Columns the sidebar should occupy, or 0 when the terminal is too narrow. */
export function sidebarWidth(cols: number): number {
  if (cols < MIN_COLS_FOR_SIDEBAR) return 0;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.floor(cols * 0.26)));
}

export type HistoryOutcome =
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'close' };

/**
 * Interprets one keystroke while the sidebar has focus.
 *
 * Movement is clamped rather than wrapped: arriving back at the newest session
 * after holding ↓ would look like a redraw glitch.
 */
export function reduceHistory(data: string, index: number, total: number): HistoryOutcome {
  const key = decodeKey(data);
  if (!key) return { kind: 'index', index };

  const last = Math.max(0, total - 1);
  const clamp = (value: number): HistoryOutcome => ({
    kind: 'index',
    index: Math.min(last, Math.max(0, value)),
  });

  switch (key.type) {
    case 'escape':
      return { kind: 'close' };
    case 'up':
      return clamp(index - 1);
    case 'down':
      return clamp(index + 1);
    case 'char':
      switch (key.value) {
        case 'k':
          return clamp(index - 1);
        case 'j':
          return clamp(index + 1);
        case 'g':
          return clamp(0);
        case 'G':
          return clamp(last);
        case 'q':
          return { kind: 'close' };
        default:
          return { kind: 'index', index };
      }
    default:
      return { kind: 'index', index };
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Age of a session, in the few characters the right-hand column allows. */
export function formatAge(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';

  const elapsed = now - at;
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;

  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  return `${hours}h${String(minutes).padStart(2, '0')}`;
}

/**
 * Which slice of the list to draw so `index` is on screen.
 *
 * Scrolls only when the selection would leave the window, so browsing a short
 * list never shifts rows around underneath the user.
 */
export function windowFor(
  total: number,
  height: number,
  index: number,
): { start: number; end: number } {
  const size = Math.max(1, height);
  if (total <= size) return { start: 0, end: total };

  const half = Math.floor(size / 2);
  const start = Math.min(Math.max(0, index - half), total - size);
  return { start, end: start + size };
}

const OUTCOME_GLYPH: Readonly<Record<SessionOutcome, string>> = {
  running: '●',
  ok: '✓',
  failed: '✗',
  interrupted: '·',
};

interface SidebarProps {
  sessions: readonly SessionRecord[];
  /** Records this process has open right now — one per running pane. */
  activeIds: ReadonlySet<string>;
  selectedIndex: number;
  focused: boolean;
  width: number;
  rows: number;
  /** Passed in so every row ages against one instant, and tests can pin it. */
  now: number;
}

function SidebarView({
  sessions,
  activeIds,
  selectedIndex,
  focused,
  width,
  rows,
  now,
}: SidebarProps): React.ReactElement {
  const theme = useTheme();

  // Two columns are spoken for: the right-hand rule that separates us from the
  // child, and the gap before it. Sizing rows any wider makes each one overflow
  // and wrap, which grows the panel past its height and scrolls the terminal.
  const inner = Math.max(1, width - 2);
  const listHeight = Math.max(1, rows - 1);
  const { start, end } = windowFor(sessions.length, listHeight, selectedIndex);
  const visible = sessions.slice(start, end);

  const title = focused
    ? `history ${sessions.length === 0 ? 0 : selectedIndex + 1}/${sessions.length}`
    : `history ${sessions.length}`;

  const outcomeColour: Readonly<Record<SessionOutcome, string | undefined>> = {
    running: theme.status.running,
    ok: theme.status.exited,
    failed: theme.status.error,
    interrupted: theme.secondary,
  };

  return (
    <Box
      width={width}
      height={rows}
      flexDirection="column"
      borderStyle={theme.borderStyle}
      borderColor={theme.border}
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      paddingRight={1}
      flexShrink={0}
      // Belt and braces after the width bug above: even if a row ever exceeds
      // its line, the panel cannot grow and scroll the terminal.
      overflow="hidden"
    >
      <Box width={inner}>
        <Text color={focused ? theme.accent : theme.secondary} dimColor={!focused && theme.dimSecondary} wrap="truncate">
          {title}
        </Text>
      </Box>

      {sessions.length === 0 ? (
        <Box width={inner}>
          <Text color={theme.secondary} dimColor={theme.dimSecondary} wrap="truncate">
            no sessions yet
          </Text>
        </Box>
      ) : (
        visible.map((record, offset) => {
          const index = start + offset;
          const selected = focused && index === selectedIndex;
          const outcome = outcomeOf(record, activeIds);
          const elapsed = durationMs(record);

          // A finished session is described by how long it ran; a live or
          // interrupted one by how long ago it began, since it has no duration.
          const right =
            outcome === 'ok' || outcome === 'failed'
              ? elapsed === null
                ? formatAge(record.startedAt, now)
                : formatDuration(elapsed)
              : formatAge(record.startedAt, now);

          return (
            <Box key={record.id} width={inner}>
              <Text color={selected ? theme.accent : theme.border}>{selected ? '❯' : ' '}</Text>
              <Text color={outcomeColour[outcome]}>{`${OUTCOME_GLYPH[outcome]} `}</Text>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text
                  color={selected ? theme.text : theme.secondary}
                  dimColor={!selected && theme.dimSecondary}
                  bold={outcome === 'running'}
                  wrap="truncate"
                >
                  {record.label}
                </Text>
              </Box>
              <Text color={theme.secondary} dimColor={theme.dimSecondary}>
                {` ${right}`}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

/**
 * Memoised for the same reason as SessionPanel: the status bar re-renders once a
 * second, and the sidebar's contents change only when a session starts or ends.
 */
export const Sidebar = React.memo(SidebarView);
