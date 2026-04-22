// NowPlaying: title/artist render, play/pause icon swap, transport buttons fire
// onControl with the right action.

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeroUIProvider } from '@heroui/react';
import NowPlaying from '../../../web/src/components/NowPlaying.jsx';

function renderNP(props) {
  return render(
    <HeroUIProvider>
      <NowPlaying {...props} />
    </HeroUIProvider>,
  );
}

describe('NowPlaying', () => {
  it('shows the empty-state copy when nothing is playing', () => {
    renderNP({ nowPlaying: null, onControl: vi.fn() });
    expect(screen.getByText(/Nothing playing/i)).toBeInTheDocument();
  });

  it('renders the song title and artist when present', () => {
    renderNP({
      nowPlaying: { song: 'In Bloom', artist: 'Nirvana' },
      onControl: vi.fn(),
    });
    expect(screen.getByText('In Bloom')).toBeInTheDocument();
    expect(screen.getByText('Nirvana')).toBeInTheDocument();
  });

  it('exposes Play/Pause via aria-label depending on play state', () => {
    const { rerender } = renderNP({
      nowPlaying: { song: 'X', artist: 'Y', state: 'pause' },
      onControl: vi.fn(),
    });
    expect(screen.getByLabelText('Play')).toBeInTheDocument();
    rerender(
      <HeroUIProvider>
        <NowPlaying nowPlaying={{ song: 'X', artist: 'Y', state: 'play' }} onControl={vi.fn()} />
      </HeroUIProvider>,
    );
    expect(screen.getByLabelText('Pause')).toBeInTheDocument();
  });

  it('fires onControl(previous|play|next) for each transport button', async () => {
    const user = userEvent.setup();
    const onControl = vi.fn();
    renderNP({
      nowPlaying: { song: 'X', artist: 'Y', state: 'pause' },
      onControl,
    });
    await user.click(screen.getByLabelText('Previous'));
    await user.click(screen.getByLabelText('Play'));
    await user.click(screen.getByLabelText('Next'));
    expect(onControl.mock.calls.map((c) => c[0])).toEqual(['previous', 'play', 'next']);
  });

  it('toggles play→pause action when state is playing', async () => {
    const user = userEvent.setup();
    const onControl = vi.fn();
    renderNP({
      nowPlaying: { song: 'X', artist: 'Y', state: 'playing' },
      onControl,
    });
    await user.click(screen.getByLabelText('Pause'));
    expect(onControl).toHaveBeenCalledWith('pause');
  });

  it('renders the master volume slider when masterVolume is a number', () => {
    renderNP({
      nowPlaying: null,
      onControl: vi.fn(),
      masterVolume: 55,
      onMasterVolume: vi.fn(),
    });
    expect(screen.getByLabelText('Master volume')).toBeInTheDocument();
  });

  it('hides the master volume slider when masterVolume is null', () => {
    renderNP({ nowPlaying: null, onControl: vi.fn(), masterVolume: null });
    expect(screen.queryByLabelText('Master volume')).not.toBeInTheDocument();
  });
});
