// In-memory state shared between REST endpoints and the WebSocket broadcaster.
// Plain object with subscribe/notify; nothing fancy.
//
// Zone-first model: the user picks named zones (config-driven, see zones.js).
// activePids is derived from activeZones + the resolved zones table; nothing
// outside this file should mutate it.

import { EventEmitter } from 'node:events';
import { pidsForZones } from './zones.js';

class State extends EventEmitter {
  constructor() {
    super();
    this.players = []; // [{ pid, name, model, ip }] — raw HEOS discovery
    this.zones = []; // [{ name, pids }] — resolved against players
    this.activeZones = []; // selected zone names; first treated as group leader source
    this.source = 'spotify';
    this.nowPlayingByPid = {};
    this.volumes = {};
    this.recents = [];
    // Auto-derived "frequent plays" — top items by play count over a sliding
    // window, computed in app.js on every play. Lives in state so the WS
    // snapshot/change broadcast includes it without a separate channel.
    this.frequent = [];
  }

  // Derived: flat unique pid list across active zones, in zone-config order.
  // The first pid is the candidate group leader (overridden by /api/play if
  // a different zone-pid is the one Spotify can actually see).
  get activePids() {
    return pidsForZones(this.zones, this.activeZones);
  }

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

  // Caller (server bootstrap) recomputes zones whenever players change. Kept
  // separate from setPlayers so tests can drive it directly without a real
  // zones.json round-trip.
  setZones(zones) {
    if (sameZones(this.zones, zones)) return;
    const priorPids = this.activePids;
    const priorDerived = this.nowPlaying;
    this.zones = zones;
    this.emit('change', { type: 'zones', zones });
    // Re-broadcast active/nowPlaying if the derived pid list changed (e.g. a
    // zone gained/lost a speaker because HEOS player names shifted).
    const nextPids = this.activePids;
    if (!sameStringArray(priorPids, nextPids)) {
      this.emit('change', { type: 'active', activePids: nextPids });
      const nextDerived = this.nowPlaying;
      if (!sameDerivedNowPlaying(priorDerived, nextDerived)) {
        this.emit('change', { type: 'nowPlaying', nowPlaying: nextDerived });
      }
    }
  }

  setActiveZones(names) {
    names = (names || []).map(String);
    if (sameStringArray(this.activeZones, names)) return;
    const priorPids = this.activePids;
    const priorDerived = this.nowPlaying;
    this.activeZones = names;
    this.emit('change', { type: 'activeZones', activeZones: names });
    const nextPids = this.activePids;
    // Keep emitting the legacy `active` change so any pid-aware internals
    // (and old test fixtures) still get notified. UI doesn't rely on it.
    if (!sameStringArray(priorPids, nextPids)) {
      this.emit('change', { type: 'active', activePids: nextPids });
    }
    if (nextPids[0] !== priorPids[0] && !sameDerivedNowPlaying(priorDerived, this.nowPlaying)) {
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

  setFrequent(frequent) {
    if (sameTileList(this.frequent, frequent)) return;
    this.frequent = frequent;
    this.emit('change', { type: 'frequent', frequent });
  }

  snapshot() {
    return {
      players: this.players,
      zones: this.zones,
      activeZones: this.activeZones,
      activePids: this.activePids,
      source: this.source,
      nowPlaying: this.nowPlaying,
      nowPlayingByPid: this.nowPlayingByPid,
      volumes: this.volumes,
      recents: this.recents,
      frequent: this.frequent,
    };
  }
}

function sameTileList(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].uri !== b[i].uri) return false;
  }
  return true;
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

function sameZones(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name) return false;
    if (!sameStringArray(a[i].pids, b[i].pids)) return false;
  }
  return true;
}

function sameNowPlayingBody(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.song === b.song && a.title === b.title
    && a.artist === b.artist && a.album === b.album
    && a.image_url === b.image_url && a.state === b.state;
}

function sameDerivedNowPlaying(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.pid === b.pid && sameNowPlayingBody(a, b);
}

export { State };
export const state = new State();
