// Frame parsing, command/response correlation, event emission, and timeouts
// for HeosClient. The TCP socket is stubbed via MockSocket; no real network.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockSocket } from '../helpers/mock-socket.js';
import { connectedClient as openClient, flush } from '../helpers/heos-test-client.js';
import { FRAME, chunks } from '../fixtures/heos-frames.js';

// Mock node:net so `new net.Socket()` yields our MockSocket. Tests grab the
// instance via the `lastSocket` export of the mock module.
vi.mock('node:net', () => {
  const sockets = [];
  return {
    default: {
      Socket: class extends MockSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      },
    },
    __sockets: sockets,
  };
});

let HeosClient;
let netModule;

beforeEach(async () => {
  vi.useFakeTimers();
  // Re-import after mock is set up (top-level await in module scope is fine).
  ({ HeosClient } = await import('../../server/heos.js'));
  netModule = await import('node:net');
  netModule.__sockets.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// `flush` and `connectedClient` are imported from helpers/heos-test-client.js.
async function connectedClient() {
  return openClient(HeosClient, netModule);
}

describe('HeosClient frame parser', () => {
  it('parses a single frame and resolves the matching pending command', async () => {
    const { client, sock } = await connectedClient();

    const sendPromise = client.send('player/get_players');
    sock.feed(FRAME.getPlayers);
    const result = await sendPromise;
    expect(result.heos.command).toBe('player/get_players');
    expect(result.payload).toHaveLength(3);
    expect(result.payload[0]).toMatchObject({ pid: 1111, name: 'Kitchen' });
  });

  it('handles a frame split across two reads (partial buffering)', async () => {
    const { client, sock } = await connectedClient();

    const sendPromise = client.send('player/get_volume', { pid: 1111 });
    const [a, b] = chunks(FRAME.getVolume_42, [20]);
    sock.feed(a);
    // Should still be pending since \r\n hasn't arrived yet — give the parser a
    // microtask, then assert nothing has resolved.
    let resolved = false;
    sendPromise.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    // Now finish the frame and the pending command resolves.
    sock.feed(b);
    const result = await sendPromise;
    expect(result.heos.command).toBe('player/get_volume');
  });

  it('handles two frames arriving in a single read', async () => {
    const { client, sock } = await connectedClient();

    const p1 = client.send('player/get_players');
    const p2 = client.send('player/get_volume', { pid: 1111 });
    sock.feed(FRAME.getPlayers + FRAME.getVolume_42);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.heos.command).toBe('player/get_players');
    expect(r2.heos.command).toBe('player/get_volume');
  });

  it('emits "event" for unsolicited event/* frames without resolving any pending', async () => {
    const { client, sock } = await connectedClient();

    const onEvent = vi.fn();
    client.on('event', onEvent);
    sock.feed(FRAME.event_volume);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls[0][0].heos.command).toBe('event/player_volume_changed');
  });

  it('rejects a pending command with a translated message on syserrno=-9', async () => {
    const { client, sock } = await connectedClient();

    const sendPromise = client.send('group/set_group', { pid: '1,2' });
    sock.feed(FRAME.setGroup_syserrno9);
    await expect(sendPromise).rejects.toThrow(/can't be grouped together/);
  });

  it('rejects with a generic message on other failures', async () => {
    const { client, sock } = await connectedClient();

    const sendPromise = client.send('player/get_players');
    sock.feed('{"heos":{"command":"player/get_players","result":"fail","message":"boom"}}\r\n');
    await expect(sendPromise).rejects.toThrow(/HEOS player\/get_players failed: boom/);
  });

  it('skips malformed (non-JSON) lines without crashing the parser', async () => {
    const { client, sock } = await connectedClient();

    const sendPromise = client.send('player/get_players');
    sock.feed('not-json\r\n' + FRAME.getPlayers);
    const result = await sendPromise;
    expect(result.heos.result).toBe('success');
  });

  it('times out a pending send after 8s and rejects', async () => {
    const { client } = await connectedClient();

    const sendPromise = client.send('player/get_players');
    const expectation = expect(sendPromise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(8001);
    await expectation;
  });

  // Regression: a timed-out pending entry MUST stay in the FIFO so that the
  // late-arriving response is consumed in order, not handed to the next live
  // waiter. Splicing on timeout used to corrupt every subsequent response.
  it('preserves FIFO when an early command times out and its response arrives later', async () => {
    const { client, sock } = await connectedClient();

    // p1 will time out before any response arrives.
    const p1 = client.send('player/get_volume', { pid: 1111 });
    const p1Reject = expect(p1).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(8001);
    await p1Reject;

    // Send p2 AFTER p1 has been marked cancelled. p1's response is still in
    // flight on the wire and arrives first; without the cancelled-skip in
    // _onData, p2 would resolve to p1's response (pid=1111) instead of its
    // own (pid=2222).
    const p2 = client.send('player/get_volume', { pid: 2222 });
    sock.feed(
      '{"heos":{"command":"player/get_volume","result":"success","message":"pid=1111&level=10"}}\r\n' +
      '{"heos":{"command":"player/get_volume","result":"success","message":"pid=2222&level=20"}}\r\n'
    );
    const r2 = await p2;
    expect(r2.heos.message).toMatch(/pid=2222/);
  });

  it('rejects writes with no socket connection', async () => {
    const client = new HeosClient();
    await expect(client.send('player/get_players')).rejects.toThrow(/HEOS not connected/);
  });

  // M6: two same-name commands in flight must each resolve with their own
  // response. Strict FIFO is the right policy on a single HEOS connection.
  it('resolves two same-name commands in FIFO order', async () => {
    const { client, sock } = await connectedClient();

    const p1 = client.send('player/get_volume', { pid: 1111 });
    const p2 = client.send('player/get_volume', { pid: 2222 });
    sock.feed(
      '{"heos":{"command":"player/get_volume","result":"success","message":"pid=1111&level=10"}}\r\n' +
      '{"heos":{"command":"player/get_volume","result":"success","message":"pid=2222&level=20"}}\r\n'
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.heos.message).toMatch(/pid=1111/);
    expect(r2.heos.message).toMatch(/pid=2222/);
  });

  // Idle TCP errors after connect (e.g. ETIMEDOUT overnight on a wall tablet)
  // must not crash the process — they did before we attached a persistent
  // 'error' handler in _open().
  it('does not throw on a post-connect socket error and rejects in-flight commands', async () => {
    const { client, sock } = await connectedClient();

    const origWarn = console.warn;
    console.warn = vi.fn();
    try {
      const sendPromise = client.send('player/get_players');
      const err = Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' });
      // If no persistent handler is attached, this throws as 'Unhandled error event'.
      expect(() => sock.emit('error', err)).not.toThrow();
      await expect(sendPromise).rejects.toThrow(/ETIMEDOUT/);
    } finally {
      console.warn = origWarn;
    }
  });

  // C5: when the TCP socket closes (overnight ETIMEDOUT, router reboot), the
  // 5s reconnect timer must fire AND re-register for change events on the new
  // socket. Without re-registration, the controller silently misses every
  // volume/play-state event from then on.
  it('re-registers for change events after a socket close → reconnect cycle', async () => {
    const client = new HeosClient();
    client.host = '127.0.0.1'; // _scheduleReconnect short-circuits without a host
    const connectPromise = client._open();
    const sock1 = netModule.__sockets[0];
    await flush();
    await connectPromise;

    // Simulate the wire dropping. _open's 'close' handler nulls the socket
    // and schedules the reconnect timer.
    sock1.emit('close');
    expect(client.socket).toBeNull();

    // Quiet the warn from any in-flight rejections / send timeouts.
    const origWarn = console.warn;
    console.warn = vi.fn();
    try {
      // Fire the 5s reconnect timer. Its callback constructs sock2 and calls
      // sock2.connect(), which schedules a setImmediate to emit 'connect'.
      await vi.advanceTimersByTimeAsync(5000);
      const sock2 = netModule.__sockets[1];
      expect(sock2).toBeDefined();
      expect(sock2).not.toBe(sock1);
      // Explicitly drive the 'connect' so we don't depend on setImmediate
      // ordering inside the async timer callback (fake timers + chained
      // awaits is fiddly; this keeps the assertion deterministic).
      sock2.emit('connect');
      await flush();
      await flush();

      const writes = sock2.written.join('');
      expect(writes).toMatch(/system\/register_for_change_events\?enable=on/);
    } finally {
      console.warn = origWarn;
    }
  });

  // M7: protect against unbounded buffer growth from a malformed remote.
  it('drops the buffer and keeps parsing after >64KB without a newline', async () => {
    const { client, sock } = await connectedClient();

    // Quiet the warn from the dropped buffer.
    const origWarn = console.warn;
    console.warn = vi.fn();
    try {
      sock.feed('x'.repeat(70_000));
      // The parser should be back to a clean state — a well-formed frame after
      // the dropped junk should resolve normally.
      const sendPromise = client.send('player/get_players');
      sock.feed(FRAME.getPlayers);
      const result = await sendPromise;
      expect(result.heos.command).toBe('player/get_players');
    } finally {
      console.warn = origWarn;
    }
  });
});
