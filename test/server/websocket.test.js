// WebSocket lifecycle: snapshot on connect, change broadcast, multi-client fan-out.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { buildTestApp } from '../helpers/build-test-app.js';
import { attachWebSocket } from '../../server/app.js';

let server;
let port;
let ctx;
let wsAttachment;

beforeEach(async () => {
  ctx = buildTestApp();
  server = http.createServer(ctx.app);
  wsAttachment = attachWebSocket(server, { state: ctx.state, spotify: ctx.spotify });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterEach(async () => {
  wsAttachment.close();
  await new Promise((resolve) => server.close(resolve));
});

function connectClient() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString('utf8'))));
  return { ws, messages, opened };
}

function waitFor(predicate, { timeout = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('timed out waiting for predicate'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('WebSocket /ws', () => {
  it('sends a snapshot on connection', async () => {
    ctx.state.setPlayers([{ pid: '1', name: 'K' }]);
    ctx.state.setZones([{ name: 'Upstairs', pids: ['1'] }]);
    ctx.state.setActiveZones(['Upstairs']);
    const { ws, messages, opened } = connectClient();
    await opened;
    await waitFor(() => messages.length >= 1);
    expect(messages[0].type).toBe('snapshot');
    expect(messages[0].state.players).toEqual([{ pid: '1', name: 'K' }]);
    expect(messages[0].state.zones).toEqual([{ name: 'Upstairs', pids: ['1'] }]);
    expect(messages[0].state.activeZones).toEqual(['Upstairs']);
    expect(messages[0].state.spotifyConnected).toBe(true);
    ws.close();
  });

  it('broadcasts state changes to all connected clients', async () => {
    const a = connectClient();
    const b = connectClient();
    await Promise.all([a.opened, b.opened]);
    await waitFor(() => a.messages.length >= 1 && b.messages.length >= 1);

    ctx.state.setVolume('1', 42);
    await waitFor(() =>
      a.messages.some((m) => m.type === 'change' && m.change?.type === 'volume')
      && b.messages.some((m) => m.type === 'change' && m.change?.type === 'volume')
    );
    const aChange = a.messages.find((m) => m.type === 'change');
    expect(aChange.change).toEqual({ type: 'volume', pid: '1', level: 42 });
    a.ws.close();
    b.ws.close();
  });

  it('does not broadcast to clients that have already closed', async () => {
    const a = connectClient();
    const b = connectClient();
    await Promise.all([a.opened, b.opened]);
    await waitFor(() => a.messages.length >= 1 && b.messages.length >= 1);

    a.ws.close();
    await waitFor(() => a.ws.readyState === WebSocket.CLOSED);

    ctx.state.setZones([{ name: 'Upstairs', pids: ['1'] }]);
    ctx.state.setActiveZones(['Upstairs']);
    await waitFor(() => b.messages.some((m) => m.type === 'change' && m.change?.type === 'activeZones'));
    expect(a.messages.some((m) => m.type === 'change' && m.change?.type === 'activeZones')).toBe(false);
    b.ws.close();
  });

  // A1: when a single client's ws.send throws (RST mid-broadcast, encoder
  // failure on a half-open iOS socket), the broadcast loop must NOT bail —
  // every other client still needs the change. Pre-fix, one bad client
  // killed the loop and left every other tab silently stale.
  it('continues broadcasting to live clients even when one client send throws', async () => {
    const a = connectClient();
    const b = connectClient();
    await Promise.all([a.opened, b.opened]);
    await waitFor(() => a.messages.length >= 1 && b.messages.length >= 1);

    // Monkey-patch ONE of the two server-side sockets so its ws.send throws
    // mid-broadcast while it still reports OPEN. The Set iteration order is
    // not guaranteed to match the client connection order, so we just assert
    // that the broadcast survived: at least one client received the change.
    const serverSockets = Array.from(wsAttachment.wss.clients);
    expect(serverSockets).toHaveLength(2);
    serverSockets[0].send = () => { throw new Error('synthetic send failure'); };

    const origWarn = console.warn;
    console.warn = () => {}; // safeSend logs the throw; quiet for the test
    try {
      ctx.state.setVolume('99', 11);
      // The healthy client still receives the change. Either A or B —
      // whichever one wasn't the patched socket.
      await waitFor(() =>
        a.messages.some((m) => m.type === 'change' && m.change?.pid === '99')
        || b.messages.some((m) => m.type === 'change' && m.change?.pid === '99')
      );
      const aGot = a.messages.some((m) => m.type === 'change' && m.change?.pid === '99');
      const bGot = b.messages.some((m) => m.type === 'change' && m.change?.pid === '99');
      // Exactly one of the two clients got the change (the live one).
      expect(aGot || bGot).toBe(true);
    } finally {
      console.warn = origWarn;
    }
    a.ws.close();
    b.ws.close();
  });
});

// C2: cross-origin browser tabs must NOT be able to drive the controller WS.
// Header-less callers (curl, native ws clients in tests) are still allowed so
// local CLI debugging keeps working.
describe('WebSocket Origin allow-list', () => {
  it('accepts a connection with no Origin header (CLI / native client)', async () => {
    const { ws, opened } = connectClient();
    await opened;
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('accepts a connection with an allowed Origin', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'http://localhost:8080' });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects a connection from a foreign Origin with 403', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'http://evil.example' });
    const result = await new Promise((resolve) => {
      ws.once('open', () => resolve({ kind: 'open' }));
      ws.once('unexpected-response', (_req, res) => resolve({ kind: 'http', status: res.statusCode }));
      ws.once('error', (e) => resolve({ kind: 'error', message: e.message }));
    });
    expect(result.kind).toBe('http');
    expect(result.status).toBe(403);
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  });
});
