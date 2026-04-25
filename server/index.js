import 'dotenv/config';
import http from 'node:http';

import { getHeos } from './heos.js';
import * as spotify from './spotify.js';
import { state } from './state.js';
import { createApp, attachWebSocket, initHeosState, refreshDeviceCache } from './app.js';

// Crash loudly. Node 20+ already exits on unhandledRejection, but the default
// stack dump lands without a marker line — on a headless Pi reading via
// journalctl, a single grep-able [fatal] tag makes the difference between a
// 30-second triage and a half-hour scroll. We exit(1) so systemd's
// Restart=on-failure fires; swallowing would leave the process in an unknown
// state.
process.on('uncaughtException', (e) => {
  console.error('[fatal] uncaughtException:', e?.stack || e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandledRejection:', e?.stack || e);
  process.exit(1);
});

const PORT = Number(process.env.PORT || 8080);

let heosClient = null;
const app = createApp({ heos: () => heosClient, spotify, state });
const server = http.createServer(app);
attachWebSocket(server, { state, spotify });

// Background poll that keeps the pid → Spotify device_id cache warm. The wake
// path in /api/play needs at least one cached ID per zone; without proactive
// seeding the very first cold-start is unrecoverable from inside the
// controller (all zones idle ⇒ none visible ⇒ no cache ⇒ stuck). 60s is slow
// enough that getDevices doesn't hammer Spotify, fast enough that the wife's
// brief speaker-pick on her phone is captured before she next taps Play.
const DEVICE_CACHE_POLL_MS = 60_000;
let cachePollTimer = null;
function startDeviceCachePoll() {
  if (cachePollTimer) return;
  // Catch on the tick: refreshDeviceCache only wraps getDevices() in a
  // try/catch; persist.read/write failures (rare FS errors on a Pi under
  // load) would otherwise become unhandled rejections.
  const tick = () => refreshDeviceCache({ spotify, state })
    .catch((e) => console.warn('[device-cache] poll failed:', e.message));
  tick();
  cachePollTimer = setInterval(tick, DEVICE_CACHE_POLL_MS);
}

// Retry HEOS init on failure with linear backoff capped at 60s. Without this,
// a Pi that boots before the speakers do (cold-power-on after a power blip)
// would leave the HTTP server up but unusable: the catch path runs once,
// /healthz reports 503 forever, and systemd's Restart=on-failure never fires
// because the process is "healthy" from its POV. The retry keeps the HTTP
// server alive (so /healthz still reports 503 to any external monitor) and
// reconnects unattended once the speakers are reachable.
let heosInitAttempt = 0;
async function initHeos() {
  heosInitAttempt += 1;
  heosClient = await getHeos();
  await initHeosState({ heos: heosClient, state });
  app.locals.setHeosReady();
  startDeviceCachePoll();
  heosInitAttempt = 0;
}
function scheduleHeosInit() {
  initHeos().catch((e) => {
    const delay = Math.min(60_000, heosInitAttempt * 5_000);
    console.error(`[server] HEOS init failed (attempt ${heosInitAttempt}):`, e.message);
    if (heosInitAttempt === 1) {
      console.error('  Hint: make sure a HEOS speaker is on the same network. Set HEOS_HOST=<ip> to skip discovery.');
    }
    console.error(`  Retrying in ${delay / 1000}s.`);
    setTimeout(scheduleHeosInit, delay).unref();
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] http://localhost:${PORT}`);
  scheduleHeosInit();
});

// Release the port on hot reload (`node --watch`) and on Ctrl-C; without
// this, the next process EADDRINUSEs because the listener is still alive.
function shutdown() {
  if (cachePollTimer) clearInterval(cachePollTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
