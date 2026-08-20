# BetterClaude

A BetterDiscord-style enhancement suite for Claude. Themes, plugins, and a pile of productivity tools layered on top of the Claude app you already use, without touching Anthropic's code or your login.

There are two ways to run it: a full Electron desktop app, or a terminal wrapper around your Claude Code CLI. Pick the one that matches how you already work.

![BetterClaude desktop app, home screen](.github/readme-assets/hero-home.png)

MIT licensed. Not affiliated with or endorsed by Anthropic.

## Contents

- [Desktop app](#desktop-app)
- [Themes](#themes)
- [Plugins](#plugins)
- [Buddies](#buddies)
- [The little stuff](#the-little-stuff)
- [Also in this repo](#also-in-this-repo)
- [Building it yourself](#building-it-yourself)
- [Contributing](#contributing)

## Desktop app

`BETTERCLAUDE DESKTOP MAIN/` is the main product: an Electron shell that loads the real claude.ai and injects a layer of UI and settings on top of it. Turning it off in Settings reverts you to stock claude.ai instantly, no uninstall needed.

Nine productivity modules, each toggleable on its own:

- **Skill Marketplace**: browse public GitHub repos tagged `claude-skill` and pull `SKILL.md` files down locally. claude.ai has no API to register a Skill for you, so you still upload the result yourself, but you stop hunting through repos by hand.
- **Prompt Library**: saved prompts with `{{clipboard}}` / `{{selection}}` placeholders, opened from a picker overlay or bound to their own global shortcut. Import/export as JSON.
- **Native File Watcher Sync**: watch a local file and keep a synced fenced-code-block copy of it in the composer. It doesn't fake claude.ai's own upload UI; it's real text, and "auto-reattach" only ever edits an unsent message.
- **Team/Shared Plugin Sync**: point it at a git repo of shared plugins and themes, pull on demand or on an interval. Conflicts are hash-based, so it can tell "the repo changed" apart from "you edited your copy" and only bugs you when both did.
- **Usage Analytics Dashboard**: a local, offline usage chart built from plugin-activity events, stored in a real SQLite database (via `sql.js`, so no native rebuild step per platform). No conversation content is ever touched, nothing leaves your machine.
- **Cross-Device Clipboard Bridge**: copy on one device, paste on another within a short TTL. Everything is encrypted client-side before it hits the relay, which only ever sees ciphertext, and the relay itself is a tiny self-hostable script included in the repo.
- **Smart Notification Digest**: batches routine "it worked" notifications into one periodic native alert instead of a toast per event. Failures always bypass the queue and show immediately.
- **Command Palette (Cmd/Ctrl+K)**: fuzzy search across app actions, every settings page, installed plugins, prompts, and skills, all from one overlay.
- **Embedded Claude Code window**: opens your actual Claude Code CLI in a real pseudo-terminal inside a BetterClaude-owned window, the same relationship `lazygit` has with `git`. It's the authentic binary; BetterClaude only supplies the window chrome and lets the terminal colors follow your active theme.

![BetterClaude Appearance Editor with live token values](.github/readme-assets/appearance-editor.png)

![The real Claude Code CLI running inside a BetterClaude-owned window](.github/readme-assets/claude-code-window.png)

Full detail on every module, including exactly what's stored where and what each toggle does under the hood, is in the [desktop app README](BETTERCLAUDE%20DESKTOP%20MAIN/README.md).

## Themes

80 built-in themes, plus a full Appearance Editor if you want to hand-tune corner radius, spacing, fonts, and every derived hover/active/disabled color state, and a raw Custom CSS box for anyone who wants to go further than the editor allows. Save whatever you land on as your own named theme.

![Theme gallery: rows of colored preview swatches for dozens of built-in themes](.github/readme-assets/themes.png)

A few names to give you a sense of range: Dracula, Nord, Tokyo Night, Catppuccin Mocha, Cyberpunk Neon, Gruvbox Dark, Solarized Light, Synthwave, Midnight Violet, Sakura Blossom, High Contrast. Import a theme from a URL or a local file, or shuffle through them with "Surprise Me" if you'd rather not pick.

## Plugins

Nine plugins ship in the box, each a plain `*.claudeplugin.js` file you can read, edit, or replace:

| Plugin | What it does |
| --- | --- |
| Focus Mode | Strips away the parts of the page that aren't the conversation |
| Goal Tracker | Simple running list of goals, pinned to the sidebar |
| Markdown Plus | Extra Markdown rendering in the composer and replies |
| Pomodoro Timer | A timer widget that lives in the corner of the app |
| Quick Prompts | One-click buttons for prompts you use constantly |
| Quote of the Day | A rotating quote on the home screen |
| Snippet Library | Reusable text snippets you can drop into the composer |
| Sticky Notes | Freeform notes that stay pinned to the app |
| World Clock | A small multi-timezone clock widget |

![Plugin list in Settings, showing all nine built-in plugins with toggle switches](.github/readme-assets/plugins.png)

The plugin loader also picks up your own custom `*.claudeplugin.js` files (Electron build only, since it needs a real filesystem to read from). "Open Plugins Folder" in Settings takes you straight there.

## Buddies

Small animated companions that live in the corner of the app while you work: Astronaut, Detective, Scuba Diver, and Spartan. Each has its own typing, thinking, running, and flying animation depending on what's happening in the conversation.

<img src=".github/readme-assets/buddy-astronaut.png" alt="The Astronaut buddy, an animated pixel-art companion" width="240" />

## The little stuff

Things that don't need their own section but are worth knowing about:

- **Snake, while you wait.** A small Snake board pops up in the corner whenever Claude is generating a response and disappears on its own once the answer lands. There's a setting for how long it waits before showing up, so quick replies don't trigger it.
- **Sound effects** for the things that deserve them, all optional.
- **Motion and interaction touches** scattered through the UI (`core/interaction-fx.js`, `core/motion-fx.js`), the kind of detail that's easy to miss and hard to unsee once you notice it.
- **A weather widget**, if you want one more thing in the corner of your screen.
- **A built-in diff viewer** for anything that needs a side-by-side comparison.

## Also in this repo

The desktop app is the main event, but the same `core/` and `ui/` source is reused in one other place:

**[`BETTERCLAUDE OFFICIAL/`](BETTERCLAUDE%20OFFICIAL/README.md)** is `betterclaude`, a terminal UI that wraps the Claude Code CLI you already have installed. Same category of program as `lazygit` or `k9s`: it finds the real `claude` on your PATH, spawns it in a pseudo-terminal, and draws its own chrome around that session. Multi-pane sessions, per-pane history, themeable colors. It does not log in, does not touch credential files, and never calls the API directly; all it does is spawn the binary you're already authenticated with.

That folder has its own README with the details specific to that build.

## Building it yourself

### Desktop app

```bash
cd "BETTERCLAUDE DESKTOP MAIN"
npm install
npm run dev      # build the core bundle and launch Electron in dev mode
```

Packaged builds go through [electron-builder](https://www.electron.build/):

```bash
npm run build:mac    # macOS, arm64 + x64, .dmg and .zip
npm run build:win    # Windows, x64 NSIS installer
npm run build:all    # everything above
```

Output lands in `dist/`. These builds are unsigned (no Apple Developer ID or Windows code-signing cert configured yet), so macOS will show a Gatekeeper warning and Windows will show a SmartScreen prompt on first launch. Full detail on signing, auto-update, and every setting is in that folder's own README.

### Terminal UI

```bash
cd "BETTERCLAUDE OFFICIAL"
npm install
npm run build
npm link          # installs the `betterclaude` and `bcx` commands globally
betterclaude
```

Requires Node 20+ and a working `claude` login already set up.

## Contributing

Issues and pull requests are welcome. If you're adding a plugin or a theme, look at an existing one in `plugins/` or `themes/` first; the format is small enough to copy from.

## License

MIT, see [LICENSE](LICENSE).
