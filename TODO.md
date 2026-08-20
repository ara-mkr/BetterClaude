# TODO

Known issues that are **out of scope** for the dead-subsystem removal pass
(plugin/HUD/macro/search) but should not get lost. None of these were caused
by that pass — they are recorded here so a later cleanup can pick them up.

## Orphaned IPC handlers (no callers)

Three `ipcMain.handle` registrations in `electron/main.js` have no caller
anywhere in `electron/preload.js`, `core/`, `ui/`, or `plugins/`. They were
verified orphaned *before* the removal pass, and the pass did not touch them.
Each is either a leftover from a refactor or a half-wired feature; decide
per-handler whether to wire up the caller or delete the handler.

| Channel | Location | Provenance |
| --- | --- | --- |
| `appearance:begin-custom` | `electron/main.js:654` | Not present at commit `64c71bf`; introduced by earlier uncommitted work, already caller-less. The adjacent `appearance:set-cosmetic` calls `beginCustomAppearance()` itself, so this handler looks redundant rather than merely unwired. |
| `clipboardBridge:get-status` | `electron/main.js:1168` | Pre-existing at commit `64c71bf`. Returns `clipboardBridgeStatus`; the Clipboard Bridge settings section reads status by another path. |
| `updater:get-status` | `electron/main.js:1319` | Pre-existing at commit `64c71bf`. Returns `updateStatus`; the Appearance section's update box is driven by push events instead. |

Note the changelog for the removal pass described all three as "pre-existing
against HEAD" — that is accurate for the latter two, but
`appearance:begin-custom` is newer than HEAD and came from prior uncommitted
work. It is still caller-less either way.

## `scripts/audit.js` — sibling-directory path assumption

`scripts/audit.js:486-487` reads the browser-extension sources:

```js
path.join(ROOT, "..", "BetterClaudeExtension", "content", "content-script.js")
path.join(ROOT, "..", "BetterClaudeExtension", "background", "service-worker.js")
```

The script originally assumed `BetterClaudeExtension/` was nested inside this
project. It is actually a **sibling** of `BETTERCLAUDE DESKTOP MAIN/`, so a
`..` was added locally just to get the audit to run. That makes the audit
depend on the checkout's parent-directory layout, which will break for anyone
who clones this directory on its own.

Fix properly by one of:

- resolving the extension path from an env var or a config value with a clear
  "extension checkout not found — skipping extension assertions" skip path, or
- making those assertions opt-in rather than failing/erroring when the sibling
  directory is absent.

This path bug is **pre-existing** and unrelated to the removal pass.

## Stale seeded built-in plugins in `userData`

`seedBuiltinPlugins()` (`electron/main.js:174`) only copies a built-in plugin
into `userData/plugins/` when the destination does **not** already exist, so an
edit to a shipped `plugins/*.claudeplugin.js` never reaches an existing
install. The removal pass edited `plugins/markdown-plus.claudeplugin.js` to
drop the retired `api.onMessage` call, but upgrading users keep the old seeded
copy and hit:

```
[BetterClaude] plugin "markdown-plus" failed to load
TypeError: api.onMessage is not a function
```

The plugin loader catches this, so it degrades to "markdown-plus silently stops
working" rather than crashing. `RETIRED_BUILTIN_PLUGINS` solves the *deleted*
built-in case; the *edited* built-in case is still open. Needs a re-seed policy
(version stamp or content comparison) that does not clobber third-party plugins
or user hand-edits in the same directory.
