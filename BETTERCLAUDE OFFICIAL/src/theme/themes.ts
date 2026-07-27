/**
 * Built-in colour schemes for the wrapper's own chrome.
 *
 * These only ever style the app's furniture — borders, status bar, error panels.
 * The session pane is whatever `claude` drew, passed through untouched; a theme
 * that recoloured the child's output would be lying about what it produced.
 */

import type { SessionStatus } from '../types.js';

export type BorderStyle = 'single' | 'double' | 'round' | 'bold' | 'classic';

export interface Theme {
  readonly name: string;
  readonly label: string;
  readonly border: string;
  readonly borderStyle: BorderStyle;
  /** Highlight for the app's own emphasis. */
  readonly accent: string;
  /**
   * Primary chrome text. `undefined` means "inherit the terminal's foreground",
   * which is what keeps the default theme legible on light and dark alike.
   */
  readonly text: string | undefined;
  readonly secondary: string | undefined;
  /** Render secondary text with the dim attribute rather than a literal colour. */
  readonly dimSecondary: boolean;
  readonly status: Readonly<Record<SessionStatus, string>>;
}

/**
 * The default. It deliberately uses palette names rather than hex so the user's
 * own terminal theme still decides what "green" looks like, and so the wrapper
 * does not visually clash with the terminal it is running inside.
 */
const terminal: Theme = {
  name: 'terminal',
  label: 'Terminal (inherits your colours)',
  border: 'gray',
  borderStyle: 'round',
  accent: 'cyan',
  text: undefined,
  secondary: undefined,
  dimSecondary: true,
  status: {
    starting: 'yellow',
    running: 'green',
    exited: 'gray',
    error: 'red',
  },
};

const midnight: Theme = {
  name: 'midnight',
  label: 'Midnight (cool blues)',
  border: '#3b4261',
  borderStyle: 'round',
  accent: '#7aa2f7',
  text: '#c0caf5',
  secondary: '#565f89',
  dimSecondary: false,
  status: {
    starting: '#e0af68',
    running: '#9ece6a',
    exited: '#565f89',
    error: '#f7768e',
  },
};

const ember: Theme = {
  name: 'ember',
  label: 'Ember (warm)',
  border: '#5a3a2e',
  borderStyle: 'bold',
  accent: '#ff9e64',
  text: '#f5e0dc',
  secondary: '#a68a7b',
  dimSecondary: false,
  status: {
    starting: '#f9e2af',
    running: '#a6e3a1',
    exited: '#6c7086',
    error: '#f38ba8',
  },
};

const mono: Theme = {
  name: 'mono',
  label: 'Mono (greyscale)',
  border: '#555555',
  borderStyle: 'single',
  accent: '#ffffff',
  text: '#dddddd',
  secondary: '#888888',
  dimSecondary: false,
  status: {
    starting: '#999999',
    running: '#ffffff',
    exited: '#666666',
    error: '#ffffff',
  },
};

export const THEMES: Readonly<Record<string, Theme>> = { terminal, midnight, ember, mono };

export const DEFAULT_THEME = terminal;

export const THEME_NAMES: readonly string[] = Object.keys(THEMES);

/** Returns the named theme, or undefined so the caller can report valid names. */
export function resolveTheme(name: string | undefined): Theme | undefined {
  if (!name) return DEFAULT_THEME;
  return THEMES[name.toLowerCase()];
}
