// Build a fully-stubbed Express app for route tests.
// Returns { app, heos, spotify, state } so individual tests can adjust the stubs
// or assert on calls.

import { vi } from 'vitest';
import { createApp } from '../../server/app.js';
import { State } from '../../server/state.js';

export function buildTestApp(overrides = {}) {
  const heos = {
    applyGroup: vi.fn().mockResolvedValue(undefined),
    setVolume: vi.fn().mockResolvedValue(undefined),
    setPlayState: vi.fn().mockResolvedValue(undefined),
    playNext: vi.fn().mockResolvedValue(undefined),
    playPrevious: vi.fn().mockResolvedValue(undefined),
    getPlayers: vi.fn().mockResolvedValue([]),
    getNowPlaying: vi.fn().mockResolvedValue(null),
    getVolume: vi.fn().mockResolvedValue(null),
    getGroups: vi.fn().mockResolvedValue([]),
    getPlayState: vi.fn().mockResolvedValue(null),
    send: vi.fn().mockResolvedValue({}),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides.heos,
  };

  const spotify = {
    isConnected: vi.fn().mockReturnValue(true),
    search: vi.fn().mockResolvedValue({ tracks: { items: [] } }),
    getDevices: vi.fn().mockResolvedValue([]),
    transferPlayback: vi.fn().mockResolvedValue(undefined),
    play: vi.fn().mockResolvedValue(undefined),
    getPlayback: vi.fn().mockResolvedValue(null),
    seek: vi.fn().mockResolvedValue(undefined),
    pauseActive: vi.fn().mockResolvedValue(null),
    // Album-context play resolves the parent album URI; default mock returns
    // a synthetic album so the play handler can build a context+offset body.
    getTrack: vi.fn().mockResolvedValue({ album: { uri: 'spotify:album:default' } }),
    getAuthUrl: vi.fn().mockReturnValue('https://accounts.spotify.com/authorize?fake=1'),
    exchangeCode: vi.fn().mockResolvedValue(undefined),
    _accessTokenForDebug: vi.fn().mockResolvedValue('fake-token'),
    ...overrides.spotify,
  };

  const state = overrides.state || new State();
  // In-memory persist by default so tests don't touch ~/.heos-controller.
  const store = overrides.store || {};
  const persist = overrides.persist || {
    read: (name, fallback) => (name in store ? store[name] : fallback),
    write: (name, value) => { store[name] = value; },
  };
  const app = createApp({ heos, spotify, state, persist });
  // Most tests run as if the bootstrap finished. Tests that exercise the
  // readiness gate explicitly pass { ready: false }.
  if (overrides.ready !== false) app.locals.setHeosReady();
  return { app, heos, spotify, state, persist, store };
}
