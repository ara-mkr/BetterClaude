/**
 * Draws every pane, the rules between them, and the focus marker.
 *
 * All geometry arrives pre-computed from `panes/layout.ts` — this file adds no
 * arithmetic of its own beyond reading the boxes it is handed. That is the point:
 * one module decides how the screen divides, and it is the one with the tests.
 *
 * Every child here is `flexShrink={0}` at an explicit size. Letting flexbox
 * negotiate would reintroduce exactly the failure the layout module exists to
 * prevent — a row one column too wide wraps, the frame grows by a line, and the
 * terminal scrolls on every repaint.
 *
 * With a single pane the gutter and separator are both zero, so this renders the
 * same cells as the old single-pane path and costs the child nothing.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/ThemeContext.js';
import { SessionPanel } from './SessionPanel.js';
import { Frame } from './Frame.js';
import type { Layout, PaneBox } from '../panes/layout.js';
import type { PaneView } from '../panes/types.js';

/** Solid bar beside the pane holding the keyboard. */
const FOCUS_MARK = '▌';
const VERTICAL_RULE = '│';
const HORIZONTAL_RULE = '─';

interface GutterProps {
  rows: number;
  focused: boolean;
  color: string;
}

function GutterView({ rows, focused, color }: GutterProps): React.ReactElement {
  return (
    <Box width={1} height={rows} flexDirection="column" flexShrink={0}>
      {Array.from({ length: rows }, (_, y) => (
        <Text key={y} color={focused ? color : undefined}>
          {focused ? FOCUS_MARK : ' '}
        </Text>
      ))}
    </Box>
  );
}

/** Memoised: the status bar ticks once a second and this never changes with it. */
const Gutter = React.memo(GutterView);

interface RuleProps {
  orientation: Layout['orientation'];
  /** Length of the rule: rows for a vertical one, columns for a horizontal one. */
  extent: number;
  color: string;
}

function RuleView({ orientation, extent, color }: RuleProps): React.ReactElement {
  if (orientation === 'rows') {
    return (
      <Box width={extent} height={1} flexShrink={0}>
        <Text color={color} wrap="truncate">
          {HORIZONTAL_RULE.repeat(Math.max(0, extent))}
        </Text>
      </Box>
    );
  }
  return (
    <Box width={1} height={extent} flexDirection="column" flexShrink={0}>
      {Array.from({ length: extent }, (_, y) => (
        <Text key={y} color={color}>
          {VERTICAL_RULE}
        </Text>
      ))}
    </Box>
  );
}

const Rule = React.memo(RuleView);

/** One line describing how a finished pane finished, and how to dismiss it. */
export function footerFor(view: PaneView, closeHint: string): string {
  if (view.status === 'error') {
    return `✗ ${view.spawnError?.message ?? 'could not start claude'}`;
  }
  const exit = view.exit;
  if (!exit) return `· exited · ${closeHint} close`;
  if (exit.signal) return `✗ killed (signal ${exit.signal}) · ${closeHint} close`;
  return exit.exitCode === 0
    ? `✓ exited · ${closeHint} close`
    : `✗ exited (code ${exit.exitCode}) · ${closeHint} close`;
}

interface PaneBodyProps {
  view: PaneView;
  box: PaneBox;
  closeHint: string;
}

/**
 * The inside of one pane.
 *
 * A finished pane keeps its final frame — the transcript is still worth reading
 * — and gives up its *last* row to the footer rather than gaining one. Growing
 * here would push the status bar off screen.
 */
function PaneBody({ view, box, closeHint }: PaneBodyProps): React.ReactElement {
  const theme = useTheme();
  const finished = view.status === 'exited' || view.status === 'error';

  if (!finished) return <SessionPanel frame={view.frame} cols={box.cols} rows={box.rows} />;

  const failed =
    view.status === 'error' || (view.exit?.exitCode ?? 0) !== 0 || Boolean(view.exit?.signal);

  return (
    <Box flexDirection="column" width={box.cols} height={box.rows}>
      <SessionPanel frame={view.frame} cols={box.cols} rows={Math.max(0, box.rows - 1)} />
      <Box width={box.cols} height={1} flexShrink={0}>
        <Text color={failed ? theme.status.error : theme.status.exited} wrap="truncate">
          {footerFor(view, closeHint)}
        </Text>
      </Box>
    </Box>
  );
}

interface PaneGridProps {
  views: readonly PaneView[];
  layout: Layout;
  focusIndex: number;
  framed: boolean;
  /** Rendered into a finished pane's footer, e.g. "ctrl+g x". */
  closeHint: string;
  cols: number;
  rows: number;
}

export function PaneGrid({
  views,
  layout,
  focusIndex,
  framed,
  closeHint,
  cols,
  rows,
}: PaneGridProps): React.ReactElement {
  const theme = useTheme();
  const vertical = layout.orientation === 'rows';

  return (
    <Box
      flexDirection={vertical ? 'column' : 'row'}
      width={cols}
      height={rows}
      flexShrink={0}
      overflow="hidden"
    >
      {views.map((view, index) => {
        const box = layout.panes[index];
        if (!box || box.outerCols <= 0 || box.outerRows <= 0) return null;

        const focused = index === focusIndex;
        const body = <PaneBody view={view} box={box} closeHint={closeHint} />;

        return (
          <React.Fragment key={view.id}>
            {index > 0 && layout.separator > 0 ? (
              <Rule
                orientation={layout.orientation}
                extent={vertical ? cols : rows}
                color={theme.border}
              />
            ) : null}

            <Box
              width={box.outerCols}
              height={box.outerRows}
              flexDirection="row"
              flexShrink={0}
              overflow="hidden"
            >
              {layout.gutter > 0 ? (
                <Gutter rows={box.outerRows} focused={focused} color={theme.accent} />
              ) : null}
              {framed ? (
                <Frame width={box.cols + 2} height={box.rows + 2} focused={focused}>
                  {body}
                </Frame>
              ) : (
                body
              )}
            </Box>
          </React.Fragment>
        );
      })}
    </Box>
  );
}
