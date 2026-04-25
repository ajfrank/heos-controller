// Static zones config: maps zone names → speaker names. Edit zones.json to
// rename or re-cluster speakers; speakers not listed in any zone are hidden
// from the UI and never receive playback. The server is the source of truth
// for the zone shape (UI only sees what's resolved).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cached = null;
function loadConfig() {
  if (cached) return cached;
  const file = path.join(__dirname, 'zones.json');
  // Bad JSON / missing file is rare but recoverable on a long-running Pi
  // (SD-card bit rot, an aborted hand-edit). Falling back to [] keeps the
  // HTTP server, /healthz, and OAuth flow alive so the user has a way back
  // in instead of a tight retry loop in journalctl. The log line includes
  // a one-shot recovery command so the fix doesn't require remembering
  // the path.
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.zones || !Array.isArray(parsed.zones)) {
      throw new Error('missing top-level "zones" array');
    }
    cached = parsed.zones.map((z) => ({
      name: String(z.name),
      speakers: (z.speakers || []).map(String),
    }));
  } catch (e) {
    console.warn(
      `[zones] zones.json unreadable (${e.message}) — booting with no zones; ` +
        'the UI will show an empty state. Restore from git: ' +
        'cd ~/heos-controller && git checkout server/zones.json',
    );
    cached = [];
  }
  return cached;
}

// Resolve the zones config against the current HEOS player list. Speaker name
// match is case-insensitive + trimmed. Returns [{ name, pids }, ...] in config
// order. Zones whose speakers don't resolve to any known pid are omitted (and
// the missing speakers logged) so the UI never shows a phantom zone.
export function resolveZones(players, log = console) {
  const cfg = loadConfig();
  const byName = new Map(
    players.map((p) => [(p.name || '').trim().toLowerCase(), p]),
  );
  const out = [];
  for (const z of cfg) {
    const pids = [];
    const missing = [];
    for (const sp of z.speakers) {
      const player = byName.get(sp.trim().toLowerCase());
      if (player) pids.push(String(player.pid));
      else missing.push(sp);
    }
    if (missing.length) {
      log.warn?.(`[zones] ${z.name}: speaker(s) not found in HEOS — ${missing.join(', ')}`);
    }
    if (pids.length) out.push({ name: z.name, pids });
  }
  return out;
}

// Expand a list of zone names to a flat unique pid list. Preserves zone order
// then in-zone speaker order so the leader-pick in /api/play stays stable.
export function pidsForZones(zones, activeZoneNames) {
  const seen = new Set();
  const out = [];
  for (const name of activeZoneNames) {
    const z = zones.find((zone) => zone.name === name);
    if (!z) continue;
    for (const pid of z.pids) {
      if (!seen.has(pid)) { seen.add(pid); out.push(pid); }
    }
  }
  return out;
}

// For tests: clear the cached zones.json so a fresh require picks up edits.
export function _resetZonesCache() { cached = null; }
