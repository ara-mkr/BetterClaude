#!/usr/bin/env node
/**
 * Restores the executable bit on node-pty's `spawn-helper`.
 *
 * On macOS and Linux node-pty shells out to a small helper binary to launch the
 * child inside the PTY. Some npm versions extract the published tarball without
 * preserving the +x bit, and the failure mode is a bare "posix_spawnp failed"
 * from deep inside node-pty with no hint about permissions. Re-applying the bit
 * after install costs nothing and removes a genuinely confusing setup failure.
 */

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') process.exit(0);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prebuildsDir = path.join(projectRoot, 'node_modules', 'node-pty', 'prebuilds');

if (!existsSync(prebuildsDir)) process.exit(0);

let repaired = 0;
for (const entry of readdirSync(prebuildsDir)) {
  const helper = path.join(prebuildsDir, entry, 'spawn-helper');
  if (!existsSync(helper)) continue;
  if (statSync(helper).mode & 0o111) continue;
  chmodSync(helper, 0o755);
  repaired += 1;
}

if (repaired > 0) {
  console.log(
    `[betterclaude] restored exec bit on ${repaired} node-pty spawn-helper binary/binaries`,
  );
}
