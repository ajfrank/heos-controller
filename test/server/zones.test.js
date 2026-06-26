// Zones config loader: must keep the controller bootable when zones.json is
// missing or malformed (rare SD-card / aborted-edit scenario on the Pi).
// Without the fallback, scheduleHeosInit retries forever in journalctl with
// no actionable error.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { resolveZones, _resetZonesCache } from '../../server/zones.js';

describe('zones loader', () => {
  let warnSpy;
  beforeEach(() => {
    _resetZonesCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    _resetZonesCache();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('falls back to no zones when zones.json is malformed JSON', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce('{ this is not json');
    const out = resolveZones([{ pid: '1', name: 'Kitchen' }], { warn: () => {} });
    expect(out).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/zones\.json unreadable/);
  });

  it('falls back to no zones when zones.json is missing the zones array', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce('{"unrelated":true}');
    const out = resolveZones([{ pid: '1', name: 'Kitchen' }], { warn: () => {} });
    expect(out).toEqual([]);
  });

  it('falls back to no zones when zones.json is missing on disk', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      const e = new Error('ENOENT: no such file');
      e.code = 'ENOENT';
      throw e;
    });
    const out = resolveZones([{ pid: '1', name: 'Kitchen' }], { warn: () => {} });
    expect(out).toEqual([]);
  });

  // Each zone reports the names of its configured-but-not-resolved speakers
  // so the UI can show "Deck offline" instead of silently shrinking a 2-speaker
  // zone to 1. Tracks the Pi log we saw at Jun 26 17:32:02 — Deck dropped from
  // HEOS's player list, Porch silently became a 1-speaker zone, user thought
  // the app was broken.
  it('returns missing[] for configured speakers not present in HEOS', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(JSON.stringify({
      zones: [{ name: 'Porch', speakers: ['Outdoor', 'Deck'] }],
    }));
    const out = resolveZones([{ pid: '10', name: 'Outdoor' }], { warn: () => {} });
    expect(out).toEqual([{ name: 'Porch', pids: ['10'], missing: ['Deck'] }]);
  });

  it('returns empty missing[] when all configured speakers resolve', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(JSON.stringify({
      zones: [{ name: 'Porch', speakers: ['Outdoor', 'Deck'] }],
    }));
    const out = resolveZones(
      [{ pid: '10', name: 'Outdoor' }, { pid: '11', name: 'Deck' }],
      { warn: () => {} },
    );
    expect(out).toEqual([{ name: 'Porch', pids: ['10', '11'], missing: [] }]);
  });

  it('omits a zone entirely when every configured speaker is missing', () => {
    // Distinct from "1 of 2 missing": when there's no resolvable pid there's
    // no possible audio path, so the zone disappears from the UI rather than
    // showing as a dead tile. The warning log still fires.
    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(JSON.stringify({
      zones: [{ name: 'Porch', speakers: ['Outdoor', 'Deck'] }],
    }));
    const out = resolveZones([{ pid: '99', name: 'Kitchen' }], { warn: () => {} });
    expect(out).toEqual([]);
  });
});
