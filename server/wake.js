// Match a Spotify Connect device to one of our active HEOS pids by name.
// Pulled out so /api/play can stay readable; kept here (rather than inlined)
// because the same logic could be reused if we add a wake-and-poll path later.
export function findMatchingDevice(devices, pids, players) {
  // Spotify occasionally returns Connect devices with null/empty names
  // (browser Web Player, transient SDK clients). The empty-string entry
  // would otherwise shadow a legitimate empty player name and turn into a
  // crash on `.trim()` of null.
  const seenByName = new Map(
    devices
      .map((d) => [(d.name || '').trim().toLowerCase(), d])
      .filter(([k]) => k),
  );
  for (const pid of pids) {
    const player = players.find((p) => p.pid === pid);
    if (!player) continue;
    const key = (player.name || '').trim().toLowerCase();
    if (!key) continue;
    const exact = seenByName.get(key);
    const fuzzy = exact || devices.find((d) => (d.name || '').trim().toLowerCase().includes(key));
    if (fuzzy) return { device: fuzzy, leaderPid: pid };
  }
  return null;
}
