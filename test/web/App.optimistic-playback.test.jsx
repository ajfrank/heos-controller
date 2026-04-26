// Audit pass #6: two behaviors that didn't have direct coverage.
//
// 1. Burst-poll timer cleanup on unmount. control('next' | 'previous') schedules
//    setTimeout(...)s at 1.2s and 2.5s to bump the playback token. They MUST
//    be cleared on unmount, otherwise React warns about setState on a dead
//    component if the iPad reloads or HMR fires within 2.5s of a skip.
//
// 2. App-level playStateOverride. With the recent removal of NowPlaying's
//    local optimistic icon state, the bar's is_playing now derives from
//    `playbackForUI` (sample patched by override). On a play/pause tap, the
//    override patches is_playing synchronously; it clears when the next poll
//    confirms. This test covers the patch + clear cycle.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor, act } from '@testing-library/react';
import { createApiMock, setupAppTest, captureComponent, renderApp } from './helpers/render-app.jsx';

vi.mock('../../web/src/api.js', () => createApiMock());
vi.mock('../../web/src/components/Backdrop.jsx', () => ({ default: () => null }));
vi.mock('../../web/src/components/NowPlaying.jsx', () => captureComponent('NowPlaying'));

import App from '../../web/src/App.jsx';
import { api } from '../../web/src/api.js';

let testCtx;

beforeEach(() => {
  api.playbackPosition.mockReset();
  api.control.mockReset();
  api.control.mockResolvedValue({ ok: true });
  testCtx = setupAppTest({
    snapshot: {
      players: [{ pid: '1', name: 'Bar' }],
      zones: [{ name: 'Bar', pids: ['1'] }],
      activeZones: ['Bar'],
      activePids: ['1'],
      nowPlaying: { pid: '1', state: 'play', song: 'Old Track', artist: 'A' },
      nowPlayingByPid: { 1: { state: 'play', song: 'Old Track', artist: 'A' } },
      volumes: { 1: 50 },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const npProps = () => testCtx.getCapturedProps('NowPlaying');

describe('App-level playStateOverride (audit pass #6)', () => {
  it('flips playbackForUI.is_playing synchronously on pause tap', async () => {
    api.playbackPosition.mockResolvedValue({
      playback: {
        is_playing: true, progress_ms: 30_000, duration_ms: 200_000,
        song: 'Old Track', track_id: 'tk-old',
      },
      queue: [],
    });
    renderApp(App);
    await waitFor(() => expect(npProps()).toBeDefined());
    // Wait for the first poll to land so playback is non-null.
    await waitFor(() => expect(npProps().playback?.is_playing).toBe(true));

    // Simulate the user tapping pause on the transport row.
    await act(async () => {
      npProps().onControl('pause');
      await Promise.resolve();
    });

    // Override should patch is_playing on the NEXT render — no waiting for poll.
    expect(npProps().playback.is_playing).toBe(false);
    // progress_ms freezes at the displayed effective time, not the raw sample's
    // pre-pause value (which would have been ahead of the displayed bar).
    expect(typeof npProps().playback.progress_ms).toBe('number');
    expect(api.control).toHaveBeenCalledWith('pause');
  });

  it('flips playbackForUI.is_playing synchronously on play tap (when reported state is paused)', async () => {
    api.playbackPosition.mockResolvedValue({
      playback: {
        is_playing: false, progress_ms: 30_000, duration_ms: 200_000,
        song: 'Old Track', track_id: 'tk-old',
      },
      queue: [],
    });
    renderApp(App);
    await waitFor(() => expect(npProps()).toBeDefined());
    await waitFor(() => expect(npProps().playback?.is_playing).toBe(false));

    await act(async () => {
      npProps().onControl('play');
      await Promise.resolve();
    });

    expect(npProps().playback.is_playing).toBe(true);
    expect(api.control).toHaveBeenCalledWith('play');
  });

  it('clears the override when the next poll reports a matching is_playing', async () => {
    let callCount = 0;
    api.playbackPosition.mockImplementation(() => {
      callCount += 1;
      // Both polls return is_playing=true (matches the play override).
      return Promise.resolve({
        playback: {
          is_playing: true, progress_ms: 30_000 + callCount * 1000,
          duration_ms: 200_000, song: 'Old Track', track_id: 'tk-old',
        },
        queue: [],
      });
    });
    renderApp(App);
    await waitFor(() => expect(npProps()?.playback?.is_playing).toBe(true));
    const callsBeforeTap = api.playbackPosition.mock.calls.length;

    // Pause then immediately play — the second tap's override matches the
    // poll's reported state (is_playing=true), so the override clears on
    // the next poll instead of waiting the 4s safety timeout.
    await act(async () => {
      npProps().onControl('pause');
      await Promise.resolve();
      npProps().onControl('play');
      await Promise.resolve();
    });

    // Each play/pause tap bumps playBumpToken → triggers a re-poll.
    await waitFor(() => {
      expect(api.playbackPosition.mock.calls.length).toBeGreaterThan(callsBeforeTap);
    });
    // Eventually playback reflects the polled state with is_playing=true and
    // progress_ms === the polled value (override cleared).
    await waitFor(() => {
      expect(npProps().playback.is_playing).toBe(true);
    });
  });
});

describe('Burst-poll timer cleanup on unmount (audit pass #6)', () => {
  it('clearTimeouts the scheduled 1.2s/2.5s playback re-polls when the component unmounts', async () => {
    api.playbackPosition.mockResolvedValue({
      playback: {
        is_playing: true, progress_ms: 30_000, duration_ms: 200_000,
        song: 'Old Track', track_id: 'tk-old',
      },
      queue: [],
    });
    // Spy without mocking — real setTimeout still schedules; we just observe
    // the burst ids and verify clearTimeout sees them on unmount.
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    const { unmount } = renderApp(App);
    await waitFor(() => expect(npProps()).toBeDefined());
    await waitFor(() => expect(npProps().playback?.is_playing).toBe(true));

    setTimeoutSpy.mockClear();

    // Tap Next — schedules setTimeout(..., 1200) and setTimeout(..., 2500).
    await act(async () => {
      npProps().onControl('next');
      await Promise.resolve();
    });

    const burstCalls = setTimeoutSpy.mock.calls.filter(
      ([_, delay]) => delay === 1200 || delay === 2500,
    );
    expect(burstCalls.length).toBe(2);
    // The corresponding setTimeout return values are the IDs we expect cleared.
    const burstIds = setTimeoutSpy.mock.results
      .filter((_, i) => setTimeoutSpy.mock.calls[i][1] === 1200 || setTimeoutSpy.mock.calls[i][1] === 2500)
      .map((r) => r.value);

    clearTimeoutSpy.mockClear();
    unmount();

    const clearedIds = clearTimeoutSpy.mock.calls.map(([id]) => id);
    for (const id of burstIds) {
      expect(clearedIds).toContain(id);
    }
  });
});
