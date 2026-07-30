# BetterClaude

A BetterDiscord-style enhancement suite for Claude AI (Electron desktop app).

## Productivity modules

Each is independently toggleable from its own Settings panel section and persists via the same electron-store-backed settings file as everything else.

**Skill Marketplace** (Settings → Skill Marketplace, off by default) — browses public GitHub repos tagged `claude-skill` via the GitHub Search API (optional personal access token for a higher rate limit). "Install" downloads `SKILL.md` + assets into `userData/skills/<id>/` — claude.ai has no public API to register a Skill, so upload the result yourself via claude.ai Settings → Capabilities. Catalog UI: `core/skill-marketplace.js` (open via Cmd/Ctrl+K → "Open Skill Marketplace"). Backend: `skills:*` IPC handlers in `electron/main.js`.

**Prompt Library** (Settings → Prompt Library) — saved prompts with `{{variable}}` placeholders (`{{clipboard}}` / `{{selection}}` auto-fill). Picker overlay: `core/prompt-picker.js`, opened with Cmd/Ctrl+Shift+P or via the Command Palette; any prompt can also be bound to its own OS-wide shortcut (`electron/main.js`'s `registerPromptShortcuts`, via Electron's `globalShortcut`). Import/export as JSON, merged by id so importing a shared library doesn't wipe local prompts.

**Native File Watcher Sync** (Settings → File Watcher) — watches a local file (`chokidar`, main-process only) and keeps a labeled fenced-code-block copy of it in the composer in sync. Deliberately doesn't fake claude.ai's own native file-upload UI — "attach" is real inserted text (`core/file-sync-indicator.js`), and "auto-reattach" only ever find-and-replaces that same block in an *unsent* message; once sent, a changed file is just marked stale with a one-click re-insert.

**Team/Shared Plugin Sync** (Settings → Team Sync, off by default) — points at a git repo of shared `*.claudeplugin.js` and/or theme `*.css` files; `electron/team-sync.js` shells out to the system `git` (clone once, then fetch + hard-reset on every later sync — no JS git library dependency) into `userData/team-sync/<repo-slug>/`, then copies matched files into the same `userData/plugins`/`userData/themes` directories a manually-added plugin or theme already lives in. Pull manually ("Sync now") or on an interval. Conflict handling is hash-based: a per-file manifest remembers what was last applied, so a sync can tell "the repo changed" apart from "you edited your local copy" — anything where **both** changed since the last sync surfaces as a conflict with an inline diff and Keep mine / Take theirs; safe (non-conflicting) updates apply automatically when "Auto-apply" is on.

**Usage Analytics Dashboard** (Settings → Usage Analytics, off by default) — a most-used-plugins chart with a date range picker (presets + custom) and CSV/PNG export. Built entirely from plugin-activity events logged locally as you go, once enabled — `electron/analytics-db.js` stores them in a real SQLite database (via `sql.js`, SQLite compiled to WebAssembly) under `userData/analytics.sqlite`. WASM rather than a native addon like `better-sqlite3` on purpose: no per-platform native rebuild step, and the same engine can run in a browser extension later. Charts are hand-rolled Canvas 2D (`core/analytics-charts.js`) — no charting library dependency. No conversation content is ever read or recorded, and nothing is ever sent anywhere; "Clear all data" wipes the local database. Dashboard overlay: `core/analytics-dashboard.js` (open via Cmd/Ctrl+K → "Open Usage Analytics", or Settings → Usage Analytics → "Open Dashboard").

**Cross-Device Clipboard Bridge** (Settings → Clipboard Bridge, off by default) — copy on one device, and it's paste-ready on another within a short TTL. Syncs through a relay you point at yourself: `scripts/clipboard-relay-server.js` is a minimal self-hostable reference implementation (`npm run clipboard-relay`, or `node scripts/clipboard-relay-server.js --port 8787`), and any HTTP endpoint implementing the same tiny `POST /put` / `GET /pull` / `GET /health` protocol works instead. Everything is end-to-end encrypted client-side (`core/clipboard-bridge.js`, PBKDF2 + AES-GCM keyed from a shared passphrase you set) before it ever reaches the relay, which only ever sees ciphertext plus a one-way channel id — never plaintext or the passphrase itself. Nothing syncs until both a relay URL and passphrase are set and the toggle is on; Settings → Clipboard Bridge always shows live connection status (Disconnected/Connecting/Connected/Error) and every synced item fires a notification, so syncing is never silent. Backend polling, encryption, and OS clipboard read/write all happen in `electron/main.js` (mirrors Native File Watcher Sync's split).

**Smart Notification Digest** (Settings → Notifications → Smart Notification Digest, off by default) — batches routine background-completion notifications (Team Sync applied files, clipboard synced, skill installed, ...) into one periodic native OS notification instead of firing one in-page toast per event. Failures always bypass the queue: `electron/preload.js`'s `notify()` has an `urgent` option that shows immediately as both an in-page toast and a native notification regardless of digest state (used for Team Sync's background auto-sync failing) — the digest only ever delays "it worked" updates, never error visibility. Native notification delivery is a small `Notification.isSupported()`-guarded IPC handler (`notifications:show-native`) in `electron/main.js`.

**Embedded Claude Code window** (tray → "Open Claude Code", File → "Open Claude Code" / "Open Claude Code in Folder…", Cmd/Ctrl+Shift+K, or launch with `--code`) — opens your real Claude Code CLI inside a BetterClaude-owned window instead of handing it off to Terminal.app. Same relationship `lazygit` has with `git`: `electron/claude-cli.js` resolves the `claude` executable the way a shell would (PATH first, then the usual user-level install dirs, since a Dock-launched .app inherits a stripped PATH) and spawns it in a real pseudo-terminal via `node-pty`; `ui/code-window/terminal.js` renders it with xterm.js. Nothing about the CLI is reimplemented, wrapped, or intercepted — it's the authentic binary, with BetterClaude supplying only the window chrome. The terminal's colours come from the same `--bc-*` theme variables as everything else, so switching a theme restyles it live without disturbing the running session, and the title bar's settings button opens the real settings panel scoped to the appearance sections (`electron/code-preload.js`'s `CODE_WINDOW_SECTIONS`). The renderer runs with `nodeIntegration: false`: every pty byte crosses one `contextBridge` surface, the only thing ever written to the child's stdin is your own keystrokes forwarded verbatim, terminal output is never parsed to trigger anything, and no auth/token/session file is read anywhere in the path. Closing the window kills the child. A port of the compliant spawn logic from the `BETTERCLAUDE OFFICIAL` track, not an import across folders.

**Command Palette (Cmd/Ctrl+K) for Everything** (Settings → Command Palette) — the connective tissue tying the rest of this list together, built last so there was something to index. One fuzzy-search overlay covering app actions, every settings page (jumps straight to it via `SettingsPanel.openSection`), installed plugins (toggle on/off), Prompt Library entries (insert), and installed + cached-marketplace Skills. Matching is a small hand-rolled fuzzy subsequence scorer (`core/command-palette.js`'s `fuzzyScore`, no library) rather than a plain substring filter, so abbreviations and scattered-letter queries still rank sensibly; each result shows a small group tag (Action/Settings/Plugins/Prompts/Skills/Analytics).

## Development

```bash
npm install
npm run dev      # build core bundle + launch Electron in dev mode
npm start        # build core bundle + launch Electron
```

## Building & Distribution

Packaged builds are produced with [electron-builder](https://www.electron.build/), configured in the `build` field of `package.json`.

### Prerequisites

| Target | Can build from | Notes |
| --- | --- | --- |
| macOS (arm64 + x64) | macOS only | Apple's mac build tools (`hdiutil`, codesign, etc.) aren't available on Linux/Windows, so signed/notarized `.dmg`/`.zip` output requires a real Mac (or a macOS CI runner). |
| Windows (x64, NSIS) | macOS, Linux, or Windows | electron-builder bundles its own NSIS tooling, so the Windows installer builds fine cross-platform without Wine. |

### Scripts

```bash
npm run build:mac         # macOS: arm64 + x64, .dmg + .zip
npm run build:mac:arm64   # macOS: arm64 only
npm run build:mac:intel   # macOS: x64 only
npm run build:win         # Windows: x64 NSIS installer (.exe)
npm run build:all         # everything above in one run
```

Each script runs `build:core` first (the esbuild bundle) so packaged output always ships up-to-date `build/*.bundle.js` files.

### Output

All artifacts land in `dist/`:

- `dist/BetterClaude-<version>-arm64.dmg` + `.zip` — macOS Apple Silicon
- `dist/BetterClaude-<version>-x64.dmg` + `.zip` — macOS Intel
- `dist/BetterClaude Setup <version>.exe` — Windows installer (NSIS, lets the user choose install directory, adds desktop + Start Menu shortcuts)

### Icons

Source icon is `assets/icon.png` (2000×2000), converted into `build/icon.icns` (macOS) and `build/icon.ico` (Windows) — both already checked in. Swap those two files for polished, on-brand multi-resolution artwork before a real release; the current ones are generated straight from the existing app icon and are functional but not final.

### Code signing & notarization

These builds are **unsigned**. That's expected in this setup — there's no Apple Developer ID or Windows code signing certificate configured. Concretely:

- **macOS**: unsigned apps trigger Gatekeeper warnings ("app is damaged and can't be opened" / "unidentified developer"). Users can work around this per-app with right-click → Open, but for real distribution you need an Apple Developer ID certificate and to run the app through Apple's notarization service.
- **Windows**: unsigned installers trigger SmartScreen warnings ("Windows protected your PC"). Users can click "More info" → "Run anyway", but for public distribution without that warning you need a code signing certificate (EV certs also get you instant SmartScreen reputation).

Neither of these is configured here — add signing identities/certificates to the `mac`/`win` build config (and `CSC_LINK`/`CSC_KEY_PASSWORD` env vars, or their Windows equivalents) when you're ready to distribute publicly.

**⚠️ This directly limits in-app auto-update (see below):**

- **macOS — auto-update will not complete unsigned.** `electron-updater` verifies that the downloaded build's code signature matches the running app before swapping it in. On an unsigned or ad-hoc-signed build the download succeeds and then install fails with a code-signature error. macOS auto-update effectively **requires** a Developer ID Application certificate + notarization. Until then, macOS users must update by downloading the new `.dmg` manually — which is exactly why every failure path in the UI offers an "Open Releases" button.
- **Windows — auto-update does work unsigned.** NSIS updates apply without a certificate. The cost is a SmartScreen "unrecognized publisher" prompt on each install until the build is signed and has accumulated reputation.

## Releasing (in-app auto-update)

Updates are served straight from **GitHub Releases** — no backend server. `build.publish` in `package.json` points `electron-updater` at `ara-mkr/betterclaude`; electron-builder writes a `latest-mac.yml` / `latest.yml` feed next to the artifacts, and the app polls that.

Cutting a release:

```bash
# 1. Bump the version (must be semver; this is the value the app compares against).
#    `npm version` writes package.json AND creates the matching git tag.
npm version patch          # 0.2.0 -> 0.2.1   (or: minor / major / 0.3.0)

# 2. Push the commit and the tag. The tag MUST be vX.Y.Z — electron-builder
#    derives the GitHub release from it, and electron-updater matches on it.
git push && git push --tags

# 3. Build every target and upload the artifacts + update feed to the
#    GitHub release in one step.
export GH_TOKEN=<a GitHub personal access token with `repo` scope>
npm run build:core && npx electron-builder --mac --arm64 --x64 --win --x64 --publish always
```

Notes:

- `npm version` refuses to run on a dirty working tree — commit first.
- The release is created as a **draft**. Add the changelog to the release body and publish it; that body is what the in-app banner shows as its "what's new" blurb (stripped to plain text, capped at 160 chars — see `summarizeReleaseNotes` in `electron/main.js`).
- `GH_TOKEN` is only needed for `--publish`; plain `npm run build:all` still works offline.
- Keep the `package.json` version and the git tag in lockstep. A tag without the matching `version` bump produces a release the running app will not offer as an update.
- There is **no CI/GitHub Actions workflow** for this yet — the sequence above is manual.
- Bumping the version also advances `electron-store`'s migration pointer; see the comment above the `new Store(...)` call in `electron/main.js` before adding a settings migration keyed to a new version.

### How it behaves in the app

- Checks the feed ~5s after launch (skipped if Settings → Appearance → Updates → "Automatically check for updates" is off), plus on demand via that section's "Check now" and the Help → Check for Updates… menu item.
- Nothing downloads automatically (`autoDownload = false`) and nothing installs on quit (`autoInstallOnAppQuit = false`) — both require an explicit click.
- An available update raises a dismissible bottom-right banner (`core/update-banner.js`). "Later" suppresses **that version only**; the next release surfaces again.
- Background check failures stay silent (Settings shows them); only a hand-triggered check surfaces an error in the banner, always alongside an "Open Releases" fallback.
- Running unpackaged (`npm start`) reports "Updates only check in packaged builds" rather than a confusing feed error.
