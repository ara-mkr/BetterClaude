/**
 * Key names, the bytes they correspond to, and which ones are safe to steal.
 *
 * The wrapper reserves exactly one key — the leader — and forwards everything
 * else to `claude` untouched. Choosing that key badly would break the session in
 * ways that look like a bug in `claude`, so unsafe choices are rejected outright
 * rather than merely discouraged.
 */

/** Control bytes that terminals and shells rely on. Never usable as a leader. */
const UNSAFE_LEADERS: Readonly<Record<string, string>> = {
  'ctrl+c': 'interrupts the running command',
  'ctrl+d': 'signals end-of-input',
  'ctrl+z': 'suspends the process',
  'ctrl+m': 'is Enter',
  'ctrl+j': 'is a newline',
  'ctrl+i': 'is Tab',
  'ctrl+h': 'is Backspace',
  'ctrl+[': 'is Escape',
  'ctrl+q': 'is terminal flow control (XON)',
  'ctrl+s': 'is terminal flow control (XOFF)',
  'ctrl+\\': 'quits the foreground process',
};

/**
 * Offered in the settings picker. Every entry is a control byte that neither the
 * terminal driver nor a typical line editor treats specially.
 */
export const SAFE_LEADERS: readonly string[] = [
  'ctrl+g',
  'ctrl+t',
  'ctrl+x',
  'ctrl+b',
  'ctrl+]',
  'ctrl+^',
  'ctrl+_',
];

/** Returns why `name` must not be a leader, or undefined when it is fine. */
export function unsafeLeaderReason(name: string): string | undefined {
  return UNSAFE_LEADERS[name.toLowerCase()];
}

/**
 * Turns a key name such as `ctrl+g` into the single byte a terminal sends.
 *
 * Control bytes are the low five bits of the character, which is why this works
 * uniformly for letters and for the punctuation keys `[ \ ] ^ _`.
 */
export function encodeKeyName(name: string): string | undefined {
  const normalised = name.trim().toLowerCase();
  if (normalised === 'esc' || normalised === 'escape') return '\x1b';

  const match = /^ctrl\+(.)$/.exec(normalised);
  if (!match) return undefined;

  const char = match[1];
  if (!char) return undefined;

  const code = char.charCodeAt(0) & 0x1f;
  if (code < 1 || code > 31) return undefined;
  return String.fromCharCode(code);
}

/** Inverse of encodeKeyName, for showing a stored byte back to the user. */
export function decodeKeyByte(byte: string): string {
  const code = byte.charCodeAt(0);
  if (code === 27) return 'esc';
  if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
  if (code >= 28 && code <= 31) return `ctrl+${String.fromCharCode(code + 64)}`;
  return byte;
}

/**
 * A command key is the single character typed after the leader. It must be
 * printable so it can be shown in a hint and typed on any keyboard.
 */
export function isValidCommandKey(key: string): boolean {
  return key.length === 1 && key >= ' ' && key <= '~';
}

export type LogicalKey =
  | { readonly type: 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'tab' }
  | { readonly type: 'char'; readonly value: string };

/**
 * Decodes a keystroke for the app's own screens.
 *
 * Only used while a wrapper screen has focus. During a normal session nothing is
 * decoded at all — bytes go straight to the child.
 */
export function decodeKey(data: string): LogicalKey | undefined {
  switch (data) {
    case '\x1b[A':
    case '\x1bOA':
      return { type: 'up' };
    case '\x1b[B':
    case '\x1bOB':
      return { type: 'down' };
    case '\x1b[C':
    case '\x1bOC':
      return { type: 'right' };
    case '\x1b[D':
    case '\x1bOD':
      return { type: 'left' };
    case '\r':
    case '\n':
      return { type: 'enter' };
    case '\x1b':
      return { type: 'escape' };
    case '\t':
      return { type: 'tab' };
    default:
      return isValidCommandKey(data) ? { type: 'char', value: data } : undefined;
  }
}
