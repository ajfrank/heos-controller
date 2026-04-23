// Tiny JSON-on-disk store for per-installation data (recents, device cache).
// Files contain user listening history and Spotify device IDs — not secrets,
// but worth keeping out of other users' read paths on multi-user hosts.
//
// Writes are sync — these endpoints are low-traffic (a few writes per minute
// at peak) and the JSON files stay small (≤a few KB).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  // writeFileSync only sets mode on creation; tighten if a pre-existing file
  // had looser perms (matches the pattern in spotify.js).
  try { fs.chmodSync(file, 0o600); }
  catch (e) { console.warn('[persist] chmod failed:', e.message); }
}
