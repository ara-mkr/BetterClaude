# ADR-0001: A full VS Code workbench in the Code tab

- **Status:** Proposed — waiting for approval. No Phase 3 code is written until it is approved.
- **Date:** 2026-09-27
- **Scope:** the Code tab's optional "full IDE" layout, real VS Code extensions (including OpenAI's Codex and Anthropic's Claude Code), and how today's Claude Code chat fits into it.

## 1. Context

The Code tab today is chat-first: a sidebar of projects and sessions, one Claude Code conversation driven over the host protocol (`electron/ide-chat.js`), and an on-demand right panel with Changes, Files (CodeMirror 6), Terminal and an Extensions list. The next step is a complete, VS Code-shaped IDE that can run real extensions — Codex in particular — without losing anything the chat does now.

Two facts decide most of this ADR:

1. **Codex and Claude Code are Node extensions.** Their manifests declare `main` and no `browser` entry, so they need a real Node extension host. Anything that only runs web extensions cannot load them.
2. **Codex uses proposed APIs.** It declares `enabledApiProposals: ["chatSessionsProvider", "languageModelProxy"]`. A VS Code build only lets an extension use proposed APIs when the product's `product.json` allow-lists that extension.

## 2. Requirements

- Runs Node VS Code extensions as-is, including Codex and Claude Code.
- VS Code's real layout and behaviour: activity bar, explorer, search, source control, run, extensions, editor groups and splits, diff editor, minimap, breadcrumbs, terminals, problems, output, command palette, quick open, keybindings.
- Extensions come from Open VSX only. The Microsoft Marketplace's terms don't allow third-party products.
- It is local-only and isolated. It binds `127.0.0.1` on a random port with a connection token, the token is never logged, and it has no access to BetterClaude's preload bridges or to claude.ai.
- Nothing is downloaded without an explicit OK that shows size and source. Checksums are verified, and it works offline once installed.
- The Claude Code chat stays first-class: approval cards, modes, the model menu, free models, sessions and usage.
- Chat-first stays the default. Today's lightweight CodeMirror editor remains the fallback when the workbench isn't installed.

## 3. Facts gathered for this decision (checked 2026-09-27)

| Item | Finding | Source |
| --- | --- | --- |
| Codex | Extension `openai.chatgpt` ("Codex – OpenAI's coding agent"), v26.5908.31748, on **Open VSX**, publisher **verified**. Platform-specific builds; the darwin-arm64 VSIX is **236 MB**. `main: ./out/extension.js`, **no `browser`**. `engines.vscode ^1.96.2`. Activation `onStartupFinished`, `onUri`. Proposed APIs `chatSessionsProvider`, `languageModelProxy`. Licence: "See https://openai.com/policies/row-terms-of-use" (proprietary). Sign-in: its own ChatGPT account flow. | `open-vsx.org/api/openai/chatgpt`, its `package.json` and `LICENSE.md` |
| Claude Code | Extension `anthropic.claude-code` ("Claude Code for VS Code"), v2.1.283, on **Open VSX**, publisher **verified**. The darwin-arm64 VSIX is **103 MB** (it bundles the CLI). `main: ./extension.js`, **no `browser`**. `engines.vscode ^1.94.0`. No proposed APIs. Licence: © Anthropic PBC, all rights reserved, subject to Anthropic's legal agreements. | `open-vsx.org/api/Anthropic/claude-code` and its `package.json` |
| Open VSX integrity | Every version publishes `sha256`, `signature` and `publicKey` files next to the VSIX. | the same API responses |
| OpenVSCode Server (Gitpod, MIT) | Latest release v1.109.5, published 2026-02-20. Assets are **Linux only**: no macOS or Windows builds. | GitHub releases API |
| code-server (Coder, MIT) | v4.139.1, published 2026-09-26, VS Code 1.139.1. macOS arm64 **196 MB**, macOS x64 216 MB, Windows x64 207 MB. Auth is by password (or none), **not** VS Code's connection token. | GitHub releases API |
| VSCodium REH-web (MIT) | v1.135.06055, published 2026-09-09. VS Code OSS's own web server, the same thing as `code serve-web`, with its native `--connection-token-file`. Builds: darwin-arm64 **131 MB**, darwin-x64 132 MB, win32-x64 130 MB. VSCodium's `product.json` **allow-lists `openai.chatgpt` for `languageModelProxy` and `chatSessionsProvider`**. Open VSX gallery and telemetry off by default. | GitHub releases API; `VSCodium/vscodium/product.json` |
| Microsoft `code serve-web` | Microsoft's server build is licensed only for use with Visual Studio Code products. | VS Code Server licence |

## 4. Options

### A. Embed a real VS Code workbench server (recommended)

Run a VS Code web server locally, show it in a `WebContentsView`, and keep BetterClaude's chat as its own side panel next to it. The server spawns a real Node extension host, so Node extensions like Codex and Claude Code run unmodified. This is the only family of options where that's true.

Candidate engines:

- **A1. VSCodium REH-web (recommended engine).**
  - MIT licence, macOS and Windows builds, and the smallest download (about 131 MB).
  - VS Code's own `--connection-token-file` auth, so the token never appears in `ps` output.
  - Open VSX gallery and telemetry off by default.
  - Codex's proposed APIs are already allow-listed.
  - Its VS Code base (1.135) is a few versions behind code-server's. Both are well above what Codex (1.96) and Claude Code (1.94) require.
- **A2. code-server (fallback engine).**
  - MIT licence, the newest VS Code base (1.139), and actively released.
  - A larger download (about 196 MB).
  - Password or no auth instead of a connection token. It would need a random password set as a login cookie through the view's session.
  - Its proposed-API allow-list for Codex would have to be patched into its `product.json`.
- **A3. OpenVSCode Server.** Rejected: there are no macOS or Windows builds, and releases stopped seven months ago.
- **A4. Microsoft's `code serve-web`.** Rejected on licence grounds.

Costs:
- A first-run download (with your OK) of about 131 MB, roughly 330 MB unpacked.
- One extra Node process for the server, plus one extension host per window. From VS Code's own footprint I'd expect about 200–400 MB RSS idle, and more with Codex. That's an estimate; it gets measured in 3b.
- A cold start of a few seconds. Mitigated by starting the server lazily and keeping it warm.

### B. Monaco plus `@codingame/monaco-vscode-api`

This brings VS Code's services into BetterClaude's renderer, with a Web Worker extension host. It's lighter and fully in-process.

- **Why it doesn't work here:** Codex and Claude Code ship only `main`, with no `browser` bundle, so a web extension host cannot load them. That's verified from their manifests, not assumed.
- **The only workaround brings back option A:** monaco-vscode-api can attach to a *remote* extension host, but that means running a VS Code server (A) anyway, plus hand-assembling the workbench from dozens of service packages.
- **Rejected** for this goal. It stays attractive for a future "web extensions only" mode inside the browser extension.

### C. Eclipse Theia

A full IDE framework with a Node plugin host that runs VS Code extensions and uses Open VSX natively. EPL-2.0.

- **Weight and maintenance:** we'd build and ship our own Theia application, with a large dependency tree and native modules to rebuild for Electron. That's a second IDE to maintain inside ours.
- **API compatibility:** Theia's VS Code API compatibility trails VS Code, and it has little support for proposed APIs, so Codex's `chatSessionsProvider` / `languageModelProxy` are unlikely to work.
- **Rejected** on weight, maintenance cost and extension compatibility.

## 5. Decision

**Option A with engine A1 (VSCodium REH-web), keeping A2 (code-server) as a documented fallback engine** if A1 turns out to block something in practice.

## 6. Design

### 6.1 Processes and lifecycle

- **Lazy, single server.** Started the first time the full-IDE layout opens, never at app launch. One server per app, with a workspace per project, opened as `?folder=<path>`.
- **Spawn arguments.** `127.0.0.1` on a random free port, `--connection-token-file <userData>/workbench/token` (mode 0600), `--server-data-dir`, `--user-data-dir` and `--extensions-dir` under `<userData>/workbench/`, and `--telemetry-level off`.
- **The token is secret.** It's 32 random bytes, never logged, never put in argv, and never in a URL a log line could print.
- **Environment.** The same scrubbed environment as the chat (`subscriptionEnv`), so no `ANTHROPIC_*` or provider overrides leak into the extension host. Plus the bridge variables in 6.4.
- **Teardown and crash handling.** Killed with its process group on quit, and when the last full-IDE window closes (after an idle grace period). A crash restarts it with backoff (1 s, 2 s, 4 s, at most 5 per minute), mirroring the existing Code view crash reload.

### 6.2 Installing the engine

- **Opt-in download.** Settings → Claude Code → IDE → "Install full IDE" shows the exact asset, its size (for example 131 MB) and its source (`github.com/VSCodium/vscodium/releases`), and downloads only after you click.
- **Verified cache.** The download is checked against VSCodium's published `.sha256`, unpacked into `<userData>/workbench/engine/<version>/`, and progress is shown.
- **Offline once installed.** "Check for updates" is a manual button that queries the GitHub releases API.
- **Fallback.** Not installed means the lightweight engine (today's CodeMirror panel), with the full-IDE toggle explaining what's missing.

### 6.3 The window and the chat

- **Two layouts per project.** **Chat-first** is today's layout and the default. **Full IDE** puts the workbench view on the left and centre, with BetterClaude's Claude Code chat as a secondary side bar on the right. It's the same transcript, composer, approval cards, modes, model menu, free models, sessions and usage, rendered by the same code (`ide-transcript.js` / `ide-workspace.js`). The toggle is remembered per project, and switching never restarts either side.
- **What VS Code provides natively:** activity bar, explorer, search, source control, run, extensions, editor groups, splits and drag-between-groups, the diff editor, minimap, breadcrumbs, dirty and "file changed on disk" handling, several real pty terminals, problems, output, command palette (⌘⇧P) and quick open (⌘P). VS Code's default keybindings come with it.
- **Keybinding conflicts.** BetterClaude's in-page shortcuts (⌘K palette, ⌘⇧P prompt picker) only listen inside the claude.ai page, so they don't fire while the workbench has focus. The exception is user-defined per-prompt shortcuts registered with `globalShortcut`, which are OS-wide and win everywhere; they'll be documented and flagged in the IDE settings.
- **The Changes panel folds into Source Control.** Commit & PR through `gh` becomes a Source Control action, provided by the companion extension below.

### 6.4 The bridge: a BetterClaude companion extension

A small first-party extension (`betterclaude.bridge`), installed into the workbench's own extensions directory. It talks to BetterClaude's main process over a localhost WebSocket. The URL and a per-launch random token arrive in the extension host's environment (`BC_BRIDGE_URL`, `BC_BRIDGE_TOKEN`). The workbench page itself gets no bridge. It provides:

- **Add selection to chat:** the editor context menu and a command send the file, range and text to the chat composer as an attachment.
- **Open file:** tool-row "Open file" links in the chat open the file in the workbench editor.
- **Review:** Claude's edits open in VS Code's diff editor (HEAD against the working tree) for review.
- **Status bar items:** the Claude plan-usage ring, the active model and mode, and a "Claude working / needs input" indicator. Git branch, sync and problems are native.
- **Theme sync** (6.6).
- **Commit & PR** in Source Control's title menu.

### 6.5 Extensions

- **Browsing and managing.** The workbench's own Extensions view does browse, search, details (README, changelog, ratings), install, uninstall, enable, disable, updates and recommendations against Open VSX. There's nothing to rebuild there. Today's Extensions panel stays for the lightweight engine.
- **Install location.** Everything installs into the IDE's own `--extensions-dir`.
- **Import from other editors.** A copy from VS Code, Cursor or Antigravity (or VS Code Insiders), chosen per extension, and never written back into those editors.
- **Integrity.** For installs BetterClaude performs (import, `.vsix` file, the curated catalog), the VSIX is checked against Open VSX's `sha256` and the publisher and verified badge are shown. Installs made from inside the workbench's own Extensions view go through VS Code's installer. VSCodium has no signature verification (Microsoft's `vsce-sign` is proprietary), so their trust model is the same as VSCodium desktop. A verifying local gallery proxy is possible later if that's not enough.
- **Codex:** installed from Open VSX through the UI during testing, taken as far as its sign-in screen, and stopped there. You sign in yourself; credentials are never typed or handled by BetterClaude. If Open VSX stops carrying it, "Install from .vsix…" takes a file you provide.
- **Claude Code for VS Code:** the same. It uses its own bundled CLI and its own login.

### 6.6 Theming

- **One BetterClaude theme, two outputs.** A VS Code colour theme is generated from the active theme's `core/tokens.js` values. It's shipped as a theme contribution in the companion extension, with live changes applied as `workbench.colorCustomizations` through the bridge. Fonts and ligatures (`editor.fontFamily`, `editor.fontLigatures`, `terminal.integrated.fontFamily`) follow BetterClaude's font settings.
- **The chat side panel** keeps today's `--bc-ide-*` tokens. The Phase 2 composer fix, one painted card layer, is re-checked there.

### 6.7 Security

- **The workbench view is walled off:**
  - it runs in its own session partition (`persist:bc-workbench`);
  - `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and **no preload**, so extension webviews, which are iframes inside it, can never reach `betterClaudeIDE` or the main app's preload;
  - it shares no cookies or storage with claude.ai.
- **Navigation is guarded:**
  - `will-navigate` only allows the server's origin;
  - `setWindowOpenHandler` denies new windows, and http(s) links go to the system browser;
  - all permission requests are denied except clipboard for the server origin.
- **Webview origins.** VS Code web serves extension webviews from a separate origin, by default Microsoft's `*.vscode-cdn.net`. That would break offline use and send requests to Microsoft. The engine's `product.json` will be pointed at a local per-webview origin instead: `{{uuid}}.localhost` on the server's port, which Chromium resolves to loopback. That keeps both isolation and offline use. It's verified in 3b before anything else is built on it.
- **Trust.** Extensions run with your user privileges, exactly as in VS Code. Open VSX is the only source, and the publisher and verified state are shown.
- **Settings.** Telemetry is forced off (`--telemetry-level off` plus `telemetry.telemetryLevel: "off"`).

### 6.8 Settings (Settings → Claude Code → IDE)

- The layout default (chat-first or full IDE).
- The engine: lightweight or full, with install and uninstall.
- The engine version and an update check.
- The extensions directory (read-only path plus "Reveal").
- Import from VS Code, Cursor or Antigravity.
- Telemetry, shown as off and locked.
- A note on OS-wide prompt shortcuts.

## 7. Risks and what 3b must verify first

1. **Webview origin.** Extension webviews must load offline from the local `{{uuid}}.localhost` origin, not `vscode-cdn.net`. If they can't, fall back to engine A2 or ship a patched `product.json`.
2. **Codex in a non-Microsoft build.** The proposals are allow-listed, but `languageModelProxy` may expect Copilot's model service. It needs to be confirmed that Codex activates and reaches its sign-in screen.
3. **OAuth and URI callbacks** (`onUri`) inside a web workbench in an Electron view: the redirect has to come back to the right window. Test with Codex's and Claude Code's sign-in, stopping before any credentials.
4. **Real memory and cold-start numbers** on your machine, measured, not estimated.
5. **Engine updates.** The engine's VS Code version must keep satisfying the `engines.vscode` of installed extensions, so an update check must warn before a downgrade breaks one.

## 8. Rollout (3b milestones)

1. **Engine:** download with your OK, verify, unpack, spawn, token, the guarded view, the webview-origin check, and quit and crash handling.
2. **Layout:** the chat-first ↔ full-IDE toggle, remembered per project; the chat as a secondary side bar; no state lost when switching.
3. **Bridge extension:** selection to chat, open file, diff review, status bar items, theme sync, Commit & PR.
4. **Extensions:** import from other editors, `.vsix` install, sha256 verification, Codex and Claude Code up to their sign-in screens.
5. **Settings, docs, README images** (synthetic data only), and the gate checks from the plan.

## 9. What needs your OK before or during 3b

- This ADR (engine A1, with A2 as the fallback).
- Downloading the engine: about 131 MB from VSCodium's GitHub releases, checksum-verified.
- Installing Codex (236 MB) and Claude Code for VS Code (103 MB) from Open VSX during testing, up to their sign-in screens. You sign in yourself.
- Whether to commit the uncommitted Phase 1–2 work on a branch before 3b starts.
