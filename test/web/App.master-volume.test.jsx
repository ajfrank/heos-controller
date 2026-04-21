// H5: the displayed master volume is local state — incoming per-zone WS
// volume_changed events update the underlying snap.volumes map but do NOT
// snap the master display back while the user is dragging. The override
// clears on onMasterVolumeEnd.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';

let onMessageCb = null;
let lastNowPlayingProps = null;

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
        players: [{ pid: '1', name: 'A' }, { pid: '2', name: 'B' }],
        activePids: ['1', '2'],
        nowPlaying: null,
        volumes: { 1: 20, 2: 40 },
        spotifyConnected: true,
      },
    }));
    return { close: vi.fn() };
  }),
  setupWakeLock: vi.fn(),
  SPOTIFY_REAUTH_EVENT: 'heos:spotify-reauth',
}));

vi.mock('../../web/src/components/Backdrop.jsx', () => ({ default: () => null }));

// Capture the props NowPlaying receives so we can drive its callbacks directly.
vi.mock('../../web/src/components/NowPlaying.jsx', () => ({
  default: (props) => {
    lastNowPlayingProps = props;
    return <div data-testid="np">master={String(props.masterVolume)}</div>;
  },
}));

import App from '../../web/src/App.jsx';
import { api } from '../../web/src/api.js';

beforeEach(() => {
  onMessageCb = null;
  lastNowPlayingProps = null;
  api.setVolume.mockClear();
});

function renderApp() {
  return render(<HeroUIProvider><App /></HeroUIProvider>);
}

describe('App master volume', () => {
  it('starts with the average of active per-zone volumes', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=30'));
  });

  it('drag to 60 fires per-zone setVolume for each active pid', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=30'));
    act(() => { lastNowPlayingProps.onMasterVolume(60); });
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=60'));
    expect(api.setVolume).toHaveBeenCalledWith('1', 60);
    expect(api.setVolume).toHaveBeenCalledWith('2', 60);
  });

  it('a WS volume_changed for one pid does NOT yank the displayed master mid-drag', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=30'));
    act(() => { lastNowPlayingProps.onMasterVolume(60); });
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=60'));
    // Stale per-zone value arrives over WS — must not override the displayed master.
    act(() => {
      onMessageCb({ type: 'change', change: { type: 'volume', pid: '1', level: 22 } });
    });
    expect(screen.getByTestId('np')).toHaveTextContent('master=60');
  });

  it('after onMasterVolumeEnd, the displayed master returns to the live average', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=30'));
    act(() => { lastNowPlayingProps.onMasterVolume(60); });
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=60'));
    // setVolume optimistically updated snap.volumes for both pids to 60, so
    // the live average is now 60. End the drag and expect the display to
    // continue tracking the average (which happens to also be 60).
    act(() => { lastNowPlayingProps.onMasterVolumeEnd(); });
    expect(screen.getByTestId('np')).toHaveTextContent('master=60');
    // A new WS event for one zone now propagates to the master display.
    act(() => {
      onMessageCb({ type: 'change', change: { type: 'volume', pid: '1', level: 20 } });
    });
    // average(20, 60) = 40
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=40'));
  });
});
