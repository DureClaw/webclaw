// webclaw local mini-bus — standalone mode, no DureClaw server needed.
//
// Speaks just enough of the DureClaw bus for the extension (Phoenix v2
// WebSocket frames) and for clients (the same REST surface as the real bus),
// so the extension needs no code change: point its "Bus" at this.
//
//   WS   /socket/websocket?vsn=2.0.0&token=<secret>   phx_join / heartbeat /
//        task.result / task.ack in; task.assign (+ task.result echo) out
//   REST GET  /api/health                       (no auth)
//        GET  /api/presence[?work_key=]         joined nodes
//        POST /api/task {to, work_key, task_id?, instructions}
//        GET  /api/task/:id · /api/task-result/:id   200 result | 202 pending
//   CDP  /cdp/<cdp-token>/…   (cdp-token = HMAC-SHA256(secret, "webclaw-cdp"),
//        so a CDP URL pasted into a tool never leaks the master secret)
//
// Security: binds loopback only (non-loopback hosts need allowRemote); every
// call needs the secret (Bearer / ?token=). WebSockets have no CORS, so
// upgrades from any http(s) page origin are refused — only extension
// (chrome-extension://) or origin-less (Node) clients may connect; otherwise
// any website could drive the browser. No input may crash the process: every
// handler is wrapped and answers 400 / closes the socket instead.
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { upgrade } = require("./ws.cjs");
const { createCdpEndpoint } = require("./cdp-relay.cjs");

const RESULT_CAP = 500; // task ids kept in memory
const PER_TASK_CAP = 200; // results kept per task id (HUD inbox grows forever otherwise)
const MAX_BODY = 4 * 1024 * 1024; // REST request bodies
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// CDP-only credential derived from the secret (also printed by `webclaw cdp-url`)
function cdpToken(secret) {
  return crypto.createHmac("sha256", String(secret)).update("webclaw-cdp").digest("base64url");
}

// constant-time compare on bytes (a same-length non-ASCII string has a
// different byte length — timingSafeEqual would throw)
function safeEqual(token, expected) {
  if (typeof token !== "string" || !token) return false;
  const a = Buffer.from(token, "utf8");
  return a.length === expected.length && crypto.timingSafeEqual(a, expected);
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return null; } }

function createMiniBus(opts) {
  const secret = opts.secret;
  if (!secret) throw new Error("mini-bus needs a secret");
  const log = opts.log || (() => {});
  const sockets = new Set(); // { conn, topics:Set, name, meta }
  const cdpConns = new Set();
  const results = new Map(); // task_id → [result…]   (insertion order = recency)
  const status = new Map(); // task_id → { status, to, queued_at }
  const secretBuf = Buffer.from(String(secret), "utf8");
  const cdpBuf = Buffer.from(cdpToken(secret), "utf8");
  let boundHost = "127.0.0.1";

  const authOk = (token) => safeEqual(token, secretBuf);

  // recency-ordered maps: delete + set moves the id to the newest end
  function touch(map, id, value) { map.delete(id); map.set(id, value); }
  function evict() {
    while (results.size > RESULT_CAP) { const id = results.keys().next().value; results.delete(id); status.delete(id); }
    while (status.size > RESULT_CAP * 2) { const id = status.keys().next().value; status.delete(id); results.delete(id); }
  }
  function remember(taskId, result) {
    const list = results.get(taskId) || [];
    list.push(result);
    if (list.length > PER_TASK_CAP) list.splice(0, list.length - PER_TASK_CAP);
    touch(results, taskId, list);
    evict();
  }
  function setStatus(taskId, st) { touch(status, taskId, st); evict(); }

  function presences(topic) {
    const out = {};
    for (const s of sockets) if (s.topics.has(topic) && s.name) (out[s.name] = out[s.name] || { metas: [] }).metas.push(s.meta);
    return out;
  }

  function sendToNode(name, event, payload) {
    for (const s of sockets) {
      if (s.name !== name || !s.topics.size) continue;
      s.conn.send(JSON.stringify([null, null, [...s.topics][0], event, payload]));
      return true;
    }
    return false;
  }
  const cdp = createCdpEndpoint({ sendToNode, log });
  function webclawNodes() { return [...new Set([...sockets].map((s) => s.name).filter((n) => /^webclaw@/.test(n || "")))]; }

  // Skill registry (same contract as the DureClaw bus /api/skill-registry),
  // persisted to opts.registryFile — used to share learnings between nodes.
  let registry = { skills: {} };
  try { if (opts.registryFile) registry = JSON.parse(fs.readFileSync(opts.registryFile, "utf8")); } catch (e) {}
  if (!registry || typeof registry !== "object" || !registry.skills || typeof registry.skills !== "object") registry = { skills: {} };
  const saveRegistry = () => {
    if (!opts.registryFile) return;
    try { fs.writeFileSync(opts.registryFile, JSON.stringify(registry), { mode: 0o600 }); fs.chmodSync(opts.registryFile, 0o600); } catch (e) {}
  };

  function broadcast(topic, event, payload, except) {
    const frame = JSON.stringify([null, null, topic, event, payload]);
    for (const s of sockets) if (s !== except && s.topics.has(topic)) s.conn.send(frame);
  }

  function onFrame(s, text) {
    let f;
    try { f = JSON.parse(text); } catch (e) { return; }
    if (!Array.isArray(f) || f.length !== 5) return;
    const [joinRef, ref, topic, event, rawPayload] = f;
    if (typeof topic !== "string" || typeof event !== "string") return;
    const payload = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload) ? rawPayload : {};
    const reply = (response) => s.conn.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: response || {} }]));
    if (topic === "phoenix" && event === "heartbeat") return reply({});
    if (event === "phx_join") {
      if (!/^work:/.test(topic)) return s.conn.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "error", response: { reason: "unmatched topic" } }]));
      const p = payload;
      s.topics.add(topic);
      s.name = (typeof p.agent_name === "string" && p.agent_name) || s.name || "unknown@unknown";
      s.meta = { role: p.role || "unknown", machine: p.machine || "unknown", capabilities: Array.isArray(p.capabilities) ? p.capabilities : [],
        version: p.version, work_key: topic.slice(5), online_since: new Date().toISOString() };
      log("join " + s.name + " → " + topic);
      return reply({ presences: presences(topic) });
    }
    if (event === "phx_leave") { s.topics.delete(topic); return reply({}); }
    if (event === "cdp.reply" || event === "cdp.event") { cdp.onNodeFrame(s.name, event, payload); return reply({}); }
    if (event === "task.result" || event === "task.ack" || event === "task.blocked") {
      const msg = Object.assign({}, payload, { from: s.name, event, ts: new Date().toISOString() });
      if (event !== "task.ack" && msg.task_id != null && msg.task_id !== "") {
        msg.task_id = String(msg.task_id);
        remember(msg.task_id, msg);
        if (event === "task.result") setStatus(msg.task_id, Object.assign(status.get(msg.task_id) || {}, { status: msg.status === "done" ? "done" : "failed" }));
      }
      broadcast(topic, event, msg, s);
      return reply({});
    }
    reply({});
  }

  function send(res, code, obj, extra) {
    const body = JSON.stringify(obj);
    res.writeHead(code, Object.assign({ "content-type": "application/json", "content-length": Buffer.byteLength(body) }, extra || {}));
    res.end(body);
  }

  const TOO_LARGE = Symbol("too large");
  function readBody(req) {
    return new Promise((resolve) => {
      // too large: answer 413 and keep draining (discarding) so the client sees the answer
      if (Number(req.headers["content-length"]) > MAX_BODY) { req.resume(); return resolve(TOO_LARGE); }
      const chunks = [];
      let size = 0, done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      req.on("data", (c) => {
        if (done) return;
        size += c.length;
        if (size > MAX_BODY) { chunks.length = 0; req.resume(); return finish(TOO_LARGE); }
        chunks.push(c);
      });
      req.on("end", () => { try { finish(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { finish(null); } });
      req.on("error", () => finish(null));
    });
  }
  const tooLarge = (res) => send(res, 413, { error: "body too large (max " + MAX_BODY + " bytes)" });

  function resultBody(id) {
    const list = results.get(id);
    if (!list || !list.length) return null;
    const st = status.get(id) || {};
    return list.length === 1 ? Object.assign({}, st, list[0]) : Object.assign({}, st, { task_id: id, results: list, count: list.length });
  }

  // DNS-rebinding guard: only loopback Host headers (or the explicitly bound remote host)
  const hostOk = (req) => {
    const h = String(req.headers.host || "");
    if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h)) return true;
    if (!opts.allowRemote) return false;
    const name = h.replace(/:\d+$/, "");
    return name === boundHost || name === "[" + boundHost + "]";
  };
  // /cdp/<cdp-token>/… → the rest of the path, or null (wrong token → falls through to REST auth)
  const cdpPath = (pathname) => {
    const m = pathname.match(/^\/cdp\/([^/]+)(\/.*)?$/);
    if (!m) return null;
    const tok = safeDecode(m[1]);
    return tok !== null && safeEqual(tok, cdpBuf) ? (m[2] || "/") : null;
  };
  function pickNode(want) {
    const ns = webclawNodes();
    if (want) return ns.includes(want) ? want : null;
    return ns.length === 1 ? ns[0] : null;
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (!hostOk(req)) return send(res, 403, { error: "bad host" });
    const cp = cdpPath(url.pathname);
    if (cp !== null) {
      // DevTools discovery for CDP clients (Puppeteer browserURL, Playwright connectOverCDP)
      const node = pickNode(url.searchParams.get("node"));
      if (!node) return send(res, 409, { error: "need exactly one webclaw node (or ?node=<name>)", nodes: webclawNodes() });
      const base = "ws://" + req.headers.host + url.pathname.replace(/\/json.*$/, "").replace(/\/$/, "");
      const wsUrl = base + "/devtools/browser/" + encodeURIComponent(node);
      if (/^\/json\/version\/?$/.test(cp)) return send(res, 200, { Browser: "Chrome/webclaw-relay", "Protocol-Version": "1.3", "User-Agent": "webclaw-relay", webSocketDebuggerUrl: wsUrl });
      if (/^\/json(\/list)?\/?$/.test(cp)) return send(res, 200, []);
      return send(res, 404, { error: "not found" });
    }
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true, version: "webclaw-minibus/" + (opts.version || "0"), nodes: sockets.size });
    const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
    if (!authOk(auth)) return send(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && url.pathname === "/api/presence") {
      const wk = url.searchParams.get("work_key");
      const agents = [];
      for (const s of sockets) {
        if (!s.name) continue;
        for (const t of s.topics) if (!wk || t === "work:" + wk) agents.push(Object.assign({ name: s.name }, s.meta));
      }
      return send(res, 200, { agents });
    }
    if (req.method === "POST" && url.pathname === "/api/task") {
      const p = await readBody(req);
      if (p === TOO_LARGE) return tooLarge(res);
      if (!p || typeof p !== "object" || !p.instructions) return send(res, 400, { error: "instructions required" });
      const wk = typeof p.work_key === "string" && p.work_key ? p.work_key : (opts.workKey || "WK-local");
      const taskId = p.task_id != null && p.task_id !== "" ? String(p.task_id) : "local-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
      // a reused task_id starts fresh — never hand back the previous run's results
      results.delete(taskId);
      const payload = { task_id: taskId, from: "http@controller", role: p.role || "executor", to: p.to || null, instructions: p.instructions, work_key: wk };
      setStatus(taskId, { status: "queued", to: p.to || null, queued_at: new Date().toISOString() });
      broadcast("work:" + wk, "task.assign", payload);
      return send(res, 201, { task_id: taskId, work_key: wk, status: "queued", pending: false });
    }
    if (req.method === "GET" && url.pathname === "/api/skill-registry") {
      return send(res, 200, { skills: Object.entries(registry.skills).map(([name, e]) => ({ name, version: e.version, description: e.description, published_at: e.published_at })) });
    }
    const dl = url.pathname.match(/^\/api\/skill-registry\/download\/([^/]+)$/);
    if (req.method === "GET" && dl) {
      const name = safeDecode(dl[1]);
      if (name === null) return send(res, 400, { error: "bad name encoding" });
      const e = Object.prototype.hasOwnProperty.call(registry.skills, name) ? registry.skills[name] : null;
      return e ? send(res, 200, Object.assign({ name }, e)) : send(res, 404, { error: "skill not found" });
    }
    if (req.method === "POST" && url.pathname === "/api/skill-registry/publish") {
      const p = await readBody(req);
      if (p === TOO_LARGE) return tooLarge(res);
      if (!p || typeof p !== "object" || typeof p.name !== "string" || !p.name || !p.version || p.name === "__proto__") return send(res, 400, { error: "name and version required" });
      registry.skills[p.name] = { version: p.version, description: p.description || "", content: p.content || "", published_by: p.published_by || "http@controller", published_at: new Date().toISOString() };
      saveRegistry();
      return send(res, 201, { ok: true, name: p.name, entry: registry.skills[p.name] });
    }
    const m = url.pathname.match(/^\/api\/task(?:-result)?\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const id = safeDecode(m[1]);
      if (id === null) return send(res, 400, { error: "bad task id encoding" });
      const body = resultBody(id);
      return body ? send(res, 200, body) : send(res, 202, Object.assign({ status: "pending" }, status.get(id) || {}, { task_id: id }));
    }
    send(res, 404, { error: "not found" });
  }

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((e) => {
      log("http error: " + ((e && e.message) || e));
      try { if (!res.headersSent) send(res, 400, { error: "bad request" }); else res.destroy(); } catch (e2) { try { res.destroy(); } catch (e3) {} }
    });
  });

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, "http://localhost");
    const origin = req.headers.origin || "";
    const deny = (code, why) => { log("ws refused (" + why + ")"); socket.end("HTTP/1.1 " + code + "\r\n\r\n"); };
    if (origin && !/^chrome-extension:\/\//.test(origin)) return deny("403 Forbidden", "origin " + origin);
    if (!hostOk(req)) return deny("403 Forbidden", "host");
    const cp = cdpPath(url.pathname);
    if (cp !== null) {
      const m = cp.match(/^\/devtools\/browser(?:\/([^/]+))?$/);
      const want = m && m[1] ? safeDecode(m[1]) : "";
      const node = m && want !== null && pickNode(want);
      if (!node) return deny("404 Not Found", "cdp node");
      const conn = upgrade(req, socket, head);
      if (!conn) return;
      log("cdp client → " + node);
      cdpConns.add(conn);
      cdp.attachClient(conn, node);
      const onclose = conn.onclose;
      conn.onclose = () => { cdpConns.delete(conn); onclose && onclose(); };
      return;
    }
    if (url.pathname !== "/socket/websocket") return deny("404 Not Found", "path");
    if (!authOk(url.searchParams.get("token") || "")) return deny("403 Forbidden", "token");
    const conn = upgrade(req, socket, head);
    if (!conn) return;
    const s = { conn, topics: new Set(), name: null, meta: {} };
    sockets.add(s);
    conn.onmessage = (text) => { try { onFrame(s, text); } catch (e) { log("frame error: " + e.message); } };
    conn.onclose = () => {
      sockets.delete(s);
      if (s.name) {
        log("left " + s.name);
        if (![...sockets].some((o) => o.name === s.name)) cdp.nodeGone(s.name);
      }
    };
  }

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {}); // a reset during the handshake must not crash the bus
    try { handleUpgrade(req, socket, head); } catch (e) {
      log("upgrade error: " + ((e && e.message) || e));
      try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch (e2) {}
      try { socket.destroy(); } catch (e2) {}
    }
  });

  return {
    server,
    listen(port, host) {
      const h = host || "127.0.0.1";
      if (!LOOPBACK.has(h) && !opts.allowRemote) {
        return Promise.reject(new Error("refusing to listen on non-loopback host " + h + " — pass --allow-remote (or WEBCLAW_ALLOW_REMOTE=1) if you really mean it"));
      }
      boundHost = h;
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, h, () => resolve(server.address().port));
      });
    },
    close() {
      for (const s of sockets) s.conn.close();
      for (const c of cdpConns) c.close();
      return new Promise((r) => server.close(() => r()));
    },
    // test/diagnostic view of the in-memory maps
    _state: { results, status },
  };
}

module.exports = { createMiniBus, cdpToken, safeEqual, RESULT_CAP, PER_TASK_CAP, MAX_BODY };
