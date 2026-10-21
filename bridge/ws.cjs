// Minimal RFC 6455 WebSocket *server* side — zero dependencies (Node has a
// global WebSocket client since v22, but no server). Text frames, ping/pong,
// close, fragmentation and 16/64-bit lengths (task results can be ~2 MB).
// Hardening: chunks are kept as a list and joined once per complete frame
// (no quadratic re-copying); frames/messages above maxPayload (16 MB default,
// env WEBCLAW_WS_MAX_BYTES) close with 1009, unmasked client frames with 1002.
"use strict";
const crypto = require("node:crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX = Number(process.env.WEBCLAW_WS_MAX_BYTES) || 16 * 1024 * 1024;

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, data]);
}

const wsError = (code, message) => Object.assign(new Error(message), { wsCode: code });

// Incremental parser: feed() chunks, get complete frames back. Throws an error
// carrying wsCode (1009 too big, 1002 protocol) — the caller closes the socket.
function createParser(opts = {}) {
  const maxPayload = opts.maxPayload || DEFAULT_MAX;
  const requireMask = !!opts.requireMask;
  const chunks = [];
  let total = 0;
  // the first n buffered bytes as one buffer, without consuming (n ≤ 14)
  function peek(n) {
    if (chunks[0].length >= n) return chunks[0];
    const parts = []; let got = 0;
    for (const c of chunks) { parts.push(c); got += c.length; if (got >= n) break; }
    return Buffer.concat(parts, got);
  }
  // consume exactly n bytes (at most one copy)
  function take(n) {
    total -= n;
    if (chunks[0].length >= n) {
      const out = chunks[0].subarray(0, n);
      if (chunks[0].length === n) chunks.shift(); else chunks[0] = chunks[0].subarray(n);
      return out;
    }
    const out = Buffer.allocUnsafe(n); let off = 0;
    while (off < n) {
      const c = chunks[0], k = Math.min(c.length, n - off);
      c.copy(out, off, 0, k); off += k;
      if (k === c.length) chunks.shift(); else chunks[0] = c.subarray(k);
    }
    return out;
  }
  return function feed(chunk) {
    if (chunk && chunk.length) { chunks.push(chunk); total += chunk.length; }
    const frames = [];
    for (;;) {
      if (total < 2) break;
      const h = peek(Math.min(total, 14));
      const fin = (h[0] & 0x80) !== 0;
      const opcode = h[0] & 0x0f;
      const masked = (h[1] & 0x80) !== 0;
      if (requireMask && !masked) throw wsError(1002, "unmasked client frame");
      let len = h[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (h.length < 4) break; len = h.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (h.length < 10) break;
        const big = h.readBigUInt64BE(2);
        if (big > BigInt(maxPayload)) throw wsError(1009, "frame too big");
        len = Number(big); off = 10;
      }
      if (len > maxPayload) throw wsError(1009, "frame too big");
      const maskLen = masked ? 4 : 0;
      if (total < off + maskLen + len) break;
      take(off);
      const mask = masked ? Buffer.from(take(4)) : null;
      const data = Buffer.from(len ? take(len) : Buffer.alloc(0)); // own the bytes (take() may return a view)
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      frames.push({ fin, opcode, data });
    }
    return frames;
  };
}

// Upgrade an http "upgrade" request into a tiny connection object:
// { send(text), close([code]), onmessage(text), onclose() }. `head` is the
// first bytes after the HTTP request that Node hands to the "upgrade" event.
function upgrade(req, socket, head, opts = {}) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return null; }
  const maxPayload = opts.maxPayload || DEFAULT_MAX;
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n");
  socket.setNoDelay(true);
  const parse = createParser({ maxPayload, requireMask: true });
  let partial = null, partialLen = 0, closed = false;
  const conn = {
    onmessage: null,
    onclose: null,
    send(text) { if (!closed) try { socket.write(encodeFrame(0x1, text)); } catch (e) {} },
    // code (1002 protocol error, 1009 too big) → close frame with status, then destroy
    close(code) {
      if (closed) return;
      closed = true;
      const body = code ? Buffer.from([code >> 8, code & 0xff]) : Buffer.alloc(0);
      try { socket.end(encodeFrame(0x8, body)); } catch (e) {}
      if (code) setTimeout(() => socket.destroy(), 50).unref();
      try { conn.onclose && conn.onclose(); } catch (e) {}
    },
  };
  // a throwing / rejecting handler must never take the process down
  const deliver = (text) => {
    try {
      const r = conn.onmessage && conn.onmessage(text);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch (e) {}
  };
  function onData(chunk) {
    if (closed) return;
    let frames;
    try { frames = parse(chunk); } catch (e) { return conn.close(e.wsCode || 1002); }
    for (const f of frames) {
      if (f.opcode === 0x8) return conn.close();
      if (f.opcode === 0x9) { if (!closed) socket.write(encodeFrame(0xA, f.data)); continue; }
      if (f.opcode === 0xA) continue;
      if (f.opcode === 0x1 || f.opcode === 0x2) { partial = [f.data]; partialLen = f.data.length; }
      else if (f.opcode === 0x0 && partial) { partial.push(f.data); partialLen += f.data.length; }
      else continue;
      if (partialLen > maxPayload) { partial = null; return conn.close(1009); }
      if (f.fin) {
        const text = Buffer.concat(partial, partialLen).toString("utf8");
        partial = null; partialLen = 0;
        deliver(text);
      }
    }
  }
  socket.on("data", onData);
  const gone = () => { if (!closed) { closed = true; try { conn.onclose && conn.onclose(); } catch (e) {} } };
  socket.on("close", gone);
  socket.on("error", gone);
  // bytes that arrived with the handshake; next tick so the caller can set onmessage first
  if (head && head.length) process.nextTick(() => onData(Buffer.from(head)));
  return conn;
}

module.exports = { upgrade, encodeFrame, createParser, acceptKey, DEFAULT_MAX };
