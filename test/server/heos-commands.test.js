// HeosClient high-level helpers — verify they build the right command line and
// parse the response payload/message correctly.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockSocket } from '../helpers/mock-socket.js';
import { connectedClient as openClient } from '../helpers/heos-test-client.js';
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
  return openClient(HeosClient, netModule);
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

  // Leader-aware diff: pid-set matches but Spotify-visible leader differs from
  // HEOS leader. Without this, transferPlayback routes Spotify Connect audio
  // to Kitchen's endpoint, but Kitchen is a slave so HEOS doesn't mirror —
  // only Kitchen plays. setGroup with Kitchen first re-leaders the group.
  it('issues set_group when pid-set matches but leader position differs', async () => {
    const { client, sock } = await connectedClient();
    let call = 0;
    sock.onWrite(() => (call++ === 0 ? FRAME.getGroups_LRleader : FRAME.setGroup_success));
    await client.applyGroup([1111, 2222]); // want Kitchen as leader
    expect(sock.written.some((w) => w.includes('group/set_group?pid=1111,2222'))).toBe(true);
  });

  // force:true (used by /api/play) bypasses the diff entirely — even if HEOS
  // reports a perfectly-matching group, we still issue setGroup. Guards
  // against HEOS getGroups lying (silent slave drop, mesh hiccup) where the
  // group looks intact but only the leader actually plays.
  it('issues set_group when force:true even if desired matches existing exactly', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(() => FRAME.setGroup_success);
    await client.applyGroup([1111, 2222], { force: true });
    // get_groups should be SKIPPED — force bypasses the diff round-trip too.
    expect(sock.written.some((w) => w.includes('group/get_groups'))).toBe(false);
    expect(sock.written.some((w) => w.includes('group/set_group?pid=1111,2222'))).toBe(true);
  });

  // Build a command-name-aware onWrite handler so tests don't break when the
  // sequence injects extra reads (e.g. the get_play_state pause-regroup-resume
  // path). `setGroupResponses` is consumed in order on each set_group write.
  function eid13TestHandler({ playState = 'play', setGroupResponses = [] } = {}) {
    let setGroupIdx = 0;
    const pausedFrame = JSON.stringify({
      heos: { command: 'player/get_play_state', result: 'success', message: `pid=1111&state=${playState}` },
    }) + '\r\n';
    return (line) => {
      if (line.includes('group/get_groups')) return FRAME.getGroups_kitchenLR;
      if (line.includes('player/get_play_state')) return pausedFrame;
      if (line.includes('player/set_play_state')) return FRAME.setPlayState_success;
      if (line.includes('group/set_group?pid=1111,2222,3333')) {
        const i = setGroupIdx++;
        return setGroupResponses[i] ?? FRAME.setGroup_success;
      }
      return null;
    };
  }

  it('retries set_group on eid=13 (HEOS busy with internal state change)', async () => {
    // Repro: user starts a song in one zone (Spotify Connect wakes the
    // speaker; HEOS fires its own internal commands), then immediately
    // toggles zones. The first set_group lands while HEOS is still
    // processing the wake fallout and gets eid=13. _doApplyGroup must
    // sleep briefly and retry so the user never sees the error.
    const { client, sock } = await connectedClient();
    sock.onWrite(eid13TestHandler({
      playState: 'pause', // skip pause/resume side path; just verify retry counting
      setGroupResponses: [FRAME.setGroup_eid13, FRAME.setGroup_success],
    }));
    const p = client.applyGroup([1111, 2222, 3333]);
    await vi.advanceTimersByTimeAsync(900);
    await p;
    const setCalls = sock.written.filter((w) => w.includes('group/set_group?pid=1111,2222,3333'));
    expect(setCalls.length).toBe(2);
  });

  // Real-world report: a single 800ms retry wasn't enough when HEOS was mid-
  // Spotify-Connect-wake (busy window ~2-3s). _doApplyGroup now retries up to
  // three times with growing delays (800 → 1600 → 2800ms, cumulative ~5.2s).
  it('retries set_group up to three times on persistent eid=13', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(eid13TestHandler({
      playState: 'pause',
      setGroupResponses: [
        FRAME.setGroup_eid13, FRAME.setGroup_eid13, FRAME.setGroup_eid13, FRAME.setGroup_success,
      ],
    }));
    const p = client.applyGroup([1111, 2222, 3333]);
    // Cumulative delays: 800 + 1600 + 2800 = 5200ms.
    await vi.advanceTimersByTimeAsync(5300);
    await p;
    const setCalls = sock.written.filter((w) => w.includes('group/set_group?pid=1111,2222,3333'));
    expect(setCalls.length).toBe(4); // initial + 3 retries
  });

  // Surface the busy error after exhausting retries — don't silently hang or
  // try forever. The user can retry manually if HEOS is genuinely stuck.
  it('surfaces eid=13 to the caller after all retries are exhausted', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(eid13TestHandler({
      playState: 'pause',
      // Repeat eid13 indefinitely — the handler defaults to FRAME.setGroup_success
      // for any index past the array, so cap at 4 fail responses to be sure.
      setGroupResponses: [
        FRAME.setGroup_eid13, FRAME.setGroup_eid13, FRAME.setGroup_eid13, FRAME.setGroup_eid13,
      ],
    }));
    const p = client.applyGroup([1111, 2222, 3333]);
    const expectation = expect(p).rejects.toThrow(/busy/i);
    await vi.advanceTimersByTimeAsync(5300);
    await expectation;
    const setCalls = sock.written.filter((w) => w.includes('group/set_group?pid=1111,2222,3333'));
    expect(setCalls.length).toBe(4); // initial + 3 retries, all rejected
  });

  // The actual user complaint: zone toggles during active playback hit EID13
  // because HEOS is busy with the Spotify Connect daemon. Sidestep this by
  // pausing the leader before regrouping, then resuming — same trick the
  // official HEOS app uses.
  it('on EID13, pauses leader → retries setGroup → resumes leader (active playback path)', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(eid13TestHandler({
      playState: 'play',
      setGroupResponses: [FRAME.setGroup_eid13, FRAME.setGroup_success],
    }));
    const p = client.applyGroup([1111, 2222, 3333]);
    await vi.advanceTimersByTimeAsync(900);
    await p;

    // The full sequence on the wire.
    const order = sock.written
      .map((w) => w.match(/heos:\/\/([^?\s]+)(\?[^\s]+)?/))
      .filter(Boolean)
      .map((m) => `${m[1]}${m[2] ? '?' + m[2].slice(1, 60) : ''}`);

    // Find the indices of each step.
    const idx = (substr) => order.findIndex((s) => s.includes(substr));
    const lastIdx = (substr) => order.length - 1 - [...order].reverse().findIndex((s) => s.includes(substr));

    expect(idx('group/get_groups')).toBeGreaterThanOrEqual(0);
    expect(idx('player/get_play_state')).toBeGreaterThan(idx('group/set_group'));
    expect(idx('player/set_play_state?pid=1111&state=pause')).toBeGreaterThan(idx('player/get_play_state'));
    expect(lastIdx('group/set_group')).toBeGreaterThan(idx('player/set_play_state?pid=1111&state=pause'));
    expect(idx('player/set_play_state?pid=1111&state=play')).toBeGreaterThan(lastIdx('group/set_group'));
  });

  // Skip pause/resume when the leader is already paused — no point thrashing
  // the play state on a speaker that wasn't producing audio anyway.
  it('on EID13, skips pause/resume when leader is not currently playing', async () => {
    const { client, sock } = await connectedClient();
    sock.onWrite(eid13TestHandler({
      playState: 'pause',
      setGroupResponses: [FRAME.setGroup_eid13, FRAME.setGroup_success],
    }));
    const p = client.applyGroup([1111, 2222, 3333]);
    await vi.advanceTimersByTimeAsync(900);
    await p;
    expect(sock.written.some((w) => w.includes('player/set_play_state'))).toBe(false);
  });

  // Pause is best-effort: if it fails (eid=12, transient mesh issue, etc.) we
  // still attempt the regroup retry so the user's tap isn't completely lost.
  it('on EID13, proceeds with regroup even if pre-regroup pause fails', async () => {
    const { client, sock } = await connectedClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let setGroupCount = 0;
    sock.onWrite((line) => {
      if (line.includes('group/get_groups')) return FRAME.getGroups_kitchenLR;
      if (line.includes('player/get_play_state')) return FRAME.getPlayState_play;
      if (line.includes('player/set_play_state?pid=1111&state=pause')) {
        return JSON.stringify({
          heos: { command: 'player/set_play_state', result: 'fail', message: 'eid=12&text=System error' },
        }) + '\r\n';
      }
      if (line.includes('player/set_play_state?pid=1111&state=play')) return FRAME.setPlayState_success;
      if (line.includes('group/set_group?pid=1111,2222,3333')) {
        setGroupCount++;
        return setGroupCount === 1 ? FRAME.setGroup_eid13 : FRAME.setGroup_success;
      }
      return null;
    });
    const p = client.applyGroup([1111, 2222, 3333]);
    await vi.advanceTimersByTimeAsync(900);
    await p;
    expect(setGroupCount).toBe(2); // retry happened despite pause failure
    warnSpy.mockRestore();
  });

  // EID7 = "Command Couldn't Be Executed". Fires when the desired leader is
  // currently a slave in another group — HEOS refuses to promote a slave
  // straight to leader of a new group. _doApplyGroup catches and recovers by
  // ungrouping the slave first, sleeping 1500ms, then retrying the setGroup.
  // This is the exact scenario the force:true fix relies on (force always
  // calls setGroup; EID7 is the resulting error when the leader isn't
  // already promoted). Untested before this — silent regression risk for
  // the most user-visible fix in the recent run.
  it('on EID7 with leader-as-slave: ungroups the slave, waits, then retries setGroup successfully', async () => {
    const { client, sock } = await connectedClient();
    // Existing group has Living (2222) as leader, Kitchen (1111) as slave.
    // We want Kitchen to lead → setGroup([1111, 2222]) → HEOS rejects with
    // EID7 because 1111 is currently a slave.
    const getGroupsFrame = JSON.stringify({
      heos: { command: 'group/get_groups', result: 'success', message: '' },
      payload: [
        { name: 'Living Room + Kitchen', gid: 2222, players: [
          { name: 'Living Room', pid: 2222, role: 'leader' },
          { name: 'Kitchen', pid: 1111, role: 'member' },
        ] },
      ],
    }) + '\r\n';
    let setGroupIdx = 0;
    sock.onWrite((line) => {
      if (line.includes('group/get_groups')) return getGroupsFrame;
      // setGroup write order during recovery:
      //   [0] setGroup?pid=1111,2222  → EID7
      //   [1] setGroup?pid=1111       → success (ungroup Kitchen to solo)
      //   [2] setGroup?pid=1111,2222  → success (retry after 1500ms)
      if (line.includes('group/set_group?pid=1111,2222')) {
        const i = setGroupIdx++;
        return i === 0 ? FRAME.setGroup_eid7 : FRAME.setGroup_success;
      }
      if (line.includes('group/set_group?pid=1111')) return FRAME.setGroup_success;
      return null;
    });

    const p = client.applyGroup([1111, 2222]);
    // Advance past the 1500ms settle so the retry fires.
    await vi.advanceTimersByTimeAsync(1600);
    await p;

    // Wire sequence proves the recovery: initial setGroup, ungroup-leader,
    // then retry. Without the EID7 branch, no ungroup write would appear.
    const setGroupWrites = sock.written.filter((w) => w.includes('group/set_group'));
    expect(setGroupWrites[0]).toContain('pid=1111,2222');
    expect(setGroupWrites[1]).toContain('pid=1111\r\n'); // ungroup Kitchen
    expect(setGroupWrites[2]).toContain('pid=1111,2222'); // retry
    expect(setGroupWrites.length).toBe(3);
  });

  // Skip the ungroup step when the desired leader is already solo (not in a
  // multi-player group). EID7 still triggers a retry, but no ungroup is sent.
  it('on EID7 when leader is already solo: skips ungroup, just sleeps and retries', async () => {
    const { client, sock } = await connectedClient();
    // Existing group is Living+Bar (2222+3333); Kitchen (1111) is NOT in it.
    const getGroupsFrame = JSON.stringify({
      heos: { command: 'group/get_groups', result: 'success', message: '' },
      payload: [
        { gid: 2222, players: [
          { name: 'Living Room', pid: 2222, role: 'leader' },
          { name: 'Bar', pid: 3333, role: 'member' },
        ] },
      ],
    }) + '\r\n';
    let setGroupIdx = 0;
    sock.onWrite((line) => {
      if (line.includes('group/get_groups')) return getGroupsFrame;
      if (line.includes('group/set_group?pid=1111,2222')) {
        const i = setGroupIdx++;
        return i === 0 ? FRAME.setGroup_eid7 : FRAME.setGroup_success;
      }
      return null;
    });

    const p = client.applyGroup([1111, 2222]);
    await vi.advanceTimersByTimeAsync(1600);
    await p;

    const allSetGroups = sock.written.filter((w) => w.includes('group/set_group'));
    // No solo-ungroup of Kitchen — it wasn't in a multi-player group.
    expect(allSetGroups.every((w) => w.includes('pid=1111,2222'))).toBe(true);
    expect(allSetGroups.length).toBe(2); // initial fail + retry success
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

  // Force is sticky across coalescing: if a play-tap (force:true) lands
  // behind an in-flight zone-toggle (force:false), the queued apply must
  // STILL run forced. Otherwise the play would silently fall back to the
  // diff optimization and reintroduce the single-speaker bug.
  it('keeps force:true sticky when a forced apply is queued behind a non-forced one', async () => {
    const { client } = await connectedClient();
    const calls = [];
    let resolveFirst;
    client._doApplyGroup = vi.fn((pids, opts) => {
      calls.push({ pids: pids.slice(), force: opts?.force });
      if (calls.length === 1) return new Promise((r) => { resolveFirst = r; });
      return Promise.resolve();
    });

    const p1 = client.applyGroup([1, 2]); // toggle (no force)
    const p2 = client.applyGroup([1, 2, 3], { force: true }); // play (force)
    const p3 = client.applyGroup([1, 2, 3], { force: false }); // toggle, after

    resolveFirst();
    await Promise.all([p1, p2, p3]);

    expect(client._doApplyGroup).toHaveBeenCalledTimes(2);
    expect(calls[0]).toEqual({ pids: [1, 2], force: false });
    expect(calls[1]).toEqual({ pids: [1, 2, 3], force: true });
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
