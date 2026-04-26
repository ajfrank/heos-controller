// T1.1: App.play() must be single-flight. A double-tap on a Quick Pick (or
// rapid taps across rows) would otherwise fire two /api/play calls; their
// applyGroup + transferPlayback + play chains interleave on Spotify and
// bounce zones around. The "Waking…" toast is already feedback that the tap
// registered, so the dropped re-tap is silent.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor, act } from '@testing-library/react';
import { createApiMock, setupAppTest, captureComponent, renderApp } from './helpers/render-app.jsx';

vi.mock('../../web/src/api.js', () => createApiMock());
vi.mock('../../web/src/components/Backdrop.jsx', () => ({ default: () => null }));
vi.mock('../../web/src/components/QuickPicks.jsx', () => captureComponent('QuickPicks'));

import App from '../../web/src/App.jsx';
import { api } from '../../web/src/api.js';

let testCtx;
beforeEach(() => {
  api.play.mockReset();
  testCtx = setupAppTest({
    snapshot: {
      players: [{ pid: '1', name: 'Bar' }],
      zones: [{ name: 'Bar', pids: ['1'] }],
      activeZones: ['Bar'],
      activePids: ['1'],
      volumes: { 1: 50 },
      recents: [{ uri: 'spotify:track:r', label: 'R', sublabel: '', art: '', badge: 'Track', ts: 1 }],
    },
  });
});

describe('App play() single-flight (T1.1)', () => {
  it('drops a second play() while the first is in flight', async () => {
    let resolveFirst;
    api.play.mockImplementation(() => new Promise((r) => { resolveFirst = r; }));

    renderApp(App);
    await waitFor(() => expect(testCtx.getCapturedProps('QuickPicks')).toBeDefined());

    const item = { uri: 'spotify:track:r', label: 'R' };
    act(() => { testCtx.getCapturedProps('QuickPicks').onPlay(item); });
    act(() => { testCtx.getCapturedProps('QuickPicks').onPlay(item); });
    act(() => { testCtx.getCapturedProps('QuickPicks').onPlay(item); });

    expect(api.play).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ ok: true });
      await Promise.resolve();
    });

    // After the first call resolves, a fresh tap goes through.
    api.play.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      testCtx.getCapturedProps('QuickPicks').onPlay(item);
      await Promise.resolve();
    });
    expect(api.play).toHaveBeenCalledTimes(2);
  });
});
