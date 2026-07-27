/**
 * Themed border around a panel.
 *
 * Opt-in (`--frame`) rather than default: a border costs the child two rows and
 * two columns of real screen, which is a meaningful tax in a coding tool. Ink's
 * Box already subtracts the border from the content area, so the caller sizes
 * this to the outer rectangle and the pane receives the inside.
 */

import React from 'react';
import { Box } from 'ink';
import { useTheme } from '../theme/ThemeContext.js';

interface FrameProps {
  width: number;
  height: number;
  /**
   * Tints the border with the accent colour. Only meaningful with several panes
   * on screen, where it is a second, free signal of which one holds the keyboard
   * — the border is already paid for, so saying this with it costs no columns.
   */
  focused?: boolean;
  children: React.ReactNode;
}

export function Frame({
  width,
  height,
  focused = false,
  children,
}: FrameProps): React.ReactElement {
  const theme = useTheme();

  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      borderStyle={theme.borderStyle}
      borderColor={focused ? theme.accent : theme.border}
    >
      {children}
    </Box>
  );
}
