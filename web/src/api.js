// Custom event emitted when the server signals Spotify needs to be reconnected
// (refresh token revoked / 401 from Spotify after a successful token refresh).
// App.jsx listens and force-shows the existing connect banner.
export const SPOTIFY_REAUTH_EVENT = 'heos:spotify-reauth';

async function jsonFetch(url, init) {
  const res = await fetch(url, init);
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
}

export const api = {
  state: () => jsonFetch('/api/state'),
  setActive: (pids) =>
    jsonFetch('/api/zones/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pids }),
    }),
  search: (q, opts) => jsonFetch(`/api/search?q=${encodeURIComponent(q)}`, opts),
  play: (body) =>
    jsonFetch('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  control: (action) =>
    jsonFetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }),
  setVolume: (pid, level) =>
    jsonFetch('/api/volume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid, level }),
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
};

// connectWS returns a managed connection: tracks attempts, applies exponential
// backoff (1s → 30s capped), de-duplicates parallel reconnects, and exposes a
// close() that cancels both the timer and any in-flight socket. Callers only
// need close() — receive messages via the onMessage callback.
export function connectWS(onMessage) {
  let attempt = 0;
  let socket = null;
  let timer = null;
  let cancelled = false;

  function open() {
    if (cancelled) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${proto}//${location.host}/ws`);
    socket.onopen = () => { attempt = 0; };
    socket.onmessage = (ev) => {
      if (cancelled) return;
      try { onMessage(JSON.parse(ev.data)); } catch {}
    };
    socket.onclose = () => {
      socket = null;
      if (cancelled) return;
      const delay = Math.min(30_000, 1000 * Math.pow(2, attempt));
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
