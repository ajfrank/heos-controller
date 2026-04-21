import React from 'react';
import { Card, CardBody, Chip, Slider } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';

// Card itself is no longer pressable. Only the header button toggles the zone,
// so dragging the slider can't accidentally fire onToggle via react-aria's
// pointerup/keyboard press capture.
export default function ZoneGrid({ players, activePids, volumes, nowPlayingByPid = {}, wsReady = true, onToggle, onVolume }) {
  // Pre-snapshot: show a quiet "Connecting…" so a slow WS handshake doesn't
  // read as a broken app. Empty player list AFTER the first snapshot is a
  // legitimate "no zones found" state — we let it through.
  if (!wsReady && players.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-default-500 text-small">
        <span className="inline-block w-3 h-3 rounded-full bg-default-400 animate-pulse" />
        Connecting…
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2.5">
      {players.map((p) => {
        const active = activePids.includes(p.pid);
        const vol = volumes[p.pid] ?? 0;
        const np = nowPlayingByPid[p.pid];
        const isPlaying = (np?.state || '').toLowerCase() === 'play' || (np?.state || '').toLowerCase() === 'playing';
        const npLine = np && (np.song || np.title)
          ? `${np.song || np.title}${np.artist ? ` — ${np.artist}` : ''}`
          : null;
        return (
          <motion.div
            key={p.pid}
            whileTap={{ scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 400, damping: 22 }}
            className="h-full"
          >
            <Card
              isHoverable
              radius="lg"
              shadow="sm"
              classNames={{
                base: [
                  'w-full h-full min-h-[88px] border transition-colors',
                  active
                    ? 'bg-primary/20 border-primary shadow-[0_0_0_1px_var(--heroui-primary),0_4px_18px_rgba(29,185,84,0.35)]'
                    : 'bg-content2/70 border-white/10',
                ].join(' '),
              }}
            >
              <CardBody className="p-0">
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onToggle(p.pid)}
                  className="w-full flex items-start justify-between gap-2 px-3.5 py-3 min-h-[56px] text-left bg-transparent border-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-large"
                >
                  <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className="font-semibold text-base truncate">{p.name}</span>
                    {npLine && (
                      <span
                        className="text-tiny text-default-500 truncate"
                        title={npLine}
                      >
                        {isPlaying ? '♪ ' : '⏸ '}{npLine}
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
                        className="mt-0.5"
                      >
                        <Chip color="primary" size="sm" variant="solid" classNames={{ content: 'font-bold' }}>
                          ✓
                        </Chip>
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
                          aria-label={`${p.name} volume`}
                          color="primary"
                          size="md"
                          radius="lg"
                          minValue={0}
                          maxValue={100}
                          step={1}
                          value={vol}
                          onChange={(v) => onVolume(p.pid, Array.isArray(v) ? v[0] : v)}
                          className="flex-1"
                        />
                        <span className="text-tiny text-white/85 tabular-nums w-7 text-right">{vol}</span>
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
