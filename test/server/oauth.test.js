// Spotify OAuth flow: /api/spotify/login mints state and redirects;
// /api/spotify/callback validates state and exchanges the code.

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { buildTestApp } from '../helpers/build-test-app.js';

describe('GET /api/spotify/login', () => {
  it('redirects to the Spotify auth URL with a state token', async () => {
    const { app, spotify } = buildTestApp({
      spotify: {
        getAuthUrl: vi.fn((s) => `https://accounts.spotify.com/authorize?state=${s}`),
      },
    });
    const res = await request(app).get('/api/spotify/login');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.spotify\.com\/authorize\?state=[a-f0-9]{32}$/);
    expect(spotify.getAuthUrl).toHaveBeenCalledOnce();
    // The state passed to getAuthUrl should be a 32-char hex string (16 random bytes).
    const passedState = spotify.getAuthUrl.mock.calls[0][0];
    expect(passedState).toMatch(/^[a-f0-9]{32}$/);
  });

  it('500s with generic text/plain when getAuthUrl throws (does not leak server error)', async () => {
    const { app } = buildTestApp({
      spotify: {
        getAuthUrl: vi.fn(() => { throw new Error('SPOTIFY_CLIENT_ID not set'); }),
      },
    });
    const res = await request(app).get('/api/spotify/login');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    // The raw config error is logged server-side, NOT reflected to the client —
    // a public-facing controller shouldn't expose internal config details.
    expect(res.text).not.toMatch(/SPOTIFY_CLIENT_ID/);
    expect(res.text).toMatch(/login failed/i);
  });

  it('mints a fresh state on every request', async () => {
    const seen = [];
    const { app } = buildTestApp({
      spotify: {
        getAuthUrl: vi.fn((s) => { seen.push(s); return `https://x/?s=${s}`; }),
      },
    });
    await request(app).get('/api/spotify/login');
    await request(app).get('/api/spotify/login');
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('GET /api/spotify/callback', () => {
  it('400s when state is missing', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/spotify/callback?code=abc');
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Invalid OAuth state/);
  });

  it('400s when code is missing', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/spotify/callback?state=anything');
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Invalid OAuth state/);
  });

  it('400s when state was never issued (forged)', async () => {
    const { app, spotify } = buildTestApp();
    const res = await request(app).get('/api/spotify/callback?code=abc&state=not-a-real-token');
    expect(res.status).toBe(400);
    expect(spotify.exchangeCode).not.toHaveBeenCalled();
  });

  it('400s when an upstream error param is present', async () => {
    const { app, spotify } = buildTestApp();
    const res = await request(app).get('/api/spotify/callback?error=access_denied');
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/access_denied/);
    expect(spotify.exchangeCode).not.toHaveBeenCalled();
  });

  // The error param is an attacker-controlled query string. Reflecting it as
  // HTML would give a same-origin XSS path — and there's no CSRF guard on the
  // REST surface, so a payload could fetch /api/spotify/disconnect or similar.
  // The route must respond as text/plain so the browser doesn't interpret tags.
  it('serves the error response as text/plain so query-string HTML is inert', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get(
      '/api/spotify/callback?error=' + encodeURIComponent('<script>alert(1)</script>'),
    );
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    // Body contains the literal payload (not HTML-escaped, but inert because
    // text/plain prevents the browser from parsing it as HTML).
    expect(res.text).toBe('Spotify error: <script>alert(1)</script>');
  });

  it('exchanges the code and renders success when state is valid', async () => {
    const { app, spotify } = buildTestApp({
      spotify: {
        getAuthUrl: vi.fn((s) => `https://x/?s=${s}`),
      },
    });
    // Mint a state by calling /login, then extract it from the redirect URL.
    const login = await request(app).get('/api/spotify/login');
    const minted = new URL(login.headers.location).searchParams.get('s');
    const res = await request(app).get(`/api/spotify/callback?code=thecode&state=${minted}`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Spotify connected/);
    expect(spotify.exchangeCode).toHaveBeenCalledWith('thecode');
  });

  it('rejects a replayed state (single-use)', async () => {
    const { app, spotify } = buildTestApp({
      spotify: {
        getAuthUrl: vi.fn((s) => `https://x/?s=${s}`),
      },
    });
    const login = await request(app).get('/api/spotify/login');
    const minted = new URL(login.headers.location).searchParams.get('s');
    const ok = await request(app).get(`/api/spotify/callback?code=c1&state=${minted}`);
    expect(ok.status).toBe(200);
    const replay = await request(app).get(`/api/spotify/callback?code=c2&state=${minted}`);
    expect(replay.status).toBe(400);
    expect(spotify.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('500s with generic text/plain when exchangeCode throws (does not leak Spotify error body)', async () => {
    const { app } = buildTestApp({
      spotify: {
        getAuthUrl: vi.fn((s) => `https://x/?s=${s}`),
        exchangeCode: vi.fn().mockRejectedValue(new Error('token exchange failed: 400 invalid_grant')),
      },
    });
    const login = await request(app).get('/api/spotify/login');
    const minted = new URL(login.headers.location).searchParams.get('s');
    const res = await request(app).get(`/api/spotify/callback?code=thecode&state=${minted}`);
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    // The raw upstream error (including any token bytes Spotify echoed back)
    // is logged server-side, NOT reflected to the browser.
    expect(res.text).not.toMatch(/token exchange failed/);
    expect(res.text).not.toMatch(/invalid_grant/);
    expect(res.text).toMatch(/connection failed/i);
  });
});

// H6: oauthStates is bounded — sweeps expired entries on insert and returns
// 429 if the cap (100) is hit.
describe('GET /api/spotify/login bounds the in-flight state set', () => {
  it('returns 429 once the in-flight cap is reached', async () => {
    const { app } = buildTestApp({
      spotify: { getAuthUrl: vi.fn((s) => `https://x/?s=${s}`) },
    });
    for (let i = 0; i < 100; i++) {
      const r = await request(app).get('/api/spotify/login');
      expect(r.status).toBe(302);
    }
    const overflow = await request(app).get('/api/spotify/login');
    expect(overflow.status).toBe(429);
    expect(overflow.text).toMatch(/Too many/i);
  });

  it('admits new logins after expired states are swept', async () => {
    const { app } = buildTestApp({
      spotify: { getAuthUrl: vi.fn((s) => `https://x/?s=${s}`) },
    });
    for (let i = 0; i < 100; i++) {
      await request(app).get('/api/spotify/login');
    }
    expect((await request(app).get('/api/spotify/login')).status).toBe(429);
    // Jump Date.now() forward 11 minutes; the next /login synchronously sweeps
    // expired entries (all 100 of them) before checking the cap. Using
    // vi.setSystemTime rather than useFakeTimers avoids breaking supertest's
    // internal HTTP parser.
    const realNow = Date.now;
    Date.now = () => realNow.call(Date) + 11 * 60 * 1000;
    try {
      const r = await request(app).get('/api/spotify/login');
      expect(r.status).toBe(302);
    } finally {
      Date.now = realNow;
    }
  });
});
