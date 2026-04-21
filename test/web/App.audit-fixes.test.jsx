// Pre-push audit regressions:
//   A3 — usePlaybackProgress re-arms when snap.nowPlaying.state flips to 'play'
//        after being paused. Without this, paused → played leaves the bar
//        frozen until the tab is hidden+shown.
//   B2 — setHeosVolume rolls back the optimistic per-zone update when
//        api.setVolume rejects (symmetric with the existing setActiveHeos
//        rollback).

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';

let onMessageCb = null;
let lastZoneGridProps = null;

vi.mock('../../web/src/api.js', () => ({
  api: {
    state: vi.fn(),
    setActive: vi.fn().mockResolvedValue({ ok: true }),
    search: vi.fn().mockResolvedValue({ results: {} }),
    play: vi.fn().mockResolvedValue({ ok: true }),
    control: vi.fn().mockResolvedValue({ ok: true }),
    setVolume: vi.fn().mockResolvedValue({ ok: true }),
    seek: vi.fn().mockResolvedValue({ ok: true }),
    playbackPosition: vi.fn().mockResolvedValue({ playback: null }),
    spotifyDisconnect: vi.fn().mockResolvedValue({ ok: true }),
  },
  connectWS: vi.fn((cb) => {
    onMessageCb = cb;
    queueMicrotask(() => cb({
      type: 'snapshot',
      state: {
        players: [{ pid: '1', name: 'Bar' }, { pid: '2', name: 'Basement' }],
        activePids: ['1', '2'],
        nowPlaying: { pid: '1', state: 'pause', song: 'Track', artist: 'A' },
        volumes: { 1: 50, 2: 60 },
        spotifyConnected: true,
        recents: [],
      },
    }));
    return { close: vi.fn() };
  }),
  setupWakeLock: vi.fn(),
  SPOTIFY_REAUTH_EVENT: 'heos:spotify-reauth',
}));

vi.mock('../../web/src/components/Backdrop.jsx', () => ({ default: () => null }));
vi.mock('../../web/src/components/NowPlaying.jsx', () => ({ default: () => <div data-testid="np" /> }));

// Capture ZoneGrid props so the test can call onVolume directly without
// driving HeroUI's slider interaction model.
vi.mock('../../web/src/components/ZoneGrid.jsx', () => ({
  default: (props) => {
    lastZoneGridProps = props;
    return <div data-testid="zg" />;
  },
}));

import App from '../../web/src/App.jsx';
import { api } from '../../web/src/api.js';

beforeEach(() => {
  onMessageCb = null;
  lastZoneGridProps = null;
  api.setVolume.mockReset();
  api.playbackPosition.mockReset();
  api.playbackPosition.mockResolvedValue({ playback: null });
});

function renderApp() {
  return render(<HeroUIProvider><App /></HeroUIProvider>);
}

describe('A3: usePlaybackProgress re-arms on play-state hint change', () => {
  it('polls playbackPosition again when snap.nowPlaying.state flips pause→play', async () => {
    renderApp();
    // Initial mount with state=pause: the loop polls once, sees is_playing=false,
    // and stops. Wait for that first poll to settle.
    await waitFor(() => expect(api.playbackPosition).toHaveBeenCalledTimes(1));

    // Now flip the leader's play state to 'play' via WS — this is what HEOS
    // emits when the user taps Play on the controller after a pause.
    api.playbackPosition.mockClear();
    act(() => {
      onMessageCb({
        type: 'change',
        change: { type: 'nowPlaying', nowPlaying: { pid: '1', state: 'play', song: 'Track', artist: 'A' } },
      });
    });
    // Effect re-runs because playStateHint changed — fetchOnce fires immediately.
    await waitFor(() => expect(api.playbackPosition).toHaveBeenCalledTimes(1));
  });
});

describe('B2: setHeosVolume optimistic rollback', () => {
  it('rolls back snap.volumes[pid] when api.setVolume rejects', async () => {
    api.setVolume.mockRejectedValueOnce(new Error('HEOS unreachable'));
    renderApp();
    await waitFor(() => expect(lastZoneGridProps).not.toBeNull());
    // Sanity: starting volume for pid=1 is 50.
    expect(lastZoneGridProps.volumes['1']).toBe(50);

    await act(async () => {
      await lastZoneGridProps.onVolume('1', 80);
    });

    // After the rejected setVolume, the slider value must be back to 50, not
    // stuck at the optimistic 80.
    await waitFor(() => expect(lastZoneGridProps.volumes['1']).toBe(50));
  });

  it('keeps the new value when api.setVolume resolves', async () => {
    api.setVolume.mockResolvedValueOnce({ ok: true });
    renderApp();
    await waitFor(() => expect(lastZoneGridProps).not.toBeNull());

    await act(async () => {
      await lastZoneGridProps.onVolume('1', 80);
    });
    await waitFor(() => expect(lastZoneGridProps.volumes['1']).toBe(80));
  });
});
