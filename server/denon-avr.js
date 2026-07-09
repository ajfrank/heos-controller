// Denon/Marantz AVR control-protocol client.
//
// Separate from HEOS CLI (port 1255) — this is the classic Denon AVR remote
// protocol on TCP port 23 (telnet-style), one command per line terminated by
// \r. Used for the one thing HEOS CLI can't do: force the AVR's Main Zone on
// so Spotify Connect audio routes to the physical speaker terminals the user
// expects instead of Zone 2 (which the AVR sometimes defaults to when waking
// from HEOS/Network source on the AVR-X series).
//
// Command reference: search "Denon AVR Remote Control Protocol" — Denon and
// Marantz publish per-model PDFs. Common commands: ZMON (Main Zone On),
// Z2OFF (Zone 2 Off), MSNET (select Network source on Main Zone).

import net from 'node:net';

const AVR_PORT = 23;
const AVR_TIMEOUT_MS = 2000;

/**
 * Send a single Denon control command. Fire-and-forget for power/zone ops —
 * writes the command, half-closes with FIN, and waits for the AVR to close
 * its side. Rejects on connect failure or timeout so best-effort callers can
 * log without hanging.
 * @param {string} host - AVR IP address
 * @param {string} cmd - control command, e.g. "ZMON"
 * @returns {Promise<void>}
 */
export function sendCommand(host, cmd) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => done(new Error(`AVR ${host} ${cmd} timed out after ${AVR_TIMEOUT_MS}ms`)),
      AVR_TIMEOUT_MS,
    );
    sock.once('error', (e) => done(e));
    sock.once('close', () => done());
    sock.connect(AVR_PORT, host, () => {
      sock.write(`${cmd}\r`, 'ascii');
      // Half-close: FIN goes out after the write drains. Denon AVRs typically
      // ack a one-off command and close their side, which trips our 'close'
      // handler. If the AVR keeps the connection open (some Marantz firmware
      // does), the timeout above catches it.
      sock.end();
    });
  });
}
