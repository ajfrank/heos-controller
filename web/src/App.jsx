import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, CardBody } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { api, connectWS, setupWakeLock, SPOTIFY_REAUTH_EVENT } from './api.js';
import { applyChange } from './reducer.js';
import NowPlaying from './components/NowPlaying.jsx';
import ZoneGrid from './components/ZoneGrid.jsx';
import SearchResults from './components/SearchResults.jsx';
import Backdrop from './components/Backdrop.jsx';
import Banner from './components/Banner.jsx';
import QuickPicks from './components/QuickPicks.jsx';

const SOURCE_KEY = 'heos.source';
if (localStorage.getItem(SOURCE_KEY)) localStorage.removeItem(SOURCE_KEY);

const sectionCardClasses = {
  base: 'bg-content1/70 backdrop-blur-xl border border-white/10',
  body: 'p-4',
};

export default function App() {
  const [snap, setSnap] = useState({
    zones: [],
    activeZones: [],
    activePids: [],
    nowPlaying: null,
    nowPlayingByPid: {},
    volumes: {},
    spotifyConnected: false,
    recents: [],
    frequent: [],
  });
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const [banner, setBanner] = useState(null);
  // Flip true on the first WS snapshot. Stays true for the session, even
  // through transient reconnects, so we don't flicker "Connecting…" every
  // time the iPad's WiFi blips.
  const [wsReady, setWsReady] = useState(false);
  // Sticky flag set when the server replies code:'reauth' to ANY request.
  // The default banner copy says "isn't connected yet"; this flips it to
  // "needs to reconnect" — same Connect button, different framing.
  const [reauthNeeded, setReauthNeeded] = useState(false);

  function showToast(text, kind = 'info') {
    setToast({ text, kind, id: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  function showBanner(text, title) {
    setBanner({ text, title, id: Date.now() });
  }

  useEffect(() => {
    setupWakeLock();
    // The WS handshake's first frame is a full snapshot, so the initial REST
    // hydrate was redundant — and racing it created a flicker when the two
    // payloads disagreed during a fast reconnect.
    const conn = connectWS((msg) => {
      if (msg.type === 'snapshot') {
        // Server's state.snapshot() is the authoritative full picture. Top-level
        // spread overwrites every key (players, zones, nowPlayingByPid, volumes…),
        // so a reconnect snapshot — or a server-pushed resync after a play
        // rollback failed — fully replaces the optimistic in-flight state.
        setSnap((cur) => ({ ...cur, ...msg.state }));
        setWsReady(true);
      } else if (msg.type === 'change') {
        setSnap((cur) => applyChange(cur, msg.change));
      }
    });
    return () => conn.close();
  }, []);

  useEffect(() => {
    const onReauth = () => setReauthNeeded(true);
    window.addEventListener(SPOTIFY_REAUTH_EVENT, onReauth);
    return () => window.removeEventListener(SPOTIFY_REAUTH_EVENT, onReauth);
  }, []);

  async function setActiveZones(zones) {
    // Capture prior selection so we can roll back the optimistic toggle when
    // HEOS rejects the regroup. Without rollback the checkmark stays on a
    // zone the server never accepted.
    const prior = snap.activeZones;
    setSnap((cur) => ({ ...cur, activeZones: zones }));
    try {
      await api.setActive(zones);
    } catch (e) {
      setSnap((cur) => ({ ...cur, activeZones: prior }));
      showBanner(e.message, "Couldn't update zones");
    }
  }

  // Single-flight guard. A double-tap on a Quick Pick would otherwise fire
  // two /api/play calls; their applyGroup + transferPlayback + play chains
  // interleave on Spotify and bounce zones around. The "Waking…" toast is
  // already visible feedback that the first tap registered, so the dropped
  // re-tap is silent.
  const playInflight = useRef(false);
  // Optimistic now-playing overlay so the bottom card flips to the picked
  // item the instant the tap registers, instead of waiting up to ~5s for the
  // next Spotify /me/player poll. Cleared by the effect below once Spotify
  // catches up (or 10s safety timeout).
  const [pickedOptimistic, setPickedOptimistic] = useState(null);
  // Token bumped after every successful /api/play so usePlaybackProgress
  // re-fetches immediately instead of finishing its current 5s sleep.
  const [playBumpToken, setPlayBumpToken] = useState(0);
  // Auto-recovery for the "Spotify session got stolen" case. After a
  // successful /api/play, capture the device id we transferred to and the
  // wall-time the play landed; the playback poll effect compares this to the
  // device Spotify reports as active. If a foreign device (Echo Dot, phone,
  // laptop) has hijacked the session within ~10s of our play, we pause the
  // session and toast — without forcing the wife to dig out the official
  // Spotify app to figure out what happened.
  const expectedDevice = useRef(null); // { id, name, deadline }
  async function play(itemBody) {
    if (playInflight.current) return;
    if (!snap.activeZones.length) {
      showToast('Select at least one zone first', 'error'); return;
    }
    playInflight.current = true;
    if (itemBody?.label) {
      setPickedOptimistic({
        song: itemBody.label,
        artist: itemBody.sublabel || '',
        image_url: itemBody.art || '',
        // Watermark: clear the overlay once Spotify reports a track different
        // from whatever was playing at pick time. Using the previous song name
        // (rather than a wallclock timer alone) means we hold the overlay
        // exactly as long as Spotify is still showing the stale track.
        prevSpotifySong: latestPlaybackSongRef.current,
      });
    }
    // Auto-wake on the server can take 2-8s when speakers were idle. Show a
    // quiet "Waking…" hint after ~700ms so the wife isn't staring at silence
    // wondering if her tap registered. Cancelled the moment play resolves.
    const wakeHint = setTimeout(() => showToast('Waking speakers…'), 700);
    try {
      const r = await api.play(itemBody);
      clearTimeout(wakeHint);
      showToast('Playing');
      if (r?.device_id) {
        expectedDevice.current = {
          id: r.device_id,
          name: r.device || '',
          deadline: Date.now() + 10_000,
        };
      }
      setPlayBumpToken((x) => x + 1);
    } catch (e) {
      clearTimeout(wakeHint);
      setPickedOptimistic(null); // play failed — drop the overlay
      showToast(e.message, 'error');
    } finally {
      playInflight.current = false;
    }
  }

  // Optimistic playback override for the time bar. The Spotify poll is on a 5s
  // cadence, so without this the bar waits up to 5s after a play/pause tap
  // before it starts/stops ticking — visibly long after the audio reacts.
  // Pause case: freeze progress_ms at the currently-displayed effective time
  // (raw sample's progress + elapsed since sampledAt) so the bar stops where
  // it shows instead of snapping back to the last sample's position. Play
  // case: stamp sampledAt=now so the interpolator ticks forward from the
  // current displayed position. The override is reconciled (cleared) when
  // the next authoritative poll's is_playing matches, or after a 4s safety.
  const [playStateOverride, setPlayStateOverride] = useState(null);
  // Capture latest raw playback in a ref so control() can read it without
  // depending on closure freshness (taps can land between renders).
  const latestPlaybackRef = useRef(null);

  async function control(action) {
    const pb = latestPlaybackRef.current;
    if (action === 'play' || action === 'pause') {
      const next = action === 'play';
      const elapsed = pb?.is_playing ? Date.now() - (pb.sampledAt || Date.now()) : 0;
      const currentMs = Math.max(0, Math.min(pb?.duration_ms || 0, (pb?.progress_ms || 0) + elapsed));
      setPlayStateOverride({ kind: 'pp', is_playing: next, progress_ms: currentMs, sampledAt: Date.now() });
    } else if (action === 'next' || action === 'previous') {
      // Reset the visible bar to 0 so it reads as "new track playing from
      // start" instead of marching forward on the old track's position. Tag
      // with the song-at-tap-time so reconcile can tell when Spotify reports
      // the actual new track (vs. catching the OLD track on a fast immediate
      // poll, which would otherwise un-stick the override prematurely).
      setPlayStateOverride({
        kind: 'skip',
        is_playing: pb?.is_playing ?? true,
        progress_ms: 0,
        sampledAt: Date.now(),
        prevSong: latestPlaybackSongRef.current,
      });
      // For next: we already know what's coming up from the prefetched queue,
      // so flip the title/art instantly. The same pickedOptimistic mechanism
      // used by /api/play will clear once Spotify reports the new song
      // (or matches it). Previous doesn't have a prefetched analogue, so
      // it just rides the burst-poll path with the bar already at 0.
      if (action === 'next') {
        const first = upNextRef.current[0];
        if (first?.song) {
          setPickedOptimistic({
            song: first.song,
            artist: first.artist || '',
            image_url: first.image_url || '',
            prevSpotifySong: latestPlaybackSongRef.current,
          });
        }
      }
    }
    try {
      await api.control(action);
      if (action === 'play' || action === 'pause') {
        // ~500ms (network + Spotify API) for the override to resolve.
        setPlayBumpToken((x) => x + 1);
      } else if (action === 'next' || action === 'previous') {
        // HEOS → speaker's Spotify Connect daemon → Spotify takes ~500-1500ms
        // to propagate a skip. An immediate poll alone often catches the OLD
        // track. Burst three: now (fast cases), 1.2s (typical), 2.5s (slow
        // path safety net before falling back to the natural 5s cadence).
        setPlayBumpToken((x) => x + 1);
        setTimeout(() => setPlayBumpToken((x) => x + 1), 1200);
        setTimeout(() => setPlayBumpToken((x) => x + 1), 2500);
      }
    } catch (e) {
      // On failure, drop any optimistic override so the next poll shows truth.
      setPlayStateOverride(null);
      showToast(e.message, 'error');
    }
  }

  async function setZoneVolume(zoneName, level) {
    // Optimistic per-pid rollback: snapshot the prior levels for every speaker
    // in the zone so a failed setVolume doesn't strand the slider at the
    // optimistic value until a WS volume_changed event happens to drift it back.
    const zone = snap.zones.find((z) => z.name === zoneName);
    if (!zone) return;
    const prior = {};
    for (const pid of zone.pids) prior[pid] = snap.volumes[pid];
    setSnap((cur) => {
      const next = { ...cur.volumes };
      for (const pid of zone.pids) next[pid] = level;
      return { ...cur, volumes: next };
    });
    try { await api.setVolume(zoneName, level); }
    catch (e) {
      setSnap((cur) => {
        const next = { ...cur.volumes };
        for (const pid of zone.pids) next[pid] = prior[pid];
        return { ...cur, volumes: next };
      });
      showToast(e.message, 'error');
    }
  }

  // Per-zone slider debounce: same justification as the master volume above.
  // ZoneGrid's onChange fires ~30/s and the server fans each call out to every
  // pid in the zone, so a 4-speaker zone drag was 120 HEOS commands/s without
  // this. The optimistic state still moves immediately on every tick (so the
  // slider thumb tracks the finger); only the network call coalesces.
  // onChangeEnd from HeroUI Slider flushes the trailing edge on finger-up.
  const zonePending = useRef(new Map());      // name → latest level
  const zoneFanoutTimers = useRef(new Map()); // name → timeout id
  const ZONE_DEBOUNCE_MS = 80;
  function flushZoneFanout(zoneName) {
    const t = zoneFanoutTimers.current.get(zoneName);
    if (t) {
      clearTimeout(t);
      zoneFanoutTimers.current.delete(zoneName);
    }
    if (!zonePending.current.has(zoneName)) return;
    const level = zonePending.current.get(zoneName);
    zonePending.current.delete(zoneName);
    setZoneVolume(zoneName, level);
  }
  function setZoneVolumeDebounced(zoneName, level) {
    // Move the slider immediately so the thumb tracks the finger; the
    // setZoneVolume call inside flushZoneFanout will re-apply the same
    // optimistic update + run the network request.
    const zone = snap.zones.find((z) => z.name === zoneName);
    if (zone) {
      setSnap((cur) => {
        const next = { ...cur.volumes };
        for (const pid of zone.pids) next[pid] = level;
        return { ...cur, volumes: next };
      });
    }
    zonePending.current.set(zoneName, level);
    const existing = zoneFanoutTimers.current.get(zoneName);
    if (existing) clearTimeout(existing);
    zoneFanoutTimers.current.set(
      zoneName,
      setTimeout(() => flushZoneFanout(zoneName), ZONE_DEBOUNCE_MS),
    );
  }
  function endZoneVolumeDrag(zoneName) {
    flushZoneFanout(zoneName);
  }

  // Master volume = average across every active-zone speaker; slider drag
  // overrides locally so an incoming WS volume_changed event can't yank the
  // thumb out of the user's finger.
  const [masterOverride, setMasterOverride] = useState(null);
  const draggingMaster = useRef(false);
  // Debounce the fan-out: a slider drag fires onChange ~30×/s, and each tick
  // would otherwise dispatch N parallel HEOS set_volume calls (one per active
  // pid). With three zones × four speakers that's 120 commands/s — enough to
  // saturate HEOS's processing window and trigger eid=11/13 busy errors. The
  // override above keeps the UI snappy; the LATEST level coalesces into a
  // single fan-out per ~80ms.
  const masterPendingLevel = useRef(null);
  const masterFanoutTimer = useRef(null);
  const MASTER_DEBOUNCE_MS = 80;

  const derivedMaster = useMemo(() => {
    const vals = snap.activePids.map((p) => snap.volumes[p]).filter((v) => typeof v === 'number');
    if (!vals.length) return null;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }, [snap.activePids, snap.volumes]);
  const masterDisplay = masterOverride != null ? masterOverride : derivedMaster;

  function flushMasterFanout() {
    if (masterFanoutTimer.current) {
      clearTimeout(masterFanoutTimer.current);
      masterFanoutTimer.current = null;
    }
    const level = masterPendingLevel.current;
    masterPendingLevel.current = null;
    if (level == null) return;
    for (const name of snap.activeZones) setZoneVolume(name, level);
  }
  function setMasterVolume(level) {
    draggingMaster.current = true;
    setMasterOverride(level);
    masterPendingLevel.current = level;
    if (masterFanoutTimer.current) clearTimeout(masterFanoutTimer.current);
    masterFanoutTimer.current = setTimeout(flushMasterFanout, MASTER_DEBOUNCE_MS);
  }
  function endMasterDrag() {
    // Always send the final value immediately — drop-the-finger should be
    // the moment the volume locks in, not 80ms later.
    flushMasterFanout();
    draggingMaster.current = false;
    setMasterOverride(null);
  }
  useEffect(() => () => {
    if (masterFanoutTimer.current) clearTimeout(masterFanoutTimer.current);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    for (const t of zoneFanoutTimers.current.values()) clearTimeout(t);
    zoneFanoutTimers.current.clear();
  }, []);

  const showSpotifyBanner = !snap.spotifyConnected || reauthNeeded;
  const pinsCount = usePinsCount();

  // F3: source-of-truth playback position from Spotify. The hook polls every
  // 5s while playing and tightens to a quick re-poll near track end so an
  // auto-advance flips the bar back to 0 within a fraction of a second
  // instead of interpolating up-to-5s past the old track's end. The
  // playStateHint is here so the polling loop re-arms when HEOS reports the
  // leader transitioned pause→play — without it, the loop would stay dormant
  // until the tab is hidden+shown.
  const { sample: playback, queue: upNext } = usePlaybackProgress({
    enabled: snap.spotifyConnected,
    playStateHint: snap.nowPlaying?.state || '',
    bumpToken: playBumpToken,
  });

  // Mirror the latest Spotify-reported song into a ref so play() can capture
  // it synchronously as the "stale" watermark for the optimistic overlay.
  const latestPlaybackSongRef = useRef('');
  useEffect(() => { latestPlaybackSongRef.current = playback?.song || ''; }, [playback?.song]);
  // Mirror the full sample so control() can compute the optimistic freeze
  // position synchronously without re-rendering.
  useEffect(() => { latestPlaybackRef.current = playback || null; }, [playback]);
  // Mirror the queue so control('next') can swap to queue[0] synchronously.
  const upNextRef = useRef([]);
  useEffect(() => { upNextRef.current = upNext || []; }, [upNext]);

  // Reconcile the play-state override with the authoritative poll. Two modes:
  //   - 'pp' (play/pause): clear when polled is_playing matches.
  //   - 'skip' (next/previous): clear when polled.song != song-at-tap-time.
  //     Matching on is_playing here would mis-fire on a fast immediate poll
  //     that catches the OLD track (still playing, same is_playing value) —
  //     the bar would snap to the old position before the new track arrives.
  // 4s safety net for either mode so a stranded override (Spotify session
  // moved, refresh failed, skip-to-same-song) can't freeze the bar permanently.
  useEffect(() => {
    if (!playStateOverride) return;
    if (playStateOverride.kind === 'skip') {
      if (playback?.song && playback.song !== playStateOverride.prevSong) {
        setPlayStateOverride(null);
        return;
      }
    } else {
      if (playback?.is_playing === playStateOverride.is_playing) {
        setPlayStateOverride(null);
        return;
      }
    }
    const t = setTimeout(() => setPlayStateOverride(null), 4000);
    return () => clearTimeout(t);
  }, [playStateOverride, playback?.is_playing, playback?.song]);

  // Compose what NowPlaying renders: the polled sample with the optimistic
  // is_playing + progress_ms patched in while the override is active. Other
  // metadata (song, art, duration, device_id, shuffle/repeat) flows through
  // unchanged — they're not what the override is fixing. Effects that need the
  // raw sample (foreign-device detect, seek catch-up, latest-song-ref) still
  // read `playback` directly.
  const playbackForUI = useMemo(() => {
    if (!playStateOverride) return playback;
    if (!playback) return null;
    return {
      ...playback,
      is_playing: playStateOverride.is_playing,
      progress_ms: playStateOverride.progress_ms,
      sampledAt: playStateOverride.sampledAt,
    };
  }, [playback, playStateOverride]);

  // First-load convenience: if HEOS reports zones already have a track queued
  // (play or paused) but no zone is selected in the UI, auto-select them so
  // the play button on the NowPlaying card just works without an extra
  // zone tap. Group zones by song and pick the largest cluster — handles the
  // common "all three speakers grouped on the same content" case while
  // avoiding the edge case where two distinct groups have different content
  // and merging them would mis-target playback.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (!wsReady || autoSelectedRef.current) return;
    if (snap.activeZones.length > 0) {
      autoSelectedRef.current = true; // user/server already has a selection
      return;
    }
    if (!snap.zones.length) return;
    // Don't gate on play-state. HEOS get_play_state can come back null at
    // hydration (transient query failure on a sleeping speaker), leaving
    // np.state undefined even though the speaker has perfectly valid queued
    // metadata. ZoneGrid happily shows that song line — the auto-select
    // should match and pick the zone too.
    const songToZones = new Map();
    for (const z of snap.zones) {
      const leader = z.pids[0];
      if (!leader) continue;
      const np = snap.nowPlayingByPid[leader];
      if (!np) continue;
      const song = np.song || np.title;
      if (!song) continue;
      const cur = songToZones.get(song) || [];
      cur.push(z.name);
      songToZones.set(song, cur);
    }
    let best = [];
    for (const zones of songToZones.values()) {
      if (zones.length > best.length) best = zones;
    }
    if (best.length) {
      autoSelectedRef.current = true;
      setActiveZones(best);
    }
  }, [wsReady, snap.zones, snap.nowPlayingByPid, snap.activeZones]);

  // Foreign-device auto-recovery. Within 10s of a successful play, if Spotify
  // reports the active device is something other than what we transferred to,
  // pause the session and surface a clear toast. Outside that window we trust
  // the user (they may have intentionally moved playback in the Spotify app).
  useEffect(() => {
    const exp = expectedDevice.current;
    if (!exp) return;
    if (Date.now() > exp.deadline) { expectedDevice.current = null; return; }
    if (!playback?.device_id) return;
    if (playback.device_id === exp.id) {
      expectedDevice.current = null;
      return;
    }
    // Mismatch — Spotify session ended up on a non-HEOS device. Pause and
    // surface what happened. Single-shot: clear before firing so a second
    // poll in the same window doesn't toast twice.
    expectedDevice.current = null;
    api.spotifyDisconnect().catch(() => {});
    const where = playback.device_name ? ` (on ${playback.device_name})` : '';
    showToast(`Spotify session moved${where} — paused`, 'error');
  }, [playback?.device_id]);

  // Clear the optimistic overlay as soon as Spotify reports either:
  //  (a) a track different from the one that was playing at pick time
  //      (Spotify confirmed the new playback landed), or
  //  (b) a track matching the optimistic pick (covers the same-song replay
  //      case — without (b) the overlay would sit until the 10s safety
  //      timeout because prevSpotifySong === picked song).
  // 10s safety timeout in case Spotify never catches up (session migrated,
  // wrong device, etc).
  useEffect(() => {
    if (!pickedOptimistic) return;
    if (playback?.song) {
      if (playback.song !== pickedOptimistic.prevSpotifySong || playback.song === pickedOptimistic.song) {
        setPickedOptimistic(null);
        return;
      }
    }
    const t = setTimeout(() => setPickedOptimistic(null), 10000);
    return () => clearTimeout(t);
  }, [pickedOptimistic, playback?.song]);

  // Spotify Connect playback gives HEOS no song/title metadata —
  // get_now_playing_media returns just `{type:'station', station:'Spotify'}`.
  // Merge Spotify's track info (already polled for the progress bar) on top of
  // the HEOS payload so the Now Playing card shows the actual song instead of
  // "Nothing playing" beside a green Pause button. HEOS still owns play/pause
  // state (which is what triggers the per-zone re-fetch upstream).
  const displayedNowPlaying = useMemo(() => {
    const heos = snap.nowPlaying;
    // Optimistic overlay wins until Spotify catches up (see effect above).
    if (pickedOptimistic) {
      return {
        ...(heos || {}),
        song: pickedOptimistic.song,
        artist: pickedOptimistic.artist,
        album: '',
        image_url: pickedOptimistic.image_url,
      };
    }
    if (!playback?.song && !playback?.image_url) return heos;
    return {
      ...(heos || {}),
      song: playback.song || heos?.song || heos?.title || '',
      artist: playback.artist || heos?.artist || '',
      album: playback.album || heos?.album || '',
      image_url: playback.image_url || heos?.image_url || '',
    };
  }, [snap.nowPlaying, playback?.song, playback?.artist, playback?.album, playback?.image_url, pickedOptimistic]);

  const art = displayedNowPlaying?.image_url || null;

  // Optimistic seek: the next /me/player poll can be up to 5s away, so without
  // an override the slider snaps back to the pre-seek position for a beat
  // before the new sample arrives. Hold the seeked value as the source of truth
  // until either (a) Spotify reports a progress >= the seeked value, or (b) a
  // 6s safety timeout — whichever comes first. NowPlaying merges this in.
  const [seekOverride, setSeekOverride] = useState(null);
  useEffect(() => {
    if (seekOverride == null) return;
    if (playback?.is_playing && playback.progress_ms != null) {
      // Cleared once Spotify catches up to the optimistic position. Allow 1s
      // slack so a slightly-behind sample still clears it.
      const elapsed = playback.is_playing ? Date.now() - playback.sampledAt : 0;
      if ((playback.progress_ms + elapsed) >= seekOverride - 1000) {
        setSeekOverride(null);
        return;
      }
    }
    const t = setTimeout(() => setSeekOverride(null), 6000);
    return () => clearTimeout(t);
  }, [seekOverride, playback?.progress_ms, playback?.sampledAt, playback?.is_playing]);

  async function seekTo(ms) {
    setSeekOverride(ms);
    try { await api.seek(ms); }
    catch (e) {
      setSeekOverride(null);
      showToast(e.message, 'error');
    }
  }

  async function stopEverywhere() {
    try {
      const r = await api.stopAll();
      // Server clears active zones, so the next snapshot/change reconciles
      // the UI; in the meantime, clear locally so the button hides immediately.
      setSnap((cur) => ({ ...cur, activeZones: [] }));
      // If the user just tapped a song before stopping, the optimistic overlay
      // would otherwise sit for ~10s past the stop (Spotify never advances
      // past the stale picked song). Drop it now — the bottom card will fall
      // back to whatever Spotify last reported.
      setPickedOptimistic(null);
      // Honest signal when HEOS pause failed silently — speakers may keep playing
      // even though we cleared the selection. Toast nudges the user to verify.
      if (r?.partial) showToast('Stop sent — check speakers', 'error');
      else showToast('Stopped');
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  return (
    <>
      <Backdrop artUrl={art} />
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="max-w-[900px] mx-auto px-4 flex flex-col gap-3.5 min-h-screen"
        style={{
          paddingTop: 'max(env(safe-area-inset-top), 16px)',
          paddingBottom: 'max(env(safe-area-inset-bottom), 16px)',
        }}
      >
        {showSpotifyBanner && (
          <Card radius="lg" classNames={{ base: 'bg-content2/70 border border-danger/60' }}>
            <CardBody className="flex flex-row items-center justify-between gap-3 p-3">
              <span>{reauthNeeded ? 'Spotify needs to reconnect.' : "Spotify isn't connected yet."}</span>
              <Button as="a" href="/api/spotify/login" color="success" radius="lg" className="bg-[#1db954] text-white font-semibold">
                {reauthNeeded ? 'Reconnect' : 'Connect'}
              </Button>
            </CardBody>
          </Card>
        )}

        <Banner banner={banner} onDismiss={() => setBanner(null)} />

        <Card radius="lg" classNames={sectionCardClasses}>
          <CardBody className={sectionCardClasses.body}>
            <SectionTitle>Search Spotify</SectionTitle>
            <SearchResults onPlay={play} onError={(m) => showToast(m, 'error')} />
          </CardBody>
        </Card>

        <Card radius="lg" classNames={sectionCardClasses}>
          <CardBody className={sectionCardClasses.body}>
            <div className="flex items-center justify-between mb-3 ml-1">
              <p className="text-tiny uppercase tracking-[0.1em] text-default-500 font-semibold">Zones</p>
              <AnimatePresence>
                {snap.activeZones.length > 0 && (
                  <motion.button
                    type="button"
                    key="stop-all"
                    aria-label="Stop all zones"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.12 }}
                    onClick={stopEverywhere}
                    className="text-tiny font-semibold tracking-wide text-white/55 hover:text-white px-1.5 py-0.5 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                  >
                    Stop all
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
            <ZoneGrid
              zones={snap.zones}
              activeZones={snap.activeZones}
              volumes={snap.volumes}
              nowPlayingByPid={snap.nowPlayingByPid}
              wsReady={wsReady}
              onToggle={(name) => {
                const next = snap.activeZones.includes(name)
                  ? snap.activeZones.filter((z) => z !== name)
                  : [...snap.activeZones, name];
                setActiveZones(next);
              }}
              onVolume={setZoneVolumeDebounced}
              onVolumeEnd={endZoneVolumeDrag}
            />
          </CardBody>
        </Card>

        {(snap.recents?.length > 0 || snap.frequent?.length > 0 || pinsCount > 0) && (
          <Card radius="lg" classNames={sectionCardClasses}>
            <CardBody className={sectionCardClasses.body}>
              <SectionTitle>Quick picks</SectionTitle>
              <QuickPicks
                recents={snap.recents || []}
                frequent={snap.frequent || []}
                onPlay={play}
              />
            </CardBody>
          </Card>
        )}

        <Card radius="lg" classNames={sectionCardClasses}>
          <CardBody className={sectionCardClasses.body}>
            <NowPlaying
              nowPlaying={displayedNowPlaying}
              onControl={control}
              masterVolume={masterDisplay}
              onMasterVolume={setMasterVolume}
              onMasterVolumeEnd={endMasterDrag}
              playback={playbackForUI}
              onSeek={seekTo}
              seekOverride={seekOverride}
            />
          </CardBody>
        </Card>
      </motion.div>

      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 20, scale: 0.96, x: '-50%' }}
            animate={{ opacity: 1, y: 0, scale: 1, x: '-50%' }}
            exit={{ opacity: 0, y: 12, scale: 0.96, x: '-50%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            className={[
              'fixed left-1/2 bottom-7 z-50 px-4 py-2.5 rounded-full backdrop-blur-xl border shadow-2xl text-sm',
              toast.kind === 'error'
                ? 'bg-content2/80 border-danger text-danger'
                : 'bg-content2/80 border-white/15 text-foreground',
            ].join(' ')}
          >
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function SectionTitle({ children }) {
  return (
    <p className="text-tiny uppercase tracking-[0.1em] text-default-500 font-semibold mb-3 ml-1">
      {children}
    </p>
  );
}

// Reactive pin count so the Quick Picks card can hide itself when there's
// nothing to show, but reappear the instant a long-press pins something.
function usePinsCount() {
  const [n, setN] = useState(() => readPinsCount());
  useEffect(() => {
    const refresh = () => setN(readPinsCount());
    window.addEventListener('heos:pins-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('heos:pins-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return n;
}
function readPinsCount() {
  try { return (JSON.parse(localStorage.getItem('heos.quickpicks.pins') || '[]') || []).length; }
  catch { return 0; }
}

// F3: poll Spotify's /me/player while a track is playing AND the tab is
// visible. Default cadence is 5s, but the next poll is tightened to land just
// after the predicted track end so an auto-advance is detected within a beat
// — without that, the bar would interpolate past the old track's duration for
// up to 5s before the next sample reset it. Returns the most-recent sample
// plus the wall time when it was taken; NowPlaying interpolates from there.
const POLL_MS = 5000;
const POLL_NEAR_END_MIN_MS = 800;
function usePlaybackProgress({ enabled, playStateHint, bumpToken }) {
  const [sample, setSample] = useState(null); // { progress_ms, duration_ms, is_playing, song, ..., sampledAt }
  // Up-next queue from Spotify, polled alongside playback. Used by the
  // next-tap optimistic overlay so the title flips instantly to queue[0]
  // instead of waiting for Spotify to propagate the skip.
  const [queue, setQueue] = useState([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer = null;

    async function fetchOnce() {
      try {
        const r = await api.playbackPosition();
        if (cancelled) return;
        const pb = r.playback;
        setSample(pb ? { ...pb, sampledAt: Date.now() } : null);
        setQueue(Array.isArray(r.queue) ? r.queue : []);
        let next;
        if (pb?.is_playing) {
          // Schedule the next poll to land just after the predicted track end.
          // remaining + small buffer = wake right after auto-advance, capped
          // at POLL_MS for very long tracks and floored to avoid pathological
          // sub-second polling near the boundary.
          const remaining = Math.max(0, (pb.duration_ms || 0) - (pb.progress_ms || 0));
          next = Math.min(POLL_MS, Math.max(POLL_NEAR_END_MIN_MS, remaining + 400));
        } else {
          // Idle/paused/between-tracks: keep polling at a slower cadence so an
          // external resume or autoplay extension (Spotify briefly returns
          // is_playing=false at the album→radio boundary) is picked up. Without
          // this the loop would die forever and the bottom card would freeze.
          next = POLL_MS * 2;
        }
        timer = setTimeout(fetchOnce, next);
      } catch {
        // Errors are silent — the bar just stops advancing. Surfacing a toast
        // every 5s would be far worse UX than no bar.
        if (!cancelled) timer = setTimeout(fetchOnce, POLL_MS * 2);
      }
    }

    function start() {
      clearTimeout(timer);
      fetchOnce();
    }
    function stop() {
      clearTimeout(timer);
      timer = null;
    }
    function onVis() {
      if (document.visibilityState === 'visible') start(); else stop();
    }

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
    // bumpToken in deps: every increment tears down the loop (cancelling any
    // pending sleep) and restarts with an immediate fetch — that's how a play
    // tap forces a re-poll instead of waiting up to 5s.
  }, [enabled, playStateHint, bumpToken]);

  return { sample, queue };
}

