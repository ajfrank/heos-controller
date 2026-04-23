import express from 'express';
import compression from 'compression';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { readJson, writeJson } from './persist.js';
import { findMatchingDevice } from './wake.js';
import { REAUTH_SENTINEL } from './spotify.js';
import { resolveZones } from './zones.js';

// Centralized error → response translation for routes that touch Spotify.
// REAUTH_SENTINEL → 401 + code:'reauth' so the UI can flip the banner without
// scraping error text. Everything else → opaque 500.
function sendErr(res, e) {
  if (e?.message === REAUTH_SENTINEL) {
    return res.status(401).json({ error: 'Reconnect Spotify', code: 'reauth' });
  }
  res.status(500).json({ error: e.message });
}

// Allow-list of browser origins permitted to drive the API and the WS. Same
// env var, used in two places (CSRF middleware in createApp, verifyClient in
// attachWebSocket) so adding the Pi's hostname turns BOTH on at once. Default
// covers the served-from-server origins (:8080) plus Vite's dev server (:5173).
function parseAllowedOrigins() {
  return new Set(
    (process.env.WS_ALLOWED_ORIGINS ||
      'http://localhost:8080,http://127.0.0.1:8080,http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RECENTS_FILE = 'recents.json';
const RECENTS_CAP = 8;
// Persisted pid → Spotify device_id map. Spotify's /me/player/devices only
// lists currently-advertising Connect devices, but PUT /me/player accepts a
// device_id from any device Spotify has seen recently and will trigger a
// wake handshake. Caching IDs from successful plays gives us a wake path
// for sleeping speakers without making the wife touch her phone.
const DEVICE_CACHE_FILE = 'spotify-devices.json';
// Spotify URI shape: spotify:<type>:<base62-id>. Only the playable types are
// allowed (no spotify:user:..., no spotify:local:..., no playlists with
// embedded user paths). Keeps /api/play from forwarding garbage upstream.
const SPOTIFY_URI_RE = /^spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]+$/;

export function createApp({ heos, spotify, state, persist = { read: readJson, write: writeJson } }) {
  // Allow `heos` to be passed as either an instance or a getter, so the bootstrap
  // can swap in the real client after async discovery without holding up listen().
  const getH = typeof heos === 'function' ? heos : () => heos;

  // Serialize mutations that read state.activePids and then act (zone toggles
  // and play). Without this, two interleaved requests can each snapshot prior,
  // mutate, then roll back — clobbering each other. heos.applyGroup has its
  // own coalescer, but that's per-HEOS-call, not per-route; race windows still
  // exist around the snapshot/apply pair. Single chained promise; cheap.
  let groupChain = Promise.resolve();
  function serializeGroupOp(fn) {
    const next = groupChain.then(fn, fn);
    // Don't poison the chain on rejection — rejections should reach the caller
    // via `next`, but the chain itself should keep accepting work.
    groupChain = next.catch(() => {});
    return next;
  }

  const app = express();
  // Gzip the bundle (~603KB → ~180KB) and JSON responses. Place before
  // express.static so the static middleware's response stream gets compressed.
  app.use(compression());
  app.use(express.json());

  // CSRF defense for /api/* mutations. A malicious page on attacker.com could
  // simple-form-post to http://heos.local:8080/api/spotify/disconnect (or any
  // other state-changing route) without us ever loading. Browsers always set
  // Origin on cross-origin requests, so reject any request whose Origin is set
  // but NOT in the allow-list. Header-less requests (curl, server-to-server,
  // some same-origin native fetches) pass through — they aren't a browser CSRF
  // vector. GETs are exempt (the only mutation-via-GET path we have is the
  // OAuth callback, which is bound to a single-use state token already).
  const allowedOrigins = parseAllowedOrigins();
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.get('Origin');
    if (!origin || allowedOrigins.has(origin)) return next();
    res.status(403).json({ error: 'forbidden origin' });
  });

  // Readiness: routes that need a HEOS client return 503 until the bootstrap calls
  // app.locals.setHeosReady(). /api/state and OAuth don't touch heos so they pass through.
  let heosReady = false;
  app.locals.setHeosReady = () => { heosReady = true; };
  const READY_EXEMPT = new Set(['/api/state', '/api/spotify/login', '/api/spotify/callback', '/api/spotify/debug']);
  app.use('/api', (req, res, next) => {
    // Inside an app.use('/api', ...) middleware, req.path is mount-relative
    // ('/state'), so reconstruct the full path for the exempt check.
    const fullPath = req.baseUrl + req.path;
    if (heosReady || READY_EXEMPT.has(fullPath)) return next();
    res.status(503).json({ error: 'starting up' });
  });

  // Hydrate recents from disk on first createApp() call so the very first WS
  // snapshot is complete. Routes mutate state + write disk together. Filter
  // shape-invalid entries — if recents.json is hand-edited or corrupted, an
  // entry with `art: 'javascript:...'` would otherwise reach <img src> in the
  // QuickPicks render. Cheap defensive check at the trust boundary.
  state.setRecents(
    (persist.read(RECENTS_FILE, []) || []).filter(
      (r) =>
        r &&
        typeof r.uri === 'string' && SPOTIFY_URI_RE.test(r.uri) &&
        typeof r.label === 'string' &&
        typeof r.sublabel === 'string' &&
        (typeof r.art !== 'string' ? false : r.art === '' || /^https:\/\//.test(r.art)),
    ),
  );

  app.get('/api/state', (_req, res) => {
    res.json({ ...state.snapshot(), spotifyConnected: spotify.isConnected() });
  });

  // External health check for systemd / uptime monitors. 200 means HEOS is
  // bootstrapped and we're answering normally; 503 means we're alive but
  // can't talk to speakers yet (still in the discovery → connect window, or
  // HEOS reconnect is in progress). Spotify is reported but doesn't gate
  // health — the controller is still useful as a HEOS-only client.
  app.get('/healthz', (_req, res) => {
    const body = { ok: heosReady, heos: heosReady, spotify: spotify.isConnected() };
    res.status(heosReady ? 200 : 503).json(body);
  });

  app.post('/api/zones/active', async (req, res) => {
    const { zones } = req.body;
    if (!Array.isArray(zones)) {
      return res.status(400).json({ error: 'zones must be an array of zone names' });
    }
    const known = new Set(state.zones.map((z) => z.name));
    const unknown = zones.map(String).filter((z) => !known.has(z));
    if (unknown.length) {
      return res.status(400).json({ error: `unknown zone(s): ${unknown.join(', ')}` });
    }
    await serializeGroupOp(async () => {
      // Snapshot prior selection BEFORE optimistic update so we can roll back
      // if HEOS rejects the regroup. Without this, the client rolls back its
      // own optimistic toggle but the server keeps the new selection — the next
      // /api/play then acts on zones the user already abandoned.
      const prior = state.activeZones.slice();
      state.setActiveZones(zones);
      try {
        // Empty selection = best-effort no-op (don't issue an empty set_group).
        const pids = state.activePids;
        if (pids.length) await getH().applyGroup(pids);
        res.json({ ok: true });
      } catch (e) {
        state.setActiveZones(prior);
        res.status(500).json({ error: e.message });
      }
    });
  });

  app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'q is required' });
    // Cap query length: Spotify itself rejects > 100 chars and a 1MB query
    // string trivially fills our memory before we get there.
    if (String(q).length > 100) {
      return res.status(400).json({ error: 'q must be 100 characters or fewer' });
    }
    try {
      const results = await spotify.search(String(q), ['track', 'playlist', 'album']);
      res.json({ ok: true, source: 'spotify', results });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/play', async (req, res) => {
    await serializeGroupOp(() => playHandler(req, res));
  });
  async function playHandler(req, res) {
    try {
      const pids = state.activePids;
      if (!pids.length) return res.status(400).json({ error: 'No active zones selected' });
      const { uri, label, sublabel, art, badge } = req.body;
      if (!uri) return res.status(400).json({ error: 'uri required' });
      // Validate the URI shape before we hand it to Spotify. A malformed body
      // would otherwise surface as an opaque Spotify 4xx — easier to debug
      // here at the entry point.
      if (!SPOTIFY_URI_RE.test(String(uri))) {
        return res.status(400).json({ error: 'uri must be a Spotify URI like spotify:track:<id>' });
      }

      // Spotify only needs ONE speaker in the HEOS group to be a Connect device —
      // HEOS group sync mirrors audio to the rest. Pick the first active zone that
      // Spotify currently sees, then promote it to HEOS group leader for playback.
      //
      // getDevices (Spotify) and getGroups (HEOS) are independent reads — running
      // them in parallel saves ~150–300ms off every play tap.
      const h = getH();
      const [seen, groups] = await Promise.all([
        spotify.getDevices().catch(() => []),
        h.getGroups().catch(() => null),
      ]);

      // Try the live device list first (speakers currently advertising). If
      // none of our pids match, fall back to cached device IDs from prior
      // sessions — Spotify's transferPlayback can wake an idle Connect
      // daemon by ID even when /me/player/devices doesn't list it.
      const liveMatch = findMatchingDevice(seen, pids, state.players);
      let resolvedDeviceId = liveMatch?.device?.id ?? null;
      let resolvedDeviceName = liveMatch?.device?.name ?? null;
      let leaderPid = liveMatch?.leaderPid ?? null;
      let via = liveMatch ? 'spotify-connect-live' : null;

      const deviceCache = persist.read(DEVICE_CACHE_FILE, {});
      // Opportunistically seed the cache for every speaker Spotify can see right
      // now (not just the leader). Future plays can wake any of them without
      // having to be the active zone first.
      let cacheDirty = false;
      for (const d of seen) {
        const dn = (d.name || '').trim().toLowerCase();
        if (!dn || !d.id) continue;
        const player = state.players.find(
          (p) => (p.name || '').trim().toLowerCase() === dn,
        );
        if (player && deviceCache[player.pid] !== d.id) {
          deviceCache[player.pid] = d.id;
          cacheDirty = true;
        }
      }
      if (!leaderPid) {
        // Try cached IDs in active-pid order — first match wins. This is the
        // wake path: even if Spotify doesn't currently see the speaker, it
        // will accept a transferPlayback to a known device and try to bring
        // its Connect daemon back online.
        for (const pid of pids) {
          const cachedId = deviceCache[pid];
          if (!cachedId) continue;
          const cachedName = state.players.find((p) => p.pid === pid)?.name || pid;
          resolvedDeviceId = cachedId;
          resolvedDeviceName = cachedName;
          leaderPid = pid;
          via = 'spotify-connect-wake';
          break;
        }
      }

      const noLeaderMessage = () => {
        const wanted = pids
          .map((p) => state.players.find((pl) => pl.pid === p)?.name?.trim())
          .filter(Boolean)
          .join(', ');
        const seenStr = seen.length
          ? ` Spotify currently sees: ${seen.map((d) => (d.name || '').trim()).join(', ')}.`
          : ' Spotify sees no devices right now.';
        return `Your zones (${wanted}) aren't visible to Spotify yet, and we don't have a cached ID to wake them. Open Spotify on your phone, pick one of these speakers once, then try again.${seenStr}`;
      };

      if (!leaderPid) {
        // Persist any opportunistic matches we found above so the next tap
        // benefits even if this one fails for the user.
        if (cacheDirty) {
          try { persist.write(DEVICE_CACHE_FILE, deviceCache); }
          catch (e) { console.warn('[heos] device cache persist failed:', e.message); }
        }
        return res.status(404).json({ error: noLeaderMessage() });
      }

      // Snapshot the group an active pid currently belongs to BEFORE we
      // re-group, so we can roll back if playback fails. Without this, a
      // failed handoff leaves the speakers grouped on a leader that's playing
      // nothing. `groups === null` = getGroups failed above; we just can't
      // roll back precisely in that case.
      let priorGroupPids = null;
      if (groups) {
        const containing = groups.find((g) =>
          (g.players || []).some((p) => pids.includes(String(p.pid))),
        );
        if (containing) {
          priorGroupPids = (containing.players || []).map((p) => String(p.pid));
        }
      }
      const orderedPids = [leaderPid, ...pids.filter((p) => p !== leaderPid)];
      await h.applyGroup(orderedPids);

      try {
        // transferPlayback with play=true on the wake path so Spotify wakes
        // the Connect daemon AND starts playback in one round trip. On the
        // live path we keep play=false and follow with an explicit play()
        // so the URI is honored (transfer alone resumes the previous queue).
        const wakePath = via === 'spotify-connect-wake';
        try {
          await spotify.transferPlayback(resolvedDeviceId, wakePath);
        } catch (transferErr) {
          // Idle Connect daemons sometimes need a second poke. The first
          // transfer kicks the daemon awake; the second succeeds. Skip the
          // retry on "Device not found" — that's the cache-prune signal that
          // the device id is genuinely stale, not a transient wake-up race.
          const isStale = /not found|NO_ACTIVE_DEVICE|Device not found/i.test(transferErr.message);
          if (!wakePath || isStale) throw transferErr;
          await new Promise((r) => setTimeout(r, 1000));
          await spotify.transferPlayback(resolvedDeviceId, wakePath);
        }
        const playArgs = uri.includes(':track:') ? { uris: [uri] } : { contextUri: uri };
        await spotify.play(resolvedDeviceId, playArgs);
      } catch (playErr) {
        // If the cached deviceId is stale (speaker reset, account changed),
        // Spotify returns 404 "Device not found". Drop that entry so we don't
        // keep retrying it on every play tap.
        const stale = via === 'spotify-connect-wake' &&
          /not found|NO_ACTIVE_DEVICE|Device not found/i.test(playErr.message);
        if (stale) {
          const next = { ...deviceCache };
          delete next[leaderPid];
          try { persist.write(DEVICE_CACHE_FILE, next); }
          catch (e) { console.warn('[heos] device cache persist failed:', e.message); }
        }
        // Restore the prior group; if there wasn't one, ungroup the leader so
        // the user can pick zones cleanly without stale speakers attached.
        let rollbackOk = true;
        try {
          if (priorGroupPids?.length) await h.applyGroup(priorGroupPids);
          else await h.applyGroup([leaderPid]);
        } catch (rollbackErr) {
          rollbackOk = false;
          // The HEOS group state is now ambiguous — original mutation succeeded,
          // playback failed, AND we couldn't restore the prior group. Force a
          // fresh snapshot to all WS clients so the UI doesn't strand showing
          // a group that doesn't exist on the speakers.
          console.warn('[heos] rollback applyGroup failed:', rollbackErr.message);
          state.emit('snapshot');
        }
        // A stale wake is the user's "speaker is asleep" path — surface the
        // same actionable 404 the no-leader branch returns instead of an
        // opaque 500. Without this, the first tap looks like a server crash;
        // only the second tap (after the cache is pruned) shows the toast.
        if (stale) return res.status(404).json({ error: noLeaderMessage() });
        if (!rollbackOk) {
          // Distinct code so the client can decide to refetch / show a louder
          // toast, instead of treating it like an ordinary play failure.
          return res.status(500).json({ error: playErr.message, code: 'state_dirty' });
        }
        throw playErr;
      }

      // Cache the deviceId for this pid so future "speaker is asleep" cases
      // can wake it without the wife touching her phone. Always update on
      // success so the most recent ID wins (handles speaker hardware swaps).
      try {
        const updated = { ...deviceCache, [leaderPid]: resolvedDeviceId };
        persist.write(DEVICE_CACHE_FILE, updated);
      } catch (e) {
        console.warn('[heos] device cache persist failed:', e.message);
      }

      // Log to recents only on success. Dedup by uri so replays don't cascade
      // a row of identical tiles to the top.
      if (label) {
        const next = [
          { uri, label, sublabel: sublabel || '', art: art || '', badge: badge || '', ts: Date.now() },
          ...state.recents.filter((r) => r.uri !== uri),
        ].slice(0, RECENTS_CAP);
        state.setRecents(next);
        try { persist.write(RECENTS_FILE, next); }
        catch (e) { console.warn('[heos] recents persist failed:', e.message); }
      }
      res.json({ ok: true, via, device: resolvedDeviceName });
    } catch (e) {
      sendErr(res, e);
    }
  }

  // Remove a single recent (the wife taps × on a tile in Edit mode). Pinned
  // items live in localStorage so they're managed client-side; recents are
  // server state that must be persisted so the deletion survives reboots.
  app.post('/api/recents/remove', async (req, res) => {
    const { uri } = req.body || {};
    if (!uri || typeof uri !== 'string') return res.status(400).json({ error: 'uri required' });
    const next = state.recents.filter((r) => r.uri !== uri);
    state.setRecents(next);
    try { persist.write(RECENTS_FILE, next); }
    catch (e) { console.warn('[heos] recents persist failed:', e.message); }
    res.json({ ok: true });
  });

  // F3: progress proxy. Client polls every ~5s while a track is playing and
  // tab is visible; we just shuttle Spotify's /me/player. Returning 200 +
  // null when nothing is playing keeps the client's polling loop simple.
  app.get('/api/playback/position', async (_req, res) => {
    try {
      const pb = await spotify.getPlayback();
      res.json({ ok: true, playback: pb });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // F3: tap the progress bar → seek. Spotify accepts a global seek (no
  // device_id) — it targets whichever device is currently active, which is
  // exactly what we want post-transferPlayback.
  app.post('/api/playback/seek', async (req, res) => {
    const { ms } = req.body || {};
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      return res.status(400).json({ error: 'ms must be a non-negative number' });
    }
    try {
      await spotify.seek(ms);
      res.json({ ok: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  // Kill-switch for a stuck Spotify session. If playback gets stranded on
  // the wrong speaker (e.g. wife's Echo Dot grabbed the session and HEOS
  // can't get it back), this hits Spotify's pause endpoint and forces the
  // active device to release. Cheap, idempotent — safe to tap twice.
  app.post('/api/spotify/disconnect', async (_req, res) => {
    try {
      await spotify.pauseActive();
      res.json({ ok: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/control', async (req, res) => {
    const { action, value } = req.body;
    try {
      // Shuffle/repeat go straight to Spotify — playback state lives there
      // when we're driving via Spotify Connect, and HEOS's set_play_mode
      // doesn't propagate to the Spotify session.
      if (action === 'shuffle') {
        await spotify.setShuffle(!!value);
        return res.json({ ok: true });
      }
      if (action === 'repeat') {
        await spotify.setRepeat(value);
        return res.json({ ok: true });
      }
      const pid = state.activePids[0];
      if (!pid) return res.status(400).json({ error: 'No active zones' });
      const h = getH();
      if (action === 'pause') await h.setPlayState(pid, 'pause');
      else if (action === 'play') await h.setPlayState(pid, 'play');
      else if (action === 'next') await h.playNext(pid);
      else if (action === 'previous') await h.playPrevious(pid);
      else return res.status(400).json({ error: 'unknown action' });
      res.json({ ok: true });
    } catch (e) {
      sendErr(res, e);
    }
  });

  app.post('/api/volume', async (req, res) => {
    const { zone, level } = req.body;
    if (typeof level !== 'number') return res.status(400).json({ error: 'level required' });
    if (!zone) return res.status(400).json({ error: 'zone required' });
    const z = state.zones.find((x) => x.name === zone);
    if (!z) return res.status(400).json({ error: `unknown zone: ${zone}` });
    // Master volume = set every speaker in the zone to the same level.
    // HEOS group sync mirrors audio but NOT volume; each speaker's level
    // is independent. allSettled (not all) so one offline speaker doesn't
    // strand the rest at the old level — partial success is the more useful
    // outcome here than all-or-nothing.
    const h = getH();
    const results = await Promise.allSettled(
      z.pids.map((pid) => h.setVolume(pid, level)),
    );
    const failed = [];
    for (let i = 0; i < z.pids.length; i++) {
      const pid = z.pids[i];
      if (results[i].status === 'fulfilled') state.setVolume(pid, level);
      else failed.push({ pid, reason: results[i].reason?.message || 'unknown' });
    }
    if (failed.length === z.pids.length) {
      // Every speaker rejected — surface the first error so the caller has
      // something actionable to display.
      return res.status(500).json({ error: failed[0].reason });
    }
    if (failed.length) {
      // Partial success: applied state for the speakers that took it; report
      // 207-style success-with-warnings so the caller can decide whether to
      // toast (we don't actually use 207 to keep the response shape simple).
      console.warn('[heos] volume partial failure for zone', zone, failed);
      return res.json({ ok: true, partial: true, failedPids: failed.map((f) => f.pid) });
    }
    res.json({ ok: true });
  });

  // Debug route exposes account state — only register when explicitly enabled.
  if (process.env.ENABLE_DEBUG_ROUTES === '1') {
    app.get('/api/spotify/debug', async (_req, res) => {
      const token = await spotify._accessTokenForDebug?.().catch((e) => ({ err: e.message })) ?? null;
      const out = { tokenStatus: spotify.isConnected() ? 'present' : 'missing' };
      for (const p of ['/me', '/me/player', '/me/player/devices', '/me/devices']) {
        try {
          // Mirror the 10s timeout that production fetches in spotify.js use,
          // so a hung Spotify endpoint doesn't pin the debug request forever.
          const r = await fetch(`https://api.spotify.com/v1${p}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
          });
          const text = await r.text();
          out[p] = { status: r.status, body: safeJson(text) };
        } catch (e) {
          out[p] = { error: e.message };
        }
      }
      res.json(out);
    });
  }

  // ---- Spotify OAuth ----
  // Bounded with a soft cap of 100 in-flight states. An attacker spamming
  // /login could otherwise exhaust memory; expired entries get swept on each
  // insert, and the cap returns 429 if real users somehow build up.
  const OAUTH_STATE_CAP = 100;
  const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
  const oauthStates = new Map();
  app.get('/api/spotify/login', (_req, res) => {
    try {
      const now = Date.now();
      for (const [k, exp] of oauthStates) {
        if (exp <= now) oauthStates.delete(k);
      }
      if (oauthStates.size >= OAUTH_STATE_CAP) {
        return res.status(429).send('Too many in-flight Spotify logins, please retry shortly.');
      }
      const oauthState = crypto.randomBytes(16).toString('hex');
      oauthStates.set(oauthState, now + OAUTH_STATE_TTL_MS);
      setTimeout(() => oauthStates.delete(oauthState), OAUTH_STATE_TTL_MS);
      res.redirect(spotify.getAuthUrl(oauthState));
    } catch (e) {
      // Don't reflect the raw exception (often "SPOTIFY_CLIENT_ID not set",
      // sometimes more telling). Log server-side; show user actionable copy.
      console.warn('[spotify] /login failed:', e.message);
      res.status(500).type('text/plain').send('Spotify login failed — please try again.');
    }
  });

  app.get('/api/spotify/callback', async (req, res) => {
    const { code, state: oauthState, error } = req.query;
    // Force text/plain so the (rare) error path can't reflect query-string
    // HTML/JS into the page. Same-origin XSS here would have reach into the
    // controller's REST surface (no CSRF guard on REST routes — only WS).
    if (error) return res.status(400).type('text/plain').send(`Spotify error: ${String(error)}`);
    if (!code || !oauthState || !oauthStates.has(String(oauthState))) {
      return res.status(400).send('Invalid OAuth state');
    }
    oauthStates.delete(String(oauthState));
    try {
      await spotify.exchangeCode(String(code));
      res.send('<html><body style="font-family:system-ui;padding:2rem"><h2>Spotify connected ✓</h2><p>You can close this tab and return to the controller.</p></body></html>');
    } catch (e) {
      console.warn('[spotify] /callback exchange failed:', e.message);
      res.status(500).type('text/plain').send('Spotify connection failed — please try again.');
    }
  });

  // ---- Static frontend ----
  const distDir = path.join(__dirname, '..', 'web', 'dist');
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
      if (err) res.status(404).send('Frontend not built. Run `npm run build:web` or use `npm run dev`.');
    });
  });

  return app;
}

export function attachWebSocket(server, { state, spotify }) {
  // Browsers attach an Origin header to the WS handshake; CLI clients (curl)
  // generally don't. Reject cross-origin browser attempts so a malicious page
  // can't drive the controller from a stranger tab; allow header-less clients
  // for local debugging. Allow-list shared with the REST CSRF middleware.
  const allowed = parseAllowedOrigins();
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info, cb) => {
      const origin = info.origin;
      if (!origin || allowed.has(origin)) return cb(true);
      cb(false, 403, 'Forbidden origin');
    },
  });

  // ws emits 'error' on socket-level failures (RST, half-open detected on
  // write, encoder rejection). With no listener Node escalates to an uncaught
  // exception and the whole controller exits — saw this in practice when an
  // iPad with the PWA backgrounded racing a snapshot send. One listener per
  // client; payload is per-client noise so warn, don't error.
  function safeSend(ws, msg) {
    try { ws.send(msg); }
    catch (e) { console.warn('[ws] send failed:', e.code || e.message); }
  }

  wss.on('connection', (ws) => {
    ws.on('error', (e) => console.warn('[ws] client error:', e.code || e.message));
    safeSend(ws, JSON.stringify({
      type: 'snapshot',
      state: { ...state.snapshot(), spotifyConnected: spotify.isConnected() },
    }));
  });

  const onChange = (change) => {
    const msg = JSON.stringify({ type: 'change', change });
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) safeSend(ws, msg);
    }
  };
  // Force-resync signal: server has discovered the local view of HEOS group
  // state may diverge from reality (e.g. play rollback failed). Push a fresh
  // snapshot to every client so the UI stops trusting its incremental view.
  const onSnapshot = () => {
    const msg = JSON.stringify({
      type: 'snapshot',
      state: { ...state.snapshot(), spotifyConnected: spotify.isConnected() },
    });
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) safeSend(ws, msg);
    }
  };
  state.on('change', onChange);
  state.on('snapshot', onSnapshot);

  return {
    wss,
    close: () => {
      state.off('change', onChange);
      state.off('snapshot', onSnapshot);
      wss.close();
    },
  };
}

// Opportunistically seed the pid → device_id cache from whatever Spotify currently
// sees. Called at boot and on a slow poll so the cache fills passively — without
// requiring the user to first press Play while every zone happens to be awake.
// Silent on error: this runs in the background and shouldn't surface noise.
export async function refreshDeviceCache({
  spotify,
  state,
  persist = { read: readJson, write: writeJson },
}) {
  let devices;
  try { devices = await spotify.getDevices(); }
  catch { return; }
  if (!devices?.length) return;
  const cache = persist.read(DEVICE_CACHE_FILE, {});
  let changed = false;
  for (const d of devices) {
    const name = (d.name || '').trim().toLowerCase();
    if (!name || !d.id) continue;
    const player = state.players.find(
      (p) => (p.name || '').trim().toLowerCase() === name,
    );
    if (!player) continue;
    if (cache[player.pid] !== d.id) {
      cache[player.pid] = d.id;
      changed = true;
    }
  }
  // Drop entries for pids the controller no longer knows about — the speaker
  // was renamed in HEOS or removed from the network. Without this the cache
  // accumulates dead IDs that we'd otherwise try to wake on cold start.
  // Skip pruning when state.players is empty (HEOS hadn't hydrated yet) so
  // we don't blow away a perfectly good cache on startup races.
  if (state.players.length) {
    const known = new Set(state.players.map((p) => String(p.pid)));
    for (const pid of Object.keys(cache)) {
      if (!known.has(String(pid))) {
        delete cache[pid];
        changed = true;
      }
    }
  }
  if (!changed) return;
  try { persist.write(DEVICE_CACHE_FILE, cache); }
  catch (e) { console.warn('[heos] device cache persist failed:', e.message); }
}

// Hydrate state from a freshly-connected HEOS client and subscribe to its events.
// Used by the bootstrap; pulled out so tests can drive it with a fake heos.
export async function initHeosState({ heos, state, log = console }) {
  const players = await heos.getPlayers();
  // Normalize pid to string at the boundary. HEOS JSON delivers pids as
  // numbers; activePids/event-handler pids are strings (URLSearchParams /
  // setActive's stringify). Mixing types breaks `===` comparisons
  // (e.g. ZoneGrid's activePids.includes(p.pid)) and the leader-broadcast
  // guard in setNowPlaying. Normalize once here so downstream can assume strings.
  state.setPlayers(players.map((p) => ({ pid: String(p.pid), name: p.name, model: p.model, ip: p.ip })));
  state.setZones(resolveZones(state.players, log));
  // Hydrate per-player metadata in parallel; HEOS happily handles concurrent
  // requests on a single connection, and serial round-trips were the slowest
  // part of bootstrap on a 4-zone setup.
  await Promise.all(players.map(async (p) => {
    try {
      const v = await heos.getVolume(p.pid);
      if (v != null) state.setVolume(p.pid, v);
      // get_now_playing_media doesn't include playback state — fetch it
      // separately so the UI's play/pause button reflects reality on first paint.
      const [np, ps] = await Promise.all([
        heos.getNowPlaying(p.pid),
        heos.getPlayState(p.pid).catch(() => null),
      ]);
      if (np) state.setNowPlaying(p.pid, ps ? { ...np, state: ps } : np);
    } catch (e) {
      log.warn?.(`[heos] hydrate ${p.pid} failed:`, e.message);
    }
  }));
  wireHeosEvents({ heos, state, log });
}

export function wireHeosEvents({ heos, state, log = console }) {
  const handler = async (frame) => {
    const cmd = frame.heos.command;
    const msg = frame.heos.message || '';
    const params = Object.fromEntries(new URLSearchParams(msg));
    try {
      if (cmd === 'event/players_changed') {
        const players = await heos.getPlayers();
        state.setPlayers(players.map((p) => ({ pid: String(p.pid), name: p.name, model: p.model, ip: p.ip })));
        state.setZones(resolveZones(state.players, log));
      } else if (cmd === 'event/player_now_playing_changed' && params.pid) {
        // Fetch play state alongside the new media so the play/pause button
        // doesn't flash to "Play" between this event and the next state event.
        const [np, ps] = await Promise.all([
          heos.getNowPlaying(params.pid),
          heos.getPlayState(params.pid).catch(() => null),
        ]);
        if (np) state.setNowPlaying(params.pid, ps ? { ...np, state: ps } : np);
      } else if (cmd === 'event/player_state_changed' && params.pid) {
        const np = await heos.getNowPlaying(params.pid);
        if (np) state.setNowPlaying(params.pid, { ...np, state: params.state });
      } else if (cmd === 'event/player_volume_changed' && params.pid) {
        if (params.level) state.setVolume(params.pid, Number(params.level));
      }
    } catch (e) {
      log.warn?.('[heos] event handler error:', e.message);
    }
  };
  heos.on('event', handler);
  return () => heos.off('event', handler);
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}
