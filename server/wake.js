// Match a Spotify Connect device to one of our active HEOS pids by name.
// Pulled out so /api/play can stay readable; kept here (rather than inlined)
// because the same logic could be reused if we add a wake-and-poll path later.
export function findMatchingDevice(devices, pids, players) {
  const seenByName = new Map(
    devices.map((d) => [d.name.trim().toLowerCase(), d]),
  );
  for (const pid of pids) {
    const player = players.find((p) => p.pid === pid);
    if (!player) continue;
    const key = player.name.trim().toLowerCase();
    const exact = seenByName.get(key);
    const fuzzy = exact || devices.find((d) => (d.name || '').trim().toLowerCase().includes(key));
    if (fuzzy) return { device: fuzzy, leaderPid: pid };
  }
  return null;
}
