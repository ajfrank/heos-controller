// H5: the displayed master volume is local state — incoming per-zone WS
// volume_changed events update the underlying snap.volumes map but do NOT
// snap the master display back while the user is dragging. The override
// clears on onMasterVolumeEnd.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { createApiMock, setupAppTest, captureComponent, renderApp } from './helpers/render-app.jsx';

vi.mock('../../web/src/api.js', () => createApiMock());
vi.mock('../../web/src/components/Backdrop.jsx', () => ({ default: () => null }));

// NowPlaying mock renders the master value as text so visibility assertions
// don't need to drive HeroUI's slider interaction model.
vi.mock('../../web/src/components/NowPlaying.jsx', async () => {
  const { captureComponent: cc } = await import('./helpers/render-app.jsx');
  const base = cc('NowPlaying');
  return {
    default: (props) => {
      // Run the prop-capture, then render with the master value visible.
      base.default(props);
      return <div data-testid="np">master={String(props.masterVolume)}</div>;
    },
  };
});

import App from '../../web/src/App.jsx';
import { api } from '../../web/src/api.js';

let testCtx;
beforeEach(() => {
  api.setVolume.mockClear();
  testCtx = setupAppTest({
    snapshot: {
      players: [{ pid: '1', name: 'A' }, { pid: '2', name: 'B' }],
      zones: [
        { name: 'Upstairs', pids: ['1'] },
        { name: 'Porch', pids: ['2'] },
      ],
      activeZones: ['Upstairs', 'Porch'],
      activePids: ['1', '2'],
      volumes: { 1: 20, 2: 40 },
    },
  });
});

const npProps = () => testCtx.getCapturedProps('NowPlaying');

describe('App master volume', () => {
  it('starts with the average of active per-zone volumes', async () => {
    renderApp(App);
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=30'));
  });

  it('drag to 60 fires per-zone setVolume for each active zone (debounced)', async () => {
    renderApp(App);
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=30'));
    act(() => { npProps().onMasterVolume(60); });
    // UI flips immediately (optimistic master override).
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=60'));
    // Network fan-out is debounced ~80ms so a 30Hz drag doesn't N×4× HEOS commands.
    await waitFor(() => expect(api.setVolume).toHaveBeenCalledWith('Upstairs', 60));
    expect(api.setVolume).toHaveBeenCalledWith('Porch', 60);
  });

  it('rapid drag ticks coalesce: only the latest value reaches the network', async () => {
    renderApp(App);
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=30'));
    // Simulate a slider drag of 5 ticks within the debounce window.
    act(() => {
      npProps().onMasterVolume(40);
      npProps().onMasterVolume(45);
      npProps().onMasterVolume(50);
      npProps().onMasterVolume(55);
      npProps().onMasterVolume(60);
    });
    await waitFor(() => expect(api.setVolume).toHaveBeenCalledWith('Upstairs', 60));
    // Per zone, exactly one fan-out — earlier ticks were dropped.
    const upstairsCalls = api.setVolume.mock.calls.filter((c) => c[0] === 'Upstairs');
    expect(upstairsCalls).toEqual([['Upstairs', 60]]);
  });

  it('onMasterVolumeEnd flushes the pending value immediately, even mid-debounce', async () => {
    renderApp(App);
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=30'));
    act(() => { npProps().onMasterVolume(75); });
    // End drag synchronously — the final value should be sent without waiting
    // for the debounce timer to elapse, so finger-up locks the volume in.
    act(() => { npProps().onMasterVolumeEnd(); });
    expect(api.setVolume).toHaveBeenCalledWith('Upstairs', 75);
    expect(api.setVolume).toHaveBeenCalledWith('Porch', 75);
  });

  it('a WS volume_changed for one pid does NOT yank the displayed master mid-drag', async () => {
    renderApp(App);
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=30'));
    act(() => { npProps().onMasterVolume(60); });
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=60'));
    // Stale per-zone value arrives over WS — must not override the displayed master.
    act(() => {
      testCtx.triggerWsMessage({ type: 'change', change: { type: 'volume', pid: '1', level: 22 } });
    });
    expect(screen.getByTestId('np')).toHaveTextContent('master=60');
  });

  it('after onMasterVolumeEnd, the displayed master returns to the live average', async () => {
    renderApp(App);
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=30'));
    act(() => { npProps().onMasterVolume(60); });
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=60'));
    // setVolume optimistically updated snap.volumes for both pids to 60, so
    // the live average is now 60. End the drag and expect the display to
    // continue tracking the average (which happens to also be 60).
    act(() => { npProps().onMasterVolumeEnd(); });
    expect(screen.getByTestId('np')).toHaveTextContent('master=60');
    // A new WS event for one zone now propagates to the master display.
    act(() => {
      testCtx.triggerWsMessage({ type: 'change', change: { type: 'volume', pid: '1', level: 20 } });
    });
    // average(20, 60) = 40
    await waitFor(() => expect(screen.getByTestId('np')).toHaveTextContent('master=40'));
  });
});
