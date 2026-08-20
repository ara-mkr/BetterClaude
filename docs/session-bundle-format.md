# `.bcbundle` format (Team Sync 2.0 — Session Bundle export/import)

A `.bcbundle` file is a plain zip archive (built with `adm-zip`, readable with
any standard zip tool) containing:

```
manifest.json
transcripts/<sessionId>.jsonl   (one per included/redacted session)
diff.patch                       (optional, only when the exporter opted in)
```

## `manifest.json`

```jsonc
{
  "bundleVersion": 1,
  "projectName": "my-project",
  "generatedAt": "2026-08-20T13:04:22.101Z", // ISO-8601 UTC
  "cliVersion": "1.2.3",                      // `claude --version` output, or null if unavailable
  "gitCommit": "a1b2c3d4e5f6...",              // `git rev-parse HEAD` at export time, or null
  "author": "akhilraja-amudhan",               // OS username of whoever exported
  "diffIncluded": true,
  "sessions": [
    {
      "sessionId": "07e7405b-5cb3-4c64-b380-68ef9d11489f",
      "status": "included",  // "included" | "redacted" | "excluded"
      "messageCount": 42,
      "firstTimestamp": "2026-08-19T02:11:00.000Z",
      "lastTimestamp": "2026-08-19T03:47:12.000Z",
      "redactionCount": 0,   // number of lines rewritten during redaction, 0 if none
      "reason": null         // set for "excluded" sessions, e.g. "excluded by user"
    }
  ]
}
```

`status` is always one of the three values above. Excluded sessions get a
**placeholder** manifest entry (`status: "excluded"`, `messageCount` /
`firstTimestamp` / `lastTimestamp` all `null`, no transcript file in the
archive) rather than being omitted entirely — chosen so an importer sees "1
session excluded" honestly instead of a bundle that silently looks
incomplete. The tradeoff: the manifest still reveals that a session with that
id existed and why it was excluded, even though its content, timing, and size
never leave the exporter's machine.

## `transcripts/<sessionId>.jsonl`

A byte-for-byte copy of the relevant lines from the real `claude` CLI's own
on-disk transcript (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`,
JSON Lines, Anthropic Messages API shape), **or**, for a `"redacted"` session,
the same file with every matched secret substring replaced by
`[REDACTED:<pattern-id>]`. Redaction happens once, at export time — never
inside the CLI's own file, only inside the copy written into the bundle.

## Versioning

`bundleVersion` bumps only when the *meaning* of an existing field changes,
matching the convention `BETTERCLAUDE OFFICIAL`'s session history log uses
(`HISTORY_EVENT_VERSION` in `src/sessionHistory/types.ts`). A reader should
treat an unknown-but-higher version as "newer than I understand" and fail
soft rather than crash.

## What this format deliberately does not contain

- Any claude.ai web chat data. Every byte in a bundle came from a local file
  the `claude` CLI subprocess wrote to disk on its own, or from `git`'s own
  stdout — see `electron/session-bundle.js` for the two read paths.
- Credentials, tokens, or Claude Code's own config/auth state — the exporter
  never reads any of that, and the mandatory redaction pass
  (`electron/session-bundle.js`'s `exportSessionBundle`) refuses to write a
  session containing an unresolved secret match regardless of what the UI
  believes was already handled.
