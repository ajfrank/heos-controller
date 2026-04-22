// ZoneGrid: render zone cards, fire onToggle on press, show slider only when active.

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
  zones: [
    { name: 'Upstairs', pids: ['1', '2'] },
    { name: 'Porch', pids: ['3'] },
  ],
  activeZones: [],
  volumes: { 1: 30, 2: 50, 3: 40 },
  onToggle: vi.fn(),
  onVolume: vi.fn(),
};

describe('ZoneGrid', () => {
  it('renders one card per zone', () => {
    renderZG(baseProps);
    expect(screen.getByText('Upstairs')).toBeInTheDocument();
    expect(screen.getByText('Porch')).toBeInTheDocument();
  });

  it('fires onToggle with the zone name when a card is pressed', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderZG({ ...baseProps, onToggle });
    await user.click(screen.getByText('Upstairs'));
    expect(onToggle).toHaveBeenCalledWith('Upstairs');
  });

  it('renders the volume slider only for active zones', () => {
    renderZG({ ...baseProps, activeZones: ['Upstairs'] });
    expect(screen.getByLabelText('Upstairs volume')).toBeInTheDocument();
    expect(screen.queryByLabelText('Porch volume')).not.toBeInTheDocument();
  });

  it('shows the active checkmark on active zones', () => {
    const { container } = renderZG({ ...baseProps, activeZones: ['Porch'] });
    // Active zones render an SVG checkmark inside a span with aria-label="Active".
    expect(container.querySelector('[aria-label="Active"]')).toBeInTheDocument();
  });

  it('renders no cards when zones is empty (no crash)', () => {
    const { container } = renderZG({ ...baseProps, zones: [] });
    expect(container.querySelectorAll('[data-slot="base"]').length).toBe(0);
  });

  it('master volume slider shows the average of in-zone speaker volumes', () => {
    // Upstairs = avg(30, 50) = 40
    const { container } = renderZG({ ...baseProps, activeZones: ['Upstairs'] });
    // The component renders the master value as plain text next to the slider.
    expect(container.textContent).toContain('40');
  });
});

// H4: only the header button toggles the zone now; the slider lives outside
// the press surface, so dragging it can't fire onToggle.
describe('volume slider drag does not toggle the parent card', () => {
  it('clicking inside the slider does not call onToggle', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onVolume = vi.fn();
    renderZG({ ...baseProps, activeZones: ['Upstairs'], onToggle, onVolume });
    const slider = screen.getByLabelText('Upstairs volume');
    // userEvent.click on the slider container fires pointerdown/up but is NOT
    // routed to the header button — the slider is a sibling element.
    await user.click(slider);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('clicking the header text still toggles', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderZG({ ...baseProps, activeZones: ['Upstairs'], onToggle });
    await user.click(screen.getByText('Upstairs'));
    expect(onToggle).toHaveBeenCalledWith('Upstairs');
  });
});
