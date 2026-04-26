// HeosClient high-level helpers — verify they build the right command line and
// parse the response payload/message correctly.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockSocket } from '../helpers/mock-socket.js';
import { FRAME } from '../fixtures/heos-frames.js';

vi.mock('node:net', () => {
  const sockets = [];
  return {
    default: {
      Socket: class extends MockSocket {
        constructor() { super(); sockets.push(this); }
      },
    },
    __sockets: sockets,
  };
});

let HeosClient;
let netModule;

beforeEach(async () => {
  vi.useFakeTimers();
  ({ HeosClient } = await import('../../server/heos.js'));
  netModule = await import('node:net');
  netModule.__sockets.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

async function connectedClient() {
  const client = new HeosClient();
  const p = client._open();
  await vi.advanceTimersByTimeAsync(0);
  await p;
  return { client, sock: netModule.__sockets[0] };
}

describe('HeosClient command builders', () => {
  it('getPlayers writes the right line and returns payload', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(() => FRAME.getPlayers);
    const players = await client.getPlayers();
    expect(sock.written.at(-1)).toBe('heos://player/get_players\r\n');
    expect(players).toHaveLength(3);
    expect(players[0].name).toBe('Kitchen');
  });

  it('getVolume parses level= from the response message', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(() => FRAME.getVolume_42);
    const v = await client.getVolume(1111);
    expect(sock.written.at(-1)).toBe('heos://player/get_volume?pid=1111\r\n');
    expect(v).toBe(42);
  });

  it('setVolume clamps level to 0..100 and rounds', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(() => FRAME.setVolume_success);
    await client.setVolume(1111, 150.7);
    expect(sock.written.at(-1)).toBe('heos://player/set_volume?pid=1111&level=100\r\n');
    sock.onWrite(() => FRAME.setVolume_success);
    await client.setVolume(1111, -3);
    expect(sock.written.at(-1)).toBe('heos://player/set_volume?pid=1111&level=0\r\n');
  });

  it('setGroup keeps commas raw in the pid list (not %2C)', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(() => FRAME.setGroup_success);
    await client.setGroup([1111, 2222, 3333]);
    expect(sock.written.at(-1)).toBe('heos://group/set_group?pid=1111,2222,3333\r\n');
  });

  it('getNowPlaying returns payload object', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(() => FRAME.getNowPlaying);
    const np = await client.getNowPlaying(1111);
    expect(np).toMatchObject({ song: 'In Bloom', artist: 'Nirvana', album: 'Nevermind' });
  });

  it('getNowPlaying returns null when payload is absent', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(() => FRAME.getNowPlaying_null);
    const np = await client.getNowPlaying(1111);
    expect(np).toBeNull();
  });

  it('setPlayState forwards state to HEOS', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(() => FRAME.setPlayState_success);
    await client.setPlayState(1111, 'pause');
    expect(sock.written.at(-1)).toBe('heos://player/set_play_state?pid=1111&state=pause\r\n');
  });

  it('playNext / playPrevious build the right commands', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(() => FRAME.playNext_success);
    await client.playNext(1111);
    expect(sock.written.at(-1)).toBe('heos://player/play_next?pid=1111\r\n');
    sock.onWrite(() => FRAME.playPrevious_success);
    await client.playPrevious(1111);
    expect(sock.written.at(-1)).toBe('heos://player/play_previous?pid=1111\r\n');
  });
});

describe('HeosClient.applyGroup', () => {
  it('no-ops on empty pid list', async () => {
    const { client, sock } = await connectedClient();
    await client.applyGroup([]);
    // No commands should have been written beyond the connect/register.
    expect(sock.written.filter((w) => w.includes('group/'))).toEqual([]);
  });

  it('no-ops when single pid is already solo (not in any multi-player group)', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(() => FRAME.getGroups_empty);
    await client.applyGroup([1111]);
    // get_groups should have been called, set_group should not.
    expect(sock.written.some((w) => w.includes('group/get_groups'))).toBe(true);
    expect(sock.written.some((w) => w.includes('group/set_group'))).toBe(false);
  });

  it('breaks an existing group when single pid requested', async () => {
    const { client, sock } = await connectedClient();
    let call = 0;
    sock.onWrite(() => (call++ === 0 ? FRAME.getGroups_kitchenLR : FRAME.setGroup_success));
    await client.applyGroup([1111]);
    expect(sock.written.some((w) => w.includes('group/set_group?pid=1111'))).toBe(true);
  });

  it('skips set_group when desired group already matches existing', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(() => FRAME.getGroups_kitchenLR);
    await client.applyGroup([1111, 2222]);
    expect(sock.written.some((w) => w.includes('group/set_group'))).toBe(false);
  });

  it('issues set_group when desired set differs from existing group', async () => {
    const { client, sock } = await connectedClient();
    let call = 0;
    sock.onWrite(() => (call++ === 0 ? FRAME.getGroups_kitchenLR : FRAME.setGroup_success));
    await client.applyGroup([1111, 2222, 3333]);
    expect(sock.written.some((w) => w.includes('group/set_group?pid=1111,2222,3333'))).toBe(true);
  });

  it('retries set_group once on eid=13 (HEOS busy with internal state change)', async () => {
    // Repro: user starts a song in one zone (Spotify Connect wakes the
    // speaker; HEOS fires its own internal commands), then immediately
    // toggles zones. The first set_group lands while HEOS is still
    // processing the wake fallout and gets eid=13. _doApplyGroup must
    // sleep briefly and retry once so the user never sees the error.
    const { client, sock } = await connectedClient();
    let call = 0;
    sock.onWrite(() => {
      const i = call++;
      if (i === 0) return FRAME.getGroups_kitchenLR;
      if (i === 1) return FRAME.setGroup_eid13;
      return FRAME.setGroup_success;
    });
    const p = client.applyGroup([1111, 2222, 3333]);
    await vi.advanceTimersByTimeAsync(900);
    await p;
    const setCalls = sock.written.filter((w) => w.includes('group/set_group?pid=1111,2222,3333'));
    expect(setCalls.length).toBe(2);
  });

  it('coalesces concurrent applyGroup calls — only the latest pids run after the in-flight one finishes', async () => {
    // Regression: HEOS rejects overlapping group/set_group with eid=13.
    // applyGroup must serialize: at most one in flight, queue collapses to
    // the latest desired pids (intermediate states get skipped).
    const { client } = await connectedClient();
    const calls = [];
    let resolveFirst;
    client._doApplyGroup = vi.fn((pids) => {
      calls.push(pids.slice());
      if (calls.length === 1) return new Promise((r) => { resolveFirst = r; });
      return Promise.resolve();
    });

    const p1 = client.applyGroup([1, 2]);
    const p2 = client.applyGroup([1, 2, 3]);
    const p3 = client.applyGroup([1, 2, 3, 4]);

    // Only the first call has started; the next two are queued/collapsed.
    expect(client._doApplyGroup).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual([1, 2]);

    resolveFirst();
    await Promise.all([p1, p2, p3]);

    // Exactly one follow-up run, with the LATEST desired pids.
    expect(client._doApplyGroup).toHaveBeenCalledTimes(2);
    expect(calls[1]).toEqual([1, 2, 3, 4]);
  });

  // Repro: a HEOS query (group/get_groups) occasionally times out — speaker
  // just woke from idle, mesh hiccup, etc. The typical pattern is "slow then
  // recovered": the response DOES arrive, just after the 8s timeout window.
  // The cancelled getGroups pending entry consumes that late frame in FIFO
  // order; our fallthrough setGroup write then lands cleanly on the next
  // pending slot. The diff check is an optimization, not a correctness
  // requirement, so for multi-pid sets we proceed to setGroup blind rather
  // than fail the user's tap with a raw "HEOS group/get_groups timed out".
  it('falls through to set_group when getGroups times out (HEOS recovers and late response arrives)', async () => {
    const { client, sock } = await connectedClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sock.onWrite((line) => {
      if (line.includes('group/get_groups')) return null; // no immediate response → 8s timeout
      if (line.includes('group/set_group?pid=1111,2222')) {
        // HEOS has recovered: the late getGroups frame arrives in flight just
        // before the setGroup response. The cancelled getGroups pending entry
        // consumes the first frame (per the FIFO-with-skip design); the live
        // setGroup entry consumes the second.
        return [
          '{"heos":{"command":"group/get_groups","result":"success","message":""},"payload":[]}\r\n',
          FRAME.setGroup_success,
        ];
      }
      return null;
    });
    const p = client.applyGroup([1111, 2222]);
    await vi.advanceTimersByTimeAsync(8500); // past send()'s 8s timeout
    await p;
    expect(sock.written.some((w) => w.includes('group/set_group?pid=1111,2222'))).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Single-pid (solo) path — HEOS rejects setGroup with a not-currently-grouped
  // pid (syserrno=-9 per quirk #2), so a getGroups failure means we genuinely
  // can't tell whether the action is needed. Silent no-op is the least-harm
  // outcome; the user's next tap (after HEOS recovers) will succeed.
  it('no-ops on single-pid request when getGroups times out', async () => {
    const { client, sock } = await connectedClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sock.onWrite(() => null); // simulate no response to anything
    const p = client.applyGroup([1111]);
    await vi.advanceTimersByTimeAsync(8500);
    await p;
    expect(sock.written.some((w) => w.includes('group/set_group'))).toBe(false);
    warnSpy.mockRestore();
  });
});
