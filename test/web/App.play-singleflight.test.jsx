// T1.1: App.play() must be single-flight. A double-tap on a Quick Pick (or
// rapid taps across rows) would otherwise fire two /api/play calls; their
// applyGroup + transferPlayback + play chains interleave on Spotify and
// bounce zones around. The "Waking…" toast is already feedback that the tap
// registered, so the dropped re-tap is silent.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';

let onMessageCb = null;
let capturedQuickPickProps = null;

vi.mock('../../web/src/api.js', () => ({
  api: {
    state: vi.fn(),
    setActive: vi.fn().mockResolvedValue({ ok: true }),
    search: vi.fn().mockResolvedValue({ results: {} }),
    play: vi.fn(),
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
        players: [{ pid: '1', name: 'Bar' }],
        activePids: ['1'],
        nowPlaying: null,
        volumes: { 1: 50 },
        spotifyConnected: true,
        recents: [{ uri: 'spotify:track:r', label: 'R', sublabel: '', art: '', badge: 'Track', ts: 1 }],
      },
    }));
    return { close: vi.fn() };
  }),
  setupWakeLock: vi.fn(),
  SPOTIFY_REAUTH_EVENT: 'heos:spotify-reauth',
}));

vi.mock('../../web/src/components/Backdrop.jsx', () => ({ default: () => null }));

// Capture the onPlay prop QuickPicks receives so the test can invoke it
// directly without depending on QuickPicks' internal markup.
vi.mock('../../web/src/components/QuickPicks.jsx', () => ({
  default: (props) => {
    capturedQuickPickProps = props;
    return <div data-testid="qp" />;
  },
}));

import App from '../../web/src/App.jsx';
import { api } from '../../web/src/api.js';

beforeEach(() => {
  onMessageCb = null;
  capturedQuickPickProps = null;
  api.play.mockReset();
});

function renderApp() {
  return render(<HeroUIProvider><App /></HeroUIProvider>);
}

describe('App play() single-flight (T1.1)', () => {
  it('drops a second play() while the first is in flight', async () => {
    let resolveFirst;
    api.play.mockImplementation(() => new Promise((r) => { resolveFirst = r; }));

    renderApp();
    await waitFor(() => expect(capturedQuickPickProps).not.toBeNull());

    const item = { uri: 'spotify:track:r', label: 'R' };
    act(() => { capturedQuickPickProps.onPlay(item); });
    act(() => { capturedQuickPickProps.onPlay(item); });
    act(() => { capturedQuickPickProps.onPlay(item); });

    expect(api.play).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ ok: true });
      await Promise.resolve();
    });

    // After the first call resolves, a fresh tap goes through.
    api.play.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      capturedQuickPickProps.onPlay(item);
      await Promise.resolve();
    });
    expect(api.play).toHaveBeenCalledTimes(2);
  });
});
