import React, { useEffect, useState } from 'react';
import { Button, Image, Slider } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';

export default function NowPlaying({ nowPlaying, onControl, masterVolume, onMasterVolume, onMasterVolumeEnd, playback, onSeek, onKillSession }) {
  const np = nowPlaying || {};
  const hasTrack = np.song || np.title;
  const title = np.song || np.title || '';
  const artist = np.artist || np.station || '';
  const art = np.image_url || '';
  const stateStr = (np.state || '').toLowerCase();
  const isPlaying = stateStr === 'play' || stateStr === 'playing';
  const progressMs = useInterpolatedProgress(playback);
  const durationMs = playback?.duration_ms ?? 0;
  const showBar = hasTrack && durationMs > 0;

  return (
    <div className="flex flex-col gap-4">
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
              <p className="font-semibold text-lg truncate">{title}</p>
              <p className="text-small text-default-500 truncate">{artist}</p>
            </>
          ) : (
            <p className="text-default-500">Nothing playing — pick a zone and search for music.</p>
          )}
        </motion.div>
        {onKillSession && (
          <Button
            isIconOnly
            variant="light"
            size="sm"
            radius="full"
            aria-label="Kill Spotify session"
            title="Force-stop Spotify on whichever device has it"
            onPress={onKillSession}
            className="text-default-400 opacity-60 hover:opacity-100 shrink-0"
          >
            ⏻
          </Button>
        )}
      </div>

      {showBar && (
        <div className="flex flex-col gap-1 -mt-1">
          <Slider
            aria-label="Track progress"
            color="primary"
            size="sm"
            radius="full"
            minValue={0}
            maxValue={durationMs}
            step={1000}
            value={Math.min(progressMs, durationMs)}
            onChangeEnd={(v) => onSeek?.(Array.isArray(v) ? v[0] : v)}
            classNames={{
              track: 'h-1.5',
              filler: 'h-1.5',
              // Visual thumb stays modest, but the touch target grows via after:
              // pseudo so the iPad hit area meets HIG (~44pt). Keeps the bar
              // looking thin while making seek/scrub usable under a thumb.
              thumb: 'w-5 h-5 after:w-5 after:h-5',
            }}
          />
          <div className="flex justify-between text-tiny text-default-500 tabular-nums px-0.5">
            <span>{fmtTime(progressMs)}</span>
            <span>{fmtTime(durationMs)}</span>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button
          isIconOnly
          variant="flat"
          radius="lg"
          size="lg"
          aria-label="Previous"
          onPress={() => onControl('previous')}
          className="text-xl"
        >
          ‹‹
        </Button>
        <Button
          color="primary"
          radius="lg"
          size="lg"
          // Shadow follows the F7 accent so a recolored UI doesn't keep
          // glowing Spotify-green over (e.g.) a deep-blue album cover.
          // Underscores inside arbitrary values become spaces at build time,
          // so this resolves to: shadow: 0 4px 18px hsl(var(--heroui-primary) / 0.35)
          className="flex-1 font-semibold tracking-wide shadow-[0_4px_18px_hsl(var(--heroui-primary)_/_0.35)]"
          onPress={() => onControl(isPlaying ? 'pause' : 'play')}
        >
          {isPlaying ? '❚❚  Pause' : '▶  Play'}
        </Button>
        <Button
          isIconOnly
          variant="flat"
          radius="lg"
          size="lg"
          aria-label="Next"
          onPress={() => onControl('next')}
          className="text-xl"
        >
          ››
        </Button>
      </div>

      {masterVolume != null && (
        <Slider
          aria-label="Master volume"
          color="primary"
          size="md"
          radius="lg"
          minValue={0}
          maxValue={100}
          step={1}
          value={masterVolume}
          onChange={(v) => onMasterVolume(Array.isArray(v) ? v[0] : v)}
          onChangeEnd={() => onMasterVolumeEnd?.()}
          startContent={<span className="text-small text-default-500 w-14">Volume</span>}
          endContent={<span className="text-small text-default-500 w-8 text-right tabular-nums">{masterVolume}</span>}
          classNames={{ base: 'mt-1' }}
        />
      )}
    </div>
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
