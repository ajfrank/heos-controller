import 'dotenv/config';
import http from 'node:http';

import { getHeos } from './heos.js';
import * as spotify from './spotify.js';
import { state } from './state.js';
import { createApp, attachWebSocket, initHeosState, refreshDeviceCache } from './app.js';

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
  const tick = () => refreshDeviceCache({ spotify, state });
  tick();
  cachePollTimer = setInterval(tick, DEVICE_CACHE_POLL_MS);
}

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[server] http://localhost:${PORT}`);
  try {
    heosClient = await getHeos();
    await initHeosState({ heos: heosClient, state });
    app.locals.setHeosReady();
    startDeviceCachePoll();
  } catch (e) {
    console.error('[server] HEOS init failed:', e.message);
    console.error('  Hint: make sure a HEOS speaker is on the same network. Set HEOS_HOST=<ip> to skip discovery.');
  }
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
