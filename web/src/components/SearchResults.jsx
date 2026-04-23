import React, { useEffect, useRef, useState } from 'react';
import { Card, Chip, Image, Spinner } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api.js';
import { pinItem } from './QuickPicks.jsx';

const BADGE_COLOR = { Track: 'default', Playlist: 'success', Album: 'secondary' };

export default function SearchResults({ onPlay, onError }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const debounce = useRef(null);

  // Picking a result is the natural "I'm done searching" signal — clear the
  // query so the result list collapses (AnimatePresence exit) and the input
  // is ready for the next search. The empty-q useEffect below handles
  // aborting any in-flight request and nulling `results`.
  function handlePlay(play) {
    onPlay(play);
    setQ('');
  }

  // Keep the AbortController for the in-flight query so a stale response from
  // a prior keystroke can't overwrite the current one (race seen during fast
  // typing on a slow connection).
  const inflight = useRef(null);
  useEffect(() => {
    if (!q.trim()) {
      inflight.current?.abort();
      setResults(null);
      return;
    }
    clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      inflight.current?.abort();
      const ctrl = new AbortController();
      inflight.current = ctrl;
      setBusy(true);
      try {
        const r = await api.search(q.trim(), { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        setResults({ items: normalizeSpotify(r.results) });
      } catch (e) {
        if (e?.name === 'AbortError' || ctrl.signal.aborted) return;
        onError(e.message);
      } finally {
        if (!ctrl.signal.aborted) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(debounce.current);
  }, [q]);

  useEffect(() => () => inflight.current?.abort(), []);

  return (
    <div className="flex flex-col gap-3">
      <VoiceSearchInput q={q} setQ={setQ} onError={onError} />


      {/* Fixed-pixel height locks "exactly 8 rows" across viewports — vh-based
          sizing miscounts on shorter screens. Row = max(44px image + 12px
          py-1.5, 52px min-h) = 56px, so 8 rows = 448px. */}
      <div className="max-h-[448px] overflow-y-auto -mx-2">
        {busy && (
          <div className="flex items-center gap-2 px-3 py-3 text-default-500">
            <Spinner color="primary" size="sm" /> Searching…
          </div>
        )}
        {!busy && results?.items?.length === 0 && (
          <div className="px-3 py-3 text-default-500">No results.</div>
        )}
        <AnimatePresence initial={false}>
          {!busy && results?.items?.length > 0 && (
            <motion.ul
              variants={listVariants}
              initial="hidden"
              animate="show"
              exit="hidden"
              className="flex flex-col"
            >
              {results.items.map((item, i) => (
                <motion.li key={`${item.play.uri || i}-${i}`} variants={rowVariants}>
                  <ResultRow item={item} onPlay={handlePlay} />
                </motion.li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ResultRow({ item, onPlay }) {
  const timer = useRef(null);
  const longFired = useRef(false);
  const [pinned, setPinned] = useState(false);

  function start() {
    longFired.current = false;
    timer.current = setTimeout(() => {
      longFired.current = true;
      pinItem(item.play);
      setPinned(true);
      // Visual confirmation lasts a beat — the row stays selectable after.
      setTimeout(() => setPinned(false), 1200);
    }, 550);
  }
  function cancel() { clearTimeout(timer.current); }

  return (
    <Card
      isPressable
      onPress={() => {
        if (longFired.current) return; // long-press already pinned; don't also play
        onPlay(item.play);
      }}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => { e.preventDefault(); pinItem(item.play); setPinned(true); setTimeout(() => setPinned(false), 1200); }}
      radius="lg"
      shadow="none"
      classNames={{ base: 'w-full bg-transparent hover:bg-content2/60 active:bg-content2 transition-colors' }}
    >
      <div className="flex items-center gap-3 px-2 py-1.5 w-full min-h-[52px]">
        {item.art ? (
          <Image
            src={item.art}
            alt={item.label}
            width={44}
            height={44}
            radius="sm"
            className="object-cover w-11 h-11 shrink-0 shadow-sm"
          />
        ) : (
          <div className="w-11 h-11 rounded-md bg-content2 shrink-0" />
        )}
        <div className="flex-1 min-w-0 text-left">
          <p className="font-semibold truncate">{item.label}</p>
          <p className="text-tiny text-default-500 truncate">{item.sublabel}</p>
        </div>
        {pinned ? (
          <Chip size="sm" variant="flat" color="primary" classNames={{ content: 'text-tiny font-semibold' }}>
            Pinned
          </Chip>
        ) : item.badge && (
          <Chip
            size="sm"
            variant="flat"
            color={BADGE_COLOR[item.badge] || 'default'}
            classNames={{ content: 'text-tiny uppercase tracking-wider font-semibold' }}
          >
            {item.badge}
          </Chip>
        )}
      </div>
    </Card>
  );
}

const listVariants = {
  hidden: { opacity: 1 },
  show: { opacity: 1, transition: { staggerChildren: 0.04 } },
};
const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 360, damping: 28 } },
};

function normalizeSpotify(s) {
  if (!s) return [];
  const items = [];
  // Spotify returns null entries for tracks/playlists the caller can't access
  // (deleted, region-locked, or owned by the user without `playlist-read-private`).
  // Filter them out before reading fields, otherwise `.name` on null throws.
  // play.{label,sublabel,art,badge} are forwarded to /api/play so the server
  // can log a useful recents tile without a separate metadata call.
  function row(label, sublabel, art, badge, uri) {
    return { label, sublabel, art, badge, play: { uri, label, sublabel, art, badge } };
  }
  for (const t of (s.tracks?.items || []).filter(Boolean)) {
    items.push(row(
      t.name,
      (t.artists || []).filter(Boolean).map((a) => a.name).join(', '),
      t.album?.images?.at(-1)?.url,
      'Track',
      t.uri,
    ));
  }
  for (const p of (s.playlists?.items || []).filter(Boolean)) {
    items.push(row(
      p.name,
      `Playlist · ${p.owner?.display_name || ''}`,
      p.images?.at(-1)?.url,
      'Playlist',
      p.uri,
    ));
  }
  for (const a of (s.albums?.items || []).filter(Boolean)) {
    items.push(row(
      a.name,
      `Album · ${(a.artists || []).filter(Boolean).map((x) => x.name).join(', ')}`,
      a.images?.at(-1)?.url,
      'Album',
      a.uri,
    ));
  }
  return items;
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-default-500">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

// F8: Web Speech API mic. Hidden in browsers without SpeechRecognition (e.g.
// Firefox); on Safari + Chromium it transcribes a single utterance into the
// search box, then leans on the existing debounce to fire the search. The
// container glows + pulses while listening so the wife knows it's hearing
// her — silent listening reads as broken.
function getSR() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function VoiceSearchInput({ q, setQ, onError }) {
  const [listening, setListening] = useState(false);
  const [sr] = useState(() => getSR());
  const recRef = useRef(null);

  function start() {
    const SR = sr;
    if (!SR || listening) return;
    try {
      const rec = new SR();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.continuous = false;
      rec.onresult = (e) => {
        // Live transcript as the user speaks; the final result fires onend.
        let txt = '';
        for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
        setQ(txt.trim());
      };
      rec.onerror = (e) => {
        setListening(false);
        if (e.error && e.error !== 'aborted' && e.error !== 'no-speech') {
          onError?.(`Voice search: ${e.error}`);
        }
      };
      rec.onend = () => setListening(false);
      recRef.current = rec;
      setListening(true);
      rec.start();
    } catch (e) {
      setListening(false);
      onError?.(e.message || 'Voice search failed');
    }
  }
  function stop() {
    try { recRef.current?.stop(); } catch {}
  }
  useEffect(() => () => stop(), []);

  return (
    <label
      className={[
        'flex items-center gap-2.5 px-3.5 rounded-large bg-content2/70 border focus-within:ring-2 focus-within:ring-primary/30 transition-colors min-h-[52px]',
        listening ? 'border-primary ring-2 ring-primary/40' : 'border-white/10 focus-within:border-primary',
      ].join(' ')}
    >
      <SearchIcon />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={listening ? 'Listening…' : 'Search Spotify…'}
        autoComplete="off"
        className="flex-1 bg-transparent outline-none text-base text-foreground placeholder:text-default-500 py-3 min-w-0"
      />
      {sr && (
        <button
          type="button"
          aria-label={listening ? 'Stop voice search' : 'Voice search'}
          title={listening ? 'Tap to stop' : 'Tap and speak'}
          aria-pressed={listening}
          onClick={() => (listening ? stop() : start())}
          className={[
            'shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-colors',
            listening ? 'bg-primary text-primary-foreground' : 'text-default-500 hover:bg-content2',
          ].join(' ')}
        >
          <MicIcon listening={listening} />
        </button>
      )}
    </label>
  );
}

function MicIcon({ listening }) {
  return (
    <motion.svg
      width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      animate={listening ? { scale: [1, 1.15, 1] } : { scale: 1 }}
      transition={listening ? { duration: 0.9, repeat: Infinity } : { duration: 0.2 }}
    >
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </motion.svg>
  );
}
