// Minimal RFC 6455 WebSocket *server* side — zero dependencies (Node has a
// global WebSocket client since v22, but no server). Text frames, ping/pong,
// close, fragmentation and 16/64-bit lengths (task results can be ~2 MB).
"use strict";
const crypto = require("node:crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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

// Incremental parser: feed() chunks, get complete frames back.
function createParser() {
  let buf = Buffer.alloc(0);
  return function feed(chunk) {
    buf = Buffer.concat([buf, chunk]);
    const frames = [];
    for (;;) {
      if (buf.length < 2) break;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) break;
      let data = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        data = Buffer.from(data);
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      }
      frames.push({ fin, opcode, data: Buffer.from(data) });
      buf = buf.subarray(off + maskLen + len);
    }
    return frames;
  };
}

// Upgrade an http "upgrade" request into a tiny connection object:
// { send(text), close(), onmessage(text), onclose() }.
function upgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return null; }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n");
  socket.setNoDelay(true);
  const parse = createParser();
  let partial = null, closed = false;
  const conn = {
    onmessage: null,
    onclose: null,
    send(text) { if (!closed) socket.write(encodeFrame(0x1, text)); },
    close() {
      if (closed) return;
      closed = true;
      try { socket.end(encodeFrame(0x8, Buffer.alloc(0))); } catch (e) {}
      conn.onclose && conn.onclose();
    },
  };
  socket.on("data", (chunk) => {
    let frames;
    try { frames = parse(chunk); } catch (e) { return conn.close(); }
    for (const f of frames) {
      if (f.opcode === 0x8) return conn.close();
      if (f.opcode === 0x9) { socket.write(encodeFrame(0xA, f.data)); continue; }
      if (f.opcode === 0xA) continue;
      if (f.opcode === 0x1 || f.opcode === 0x2) partial = [f.data];
      else if (f.opcode === 0x0 && partial) partial.push(f.data);
      else continue;
      if (f.fin) {
        const text = Buffer.concat(partial).toString("utf8");
        partial = null;
        conn.onmessage && conn.onmessage(text);
      }
    }
  });
  const gone = () => { if (!closed) { closed = true; conn.onclose && conn.onclose(); } };
  socket.on("close", gone);
  socket.on("error", gone);
  return conn;
}

module.exports = { upgrade, encodeFrame, createParser, acceptKey };
