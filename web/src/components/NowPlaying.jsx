import React, { useEffect, useState } from 'react';
import { Image, Slider } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';

// Spotify-style progress slider: green fill, white thumb on a neutral track.
const progressSliderClasses = {
  base: 'gap-0',
  track: 'bg-white/15 border-0 h-1',
  filler: 'bg-primary',
  thumb: 'w-3.5 h-3.5 bg-white border-0 shadow-sm after:bg-transparent after:w-9 after:h-9 data-[dragging=true]:scale-110',
};

// Volume slider stays white-on-white so it doesn't compete with the progress
// bar for accent attention (matches both Spotify and Apple Music).
const volumeSliderClasses = {
  base: 'gap-0 flex-1',
  track: 'bg-white/15 border-0 h-1',
  filler: 'bg-white',
  thumb: 'w-3.5 h-3.5 bg-white border-0 shadow-sm after:bg-transparent after:w-9 after:h-9 data-[dragging=true]:scale-110',
};

const REPEAT_CYCLE = { off: 'context', context: 'track', track: 'off' };

export default function NowPlaying({ nowPlaying, onControl, masterVolume, onMasterVolume, onMasterVolumeEnd, playback, onSeek, seekOverride }) {
  const np = nowPlaying || {};
  const hasTrack = np.song || np.title;
  const title = np.song || np.title || '';
  const artist = np.artist || np.station || '';
  const art = np.image_url || '';
  // App-level playStateOverride patches playback.is_playing synchronously
  // when the user taps play/pause, so by the time this component re-renders
  // the icon already reflects the optimistic state — no local optimism
  // needed. (See App.jsx control() + playbackForUI useMemo.)
  const stateStr = (np.state || '').toLowerCase();
  const heosPlaying = stateStr === 'play' || stateStr === 'playing';
  const isPlaying = playback?.is_playing ?? heosPlaying;
  function togglePlay() {
    onControl(isPlaying ? 'pause' : 'play');
  }
  const interpolatedMs = useInterpolatedProgress(playback);
  // While the seek override is set, show the seeked position as the source of
  // truth — App.jsx clears it once Spotify reports a poll past the seeked point.
  const progressMs = seekOverride != null ? seekOverride : interpolatedMs;
  const durationMs = playback?.duration_ms ?? 0;
  const showBar = hasTrack && durationMs > 0;

  // Shuffle/repeat optimism. Spotify polls every 5s, so without this the
  // icon stays in its old state for up to 5s after a tap — which reads as
  // "did my tap register?". Reconcile when the next poll's reported value
  // matches the optimistic one (or fall back after 6s if Spotify never
  // confirms). Play/pause uses the App-level playStateOverride instead;
  // shuffle/repeat don't have an App-level analogue so they stay local.
  const reportedShuffle = !!playback?.shuffle_state;
  const reportedRepeat = playback?.repeat_state || 'off';
  const [shuffleOpt, setShuffleOpt] = useState(null);
  const [repeatOpt, setRepeatOpt] = useState(null);
  const shuffleOn = shuffleOpt ?? reportedShuffle;
  const repeatMode = repeatOpt ?? reportedRepeat;
  useEffect(() => {
    if (shuffleOpt == null) return;
    if (shuffleOpt === reportedShuffle) { setShuffleOpt(null); return; }
    const t = setTimeout(() => setShuffleOpt(null), 6000);
    return () => clearTimeout(t);
  }, [shuffleOpt, reportedShuffle]);
  useEffect(() => {
    if (repeatOpt == null) return;
    if (repeatOpt === reportedRepeat) { setRepeatOpt(null); return; }
    const t = setTimeout(() => setRepeatOpt(null), 6000);
    return () => clearTimeout(t);
  }, [repeatOpt, reportedRepeat]);
  function toggleShuffle() {
    const next = !shuffleOn;
    setShuffleOpt(next);
    onControl('shuffle', next);
  }
  function cycleRepeat() {
    const next = REPEAT_CYCLE[repeatMode] || 'off';
    setRepeatOpt(next);
    onControl('repeat', next);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <div className="relative w-20 h-20 shrink-0">
          <AnimatePresence mode="popLayout">
            <motion.div
              key={art || 'noart'}
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={{ type: 'spring', stiffness: 320, damping: 24 }}
              className="absolute inset-0"
            >
              {art ? (
                <Image
                  src={art}
                  alt={title}
                  width={80}
                  height={80}
                  radius="lg"
                  className="object-cover w-20 h-20 shadow-lg"
                />
              ) : (
                <div className="w-20 h-20 rounded-large bg-content2" />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <motion.div
          key={`${title}|${artist}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: 'easeOut' }}
          className="flex-1 min-w-0"
        >
          {hasTrack ? (
            <>
              <p className="font-semibold text-lg truncate leading-tight">{title}</p>
              <p className="text-small text-white/60 truncate mt-0.5">{artist}</p>
            </>
          ) : (
            <p className="text-white/60">Nothing playing — pick a zone and search for music.</p>
          )}
        </motion.div>
      </div>

      {showBar && (
        <div className="flex flex-col gap-1.5">
          <Slider
            aria-label="Track progress"
            size="sm"
            radius="full"
            minValue={0}
            maxValue={durationMs}
            step={1000}
            value={Math.min(progressMs, durationMs)}
            onChangeEnd={(v) => onSeek?.(Array.isArray(v) ? v[0] : v)}
            classNames={progressSliderClasses}
          />
          <div className="flex justify-between text-tiny text-white/50 tabular-nums px-0.5">
            <span>{fmtTime(progressMs)}</span>
            <span>{fmtTime(durationMs)}</span>
          </div>
        </div>
      )}

      {/* Transport row, Apple-Music style: bare icon buttons centered, with a
          single filled circular play button as the focal point. No button
          group, no segmented background — the spacing alone groups them. */}
      <div className="flex items-center justify-between max-w-md mx-auto w-full px-2">
        <TransportIconButton
          label={shuffleOn ? 'Shuffle on' : 'Shuffle off'}
          pressed={shuffleOn}
          onPress={toggleShuffle}
        >
          <ShuffleIcon className="w-5 h-5" />
        </TransportIconButton>

        <TransportIconButton label="Previous" onPress={() => onControl('previous')}>
          <PrevIcon className="w-7 h-7" />
        </TransportIconButton>

        <PlayPauseButton
          isPlaying={isPlaying}
          onPress={togglePlay}
        />

        <TransportIconButton label="Next" onPress={() => onControl('next')}>
          <NextIcon className="w-7 h-7" />
        </TransportIconButton>

        <TransportIconButton
          label={`Repeat ${repeatMode}`}
          pressed={repeatMode !== 'off'}
          onPress={cycleRepeat}
        >
          {repeatMode === 'track' ? <RepeatOneIcon className="w-5 h-5" /> : <RepeatIcon className="w-5 h-5" />}
        </TransportIconButton>
      </div>

      {masterVolume != null && (
        <div className="flex items-center gap-3">
          <VolumeLowIcon className="w-4 h-4 text-white/50 shrink-0" />
          <Slider
            aria-label="Master volume"
            size="sm"
            radius="full"
            minValue={0}
            maxValue={100}
            step={1}
            value={masterVolume}
            onChange={(v) => onMasterVolume(Array.isArray(v) ? v[0] : v)}
            onChangeEnd={() => onMasterVolumeEnd?.()}
            classNames={volumeSliderClasses}
          />
          <VolumeHighIcon className="w-4 h-4 text-white/50 shrink-0" />
        </div>
      )}
    </div>
  );
}

// Bare icon button, no chrome. Pressed state lights the icon with the album
// accent so the F7 recolor still shows up somewhere; off state is muted white.
function TransportIconButton({ label, pressed, onPress, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed ?? undefined}
      onClick={onPress}
      className={[
        'inline-flex items-center justify-center w-11 h-11 rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
        'active:scale-95 transition-transform',
        pressed ? 'text-primary' : 'text-white/85 hover:text-white',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

// Filled green focal control — Spotify's signature. Slight grow on press so
// touch confirmation is visible without a heavy hover state.
function PlayPauseButton({ isPlaying, onPress }) {
  return (
    <motion.button
      type="button"
      aria-label={isPlaying ? 'Pause' : 'Play'}
      onClick={onPress}
      whileTap={{ scale: 0.92 }}
      whileHover={{ scale: 1.04 }}
      transition={{ type: 'spring', stiffness: 500, damping: 22 }}
      className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-[0_6px_18px_-4px_hsl(var(--heroui-primary)/0.55)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-content1"
    >
      {isPlaying ? <PauseIcon className="w-6 h-6" /> : <PlayIcon className="w-6 h-6 ml-0.5" />}
    </motion.button>
  );
}

// --- Inline SVG icons ---------------------------------------------------------
// Hand-rolled to keep the bundle thin and avoid a runtime icon-font dependency.
// All are stroke-based at 1.75px to match Apple Music's transport set; play/
// pause are filled because they're the focal control.

function PlayIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function PauseIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
function PrevIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M6 6h2v12H6zM20 6v12L9.5 12z" />
    </svg>
  );
}
function NextIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M16 6h2v12h-2zM4 6v12l10.5-6z" />
    </svg>
  );
}
function ShuffleIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M16 3h5v5" />
      <path d="M4 20L21 3" />
      <path d="M21 16v5h-5" />
      <path d="M15 15l6 6" />
      <path d="M4 4l5 5" />
    </svg>
  );
}
function RepeatIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 014-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 01-4 4H3" />
    </svg>
  );
}
function RepeatOneIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 014-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 01-4 4H3" />
      <path d="M11 11l1-1v4" />
    </svg>
  );
}
function VolumeLowIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
    </svg>
  );
}
function VolumeHighIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 010 7" />
      <path d="M19 5a9 9 0 010 14" />
    </svg>
  );
}
// Smoothly tick the bar between 5s polls. Anchors to the latest sample's wall
// time and clamps so we never visually overshoot the duration.
function useInterpolatedProgress(playback) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!playback?.is_playing) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [playback?.is_playing, playback?.sampledAt]);
  if (!playback) return 0;
  const elapsed = playback.is_playing ? now - playback.sampledAt : 0;
  return Math.max(0, Math.min(playback.duration_ms || 0, (playback.progress_ms || 0) + elapsed));
}

function fmtTime(ms) {
  if (!ms || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}
