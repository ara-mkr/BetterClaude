#!/usr/bin/env node
/**
 * Entry point: parse arguments, load settings, find the user's `claude`, hand
 * off to Ink.
 *
 * Everything auth-related is out of scope by design. This program does not log
 * in, does not read credentials, and does not talk to any API. It runs the CLI
 * the user already installed and authenticated, and draws a UI around it.
 */

import React from 'react';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink';
import { Command } from 'commander';
import { App } from './App.js';
import { ClaudeNotFoundError, locateClaude } from './pty/locateClaude.js';
import { THEMES, THEME_NAMES } from './theme/themes.js';
import { loadConfig } from './config/store.js';
import { displayPath } from './config/paths.js';
import { validateLeader, type Config } from './config/schema.js';
import { MAX_PANES } from './panes/layout.js';
import { endAllPending } from './sessionHistory/store.js';
import type { ExitInfo } from './types.js';

const VERSION = '0.1.0';

const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_SHOW = '\x1b[?25h';

interface CliOptions {
  cwd: string;
  claudePath?: string;
  altScreen: boolean;
  theme?: string;
  frame?: boolean;
  history?: boolean;
  panes?: string;
  listThemes?: boolean;
  printConfig?: boolean;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

interface ParsedArgs {
  options: CliOptions;
  claudeArgs: string[];
  /** True only when the user actually typed the flag, not when it defaulted. */
  fromCli: (name: string) => boolean;
}

function parseArgs(): ParsedArgs {
  // Split on `--` by hand so claude's own flags are never interpreted as ours.
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const ownArgv = separator === -1 ? argv : argv.slice(0, separator);
  const claudeArgs = separator === -1 ? [] : argv.slice(separator + 1);

  const program = new Command();
  program
    .name('betterclaude')
    .description(
      [
        'A terminal UI around your existing Claude Code CLI.',
        'Requires `claude` to be installed and logged in separately.',
        'Not affiliated with or endorsed by Anthropic.',
      ].join('\n'),
    )
    .version(VERSION, '-v, --version')
    .option('-C, --cwd <dir>', 'working directory for the session', process.cwd())
    .option('--claude-path <path>', 'explicit path to the claude executable')
    .option('-t, --theme <name>', `chrome colour scheme (${THEME_NAMES.join(', ')})`)
    .option('--frame', 'draw a border around the session pane')
    .option('--no-frame', 'do not draw a border around the session pane')
    .option('--no-history', 'do not record this session in the history log')
    .option('--panes <n>', `panes to open at launch (1-${MAX_PANES})`)
    .option('--list-themes', 'print the available themes and exit')
    .option('--print-config', 'print the resolved settings and exit')
    .option('--no-alt-screen', 'render inline instead of on the alternate screen')
    .addHelpText(
      'after',
      [
        '',
        'Anything after `--` is forwarded to claude verbatim:',
        '  betterclaude -- --help',
        '',
        'Each pane is an independent claude session. Split with the leader key',
        'and `s`, close a pane with `x`, move between them with `o` or a digit.',
        '',
        'Settings persist in ~/.betterclaude-official/config.json (override the',
        'directory with BETTERCLAUDE_CONFIG_DIR). Flags win over the file for the',
        'current run; the settings screen saves to it.',
        '',
        'Session history (working directory, times, exit status — never',
        'conversation content) is kept in ~/.betterclaude-official/history.jsonl.',
        'Use --no-history for a single unrecorded run, or turn it off for good in',
        'the settings screen.',
      ].join('\n'),
    );

  program.parse(ownArgv, { from: 'user' });

  return {
    options: program.opts<CliOptions>(),
    claudeArgs,
    // Source is checked rather than the value, so a flag's default never
    // silently overrides what the user saved in their config file.
    fromCli: (name: string) => program.getOptionValueSource(name) === 'cli',
  };
}

function resolveClaudeBinary(explicit?: string): string {
  try {
    return locateClaude(explicit);
  } catch (error) {
    if (error instanceof ClaudeNotFoundError) fail(`\n${error.message}\n`);
    throw error;
  }
}

const { options, claudeArgs, fromCli } = parseArgs();

if (options.listThemes) {
  for (const name of THEME_NAMES) {
    const entry = THEMES[name];
    if (entry) process.stdout.write(`${name.padEnd(10)} ${entry.label}\n`);
  }
  process.exit(0);
}

// Precedence: defaults < config file < command-line flags.
const loaded = loadConfig();

if (fromCli('theme')) {
  const requested = (options.theme ?? '').toLowerCase();
  if (!THEME_NAMES.includes(requested)) {
    fail(`Unknown theme "${options.theme}". Available: ${THEME_NAMES.join(', ')}`);
  }
}

// Rejected outright rather than clamped, unlike the same field in the config
// file. A typo on the command line is a mistake made seconds ago and worth
// pointing at; a stale value in a file is worth carrying on from.
let startCount = loaded.config.panes.startCount;
if (fromCli('panes')) {
  const requested = Number(options.panes);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_PANES) {
    fail(`--panes must be a whole number between 1 and ${MAX_PANES}.`);
  }
  startCount = requested;
}

const initialConfig: Config = {
  ...loaded.config,
  ...(fromCli('theme') ? { theme: (options.theme ?? '').toLowerCase() } : {}),
  ...(fromCli('frame') ? { frame: options.frame === true } : {}),
  ...(fromCli('history')
    ? { history: { ...loaded.config.history, enabled: options.history === true } }
    : {}),
  panes: { ...loaded.config.panes, startCount },
};

// A leader that survived parsing is already safe; this guards the case where the
// file was hand-edited to something that cannot be encoded at all.
const leaderProblem = validateLeader(initialConfig.leader);
if (leaderProblem) {
  loaded.problems.push(`${leaderProblem} Using "ctrl+g".`);
  initialConfig.leader = 'ctrl+g';
}

if (options.printConfig) {
  process.stdout.write(`${JSON.stringify(initialConfig, null, 2)}\n`);
  process.stdout.write(
    `\nsource: ${displayPath(loaded.path)}${loaded.existed ? '' : ' (not created yet)'}\n`,
  );
  for (const problem of loaded.problems) process.stdout.write(`problem: ${problem}\n`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  fail('betterclaude needs an interactive terminal: stdin and stdout must both be a TTY.');
}

const cwd = path.resolve(options.cwd);
if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
  fail(`Not a directory: ${cwd}`);
}

const binaryPath = resolveClaudeBinary(options.claudePath);

let terminalRestored = false;
function restoreTerminal(): void {
  if (terminalRestored) return;
  terminalRestored = true;
  process.stdout.write(CURSOR_SHOW + (options.altScreen ? ALT_SCREEN_OFF : ''));
}

process.on('exit', () => {
  restoreTerminal();
  // Last chance to close an open history record. React's cleanup normally gets
  // there first; this covers the paths that bypass it, such as a signal.
  endAllPending();
});

// SIGINT is deliberately absent: raw mode turns Ctrl+C into a plain byte that we
// forward, so it interrupts claude rather than killing the wrapper out from under it.
for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    restoreTerminal();
    process.exit(1);
  });
}

process.on('uncaughtException', (error: unknown) => {
  restoreTerminal();
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`betterclaude crashed: ${detail}\n`);
  process.exit(1);
});

if (options.altScreen) process.stdout.write(ALT_SCREEN_ON);

// Boxed so TypeScript sees the assignment from the callback below. With several
// panes this is called once per pane, and the box folds them into the one code
// this process can return.
const exitState: { info: ExitInfo | null } = { info: null };

const instance = render(
  <App
    binaryPath={binaryPath}
    claudeArgs={claudeArgs}
    cwd={cwd}
    initialConfig={initialConfig}
    configPath={loaded.path}
    initialProblems={loaded.problems}
    configUnknown={loaded.unknown}
    appVersion={VERSION}
    onSessionExit={(info) => {
      // A failure sticks. Running `betterclaude` in a script should fail if any
      // wrapped session failed, and the first failure is the likeliest cause —
      // so a later clean exit must not paper over an earlier bad one.
      if (exitState.info && exitState.info.exitCode !== 0) return;
      exitState.info = info;
    }}
  />,
  {
    // Ctrl+C belongs to claude, and console patching would fight with the
    // alternate screen buffer.
    exitOnCtrlC: false,
    patchConsole: false,
  },
);

await instance.waitUntilExit();
restoreTerminal();

const exitInfo = exitState.info;
if (exitInfo && exitInfo.exitCode !== 0) {
  const suffix = exitInfo.signal ? ` (signal ${exitInfo.signal})` : '';
  process.stderr.write(`claude exited with code ${exitInfo.exitCode}${suffix}\n`);
  process.exit(exitInfo.exitCode);
}

process.exit(0);
