// initHeosState hydrates per-player state from a fresh HEOS connection.
// M5: per-player calls should fan out in parallel.

import { describe, it, expect, vi } from 'vitest';
import { initHeosState, refreshDeviceCache } from '../../server/app.js';
import { State } from '../../server/state.js';

function fakeHeos({ getVolumeDelay = 0, getNowPlayingDelay = 0 } = {}) {
  const calls = { getVolume: [], getNowPlaying: [] };
  return {
    calls,
    getPlayers: vi.fn().mockResolvedValue([
      { pid: '1', name: 'A' }, { pid: '2', name: 'B' }, { pid: '3', name: 'C' },
    ]),
    getVolume: vi.fn(async (pid) => {
      calls.getVolume.push({ pid, t: Date.now() });
      await new Promise((r) => setTimeout(r, getVolumeDelay));
      return 50;
    }),
    getNowPlaying: vi.fn(async (pid) => {
      calls.getNowPlaying.push({ pid, t: Date.now() });
      await new Promise((r) => setTimeout(r, getNowPlayingDelay));
      return { song: 'X' };
    }),
    getPlayState: vi.fn().mockResolvedValue('play'),
    on: vi.fn(),
    off: vi.fn(),
  };
}

describe('initHeosState', () => {
  it('seeds players, volumes, and per-pid nowPlaying from HEOS', async () => {
    const heos = fakeHeos();
    const state = new State();
    await initHeosState({ heos, state, log: { warn: () => {} } });
    expect(state.players.map((p) => p.pid)).toEqual(['1', '2', '3']);
    expect(state.volumes).toMatchObject({ 1: 50, 2: 50, 3: 50 });
    // F5: every hydrated player gets its own nowPlaying entry — no longer a
    // last-write-wins single field.
    expect(Object.keys(state.nowPlayingByPid).sort()).toEqual(['1', '2', '3']);
    expect(state.nowPlayingByPid['3']).toMatchObject({ song: 'X' });
  });

  // M5: serial hydration was the slowest part of bootstrap; per-player work
  // should run in parallel. With a 50ms artificial delay per getVolume call,
  // serial hydration would take >150ms; parallel < ~80ms.
  it('hydrates players in parallel (faster than serial sum)', async () => {
    const heos = fakeHeos({ getVolumeDelay: 40 });
    const state = new State();
    const start = Date.now();
    await initHeosState({ heos, state, log: { warn: () => {} } });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(120);
    expect(heos.getVolume).toHaveBeenCalledTimes(3);
  });

  it('logs and continues when one player fails to hydrate', async () => {
    const heos = fakeHeos();
    heos.getVolume.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const warn = vi.fn();
    const state = new State();
    await initHeosState({ heos, state, log: { warn } });
    expect(warn).toHaveBeenCalled();
    // The other two players still hydrated.
    expect(Object.keys(state.volumes).length).toBeGreaterThanOrEqual(2);
  });
});

describe('refreshDeviceCache', () => {
  function inMemPersist(initial = {}) {
    const store = { ...initial };
    return {
      store,
      read: (name, fallback) => (name in store ? store[name] : fallback),
      write: (name, value) => { store[name] = value; },
    };
  }

  it('seeds pid → device_id from currently-visible Spotify devices', async () => {
    const state = new State();
    state.setPlayers([{ pid: '1', name: 'Bar' }, { pid: '2', name: 'Living Room' }]);
    const persist = inMemPersist();
    const spotify = {
      getDevices: vi.fn().mockResolvedValue([
        { id: 'd-bar', name: 'Bar' },
        { id: 'd-lr', name: 'Living Room' },
        { id: 'd-other', name: 'Echo Dot' },
      ]),
    };
    await refreshDeviceCache({ spotify, state, persist });
    expect(persist.store['spotify-devices.json']).toEqual({ '1': 'd-bar', '2': 'd-lr' });
  });

  it('is silent when Spotify is unreachable (no throw, no write)', async () => {
    const state = new State();
    state.setPlayers([{ pid: '1', name: 'Bar' }]);
    const persist = inMemPersist();
    const spotify = { getDevices: vi.fn().mockRejectedValue(new Error('network down')) };
    await expect(refreshDeviceCache({ spotify, state, persist })).resolves.toBeUndefined();
    expect(persist.store).toEqual({});
  });

  it("does not rewrite the cache file when nothing changed (avoids I/O thrash)", async () => {
    const state = new State();
    state.setPlayers([{ pid: '1', name: 'Bar' }]);
    const persist = inMemPersist({ 'spotify-devices.json': { '1': 'd-bar' } });
    const writeSpy = vi.spyOn(persist, 'write');
    const spotify = { getDevices: vi.fn().mockResolvedValue([{ id: 'd-bar', name: 'Bar' }]) };
    await refreshDeviceCache({ spotify, state, persist });
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
