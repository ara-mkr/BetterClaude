/**
 * Draws one wrapped session's screen.
 *
 * Every row is emitted even when blank, so the panel keeps a fixed height and the
 * layout below it never shifts as the child redraws.
 *
 * Memoised because the status bar ticks once a second: without this, the clock
 * would re-reconcile every cell of the pane sixty times a minute for nothing.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Snapshot } from '../types.js';

interface SessionPanelProps {
  frame: Snapshot;
  cols: number;
  rows: number;
}

function SessionPanelView({ frame, cols, rows }: SessionPanelProps): React.ReactElement {
  const lines: React.ReactElement[] = [];

  for (let y = 0; y < rows; y++) {
    const row = frame.rows[y];

    lines.push(
      // truncate rather than wrap: a row that overflows by one column would
      // otherwise push the status bar off-screen and desync the whole frame.
      <Text key={y} wrap="truncate">
        {row && row.length > 0
          ? row.map((run, index) => (
              <Text
                key={index}
                color={run.color}
                backgroundColor={run.backgroundColor}
                bold={run.bold}
                dimColor={run.dimColor}
                italic={run.italic}
                underline={run.underline}
                strikethrough={run.strikethrough}
                inverse={run.inverse}
              >
                {run.text}
              </Text>
            ))
          : ' '}
      </Text>,
    );
  }

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {lines}
    </Box>
  );
}

export const SessionPanel = React.memo(SessionPanelView);
