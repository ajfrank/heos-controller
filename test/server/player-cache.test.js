// Grace-window cache that smooths transient HEOS player dropouts. Covers the
// real Pi incident at Jun 26 17:32:02 where Deck briefly fell off HEOS's
// player/get_players list and Porch silently shrank to a 1-speaker zone
// mid-song. The cache keeps a vanished player visible for graceMs before
// truly dropping it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPlayerCache } from '../../server/player-cache.js';

const A = { pid: '1', name: 'Outdoor' };
const B = { pid: '2', name: 'Deck' };
const C = { pid: '3', name: 'Kitchen' };

describe('createPlayerCache', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('first apply returns rawPlayers unchanged (no prior state to merge)', () => {
    const cache = createPlayerCache({ graceMs: 30_000 });
    expect(cache.apply([A, B])).toEqual([A, B]);
  });

  it('keeps a vanished player visible while within grace, then drops + fires onExpire', () => {
    const onExpire = vi.fn();
    const cache = createPlayerCache({ graceMs: 30_000, onExpire });
    cache.apply([A, B]);

    // B disappears 10s later — still within grace, must remain visible.
    vi.advanceTimersByTime(10_000);
    expect(cache.apply([A])).toEqual([A, B]);
    expect(onExpire).not.toHaveBeenCalled();

    // 20s further (30s total since B was last seen) — grace expires, prune
    // fires asynchronously via setTimeout, onExpire is called with B's pid.
    vi.advanceTimersByTime(20_000);
    expect(onExpire).toHaveBeenCalledWith('2');
    expect(onExpire).toHaveBeenCalledTimes(1);

    // Next apply no longer surfaces B (it was forgotten on prune).
    expect(cache.apply([A])).toEqual([A]);
  });

  it('cancels the pending prune when the vanished player returns before grace expires', () => {
    const onExpire = vi.fn();
    const cache = createPlayerCache({ graceMs: 30_000, onExpire });
    cache.apply([A, B]);

    // B drops at t=10s, schedules a prune at t=40s.
    vi.advanceTimersByTime(10_000);
    cache.apply([A]);

    // B returns at t=20s, cancels the prune.
    vi.advanceTimersByTime(10_000);
    cache.apply([A, B]);

    // Advance past where the prune WOULD have fired (t=40s+).
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('drops a long-gone player immediately on the next apply (no spurious onExpire)', () => {
    // When apply is called sparsely (e.g. a quiet hour between HEOS events),
    // a player whose grace already expired must be dropped on the next apply
    // without firing onExpire — there's no timer pending to fire it, and
    // emitting a duplicate event would re-trigger an unnecessary zone resolve.
    const onExpire = vi.fn();
    const cache = createPlayerCache({ graceMs: 30_000, onExpire });
    cache.apply([A, B]);

    // Skip way past grace WITHOUT a re-apply in between — no timer fires yet
    // because none was scheduled (apply only schedules on a dropout).
    vi.advanceTimersByTime(120_000);
    expect(onExpire).not.toHaveBeenCalled();

    // Now apply without B. B has been gone for 120s — well past 30s grace.
    // Cache should silently drop it; onExpire stays unfired.
    expect(cache.apply([A])).toEqual([A]);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('preserves the most recent shape of a player when surfacing as a survivor', () => {
    // A renamed-in-HEOS speaker that briefly drops should resurface with its
    // last known name/model, not a stale shape. Important so the rest of the
    // app (e.g. resolveZones's name match) sees a consistent identity.
    const cache = createPlayerCache({ graceMs: 30_000 });
    cache.apply([A, B]);
    const updatedB = { ...B, name: 'Deck (Patio)' };
    cache.apply([A, updatedB]); // B's shape updated

    cache.apply([A]); // B vanishes
    const next = cache.apply([A]);
    expect(next).toContainEqual(updatedB);
  });

  it('multiple concurrent dropouts each get their own independent prune timer', () => {
    const onExpire = vi.fn();
    const cache = createPlayerCache({ graceMs: 30_000, onExpire });
    cache.apply([A, B, C]);

    // B and C drop at the same moment.
    cache.apply([A]);

    // C reappears at t=15s, cancelling its own prune. B's prune is unaffected.
    vi.advanceTimersByTime(15_000);
    cache.apply([A, C]);

    // At t=30s total, B's grace expires and only B's prune fires.
    vi.advanceTimersByTime(15_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledWith('2');
  });
});
