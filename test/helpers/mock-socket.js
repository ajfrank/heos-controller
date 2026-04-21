// Minimal stand-in for net.Socket used by HeosClient.
// Inherits EventEmitter, exposes setKeepAlive/connect/write/destroy.
// Drive incoming bytes with .feed(str|Buffer); inspect outgoing with .written.

import { EventEmitter } from 'node:events';

export class MockSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
    this._writeHandler = null;
  }

  setKeepAlive() { /* no-op */ }

  connect(_port, _host, cb) {
    // Defer so the caller can attach 'connect' / 'error' listeners first.
    setImmediate(() => {
      this.emit('connect');
      cb?.();
    });
  }

  write(data, _enc, cb) {
    this.written.push(typeof data === 'string' ? data : data.toString('utf8'));
    if (this._writeHandler) {
      try { this._writeHandler(data); } catch (e) { cb?.(e); return false; }
    }
    cb?.();
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    setImmediate(() => this.emit('close'));
  }

  // ---- test-only helpers ----

  feed(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this.emit('data', buf);
  }

  // Auto-respond to writes by feeding the matching response.
  // Handler receives the written line; return a string/Buffer (or array of) to feed back.
  // Feeds synchronously: HeosClient.send() registers its pending entry before
  // calling write(), so the data event can be handled inline. Deferring would
  // require advancing fake timers in every test.
  onWrite(handler) {
    this._writeHandler = (data) => {
      const out = handler(typeof data === 'string' ? data : data.toString('utf8'));
      if (out == null) return;
      const arr = Array.isArray(out) ? out : [out];
      for (const x of arr) this.feed(x);
    };
  }
}
