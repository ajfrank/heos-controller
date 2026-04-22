// REST route tests via supertest. heos + spotify are stubbed by buildTestApp;
// state is a fresh State instance per test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { buildTestApp } from '../helpers/build-test-app.js';

// Seed convenience: most tests want a player + a zone wrapping that player so
// /api/zones/active and /api/play have something to grab. Default zone name
// is the player name capitalised; pass explicit zones if you need otherwise.
function seedPlayersAndZones(state, players, zones) {
  state.setPlayers(players);
  state.setZones(zones || players.map((p) => ({ name: p.name, pids: [p.pid] })));
}

describe('GET /api/state', () => {
  it('returns the state snapshot plus spotifyConnected', async () => {
    const { app, state } = buildTestApp();
    seedPlayersAndZones(state, [{ pid: '1', name: 'K' }]);
    state.setActiveZones(['K']);
    state.setVolume('1', 50);
    const res = await request(app).get('/api/state');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      players: [{ pid: '1', name: 'K' }],
      zones: [{ name: 'K', pids: ['1'] }],
      activeZones: ['K'],
      activePids: ['1'],
      volumes: { 1: 50 },
      spotifyConnected: true,
    });
  });
});

describe('POST /api/zones/active', () => {
  it('400s when zones is missing', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/zones/active').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/zones/);
  });

  it('updates state and calls heos.applyGroup with the resolved pids', async () => {
    const { app, heos, state } = buildTestApp();
    seedPlayersAndZones(state,
      [{ pid: '1', name: 'A' }, { pid: '2', name: 'B' }],
      [{ name: 'Upstairs', pids: ['1', '2'] }],
    );
    const res = await request(app).post('/api/zones/active').send({ zones: ['Upstairs'] });
    expect(res.status).toBe(200);
    expect(state.activeZones).toEqual(['Upstairs']);
    expect(state.activePids).toEqual(['1', '2']);
    expect(heos.applyGroup).toHaveBeenCalledWith(['1', '2']);
  });

  it('500s with the heos error message when applyGroup throws', async () => {
    const { app, state } = buildTestApp({ heos: { applyGroup: vi.fn().mockRejectedValue(new Error('group fail')) } });
    seedPlayersAndZones(state, [{ pid: '1', name: 'A' }]);
    const res = await request(app).post('/api/zones/active').send({ zones: ['A'] });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('group fail');
  });

  // T1.2: client+server stay consistent on applyGroup failure. Without rollback,
  // a 500 leaves state.activeZones holding zones the user already abandoned,
  // and the next /api/play acts on stale zones.
  it('rolls back state.activeZones when applyGroup rejects', async () => {
    const { app, state } = buildTestApp({
      heos: { applyGroup: vi.fn().mockRejectedValue(new Error('syserrno=-9')) },
    });
    seedPlayersAndZones(state,
      [{ pid: '1', name: 'A' }, { pid: '2', name: 'B' }],
      [{ name: 'Upstairs', pids: ['1'] }, { name: 'Porch', pids: ['2'] }],
    );
    state.setActiveZones(['Upstairs']);
    const res = await request(app).post('/api/zones/active').send({ zones: ['Upstairs', 'Porch'] });
    expect(res.status).toBe(500);
    // setActiveZones was attempted optimistically, then reverted to the prior selection.
    expect(state.activeZones).toEqual(['Upstairs']);
  });

  it('rolls back to an empty selection when no zones were previously active', async () => {
    const { app, state } = buildTestApp({
      heos: { applyGroup: vi.fn().mockRejectedValue(new Error('boom')) },
    });
    seedPlayersAndZones(state, [{ pid: '1', name: 'A' }]);
    // No prior selection.
    const res = await request(app).post('/api/zones/active').send({ zones: ['A'] });
    expect(res.status).toBe(500);
    expect(state.activeZones).toEqual([]);
  });

  // M3: stale clients can submit zone names the server no longer knows about.
  it('400s with the unknown zone name when a zone is not in state.zones', async () => {
    const { app, state } = buildTestApp();
    seedPlayersAndZones(state, [{ pid: '1', name: 'A' }]);
    const res = await request(app).post('/api/zones/active').send({ zones: ['A', 'Ghost'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ghost/);
  });
});

describe('GET /api/search', () => {
  it('400s without q', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/search');
    expect(res.status).toBe(400);
  });

  it('passes track,playlist,album to spotify.search and returns the wrapped result', async () => {
    const { app, spotify } = buildTestApp();
    spotify.search.mockResolvedValue({ tracks: { items: [{ name: 'X' }] } });
    const res = await request(app).get('/api/search?q=hello');
    expect(spotify.search).toHaveBeenCalledWith('hello', ['track', 'playlist', 'album']);
    expect(res.body).toEqual({ ok: true, source: 'spotify', results: { tracks: { items: [{ name: 'X' }] } } });
  });

  // M2: cap query length so a giant ?q= can't fill memory or hit Spotify limits.
  it('accepts a 100-character q and rejects 101', async () => {
    const { app } = buildTestApp();
    const ok = await request(app).get(`/api/search?q=${'a'.repeat(100)}`);
    expect(ok.status).toBe(200);
    const tooLong = await request(app).get(`/api/search?q=${'a'.repeat(101)}`);
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toMatch(/100 characters/);
  });
});

describe('POST /api/play', () => {
  function seed(state, players, activeZoneNames, zones) {
    state.setPlayers(players);
    state.setZones(zones || players.map((p) => ({ name: p.name, pids: [p.pid] })));
    if (activeZoneNames) state.setActiveZones(activeZoneNames);
  }

  it('400s when no zones are active', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/play').send({ uri: 'spotify:track:1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No active zones/);
  });

  it('400s when uri is missing', async () => {
    const { app, state } = buildTestApp();
    seed(state, [{ pid: '1', name: 'Bar' }], ['Bar']);
    const res = await request(app).post('/api/play').send({});
    expect(res.status).toBe(400);
  });

  // T2.3: malformed URIs would otherwise surface as opaque Spotify 4xx text.
  // Validate at the entry point so the error is actionable.
  it('400s on a malformed uri instead of forwarding it to Spotify', async () => {
    const { app, state, spotify } = buildTestApp();
    seed(state, [{ pid: '1', name: 'Bar' }], ['Bar']);
    const res = await request(app).post('/api/play').send({ uri: 'junk' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Spotify URI/i);
    expect(spotify.getDevices).not.toHaveBeenCalled();
  });

  it.each([
    'spotify:track:abc123',
    'spotify:album:xyz',
    'spotify:playlist:p1',
    'spotify:artist:a1',
    'spotify:episode:e1',
    'spotify:show:s1',
  ])('accepts valid Spotify URI %s', async (uri) => {
    const { app, state, spotify } = buildTestApp();
    seed(state, [{ pid: '1', name: 'Bar' }], ['Bar']);
    spotify.getDevices.mockResolvedValue([{ id: 'd', name: 'Bar' }]);
    const res = await request(app).post('/api/play').send({ uri });
    expect(res.status).toBe(200);
  });

  it.each([
    'spotify:user:foo',
    'spotify:local:bar',
    'http://example.com/x',
    '',
    'spotify:track:',
    'spotify::abc',
  ])('rejects invalid uri %s', async (uri) => {
    const { app, state } = buildTestApp();
    seed(state, [{ pid: '1', name: 'Bar' }], ['Bar']);
    const res = await request(app).post('/api/play').send({ uri });
    expect(res.status).toBe(400);
  });

  // T1.4: when the Spotify call throws the SPOTIFY_REAUTH_REQUIRED sentinel,
  // routes translate it to 401 + code:'reauth' so the UI flips its banner.
  it('returns 401 + code:"reauth" when Spotify throws SPOTIFY_REAUTH_REQUIRED', async () => {
    // Cache a deviceId so the route still has a leader and reaches the
    // transferPlayback step where reauth is surfaced.
    const ctx2 = buildTestApp();
    seed(ctx2.state, [{ pid: '1', name: 'Bar' }], ['Bar']);
    ctx2.store['spotify-devices.json'] = { '1': 'd-cached' };
    ctx2.spotify.transferPlayback.mockRejectedValue(new Error('SPOTIFY_REAUTH_REQUIRED'));
    const res = await request(ctx2.app).post('/api/play').send({ uri: 'spotify:track:abc' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'reauth' });
  });

  it('GET /api/search also translates SPOTIFY_REAUTH_REQUIRED → 401 reauth', async () => {
    const { app, spotify } = buildTestApp();
    spotify.search.mockRejectedValue(new Error('SPOTIFY_REAUTH_REQUIRED'));
    const res = await request(app).get('/api/search?q=hi');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('reauth');
  });

  it('404s with a clear message when no zone is visible AND no cached deviceId exists', async () => {
    const { app, state, spotify } = buildTestApp();
    seed(state, [{ pid: '1', name: 'Bar' }], ['Bar']);
    spotify.getDevices.mockResolvedValue([{ id: 'd-other', name: 'Echo Dot' }]);
    const res = await request(app).post('/api/play').send({ uri: 'spotify:track:abc' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Bar/);
    expect(res.body.error).toMatch(/Echo Dot/);
    expect(res.body.error).toMatch(/Open Spotify on your phone/);
  });

  it('uses a cached deviceId to wake a sleeping speaker via transferPlayback', async () => {
    const { app, state, spotify, heos, store } = buildTestApp();
    // Seed the cache as if we'd previously played to "Bar" successfully.
    store['spotify-devices.json'] = { '1': 'd-bar' };
    seed(state, [{ pid: '1', name: 'Bar' }], ['Bar']);
    // Spotify currently sees nothing relevant (speaker idle).
    spotify.getDevices.mockResolvedValue([{ id: 'd-other', name: 'Echo Dot' }]);
    const res = await request(app).post('/api/play').send({ uri: 'spotify:track:abc' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, via: 'spotify-connect-wake' });
    expect(heos.applyGroup).toHaveBeenCalledWith(['1']);
    // Wake path uses play=true to start playback in one round trip.
    expect(spotify.transferPlayback).toHaveBeenCalledWith('d-bar', true);
    expect(spotify.play).toHaveBeenCalledWith('d-bar', { uris: ['spotify:track:abc'] });
  });

  it('caches the deviceId after a successful live play so future taps can wake it', async () => {
    const { app, state, spotify, store } = buildTestApp();
    seed(state, [{ pid: '1', name: 'Bar' }], ['Bar']);
    spotify.getDevices.mockResolvedValue([{ id: 'd-bar', name: 'Bar' }]);
    await request(app).post('/api/play').send({ uri: 'spotify:track:abc' });
    expect(store['spotify-devices.json']).toEqual({ '1': 'd-bar' });
  });

  it('clears a stale cache entry and surfaces the actionable 404 when wake hits Device not found', async () => {
    // Without the 500→404 conversion, the first tap looked like a server crash;
    // only the second tap (after the cache prune) showed the helpful toast.
    const { app, state, spotify, store } = buildTestApp({
      spotify: { transferPlayback: vi.fn().mockRejectedValue(new Error('Spotify API failed: 404 Device not found')) },
    });
    store['spotify-devices.json'] = { '1': 'd-stale' };
    seed(state, [{ pid: '1', name: 'Bar' }], ['Bar']);
    spotify.getDevices.mockResolvedValue([]);
    const res = await request(app).post('/api/play').send({ uri: 'spotify:track:abc' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/aren't visible to Spotify/);
    // Stale entry pruned so we don't keep retrying it on every play tap.
    expect(store['spotify-devices.json']).toEqual({});
  });

  it('opportunistically caches every visible-zone device id during /api/play, not just the active leader', async () => {
    const { app, state, spotify, store } = buildTestApp();
    seed(state,
      [
        { pid: '1', name: 'Bar' },
        { pid: '2', name: 'Living Room' },
        { pid: '3', name: 'Kitchen' },
      ],
      ['Bar'],
    );
    // Active=Bar; Spotify also sees Living Room and Kitchen → those IDs should
    // get cached as a side effect so future taps can wake them too.
    spotify.getDevices.mockResolvedValue([
      { id: 'd-bar', name: 'Bar' },
      { id: 'd-lr', name: 'Living Room' },
      { id: 'd-kitchen', name: 'Kitchen' },
    ]);
    const res = await request(app).post('/api/play').send({ uri: 'spotify:track:abc' });
    expect(res.status).toBe(200);
    expect(store['spotify-devices.json']).toEqual({
      '1': 'd-bar',
      '2': 'd-lr',
      '3': 'd-kitchen',
    });
  });

  it('still seeds the cache from visible non-active devices even on the 404 no-match path', async () => {
    const { app, state, spotify, store } = buildTestApp();
    seed(state,
      [
        { pid: '1', name: 'Bar' },
        { pid: '2', name: 'Living Room' },
      ],
      ['Bar'],
    );
    // Active=Bar (not visible). Living Room is visible — seed it so the next
    // tap that targets Living Room can wake without phone help.
    spotify.getDevices.mockResolvedValue([{ id: 'd-lr', name: 'Living Room' }]);
    const res = await request(app).post('/api/play').send({ uri: 'spotify:track:abc' });
    expect(res.status).toBe(404);
    expect(store['spotify-devices.json']).toEqual({ '2': 'd-lr' });
  });

  it('promotes the matched zone to group leader and transfers playback', async () => {
    const { app, state, spotify, heos } = buildTestApp();
    // All three speakers in one zone so they're all in activePids.
    seed(state,
      [
        { pid: '1', name: 'Bar' },
        { pid: '2', name: 'Living Room' },
        { pid: '3', name: 'Kitchen' },
      ],
      ['All'],
      [{ name: 'All', pids: ['1', '2', '3'] }],
    );
    spotify.getDevices.mockResolvedValue([{ id: 'd-living', name: 'Living Room' }]);
    const res = await request(app).post('/api/play').send({ uri: 'spotify:track:abc' });
    expect(res.status).toBe(200);
    expect(heos.applyGroup).toHaveBeenCalledWith(['2', '1', '3']);
    expect(spotify.transferPlayback).toHaveBeenCalledWith('d-living', false);
    expect(spotify.play).toHaveBeenCalledWith('d-living', { uris: ['spotify:track:abc'] });
  });

  it('uses contextUri for non-track URIs (playlists, albums)', async () => {
    const { app, state, spotify } = buildTestApp();
    seed(state, [{ pid: '1', name: 'Living Room' }], ['Living Room']);
    spotify.getDevices.mockResolvedValue([{ id: 'd-living', name: 'Living Room' }]);
    await request(app).post('/api/play').send({ uri: 'spotify:playlist:xyz' });
    expect(spotify.play).toHaveBeenCalledWith('d-living', { contextUri: 'spotify:playlist:xyz' });
  });

  it('matches device names case-insensitively and trims whitespace', async () => {
    const { app, state, spotify } = buildTestApp();
    seed(state, [{ pid: '1', name: 'Living Room' }], ['Living Room']);
    spotify.getDevices.mockResolvedValue([{ id: 'd', name: '  living room  ' }]);
    const res = await request(app).post('/api/play').send({ uri: 'spotify:track:1' });
    expect(res.status).toBe(200);
    expect(spotify.transferPlayback).toHaveBeenCalledWith('d', false);
  });

  it('falls back to substring match when no exact device name matches', async () => {
    const { app, state, spotify } = buildTestApp();
    seed(state, [{ pid: '1', name: 'Bar' }], ['Bar']);
    spotify.getDevices.mockResolvedValue([{ id: 'd', name: 'Bar Speaker' }]);
    await request(app).post('/api/play').send({ uri: 'spotify:track:1' });
    expect(spotify.transferPlayback).toHaveBeenCalledWith('d', false);
  });
});

describe('POST /api/control', () => {
  it.each([
    ['pause', 'setPlayState'],
    ['play', 'setPlayState'],
    ['next', 'playNext'],
    ['previous', 'playPrevious'],
  ])('action=%s calls heos.%s', async (action, method) => {
    const { app, heos, state } = buildTestApp();
    seedPlayersAndZones(state, [{ pid: '1', name: 'Bar' }]);
    state.setActiveZones(['Bar']);
    const res = await request(app).post('/api/control').send({ action });
    expect(res.status).toBe(200);
    expect(heos[method]).toHaveBeenCalled();
  });

  it('400s on unknown action', async () => {
    const { app, state } = buildTestApp();
    seedPlayersAndZones(state, [{ pid: '1', name: 'Bar' }]);
    state.setActiveZones(['Bar']);
    const res = await request(app).post('/api/control').send({ action: 'eject' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown action/);
  });

  it('400s when no zones are active', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/control').send({ action: 'play' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/volume', () => {
  it('400s when level is not a number', async () => {
    const { app, state } = buildTestApp();
    seedPlayersAndZones(state, [{ pid: '1', name: 'Bar' }]);
    const res = await request(app).post('/api/volume').send({ zone: 'Bar', level: 'loud' });
    expect(res.status).toBe(400);
  });

  it('400s when zone is missing', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/volume').send({ level: 50 });
    expect(res.status).toBe(400);
  });

  it('400s when zone is not in state.zones', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/volume').send({ zone: 'Ghost', level: 50 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ghost/);
  });

  it('calls heos.setVolume for every pid in the zone and updates state on success', async () => {
    const { app, heos, state } = buildTestApp();
    seedPlayersAndZones(state,
      [{ pid: '1', name: 'A' }, { pid: '2', name: 'B' }],
      [{ name: 'Upstairs', pids: ['1', '2'] }],
    );
    const res = await request(app).post('/api/volume').send({ zone: 'Upstairs', level: 70 });
    expect(res.status).toBe(200);
    expect(heos.setVolume).toHaveBeenCalledWith('1', 70);
    expect(heos.setVolume).toHaveBeenCalledWith('2', 70);
    expect(state.volumes['1']).toBe(70);
    expect(state.volumes['2']).toBe(70);
  });
});

// H1: when /api/play's transferPlayback fails after applyGroup succeeds, speakers
// stay grouped with no audio. The route now snapshots the prior group and
// restores it.
describe('POST /api/play rollback on transferPlayback failure', () => {
  it('restores the prior group and surfaces the Spotify error as 500', async () => {
    const { app, state, spotify, heos } = buildTestApp({
      heos: {
        getGroups: vi.fn().mockResolvedValue([
          { gid: 'g1', players: [{ pid: '1' }, { pid: '2' }] },
        ]),
      },
      spotify: {
        transferPlayback: vi.fn().mockRejectedValue(new Error('transfer boom')),
      },
    });
    state.setPlayers([
      { pid: '1', name: 'Bar' },
      { pid: '2', name: 'Living Room' },
    ]);
    state.setZones([{ name: 'Both', pids: ['1', '2'] }]);
    state.setActiveZones(['Both']);
    spotify.getDevices.mockResolvedValue([{ id: 'd-bar', name: 'Bar' }]);

    const res = await request(app).post('/api/play').send({ uri: 'spotify:track:abc' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/transfer boom/);

    // applyGroup called twice: once to set the leader-first ordering, then
    // again to restore the original group [1, 2].
    expect(heos.applyGroup).toHaveBeenCalledTimes(2);
    expect(heos.applyGroup).toHaveBeenNthCalledWith(1, ['1', '2']);
    expect(heos.applyGroup).toHaveBeenNthCalledWith(2, ['1', '2']);
  });

  it('falls back to ungrouping the leader when no prior group existed', async () => {
    const { app, state, spotify, heos } = buildTestApp({
      heos: { getGroups: vi.fn().mockResolvedValue([]) },
      spotify: { transferPlayback: vi.fn().mockRejectedValue(new Error('nope')) },
    });
    state.setPlayers([{ pid: '1', name: 'Bar' }, { pid: '2', name: 'Living Room' }]);
    state.setZones([{ name: 'Both', pids: ['1', '2'] }]);
    state.setActiveZones(['Both']);
    spotify.getDevices.mockResolvedValue([{ id: 'd-bar', name: 'Bar' }]);

    const res = await request(app).post('/api/play').send({ uri: 'spotify:track:1' });
    expect(res.status).toBe(500);
    expect(heos.applyGroup).toHaveBeenCalledTimes(2);
    expect(heos.applyGroup).toHaveBeenNthCalledWith(2, ['1']);
  });
});

// L1: success responses use { ok: true, ... } and errors use { error: string }
// across the action routes. /api/state is exempt — it returns the snapshot shape
// directly (also used over the WS), not a command result.
describe('response shape conformance', () => {
  it('action successes include ok: true', async () => {
    const { app, state, spotify } = buildTestApp();
    seedPlayersAndZones(state, [{ pid: '1', name: 'Bar' }]);
    state.setActiveZones(['Bar']);
    spotify.getDevices.mockResolvedValue([{ id: 'd', name: 'Bar' }]);
    spotify.search.mockResolvedValue({ tracks: { items: [] } });

    const responses = await Promise.all([
      request(app).post('/api/zones/active').send({ zones: ['Bar'] }),
      request(app).get('/api/search?q=hi'),
      request(app).post('/api/play').send({ uri: 'spotify:track:1' }),
      request(app).post('/api/control').send({ action: 'play' }),
      request(app).post('/api/volume').send({ zone: 'Bar', level: 50 }),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  });

  it('errors use { error: string }', async () => {
    const { app } = buildTestApp();
    const responses = await Promise.all([
      request(app).post('/api/zones/active').send({}),
      request(app).get('/api/search'),
      request(app).post('/api/play').send({}),
      request(app).post('/api/control').send({ action: 'eject' }),
      request(app).post('/api/volume').send({}),
    ]);
    for (const res of responses) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error.length).toBeGreaterThan(0);
    }
  });
});

// F1: successful /api/play with display metadata appends to the recents
// ring buffer (capped at 8, deduped by uri, most-recent first).
describe('POST /api/play recents log (F1)', () => {
  function setup() {
    const ctx = buildTestApp();
    seedPlayersAndZones(ctx.state, [{ pid: '1', name: 'Bar' }]);
    ctx.state.setActiveZones(['Bar']);
    ctx.spotify.getDevices.mockResolvedValue([{ id: 'd', name: 'Bar' }]);
    return ctx;
  }

  it('records the played item with full metadata at the head of recents', async () => {
    const { app, state, store } = setup();
    await request(app).post('/api/play').send({
      uri: 'spotify:track:abc',
      label: 'Shake It Out',
      sublabel: 'Florence',
      art: 'https://i/1.png',
      badge: 'Track',
    });
    expect(state.recents[0]).toMatchObject({
      uri: 'spotify:track:abc',
      label: 'Shake It Out',
      sublabel: 'Florence',
      art: 'https://i/1.png',
      badge: 'Track',
    });
    expect(typeof state.recents[0].ts).toBe('number');
    expect(store['recents.json']).toBeDefined();
  });

  it('does not log when label is missing (e.g., quick repeat from /api/control)', async () => {
    const { app, state } = setup();
    await request(app).post('/api/play').send({ uri: 'spotify:track:abc' });
    expect(state.recents.length).toBe(0);
  });

  it('dedupes by uri so replaying an item promotes it instead of duplicating', async () => {
    const { app, state } = setup();
    await request(app).post('/api/play').send({ uri: 'spotify:track:a', label: 'A' });
    await request(app).post('/api/play').send({ uri: 'spotify:track:b', label: 'B' });
    await request(app).post('/api/play').send({ uri: 'spotify:track:a', label: 'A' });
    expect(state.recents.map((r) => r.uri)).toEqual(['spotify:track:a', 'spotify:track:b']);
  });

  it('caps at 8 items, dropping the oldest', async () => {
    const { app, state } = setup();
    for (let i = 0; i < 10; i++) {
      await request(app).post('/api/play').send({ uri: `spotify:track:${i}`, label: `T${i}` });
    }
    expect(state.recents.length).toBe(8);
    // Most recent first; oldest two ('0' and '1') were dropped.
    expect(state.recents[0].uri).toBe('spotify:track:9');
    expect(state.recents.find((r) => r.uri === 'spotify:track:0')).toBeUndefined();
  });
});

// F1: createApp hydrates the persisted recents on boot so the very first WS
// snapshot includes the user's pinned/recent quick picks.
describe('recents persistence', () => {
  it('hydrates state.recents from persist on createApp', async () => {
    const seed = {
      'recents.json': [{ uri: 'spotify:track:r', label: 'Re', sublabel: '', art: '', badge: 'Track', ts: 1 }],
    };
    const { state } = buildTestApp({ store: seed });
    expect(state.recents).toHaveLength(1);
  });

  // Defense in depth: recents.json is read from disk and its `art` field is
  // piped into <img src> on the client. A hand-edited or corrupted file with
  // `javascript:` URLs or non-string fields must be filtered out at the trust
  // boundary so it can't reach the renderer.
  it('drops malformed entries on hydrate', async () => {
    const seed = {
      'recents.json': [
        { uri: 'spotify:track:good', label: 'OK', sublabel: '', art: 'https://i/x', badge: 'Track', ts: 1 },
        { uri: 'not-a-spotify-uri', label: 'bad-uri', sublabel: '', art: '', badge: '', ts: 2 },
        { uri: 'spotify:track:b', label: 42, sublabel: '', art: '', badge: '', ts: 3 },
        { uri: 'spotify:track:c', label: 'bad-art', sublabel: '', art: 'javascript:alert(1)', badge: '', ts: 4 },
        { uri: 'spotify:track:d', label: 'no-sublabel', art: '', badge: '', ts: 5 },
        null,
        'not-an-object',
      ],
    };
    const { state } = buildTestApp({ store: seed });
    expect(state.recents.map((r) => r.uri)).toEqual(['spotify:track:good']);
  });
});

// C5: middleware should 503 routes that need HEOS until bootstrap finishes.
describe('readiness gate', () => {
  it('503s /api/play before setHeosReady is called', async () => {
    const { app, state } = buildTestApp({ ready: false });
    seedPlayersAndZones(state, [{ pid: '1', name: 'Bar' }]);
    state.setActiveZones(['Bar']);
    const res = await request(app).post('/api/play').send({ uri: 'spotify:track:1' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/starting up/);
  });

  it('503s /api/zones/active and /api/control before ready', async () => {
    const { app } = buildTestApp({ ready: false });
    expect((await request(app).post('/api/zones/active').send({ zones: ['Bar'] })).status).toBe(503);
    expect((await request(app).post('/api/control').send({ action: 'play' })).status).toBe(503);
  });

  it('lets /api/state through even before ready (used for first paint)', async () => {
    const { app } = buildTestApp({ ready: false });
    const res = await request(app).get('/api/state');
    expect(res.status).toBe(200);
  });

  it('lets /api/spotify/login through before ready', async () => {
    const { app } = buildTestApp({ ready: false });
    const res = await request(app).get('/api/spotify/login');
    expect([302, 200]).toContain(res.status);
  });

  it('passes through after setHeosReady is called', async () => {
    const { app, state } = buildTestApp({ ready: false });
    seedPlayersAndZones(state, [{ pid: '1', name: 'A' }]);
    app.locals.setHeosReady();
    const res = await request(app).post('/api/zones/active').send({ zones: ['A'] });
    expect(res.status).toBe(200);
    expect(state.activeZones).toEqual(['A']);
    expect(state.activePids).toEqual(['1']);
  });
});

// C4: /api/spotify/debug exposes account state — must be gated behind an env.
describe('GET /api/spotify/debug', () => {
  it('does NOT serve the debug payload by default (route not registered)', async () => {
    const prev = process.env.ENABLE_DEBUG_ROUTES;
    delete process.env.ENABLE_DEBUG_ROUTES;
    try {
      const { app } = buildTestApp();
      const res = await request(app).get('/api/spotify/debug');
      // Without the env, the route isn't bound: requests fall through to the
      // SPA fallback (200 index.html when dist is built, 404 otherwise). The
      // critical assertion is that the JSON debug payload is never returned.
      expect(res.headers['content-type'] || '').not.toMatch(/application\/json/);
      expect(res.body.tokenStatus).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.ENABLE_DEBUG_ROUTES = prev;
    }
  });

  it('serves the debug payload when ENABLE_DEBUG_ROUTES=1', async () => {
    const prev = process.env.ENABLE_DEBUG_ROUTES;
    process.env.ENABLE_DEBUG_ROUTES = '1';
    try {
      const { app } = buildTestApp();
      // Stub global fetch so the route's per-endpoint probes don't hit the network.
      const origFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        status: 200, text: async () => '{"ok":true}',
      });
      try {
        const res = await request(app).get('/api/spotify/debug');
        expect(res.status).toBe(200);
        expect(res.body.tokenStatus).toBe('present');
      } finally {
        global.fetch = origFetch;
      }
    } finally {
      if (prev === undefined) delete process.env.ENABLE_DEBUG_ROUTES;
      else process.env.ENABLE_DEBUG_ROUTES = prev;
    }
  });
});
