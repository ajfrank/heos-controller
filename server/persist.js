// Tiny JSON-on-disk store for non-secret per-installation data (recents).
// Spotify tokens stay in their own file with 0600 perms; these are user-data
// and don't need that.
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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(value, null, 2));
}
