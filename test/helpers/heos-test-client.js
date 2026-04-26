// Shared HEOS test plumbing. Both heos-protocol.test.js and
// heos-commands.test.js mock node:net at module scope and then drive a fresh
// HeosClient through MockSocket.connect → 'connect' emit → register-for-events.
// The HeosClient + netModule references must be passed in: vi.mock is per-file,
// so the mock instance lives in each test file's scope.

import { vi } from 'vitest';

/** Drain microtasks + setImmediate (used by MockSocket.connect) without advancing the clock. */
export async function flush() {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

/**
 * Open a fresh HeosClient against the most recent MockSocket and return both.
 * @param {typeof import('../../server/heos.js').HeosClient} HeosClient
 * @param {{ __sockets: any[] }} netModule - the mocked node:net module
 * @returns {Promise<{ client: any, sock: any }>}
 */
export async function connectedClient(HeosClient, netModule) {
  const client = new HeosClient();
  const p = client._open();
  await flush();
  await p;
  return { client, sock: netModule.__sockets[0] };
}
