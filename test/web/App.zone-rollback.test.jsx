// F6: optimistic toggle of a zone must roll back when /api/zones/active
// rejects (e.g. HEOS syserrno=-9 — speaker can't be grouped with this leader).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createApiMock, setupAppTest, renderApp } from './helpers/render-app.jsx';

vi.mock('../../web/src/api.js', () => createApiMock());
vi.mock('../../web/src/components/Backdrop.jsx', () => ({ default: () => null }));

import App from '../../web/src/App.jsx';
import { api } from '../../web/src/api.js';

beforeEach(() => {
  setupAppTest({
    snapshot: {
      players: [{ pid: '1', name: 'Bar' }, { pid: '2', name: 'Basement' }],
      zones: [
        { name: 'Downstairs', pids: ['1'] },
        { name: 'Basement', pids: ['2'] },
      ],
      activeZones: ['Downstairs'],
      activePids: ['1'],
      volumes: { 1: 50, 2: 50 },
    },
  });
});

afterEach(() => { vi.clearAllMocks(); });

describe('zone rollback (F6)', () => {
  it('rolls back the optimistic toggle and shows a banner when setActive rejects', async () => {
    api.setActive.mockRejectedValueOnce(new Error('syserrno=-9 (Group not allowed)'));
    const user = userEvent.setup();
    renderApp(App);
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
    renderApp(App);
    await waitFor(() => expect(screen.getByText('Basement')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Basement/ }));
    await waitFor(() => {
      expect(api.setActive).toHaveBeenCalledWith(['Downstairs', 'Basement']);
    });
    const btn = screen.getByRole('button', { name: /Basement/ });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
});
