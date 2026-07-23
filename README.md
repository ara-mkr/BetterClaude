# BetterClaude

A BetterDiscord-style enhancement suite for Claude AI (Electron desktop app).

## Productivity modules

Each is independently toggleable from its own Settings panel section and persists via the same electron-store-backed settings file as everything else.

**Skill Marketplace** (Settings → Skill Marketplace, off by default) — browses public GitHub repos tagged `claude-skill` via the GitHub Search API (optional personal access token for a higher rate limit). "Install" downloads `SKILL.md` + assets into `userData/skills/<id>/` — claude.ai has no public API to register a Skill, so upload the result yourself via claude.ai Settings → Capabilities. Catalog UI: `core/skill-marketplace.js` (open via Cmd/Ctrl+K → "Open Skill Marketplace"). Backend: `skills:*` IPC handlers in `electron/main.js`.

**Prompt Library** (Settings → Prompt Library) — saved prompts with `{{variable}}` placeholders (`{{clipboard}}` / `{{selection}}` auto-fill). Picker overlay: `core/prompt-picker.js`, opened with Cmd/Ctrl+Shift+P or via the Command Palette; any prompt can also be bound to its own OS-wide shortcut (`electron/main.js`'s `registerPromptShortcuts`, via Electron's `globalShortcut`). Import/export as JSON, merged by id so importing a shared library doesn't wipe local prompts.

**Conversation Branching** (Settings → Branches) — a "⑂ Fork" button floats next to each message (`core/branch-fork-buttons.js`, positioned over — never inserted into — claude.ai's own DOM). Forking opens a second tiled window on a new claude.ai chat with the transcript up to that point pre-filled in the composer; nothing is ever sent automatically, and claude.ai's private chat API is never called. `core/diff-viewer.js` (Cmd/Ctrl+K → "Compare Responses") renders a local word-level diff between two pasted responses.

**Context Budget Planner** (Settings → Context Budget) — a pre-send planning step, distinct from the live Usage HUD. `core/context-budget.js` watches paste/drop/file-attach events on the composer and, only once the projected total (conversation so far + draft + attachments) crosses a configurable threshold (default 75%), intercepts the send action and shows a breakdown modal with Continue/Cancel. Below threshold it's invisible — zero friction for normal use — and every handler fails open, so a thrown error never blocks a send.

**Auto-Session Snapshots** (Settings → Snapshots) — periodic (or on-demand) checkpoints of a conversation's transcript, deduped against the last snapshot of the same conversation and capped at 20 per conversation. claude.ai owns the actual conversation state, so "Restore" doesn't rewind anything in place — it forks a new window pre-filled from the snapshot's transcript, reusing the same `branching:open-fork` IPC as Conversation Branching.

**Local Semantic Search** (Settings → Semantic Search, off by default) — hybrid keyword + similarity search across every conversation opened in BetterClaude. Indexing is opportunistic (built up from real use, never a bulk import of claude.ai's history) and stored as one JSON file per conversation under `userData/search-index/`. "Local" mode is dependency-free TF-IDF/cosine similarity; "Hosted" mode blends in a real neural-embedding score via the user's own OpenAI-compatible embeddings API key. Overlay: `core/semantic-search.js` (Cmd/Ctrl+Shift+F, or Cmd+K → "Search All Chats"); backend: `search:*` IPC handlers in `electron/main.js`.

**Multi-Model Routing Rules** (Settings → Model Routing, off by default) — matches the outgoing message against user-defined rules (priority = list order) and clicks through claude.ai's own model picker before the send goes through. `core/model-router.js` shares the exact composer-send interception shape as Context Budget Planner, including the same shared, time-windowed bypass (`electron/preload.js`'s `isSendBypassed`/`setSendBypass`) so the two interceptors compose correctly instead of re-triggering each other. Every match fires a notification so routing is never a silent black box; every DOM step fails open.

**Native File Watcher Sync** (Settings → File Watcher) — watches a local file (`chokidar`, main-process only) and keeps a labeled fenced-code-block copy of it in the composer in sync. Deliberately doesn't fake claude.ai's own native file-upload UI — "attach" is real inserted text (`core/file-sync-indicator.js`), and "auto-reattach" only ever find-and-replaces that same block in an *unsent* message; once sent, a changed file is just marked stale with a one-click re-insert.

**Macro Recorder** (Settings → Macros) — records a sequence of sends (Prompt Library entries stay re-resolvable at replay time, so `{{clipboard}}` picks up whatever's on the clipboard *during* replay) and replays them by actually driving the conversation: insert, send, wait for the real assistant response to finish, then the next step. `core/macro-recorder.js` reimplements the same turn-stability-across-polls technique the live message dispatcher already uses, as a one-shot awaitable. A floating indicator (never inserted into claude.ai's DOM) shows recording/replay progress with a Stop control.

**Inline Diff Applier for Code Blocks** (Settings → Diff Applier) — when a response's code block matches a file watched by Native File Watcher Sync, a "⇄ Diff & Apply" button floats over that code block (`core/diff-applier.js`, same viewport-pinned technique as the "⑂ Fork" buttons). Matching is honest about confidence rather than silently guessing: "exact" when the filename is mentioned in the message, "fuzzy" when exactly one watched file shares the code block's language, "ambiguous"/"unknown" otherwise — anything short of exact shows a warning and a file picker so you confirm the target before applying. The diff itself is always computed against the file's real current contents (read fresh from disk, never a cached copy) and "Apply" overwrites the file directly; the existing file watcher then picks up that on-disk change through its normal flow.

**Team/Shared Plugin Sync** (Settings → Team Sync, off by default) — points at a git repo of shared `*.claudeplugin.js` and/or theme `*.css` files; `electron/team-sync.js` shells out to the system `git` (clone once, then fetch + hard-reset on every later sync — no JS git library dependency) into `userData/team-sync/<repo-slug>/`, then copies matched files into the same `userData/plugins`/`userData/themes` directories a manually-added plugin or theme already lives in. Pull manually ("Sync now") or on an interval. Conflict handling is hash-based: a per-file manifest remembers what was last applied, so a sync can tell "the repo changed" apart from "you edited your local copy" — anything where **both** changed since the last sync surfaces as a conflict with an inline diff and Keep mine / Take theirs; safe (non-conflicting) updates apply automatically when "Auto-apply" is on.

**Usage Analytics Dashboard** (Settings → Usage Analytics, off by default) — historical charts (tokens/day, messages/day, estimated cost/day, most-used skills/plugins, busiest projects) with a date range picker (presets + custom) and CSV/PNG export, distinct from the live Usage HUD which never persists anything. Built entirely from usage events logged locally as you go, once enabled — `electron/analytics-db.js` stores them in a real SQLite database (via `sql.js`, SQLite compiled to WebAssembly) under `userData/analytics.sqlite`. WASM rather than a native addon like `better-sqlite3` on purpose: no per-platform native rebuild step, and the same engine can run in a browser extension later. Charts are hand-rolled Canvas 2D (`core/analytics-charts.js`) — no charting library dependency. Nothing here is ever sent anywhere; "Clear all data" wipes the local database. Dashboard overlay: `core/analytics-dashboard.js` (open via Cmd/Ctrl+K → "Open Usage Analytics", or Settings → Usage Analytics → "Open Dashboard").

**Cross-Device Clipboard Bridge** (Settings → Clipboard Bridge, off by default) — copy on one device, and it's paste-ready on another within a short TTL. Syncs through a relay you point at yourself: `scripts/clipboard-relay-server.js` is a minimal self-hostable reference implementation (`npm run clipboard-relay`, or `node scripts/clipboard-relay-server.js --port 8787`), and any HTTP endpoint implementing the same tiny `POST /put` / `GET /pull` / `GET /health` protocol works instead. Everything is end-to-end encrypted client-side (`core/clipboard-bridge.js`, PBKDF2 + AES-GCM keyed from a shared passphrase you set) before it ever reaches the relay, which only ever sees ciphertext plus a one-way channel id — never plaintext or the passphrase itself. Nothing syncs until both a relay URL and passphrase are set and the toggle is on; Settings → Clipboard Bridge always shows live connection status (Disconnected/Connecting/Connected/Error) and every synced item fires a notification, so syncing is never silent. Backend polling, encryption, and OS clipboard read/write all happen in `electron/main.js` (mirrors Native File Watcher Sync's split).

**Smart Notification Digest** (Settings → Notifications → Smart Notification Digest, off by default) — batches routine background-completion notifications (macro replay finished, Team Sync applied files, clipboard synced, ...) into one periodic native OS notification instead of firing one in-page toast per event. Failures always bypass the queue: `electron/preload.js`'s `notify()` gained an `urgent` option that shows immediately as both an in-page toast and a native notification regardless of digest state (used for a macro replay timing out and for Team Sync's background auto-sync failing) — the digest only ever delays "it worked" updates, never error visibility. Native notification delivery is a small `Notification.isSupported()`-guarded IPC handler (`notifications:show-native`) in `electron/main.js`.

**Command Palette (Cmd/Ctrl+K) for Everything** (Settings → Command Palette) — the connective tissue tying the rest of this list together, built last so there was something to index. One fuzzy-search overlay covering app actions, every settings page (jumps straight to it via `SettingsPanel.openSection`), installed plugins (toggle on/off), Prompt Library entries (insert), Macros (replay), installed + cached-marketplace Skills, and — once Local Semantic Search is enabled — past chats, merged in asynchronously as you type. Matching is a small hand-rolled fuzzy subsequence scorer (`core/command-palette.js`'s `fuzzyScore`, no library) rather than a plain substring filter, so abbreviations and scattered-letter queries still rank sensibly; each result shows a small group tag (Action/Settings/Plugins/Prompts/Macros/Skills/Chats/Analytics).

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
