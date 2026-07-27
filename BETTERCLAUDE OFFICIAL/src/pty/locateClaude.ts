/**
 * Finds the user's existing `claude` binary.
 *
 * This module looks for an *executable file* and nothing else. It never reads
 * Claude Code's config directory, credential store, or any auth state — the
 * wrapper's only relationship with Claude Code is "spawn the binary the user
 * already installed and logged into".
 */

import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWindows = process.platform === 'win32';

export const DOCS_URL = 'https://docs.claude.com/en/docs/claude-code/overview';

export class ClaudeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeNotFoundError';
  }
}

function isExecutableFile(candidate: string): boolean {
  try {
    // statSync follows symlinks, which matters: `claude` is commonly a symlink
    // into a version-managed install directory.
    if (!statSync(candidate).isFile()) return false;
    if (isWindows) return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories checked after PATH. A GUI-launched terminal sometimes inherits a
 * stripped PATH that omits the usual user-level install locations, and failing
 * there with "not installed" would be actively misleading.
 */
function fallbackDirs(): string[] {
  const home = os.homedir();
  if (isWindows) {
    return [
      path.join(home, 'AppData', 'Local', 'Programs'),
      path.join(home, 'AppData', 'Roaming', 'npm'),
    ];
  }
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
}

function executableNames(): string[] {
  if (!isWindows) return ['claude'];
  const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return exts.map((ext) => `claude${ext.toLowerCase()}`);
}

function searchDirs(dirs: string[], names: string[]): string | undefined {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Resolves the absolute path to the `claude` executable.
 *
 * @param explicit Optional user-supplied path (`--claude-path`), trusted over any
 *                 search result so version-managed installs can be pinned.
 * @throws {ClaudeNotFoundError} when no executable can be found.
 */
export function locateClaude(explicit?: string): string {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (isExecutableFile(resolved)) return resolved;
    throw new ClaudeNotFoundError(
      `No executable found at the path passed to --claude-path:\n  ${resolved}`,
    );
  }

  const names = executableNames();

  const fromPath = searchDirs((process.env['PATH'] ?? '').split(path.delimiter), names);
  if (fromPath) return fromPath;

  const fromFallback = searchDirs(fallbackDirs(), names);
  if (fromFallback) return fromFallback;

  throw new ClaudeNotFoundError(
    [
      'Could not find the `claude` command on your PATH.',
      '',
      'This app is a UI wrapper — it does not include, install, or authenticate',
      'Claude Code. You need the real CLI installed and logged in first:',
      '',
      `  ${DOCS_URL}`,
      '',
      'Once `claude` runs on its own in your terminal, run this app again.',
      'If it is installed somewhere unusual, point at it directly:',
      '',
      '  betterclaude --claude-path /path/to/claude',
    ].join('\n'),
  );
}
