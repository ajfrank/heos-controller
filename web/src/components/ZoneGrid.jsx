import React from 'react';
import { Card, CardBody, Slider } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';

// Card itself is no longer pressable. Only the header button toggles the zone,
// so dragging the slider can't accidentally fire onToggle via react-aria's
// pointerup/keyboard press capture.
export default function ZoneGrid({ zones, activeZones, volumes, nowPlayingByPid = {}, wsReady = true, onToggle, onVolume, onVolumeEnd }) {
  // Pre-snapshot: show a quiet "Connecting…" so a slow WS handshake doesn't
  // read as a broken app. Empty zones AFTER the first snapshot is a legitimate
  // "no zones found" state — we let it through.
  if (!wsReady && zones.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-default-500 text-small">
        <span className="inline-block w-3 h-3 rounded-full bg-default-400 animate-pulse" />
        Connecting…
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
      {zones.map((z) => {
        const active = activeZones.includes(z.name);
        const leaderPid = z.pids[0];
        // Master volume = average of in-zone speaker volumes; defaults to 0
        // when none are reported yet.
        const inZoneVols = z.pids.map((pid) => volumes[pid]).filter((v) => typeof v === 'number');
        const masterVol = inZoneVols.length
          ? Math.round(inZoneVols.reduce((a, b) => a + b, 0) / inZoneVols.length)
          : 0;
        const np = leaderPid ? nowPlayingByPid[leaderPid] : null;
        const isPlaying = (np?.state || '').toLowerCase() === 'play' || (np?.state || '').toLowerCase() === 'playing';
        const npLine = np && (np.song || np.title)
          ? `${np.song || np.title}${np.artist ? ` — ${np.artist}` : ''}`
          : null;
        return (
          <motion.div
            key={z.name}
            whileTap={{ scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 400, damping: 22 }}
            className="h-full"
          >
            <Card
              isHoverable
              radius="lg"
              shadow="none"
              classNames={{
                base: [
                  'w-full h-full min-h-[88px] border transition-colors',
                  active
                    ? 'bg-primary/[0.12] border-primary/70'
                    : 'bg-white/[0.03] border-white/10',
                ].join(' '),
              }}
            >
              <CardBody className="p-0">
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onToggle(z.name)}
                  className="w-full flex items-start justify-between gap-2 px-3.5 py-3 min-h-[56px] text-left bg-transparent border-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-large"
                >
                  <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className="font-semibold text-base truncate">{z.name}</span>
                    {npLine && (
                      <span
                        className="text-tiny text-default-500 truncate"
                        title={npLine}
                      >
                        <span className={isPlaying ? 'text-primary' : ''}>{isPlaying ? '♪ ' : '⏸ '}</span>{npLine}
                      </span>
                    )}
                  </span>
                  <AnimatePresence>
                    {active && (
                      <motion.span
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                        className="mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground"
                        aria-label="Active"
                      >
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12l5 5 9-11" />
                        </svg>
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>
                <AnimatePresence initial={false}>
                  {active && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="px-3 pb-3 flex items-center gap-2.5">
                        <Slider
                          aria-label={`${z.name} volume`}
                          size="sm"
                          radius="full"
                          minValue={0}
                          maxValue={100}
                          step={1}
                          value={masterVol}
                          onChange={(v) => onVolume(z.name, Array.isArray(v) ? v[0] : v)}
                          onChangeEnd={() => onVolumeEnd?.(z.name)}
                          className="flex-1"
                          classNames={{
                            base: 'gap-0',
                            track: 'bg-white/15 border-0 h-1',
                            filler: 'bg-white',
                            thumb: 'w-3 h-3 bg-white border-0 shadow-sm after:bg-transparent after:w-8 after:h-8',
                          }}
                        />
                        <span className="text-tiny text-white/60 tabular-nums w-7 text-right">{masterVol}</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </CardBody>
            </Card>
          </motion.div>
        );
      })}
    </div>
  );
}
