// Smoke test for App: mounts, hydrates from api.state(), receives a WS snapshot,
// renders zones, and shows a toast when Play is pressed with no active zones.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeroUIProvider } from '@heroui/react';

let onMessageCb = null;
const wsCloseSpy = vi.fn();

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
    // Mimic the bootstrap snapshot the real server sends on connect.
    queueMicrotask(() => cb({
      type: 'snapshot',
      state: {
        players: [{ pid: '1', name: 'Kitchen' }, { pid: '2', name: 'Living Room' }],
        activePids: [],
        nowPlaying: null,
        volumes: {},
        spotifyConnected: true,
      },
    }));
    return { close: wsCloseSpy };
  }),
  setupWakeLock: vi.fn(),
  SPOTIFY_REAUTH_EVENT: 'heos:spotify-reauth',
}));

// Backdrop renders a heavy <img> + canvas; stub it for the smoke test.
vi.mock('../../web/src/components/Backdrop.jsx', () => ({
  default: () => null,
}));

import App from '../../web/src/App.jsx';
import { api, connectWS } from '../../web/src/api.js';

function renderApp() {
  return render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );
}

beforeEach(() => {
  onMessageCb = null;
  wsCloseSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('App smoke', () => {
  it('renders zones once the WS snapshot arrives', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeInTheDocument());
    expect(screen.getByText('Living Room')).toBeInTheDocument();
    expect(connectWS).toHaveBeenCalled();
  });

  it('updates state when a follow-up WS snapshot arrives', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeInTheDocument());
    act(() => {
      onMessageCb({
        type: 'snapshot',
        state: {
          players: [{ pid: '9', name: 'Patio' }],
          activePids: [],
          nowPlaying: null,
          volumes: {},
          spotifyConnected: true,
        },
      });
    });
    expect(screen.getByText('Patio')).toBeInTheDocument();
  });

  it('shows the Spotify-connect banner when spotifyConnected is false', async () => {
    renderApp();
    // Override the snapshot the mocked connectWS just queued.
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeInTheDocument());
    act(() => {
      onMessageCb({
        type: 'snapshot',
        state: { players: [], activePids: [], nowPlaying: null, volumes: {}, spotifyConnected: false },
      });
    });
    await waitFor(() => expect(screen.getByText(/Spotify isn't connected/)).toBeInTheDocument());
  });

  it('applies a WS change event by reducing into snap', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeInTheDocument());
    act(() => {
      onMessageCb({ type: 'change', change: { type: 'players', players: [{ pid: '7', name: 'Garage' }] } });
    });
    expect(screen.getByText('Garage')).toBeInTheDocument();
    expect(screen.queryByText('Kitchen')).not.toBeInTheDocument();
  });

  it('cleans up the WS connection on unmount', async () => {
    const { unmount } = renderApp();
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeInTheDocument());
    unmount();
    expect(wsCloseSpy).toHaveBeenCalled();
  });
});

// H3: the REST hydrate was redundant with the WS snapshot — the App should
// rely on the WS handshake's first frame.
describe('App does not call api.state() during mount', () => {
  it('mounts without calling the REST snapshot endpoint', async () => {
    renderApp();
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeInTheDocument());
    expect(api.state).not.toHaveBeenCalled();
  });
});

// H5 is verified separately in App.master-volume.test.jsx — it mocks
// NowPlaying to drive the master-volume callbacks directly, since HeroUI's
// Slider doesn't respond to keyboard events under jsdom.
