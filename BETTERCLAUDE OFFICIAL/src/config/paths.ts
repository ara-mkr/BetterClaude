/**
 * Locations this app owns.
 *
 * This is the complete list of paths the program ever reads or writes. It is
 * deliberately one directory that belongs to this app alone: nothing here points
 * at Claude Code's config, credential store, or session data, and no code path
 * elsewhere in the project opens a file outside it.
 */

import os from 'node:os';
import path from 'node:path';

export const APP_DIR_NAME = '.betterclaude-official';

/** Overridable so tests never touch a real user's settings. */
export function configDir(): string {
  const override = process.env['BETTERCLAUDE_CONFIG_DIR'];
  return override ? path.resolve(override) : path.join(os.homedir(), APP_DIR_NAME);
}

export function configFile(): string {
  return path.join(configDir(), 'config.json');
}

/** Session metadata log. Sits beside the config, in the same owned directory. */
export function historyFile(): string {
  return path.join(configDir(), 'history.jsonl');
}

/** Shortens a path for display, so the UI shows `~/.betterclaude-official/…`. */
export function displayPath(target: string): string {
  const home = os.homedir();
  return target === home || target.startsWith(home + path.sep)
    ? `~${target.slice(home.length)}`
    : target;
}
