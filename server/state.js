// In-memory state shared between REST endpoints and the WebSocket broadcaster.
// Plain object with subscribe/notify; nothing fancy.

import { EventEmitter } from 'node:events';

class State extends EventEmitter {
  constructor() {
    super();
    this.players = []; // [{ pid, name, model, ip }]
    this.activePids = []; // selected HEOS zones (first is treated as group leader)
    this.source = 'spotify'; // single source; kept in snapshot for forward compat
    this.nowPlayingByPid = {}; // pid -> { song|title, artist, album, image_url, state }
    this.volumes = {}; // pid -> 0-100
    this.recents = []; // [{ uri, label, sublabel, art, badge, ts }] — most-recent first, capped
  }

  // Derived: the now-playing of the active group leader (first activePid). UI's
  // "Now Playing" card reads this; per-zone subtitles read nowPlayingByPid[pid].
  get nowPlaying() {
    const lead = this.activePids[0];
    if (!lead) return null;
    const np = this.nowPlayingByPid[lead];
    return np ? { pid: lead, ...np } : null;
  }

  setPlayers(players) {
    if (samePlayerList(this.players, players)) return;
    this.players = players;
    this.emit('change', { type: 'players', players });
  }

  setActive(pids) {
    // Normalize to strings so leader-change comparisons against pids from
    // HEOS event payloads (URLSearchParams = always strings) match. Without
    // this, JSON-parsed numeric pids from the API request stay as numbers
    // and `activePids[0] === String(pid)` in setNowPlaying silently fails —
    // the master Now Playing card never updates.
    pids = pids.map(String);
    if (sameStringArray(this.activePids, pids)) return;
    const priorLeader = this.activePids[0];
    const priorDerived = this.nowPlaying;
    this.activePids = pids;
    this.emit('change', { type: 'active', activePids: pids });
    // Leader change → re-broadcast the derived nowPlaying so the master Now
    // Playing card flips to whatever the new leader is playing. Skip the
    // emit when the derived value didn't actually change (e.g. neither
    // leader had any media yet, so both are null).
    if (pids[0] !== priorLeader && !sameDerivedNowPlaying(priorDerived, this.nowPlaying)) {
      this.emit('change', { type: 'nowPlaying', nowPlaying: this.nowPlaying });
    }
  }

  setSource(source) {
    if (this.source === source) return;
    this.source = source;
    this.emit('change', { type: 'source', source });
  }

  setNowPlaying(pid, np) {
    const prior = this.nowPlayingByPid[pid] || null;
    if (sameNowPlayingBody(prior, np)) return;
    if (np) this.nowPlayingByPid[pid] = np;
    else delete this.nowPlayingByPid[pid];
    this.emit('change', { type: 'nowPlayingByPid', pid, nowPlaying: np || null });
    // If this pid is the active leader, also broadcast the legacy nowPlaying
    // shape so existing UI surfaces (and the App's accent/Backdrop) update
    // without needing a per-pid lookup.
    if (this.activePids[0] === String(pid)) {
      this.emit('change', { type: 'nowPlaying', nowPlaying: this.nowPlaying });
    }
  }

  setVolume(pid, level) {
    if (this.volumes[pid] === level) return;
    this.volumes[pid] = level;
    this.emit('change', { type: 'volume', pid, level });
  }

  setRecents(recents) {
    this.recents = recents;
    this.emit('change', { type: 'recents', recents });
  }

  snapshot() {
    return {
      players: this.players,
      activePids: this.activePids,
      source: this.source,
      nowPlaying: this.nowPlaying,
      nowPlayingByPid: this.nowPlayingByPid,
      volumes: this.volumes,
      recents: this.recents,
    };
  }
}

function sameStringArray(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function samePlayerList(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].pid !== b[i].pid || a[i].name !== b[i].name || a[i].model !== b[i].model || a[i].ip !== b[i].ip) return false;
  }
  return true;
}

// Compare the fields the UI actually renders (queue ids etc. change on every
// poll and would defeat dedupe). Operates on the per-pid body — pid is keyed
// in the map, not part of the body.
function sameNowPlayingBody(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.song === b.song && a.title === b.title
    && a.artist === b.artist && a.album === b.album
    && a.image_url === b.image_url && a.state === b.state;
}

// Compares the derived {pid, ...body} value (or null) used by setActive's
// re-broadcast guard.
function sameDerivedNowPlaying(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.pid === b.pid && sameNowPlayingBody(a, b);
}

export { State };
export const state = new State();
