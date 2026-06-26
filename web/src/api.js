// Custom event emitted when the server signals Spotify needs to be reconnected
// (refresh token revoked / 401 from Spotify after a successful token refresh).
// App.jsx listens and force-shows the existing connect banner.
export const SPOTIFY_REAUTH_EVENT = 'heos:spotify-reauth';

// Default 10s covers fast routes (state, control, search). Mutations that can
// legitimately take seconds — /api/play (HEOS retries + Spotify wake) and
// /api/zones/active (group apply with EID7/11/13 retries) — pass a longer
// timeout. Without an explicit AbortController the browser holds /fetch open
// indefinitely on a Pi WiFi blip; the UI looks frozen with no toast.
async function jsonFetch(url, init = {}, { timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: init.signal || ctrl.signal });
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      let parsed = null;
      try { parsed = JSON.parse(text); msg = parsed.error || text; } catch {}
      if (parsed?.code === 'reauth') {
        try { window.dispatchEvent(new CustomEvent(SPOTIFY_REAUTH_EVENT)); }
        catch {}
      }
      throw new Error(msg || `${res.status} ${res.statusText}`);
    }
    return res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  state: () => jsonFetch('/api/state'),
  setActive: (zones) =>
    jsonFetch(
      '/api/zones/active',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zones }),
      },
      { timeoutMs: 20_000 },
    ),
  search: (q, opts) => jsonFetch(`/api/search?q=${encodeURIComponent(q)}`, opts),
  play: (body) =>
    jsonFetch(
      '/api/play',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      { timeoutMs: 20_000 },
    ),
  control: (action, value) =>
    jsonFetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value === undefined ? { action } : { action, value }),
    }),
  setVolume: (zone, level) =>
    jsonFetch('/api/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone, level }),
    }),
  playbackPosition: () => jsonFetch('/api/playback/position'),
  seek: (ms) =>
    jsonFetch('/api/playback/seek', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms }),
    }),
  spotifyDisconnect: () =>
    jsonFetch('/api/spotify/disconnect', { method: 'POST' }),
  stopAll: () => jsonFetch('/api/stop-all', { method: 'POST' }, { timeoutMs: 20_000 }),
  removeRecent: (uri) =>
    jsonFetch('/api/recents/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri }),
    }),
};

// connectWS returns a managed connection: tracks attempts, applies exponential
// backoff (1s → 10s capped), de-duplicates parallel reconnects, and exposes a
// close() that cancels both the timer and any in-flight socket. Callers only
// need close() — receive messages via the onMessage callback.
// 10s cap (vs 30s) keeps a wall-tablet from sitting stale for half a minute
// after a LAN blip resolves — the Pi is on the same network, so recovery is
// usually sub-second once routing is back.
export function connectWS(onMessage) {
  let attempt = 0;
  let socket = null;
  let timer = null;
  let cancelled = false;

  function open() {
    if (cancelled) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${proto}//${location.host}/ws`);
    socket.onopen = () => {
      // Re-check cancellation: a fast unmount-then-remount (React 18 StrictMode
      // in dev, HMR in prod) can fire close() after `new WebSocket(...)` but
      // before `onopen`. Without this guard we'd leak an orphan open socket
      // that the cleanup never sees.
      if (cancelled) { try { socket?.close(); } catch {} return; }
      attempt = 0;
    };
    socket.onmessage = (ev) => {
      if (cancelled) return;
      try { onMessage(JSON.parse(ev.data)); } catch {}
    };
    socket.onclose = () => {
      socket = null;
      if (cancelled) return;
      const delay = Math.min(10_000, 1000 * Math.pow(2, attempt));
      attempt += 1;
      timer = setTimeout(() => { timer = null; open(); }, delay);
    };
  }

  open();

  return {
    close() {
      cancelled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (socket) {
        try { socket.close(); } catch {}
        socket = null;
      }
    },
  };
}

// Keep the wall-tablet's screen awake while the app is foregrounded.
// Safari requires a user gesture to grant; we re-acquire on visibilitychange.
let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    // Permission denied or unsupported — silent.
  }
}

export function setupWakeLock() {
  if (!('wakeLock' in navigator)) return;
  // First gesture re-acquires on iOS Safari; visibilitychange handles tab switches.
  document.addEventListener('pointerdown', acquireWakeLock, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquireWakeLock();
  });
  acquireWakeLock();
}
