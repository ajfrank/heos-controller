// Pure reducer for WebSocket change events arriving from server/state.js.
// Keep this file dependency-free so it can be unit-tested in isolation.

export function applyChange(cur, change) {
  switch (change.type) {
    case 'players': return { ...cur, players: change.players };
    case 'zones': return { ...cur, zones: change.zones };
    case 'activeZones': return { ...cur, activeZones: change.activeZones };
    case 'active': return { ...cur, activePids: change.activePids };
    case 'nowPlaying': return { ...cur, nowPlaying: change.nowPlaying };
    case 'nowPlayingByPid': {
      const next = { ...(cur.nowPlayingByPid || {}) };
      if (change.nowPlaying) next[change.pid] = change.nowPlaying;
      else delete next[change.pid];
      return { ...cur, nowPlayingByPid: next };
    }
    case 'volume': return { ...cur, volumes: { ...cur.volumes, [change.pid]: change.level } };
    case 'recents': return { ...cur, recents: change.recents };
    default: return cur;
  }
}
