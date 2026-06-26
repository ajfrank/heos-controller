// Grace-window cache around HEOS's player/get_players list. HEOS occasionally
// reports a player missing for a few seconds (Wi-Fi blip, mesh re-elect, a
// speaker briefly napping) and then it reappears unchanged. Without this
// cache, those transient dropouts immediately remove the speaker from its
// configured zone, which presents to the user as "only one of my speakers
// played." Smoothing dropouts < graceMs eliminates the flap; longer outages
// still drop and the UI's "Deck offline" warning takes over.
//
// Design:
//   - apply(rawPlayers) refreshes last-seen for everyone in the new list, then
//     returns rawPlayers + any previously-known players that have been seen
//     within graceMs (the "survivors"). Survivors get a one-shot prune timer
//     scheduled at exactly their grace expiry; if they reappear before then,
//     the timer is cancelled.
//   - onExpire(pid) fires when a survivor's grace runs out and they're truly
//     gone. The caller uses this to drop the player from state and re-resolve
//     zones (only path where the cache produces an asynchronous side effect).
//   - clock / setTimer / clearTimer are injectable for vitest fake timers.

export function createPlayerCache({
  graceMs = 30_000,
  onExpire,
  clock = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  // pid → most-recently-seen player object (we hold onto the last known shape
  // so a survivor keeps its name/model when surfaced as effective).
  const known = new Map();
  const lastSeen = new Map(); // pid → timestamp
  const pruneTimers = new Map(); // pid → timer handle

  function cancelTimer(pid) {
    const t = pruneTimers.get(pid);
    if (t) { clearTimer(t); pruneTimers.delete(pid); }
  }

  function forgetPid(pid) {
    cancelTimer(pid);
    lastSeen.delete(pid);
    known.delete(pid);
  }

  function apply(rawPlayers) {
    const now = clock();
    const rawByPid = new Map();
    for (const p of rawPlayers) rawByPid.set(String(p.pid), p);

    // Everyone in the new list is "live now" — refresh last-seen, cancel any
    // pending prune (they came back before the grace window expired).
    for (const [pid, p] of rawByPid) {
      known.set(pid, p);
      lastSeen.set(pid, now);
      cancelTimer(pid);
    }

    // Previously-known players not in the new list: either schedule a prune
    // (still within grace) or drop them immediately (grace already expired —
    // happens when apply is called sparsely, e.g. after a long quiet period).
    const survivors = [];
    for (const [pid, seen] of [...lastSeen.entries()]) {
      if (rawByPid.has(pid)) continue;
      const age = now - seen;
      if (age >= graceMs) {
        forgetPid(pid);
        continue;
      }
      survivors.push(known.get(pid));
      if (!pruneTimers.has(pid)) {
        const remaining = graceMs - age;
        pruneTimers.set(pid, setTimer(() => {
          forgetPid(pid);
          onExpire?.(pid);
        }, remaining));
      }
    }

    return [...rawPlayers, ...survivors];
  }

  // Test helper — drop all state and clear timers. Not exposed in production
  // wiring; tests use it to reset between cases without leaking a setTimeout
  // into the next test's fake-timer clock.
  function _reset() {
    for (const t of pruneTimers.values()) clearTimer(t);
    pruneTimers.clear();
    lastSeen.clear();
    known.clear();
  }

  return { apply, _reset };
}
