/**
 * Shown when the wrapper is running but the session could not be started.
 *
 * Failures that happen before Ink mounts (no `claude` on PATH, not a TTY) print
 * plainly to stderr instead — see index.tsx. This screen is for the case where we
 * already own the alternate screen buffer and a bare console.error would be lost.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/ThemeContext.js';

interface ErrorScreenProps {
  title: string;
  message: string;
  detail?: string | undefined;
  hint?: string | undefined;
  cols: number;
}

export function ErrorScreen({
  title,
  message,
  detail,
  hint,
  cols,
}: ErrorScreenProps): React.ReactElement {
  const theme = useTheme();

  return (
    <Box flexDirection="column" width={cols} paddingX={1} paddingY={1}>
      <Box
        borderStyle={theme.borderStyle}
        borderColor={theme.status.error}
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color={theme.status.error}>
          {title}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.text}>{message}</Text>
        </Box>
        {detail ? (
          <Box marginTop={1}>
            <Text color={theme.secondary} dimColor={theme.dimSecondary}>
              {detail}
            </Text>
          </Box>
        ) : null}
        {hint ? (
          <Box marginTop={1}>
            <Text color={theme.accent}>{hint}</Text>
          </Box>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.secondary} dimColor={theme.dimSecondary}>
          Press any key to exit.
        </Text>
      </Box>
    </Box>
  );
}
