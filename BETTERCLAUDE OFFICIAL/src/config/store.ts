/**
 * Reads and writes the app's settings file.
 *
 * Saving is atomic — write a sibling temp file, then rename over the target.
 * A rename within one directory cannot half-succeed, so an interrupted save
 * leaves the previous settings intact instead of a truncated file that would
 * fail to parse on next launch.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configDir, configFile } from './paths.js';
import { parseConfig, serialiseConfig, type Config, type ParseResult } from './schema.js';
import { debug } from '../util/logger.js';

export interface LoadedConfig extends ParseResult {
  path: string;
  /** False on first run, which is not an error and is not reported as one. */
  existed: boolean;
}

export function loadConfig(): LoadedConfig {
  const target = configFile();

  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      debug('config:absent', { path: target });
      return { ...parseConfig(undefined), path: target, existed: false };
    }
    const parsed = parseConfig(undefined);
    parsed.problems.push(`Could not read ${target}: ${String(error)}`);
    return { ...parsed, path: target, existed: true };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const parsed = parseConfig(undefined);
    parsed.problems.push(
      `${target} is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      }); using defaults.`,
    );
    return { ...parsed, path: target, existed: true };
  }

  const parsed = parseConfig(json);
  debug('config:loaded', { problems: parsed.problems.length });
  return { ...parsed, path: target, existed: true };
}

export interface SaveResult {
  ok: boolean;
  path: string;
  error?: string;
}

export function saveConfig(config: Config, unknown: Record<string, unknown> = {}): SaveResult {
  const target = configFile();
  const directory = configDir();
  const temporary = path.join(directory, `.config.json.${process.pid}.tmp`);

  try {
    // 0o700: these are the user's own preferences and nobody else's business.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, serialiseConfig(config, unknown), { mode: 0o600 });
    renameSync(temporary, target);
    debug('config:saved', { path: target });
    return { ok: true, path: target };
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temp file may not exist; nothing to clean up.
    }
    const message = error instanceof Error ? error.message : String(error);
    debug('config:save-failed', { message });
    return { ok: false, path: target, error: message };
  }
}
