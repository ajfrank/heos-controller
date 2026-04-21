// REST/WS client surface. Verifies URL/method/body shape per call and that
// jsonFetch surfaces the server's `error` field.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, connectWS } from '../../web/src/api.js';

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

function fail(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return Promise.resolve({
    ok: false,
    status,
    statusText: 'ERR',
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === 'string' ? null : body),
  });
}

describe('api.state', () => {
  it('GETs /api/state and returns the json', async () => {
    fetchMock.mockReturnValueOnce(ok({ players: [], activePids: [] }));
    const r = await api.state();
    expect(fetchMock).toHaveBeenCalledWith('/api/state', undefined);
    expect(r.players).toEqual([]);
  });
});

describe('api.setActive', () => {
  it('POSTs /api/zones/active with pids in JSON body', async () => {
    fetchMock.mockReturnValueOnce(ok({ ok: true }));
    await api.setActive(['1', '2']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/zones/active');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ pids: ['1', '2'] });
  });
});

describe('api.search', () => {
  it('GETs /api/search with the q query, URI-encoded', async () => {
    fetchMock.mockReturnValueOnce(ok({ results: {} }));
    await api.search('hello world & friends');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/search?q=hello%20world%20%26%20friends');
  });
});

describe('api.play', () => {
  it('POSTs /api/play with the body as-is', async () => {
    fetchMock.mockReturnValueOnce(ok({ ok: true }));
    await api.play({ uri: 'spotify:track:abc' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/play');
    expect(JSON.parse(init.body)).toEqual({ uri: 'spotify:track:abc' });
  });
});

describe('api.control', () => {
  it.each(['play', 'pause', 'next', 'previous'])('POSTs /api/control action=%s', async (action) => {
    fetchMock.mockReturnValueOnce(ok({ ok: true }));
    await api.control(action);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/control');
    expect(JSON.parse(init.body)).toEqual({ action });
  });
});

describe('api.setVolume', () => {
  it('POSTs /api/volume with pid + level', async () => {
    fetchMock.mockReturnValueOnce(ok({ ok: true }));
    await api.setVolume('1', 50);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/volume');
    expect(JSON.parse(init.body)).toEqual({ pid: '1', level: 50 });
  });
});

describe('jsonFetch error extraction', () => {
  it('surfaces the server `error` field as Error.message', async () => {
    fetchMock.mockReturnValueOnce(fail(400, { error: 'pids must be a non-empty string array' }));
    await expect(api.setActive(['', ''])).rejects.toThrow(/pids must be a non-empty/);
  });

  it('falls back to raw text when the body is not JSON', async () => {
    fetchMock.mockReturnValueOnce(fail(500, 'plain text boom'));
    await expect(api.state()).rejects.toThrow(/plain text boom/);
  });

  it('falls back to status when text body is empty', async () => {
    fetchMock.mockReturnValueOnce(fail(503, ''));
    await expect(api.state()).rejects.toThrow(/503/);
  });
});

describe('connectWS', () => {
  let lastSocket;

  beforeEach(() => {
    lastSocket = null;
    // jsdom doesn't ship a real WebSocket; stub one that captures handlers and
    // tracks the most recently constructed instance so tests can drive it.
    vi.stubGlobal('WebSocket', class {
      constructor(url) {
        this.url = url;
        this.closed = false;
        lastSocket = this;
      }
      close() { this.closed = true; if (this.onclose) this.onclose(); }
    });
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'example.test:1234' },
      writable: true,
    });
  });

  it('builds ws://host/ws on http', () => {
    connectWS(() => {});
    expect(lastSocket.url).toBe('ws://example.test:1234/ws');
  });

  it('builds wss://host/ws on https', () => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'https:', host: 'example.test:1234' },
      writable: true,
    });
    connectWS(() => {});
    expect(lastSocket.url).toBe('wss://example.test:1234/ws');
  });

  it('parses incoming messages and forwards to the callback', () => {
    const onMessage = vi.fn();
    connectWS(onMessage);
    lastSocket.onmessage({ data: JSON.stringify({ type: 'snapshot', state: {} }) });
    expect(onMessage).toHaveBeenCalledWith({ type: 'snapshot', state: {} });
  });

  it('swallows malformed JSON without throwing', () => {
    const onMessage = vi.fn();
    connectWS(onMessage);
    expect(() => lastSocket.onmessage({ data: 'not json' })).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// H2: reconnect with exponential backoff, single-flight, and a close() that
// cancels in-flight retries.
describe('connectWS reconnect backoff + single-flight', () => {
  let sockets;

  beforeEach(() => {
    sockets = [];
    vi.stubGlobal('WebSocket', class {
      constructor(url) {
        this.url = url;
        sockets.push(this);
      }
      close() { if (this.onclose) this.onclose(); }
    });
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'example.test:1234' },
      writable: true,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries with exponential backoff (1s → 2s → 4s)', async () => {
    connectWS(() => {});
    expect(sockets).toHaveLength(1);
    sockets[0].onclose();
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    sockets[1].onclose();
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(sockets).toHaveLength(3);
    sockets[2].onclose();
    await vi.advanceTimersByTimeAsync(4000);
    expect(sockets).toHaveLength(4);
  });

  it('caps backoff at 30s', async () => {
    connectWS(() => {});
    // Walk through 7 close/reopen cycles so the next delay would be 64s without the cap.
    for (let i = 0; i < 7; i++) {
      sockets[i].onclose();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(sockets.length).toBeGreaterThanOrEqual(8);
  });

  it('close() cancels a pending reconnect and stops forwarding messages', async () => {
    const onMessage = vi.fn();
    const conn = connectWS(onMessage);
    sockets[0].onclose();
    conn.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    // Even if a stale message somehow arrives, the callback shouldn't fire.
    if (sockets[0].onmessage) {
      sockets[0].onmessage({ data: JSON.stringify({ type: 'snapshot', state: {} }) });
    }
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('resets the backoff after a successful open', async () => {
    connectWS(() => {});
    sockets[0].onclose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    sockets[1].onopen?.();
    sockets[1].onclose();
    // Counter reset → next delay is 1s again, not 2s.
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(sockets).toHaveLength(3);
  });
});
