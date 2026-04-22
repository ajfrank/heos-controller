// Pure reducer for WS change events. Every change type, plus immutability.

import { describe, it, expect } from 'vitest';
import { applyChange } from '../../web/src/reducer.js';

const seed = () => ({
  players: [{ pid: '1', name: 'A' }],
  activePids: [],
  nowPlaying: {},
  volumes: { 1: 30 },
});

describe('applyChange', () => {
  it('replaces players on type=players', () => {
    const next = applyChange(seed(), { type: 'players', players: [{ pid: '2', name: 'B' }] });
    expect(next.players).toEqual([{ pid: '2', name: 'B' }]);
  });

  it('replaces activePids on type=active', () => {
    const next = applyChange(seed(), { type: 'active', activePids: ['1', '2'] });
    expect(next.activePids).toEqual(['1', '2']);
  });

  it('replaces zones on type=zones', () => {
    const next = applyChange(seed(), { type: 'zones', zones: [{ name: 'Upstairs', pids: ['1'] }] });
    expect(next.zones).toEqual([{ name: 'Upstairs', pids: ['1'] }]);
  });

  it('replaces activeZones on type=activeZones', () => {
    const next = applyChange(seed(), { type: 'activeZones', activeZones: ['Upstairs', 'Porch'] });
    expect(next.activeZones).toEqual(['Upstairs', 'Porch']);
  });

  it('replaces nowPlaying on type=nowPlaying', () => {
    const next = applyChange(seed(), { type: 'nowPlaying', nowPlaying: { 1: { song: 'X' } } });
    expect(next.nowPlaying).toEqual({ 1: { song: 'X' } });
  });

  it('merges volume on type=volume (preserves other pids)', () => {
    const cur = { ...seed(), volumes: { 1: 30, 2: 40 } };
    const next = applyChange(cur, { type: 'volume', pid: '1', level: 75 });
    expect(next.volumes).toEqual({ 1: 75, 2: 40 });
  });

  it('adds a new pid to volumes when not previously present', () => {
    const next = applyChange(seed(), { type: 'volume', pid: '99', level: 10 });
    expect(next.volumes).toEqual({ 1: 30, 99: 10 });
  });

  it('replaces recents on type=recents (F1 quick picks)', () => {
    const next = applyChange(seed(), { type: 'recents', recents: [{ uri: 'spotify:track:r' }] });
    expect(next.recents).toEqual([{ uri: 'spotify:track:r' }]);
  });

  it('returns the same reference for unknown change types', () => {
    const cur = seed();
    const next = applyChange(cur, { type: 'wat' });
    expect(next).toBe(cur);
  });

  it('does not mutate the input state', () => {
    const cur = seed();
    const snap = JSON.parse(JSON.stringify(cur));
    applyChange(cur, { type: 'volume', pid: '1', level: 99 });
    applyChange(cur, { type: 'players', players: [] });
    applyChange(cur, { type: 'active', activePids: ['x'] });
    expect(cur).toEqual(snap);
  });
});
