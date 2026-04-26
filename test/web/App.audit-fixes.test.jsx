// Pre-push audit regressions:
//   A3 — usePlaybackProgress re-arms when snap.nowPlaying.state flips to 'play'
//        after being paused. Without this, paused → played leaves the bar
//        frozen until the tab is hidden+shown.
//   B2 — setZoneVolume rolls back the optimistic per-zone update when
//        api.setVolume rejects (symmetric with the existing setActive
//        rollback).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor, act } from '@testing-library/react';
import { createApiMock, setupAppTest, captureComponent, renderApp } from './helpers/render-app.jsx';

vi.mock('../../web/src/api.js', () => createApiMock());
vi.mock('../../web/src/components/Backdrop.jsx', () => ({ default: () => null }));
vi.mock('../../web/src/components/NowPlaying.jsx', () => captureComponent('NowPlaying'));
vi.mock('../../web/src/components/ZoneGrid.jsx', () => captureComponent('ZoneGrid'));

import App from '../../web/src/App.jsx';
import { api } from '../../web/src/api.js';

let testCtx;
beforeEach(() => {
  api.setVolume.mockReset();
  api.playbackPosition.mockReset();
  api.playbackPosition.mockResolvedValue({ playback: null });
  testCtx = setupAppTest({
    snapshot: {
      players: [{ pid: '1', name: 'Bar' }, { pid: '2', name: 'Basement' }],
      zones: [{ name: 'Downstairs', pids: ['1', '2'] }],
      activeZones: ['Downstairs'],
      activePids: ['1', '2'],
      nowPlaying: { pid: '1', state: 'pause', song: 'Track', artist: 'A' },
      nowPlayingByPid: { 1: { state: 'pause', song: 'Track', artist: 'A' } },
      volumes: { 1: 50, 2: 60 },
    },
  });
});

describe('A3: usePlaybackProgress re-arms on play-state hint change', () => {
  it('polls playbackPosition again when snap.nowPlaying.state flips pause→play', async () => {
    renderApp(App);
    // Initial mount with state=pause: the loop polls once, sees is_playing=false,
    // and stops. Wait for that first poll to settle.
    await waitFor(() => expect(api.playbackPosition).toHaveBeenCalledTimes(1));

    // Now flip the leader's play state to 'play' via WS — this is what HEOS
    // emits when the user taps Play on the controller after a pause.
    api.playbackPosition.mockClear();
    act(() => {
      testCtx.triggerWsMessage({
        type: 'change',
        change: { type: 'nowPlaying', nowPlaying: { pid: '1', state: 'play', song: 'Track', artist: 'A' } },
      });
    });
    // Effect re-runs because playStateHint changed — fetchOnce fires immediately.
    await waitFor(() => expect(api.playbackPosition).toHaveBeenCalledTimes(1));
  });
});

describe('B2: setZoneVolume optimistic rollback', () => {
  it('rolls back snap.volumes[pid] for every speaker in the zone when api.setVolume rejects', async () => {
    api.setVolume.mockRejectedValueOnce(new Error('HEOS unreachable'));
    renderApp(App);
    await waitFor(() => expect(testCtx.getCapturedProps('ZoneGrid')).toBeDefined());
    // Sanity: starting volumes (50, 60).
    expect(testCtx.getCapturedProps('ZoneGrid').volumes['1']).toBe(50);
    expect(testCtx.getCapturedProps('ZoneGrid').volumes['2']).toBe(60);

    await act(async () => {
      await testCtx.getCapturedProps('ZoneGrid').onVolume('Downstairs', 80);
    });

    // After the rejected setVolume, both pids in the zone must be back to
    // their original values, not stuck at the optimistic 80.
    await waitFor(() => {
      expect(testCtx.getCapturedProps('ZoneGrid').volumes['1']).toBe(50);
      expect(testCtx.getCapturedProps('ZoneGrid').volumes['2']).toBe(60);
    });
  });

  it('keeps the new value when api.setVolume resolves', async () => {
    api.setVolume.mockResolvedValueOnce({ ok: true });
    renderApp(App);
    await waitFor(() => expect(testCtx.getCapturedProps('ZoneGrid')).toBeDefined());

    await act(async () => {
      await testCtx.getCapturedProps('ZoneGrid').onVolume('Downstairs', 80);
    });
    await waitFor(() => {
      expect(testCtx.getCapturedProps('ZoneGrid').volumes['1']).toBe(80);
      expect(testCtx.getCapturedProps('ZoneGrid').volumes['2']).toBe(80);
    });
  });
});
