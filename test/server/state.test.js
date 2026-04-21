import { describe, it, expect, vi } from 'vitest';
import { State } from '../../server/state.js';

describe('State', () => {
  it('starts with empty defaults and a Spotify source', () => {
    const s = new State();
    expect(s.snapshot()).toEqual({
      players: [],
      activePids: [],
      source: 'spotify',
      nowPlaying: null,
      nowPlayingByPid: {},
      volumes: {},
      recents: [],
    });
  });

  it('setPlayers replaces the player list and emits a "players" change', () => {
    const s = new State();
    const onChange = vi.fn();
    s.on('change', onChange);
    const players = [{ pid: '1', name: 'Kitchen' }];
    s.setPlayers(players);
    expect(s.players).toBe(players);
    expect(onChange).toHaveBeenCalledWith({ type: 'players', players });
  });

  it('setActive stores activePids and emits an "active" change', () => {
    const s = new State();
    const onChange = vi.fn();
    s.on('change', onChange);
    s.setActive(['1', '2']);
    expect(s.activePids).toEqual(['1', '2']);
    expect(onChange).toHaveBeenCalledWith({ type: 'active', activePids: ['1', '2'] });
  });

  // Regression: setActive must coerce numeric pids to strings so the leader
  // comparison in setNowPlaying (`activePids[0] === String(pid)`) keeps working
  // when the REST request body parses pids as numbers.
  it('setActive stringifies numeric pids and the leader broadcast still fires', () => {
    const s = new State();
    s.setActive([1, 2]);
    expect(s.activePids).toEqual(['1', '2']);
    const onChange = vi.fn();
    s.on('change', onChange);
    s.setNowPlaying('1', { song: 'Foo' });
    const types = onChange.mock.calls.map((c) => c[0].type);
    expect(types).toContain('nowPlaying');
  });

  it('setVolume records per-pid volume and emits per change', () => {
    const s = new State();
    const onChange = vi.fn();
    s.on('change', onChange);
    s.setVolume('1', 30);
    s.setVolume('2', 60);
    expect(s.volumes).toEqual({ 1: 30, 2: 60 });
    expect(onChange).toHaveBeenNthCalledWith(1, { type: 'volume', pid: '1', level: 30 });
    expect(onChange).toHaveBeenNthCalledWith(2, { type: 'volume', pid: '2', level: 60 });
  });

  // F5: setNowPlaying writes to a per-pid map; the legacy `nowPlaying` is
  // derived from the active group leader. The change event is per-pid so
  // ungrouped zones can render their own subtitles.
  it('setNowPlaying writes to nowPlayingByPid and emits a per-pid change', () => {
    const s = new State();
    const onChange = vi.fn();
    s.on('change', onChange);
    s.setNowPlaying('1', { song: 'Foo', artist: 'Bar' });
    expect(s.nowPlayingByPid['1']).toEqual({ song: 'Foo', artist: 'Bar' });
    expect(onChange).toHaveBeenCalledWith({
      type: 'nowPlayingByPid',
      pid: '1',
      nowPlaying: { song: 'Foo', artist: 'Bar' },
    });
  });

  it('derived nowPlaying reflects the active group leader', () => {
    const s = new State();
    s.setActive(['1', '2']);
    s.setNowPlaying('1', { song: 'Lead' });
    s.setNowPlaying('2', { song: 'Member' });
    expect(s.nowPlaying).toEqual({ pid: '1', song: 'Lead' });
    s.setActive(['2']);
    expect(s.nowPlaying).toEqual({ pid: '2', song: 'Member' });
  });

  it('setNowPlaying for the active leader also broadcasts the derived nowPlaying', () => {
    const s = new State();
    s.setActive(['1']);
    const onChange = vi.fn();
    s.on('change', onChange);
    s.setNowPlaying('1', { song: 'Foo' });
    const types = onChange.mock.calls.map((c) => c[0].type);
    expect(types).toContain('nowPlayingByPid');
    expect(types).toContain('nowPlaying');
  });

  it('setNowPlaying for a non-leader does NOT broadcast the legacy nowPlaying', () => {
    const s = new State();
    s.setActive(['1']);
    const onChange = vi.fn();
    s.on('change', onChange);
    s.setNowPlaying('2', { song: 'Other zone' });
    const types = onChange.mock.calls.map((c) => c[0].type);
    expect(types).toContain('nowPlayingByPid');
    expect(types).not.toContain('nowPlaying');
  });

  it('setNowPlaying with null clears the per-pid entry', () => {
    const s = new State();
    s.setActive(['1']);
    s.setNowPlaying('1', { song: 'Foo' });
    s.setNowPlaying('1', null);
    expect(s.nowPlayingByPid['1']).toBeUndefined();
    expect(s.nowPlaying).toBeNull();
  });

  it('setSource updates the source and emits', () => {
    const s = new State();
    const onChange = vi.fn();
    s.on('change', onChange);
    s.setSource('apple');
    expect(s.source).toBe('apple');
    expect(onChange).toHaveBeenCalledWith({ type: 'source', source: 'apple' });
  });

  it('snapshot reflects all mutations', () => {
    const s = new State();
    s.setPlayers([{ pid: '1', name: 'K' }]);
    s.setActive(['1']);
    s.setVolume('1', 80);
    s.setNowPlaying('1', { song: 'Hello' });
    expect(s.snapshot()).toEqual({
      players: [{ pid: '1', name: 'K' }],
      activePids: ['1'],
      source: 'spotify',
      nowPlaying: { pid: '1', song: 'Hello' },
      nowPlayingByPid: { 1: { song: 'Hello' } },
      volumes: { 1: 80 },
      recents: [],
    });
  });

  // M1: setters skip emit when the value hasn't changed — repeated identical
  // events from HEOS shouldn't wake every WS client.
  describe('setter dedupe (no-op when value unchanged)', () => {
    it('setVolume does not emit when called with the same level', () => {
      const s = new State();
      const onChange = vi.fn();
      s.on('change', onChange);
      s.setVolume('1', 30);
      s.setVolume('1', 30);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('setActive does not emit when the same pid array is passed', () => {
      const s = new State();
      const onChange = vi.fn();
      s.on('change', onChange);
      s.setActive(['1', '2']);
      s.setActive(['1', '2']);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('setPlayers does not emit when player list is structurally identical', () => {
      const s = new State();
      const onChange = vi.fn();
      s.on('change', onChange);
      s.setPlayers([{ pid: '1', name: 'K' }]);
      s.setPlayers([{ pid: '1', name: 'K' }]);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('setNowPlaying does not emit when the rendered fields are unchanged', () => {
      const s = new State();
      const onChange = vi.fn();
      s.on('change', onChange);
      s.setNowPlaying('1', { song: 'A', artist: 'B', state: 'play' });
      s.setNowPlaying('1', { song: 'A', artist: 'B', state: 'play' });
      // Single per-pid emit; pid '1' isn't the active leader so no derived
      // 'nowPlaying' emit either.
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('setSource does not emit when source is unchanged', () => {
      const s = new State();
      const onChange = vi.fn();
      s.on('change', onChange);
      s.setSource('spotify'); // same as default
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
