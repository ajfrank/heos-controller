import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

// 48px gaussian blur is GPU-heavy on older iPads (Air 2 / Pro 9.7"). When the
// user has prefers-reduced-motion set, drop the blur and just darken — same
// readability for the foreground card without the per-frame filter cost.
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e) => setReduced(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);
  return reduced;
}

export default function Backdrop({ artUrl }) {
  const [layers, setLayers] = useState([]);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (!artUrl) {
      setLayers([]);
      return;
    }
    setLayers((cur) => {
      if (cur.length && cur[cur.length - 1].url === artUrl) return cur;
      return [...cur.slice(-1), { url: artUrl, key: `${Date.now()}-${Math.random()}` }];
    });
  }, [artUrl]);

  useEffect(() => {
    if (layers.length <= 1) return;
    const t = setTimeout(() => setLayers((cur) => cur.slice(-1)), 800);
    return () => clearTimeout(t);
  }, [layers]);

  return (
    <div className="fixed inset-0 -z-10 overflow-hidden bg-background">
      <AnimatePresence>
        {layers.map((l) => (
          <motion.div
            key={l.key}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            className="absolute -inset-[10%] bg-cover bg-center scale-110"
            style={{
              backgroundImage: `url(${l.url})`,
              filter: reducedMotion
                ? 'brightness(0.4)'
                : 'blur(48px) saturate(140%) brightness(0.45)',
              willChange: 'opacity',
            }}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
