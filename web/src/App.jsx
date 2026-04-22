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
import { extractAccent } from './lib/extractAccent.js';

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
  async function play(itemBody) {
    if (playInflight.current) return;
    if (!snap.activeZones.length) {
      showToast('Select at least one zone first', 'error'); return;
    }
    playInflight.current = true;
    // Auto-wake on the server can take 2-8s when speakers were idle. Show a
    // quiet "Waking…" hint after ~700ms so the wife isn't staring at silence
    // wondering if her tap registered. Cancelled the moment play resolves.
    const wakeHint = setTimeout(() => showToast('Waking speakers…'), 700);
    try {
      await api.play(itemBody);
      clearTimeout(wakeHint);
      showToast('Playing');
    } catch (e) {
      clearTimeout(wakeHint);
      showToast(e.message, 'error');
    } finally {
      playInflight.current = false;
    }
  }

  async function control(action) {
    try { await api.control(action); } catch (e) { showToast(e.message, 'error'); }
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

  // Master volume = average across every active-zone speaker; slider drag
  // overrides locally so an incoming WS volume_changed event can't yank the
  // thumb out of the user's finger.
  const [masterOverride, setMasterOverride] = useState(null);
  const draggingMaster = useRef(false);

  const derivedMaster = useMemo(() => {
    const vals = snap.activePids.map((p) => snap.volumes[p]).filter((v) => typeof v === 'number');
    if (!vals.length) return null;
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }, [snap.activePids, snap.volumes]);
  const masterDisplay = masterOverride != null ? masterOverride : derivedMaster;

  function setMasterVolume(level) {
    draggingMaster.current = true;
    setMasterOverride(level);
    for (const name of snap.activeZones) setZoneVolume(name, level);
  }
  function endMasterDrag() {
    draggingMaster.current = false;
    setMasterOverride(null);
  }

  const showSpotifyBanner = !snap.spotifyConnected || reauthNeeded;
  const pinsCount = usePinsCount();

  // F3: source-of-truth playback position from Spotify. The hook polls every
  // 5s while playing and tightens to a quick re-poll near track end so an
  // auto-advance flips the bar back to 0 within a fraction of a second
  // instead of interpolating up-to-5s past the old track's end. The
  // playStateHint is here so the polling loop re-arms when HEOS reports the
  // leader transitioned pause→play — without it, the loop would stay dormant
  // until the tab is hidden+shown.
  const playback = usePlaybackProgress({
    enabled: snap.spotifyConnected,
    playStateHint: snap.nowPlaying?.state || '',
  });

  // Spotify Connect playback gives HEOS no song/title metadata —
  // get_now_playing_media returns just `{type:'station', station:'Spotify'}`.
  // Merge Spotify's track info (already polled for the progress bar) on top of
  // the HEOS payload so the Now Playing card shows the actual song instead of
  // "Nothing playing" beside a green Pause button. HEOS still owns play/pause
  // state (which is what triggers the per-zone re-fetch upstream).
  const displayedNowPlaying = useMemo(() => {
    const heos = snap.nowPlaying;
    if (!playback?.song && !playback?.image_url) return heos;
    return {
      ...(heos || {}),
      song: playback.song || heos?.song || heos?.title || '',
      artist: playback.artist || heos?.artist || '',
      album: playback.album || heos?.album || '',
      image_url: playback.image_url || heos?.image_url || '',
    };
  }, [snap.nowPlaying, playback?.song, playback?.artist, playback?.album, playback?.image_url]);

  const art = displayedNowPlaying?.image_url || null;
  useAlbumAccent(art);

  async function seekTo(ms) {
    try { await api.seek(ms); } catch (e) { showToast(e.message, 'error'); }
  }

  async function killSpotifySession() {
    try {
      await api.spotifyDisconnect();
      showToast('Spotify session stopped');
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
            <SectionTitle>Zones</SectionTitle>
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
              onVolume={setZoneVolume}
            />
          </CardBody>
        </Card>

        {(snap.recents?.length > 0 || pinsCount > 0) && (
          <Card radius="lg" classNames={sectionCardClasses}>
            <CardBody className={sectionCardClasses.body}>
              <SectionTitle>Quick picks</SectionTitle>
              <QuickPicks recents={snap.recents || []} onPlay={play} />
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
              playback={playback}
              onSeek={seekTo}
              onKillSession={killSpotifySession}
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

// F7: pull a dominant hue from the current art and override HeroUI's primary
// HSL variable so the play button, sliders, active zone borders, and chip
// accents all retint to match. Falls back to Spotify green when no art or no
// usable color (podcast, mostly-gray covers).
const SPOTIFY_PRIMARY = '141 73% 42%';
function useAlbumAccent(artUrl) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const accent = artUrl ? await extractAccent(artUrl) : null;
      if (cancelled) return;
      document.documentElement.style.setProperty('--heroui-primary', accent || SPOTIFY_PRIMARY);
    })();
    return () => { cancelled = true; };
  }, [artUrl]);
}

// F3: poll Spotify's /me/player while a track is playing AND the tab is
// visible. Default cadence is 5s, but the next poll is tightened to land just
// after the predicted track end so an auto-advance is detected within a beat
// — without that, the bar would interpolate past the old track's duration for
// up to 5s before the next sample reset it. Returns the most-recent sample
// plus the wall time when it was taken; NowPlaying interpolates from there.
const POLL_MS = 5000;
const POLL_NEAR_END_MIN_MS = 800;
function usePlaybackProgress({ enabled, playStateHint }) {
  const [sample, setSample] = useState(null); // { progress_ms, duration_ms, is_playing, song, ..., sampledAt }

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
        if (pb?.is_playing) {
          // Schedule the next poll to land just after the predicted track end.
          // remaining + small buffer = wake right after auto-advance, capped
          // at POLL_MS for very long tracks and floored to avoid pathological
          // sub-second polling near the boundary.
          const remaining = Math.max(0, (pb.duration_ms || 0) - (pb.progress_ms || 0));
          const next = Math.min(POLL_MS, Math.max(POLL_NEAR_END_MIN_MS, remaining + 400));
          timer = setTimeout(fetchOnce, next);
        }
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
  }, [enabled, playStateHint]);

  return sample;
}

