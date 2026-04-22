// Real-shape HEOS CLI response frames. Each frame is the JSON line as it would
// arrive on the wire (terminated by \r\n). These match what real Denon firmware
// returns; do not reformat them.

export const FRAME = {
  registerEvents: '{"heos":{"command":"system/register_for_change_events","result":"success","message":"enable=on"}}\r\n',

  getPlayers: JSON.stringify({
    heos: { command: 'player/get_players', result: 'success', message: '' },
    payload: [
      { name: 'Kitchen', pid: 1111, model: 'HEOS 1', version: '1.520.200', ip: '10.0.0.10', network: 'wifi', lineout: 1 },
      { name: 'Living Room', pid: 2222, model: 'HEOS 5', version: '1.520.200', ip: '10.0.0.11', network: 'wired', lineout: 1 },
      { name: 'Bar', pid: 3333, model: 'HEOS Drive', version: '1.520.200', ip: '10.0.0.12', network: 'wired', lineout: 1 },
    ],
  }) + '\r\n',

  getGroups_empty: JSON.stringify({
    heos: { command: 'group/get_groups', result: 'success', message: '' },
    payload: [],
  }) + '\r\n',

  getGroups_kitchenLR: JSON.stringify({
    heos: { command: 'group/get_groups', result: 'success', message: '' },
    payload: [
      { name: 'Kitchen + Living Room', gid: 1111, players: [
        { name: 'Kitchen', pid: 1111, role: 'leader' },
        { name: 'Living Room', pid: 2222, role: 'member' },
      ] },
    ],
  }) + '\r\n',

  setGroup_success: JSON.stringify({
    heos: { command: 'group/set_group', result: 'success', message: 'gid=1111&name=Kitchen + Living Room&pid=1111,2222' },
  }) + '\r\n',

  setGroup_syserrno9: JSON.stringify({
    heos: { command: 'group/set_group', result: 'fail', message: 'eid=12&text=System error&syserrno=-9' },
  }) + '\r\n',

  setGroup_eid13: JSON.stringify({
    heos: { command: 'group/set_group', result: 'fail', message: 'eid=13&text=Processing previous command' },
  }) + '\r\n',

  getVolume_42: JSON.stringify({
    heos: { command: 'player/get_volume', result: 'success', message: 'pid=1111&level=42' },
  }) + '\r\n',

  setVolume_success: JSON.stringify({
    heos: { command: 'player/set_volume', result: 'success', message: 'pid=1111&level=55' },
  }) + '\r\n',

  getNowPlaying: JSON.stringify({
    heos: { command: 'player/get_now_playing_media', result: 'success', message: 'pid=1111' },
    payload: {
      type: 'song',
      song: 'In Bloom',
      album: 'Nevermind',
      artist: 'Nirvana',
      image_url: 'https://i.scdn.co/image/abc',
      mid: 'spotify:track:abc',
      qid: 1,
      sid: 1,
    },
  }) + '\r\n',

  getNowPlaying_null: JSON.stringify({
    heos: { command: 'player/get_now_playing_media', result: 'success', message: 'pid=1111' },
  }) + '\r\n',

  getPlayState_play: JSON.stringify({
    heos: { command: 'player/get_play_state', result: 'success', message: 'pid=1111&state=play' },
  }) + '\r\n',

  setPlayState_success: JSON.stringify({
    heos: { command: 'player/set_play_state', result: 'success', message: 'pid=1111&state=pause' },
  }) + '\r\n',

  playNext_success: JSON.stringify({
    heos: { command: 'player/play_next', result: 'success', message: 'pid=1111' },
  }) + '\r\n',

  playPrevious_success: JSON.stringify({
    heos: { command: 'player/play_previous', result: 'success', message: 'pid=1111' },
  }) + '\r\n',

  // Unsolicited events (no pending command to match).
  event_volume: '{"heos":{"command":"event/player_volume_changed","message":"pid=1111&level=63&mute=off"}}\r\n',
  event_nowPlaying: '{"heos":{"command":"event/player_now_playing_changed","message":"pid=1111"}}\r\n',
  event_state: '{"heos":{"command":"event/player_state_changed","message":"pid=1111&state=pause"}}\r\n',
  event_playersChanged: '{"heos":{"command":"event/players_changed","message":""}}\r\n',
};

// Helper: explode a multi-frame string into individual byte-buffers, useful
// when you want to test partial-read buffering (split a frame mid-byte).
export function chunks(str, sizes) {
  const buf = Buffer.from(str, 'utf8');
  const out = [];
  let i = 0;
  for (const size of sizes) {
    out.push(buf.subarray(i, i + size));
    i += size;
  }
  if (i < buf.length) out.push(buf.subarray(i));
  return out;
}
