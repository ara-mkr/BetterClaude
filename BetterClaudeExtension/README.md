# BetterClaude — browser extension build

A Manifest V3 (Chrome/Edge/Brave) packaging of BetterClaude. It reuses the
exact same `core/` and `ui/` sources the Electron app (`../electron/`) uses —
nothing there was forked or duplicated — and adds a new extension-side
backend (`background/`, `content/`) in place of `electron/main.js` +
`electron/preload.js`.

## Build & load it

```bash
cd BetterClaudeExtension
npm install
npm run build        # bundles core/ + ui/ + plugins into dist/
```

Then, in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select this `BetterClaudeExtension/` folder.

`npm run watch` rebuilds on every change to `../core`, `../ui`, `../themes`,
or `../plugins` — reload the extension in `chrome://extensions` (or hit the
per-extension refresh icon) after each rebuild; Chrome doesn't hot-reload
extensions the way `electron .` does.

`npm run zip` produces `betterclaude-extension.zip`, ready to upload to the
Chrome Web Store dashboard or side-load elsewhere.

## Architecture: what maps to what

| Electron app | Extension | Notes |
| --- | --- | --- |
| `electron/main.js` (`ipcMain.handle`) | `background/service-worker.js` | Same message-name-per-feature shape, routed through `chrome.runtime.onMessage` instead of IPC. |
| `electron/preload.js` (`bootstrap()`) | `content/content-script.js` | Near line-for-line port; `ipcRenderer.invoke`/`.on` → `content/bridge.js`'s `bg()`/`onBroadcast()`. |
| `core/*.js`, `ui/*.js` | `dist/*.bundle.js` (bundled by `build.js`) | **Unmodified** — the exact same files, esbuild-bundled into content-script-loadable IIFEs instead of required into a preload script. |
| `electron-store` | `chrome.storage.local` | `core/settings-schema.js`'s `mergeDefaults`/`DEFAULT_SETTINGS` unchanged. |
| Native `Notification` | `chrome.notifications` | |
| `globalShortcut` (arbitrary bindings) | `chrome.commands` (manifest.json) | See limitation below. |
| `BrowserWindow` (forked/tiled window) | `chrome.tabs.create` | A new tab, not a tiled window — see limitation below. |
| chokidar (`fs.watch`) | File System Access API + polling (`content/file-watcher.js`) | Runs entirely in-page; no background round trip needed. |
| `git` shell-out (Team Sync) | GitHub REST API (`background/team-sync.js`) | GitHub repos only. |
| sql.js (WASM SQLite) | Flat event array in `chrome.storage.local` | This app's own Electron-side comment already calls the analytics corpus "personal-scale"; a plain array covers that without pulling a WASM binary into a service worker Chrome can kill at any time. |

## Real limitations (not bugs to silently work around)

These are hard platform differences between an Electron app and a Manifest
V3 extension, not oversights:

- **No arbitrary custom plugins.** The Electron app's `plugins:*` IPC read
  `*.claudeplugin.js` files off disk and `require()`'d them (chosen there
  specifically to satisfy claude.ai's CSP without `eval`). An extension has
  no filesystem to read user-authored plugin files from, and there is no
  CSP-safe way to execute arbitrary fetched/pasted JS. Only the same 12
  built-in plugins ship, pre-bundled at build time and toggled on/off — same
  as before, just not extensible without editing `../plugins/` and
  rebuilding.
- **No window chrome.** Frameless-window controls, the always-on-top toggle,
  the tray icon, and the startup splash screen don't exist for a browser
  tab. Dropped, not faked.
- **No auto-updater.** The Chrome Web Store (or your own side-loading
  process) handles that instead of `electron-updater`.
- **Global shortcuts are static, not per-item.** `chrome.commands` only
  allows a small, manifest-declared set of shortcuts (see `manifest.json`):
  Toggle Settings, Command Palette, Prompt Picker, Toggle Zen Mode. The
  Electron app's per-prompt and per-macro custom OS-wide shortcuts have no
  MV3 equivalent — there's no API to register a dynamic accelerator from JS.
- **Branching opens a tab, not a tiled window.** `chrome.tabs.create` has no
  concept of "resize the main window to make room" the way `BrowserWindow`
  does.
- **Team Sync is GitHub-only.** The GitHub REST API (tree + blob endpoints)
  replaces `git clone`; any other git host won't work here even though the
  Electron version's raw `git` shell-out didn't care.
- **Polling is clamped to 1 minute.** `chrome.alarms` (the only interval
  primitive that survives a service worker being killed for idling) has a
  practical 1-minute floor. Clipboard Bridge's default 5-second poll and Team
  Sync's poll both run at that reduced cadence here.
- **Skill "install" downloads the repo zip**, it doesn't unzip into a
  per-skill folder (no filesystem to unzip into). You still upload
  `SKILL.md` to claude.ai's own Settings → Capabilities yourself either way —
  same manual last step the Electron app already required.
- **Inline repo/local diffing for Team Sync conflicts isn't wired up yet**
  (`panelHost.getTeamSyncDiff` is a stub) — conflicts are still tracked and
  surfaced, just without a diff view in this build yet.

## Directory layout

```
BetterClaudeExtension/
  manifest.json
  build.js              esbuild bundler + static-asset copier (see below)
  background/
    service-worker.js    MV3 background — settings/themes/skills/teamSync/analytics/etc.
    team-sync.js         GitHub REST API port of ../electron/team-sync.js
  content/
    bridge.js             chrome.runtime messaging, mirrors ipcRenderer
    file-watcher.js        File System Access API port of chokidar watching
    content-script.js      port of ../electron/preload.js's bootstrap()
  popup/                  toolbar popup (tray-menu analog)
  icons/
  dist/                   generated by `npm run build` — gitignored
```

`build.js` bundles `../core/index.js`, `../ui/settings-panel/panel.js`,
`../ui/settings-panel/css-editor.js`, `../ui/mini-game/snake.js`, and each
`../plugins/*.claudeplugin.js` into browser-loadable IIFEs under `dist/`, and
copies `../ui/**/*.css`, `../themes/*.css`, and `../assets/` as static
resources. None of those source files are modified for this build.
