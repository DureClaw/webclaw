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
//
// Security: binds 127.0.0.1 only; every call needs the secret (Bearer /
// ?token=). WebSockets have no CORS, so upgrades from any http(s) page
// origin are refused — only extension (chrome-extension://) or origin-less
// (Node) clients may connect; otherwise any website could drive the browser.
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { upgrade } = require("./ws.cjs");
const { createCdpEndpoint } = require("./cdp-relay.cjs");

const RESULT_CAP = 500; // task ids kept in memory

function createMiniBus(opts) {
  const secret = opts.secret;
  if (!secret) throw new Error("mini-bus needs a secret");
  const log = opts.log || (() => {});
  const sockets = new Set(); // { conn, topics:Set, name, meta }
  const results = new Map(); // task_id → [result…]
  const status = new Map(); // task_id → { status, to, queued_at }

  const authOk = (token) => typeof token === "string" && token.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));

  function remember(taskId, result) {
    const list = results.get(taskId) || [];
    list.push(result);
    results.set(taskId, list);
    if (results.size > RESULT_CAP) results.delete(results.keys().next().value);
  }

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
  const saveRegistry = () => { if (opts.registryFile) try { fs.writeFileSync(opts.registryFile, JSON.stringify(registry), { mode: 0o600 }); } catch (e) {} };

  function broadcast(topic, event, payload, except) {
    const frame = JSON.stringify([null, null, topic, event, payload]);
    for (const s of sockets) if (s !== except && s.topics.has(topic)) s.conn.send(frame);
  }

  function onFrame(s, text) {
    let f;
    try { f = JSON.parse(text); } catch (e) { return; }
    if (!Array.isArray(f) || f.length !== 5) return;
    const [joinRef, ref, topic, event, payload] = f;
    const reply = (response) => s.conn.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: response || {} }]));
    if (topic === "phoenix" && event === "heartbeat") return reply({});
    if (event === "phx_join") {
      if (!/^work:/.test(topic)) return s.conn.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "error", response: { reason: "unmatched topic" } }]));
      const p = payload || {};
      s.topics.add(topic);
      s.name = p.agent_name || s.name || "unknown@unknown";
      s.meta = { role: p.role || "unknown", machine: p.machine || "unknown", capabilities: p.capabilities || [],
        version: p.version, work_key: topic.slice(5), online_since: new Date().toISOString() };
      log("join " + s.name + " → " + topic);
      return reply({ presences: presences(topic) });
    }
    if (event === "phx_leave") { s.topics.delete(topic); return reply({}); }
    if (event === "cdp.reply" || event === "cdp.event") { cdp.onNodeFrame(s.name, event, payload || {}); return reply({}); }
    if (event === "task.result" || event === "task.ack" || event === "task.blocked") {
      const msg = Object.assign({}, payload, { from: s.name, event, ts: new Date().toISOString() });
      if (event !== "task.ack" && msg.task_id) {
        remember(msg.task_id, msg);
        if (event === "task.result") status.set(msg.task_id, Object.assign(status.get(msg.task_id) || {}, { status: msg.status === "done" ? "done" : "failed" }));
      }
      broadcast(topic, event, msg, s);
      return reply({});
    }
    reply({});
  }

  function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { resolve(null); } });
    });
  }

  function resultBody(id) {
    const list = results.get(id);
    if (!list || !list.length) return null;
    const st = status.get(id) || {};
    return list.length === 1 ? Object.assign({}, st, list[0]) : Object.assign({}, st, { task_id: id, results: list, count: list.length });
  }

  // DNS-rebinding guard: only loopback Host headers
  const hostOk = (req) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || "");
  const cdpPath = (pathname) => {
    const m = pathname.match(/^\/cdp\/([^/]+)(\/.*)?$/);
    return m && authOk(decodeURIComponent(m[1])) ? (m[2] || "/") : null;
  };
  function pickNode(want) {
    const ns = webclawNodes();
    if (want) return ns.includes(want) ? want : null;
    return ns.length === 1 ? ns[0] : null;
  }

  const server = http.createServer(async (req, res) => {
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
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
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
      if (!p || !p.instructions) return send(res, 400, { error: "instructions required" });
      const wk = p.work_key || opts.workKey || "WK-local";
      const taskId = p.task_id || "local-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
      const payload = { task_id: taskId, from: "http@controller", role: p.role || "executor", to: p.to || null, instructions: p.instructions, work_key: wk };
      status.set(taskId, { status: "queued", to: p.to || null, queued_at: new Date().toISOString() });
      broadcast("work:" + wk, "task.assign", payload);
      return send(res, 201, { task_id: taskId, work_key: wk, status: "queued", pending: false });
    }
    if (req.method === "GET" && url.pathname === "/api/skill-registry") {
      return send(res, 200, { skills: Object.entries(registry.skills).map(([name, e]) => ({ name, version: e.version, description: e.description, published_at: e.published_at })) });
    }
    const dl = url.pathname.match(/^\/api\/skill-registry\/download\/([^/]+)$/);
    if (req.method === "GET" && dl) {
      const e = registry.skills[decodeURIComponent(dl[1])];
      return e ? send(res, 200, Object.assign({ name: decodeURIComponent(dl[1]) }, e)) : send(res, 404, { error: "skill not found" });
    }
    if (req.method === "POST" && url.pathname === "/api/skill-registry/publish") {
      const p = await readBody(req);
      if (!p || !p.name || !p.version) return send(res, 400, { error: "name and version required" });
      registry.skills[p.name] = { version: p.version, description: p.description || "", content: p.content || "", published_by: p.published_by || "http@controller", published_at: new Date().toISOString() };
      saveRegistry();
      return send(res, 201, { ok: true, name: p.name, entry: registry.skills[p.name] });
    }
    const m = url.pathname.match(/^\/api\/task(?:-result)?\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const id = decodeURIComponent(m[1]);
      const body = resultBody(id);
      return body ? send(res, 200, body) : send(res, 202, Object.assign({ status: "pending" }, status.get(id) || {}, { task_id: id }));
    }
    send(res, 404, { error: "not found" });
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://localhost");
    const origin = req.headers.origin || "";
    const deny = (code, why) => { log("ws refused (" + why + ")"); socket.end("HTTP/1.1 " + code + "\r\n\r\n"); };
    if (origin && !/^chrome-extension:\/\//.test(origin)) return deny("403 Forbidden", "origin " + origin);
    if (!hostOk(req)) return deny("403 Forbidden", "host");
    const cp = cdpPath(url.pathname);
    if (cp !== null) {
      const m = cp.match(/^\/devtools\/browser(?:\/([^/]+))?$/);
      const node = m && pickNode(m[1] ? decodeURIComponent(m[1]) : "");
      if (!node) return deny("404 Not Found", "cdp node");
      const conn = upgrade(req, socket);
      if (!conn) return;
      log("cdp client → " + node);
      return cdp.attachClient(conn, node);
    }
    if (url.pathname !== "/socket/websocket") return deny("404 Not Found", "path");
    if (!authOk(url.searchParams.get("token") || "")) return deny("403 Forbidden", "token");
    const conn = upgrade(req, socket);
    if (!conn) return;
    const s = { conn, topics: new Set(), name: null, meta: {} };
    sockets.add(s);
    conn.onmessage = (text) => onFrame(s, text);
    conn.onclose = () => { sockets.delete(s); if (s.name) log("left " + s.name); };
  });

  return {
    server,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host || "127.0.0.1", () => resolve(server.address().port));
      });
    },
    close() {
      for (const s of sockets) s.conn.close();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

module.exports = { createMiniBus };
