// HEOS CLI client.
// Protocol: TCP port 1255, line-delimited (\r\n).
// Commands: heos://group/command?key=val&key=val
// Responses: JSON {heos:{command, result, message}, payload?}
// Unsolicited events arrive on the same connection when registered.

import net from 'node:net';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

const HEOS_PORT = 1255;
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_TARGET = 'urn:schemas-denon-com:device:ACT-Denon:1';
const SSDP_TIMEOUT_MS = 3000;

// Discover a HEOS speaker IP via SSDP M-SEARCH. Resolves to the first responder's IP.
function discover() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        `ST: ${SSDP_TARGET}\r\n\r\n`
    );

    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        sock.close();
        reject(new Error(`No HEOS speaker responded to SSDP within ${SSDP_TIMEOUT_MS}ms`));
      }
    }, SSDP_TIMEOUT_MS);

    sock.on('message', (buf, rinfo) => {
      const text = buf.toString('utf8');
      if (text.includes(SSDP_TARGET) || text.includes('ACT-Denon')) {
        resolved = true;
        clearTimeout(timer);
        sock.close();
        resolve(rinfo.address);
      }
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      try { sock.close(); } catch {}
      reject(err);
    });

    sock.bind(0, () => {
      sock.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR, (err) => {
        if (err) {
          clearTimeout(timer);
          sock.close();
          reject(err);
        }
      });
    });
  });
}

class HeosClient extends EventEmitter {
  constructor() {
    super();
    this.host = null;
    this.socket = null;
    this.buffer = '';
    // Pending non-event responses are matched in FIFO by command name.
    // HEOS guarantees in-order response on a single connection.
    this.pending = [];
    this.reconnectTimer = null;
  }

  /** @param {string} host - HEOS speaker IP. Opens the TCP connection and subscribes to change events. */
  async connect(host) {
    this.host = host;
    await this._open();
    // Register for change events so the UI can stay in sync.
    await this.send('system/register_for_change_events', { enable: 'on' });
  }

  _open() {
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      sock.setKeepAlive(true, 30_000);

      const onConnect = () => {
        sock.removeListener('error', onError);
        // Persistent error handler. Without this, an idle ETIMEDOUT (seen
        // overnight on the wall tablet) bubbles as an uncaught 'error' event
        // and kills the process before 'close' can trigger reconnect. Log,
        // fail any in-flight commands, and let 'close' fire reconnect.
        sock.on('error', (err) => {
          console.warn('[heos] socket error:', err.code || err.message);
          for (const p of this.pending.splice(0)) {
            p.reject(new Error(`HEOS socket error: ${err.code || err.message}`));
          }
          try { sock.destroy(); } catch {}
        });
        this.socket = sock;
        this.emit('connected', this.host);
        resolve();
      };
      const onError = (err) => reject(err);

      sock.once('connect', onConnect);
      sock.once('error', onError);

      sock.on('data', (chunk) => this._onData(chunk));
      sock.on('close', () => {
        this.socket = null;
        // Drain any in-flight commands so callers fail fast instead of hanging
        // until their per-command 8s timeout. Critical for the overnight
        // ETIMEDOUT → reconnect path: stale entries left in `pending` would
        // claim FIFO responses on the new socket and mis-route them.
        const stale = this.pending;
        this.pending = [];
        for (const entry of stale) {
          if (entry.cancelled) continue;
          entry.cancelled = true;
          try { entry.reject(new Error('HEOS connection lost')); } catch {}
        }
        this.emit('disconnected');
        this._scheduleReconnect();
      });

      sock.connect(HEOS_PORT, this.host);
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || !this.host) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this._open();
        await this.send('system/register_for_change_events', { enable: 'on' });
      } catch {
        this._scheduleReconnect();
      }
    }, 5000);
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    // M7: a malformed remote could feed us bytes without a newline forever.
    // 64KB is far above any legitimate HEOS frame; drop and resync if exceeded.
    if (this.buffer.length > 65536) {
      console.warn(`[heos] line buffer exceeded 64KB, dropping ${this.buffer.length} bytes`);
      this.buffer = '';
      return;
    }
    let nl;
    while ((nl = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 2);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      const cmd = frame?.heos?.command || '';
      // Events use the "event/..." prefix and never resolve a pending command.
      if (cmd.startsWith('event/')) {
        this.emit('event', frame);
        continue;
      }
      // M6: HEOS guarantees in-order responses on a single connection, so
      // strict FIFO is the right model. The previous "match by command name"
      // logic broke if two same-name commands were in flight (whichever
      // landed first claimed the wrong waiter).
      // Skip cancelled (timed-out) entries — their response still arrives in
      // FIFO order on the wire, so each cancelled entry consumes exactly one
      // frame before the next live waiter sees its own response. Without this
      // skip, a single timeout would corrupt every subsequent response.
      const target = this.pending.shift();
      if (!target) continue;
      if (target.cancelled) continue;
      const result = frame?.heos?.result;
      if (result === 'fail') {
        const msg = frame?.heos?.message || '';
        // Translate the most common opaque failures into something a human can act on.
        if (cmd === 'group/set_group' && /syserrno=-9/.test(msg)) {
          target.reject(new Error(
            "These zones can't be grouped together — they likely share a multi-zone amp, or one is offline. Try a different combination."
          ));
        } else if (/eid=13/.test(msg)) {
          // "Processing previous command". Hits when HEOS is mid-internal-state
          // change (e.g. just woke a speaker via Spotify Connect, or another
          // client is acting). _doApplyGroup catches EID13 and retries once
          // before surfacing the friendlier message.
          const err = new Error(
            "HEOS is busy processing another command — give it a second and try again."
          );
          err.code = 'EID13';
          target.reject(err);
        } else if (/eid=11/.test(msg)) {
          // "System busy" — distinct from eid=13 (per-command queue) but
          // similar UX: short delay then retry. _doApplyGroup catches and
          // retries; surfaced text mirrors EID13 so the wife sees the same
          // hint either way.
          const err = new Error(
            "HEOS is busy — give it a second and try again."
          );
          err.code = 'EID11';
          target.reject(err);
        } else if (cmd === 'group/set_group' && /eid=7/.test(msg)) {
          // "Command Couldn't Be Executed" — usually a transient speaker state
          // (just woke from Spotify Connect, mid-handoff, etc.). _doApplyGroup
          // catches this code and retries once before surfacing.
          const err = new Error(
            "HEOS couldn't complete the grouping — a speaker may be asleep or busy. Try again in a moment."
          );
          err.code = 'EID7';
          target.reject(err);
        } else if (/eid=10/.test(msg)) {
          // "Unrecognized command" — almost certainly a code bug (typo in a
          // command path or an unsupported parameter for this firmware), not
          // something the user can fix. Surface that explicitly so we can
          // tell it apart from the transient-busy codes during debugging.
          const err = new Error(
            `HEOS rejected ${cmd} as unrecognized — the speaker firmware may not support this command.`
          );
          err.code = 'EID10';
          target.reject(err);
        } else if (/eid=12/.test(msg)) {
          // "System error" — generic internal failure. Not retriable from our
          // side; usually means a speaker rebooted mid-command or lost its
          // mesh link. Tag with a code so callers can distinguish.
          const err = new Error(
            "HEOS reported an internal error — a speaker may have lost its connection. Try again in a moment."
          );
          err.code = 'EID12';
          target.reject(err);
        } else {
          target.reject(new Error(`HEOS ${cmd} failed: ${msg || 'unknown'}`));
        }
      } else {
        target.resolve(frame);
      }
    }
  }

  /** @param {string} command - HEOS command path (e.g., 'player/get_players'). @param {object} params - URL-style params. @returns {Promise<object>} resolved frame. */
  send(command, params = {}) {
    if (!this.socket) return Promise.reject(new Error('HEOS not connected'));
    // HEOS expects URL-style encoding but with commas left raw — encoded `%2C` between pids
    // is rejected by some firmware as a system error. Restore raw commas after encoding.
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C/g, ',')}`)
      .join('&');
    const line = `heos://${command}${qs ? '?' + qs : ''}\r\n`;
    return new Promise((resolve, reject) => {
      const entry = { command, resolve, reject, cancelled: false };
      this.pending.push(entry);
      this.socket.write(line, 'utf8', (err) => {
        if (err) {
          // Remove our pending entry on write failure.
          const idx = this.pending.indexOf(entry);
          if (idx >= 0) this.pending.splice(idx, 1);
          reject(err);
        }
      });
      // Per-command timeout so a flaky speaker doesn't wedge the queue. We
      // mark-and-keep instead of splice — splicing would shift later entries
      // up and then the next response (which still arrives in FIFO order)
      // would land on the wrong waiter. _onData skips cancelled entries.
      setTimeout(() => {
        if (entry.cancelled) return;
        const idx = this.pending.indexOf(entry);
        if (idx === -1) return; // already resolved
        entry.cancelled = true;
        reject(new Error(`HEOS ${command} timed out`));
      }, 8000);
    });
  }

  // ---- High-level helpers ----

  /** @returns {Promise<Array<{pid:string,name:string,model?:string,ip?:string}>>} discovered players. */
  async getPlayers() {
    const r = await this.send('player/get_players');
    return r.payload || [];
  }

  /** @returns {Promise<Array<{gid:string,players:Array<{pid:string}>}>>} current HEOS groups. */
  async getGroups() {
    const r = await this.send('group/get_groups');
    return r.payload || [];
  }

  /** @param {string} pid @returns {Promise<object|null>} now-playing payload or null. */
  async getNowPlaying(pid) {
    const r = await this.send('player/get_now_playing_media', { pid });
    return r.payload || null;
  }

  /** @param {string} pid @returns {Promise<string|null>} 'play'|'pause'|'stop'|null. */
  async getPlayState(pid) {
    const r = await this.send('player/get_play_state', { pid });
    return r?.heos?.message?.match(/state=(\w+)/)?.[1] || null;
  }

  /** @param {string} pid @param {'play'|'pause'|'stop'} state */
  async setPlayState(pid, state) {
    return this.send('player/set_play_state', { pid, state });
  }

  /** @param {string} pid */
  async playNext(pid) { return this.send('player/play_next', { pid }); }
  /** @param {string} pid */
  async playPrevious(pid) { return this.send('player/play_previous', { pid }); }

  /** @param {string} pid @returns {Promise<number|null>} 0-100 volume level. */
  async getVolume(pid) {
    const r = await this.send('player/get_volume', { pid });
    const m = r?.heos?.message?.match(/level=(\d+)/);
    return m ? Number(m[1]) : null;
  }

  /** @param {string} pid @param {number} level - clamped to 0-100, rounded. */
  async setVolume(pid, level) {
    return this.send('player/set_volume', { pid, level: Math.max(0, Math.min(100, Math.round(level))) });
  }

  /** @param {string[]} pids - first is leader; single-element array ungroups. */
  async setGroup(pids) {
    return this.send('group/set_group', { pid: pids.join(',') });
  }

  /**
   * Coalesces rapid toggles. HEOS rejects overlapping group/set_group with
   * eid=13 ("Processing previous command"), so when the user taps several
   * zones in quick succession we serialize: at most one apply in flight, and
   * any further calls collapse to a single queued apply with the LATEST
   * desired pids (intermediate states are skipped because the user only
   * cares about the final selection). Returns a promise that resolves once
   * the latest desired state has been applied (or rejects if it failed).
   * @param {string[]} pids
   */
  applyGroup(pids) {
    if (this._groupInflight) {
      if (this._groupPending) {
        // Overwrite pending desired pids — the user has toggled again, so
        // the previously queued state is already stale.
        this._groupPending.pids = pids;
        return this._groupPending.promise;
      }
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      this._groupPending = { pids, promise, resolve, reject };
      return promise;
    }
    this._groupInflight = (async () => {
      try {
        await this._doApplyGroup(pids);
      } finally {
        const next = this._groupPending;
        this._groupPending = null;
        this._groupInflight = null;
        if (next) {
          // Run the latest queued desired state and forward the result.
          this.applyGroup(next.pids).then(next.resolve, next.reject);
        }
      }
    })();
    return this._groupInflight;
  }

  /** Idempotent group apply — no-op when current state already matches. @param {string[]} pids */
  async _doApplyGroup(pids) {
    if (!pids.length) return;
    const groups = await this.getGroups();
    const idStr = (x) => String(x);
    const desired = new Set(pids.map(idStr));

    const containing = groups.find((g) =>
      (g.players || []).some((p) => desired.has(idStr(p.pid)))
    );

    if (pids.length === 1) {
      // Want a solo player. If it isn't in any multi-player group, no-op.
      if (!containing || (containing.players || []).length <= 1) return;
      return this.setGroup(pids);
    }

    // Want a group. Compare desired pids against the currently-existing group.
    const current = new Set((containing?.players || []).map((p) => idStr(p.pid)));
    if (current.size === desired.size && [...desired].every((p) => current.has(p))) return;
    try {
      return await this.setGroup(pids);
    } catch (e) {
      // eid=7 = "Command Couldn't Be Executed". Two known causes here:
      //   (a) transient — a speaker just transitioned (Spotify Connect wake);
      //   (b) the desired leader is currently a slave in another group, and
      //       HEOS refuses to promote a slave straight to leader of a new
      //       group. Ungroup the leader first to clear (b), then retry. A
      //       short delay also covers (a). One retry only — if it still
      //       fails, surface the friendlier message from _onData.
      if (e.code === 'EID7') {
        const leader = pids[0];
        const leaderGroup = groups.find((g) =>
          (g.players || []).some((p) => idStr(p.pid) === idStr(leader)),
        );
        if (leaderGroup && (leaderGroup.players || []).length > 1) {
          try { await this.setGroup([leader]); } catch { /* best-effort */ }
        }
        await new Promise((r) => setTimeout(r, 1500));
        return this.setGroup(pids);
      }
      // eid=13 = "Processing previous command", eid=11 = "System busy" — both
      // are transient busy signals (often Spotify Connect wake fallout). Wait
      // briefly and retry once; the busy window is typically <1s.
      if (e.code === 'EID13' || e.code === 'EID11') {
        await new Promise((r) => setTimeout(r, 800));
        return this.setGroup(pids);
      }
      throw e;
    }
  }

}

let singleton = null;

export async function getHeos() {
  if (singleton) return singleton;
  const host = process.env.HEOS_HOST || (await discover());
  console.log(`[heos] connecting to ${host}`);
  const client = new HeosClient();
  await client.connect(host);
  console.log(`[heos] connected`);
  singleton = client;
  return client;
}

export { HeosClient, discover };
