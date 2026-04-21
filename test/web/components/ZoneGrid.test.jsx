// ZoneGrid: render players, fire onToggle on press, show slider only when active.

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeroUIProvider } from '@heroui/react';
import ZoneGrid from '../../../web/src/components/ZoneGrid.jsx';

function renderZG(props) {
  return render(
    <HeroUIProvider>
      <ZoneGrid {...props} />
    </HeroUIProvider>,
  );
}

const baseProps = {
  players: [
    { pid: '1', name: 'Kitchen' },
    { pid: '2', name: 'Living Room' },
  ],
  activePids: [],
  volumes: { 1: 30, 2: 40 },
  onToggle: vi.fn(),
  onVolume: vi.fn(),
};

describe('ZoneGrid', () => {
  it('renders one card per player', () => {
    renderZG(baseProps);
    expect(screen.getByText('Kitchen')).toBeInTheDocument();
    expect(screen.getByText('Living Room')).toBeInTheDocument();
  });

  it('fires onToggle with the pid when a card is pressed', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderZG({ ...baseProps, onToggle });
    await user.click(screen.getByText('Kitchen'));
    expect(onToggle).toHaveBeenCalledWith('1');
  });

  it('renders the volume slider only for active zones', () => {
    renderZG({ ...baseProps, activePids: ['1'] });
    expect(screen.getByLabelText('Kitchen volume')).toBeInTheDocument();
    expect(screen.queryByLabelText('Living Room volume')).not.toBeInTheDocument();
  });

  it('shows the active checkmark on active zones', () => {
    renderZG({ ...baseProps, activePids: ['2'] });
    // The Chip renders ✓ as text content.
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('renders no cards when players is empty (no crash)', () => {
    const { container } = renderZG({ ...baseProps, players: [] });
    expect(container.querySelectorAll('[data-slot="base"]').length).toBe(0);
  });
});

// H4: only the header button toggles the zone now; the slider lives outside
// the press surface, so dragging it can't fire onToggle.
describe('volume slider drag does not toggle the parent card', () => {
  it('clicking inside the slider does not call onToggle', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onVolume = vi.fn();
    renderZG({ ...baseProps, activePids: ['1'], onToggle, onVolume });
    const slider = screen.getByLabelText('Kitchen volume');
    // userEvent.click on the slider container fires pointerdown/up but is NOT
    // routed to the header button — the slider is a sibling element.
    await user.click(slider);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('clicking the header text still toggles', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderZG({ ...baseProps, activePids: ['1'], onToggle });
    await user.click(screen.getByText('Kitchen'));
    expect(onToggle).toHaveBeenCalledWith('1');
  });
});
