// Pulls the dominant non-gray hue out of an album-art URL and returns it as an
// HSL triplet that slots into HeroUI's `--heroui-primary` variable
// (e.g. "141 73% 42%"). Returns null on any failure (CORS, network, all-gray
// art) so callers can fall back to the default theme color.
//
// Approach: draw the image into a 32×32 offscreen canvas, walk every pixel,
// bucket by hue (12 buckets = 30° each), pick the bucket with the most weight,
// then return the average HSL of that bucket clamped to a vivid lightness. We
// use weight = saturation × min(lightness, 1-lightness) so dark/desaturated
// pixels (background, text) don't drown out a small vibrant accent.

const SIZE = 32;
const HUE_BUCKETS = 12;
const LOAD_TIMEOUT_MS = 5000;

const cache = new Map(); // url -> "H S% L%" | null

export async function extractAccent(url) {
  if (!url) return null;
  if (cache.has(url)) return cache.get(url);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
    const accent = pickAccent(data);
    cache.set(url, accent);
    return accent;
  } catch {
    cache.set(url, null);
    return null;
  }
}

function loadImage(url) {
  // Race load against a timeout — a hung CDN response would otherwise leave the
  // previous accent stuck on screen forever (the caller awaits this promise).
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => {
      img.src = ''; // abort the in-flight load
      reject(new Error('image load timeout'));
    }, LOAD_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('image load failed')); };
    img.src = url;
  });
}

function pickAccent(data) {
  const buckets = Array.from({ length: HUE_BUCKETS }, () => ({ w: 0, h: 0, s: 0, l: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (s < 0.2) continue;
    if (l < 0.15 || l > 0.9) continue;
    const w = s * Math.min(l, 1 - l);
    const idx = Math.min(HUE_BUCKETS - 1, Math.floor((h / 360) * HUE_BUCKETS));
    const b = buckets[idx];
    b.w += w;
    b.h += h * w;
    b.s += s * w;
    b.l += l * w;
  }
  let best = null;
  for (const b of buckets) if (b.w > 0 && (!best || b.w > best.w)) best = b;
  if (!best) return null;
  const h = Math.round(best.h / best.w);
  const s = clamp(Math.round((best.s / best.w) * 100), 50, 90);
  const l = clamp(Math.round((best.l / best.w) * 100), 38, 58);
  return `${h} ${s}% ${l}%`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
      case g: h = ((b - r) / d + 2) * 60; break;
      default: h = ((r - g) / d + 4) * 60;
    }
  }
  return [h, s, l];
}
