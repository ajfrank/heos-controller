import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// jsdom doesn't ship these — HeroUI + framer-motion + Spinner all touch them.
if (!globalThis.matchMedia) {
  globalThis.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

// React-Aria expects PointerEvent in jsdom for Slider drag. Polyfill from MouseEvent.
if (typeof globalThis.PointerEvent === 'undefined') {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, props = {}) {
      super(type, props);
      this.pointerId = props.pointerId ?? 1;
      this.pointerType = props.pointerType ?? 'mouse';
      this.width = props.width ?? 1;
      this.height = props.height ?? 1;
    }
  };
}

// Element.scrollIntoView is referenced by some HeroUI components and missing in jsdom.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

// Silence framer-motion's noisy "useLayoutEffect" warning under jsdom.
const origError = console.error;
console.error = (...args) => {
  const msg = args[0];
  if (typeof msg === 'string' && msg.includes('useLayoutEffect does nothing on the server')) return;
  origError.call(console, ...args);
};
