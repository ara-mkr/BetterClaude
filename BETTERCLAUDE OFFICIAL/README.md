# betterclaude

A terminal UI that wraps the Claude Code CLI you already have installed.

Not affiliated with, endorsed by, or produced by Anthropic.

## What this is

`betterclaude` runs *inside* your existing terminal — Terminal.app, iTerm2,
WezTerm, Windows Terminal, whatever you already use. It is the same category of
program as `lazygit`, `k9s`, or `htop`. It is **not** a terminal emulator and
**not** a modified copy of any Anthropic binary.

On launch it finds the real `claude` on your PATH, spawns it attached to a
pseudo-terminal, and draws its own UI around that session.

Think of it as a cockpit built around an engine you already own: your
already-authenticated `claude` CLI is the engine, this is the dashboard.

## What it does not do

These are hard boundaries, not preferences:

- **No authentication, ever.** It does not log in, does not read credential
  files, OAuth tokens, session data, or Claude Code's config directory. All auth
  is handled by your separate, normal `claude` login. There is no code path in
  this project that touches any of it.
- **No API access.** It never calls `api.anthropic.com`. The only way it reaches
  Claude is by spawning the real `claude` binary and talking to that subprocess.
- **No telemetry.** Nothing leaves your machine. Conversations are not logged,
  intercepted, or transmitted. The session history it does keep is local
  metadata only — see [Session history](#session-history).
- **It does not install or configure `claude` for you.** If the binary is
  missing, it tells you and stops.

## Requirements

- Node.js 20 or newer
- Claude Code installed and **already logged in**, such that typing `claude` in
  your terminal works on its own. See
  <https://docs.claude.com/en/docs/claude-code/overview>.

## Build and run

```sh
npm install
npm run build
npm start
```

For development, without a build step:

```sh
npm run dev
```

To install it as a global command:

```sh
npm link          # provides `betterclaude` and the shorter alias `bcx`
```

### Usage

```sh
betterclaude                          # start a session in the current directory
betterclaude --cwd ~/code/my-project  # start somewhere else
betterclaude --claude-path /opt/claude/bin/claude
betterclaude --theme midnight         # chrome colour scheme
betterclaude --frame                  # draw a border around the session
betterclaude --no-frame               # override a config that enables it
betterclaude --panes 2                # open two side-by-side sessions at launch
betterclaude --list-themes            # print available themes and exit
betterclaude --print-config           # print resolved settings and exit
betterclaude --no-history             # do not record this run in the history log
betterclaude --no-alt-screen          # render inline; useful when debugging
betterclaude -- --help                # forward arguments verbatim to claude
```

Anything after `--` goes to `claude` untouched.

### Themes

| Name | Look |
| --- | --- |
| `terminal` | default; inherits your terminal's own palette |
| `midnight` | cool blues |
| `ember` | warm oranges |
| `mono` | greyscale |

Themes style the app's chrome only — border, status bar, error panels. The
session pane is whatever `claude` drew, passed through untouched: a theme that
recoloured the child's output would be misrepresenting what it produced.

`terminal` is the default and uses palette *names* rather than hex, so your own
terminal theme still decides what "green" looks like and the wrapper never
clashes with the terminal it runs inside.

`--frame` is opt-in rather than default because a border costs the child two rows
and two columns of real screen, which is a meaningful tax in a coding tool.

The status bar drops segments as the terminal narrows — key hint below 52
columns, elapsed time below 64, pane size below 82, the history hint below 96 and
the split hint below 118 — rather than truncating them, since a half-printed path
is worse than no path.

### Keys

Every keystroke reaches `claude` unchanged. App-level actions live behind a
leader key so this wrapper can never shadow a binding inside `claude`.

| Key | Action |
| --- | --- |
| `ctrl+g` then `q` | quit |
| `ctrl+g` then `,` | open settings |
| `ctrl+g` then `r` | reload the config file from disk |
| `ctrl+g` then `h` | show or hide the history sidebar |
| `ctrl+g` then `H` | show the sidebar *and* focus it for browsing |
| `ctrl+g` then `s` | split — open another pane |
| `ctrl+g` then `x` | close the focused pane |
| `ctrl+g` then `o` | focus the next pane (`O` for the previous) |
| `ctrl+g` then `1`–`9` | focus that pane directly |
| `ctrl+g` then `v` | flip between side-by-side and stacked |
| `ctrl+g` twice | send a literal `ctrl+g` to `claude` |

`ctrl+c` is deliberately *not* intercepted — it goes to `claude`, which is what
you expect it to interrupt.

`ctrl+g` `H` is the shifted form of whatever the sidebar toggle is bound to, so
there is only one history key to remember. If you rebind the toggle to something
with no distinct uppercase form, the browse shortcut simply goes away and
toggling still works.

The leader and all eight command keys are configurable. Leader keys that the
terminal or shell relies on (`ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+[`, `ctrl+m`,
`ctrl+s`, and friends) are **rejected**, not merely discouraged — binding one
would break the session in ways that look like a bug in `claude`.

## Settings

Press `ctrl+g` `,` to open the settings screen.

| Key | Action |
| --- | --- |
| `↑` `↓` (or `k` `j`) | move between rows |
| `←` `→` (or `h` `l`) | change the selected value |
| `enter` | rebind a command key (then press the key you want) |
| `s` | save and close |
| `d` | restore defaults (still needs `s` to save) |
| `esc` | close without saving |

Theme and frame changes preview live while the screen is open, and `esc` reverts
them along with everything else — nothing reaches disk until you press `s`.

## Panes

`ctrl+g` `s` splits the screen and starts another `claude` in the new pane. Each
pane is a completely independent session — its own subprocess, its own terminal
emulator, its own history record. They share nothing but the screen.

The focused pane is the one with the accent-coloured bar down its left edge, and
it is the only one receiving your keystrokes. `ctrl+g` `o` moves to the next
pane, `O` to the previous, and `ctrl+g` followed by a digit jumps straight to
that pane. The status bar shows which one you are in as `2/3`.

```
▌│ claude (focused)   │ │ claude              │ │ claude
▌│ > building the …   │ │ > waiting…          │ │ > /tests
▌│                    │ │                     │ │
```

Splitting is refused rather than attempted when the result would be unusable:
each pane needs at least 50 columns side by side, or 12 rows stacked, and there
is a hard ceiling of 4. A refusal explains itself in the status bar. `claude`
needs room to lay itself out, and four unusable panes are worth less than one
working one.

### Direction

`ctrl+g` `v` flips between side-by-side and stacked, and the panes reflow
immediately — `claude` is told its new size and redraws, the same path a real
terminal resize takes.

Like a split, the flip is **refused** when the destination would not fit: a wide
but short terminal holds three columns and no stacked panes at all, so it says so
rather than squeezing them to seven rows each. Which way is currently in force
shows up as a notice when you press it.

The chord applies to the current run only. `Split direction` in settings is what
writes the preference to disk, which is also why `ctrl+g` `r` (reload) puts a
flipped session back to whatever the file says.

### When a pane's session ends

The pane stays where it is, keeping its final frame so the transcript is still
readable, and its footer shows how the session ended. Dismiss it with
`ctrl+g` `x`.

It deliberately does **not** close itself. A background task finishing while you
are typing in another pane would otherwise reflow the entire screen out from
under you, and the exit code would vanish before you saw it.

The app exits once nothing is running — so a single pane behaves exactly as it
always has, and `ctrl+g` `x` on the last remaining pane tells you to use the quit
key instead. Quitting with several sessions alive asks once: the first `ctrl+g`
`q` warns, the second goes through. One keystroke should not end three live
sessions without a word.

If `betterclaude` was launched from a script, it exits non-zero when *any* pane
exited non-zero — the first failure wins, and a later clean exit does not paper
over an earlier bad one.

## Session history

Every pane opens its own record, so a session's history is per-pane rather than
per-launch. The sidebar marks all of them live at once.

The sidebar lists sessions you launched through this app, newest first, with a
glyph for how each one ended: `●` running, `✓` clean exit, `✗` non-zero exit or
signal, `·` never closed cleanly.

`ctrl+g` `h` shows and hides it. While it is merely *visible* every keystroke
still goes to `claude` — the panel can never eat your typing. `ctrl+g` `H` also
gives it focus so you can browse:

| Key | Action |
| --- | --- |
| `↑` `↓` (or `k` `j`) | move through the list |
| `g` / `G` | jump to newest / oldest |
| `esc` or `q` | hand focus back to `claude`, leaving the panel open |

Opening the sidebar narrows the session pane, and `claude` is told about its new
size and reflows — the same path a real terminal resize takes.

Below 72 columns the sidebar is not offered at all: splitting a narrow terminal
leaves `claude` too cramped to lay itself out, and a broken session pane is worse
than a missing panel.

### What is recorded

Metadata about *invocations*, and nothing about conversations:

```jsonc
// ~/.betterclaude-official/history.jsonl — one JSON object per line
{"v":1,"kind":"start","id":"9f2c1a7e-…","startedAt":"2026-07-27T14:03:11.482Z",
 "cwd":"/home/example/code/demo","label":"demo","pid":41233,"app":"0.1.0"}
{"v":1,"kind":"end","id":"9f2c1a7e-…","endedAt":"2026-07-27T14:41:02.119Z",
 "exitCode":0,"signal":null}
```

All timestamps are ISO-8601 UTC with millisecond precision. Duration is computed
when the list is drawn, not stored.

There is **no field in this format capable of holding conversation content**, and
that is structural rather than a promise: the wrapper hands PTY bytes straight to
a terminal emulator without reading them, so it has nothing to write down.
Nothing auth-related is recorded either — no tokens, no account, no session ids
belonging to Claude Code.

`label` is the working directory's basename, deliberately *not* the git
repository name. Reading `.git/HEAD` would mean opening a file outside
`~/.betterclaude-official/`, and keeping "this app touches exactly one directory"
literally true is worth more than a prettier label.

The one thing that can put prompt text on disk is **off by default**: turning on
`Record claude args` stores the arguments you forwarded after `--`, and
`claude -p "some prompt"` puts that prompt in them. The settings row says so.

### Why an append-only log

Two lines per session — one when it starts, one when it ends — rather than
rewriting a JSON array:

- Recording a start is a single short append, which cannot leave an earlier
  record half-written the way a read-modify-write of a whole array can.
- A torn or hand-edited line costs you that one line; everything else still
  parses.
- A session killed by `SIGHUP` leaves a start with no end. That is not a lost
  record, it is an honest one — shown as "never closed cleanly" rather than
  quietly disappearing.

Old sessions are dropped when the log outgrows the retention limit (default 200);
the rewrite is atomic, so an interrupted compaction leaves the previous log
intact. History failures never touch the session: every filesystem call is
wrapped, and a failure goes to the debug log while `claude` carries on.

To turn it off entirely, use `--no-history` for one run or `Record history` in
settings for good. To delete what is already there, remove
`~/.betterclaude-official/history.jsonl` — nothing else references it.

### Config file

Settings persist in `~/.betterclaude-official/config.json`. Override the
directory with `BETTERCLAUDE_CONFIG_DIR`.

```json
{
  "version": 3,
  "theme": "terminal",
  "frame": false,
  "leader": "ctrl+g",
  "keymap": {
    "quit": "q", "settings": ",", "reload": "r", "history": "h",
    "split": "s", "closePane": "x", "focusNext": "o", "toggleOrientation": "v"
  },
  "history": { "enabled": true, "sidebar": false, "limit": 200, "recordArgs": false },
  "panes": { "orientation": "columns", "startCount": 1 }
}
```

App preferences only. No credentials, no Claude Code state, nothing derived from
the content of your sessions. Session metadata lives in a separate file —
see [Session history](#session-history).

A version 1 or 2 config from an earlier build loads unchanged and simply picks up
the new defaults; no migration step is involved. If it happened to bind an older
action to one of the newer defaults — `h`, `s`, `x`, `o`, or `v` — the binding you
already had **wins**, the clash is reported once, and the newer action stays
unbound until you rebind it. The app never silently steals a key you were using.

Precedence is **defaults < config file < command-line flags**. A flag applies to
the current run; the settings screen is what writes to disk. Run
`betterclaude --print-config` to see what the resolved settings actually are.

Two properties worth relying on:

- **A broken config never blocks startup.** Invalid fields fall back to their
  defaults and are reported in the status bar and settings screen rather than
  throwing. Even an unparseable file just yields defaults plus an explanation.
- **Unknown keys are preserved.** A config written by a newer version keeps its
  extra fields when an older version saves over it, so downgrading does not
  silently destroy settings.

Saves are atomic — written to a temp file and renamed over the target — so an
interrupted save leaves the previous settings intact rather than a truncated file
that would fail to parse next launch.

## Architecture

```
keystrokes ─> useRawInput ─> App (which pane?) ─> PaneSet.write ─> PTY ─> claude
claude ─> PTY ─> TerminalBuffer (headless VT) ─> snapshot ─> SessionPanel ─> Ink
```

That loop runs once per pane. `useRawInput` stays deliberately ignorant of panes:
it forwards every byte but the leader, and `App` alone decides the destination, so
no amount of pane machinery can start intercepting keys meant for the child.

| Path | Role |
| --- | --- |
| `src/index.tsx` | CLI parsing, binary lookup, alternate screen, bootstrap |
| `src/App.tsx` | Root layout, keyboard routing, focus, resize handling |
| `src/panes/` | Pane lifecycle (`PaneSet`) and the layout arithmetic (`layout.ts`) |
| `src/pty/` | `node-pty` spawn/write/resize/kill; PATH lookup for `claude` |
| `src/vt/` | Headless terminal emulator and grid-to-styled-rows conversion |
| `src/components/` | Pane grid, session panel, status bar, sidebar, frame, error screen |
| `src/sessionHistory/` | Session metadata log: types, folding, append and compaction |
| `src/theme/` | Built-in colour schemes and the theme context |
| `src/input/` | Raw stdin passthrough and leader-key handling |
| `src/util/` | Render throttling, opt-in debug logging |

### Why there is a terminal emulator in here

This is the non-obvious part of the design. `claude` is itself a full-screen
TUI: its output is not an append-only log but a stream of cursor moves and
in-place rewrites. Appending those bytes to a text buffer produces garbage.

So the PTY stream is fed to a real headless VT implementation
(`@xterm/headless`), which maintains the screen grid exactly as a terminal
would. Each frame we read that grid back out as styled text and hand it to Ink.
The wrapper never parses or rewrites `claude`'s output — it just gives it a
correct screen to draw on and photographs the result.

Two consequences worth knowing:

- **Frames are coalesced to ~30fps.** A fast-streaming child would otherwise
  spend all our time in React reconciliation and visibly tear.
- **Fidelity is very good but not byte-identical** to running `claude` bare.
  Colours round-trip exactly (16-colour stays palette-indexed so your terminal
  theme still applies; 256-colour and truecolor are preserved). The cursor is
  drawn as an inverted cell rather than by moving the real cursor, because Ink
  owns the physical cursor position.

### Layout note

Ink appends a newline to every frame it writes. The app therefore renders
`rows - 1` lines: if it claimed the full height, the terminal would scroll on
every repaint and the layout would drift upward.

Panes make that constraint sharper, because a horizontal overflow turns into a
vertical one — a row one column too wide wraps, the frame grows by a line, and
the terminal scrolls forever after. So all the geometry lives in one pure module,
`src/panes/layout.ts`, with one invariant:

```
columns: sum(outerCols) + separator × (count − 1) === cols
rows:    sum(outerRows) + separator × (count − 1) === rows
```

Nothing rounds up. Integer division leaves a remainder and the remainder is handed
out one column at a time to the leading panes, so the total is exact rather than
approximately right. When a terminal is too small even for the rules between
panes, the rules are dropped — chrome yields, the sum never does.

### What a pane costs

With one pane, nothing: no gutter, no separator, and the rendering path is the
same cells the single-session build produced. From two panes up, each pane pays
one column for its focus gutter, plus one column (or row) for each rule between
neighbours, plus two of each if `--frame` is on.

All panes share **one** frame clock rather than one throttler each. Three panes
with independent 30fps timers would be ninety React updates a second between
them; a shared clock with a per-pane dirty flag keeps repaint cost flat as pane
count grows, and panes that did not change keep their snapshot object identity so
their memoised panels skip reconciliation entirely.

## Debugging

Set `BETTERCLAUDE_DEBUG` to a file path to get a timestamped trace of session
lifecycle, PTY chunk sizes, and frame counts:

```sh
BETTERCLAUDE_DEBUG=/tmp/bc.log npm run dev
```

It records sizes and state transitions only — never the bytes flowing to or from
the child.

## Known limitations

- Panes are a flat list in one direction, not a nested split tree. You cannot
  split a single pane while leaving its neighbours alone.
- Pane sizes are equal and not draggable; there is no zoom or "maximise this one".
- The sidebar browses *past* sessions and cannot switch focus between live panes
  — use `ctrl+g` `o` or a digit for that.
- Selecting a session in the sidebar does not reopen or resume it. Nothing is
  stored that could resume a conversation, and resuming is `claude`'s business,
  not the wrapper's.
- Mouse reporting is not forwarded.
- Running `betterclaude` from inside a Claude Code session will not work:
  `claude` detects the nested environment (`CLAUDECODE=1`) and exits. Run it
  from a normal shell.

## A note on naming

The npm package is `betterclaude-tui` and the command is `betterclaude`. Nothing
in the published identifiers implies Anthropic endorsement — deliberately. The
local folder name is just a directory on disk and is not published anywhere.
