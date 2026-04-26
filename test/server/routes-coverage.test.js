// Coverage for routes added in audit pass #1 that weren't covered in routes.test.js:
// /api/recents/remove, /api/playback/position, /api/playback/seek,
// /api/spotify/disconnect, plus the partial-success path of /api/volume.

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { buildTestApp } from '../helpers/build-test-app.js';

describe('POST /api/recents/remove', () => {
  it('400s when uri is missing', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/recents/remove').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uri/);
  });

  it('400s when uri is the wrong type', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/recents/remove').send({ uri: 42 });
    expect(res.status).toBe(400);
  });

  it('removes the matching entry from state.recents and persists the new list', async () => {
    const seed = {
      'recents.json': [
        { uri: 'spotify:track:a', label: 'A', sublabel: '', art: '', badge: 'Track', ts: 1 },
        { uri: 'spotify:track:b', label: 'B', sublabel: '', art: '', badge: 'Track', ts: 2 },
      ],
    };
    const { app, state, store } = buildTestApp({ store: seed });
    const res = await request(app).post('/api/recents/remove').send({ uri: 'spotify:track:a' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(state.recents.map((r) => r.uri)).toEqual(['spotify:track:b']);
    expect(store['recents.json'].map((r) => r.uri)).toEqual(['spotify:track:b']);
  });

  it('is a no-op (still 200) when the uri is not in recents', async () => {
    const { app, state } = buildTestApp();
    state.setRecents([{ uri: 'spotify:track:keep', label: 'K', sublabel: '', art: '', badge: 'Track', ts: 1 }]);
    const res = await request(app).post('/api/recents/remove').send({ uri: 'spotify:track:nope' });
    expect(res.status).toBe(200);
    expect(state.recents.map((r) => r.uri)).toEqual(['spotify:track:keep']);
  });
});

describe('GET /api/playback/position', () => {
  it('returns the current playback object + queue on success', async () => {
    const playback = { is_playing: true, progress_ms: 12345, item: { id: 'x' } };
    const queue = [{ song: 'Up Next', artist: 'A', image_url: '', uri: 'spotify:track:n' }];
    const { app, spotify } = buildTestApp({
      spotify: {
        getPlayback: vi.fn().mockResolvedValue(playback),
        getQueue: vi.fn().mockResolvedValue(queue),
      },
    });
    const res = await request(app).get('/api/playback/position');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, playback, queue });
    expect(spotify.getPlayback).toHaveBeenCalled();
    expect(spotify.getQueue).toHaveBeenCalled();
  });

  it('returns playback: null + queue: [] when nothing is playing', async () => {
    const { app } = buildTestApp({ spotify: { getPlayback: vi.fn().mockResolvedValue(null) } });
    const res = await request(app).get('/api/playback/position');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, playback: null, queue: [] });
  });

  it('swallows getQueue errors so a flaky queue endpoint never breaks the playback poll', async () => {
    const playback = { is_playing: true, progress_ms: 1, item: { id: 'x' } };
    const { app } = buildTestApp({
      spotify: {
        getPlayback: vi.fn().mockResolvedValue(playback),
        getQueue: vi.fn().mockRejectedValue(new Error('Spotify hiccup')),
      },
    });
    const res = await request(app).get('/api/playback/position');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, playback, queue: [] });
  });

  it('translates SPOTIFY_REAUTH_REQUIRED → 401 + code:"reauth"', async () => {
    const { app } = buildTestApp({
      spotify: { getPlayback: vi.fn().mockRejectedValue(new Error('SPOTIFY_REAUTH_REQUIRED')) },
    });
    const res = await request(app).get('/api/playback/position');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'reauth' });
  });

  // Server-side queue cache: the queue endpoint is hit once per track-change
  // (or every 30s if the same track plays for a long time), not once per
  // /api/playback/position poll. With multi-tablet polling every 5s this
  // cuts upstream Spotify load by ~80%.
  it('caches queue across polls of the same track_id', async () => {
    const playback = { is_playing: true, progress_ms: 1, track_id: 'tk-A' };
    const queue = [{ song: 'Up Next', artist: 'A', image_url: '', uri: 'spotify:track:n' }];
    const { app, spotify } = buildTestApp({
      spotify: {
        getPlayback: vi.fn().mockResolvedValue(playback),
        getQueue: vi.fn().mockResolvedValue(queue),
      },
    });
    // Two back-to-back polls on the same track.
    const r1 = await request(app).get('/api/playback/position');
    const r2 = await request(app).get('/api/playback/position');
    expect(r1.body.queue).toEqual(queue);
    expect(r2.body.queue).toEqual(queue);
    expect(spotify.getPlayback).toHaveBeenCalledTimes(2);
    expect(spotify.getQueue).toHaveBeenCalledTimes(1); // cached on the second poll
  });

  it('refreshes queue cache when the playing track_id changes', async () => {
    const queueA = [{ song: 'After A', artist: 'X', image_url: '', uri: 'spotify:track:after-a' }];
    const queueB = [{ song: 'After B', artist: 'Y', image_url: '', uri: 'spotify:track:after-b' }];
    let playbackTick = 0;
    const { app, spotify } = buildTestApp({
      spotify: {
        getPlayback: vi.fn(async () => ({
          is_playing: true,
          progress_ms: 1,
          track_id: ++playbackTick === 1 ? 'tk-A' : 'tk-B',
        })),
        getQueue: vi.fn()
          .mockResolvedValueOnce(queueA)
          .mockResolvedValueOnce(queueB),
      },
    });
    const r1 = await request(app).get('/api/playback/position');
    const r2 = await request(app).get('/api/playback/position');
    expect(r1.body.queue).toEqual(queueA);
    expect(r2.body.queue).toEqual(queueB);
    expect(spotify.getQueue).toHaveBeenCalledTimes(2); // track-change invalidated the cache
  });

  it('keeps prior cached queue when a refresh attempt fails (transient error)', async () => {
    const queueA = [{ song: 'After A', artist: 'X', image_url: '', uri: 'spotify:track:after-a' }];
    let tick = 0;
    const { app } = buildTestApp({
      spotify: {
        getPlayback: vi.fn(async () => ({
          is_playing: true,
          progress_ms: 1,
          track_id: ++tick === 1 ? 'tk-A' : 'tk-B',
        })),
        getQueue: vi.fn()
          .mockResolvedValueOnce(queueA)
          .mockRejectedValueOnce(new Error('Spotify hiccup')),
      },
    });
    const r1 = await request(app).get('/api/playback/position');
    const r2 = await request(app).get('/api/playback/position');
    expect(r1.body.queue).toEqual(queueA);
    // Cache fall-back: the failed refresh leaves the prior queue in place
    // rather than blanking it, so the optimistic-skip use case keeps working.
    expect(r2.body.queue).toEqual(queueA);
  });
});

describe('POST /api/playback/seek', () => {
  it.each([
    [{}, 'missing'],
    [{ ms: 'mid' }, 'string'],
    [{ ms: -1 }, 'negative'],
    [{ ms: Number.NaN }, 'NaN'],
    [{ ms: Number.POSITIVE_INFINITY }, 'Infinity'],
  ])('400s on invalid ms %j (%s)', async (body) => {
    const { app, spotify } = buildTestApp();
    const res = await request(app).post('/api/playback/seek').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-negative/);
    expect(spotify.seek).not.toHaveBeenCalled();
  });

  it('accepts ms=0 (start of track)', async () => {
    const { app, spotify } = buildTestApp();
    const res = await request(app).post('/api/playback/seek').send({ ms: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(spotify.seek).toHaveBeenCalledWith(0);
  });

  it('forwards a valid ms to spotify.seek and returns ok', async () => {
    const { app, spotify } = buildTestApp();
    const res = await request(app).post('/api/playback/seek').send({ ms: 30_000 });
    expect(res.status).toBe(200);
    expect(spotify.seek).toHaveBeenCalledWith(30_000);
  });

  it('translates SPOTIFY_REAUTH_REQUIRED → 401 + code:"reauth"', async () => {
    const { app } = buildTestApp({
      spotify: { seek: vi.fn().mockRejectedValue(new Error('SPOTIFY_REAUTH_REQUIRED')) },
    });
    const res = await request(app).post('/api/playback/seek').send({ ms: 1000 });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('reauth');
  });

  it('500s with the upstream error message on other failures', async () => {
    const { app } = buildTestApp({
      spotify: { seek: vi.fn().mockRejectedValue(new Error('seek boom')) },
    });
    const res = await request(app).post('/api/playback/seek').send({ ms: 1000 });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('seek boom');
  });
});

describe('POST /api/spotify/disconnect', () => {
  it('calls spotify.pauseActive and returns ok on success', async () => {
    const { app, spotify } = buildTestApp();
    const res = await request(app).post('/api/spotify/disconnect').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(spotify.pauseActive).toHaveBeenCalled();
  });

  it('translates SPOTIFY_REAUTH_REQUIRED → 401 + code:"reauth"', async () => {
    const { app } = buildTestApp({
      spotify: { pauseActive: vi.fn().mockRejectedValue(new Error('SPOTIFY_REAUTH_REQUIRED')) },
    });
    const res = await request(app).post('/api/spotify/disconnect').send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('reauth');
  });

  it('500s on other Spotify failures', async () => {
    const { app } = buildTestApp({
      spotify: { pauseActive: vi.fn().mockRejectedValue(new Error('disconnect boom')) },
    });
    const res = await request(app).post('/api/spotify/disconnect').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('disconnect boom');
  });
});

// Audit pass #1 changed /api/volume from Promise.all to Promise.allSettled so a
// single offline speaker doesn't strand the rest at the old level. routes.test.js
// covers the all-success path; this covers partial and total failure.
describe('POST /api/volume partial / total failure', () => {
  function seedTwoSpeakerZone() {
    const ctx = buildTestApp({
      heos: {
        // First call (pid='1') succeeds, second call (pid='2') fails.
        setVolume: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('speaker offline')),
      },
    });
    ctx.state.setPlayers([{ pid: '1', name: 'A' }, { pid: '2', name: 'B' }]);
    ctx.state.setZones([{ name: 'Upstairs', pids: ['1', '2'] }]);
    return ctx;
  }

  it('returns 200 with partial:true + failedPids when some pids fail', async () => {
    const { app, state } = seedTwoSpeakerZone();
    const res = await request(app).post('/api/volume').send({ zone: 'Upstairs', level: 70 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, partial: true, failedPids: ['2'] });
    // State updated only for the speaker that took the new level.
    expect(state.volumes['1']).toBe(70);
    expect(state.volumes['2']).toBeUndefined();
  });

  it('returns 500 with the first error message when every pid fails', async () => {
    const ctx = buildTestApp({
      heos: {
        setVolume: vi.fn()
          .mockRejectedValueOnce(new Error('first boom'))
          .mockRejectedValueOnce(new Error('second boom')),
      },
    });
    ctx.state.setPlayers([{ pid: '1', name: 'A' }, { pid: '2', name: 'B' }]);
    ctx.state.setZones([{ name: 'Upstairs', pids: ['1', '2'] }]);
    const res = await request(ctx.app).post('/api/volume').send({ zone: 'Upstairs', level: 70 });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('first boom');
    // Neither speaker's level was updated.
    expect(ctx.state.volumes['1']).toBeUndefined();
    expect(ctx.state.volumes['2']).toBeUndefined();
  });
});
