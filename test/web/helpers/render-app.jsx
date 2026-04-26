// Shared mock + render plumbing for App.* tests.
//
// Why: each App test file used to duplicate ~40 lines of `vi.mock(api.js)`,
// `connectWS` snapshot stub, and Backdrop stub. Adding a new method to the
// `api` surface required touching every file in lockstep. This helper holds
// the canonical shape; tests pass per-test snapshots and overrides.
//
// Constraint: `vi.mock(path, factory)` is hoisted by Vitest, so the factory
// expression must live in each test file (one line). The factory just calls
// `createApiMock()` from this module — by the time the factory actually runs
// (lazily, on first import of api.js by the system under test), the helper
// import has already resolved.

import React from 'react';
import { render } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { vi } from 'vitest';

// Mutable test context captured by the mocked `connectWS`. Each `setupAppTest`
// call resets it. Tests reach in via the returned helpers, not directly.
const ctx = {
  wsCb: null,
  wsCloseSpy: null,
  pendingSnapshot: null,
  capturedProps: {},
};

// Default snapshot — a clean canvas; tests merge per-test overrides on top.
export const DEFAULT_SNAPSHOT = {
  players: [],
  zones: [],
  activeZones: [],
  activePids: [],
  nowPlaying: null,
  nowPlayingByPid: {},
  volumes: {},
  spotifyConnected: true,
  recents: [],
  frequent: [],
};

/**
 * The mocked api.js module shape. Returned object is what `vi.mock` should
 * provide. Tests override individual `api.*` methods AFTER mount via the
 * standard `api.foo.mockResolvedValue(...)` pattern (since the api object
 * is the same identity across the test).
 */
export function createApiMock() {
  const api = {
    state: vi.fn(),
    setActive: vi.fn().mockResolvedValue({ ok: true }),
    search: vi.fn().mockResolvedValue({ results: {} }),
    play: vi.fn().mockResolvedValue({ ok: true }),
    control: vi.fn().mockResolvedValue({ ok: true }),
    setVolume: vi.fn().mockResolvedValue({ ok: true }),
    seek: vi.fn().mockResolvedValue({ ok: true }),
    playbackPosition: vi.fn().mockResolvedValue({ playback: null }),
    spotifyDisconnect: vi.fn().mockResolvedValue({ ok: true }),
    stopAll: vi.fn().mockResolvedValue({ ok: true }),
    removeRecent: vi.fn().mockResolvedValue({ ok: true }),
  };
  const connectWS = vi.fn((cb) => {
    ctx.wsCb = cb;
    if (ctx.pendingSnapshot) {
      const snap = ctx.pendingSnapshot;
      // Mimic the bootstrap snapshot the real server sends on connect.
      queueMicrotask(() => cb({ type: 'snapshot', state: snap }));
    }
    return { close: ctx.wsCloseSpy };
  });
  return {
    api,
    connectWS,
    setupWakeLock: vi.fn(),
    SPOTIFY_REAUTH_EVENT: 'heos:spotify-reauth',
  };
}

/**
 * Component mock that captures the props the parent passes. Use to drive
 * callbacks (e.g. `onVolume`, `onMasterVolume`, `onPlay`) without driving
 * HeroUI's interaction model.
 *
 *   vi.mock('../../web/src/components/ZoneGrid.jsx',
 *     () => captureComponent('ZoneGrid'));
 *
 * Then read `getCapturedProps('ZoneGrid')` after mount.
 */
export function captureComponent(name) {
  return {
    default: (props) => {
      ctx.capturedProps[name] = props;
      return <div data-testid={`mock-${name.toLowerCase()}`} />;
    },
  };
}

/**
 * Reset the shared mock context for a single test. Call from `beforeEach`.
 *
 * @param {object} [opts]
 * @param {object} [opts.snapshot] - merged on top of DEFAULT_SNAPSHOT, sent
 *   as the first WS frame after mount.
 * @returns helpers — `triggerWsMessage(msg)`, `getCapturedProps(name)`,
 *   `getWsCloseSpy()`.
 */
export function setupAppTest({ snapshot } = {}) {
  ctx.wsCb = null;
  ctx.wsCloseSpy = vi.fn();
  ctx.pendingSnapshot = snapshot ? { ...DEFAULT_SNAPSHOT, ...snapshot } : { ...DEFAULT_SNAPSHOT };
  ctx.capturedProps = {};
  return {
    triggerWsMessage: (msg) => { if (ctx.wsCb) ctx.wsCb(msg); },
    getCapturedProps: (name) => ctx.capturedProps[name],
    getWsCloseSpy: () => ctx.wsCloseSpy,
  };
}

/** Render an App-under-test wrapped in HeroUIProvider. */
export function renderApp(AppComponent) {
  return render(
    <HeroUIProvider>
      <AppComponent />
    </HeroUIProvider>,
  );
}
