// Smoke test for App: mounts, hydrates from api.state(), receives a WS snapshot,
// renders zones, and shows a toast when Play is pressed with no active zones.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { createApiMock, setupAppTest, renderApp } from './helpers/render-app.jsx';

vi.mock('../../web/src/api.js', () => createApiMock());
vi.mock('../../web/src/components/Backdrop.jsx', () => ({ default: () => null }));

import App from '../../web/src/App.jsx';
import { api, connectWS } from '../../web/src/api.js';

let testCtx;
beforeEach(() => {
  testCtx = setupAppTest({
    snapshot: {
      players: [{ pid: '1', name: 'Kitchen' }, { pid: '2', name: 'Living Room' }],
      zones: [{ name: 'Upstairs', pids: ['1', '2'] }],
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('App smoke', () => {
  it('renders zones once the WS snapshot arrives', async () => {
    renderApp(App);
    await waitFor(() => expect(screen.getByText('Upstairs')).toBeInTheDocument());
    expect(connectWS).toHaveBeenCalled();
  });

  it('updates state when a follow-up WS snapshot arrives', async () => {
    renderApp(App);
    await waitFor(() => expect(screen.getByText('Upstairs')).toBeInTheDocument());
    act(() => {
      testCtx.triggerWsMessage({
        type: 'snapshot',
        state: {
          players: [{ pid: '9', name: 'Patio' }],
          zones: [{ name: 'Porch', pids: ['9'] }],
          activeZones: [],
          activePids: [],
          nowPlaying: null,
          nowPlayingByPid: {},
          volumes: {},
          spotifyConnected: true,
        },
      });
    });
    expect(screen.getByText('Porch')).toBeInTheDocument();
  });

  it('shows the Spotify-connect banner when spotifyConnected is false', async () => {
    renderApp(App);
    await waitFor(() => expect(screen.getByText('Upstairs')).toBeInTheDocument());
    act(() => {
      testCtx.triggerWsMessage({
        type: 'snapshot',
        state: {
          players: [], zones: [], activeZones: [], activePids: [],
          nowPlaying: null, nowPlayingByPid: {}, volumes: {},
          spotifyConnected: false,
        },
      });
    });
    await waitFor(() => expect(screen.getByText(/Spotify isn't connected/)).toBeInTheDocument());
  });

  it('applies a WS change event by reducing into snap', async () => {
    renderApp(App);
    await waitFor(() => expect(screen.getByText('Upstairs')).toBeInTheDocument());
    act(() => {
      testCtx.triggerWsMessage({
        type: 'change',
        change: { type: 'zones', zones: [{ name: 'Garage', pids: ['7'] }] },
      });
    });
    expect(screen.getByText('Garage')).toBeInTheDocument();
    expect(screen.queryByText('Upstairs')).not.toBeInTheDocument();
  });

  it('cleans up the WS connection on unmount', async () => {
    const { unmount } = renderApp(App);
    await waitFor(() => expect(screen.getByText('Upstairs')).toBeInTheDocument());
    unmount();
    expect(testCtx.getWsCloseSpy()).toHaveBeenCalled();
  });
});

// H3: the REST hydrate was redundant with the WS snapshot — the App should
// rely on the WS handshake's first frame.
describe('App does not call api.state() during mount', () => {
  it('mounts without calling the REST snapshot endpoint', async () => {
    renderApp(App);
    await waitFor(() => expect(screen.getByText('Upstairs')).toBeInTheDocument());
    expect(api.state).not.toHaveBeenCalled();
  });
});
