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
});
