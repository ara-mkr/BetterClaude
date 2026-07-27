/**
 * Converts a virtual terminal screen into Ink-renderable styled rows.
 *
 * `claude` is itself a full-screen TUI: its output is not an append-only log but
 * a stream of cursor moves and in-place rewrites. Appending those bytes to a text
 * buffer produces garbage. So the PTY stream is fed to a real (headless) terminal
 * emulator, and this module reads the resulting cell grid back out as styled text.
 *
 * Adjacent cells sharing a style are collapsed into one run, which matters: a
 * naive cell-per-element render would create ~10k React elements per frame.
 */

import type { IBufferCell, IBufferLine, Terminal } from '@xterm/headless';
import type { CellStyle, Snapshot, StyledRow, StyledRun } from '../types.js';

/**
 * Palette entries 0-15 are deliberately mapped to chalk *names* rather than hex.
 * Those sixteen slots are defined by the user's own terminal theme, so emitting
 * names lets their theme apply. Converting to hex would override it and make the
 * wrapped session look wrong in every terminal but ours.
 */
const ANSI_16 = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
] as const;

function hexFromInt(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Maps an xterm-256 palette index to something Ink understands. */
function paletteColor(index: number): string {
  if (index < 16) return ANSI_16[index] ?? 'white';

  if (index < 232) {
    // 6x6x6 colour cube. Levels are not linear: 0, 95, 135, 175, 215, 255.
    const offset = index - 16;
    const level = (c: number): number => (c === 0 ? 0 : 55 + c * 40);
    const r = level(Math.floor(offset / 36));
    const g = level(Math.floor((offset % 36) / 6));
    const b = level(offset % 6);
    return hexFromInt((r << 16) | (g << 8) | b);
  }

  // 24-step greyscale ramp.
  const v = Math.min(255, (index - 232) * 10 + 8);
  return hexFromInt((v << 16) | (v << 8) | v);
}

function styleOf(cell: IBufferCell): CellStyle {
  const style: CellStyle = {};

  if (cell.isFgRGB()) style.color = hexFromInt(cell.getFgColor());
  else if (cell.isFgPalette()) style.color = paletteColor(cell.getFgColor());

  if (cell.isBgRGB()) style.backgroundColor = hexFromInt(cell.getBgColor());
  else if (cell.isBgPalette()) style.backgroundColor = paletteColor(cell.getBgColor());

  // These return 0/non-zero rather than booleans.
  if (cell.isBold()) style.bold = true;
  if (cell.isDim()) style.dimColor = true;
  if (cell.isItalic()) style.italic = true;
  if (cell.isUnderline()) style.underline = true;
  if (cell.isStrikethrough()) style.strikethrough = true;
  if (cell.isInverse()) style.inverse = true;

  return style;
}

function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return (
    a.color === b.color &&
    a.backgroundColor === b.backgroundColor &&
    !!a.bold === !!b.bold &&
    !!a.dimColor === !!b.dimColor &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strikethrough === !!b.strikethrough &&
    !!a.inverse === !!b.inverse
  );
}

interface ScratchCell {
  text: string;
  style: CellStyle;
  blank: boolean;
}

/**
 * @param cursorX Column holding the cursor on this row, or -1 if the cursor is
 *                elsewhere. The cursor cell is drawn inverted — see snapshot().
 */
function serializeLine(
  line: IBufferLine,
  cols: number,
  cursorX: number,
  scratch: IBufferCell,
): StyledRow {
  const cells: ScratchCell[] = [];
  let lastNonBlank = -1;
  let cursorIndex = -1;

  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x, scratch);
    if (!cell) break;

    const width = cell.getWidth();

    if (x === cursorX) {
      // A cursor sitting on the right half of a double-width glyph belongs to
      // that glyph, which we already emitted.
      cursorIndex = width === 0 ? Math.max(0, cells.length - 1) : cells.length;
    }

    // Width 0 is the continuation half of a double-width glyph: the preceding
    // cell already carries the character and occupies both columns visually.
    if (width === 0) continue;

    const style = styleOf(cell);
    let text = cell.getChars();
    if (text === '' || cell.isInvisible()) text = ' '.repeat(Math.max(1, width));

    // A cell only counts as blank if erasing it would be invisible. A space with
    // a background colour or an underline is very much not blank.
    const blank =
      text.trim() === '' &&
      !style.backgroundColor &&
      !style.inverse &&
      !style.underline &&
      !style.strikethrough;

    if (!blank) lastNonBlank = cells.length;
    cells.push({ text, style, blank });
  }

  // Trailing blanks are dropped to keep frames small, but never past the cursor.
  const keep = Math.max(lastNonBlank + 1, cursorIndex >= 0 ? cursorIndex + 1 : 0);

  const runs: StyledRun[] = [];
  for (let i = 0; i < keep; i++) {
    const cell = cells[i];
    if (!cell) continue;

    const style =
      i === cursorIndex ? { ...cell.style, inverse: !cell.style.inverse } : cell.style;

    const previous = runs[runs.length - 1];
    if (previous && sameStyle(previous, style)) previous.text += cell.text;
    else runs.push({ ...style, text: cell.text });
  }

  return runs;
}

/**
 * Reads the current visible screen out of the emulator.
 *
 * The cursor is drawn as an inverted cell rather than by moving the real terminal
 * cursor. Ink owns the physical cursor position (it parks it after the last line
 * it drew), so a synthetic block is the only way to show the child's cursor where
 * the child actually believes it is.
 */
export function snapshot(term: Terminal, cursorVisible: boolean): Snapshot {
  const buffer = term.buffer.active;
  const scratch = buffer.getNullCell();

  // cursorY is viewport-relative to the bottom page; translate to the row we draw.
  const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
  const cursorOnScreen = cursorVisible && cursorRow >= 0 && cursorRow < term.rows;

  const rows: StyledRow[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const cursorX = cursorOnScreen && y === cursorRow ? buffer.cursorX : -1;
    rows.push(line ? serializeLine(line, term.cols, cursorX, scratch) : []);
  }

  return {
    rows,
    cursor: { x: buffer.cursorX, y: cursorRow, visible: cursorOnScreen },
  };
}
