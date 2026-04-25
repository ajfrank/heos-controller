// Tiny JSON-on-disk store for per-installation data (recents, device cache).
// Files contain user listening history and Spotify device IDs — not secrets,
// but worth keeping out of other users' read paths on multi-user hosts.
//
// Writes are sync — these endpoints are low-traffic (a few writes per minute
// at peak) and the JSON files stay small (≤a few KB).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DATA_DIR = path.join(os.homedir(), '.heos-controller');

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DATA_DIR, name);
  // Atomic write: SIGKILL or power loss between truncate and full write would
  // otherwise leave the file empty, dropping every recent / Often / device-id
  // entry. Write to a sibling .tmp first, then rename — rename is atomic on
  // ext4/APFS, so readers see either the old version or the new one, never a
  // half-written one.
  // Per-writer tmp suffix (pid + random) so the play handler and the 60s
  // background device-cache poll can't clobber each other's tmp file when
  // they both target spotify-devices.json at the same instant.
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); }
  catch (e) { console.warn('[persist] chmod failed:', e.message); }
  fs.renameSync(tmp, file);
}
