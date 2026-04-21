import React, { useEffect, useRef, useState } from 'react';
import { Image } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';

// Pinned items live in localStorage (per-tablet, no sync); recents come from the
// server snapshot (so any tablet sees the same history). Both render as 80×80
// art tiles in a horizontal scroller — touch-first, no chrome.
const PINS_KEY = 'heos.quickpicks.pins';
const PIN_CAP = 8;

function loadPins() {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function savePins(pins) {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(pins)); } catch {}
}

// Allow other components (SearchResults' long-press) to add pins without
// prop-drilling. Custom event keeps this leaf component dependency-free.
export function pinItem(item) {
  if (!item?.uri) return;
  const cur = loadPins().filter((p) => p.uri !== item.uri);
  const next = [item, ...cur].slice(0, PIN_CAP);
  savePins(next);
  window.dispatchEvent(new CustomEvent('heos:pins-changed'));
}

export default function QuickPicks({ recents = [], onPlay }) {
  const [pins, setPins] = useState(loadPins);

  useEffect(() => {
    const onChange = () => setPins(loadPins());
    window.addEventListener('heos:pins-changed', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('heos:pins-changed', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  function unpin(uri) {
    const next = pins.filter((p) => p.uri !== uri);
    savePins(next);
    setPins(next);
  }

  // Dedup: a pinned item shouldn't also show in the recents row.
  const pinUris = new Set(pins.map((p) => p.uri));
  const recentTiles = recents.filter((r) => !pinUris.has(r.uri));

  if (!pins.length && !recentTiles.length) return null;

  return (
    <div className="flex flex-col gap-2">
      {pins.length > 0 && (
        <Row label="Pinned">
          {pins.map((item) => (
            <Tile
              key={`pin-${item.uri}`}
              item={item}
              isPinned
              onPlay={onPlay}
              onLongPress={() => unpin(item.uri)}
            />
          ))}
        </Row>
      )}
      {recentTiles.length > 0 && (
        <Row label="Recent">
          {recentTiles.map((item) => (
            <Tile
              key={`recent-${item.uri}`}
              item={item}
              onPlay={onPlay}
              onLongPress={() => pinItem(item)}
            />
          ))}
        </Row>
      )}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-tiny uppercase tracking-[0.1em] text-default-500 font-semibold ml-1">{label}</p>
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 no-scrollbar">
        <AnimatePresence initial={false}>
          {children}
        </AnimatePresence>
      </div>
    </div>
  );
}

// Movement past this threshold (px) cancels the long-press timer. Without it,
// a horizontal scroll across the row keeps the pointer down for 550ms+ and
// silently unpins/pins whatever tile started the gesture — the wife loses
// pinned playlists by trying to scroll the strip.
const LONGPRESS_MOVE_THRESHOLD = 10;

function Tile({ item, isPinned = false, onPlay, onLongPress }) {
  const timer = useRef(null);
  const fired = useRef(false);
  const startPos = useRef(null);

  function start(e) {
    fired.current = false;
    startPos.current = { x: e.clientX, y: e.clientY };
    timer.current = setTimeout(() => {
      fired.current = true;
      onLongPress?.(item);
    }, 550);
  }
  function move(e) {
    if (!startPos.current) return;
    const dx = e.clientX - startPos.current.x;
    const dy = e.clientY - startPos.current.y;
    if (Math.abs(dx) > LONGPRESS_MOVE_THRESHOLD || Math.abs(dy) > LONGPRESS_MOVE_THRESHOLD) {
      cancel();
    }
  }
  function cancel() {
    clearTimeout(timer.current);
    startPos.current = null;
  }
  function tap() {
    cancel();
    if (fired.current) return; // long-press already handled
    onPlay({
      uri: item.uri,
      label: item.label,
      sublabel: item.sublabel,
      art: item.art,
      badge: item.badge,
    });
  }

  return (
    <motion.button
      key={item.uri}
      type="button"
      onClick={tap}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => { e.preventDefault(); onLongPress?.(item); }}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 360, damping: 24 }}
      className="relative shrink-0 rounded-large overflow-hidden bg-content2 w-20 h-20 border border-white/10 active:border-primary focus-visible:ring-2 focus-visible:ring-primary"
      aria-label={`Play ${item.label}`}
      // Title hints the long-press action — visible on desktop hover and via
      // assistive tech. The visible pin dot below is what tells touch users
      // these tiles have a manage gesture.
      title={`${item.label}${item.sublabel ? ` — ${item.sublabel}` : ''}\n${isPinned ? 'Press and hold to unpin' : 'Press and hold to pin'}`}
    >
      {item.art ? (
        <Image
          src={item.art}
          alt={item.label}
          width={80}
          height={80}
          radius="none"
          className="object-cover w-20 h-20"
        />
      ) : (
        <div className="w-20 h-20 flex items-center justify-center text-default-500 text-tiny px-1 text-center">
          {item.label}
        </div>
      )}
      <span className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/85 to-transparent text-white text-[10px] leading-tight font-semibold px-1.5 pt-2 pb-1 truncate text-left">
        {item.label}
      </span>
      {isPinned && (
        <span
          aria-hidden="true"
          className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_4px_hsl(var(--heroui-primary)_/_0.8)]"
        />
      )}
    </motion.button>
  );
}
