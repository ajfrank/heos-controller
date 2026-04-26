// Spotify Web API client.
// Auth: Authorization Code flow (server-side; client secret stays on the Mac).
// Tokens persisted to ~/.heos-controller/spotify-tokens.json.
// Playback: Spotify Connect — HEOS speakers register themselves as Connect devices,
// so we just transfer playback to one and HEOS handles the audio.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TOKEN_DIR = path.join(os.homedir(), '.heos-controller');
const TOKEN_FILE = path.join(TOKEN_DIR, 'spotify-tokens.json');

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'user-library-read',
].join(' ');

let cached = null; // { access_token, refresh_token, expires_at }

function loadTokens() {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return cached;
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  // Refresh tokens are bearer credentials; lock the file to the current user.
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  // If the file pre-existed with looser perms, tighten them.
  try { fs.chmodSync(TOKEN_FILE, 0o600); }
  catch (e) { console.warn('[spotify] token chmod failed:', e.message); }
  cached = tokens;
}

/** @returns {boolean} true when persisted Spotify tokens exist. */
export function isConnected() {
  return !!loadTokens();
}

/** @returns {string} OAuth redirect URI (loopback IP — Spotify's 2025 policy disallows http://localhost). */
export function getRedirectUri() {
  const port = process.env.PORT || 8080;
  // Spotify's 2025 policy: HTTPS required for all redirect URIs EXCEPT loopback IPs
  // (http://127.0.0.1 and http://[::1] are allowed; plain http://localhost is not).
  return `http://127.0.0.1:${port}/api/spotify/callback`;
}

/** @param {string} state - opaque CSRF token forwarded back via callback. @returns {string} authorize URL. */
export function getAuthUrl(state) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) throw new Error('SPOTIFY_CLIENT_ID not set');
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', getRedirectUri());
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

/** @param {string} code - authorization code from Spotify callback. Persists tokens to disk. */
export async function exchangeCode(code) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`Spotify token exchange failed: ${res.status} ${await res.text()}`);
  const t = await res.json();
  saveTokens({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (t.expires_in - 60) * 1000,
  });
}

// Single-flight: concurrent callers share one refresh round-trip. Spotify rotates
// the refresh_token on each call, so two parallel refreshes would invalidate one
// another and lock the user out.
let inflightRefresh = null;

async function refresh() {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    const tokens = loadTokens();
    if (!tokens?.refresh_token) throw new Error('Spotify not connected');
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) throw new Error(`Spotify refresh failed: ${res.status} ${await res.text()}`);
    const t = await res.json();
    saveTokens({
      access_token: t.access_token,
      refresh_token: t.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (t.expires_in - 60) * 1000,
    });
  })();
  try { await inflightRefresh; } finally { inflightRefresh = null; }
}

// Sentinel thrown when Spotify auth is unrecoverable (refresh token revoked,
// access token rejected). Routes translate this to HTTP 401 + code:'reauth'
// so the UI can surface the reconnect banner without parsing error text.
export const REAUTH_SENTINEL = 'SPOTIFY_REAUTH_REQUIRED';

async function accessToken() {
  let tokens = loadTokens();
  if (!tokens) throw new Error('Spotify not connected — visit /api/spotify/login');
  if (Date.now() >= tokens.expires_at) {
    try { await refresh(); }
    catch { throw new Error(REAUTH_SENTINEL); }
    tokens = loadTokens();
  }
  return tokens.access_token;
}

export const _accessTokenForDebug = accessToken;

const SPOTIFY_TIMEOUT_MS = 10_000;
const SPOTIFY_RETRY_DELAY_MS = 500;
// Cap concurrent fetches to Spotify so a burst of taps (e.g. rapid zone
// toggles + plays) can't fan out enough requests to trip the per-user rate
// limit. 4 is well below Spotify's bucket and leaves headroom for the UI's
// background polls (devices, playback) to slip through alongside a play.
const SPOTIFY_MAX_CONCURRENT = 4;
let spotifyInflight = 0;
const spotifyWaiters = [];
async function acquireSlot() {
  if (spotifyInflight < SPOTIFY_MAX_CONCURRENT) {
    spotifyInflight++;
    return;
  }
  await new Promise((resolve) => spotifyWaiters.push(resolve));
  spotifyInflight++;
}
function releaseSlot() {
  spotifyInflight--;
  const next = spotifyWaiters.shift();
  if (next) next();
}

// One retry on transient failures (5xx, 429, network/timeout). Mutating ops
// (PUT play, PUT transfer) are idempotent for our usage — playing the same
// URI twice or transferring to the same device twice is a no-op — so we don't
// need to discriminate by method. Cap at 1 retry: more would risk piling on
// during a real Spotify outage.
async function api(pathAndQuery, init = {}) {
  await acquireSlot();
  try {
    return await apiInner(pathAndQuery, init);
  } finally {
    releaseSlot();
  }
}

async function apiInner(pathAndQuery, init = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, SPOTIFY_RETRY_DELAY_MS));
    }
    const token = await accessToken();
    let res;
    try {
      res = await fetch(`https://api.spotify.com/v1${pathAndQuery}`, {
        ...init,
        signal: AbortSignal.timeout(SPOTIFY_TIMEOUT_MS),
        headers: {
          ...(init.headers || {}),
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (e) {
      // Network-level failure (DNS, ECONNRESET, AbortSignal.timeout). Retry
      // once; on second failure translate to a user-friendly message rather
      // than leaking node's internal error name.
      if (attempt === 0) continue;
      throw new Error("Couldn't reach Spotify (network blip). Try again.");
    }

    if (res.status === 204) return null;
    // 401 = access token rejected. Refresh single-flighted upstream, so by
    // the time we see a 401 here the token is genuinely bad — surface the
    // reauth sentinel, don't retry.
    if (res.status === 401) throw new Error(REAUTH_SENTINEL);
    if (res.ok) {
      const ct = res.headers.get('content-type') || '';
      return ct.includes('application/json') ? res.json() : null;
    }

    const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (transient && attempt === 0) continue;

    const body = await res.text();
    if (res.status === 429) {
      throw new Error('Spotify is throttling us, give it a moment.');
    }
    if (res.status >= 500 && res.status < 600) {
      throw new Error('Spotify is having a hiccup — try again in a sec.');
    }
    // /me/devices returns 404 "Service not found" when no Spotify Connect devices
    // are registered to the account. Wake the speakers up by opening Spotify on your
    // phone and selecting them from the device picker, or sign into Spotify inside the HEOS app.
    if (res.status === 404 && pathAndQuery.startsWith('/me/') && /Service not found/i.test(body)) {
      throw new Error(
        'No Spotify Connect devices registered to your account. Open Spotify on your phone, tap the device picker, and select your HEOS speaker once to register it. Or sign into Spotify in the HEOS app (Music → Spotify).'
      );
    }
    throw new Error(`Spotify API ${pathAndQuery} failed: ${res.status} ${body}`);
  }
  // Loop always throws or returns above; this is just a typescript-friendly fallback.
  throw new Error("Couldn't reach Spotify (network blip). Try again.");
}

// Spotify rejects unknown values in the type= query. Whitelist against the
// official enum so a typo or attacker-controlled value can't make the upstream
// 4xx and bubble back as our error.
const VALID_SEARCH_TYPES = new Set(['track', 'playlist', 'album', 'artist', 'show', 'episode']);
/** @param {string} query @param {string[]} types - filtered against Spotify's enum. @returns {Promise<object>} raw search payload. */
export async function search(query, types = ['track']) {
  const filtered = types.filter((t) => VALID_SEARCH_TYPES.has(t));
  if (!filtered.length) throw new Error('search requires at least one valid type');
  const q = new URLSearchParams({ q: query, type: filtered.join(',') });
  return api(`/search?${q}`);
}

/** @returns {Promise<Array<{id:string,name:string,type:string,is_active:boolean}>>} Spotify Connect devices visible to this user. */
export async function getDevices() {
  const r = await api('/me/player/devices');
  return r?.devices || [];
}

/** @param {string} playerName - HEOS player name; trimmed and case-insensitive matched. @returns {Promise<object|null>} */
export async function findDeviceForPlayer(playerName) {
  const devices = await getDevices();
  const target = playerName.trim().toLowerCase();
  const exact = devices.find((d) => (d.name || '').trim().toLowerCase() === target);
  if (exact) return exact;
  return devices.find((d) => (d.name || '').trim().toLowerCase().includes(target)) || null;
}

/** @param {string} deviceId @param {boolean} play - resume after transfer. */
export async function transferPlayback(deviceId, play = true) {
  return api('/me/player', {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play }),
  });
}

/** @param {string} deviceId @param {{contextUri?:string,uris?:string[],offsetUri?:string}} args */
export async function play(deviceId, { contextUri, uris, offsetUri } = {}) {
  const body = {};
  if (contextUri) body.context_uri = contextUri;
  if (uris) body.uris = uris;
  if (offsetUri) body.offset = { uri: offsetUri };
  return api(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/** @param {string} deviceId */
export async function pause(deviceId) {
  return api(`/me/player/pause?device_id=${encodeURIComponent(deviceId)}`, { method: 'PUT' });
}

// Pause the currently-active Spotify session, whichever device owns it. Used
// by the "kill session" button when playback is stuck on the wrong speaker
// (e.g. wife's Echo Dot grabbed the session). Idempotent — when nothing is
// playing, Spotify 404s with NO_ACTIVE_DEVICE; we swallow it so the button
// behaves like "make sure nothing is playing" rather than erroring.
export async function pauseActive() {
  try {
    return await api('/me/player/pause', { method: 'PUT' });
  } catch (e) {
    if (/NO_ACTIVE_DEVICE|Player command failed/i.test(e.message)) return null;
    throw e;
  }
}

/** @param {string} deviceId */
export async function next(deviceId) {
  return api(`/me/player/next?device_id=${encodeURIComponent(deviceId)}`, { method: 'POST' });
}

/** @param {string} deviceId */
export async function previous(deviceId) {
  return api(`/me/player/previous?device_id=${encodeURIComponent(deviceId)}`, { method: 'POST' });
}

/** @param {number} positionMs - clamped at the call site; Spotify rejects negatives. */
export async function seek(positionMs) {
  const ms = Math.max(0, Math.floor(positionMs));
  return api(`/me/player/seek?position_ms=${ms}`, { method: 'PUT' });
}

/** @param {boolean} on */
export async function setShuffle(on) {
  return api(`/me/player/shuffle?state=${on ? 'true' : 'false'}`, { method: 'PUT' });
}

/** @param {'off'|'context'|'track'} mode */
export async function setRepeat(mode) {
  if (!['off', 'context', 'track'].includes(mode)) throw new Error('invalid repeat mode');
  return api(`/me/player/repeat?state=${mode}`, { method: 'PUT' });
}

/** @returns {Promise<object>} Spotify user profile. */
export async function getMe() {
  return api('/me');
}

/**
 * F3: track progress polling. Spotify is the source of truth for position
 * within a track (HEOS doesn't expose it). Also returns track metadata —
 * when playback is via Spotify Connect, HEOS's get_now_playing_media returns
 * no song/title, so the UI uses these fields for the Now Playing card.
 */
export async function getPlayback() {
  const r = await api('/me/player');
  if (!r || !r.item) return null;
  const item = r.item;
  const artist = (item.artists || []).map((a) => a.name).filter(Boolean).join(', ');
  return {
    progress_ms: r.progress_ms ?? 0,
    duration_ms: item.duration_ms ?? 0,
    is_playing: !!r.is_playing,
    track_id: item.id || null,
    song: item.name || '',
    artist,
    album: item.album?.name || '',
    image_url: item.album?.images?.[0]?.url || '',
    shuffle_state: !!r.shuffle_state,
    repeat_state: r.repeat_state || 'off',
    // Active Connect device — surfaced so the client can detect when a
    // foreign device (Echo Dot, phone, laptop) steals the session away from
    // the HEOS speaker we just transferred to.
    device_id: r.device?.id || null,
    device_name: r.device?.name || '',
  };
}

/** @returns {Promise<object[]>} up to 20 of the user's playlists. */
export async function getMyPlaylists() {
  const r = await api('/me/playlists?limit=20');
  return r?.items || [];
}

/**
 * Up-next queue. The frontend uses queue[0] to optimistically swap the Now
 * Playing title/art the instant the user taps Next, instead of waiting the
 * 500-1500ms it takes Spotify to propagate a Connect-relayed skip.
 * Trimmed to {song, artist, image_url, uri} per item and capped at 5 — we
 * only need queue[0] today, but a small lookahead is cheap and lets a
 * double-tap still hit a known title.
 * @returns {Promise<Array<{song:string,artist:string,image_url:string,uri:string}>>}
 */
export async function getQueue() {
  const r = await api('/me/player/queue');
  const items = r?.queue || [];
  return items.slice(0, 5).map((it) => ({
    song: it?.name || '',
    artist: (it?.artists || []).map((a) => a?.name).filter(Boolean).join(', '),
    image_url: it?.album?.images?.[0]?.url || '',
    uri: it?.uri || '',
  }));
}

/**
 * Look up a single track. Used by /api/play to resolve a track's parent album,
 * so we can play the track inside its album context (offset = track URI). That
 * lets Spotify's account-level Autoplay extend with similar songs after the
 * album finishes — bare `uris: [track]` plays the one track and stops.
 * @param {string} trackId
 * @returns {Promise<object>} Spotify track object including album.uri.
 */
export async function getTrack(trackId) {
  return api(`/tracks/${encodeURIComponent(trackId)}`);
}
