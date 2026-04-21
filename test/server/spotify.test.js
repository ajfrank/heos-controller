// Spotify Web API client tests. fs and global fetch are mocked.
// Module is re-imported per test so the in-module `cached` token resets.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeMockFetch } from '../helpers/mock-fetch.js';
import searchFixture from '../fixtures/spotify-search.json';
import devicesFixture from '../fixtures/spotify-devices.json';

// In-memory file-system stand-in.
let fakeFiles = {};
let fakeModes = {};
let chmodCalls = [];

vi.mock('node:fs', () => {
  const readFileSync = (p) => {
    if (!(p in fakeFiles)) {
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    }
    return fakeFiles[p];
  };
  const writeFileSync = (p, contents, opts) => {
    fakeFiles[p] = contents;
    if (opts && typeof opts === 'object' && 'mode' in opts) fakeModes[p] = opts.mode;
  };
  const mkdirSync = () => {};
  const chmodSync = (p, mode) => { chmodCalls.push([p, mode]); fakeModes[p] = mode; };
  return {
    default: { readFileSync, writeFileSync, mkdirSync, chmodSync },
    readFileSync,
    writeFileSync,
    mkdirSync,
    chmodSync,
  };
});

let spotify;
let fetchMock;

beforeEach(async () => {
  fakeFiles = {};
  fakeModes = {};
  chmodCalls = [];
  fetchMock = makeMockFetch();
  vi.stubGlobal('fetch', fetchMock);
  process.env.SPOTIFY_CLIENT_ID = 'cid';
  process.env.SPOTIFY_CLIENT_SECRET = 'csecret';
  process.env.PORT = '8080';
  vi.resetModules();
  spotify = await import('../../server/spotify.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isConnected / loadTokens', () => {
  it('returns false when no token file exists', () => {
    expect(spotify.isConnected()).toBe(false);
  });

  it('returns true when token file exists', () => {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60_000 });
    expect(spotify.isConnected()).toBe(true);
  });
});

describe('getRedirectUri / getAuthUrl', () => {
  it('redirect URI uses 127.0.0.1 (Spotify loopback exception)', () => {
    expect(spotify.getRedirectUri()).toBe('http://127.0.0.1:8080/api/spotify/callback');
  });

  it('getAuthUrl encodes client_id, scope, state, and redirect_uri', () => {
    const url = new URL(spotify.getAuthUrl('xyz'));
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('xyz');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8080/api/spotify/callback');
    expect(url.searchParams.get('scope')).toContain('user-modify-playback-state');
  });

  it('throws when SPOTIFY_CLIENT_ID is unset', () => {
    delete process.env.SPOTIFY_CLIENT_ID;
    expect(() => spotify.getAuthUrl('x')).toThrow(/SPOTIFY_CLIENT_ID/);
  });
});

describe('exchangeCode', () => {
  it('POSTs to the token endpoint with Basic auth and persists tokens', async () => {
    fetchMock.route('POST', 'accounts.spotify.com/api/token', () => ({
      access_token: 'AT', refresh_token: 'RT', expires_in: 3600,
    }));
    await spotify.exchangeCode('thecode');
    const call = fetchMock.calls()[0];
    expect(call[0]).toBe('https://accounts.spotify.com/api/token');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers.Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(spotify.isConnected()).toBe(true);
  });

  it('throws when Spotify returns non-2xx', async () => {
    fetchMock.route('POST', 'accounts.spotify.com/api/token', { status: 400, body: 'bad' });
    await expect(spotify.exchangeCode('x')).rejects.toThrow(/Spotify token exchange failed: 400/);
  });

  // C1: refresh tokens are bearer credentials; the file must be 0o600 so other
  // users on a shared host can't lift them.
  it('writes the token file with mode 0o600 and chmods if it pre-existed', async () => {
    fetchMock.route('POST', 'accounts.spotify.com/api/token', () => ({
      access_token: 'AT', refresh_token: 'RT', expires_in: 3600,
    }));
    await spotify.exchangeCode('thecode');
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    expect(fakeModes[tokenPath]).toBe(0o600);
    expect(chmodCalls.some(([p, m]) => p === tokenPath && m === 0o600)).toBe(true);
  });
});

describe('search', () => {
  it('builds /search?q=&type= and returns the parsed payload', async () => {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60_000 });
    fetchMock.route('GET', '/v1/search', searchFixture);
    const r = await spotify.search('chill', ['track', 'playlist', 'album']);
    const url = new URL(fetchMock.calls()[0][0]);
    expect(url.searchParams.get('q')).toBe('chill');
    expect(url.searchParams.get('type')).toBe('track,playlist,album');
    expect(r.tracks.items[0].name).toBe('Chill Vibes');
  });

  // M4: untrusted values in `types` would otherwise be passed straight through
  // to Spotify's API and cause a 4xx that confuses the user.
  it('drops invalid types from the query', async () => {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60_000 });
    fetchMock.route('GET', '/v1/search', searchFixture);
    await spotify.search('chill', ['track', 'evil', 'album']);
    const url = new URL(fetchMock.calls()[0][0]);
    expect(url.searchParams.get('type')).toBe('track,album');
  });

  it('throws if no types remain after filtering', async () => {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60_000 });
    await expect(spotify.search('q', ['evil', 'bogus'])).rejects.toThrow(/at least one valid type/);
  });
});

describe('getDevices', () => {
  it('returns devices from /me/player/devices', async () => {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60_000 });
    fetchMock.route('GET', '/v1/me/player/devices', devicesFixture);
    const d = await spotify.getDevices();
    expect(d).toHaveLength(3);
    expect(d.map((x) => x.name)).toEqual(['Kitchen', 'Living Room', 'Echo Dot']);
  });

  it('throws a friendly message on 404 "Service not found" (no Connect devices yet)', async () => {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60_000 });
    fetchMock.route('GET', '/v1/me/player/devices', { status: 404, body: '{"error":{"status":404,"message":"Service not found"}}' });
    await expect(spotify.getDevices()).rejects.toThrow(/No Spotify Connect devices registered/);
  });
});

describe('findDeviceForPlayer', () => {
  it('matches case-insensitively and trims whitespace', async () => {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60_000 });
    fetchMock.route('GET', '/v1/me/player/devices', devicesFixture);
    const d = await spotify.findDeviceForPlayer('  living room  ');
    expect(d.id).toBe('dev-living');
  });

  it('falls back to substring match', async () => {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60_000 });
    fetchMock.route('GET', '/v1/me/player/devices', devicesFixture);
    const d = await spotify.findDeviceForPlayer('Echo');
    expect(d.id).toBe('dev-echo');
  });

  it('returns null when nothing matches', async () => {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60_000 });
    fetchMock.route('GET', '/v1/me/player/devices', devicesFixture);
    expect(await spotify.findDeviceForPlayer('Bedroom')).toBeNull();
  });
});

describe('refresh on expired token', () => {
  it('calls the refresh endpoint and re-attempts the API call', async () => {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_at: Date.now() - 1000 });
    fetchMock.route('POST', 'accounts.spotify.com/api/token', () => ({
      access_token: 'new', refresh_token: 'r2', expires_in: 3600,
    }));
    fetchMock.route('GET', '/v1/me/player/devices', devicesFixture);
    await spotify.getDevices();
    const tokenCalls = fetchMock.calls().filter((c) => c[0].includes('accounts.spotify.com'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0][1].body.toString()).toContain('grant_type=refresh_token');
    // The new token should have been written back to disk.
    expect(JSON.parse(fakeFiles[tokenPath]).access_token).toBe('new');
  });

  // C3: two concurrent refreshes would each get a new refresh_token; one of
  // them gets invalidated and the user is locked out. Single-flight ensures
  // exactly one POST hits the token endpoint.
  it('serializes concurrent token refreshes (mutex)', async () => {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_at: Date.now() - 1000 });
    fetchMock.route('POST', 'accounts.spotify.com/api/token', async () => {
      // Hold open long enough that all 5 callers race.
      await new Promise((r) => setTimeout(r, 10));
      return { access_token: 'new', refresh_token: 'r2', expires_in: 3600 };
    });
    fetchMock.route('GET', '/v1/me/player/devices', devicesFixture);
    await Promise.all([
      spotify.getDevices(), spotify.getDevices(), spotify.getDevices(),
      spotify.getDevices(), spotify.getDevices(),
    ]);
    const tokenCalls = fetchMock.calls().filter((c) => c[0].includes('accounts.spotify.com'));
    expect(tokenCalls).toHaveLength(1);
  });
});

describe('transport calls', () => {
  function seedTokens() {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60_000 });
  }

  it('transferPlayback PUTs /me/player with device_ids + play=false', async () => {
    seedTokens();
    fetchMock.route('PUT', '/v1/me/player', { status: 204, body: '' });
    await spotify.transferPlayback('dev-1', false);
    const call = fetchMock.calls()[0];
    expect(call[0]).toBe('https://api.spotify.com/v1/me/player');
    expect(call[1].method).toBe('PUT');
    expect(JSON.parse(call[1].body)).toEqual({ device_ids: ['dev-1'], play: false });
  });

  it('play with track URI sends uris[]', async () => {
    seedTokens();
    fetchMock.route('PUT', '/v1/me/player/play', { status: 204, body: '' });
    await spotify.play('dev-1', { uris: ['spotify:track:abc'] });
    const call = fetchMock.calls()[0];
    expect(call[0]).toContain('device_id=dev-1');
    expect(JSON.parse(call[1].body)).toEqual({ uris: ['spotify:track:abc'] });
  });

  it('play with playlist URI sends context_uri', async () => {
    seedTokens();
    fetchMock.route('PUT', '/v1/me/player/play', { status: 204, body: '' });
    await spotify.play('dev-1', { contextUri: 'spotify:playlist:xyz' });
    const call = fetchMock.calls()[0];
    expect(JSON.parse(call[1].body)).toEqual({ context_uri: 'spotify:playlist:xyz' });
  });
});

// T1.3 + T1.4 + T1.5: api() retries once on 5xx/429/network, throws the
// REAUTH_SENTINEL on 401 and on refresh failure, and translates upstream
// noise into messages a wall-tablet user can act on.
describe('api() retry / reauth / error translation', () => {
  function seedTokens() {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 60_000 });
  }

  it('retries once on 503 and returns the success payload', async () => {
    seedTokens();
    let n = 0;
    fetchMock.route('GET', '/v1/me/player/devices', () => {
      n++;
      if (n === 1) return { status: 503, body: 'busy' };
      return { status: 200, body: JSON.stringify({ devices: [{ id: 'd', name: 'X' }] }) };
    });
    const d = await spotify.getDevices();
    expect(n).toBe(2);
    expect(d).toEqual([{ id: 'd', name: 'X' }]);
  });

  it('translates a persistent 5xx into "having a hiccup"', async () => {
    seedTokens();
    fetchMock.route('GET', '/v1/me/player/devices', { status: 503, body: 'still busy' });
    await expect(spotify.getDevices()).rejects.toThrow(/hiccup/);
    // Two attempts (initial + 1 retry), no more.
    expect(fetchMock.calls().filter((c) => c[0].includes('/me/player/devices'))).toHaveLength(2);
  });

  it('translates a persistent 429 into "throttling us"', async () => {
    seedTokens();
    fetchMock.route('GET', '/v1/me/player/devices', { status: 429, body: 'rate limited' });
    await expect(spotify.getDevices()).rejects.toThrow(/throttling/);
  });

  it('does NOT retry on a non-429 4xx', async () => {
    seedTokens();
    let n = 0;
    fetchMock.route('GET', '/v1/me/player/devices', () => {
      n++; return { status: 400, body: '{"error":"bad request"}' };
    });
    await expect(spotify.getDevices()).rejects.toThrow();
    expect(n).toBe(1);
  });

  it('throws SPOTIFY_REAUTH_REQUIRED on 401 (does NOT retry)', async () => {
    seedTokens();
    let n = 0;
    fetchMock.route('GET', '/v1/me/player/devices', () => {
      n++; return { status: 401, body: 'unauthorized' };
    });
    await expect(spotify.getDevices()).rejects.toThrow(/SPOTIFY_REAUTH_REQUIRED/);
    expect(n).toBe(1);
  });

  it('translates persistent network failure into "network blip" after one retry', async () => {
    seedTokens();
    let n = 0;
    // Bypass the routable mock: stub fetch directly so EVERY call throws.
    vi.stubGlobal('fetch', vi.fn(() => {
      n++;
      return Promise.reject(new TypeError('fetch failed'));
    }));
    await expect(spotify.getDevices()).rejects.toThrow(/network blip/);
    expect(n).toBe(2);
  });

  it('passes signal: AbortSignal so requests cap at the 10s timeout', async () => {
    seedTokens();
    fetchMock.route('GET', '/v1/me/player/devices', { status: 200, body: '{"devices":[]}' });
    await spotify.getDevices();
    const call = fetchMock.calls().find((c) => c[0].includes('/me/player/devices'));
    expect(call[1].signal).toBeDefined();
    // AbortSignal.timeout returns an AbortSignal instance.
    expect(call[1].signal.constructor.name).toMatch(/AbortSignal/);
  });

  it('throws SPOTIFY_REAUTH_REQUIRED when refresh itself fails', async () => {
    const tokenPath = `${process.env.HOME}/.heos-controller/spotify-tokens.json`;
    fakeFiles[tokenPath] = JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_at: Date.now() - 1000 });
    fetchMock.route('POST', 'accounts.spotify.com/api/token', { status: 400, body: 'invalid_grant' });
    await expect(spotify.getDevices()).rejects.toThrow(/SPOTIFY_REAUTH_REQUIRED/);
  });
});
