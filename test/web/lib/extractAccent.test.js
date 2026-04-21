// F7: extractAccent should return an HSL triplet that can slot into HeroUI's
// --heroui-primary variable, ignore desaturated/very-dark/very-light pixels,
// and fall back to null when no usable color is present.
//
// jsdom doesn't paint to canvas, so we stub Image + canvas.getContext to feed
// a synthetic pixel buffer. The cache also means we vary URLs per test to
// avoid cross-test contamination.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractAccent } from '../../../web/src/lib/extractAccent.js';

function rgbaBuffer(rgba) {
  const px = 32 * 32;
  const buf = new Uint8ClampedArray(px * 4);
  for (let i = 0; i < px; i++) {
    buf[i * 4] = rgba[0];
    buf[i * 4 + 1] = rgba[1];
    buf[i * 4 + 2] = rgba[2];
    buf[i * 4 + 3] = rgba[3];
  }
  return buf;
}

function stubCanvas(rgba) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    drawImage: () => {},
    getImageData: () => ({ data: rgbaBuffer(rgba) }),
  }));
}

function stubImageOk() {
  // Image.onload is queued so we let extractAccent see a "loaded" image.
  Object.defineProperty(global.Image.prototype, 'src', {
    configurable: true,
    set() { setTimeout(() => this.onload && this.onload(), 0); },
  });
}

function stubImageError() {
  Object.defineProperty(global.Image.prototype, 'src', {
    configurable: true,
    set() { setTimeout(() => this.onerror && this.onerror(new Error('cors')), 0); },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('extractAccent', () => {
  it('returns null for a falsy URL without touching the network', async () => {
    expect(await extractAccent(null)).toBeNull();
    expect(await extractAccent('')).toBeNull();
  });

  it('returns an HSL triplet for a vivid red image', async () => {
    stubImageOk();
    stubCanvas([220, 30, 40, 255]);
    const accent = await extractAccent('http://example.test/red.jpg');
    expect(accent).toMatch(/^\d+ \d+% \d+%$/);
    const hue = Number(accent.split(' ')[0]);
    // Red sits near 0/360.
    expect(hue < 20 || hue > 340).toBe(true);
  });

  it('returns null for a fully gray image (no usable hue)', async () => {
    stubImageOk();
    stubCanvas([128, 128, 128, 255]);
    expect(await extractAccent('http://example.test/gray.jpg')).toBeNull();
  });

  it('returns null when the image fails to load (CORS-blocked art)', async () => {
    stubImageError();
    expect(await extractAccent('http://example.test/cors.jpg')).toBeNull();
  });

  it('caches results by URL so a re-fetch is free', async () => {
    stubImageOk();
    stubCanvas([30, 200, 60, 255]);
    const first = await extractAccent('http://example.test/cached.jpg');
    // Second call should hit the cache; flip the canvas stub to prove it.
    stubCanvas([10, 10, 10, 255]);
    const second = await extractAccent('http://example.test/cached.jpg');
    expect(second).toBe(first);
  });
});
