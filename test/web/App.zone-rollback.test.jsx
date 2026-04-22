// F6: optimistic toggle of a zone must roll back when /api/zones/active
// rejects (e.g. HEOS syserrno=-9 — speaker can't be grouped with this leader).

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeroUIProvider } from '@heroui/react';

let onMessageCb = null;

vi.mock('../../web/src/api.js', () => ({
  api: {
    state: vi.fn(),
    setActive: vi.fn(),
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
        zones: [
          { name: 'Downstairs', pids: ['1'] },
          { name: 'Basement', pids: ['2'] },
        ],
        activeZones: ['Downstairs'],
        activePids: ['1'],
        nowPlaying: null,
        nowPlayingByPid: {},
        volumes: { 1: 50, 2: 50 },
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

import App from '../../web/src/App.jsx';
import { api } from '../../web/src/api.js';

function renderApp() {
  return render(<HeroUIProvider><App /></HeroUIProvider>);
}

beforeEach(() => { onMessageCb = null; });
afterEach(() => { vi.clearAllMocks(); });

describe('zone rollback (F6)', () => {
  it('rolls back the optimistic toggle and shows a banner when setActive rejects', async () => {
    api.setActive.mockRejectedValueOnce(new Error('syserrno=-9 (Group not allowed)'));
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getByText('Basement')).toBeInTheDocument());

    // Downstairs is initially active (✓ shown). Click Basement to add it.
    const basementBtn = screen.getByRole('button', { name: /Basement/ });
    await user.click(basementBtn);

    // Server rejected → checkmark on Basement should NOT remain.
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Basement/ });
      expect(btn.getAttribute('aria-pressed')).toBe('false');
    });

    // Banner explains the failure persistently.
    expect(screen.getByText(/Group not allowed|syserrno=-9/i)).toBeInTheDocument();

    // Downstairs's selection state survives the rollback.
    const downstairsBtn = screen.getByRole('button', { name: /Downstairs/ });
    expect(downstairsBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the toggle when setActive resolves', async () => {
    api.setActive.mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(screen.getByText('Basement')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Basement/ }));
    await waitFor(() => {
      expect(api.setActive).toHaveBeenCalledWith(['Downstairs', 'Basement']);
    });
    const btn = screen.getByRole('button', { name: /Basement/ });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
});
