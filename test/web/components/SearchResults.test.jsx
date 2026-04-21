// SearchResults: debounced typing → api.search call, normalize render with badges,
// null-entry resilience, empty state, error path.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeroUIProvider } from '@heroui/react';

vi.mock('../../../web/src/api.js', () => ({
  api: {
    search: vi.fn(),
  },
}));

import SearchResults from '../../../web/src/components/SearchResults.jsx';
import { api } from '../../../web/src/api.js';

function renderSR(props = {}) {
  return render(
    <HeroUIProvider>
      <SearchResults onPlay={props.onPlay || vi.fn()} onError={props.onError || vi.fn()} />
    </HeroUIProvider>,
  );
}

beforeEach(() => {
  api.search.mockReset();
});

describe('SearchResults', () => {
  it('debounces typing and calls api.search exactly once for a single query', async () => {
    const user = userEvent.setup();
    api.search.mockResolvedValue({ results: { tracks: { items: [] } } });
    renderSR();
    await user.type(screen.getByPlaceholderText(/Search Spotify/i), 'chill');
    await waitFor(() => expect(api.search).toHaveBeenCalled(), { timeout: 1500 });
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith('chill', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('renders normalized results with the right badges', async () => {
    const user = userEvent.setup();
    api.search.mockResolvedValue({
      results: {
        tracks: { items: [{ name: 'Track One', artists: [{ name: 'Artist A' }], uri: 'spotify:track:1' }] },
        playlists: { items: [{ name: 'Playlist One', owner: { display_name: 'me' }, uri: 'spotify:playlist:1' }] },
        albums: { items: [{ name: 'Album One', artists: [{ name: 'Band' }], uri: 'spotify:album:1' }] },
      },
    });
    renderSR();
    await user.type(screen.getByPlaceholderText(/Search Spotify/i), 'q');
    await waitFor(() => expect(screen.getByText('Track One')).toBeInTheDocument(), { timeout: 1500 });
    expect(screen.getByText('Playlist One')).toBeInTheDocument();
    expect(screen.getByText('Album One')).toBeInTheDocument();
    expect(screen.getByText('Track')).toBeInTheDocument();
    expect(screen.getByText('Playlist')).toBeInTheDocument();
    expect(screen.getByText('Album')).toBeInTheDocument();
  });

  it('filters out null entries from tracks/playlists/albums without crashing', async () => {
    const user = userEvent.setup();
    api.search.mockResolvedValue({
      results: {
        tracks: { items: [null, { name: 'Real Track', artists: [null, { name: 'A' }], uri: 'u1' }] },
        playlists: { items: [null] },
        albums: { items: [null, { name: 'Real Album', artists: [null], uri: 'u2' }] },
      },
    });
    renderSR();
    await user.type(screen.getByPlaceholderText(/Search Spotify/i), 'q');
    await waitFor(() => expect(screen.getByText('Real Track')).toBeInTheDocument(), { timeout: 1500 });
    expect(screen.getByText('Real Album')).toBeInTheDocument();
  });

  it('shows the empty state when results are empty', async () => {
    const user = userEvent.setup();
    api.search.mockResolvedValue({ results: { tracks: { items: [] } } });
    renderSR();
    await user.type(screen.getByPlaceholderText(/Search Spotify/i), 'q');
    await waitFor(() => expect(screen.getByText(/No results/i)).toBeInTheDocument(), { timeout: 1500 });
  });

  it('clears results when the input is emptied', async () => {
    const user = userEvent.setup();
    api.search.mockResolvedValue({
      results: { tracks: { items: [{ name: 'X', artists: [], uri: 'u' }] } },
    });
    renderSR();
    const input = screen.getByPlaceholderText(/Search Spotify/i);
    await user.type(input, 'q');
    await waitFor(() => expect(screen.getByText('X')).toBeInTheDocument(), { timeout: 1500 });
    await user.clear(input);
    await waitFor(() => expect(screen.queryByText('X')).not.toBeInTheDocument(), { timeout: 1500 });
  });

  it('calls onError when the search rejects', async () => {
    const user = userEvent.setup();
    api.search.mockRejectedValue(new Error('network down'));
    const onError = vi.fn();
    renderSR({ onError });
    await user.type(screen.getByPlaceholderText(/Search Spotify/i), 'q');
    await waitFor(() => expect(onError).toHaveBeenCalledWith('network down'), { timeout: 1500 });
  });

  it('fires onPlay with the spotify uri when a result is pressed', async () => {
    const user = userEvent.setup();
    api.search.mockResolvedValue({
      results: { tracks: { items: [{ name: 'Press Me', artists: [], uri: 'spotify:track:zzz' }] } },
    });
    const onPlay = vi.fn();
    renderSR({ onPlay });
    await user.type(screen.getByPlaceholderText(/Search Spotify/i), 'q');
    await waitFor(() => expect(screen.getByText('Press Me')).toBeInTheDocument(), { timeout: 1500 });
    await user.click(screen.getByText('Press Me'));
    // Quick Picks (F1) needs full display metadata routed through onPlay so the
    // server's recents tile has art/label/sublabel.
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({
      uri: 'spotify:track:zzz',
      label: 'Press Me',
      badge: 'Track',
    }));
  });

  // M8: a stale response from a prior keystroke must not overwrite the current
  // results. The component aborts the in-flight controller before issuing the
  // next request.
  it('passes an AbortSignal to api.search for cancellation', async () => {
    const user = userEvent.setup();
    api.search.mockResolvedValue({ results: { tracks: { items: [] } } });
    renderSR();
    await user.type(screen.getByPlaceholderText(/Search Spotify/i), 'a');
    await waitFor(() => expect(api.search).toHaveBeenCalled(), { timeout: 1500 });
    const opts = api.search.mock.calls.at(-1)[1];
    expect(opts).toBeTruthy();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  // F8: the mic button only appears when SpeechRecognition is available; on
  // browsers without it (Firefox, jsdom by default) it must hide cleanly so
  // the wife never taps a dead control.
  it('hides the mic button when SpeechRecognition is unavailable', () => {
    renderSR();
    expect(screen.queryByLabelText(/voice search/i)).toBeNull();
  });

  // F8: when the API is available, tapping the mic starts a recognition and
  // a recognized result lands in the search input — same code path as typing.
  it('mic transcribes voice into the search input when SpeechRecognition exists', async () => {
    const user = userEvent.setup();
    const instances = [];
    class FakeSR {
      constructor() {
        this.lang = ''; this.interimResults = false; this.maxAlternatives = 1; this.continuous = false;
        this.start = vi.fn(); this.stop = vi.fn();
        instances.push(this);
      }
    }
    vi.stubGlobal('webkitSpeechRecognition', FakeSR);
    api.search.mockResolvedValue({ results: { tracks: { items: [] } } });
    try {
      renderSR();
      const input = screen.getByPlaceholderText(/Search Spotify/i);
      await user.click(screen.getByLabelText(/voice search/i));
      expect(instances).toHaveLength(1);
      const rec = instances[0];
      expect(rec.start).toHaveBeenCalled();
      // Simulate the browser firing a final transcript, then end-of-speech.
      rec.onresult({ results: [[{ transcript: 'florence' }]] });
      rec.onend();
      await waitFor(() => expect(input.value).toBe('florence'));
      await waitFor(() => expect(api.search).toHaveBeenCalledWith('florence', expect.any(Object)), { timeout: 1500 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // M9: the list reuses its DOM across keystrokes — the wrapping motion.ul
  // shouldn't be replaced just because the query changed.
  it('reuses the same <ul> element across queries (no key={q})', async () => {
    const user = userEvent.setup();
    api.search.mockResolvedValue({
      results: { tracks: { items: [{ name: 'R1', artists: [], uri: 'u1' }] } },
    });
    renderSR();
    const input = screen.getByPlaceholderText(/Search Spotify/i);
    await user.type(input, 'a');
    await waitFor(() => expect(screen.getByText('R1')).toBeInTheDocument(), { timeout: 1500 });
    const ul1 = screen.getByRole('list');
    api.search.mockResolvedValue({
      results: { tracks: { items: [{ name: 'R2', artists: [], uri: 'u2' }] } },
    });
    await user.type(input, 'b');
    await waitFor(() => expect(screen.getByText('R2')).toBeInTheDocument(), { timeout: 1500 });
    const ul2 = screen.getByRole('list');
    expect(ul2).toBe(ul1);
  });
});
