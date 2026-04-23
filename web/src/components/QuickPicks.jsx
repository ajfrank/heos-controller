import React, { useEffect, useRef, useState } from 'react';
import { Image } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api.js';

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

export default function QuickPicks({ recents = [], frequent = [], onPlay }) {
  const [pins, setPins] = useState(loadPins);
  const [editing, setEditing] = useState(false);

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

  function removeRecent(uri) {
    // Fire-and-forget — the WS recents broadcast updates the prop.
    api.removeRecent(uri).catch(() => {});
  }

  // Dedup: a pinned item shouldn't reappear in Often or Recents, and an item
  // shown in Often shouldn't repeat in Recents either. Server-side dedup
  // already drops anything in the recents top 4 from the frequent payload, but
  // pinned is per-tablet localStorage so dedup against it has to happen here.
  const pinUris = new Set(pins.map((p) => p.uri));
  const frequentTiles = frequent.filter((f) => !pinUris.has(f.uri));
  const frequentUris = new Set(frequentTiles.map((f) => f.uri));
  const recentTiles = recents.filter((r) => !pinUris.has(r.uri) && !frequentUris.has(r.uri));

  // Auto-exit edit mode when there's nothing left to edit.
  useEffect(() => {
    if (editing && pins.length === 0 && recentTiles.length === 0 && frequentTiles.length === 0) setEditing(false);
  }, [editing, pins.length, recentTiles.length, frequentTiles.length]);

  if (!pins.length && !recentTiles.length && !frequentTiles.length) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end -mt-7 mb-1">
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="text-tiny font-semibold tracking-wide text-white/55 hover:text-white px-1.5 py-0.5 rounded transition-colors"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>
      {pins.length > 0 && (
        <Row label="Pinned">
          {pins.map((item) => (
            <Tile
              key={`pin-${item.uri}`}
              item={item}
              isPinned
              editing={editing}
              onPlay={onPlay}
              onLongPress={() => unpin(item.uri)}
              onRemove={() => unpin(item.uri)}
            />
          ))}
        </Row>
      )}
      {frequentTiles.length > 0 && (
        <Row label="Often">
          {frequentTiles.map((item) => (
            <Tile
              key={`often-${item.uri}`}
              item={item}
              editing={editing}
              onPlay={onPlay}
              // Long-press on an Often tile pins it permanently — natural
              // promotion gesture matching the existing Recents behavior.
              onLongPress={() => pinItem(item)}
              // Remove gesture is suppressed for Often — there's no per-item
              // remove (the row is auto-derived). The × is hidden via the
              // null onRemove handler check inside Tile.
              onRemove={null}
            />
          ))}
        </Row>
      )}
      {recentTiles.length > 0 && (
        <Row>
          {recentTiles.map((item) => (
            <Tile
              key={`recent-${item.uri}`}
              item={item}
              editing={editing}
              onPlay={onPlay}
              onLongPress={() => pinItem(item)}
              onRemove={() => removeRecent(item.uri)}
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
      {label && (
        <p className="text-tiny uppercase tracking-[0.1em] text-white/50 font-semibold ml-1">{label}</p>
      )}
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

function Tile({ item, isPinned = false, editing = false, onPlay, onLongPress, onRemove }) {
  const timer = useRef(null);
  const fired = useRef(false);
  const startPos = useRef(null);

  function start(e) {
    if (editing) return; // long-press disabled while edit affordance is showing
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
    if (editing) return; // taps in edit mode are reserved for the × button
    onPlay({
      uri: item.uri,
      label: item.label,
      sublabel: item.sublabel,
      art: item.art,
      badge: item.badge,
    });
  }

  return (
    <motion.div
      key={item.uri}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={{ type: 'spring', stiffness: 360, damping: 24 }}
      className="relative shrink-0"
    >
      <motion.button
        type="button"
        onClick={tap}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(e) => { if (!editing) { e.preventDefault(); onLongPress?.(item); } }}
        whileTap={editing ? undefined : { scale: 0.95 }}
        className="relative block rounded-large overflow-hidden bg-content2 w-20 h-20 border border-white/10 active:border-white/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        aria-label={editing ? `Tile ${item.label}` : `Play ${item.label}`}
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
        {isPinned && !editing && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-white/90 shadow-[0_0_4px_rgba(255,255,255,0.6)]"
          />
        )}
      </motion.button>
      <AnimatePresence>
        {editing && onRemove && (
          <motion.button
            type="button"
            key="remove"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ type: 'spring', stiffness: 500, damping: 24 }}
            onClick={(e) => { e.stopPropagation(); onRemove?.(item); }}
            aria-label={`Remove ${item.label}`}
            className="absolute top-1 left-1 z-10 w-6 h-6 rounded-full bg-black/75 text-white flex items-center justify-center backdrop-blur-sm ring-1 ring-white/20 shadow-md hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
