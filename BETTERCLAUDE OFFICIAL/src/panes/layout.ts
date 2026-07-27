/**
 * How N panes divide the content area.
 *
 * This module is pure arithmetic on purpose. Splitting the screen multiplies the
 * number of things competing for the same rows and columns, and the failure mode
 * is nasty: if the parts sum to one more than the whole, Ink wraps the row, the
 * frame grows by a line, and the terminal scrolls on every single repaint. It
 * presents as an intermittent flicker rather than an obvious layout bug.
 *
 * So the allocation lives in one function with one invariant, stated here and
 * asserted in the tests for every size the app can reach:
 *
 *   columns: sum(outerCols) + separator * (count - 1) === cols
 *   rows:    sum(outerRows) + separator * (count - 1) === rows
 *
 * Nothing rounds up. Integer division leaves a remainder, and the remainder is
 * handed out one column at a time to the leading panes, so the total is exact
 * rather than approximately right.
 */

export type Orientation = 'columns' | 'rows';

export const ORIENTATIONS: readonly Orientation[] = ['columns', 'rows'];

/**
 * Ceiling on panes. Not a taste judgement: `claude` needs width to lay itself
 * out, so a fifth pane is unusable on any terminal that exists.
 */
export const MAX_PANES = 4;

/**
 * Floors that a *split* must respect. They are not floors on running: a terminal
 * too small for these still gets one pane, because refusing to start at all
 * would be worse than a cramped session the user can resize.
 */
export const MIN_PANE_COLS = 50;
export const MIN_PANE_ROWS = 12;

export interface LayoutInput {
  /** Content-area width already available to panes, i.e. after the sidebar. */
  cols: number;
  /** Content-area height, i.e. after the status bar and Ink's trailing newline. */
  rows: number;
  count: number;
  orientation: Orientation;
  framed: boolean;
}

export interface PaneBox {
  /** Total the pane occupies in the grid, focus gutter and border included. */
  readonly outerCols: number;
  readonly outerRows: number;
  /**
   * The inside: what SessionPanel draws and what the PTY is told it has. May be
   * 0 on a terminal too small to give this pane anything, which renders as
   * nothing — the PTY layer clamps to 1 on its own.
   */
  readonly cols: number;
  readonly rows: number;
}

export interface Layout {
  readonly orientation: Orientation;
  /** Columns taken by the focus marker on each pane. 0 when there is one pane. */
  readonly gutter: number;
  /** Size of the rule between adjacent panes. 0 when there is one pane. */
  readonly separator: number;
  readonly panes: readonly PaneBox[];
}

/**
 * Splits `total` into `count` whole parts that sum back to `total` exactly.
 *
 * The remainder goes to the leading panes rather than the trailing ones so that
 * pane 1 is the widest — it is the one that exists in every layout, so keeping
 * it stable makes splitting feel less like the screen jumped.
 */
export function distribute(total: number, count: number): number[] {
  const parts = Math.max(1, Math.floor(count));
  const amount = Math.max(0, Math.floor(total));
  const base = Math.floor(amount / parts);
  const extra = amount % parts;
  return Array.from({ length: parts }, (_, index) => base + (index < extra ? 1 : 0));
}

export function computeLayout(input: LayoutInput): Layout {
  const count = Math.max(1, Math.min(MAX_PANES, Math.floor(input.count)));
  const cols = Math.max(0, Math.floor(input.cols));
  const rows = Math.max(0, Math.floor(input.rows));

  // Both are per-pane chrome that only exists once there is something to tell
  // apart. A single pane pays nothing for the multi-pane machinery.
  const gutter = count > 1 ? 1 : 0;
  const border = input.framed ? 2 : 0;

  // The rules are the one piece of chrome that eats the shared axis, so they are
  // the one piece that can overflow it. On a terminal with fewer columns than it
  // has panes, drawing n-1 of them would push the total past the width no matter
  // how the panes divide what is left — so below that threshold they are dropped
  // entirely and the panes get the space. Chrome is what yields, never the sum.
  const axis = input.orientation === 'rows' ? rows : cols;
  const separator = count > 1 && (count - 1) + count <= axis ? 1 : 0;

  const rules = separator * (count - 1);

  if (input.orientation === 'rows') {
    const shares = distribute(Math.max(0, rows - rules), count);
    return {
      orientation: 'rows',
      gutter,
      separator,
      panes: shares.map((outerRows) => ({
        outerCols: cols,
        outerRows,
        cols: Math.max(0, cols - gutter - border),
        rows: Math.max(0, outerRows - border),
      })),
    };
  }

  const shares = distribute(Math.max(0, cols - rules), count);
  return {
    orientation: 'columns',
    gutter,
    separator,
    panes: shares.map((outerCols) => ({
      outerCols,
      outerRows: rows,
      cols: Math.max(0, outerCols - gutter - border),
      rows: Math.max(0, rows - border),
    })),
  };
}

/**
 * Whether a layout leaves every pane usable.
 *
 * Only the dimension the split actually divides is checked. A short, wide
 * terminal has too few rows for comfort whether or not you split it into
 * columns, and refusing the split on that basis would be blaming the split for
 * something it did not cause.
 */
export function layoutFits(layout: Layout): boolean {
  if (layout.panes.length <= 1) return true;
  return layout.orientation === 'columns'
    ? layout.panes.every((pane) => pane.cols >= MIN_PANE_COLS)
    : layout.panes.every((pane) => pane.rows >= MIN_PANE_ROWS);
}

/**
 * The most panes this terminal can hold in this orientation.
 *
 * Always at least 1, so there is no size at which the app has nothing to draw.
 */
export function capacityFor(input: Omit<LayoutInput, 'count'>): number {
  let capacity = 1;
  for (let count = 2; count <= MAX_PANES; count++) {
    if (!layoutFits(computeLayout({ ...input, count }))) break;
    capacity = count;
  }
  return capacity;
}

/** Why a split is being refused, or undefined when it can go ahead. */
export function splitRefusal(
  input: Omit<LayoutInput, 'count'>,
  currentCount: number,
): string | undefined {
  if (currentCount >= MAX_PANES) return `At most ${MAX_PANES} panes.`;
  if (layoutFits(computeLayout({ ...input, count: currentCount + 1 }))) return undefined;
  return input.orientation === 'columns'
    ? `Terminal too narrow to split — each pane needs ${MIN_PANE_COLS} columns.`
    : `Terminal too short to split — each pane needs ${MIN_PANE_ROWS} rows.`;
}
