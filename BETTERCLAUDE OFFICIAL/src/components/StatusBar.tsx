/**
 * The one-line footer below the content area.
 *
 * This is wrapper chrome, drawn by us. Outside of the settings and error screens
 * it is the only place the app puts its own pixels on screen — everything above
 * belongs to the child process.
 *
 * Segments are dropped wholesale as the terminal narrows rather than truncated,
 * because a half-printed path or a clipped key hint is worse than no hint.
 */

import React, { useEffect, useState } from 'react';
import os from 'node:os';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/ThemeContext.js';
import type { SessionStatus } from '../types.js';

interface StatusBarProps {
  cols: number;
  cwd: string;
  status: SessionStatus;
  leaderLabel: string;
  quitKey: string;
  settingsKey: string;
  startedAt: Date | null;
  paneCols: number;
  paneRows: number;
  historyKey: string;
  splitKey: string;
  /** Zero-based position of the focused pane, and how many there are. */
  paneIndex: number;
  paneCount: number;
  notice: string | null;
  problemCount: number;
  inSettings: boolean;
  inHistory: boolean;
}

const STATUS_LABEL: Readonly<Record<SessionStatus, string>> = {
  starting: 'starting',
  running: 'claude',
  exited: 'exited',
  error: 'error',
};

/** Terminal widths at which optional segments start to appear. */
const SHOW_HINT_AT = 52;
const SHOW_ELAPSED_AT = 64;
const SHOW_SIZE_AT = 82;
const SHOW_HISTORY_HINT_AT = 96;
const SHOW_SPLIT_HINT_AT = 118;

function shortenPath(cwd: string): string {
  const home = os.homedir();
  return cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function Secondary({ children }: { children: React.ReactNode }): React.ReactElement {
  const theme = useTheme();
  return (
    <Text color={theme.secondary} dimColor={theme.dimSecondary}>
      {children}
    </Text>
  );
}

export function StatusBar({
  cols,
  cwd,
  status,
  leaderLabel,
  quitKey,
  settingsKey,
  startedAt,
  paneCols,
  paneRows,
  historyKey,
  splitKey,
  paneIndex,
  paneCount,
  notice,
  problemCount,
  inSettings,
  inHistory,
}: StatusBarProps): React.ReactElement {
  const theme = useTheme();
  const [now, setNow] = useState(() => Date.now());

  // Only tick while there is something to count. A permanent 1Hz timer would
  // repaint the whole tree forever, including after the session has ended.
  useEffect(() => {
    if (!startedAt || status !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt, status]);

  // Built by mode rather than as one string with conditionals: while a wrapper
  // screen owns the keyboard, advertising the leader chords would be a lie.
  let hint: string;
  if (inSettings) {
    hint = 'esc close · s save';
  } else if (inHistory) {
    hint = '↑↓ browse · esc back to claude';
  } else {
    hint = `${leaderLabel} ${quitKey} quit · ${leaderLabel} ${settingsKey} settings`;
    if (cols >= SHOW_HISTORY_HINT_AT) hint += ` · ${leaderLabel} ${historyKey} history`;
    if (cols >= SHOW_SPLIT_HINT_AT) hint += ` · ${leaderLabel} ${splitKey} split`;
  }

  return (
    // Each half truncates its own text, but nothing stopped their *sum* from
    // exceeding the width — and a status bar one column too long wraps onto a
    // second line, making the frame taller than the terminal and scrolling it on
    // every repaint. The hint keeps its full width; the left side gives way.
    <Box width={cols} height={1} justifyContent="space-between" overflow="hidden">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate">
          <Text color={theme.status[status]}>●</Text>
          <Text color={theme.text} bold>
            {` ${STATUS_LABEL[status]}`}
          </Text>

          {/* Which pane the keyboard is in. Sits in the flexible half so it can
              never be what pushes the bar past `cols`, and is absent entirely
              when there is nothing to disambiguate. */}
          {paneCount > 1 ? (
            <Text color={theme.accent}>{`  ${paneIndex + 1}/${paneCount}`}</Text>
          ) : null}

          {notice ? <Text color={theme.accent}>{`  ${notice}`}</Text> : null}

          {!notice ? <Secondary>{`  ${shortenPath(cwd)}`}</Secondary> : null}
          {!notice && cols >= SHOW_SIZE_AT ? (
            <Secondary>{`  ·  ${paneCols}×${paneRows}`}</Secondary>
          ) : null}
          {!notice && cols >= SHOW_ELAPSED_AT && startedAt ? (
            <Secondary>{`  ·  ${formatElapsed(now - startedAt.getTime())}`}</Secondary>
          ) : null}

          {problemCount > 0 && !notice ? (
            <Text color={theme.status.error}>{`  ! ${problemCount}`}</Text>
          ) : null}
        </Text>
      </Box>

      {cols >= SHOW_HINT_AT ? (
        <Box flexShrink={0} marginLeft={1}>
          <Text wrap="truncate">
            <Secondary>{hint}</Secondary>
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
