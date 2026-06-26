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

// Sweep stale .tmp files left behind by SIGKILL / power-loss between writeFileSync(tmp)
// and renameSync below. Without this, on a Pi these accumulate forever and bloat
// ~/.heos-controller/ over months. 1h is well past any legitimate atomic-rename window
// (writes are sync + small), so anything older is unrecoverable garbage. Best-effort:
// any error (missing dir, permission, race with another writer) is swallowed — sweeping
// is a hygiene chore, not a correctness requirement.
function sweepStaleTmpFiles() {
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    const now = Date.now();
    const ONE_HOUR_MS = 60 * 60 * 1000;
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (!name.endsWith('.tmp')) continue;
      try {
        const full = path.join(DATA_DIR, name);
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > ONE_HOUR_MS) fs.unlinkSync(full);
      } catch { /* file disappeared / permission — fine */ }
    }
  } catch { /* dir gone — fine */ }
}
sweepStaleTmpFiles();

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
