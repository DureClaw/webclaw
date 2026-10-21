// Bridge hardening tests (review 2026-10-21: S3, A10, A11, B bridge/CLI).
// Fully offline: an in-process mini-bus on an ephemeral port, a core.js node
// with fake browser hooks, raw sockets for hostile WebSocket input, and the
// CLI spawned with WEBCLAW_HOME pointing at a temp dir (never ~/.webclaw).
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { PassThrough } = require("node:stream");
const { execFile } = require("node:child_process");
const { encodeFrame, createParser } = require("../bridge/ws.cjs");
const { createMiniBus, cdpToken, RESULT_CAP, PER_TASK_CAP } = require("../bridge/minibus.cjs");
const { createCdpEndpoint } = require("../bridge/cdp-relay.cjs");
const { createClient } = require("../bridge/client.cjs");
const { createMcpServer } = require("../bridge/mcp.cjs");
const { parseArgs, isSelfBrain, resolveFallback } = require("../bin/webclaw.cjs");
const { createWebclaw } = require("../core.js");

const BIN = path.join(__dirname, "..", "bin", "webclaw.cjs");
const SECRET = "hard-secret-0123";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), "webclaw-hard-" + p + "-"));
const mode = (p) => fs.statSync(p).mode & 0o777;
async function until(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(10); }
  throw new Error("condition not met within " + ms + "ms");
}

let bus, port, base, nodeHandle, client, registryFile;
const relayed = [];

before(async () => {
  registryFile = path.join(tmp("reg"), "registry.json");
  fs.writeFileSync(registryFile, '{"skills":{}}', { mode: 0o644 });
  fs.chmodSync(registryFile, 0o644);
  bus = createMiniBus({ secret: SECRET, workKey: "WK-h", registryFile });
  port = await bus.listen(0, "127.0.0.1");
  base = "http://127.0.0.1:" + port;
  const tabs = [{ targetId: "tab-7", webclawTabId: 7, type: "page", title: "Home", url: "http://x/", attached: false }];
  nodeHandle = createWebclaw({ bus: "127.0.0.1:" + port, secret: SECRET, workKey: "WK-h", name: "webclaw@hard" }, {
    act: async (p) => {
      if (p.selector === "#missing") throw Object.assign(new Error("(no match: #missing)"), { reason: "no_match" });
      return "clicked " + p.selector;
    },
    cdpRelay: async (c) => {
      relayed.push(c);
      if (c.method === "webclaw.targets") return { result: tabs };
      if (c.method === "webclaw.attach") return { result: Object.assign({}, tabs[0], { attached: true }) };
      return { result: {} };
    },
  });
  client = createClient({ bus: "127.0.0.1:" + port, secret: SECRET, workKey: "WK-h" });
  await until(async () => { try { return (await client.nodes()).some((n) => n.name === "webclaw@hard"); } catch (e) { return false; } });
});
after(async () => { client.close(); nodeHandle.disconnect(); await bus.close(); });

const alive = async () => assert.equal((await fetch(base + "/api/health")).status, 200, "bus still alive");
const auth = { authorization: "Bearer " + SECRET };

// raw WebSocket client: handshake (+ optional bytes in the same write → `head`)
function rawWs(pathname, extra) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0), upgraded = false;
    const frames = [];
    const parse = createParser();
    sock.on("error", () => {});
    sock.on("data", (c) => {
      if (!upgraded) {
        buf = Buffer.concat([buf, c]);
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        const status = Number(buf.toString("latin1", 0, i).split(" ")[1]);
        upgraded = true;
        const rest = buf.subarray(i + 4);
        if (rest.length) frames.push(...parse(rest));
        return resolve({ sock, status, frames, closed: () => sock.destroyed || sock.readableEnded });
      }
      frames.push(...parse(c));
    });
    sock.on("connect", () => {
      const req = "GET " + pathname + " HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
      sock.write(extra ? Buffer.concat([Buffer.from(req), extra]) : req);
    });
    setTimeout(() => reject(new Error("no upgrade answer")), 3000);
  });
}
// masked client → server frame
function masked(opcode, payload) {
  const plain = encodeFrame(opcode, payload);
  const n = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(String(payload));
  const hl = n < 126 ? 2 : n < 65536 ? 4 : 10;
  const mask = crypto.randomBytes(4);
  const head = Buffer.from(plain.subarray(0, hl)); head[1] |= 0x80;
  const body = Buffer.from(plain.subarray(hl)); for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

// ---- S3: no input crashes the bus ------------------------------------------
test("S3: bad percent-encoding in /cdp, task ids and registry names answers, bus stays up", async () => {
  assert.equal((await fetch(base + "/cdp/%E0/json/version")).status, 401);
  assert.equal((await fetch(base + "/cdp/%E0")).status, 401);
  assert.equal((await fetch(base + "/api/task/%E0", { headers: auth })).status, 400);
  assert.equal((await fetch(base + "/api/skill-registry/download/%E0%A4", { headers: auth })).status, 400);
  const r = await rawWs("/cdp/" + cdpToken(SECRET) + "/devtools/browser/%E0");
  assert.equal(r.status, 404); r.sock.destroy();
  const r2 = await rawWs("/cdp/%E0/devtools/browser");
  assert.equal(r2.status, 404); r2.sock.destroy();
  await alive();
});

test("S3: non-ASCII token of the same JS length is just unauthorized (no RangeError)", async () => {
  const evil = "ä" + SECRET.slice(1); // same .length, different byte length
  assert.equal(evil.length, SECRET.length);
  assert.equal((await fetch(base + "/api/presence", { headers: { authorization: "Bearer " + evil } })).status, 401);
  assert.equal((await fetch(base + "/api/presence?token=" + encodeURIComponent(evil))).status, 401);
  const r = await rawWs("/socket/websocket?vsn=2.0.0&token=" + encodeURIComponent(evil));
  assert.equal(r.status, 403); r.sock.destroy();
  const tok = cdpToken(SECRET);
  const evilCdp = "é" + tok.slice(1);
  assert.equal((await fetch(base + "/cdp/" + encodeURIComponent(evilCdp) + "/json/version")).status, 401);
  await alive();
});

test("S3: null / non-object CDP messages and bad phoenix frames are ignored or answered, bus stays up", async () => {
  const r = await rawWs("/cdp/" + cdpToken(SECRET) + "/devtools/browser");
  assert.equal(r.status, 101);
  for (const t of ["null", "5", "[]", '"x"', "{bad json", '{"id":1}', '{"id":2,"method":7}']) r.sock.write(masked(0x1, t));
  r.sock.write(masked(0x1, JSON.stringify({ id: 3, method: "Browser.getVersion" })));
  await until(() => r.frames.some((f) => JSON.parse(f.data).id === 3));
  const msgs = r.frames.map((f) => JSON.parse(f.data));
  assert.equal(msgs.find((m) => m.id === 1).error.code, -32600, "missing method → error reply");
  assert.equal(msgs.find((m) => m.id === 2).error.code, -32600);
  assert.equal(msgs.find((m) => m.id === 3).result.protocolVersion, "1.3");
  r.sock.destroy();

  const p = await rawWs("/socket/websocket?vsn=2.0.0&token=" + SECRET);
  assert.equal(p.status, 101);
  for (const t of ["null", "[1,2,3,4,5]", '[null,null,{"a":1},"phx_join",null]', '["1","1","work:WK-h","task.result",null]', '["1","1","work:WK-h","cdp.reply","str"]'])
    p.sock.write(masked(0x1, t));
  p.sock.write(masked(0x1, JSON.stringify(["9", "9", "work:WK-h", "phx_join", null])));
  await until(() => p.frames.some((f) => JSON.parse(f.data)[1] === "9"));
  assert.equal(JSON.parse(p.frames.find((f) => JSON.parse(f.data)[1] === "9").data)[4].status, "ok");
  p.sock.destroy();
  await alive();
});

test("S3: the mini-bus refuses non-loopback hosts unless allowRemote", async () => {
  await assert.rejects(createMiniBus({ secret: "x" }).listen(0, "0.0.0.0"), /non-loopback/);
  const ok = createMiniBus({ secret: "x", allowRemote: true });
  assert.ok(await ok.listen(0, "0.0.0.0"));
  await ok.close();
});

// ---- B: ws parser ----------------------------------------------------------
test("ws: frames split byte-by-byte and many frames per chunk parse; big frames are rejected", () => {
  const a = masked(0x1, "hello"), b = masked(0x1, "y".repeat(300)), c = masked(0x1, "z".repeat(70000));
  const feed = createParser({ requireMask: true });
  const out = [];
  const all = Buffer.concat([a, b, c]);
  for (let i = 0; i < 40; i++) out.push(...feed(all.subarray(i, i + 1)));
  out.push(...feed(all.subarray(40)));
  assert.deepEqual(out.map((f) => f.data.length), [5, 300, 70000]);
  assert.equal(out[1].data.toString(), "y".repeat(300));
  const one = createParser()(Buffer.concat([a, a, a]));
  assert.equal(one.length, 3);

  const small = createParser({ maxPayload: 1000 });
  assert.throws(() => small(masked(0x1, "x".repeat(2000)).subarray(0, 8)), (e) => e.wsCode === 1009, "rejected from the header alone");
  const huge = Buffer.from([0x81, 0xff, 0, 0, 0, 1, 0, 0, 0, 0, 1, 2, 3, 4]); // 2^32 bytes claimed
  assert.throws(() => createParser()(huge), (e) => e.wsCode === 1009);
  assert.throws(() => createParser({ requireMask: true })(encodeFrame(0x1, "hi")), (e) => e.wsCode === 1002);
});

test("ws: 8 MB in 64 KB chunks parses in linear time", () => {
  const frame = masked(0x1, "q".repeat(8 * 1024 * 1024));
  const feed = createParser();
  const t0 = Date.now();
  let got = [];
  for (let i = 0; i < frame.length; i += 65536) got = got.concat(feed(frame.subarray(i, i + 65536)));
  assert.equal(got.length, 1);
  assert.equal(got[0].data.length, 8 * 1024 * 1024);
  assert.ok(Date.now() - t0 < 1500, "took " + (Date.now() - t0) + "ms");
});

test("ws server: oversize frame → close 1009, unmasked → 1002, head bytes are delivered", async () => {
  const big = await rawWs("/socket/websocket?vsn=2.0.0&token=" + SECRET);
  const h = Buffer.alloc(14); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(17 * 1024 * 1024), 2);
  big.sock.write(h);
  await until(() => big.frames.some((f) => f.opcode === 0x8));
  assert.equal(big.frames.find((f) => f.opcode === 0x8).data.readUInt16BE(0), 1009);
  await until(() => big.closed());

  const plain = await rawWs("/socket/websocket?vsn=2.0.0&token=" + SECRET);
  plain.sock.write(encodeFrame(0x1, JSON.stringify([null, "1", "phoenix", "heartbeat", {}])));
  await until(() => plain.frames.some((f) => f.opcode === 0x8));
  assert.equal(plain.frames.find((f) => f.opcode === 0x8).data.readUInt16BE(0), 1002);
  await until(() => plain.closed());

  // first frame in the same TCP write as the handshake → arrives as `head`
  const hb = masked(0x1, JSON.stringify([null, "hb1", "phoenix", "heartbeat", {}]));
  const withHead = await rawWs("/socket/websocket?vsn=2.0.0&token=" + SECRET, hb);
  await until(() => withHead.frames.some((f) => f.opcode === 0x1 && JSON.parse(f.data)[1] === "hb1"));
  withHead.sock.destroy();
  await alive();
});

// ---- B: mini-bus maps / task ids / body size --------------------------------
test("mini-bus: remember() refreshes recency, caps per-task lists, evicts status with results", async () => {
  const ws = new WebSocket("ws://127.0.0.1:" + port + "/socket/websocket?vsn=2.0.0&token=" + SECRET);
  await new Promise((r) => (ws.onopen = r));
  const send = (f) => ws.send(JSON.stringify(f));
  send(["j", "j", "work:WK-cap", "phx_join", { agent_name: "cap@test" }]);
  const result = (id, i) => send([null, null, "work:WK-cap", "task.result", { task_id: id, status: "done", output: String(i) }]);
  const { results, status } = bus._state;
  results.clear(); status.clear();
  result("keep", 0);
  result("x0", 0);
  for (let i = 1; i < RESULT_CAP - 2; i++) result("x" + i, i);
  result("keep", 1); // refresh → now the newest
  result("y1", 1); result("y2", 2); // overflow by 1 → the oldest ("x0") goes
  for (let i = 0; i < PER_TASK_CAP + 5; i++) result("inbox", i);
  await until(() => results.has("inbox") && results.get("inbox").at(-1).output === String(PER_TASK_CAP + 4));
  assert.ok(results.has("keep"), "refreshed id survives");
  assert.ok(!results.has("x0"), "oldest id evicted");
  assert.ok(!status.has("x0"), "status evicted together with results");
  assert.ok(results.size <= RESULT_CAP);
  assert.equal(results.get("inbox").length, PER_TASK_CAP);
  assert.equal(results.get("inbox")[0].output, "5", "keeps the last PER_TASK_CAP");
  ws.close();
});

test("mini-bus: POST /api/task with an existing task_id clears the previous results", async () => {
  const post = (body) => fetch(base + "/api/task", { method: "POST", headers: Object.assign({ "content-type": "application/json" }, auth), body: JSON.stringify(body) });
  const r1 = await post({ to: "webclaw@hard", work_key: "WK-h", task_id: "dup-1", instructions: "[CLICK] #a" });
  assert.equal(r1.status, 201);
  await until(async () => (await fetch(base + "/api/task/dup-1", { headers: auth })).status === 200);
  bus._state.results.get("dup-1"); // present
  // re-use the id with a marker the node will not answer quickly: block the node by sending to nobody
  const r2 = await post({ to: "nobody@x", work_key: "WK-h", task_id: "dup-1", instructions: "[CLICK] #b" });
  assert.equal(r2.status, 201);
  const g = await fetch(base + "/api/task/dup-1", { headers: auth });
  assert.equal(g.status, 202, "old result is not served for the new run");
  assert.equal((await g.json()).status, "queued");
});

test("mini-bus: request bodies over 4 MB → 413", async () => {
  const r = await fetch(base + "/api/task", { method: "POST", headers: Object.assign({ "content-type": "application/json" }, auth), body: "x".repeat(5 * 1024 * 1024) });
  assert.equal(r.status, 413);
  await alive();
});

test("registry file is chmod 0600 after a publish even if it existed 0644", async () => {
  assert.equal(mode(registryFile), 0o644);
  await client.registryPublish("hard-skill", "1", "{}", "t");
  assert.equal(mode(registryFile), 0o600);
});

// ---- A10: MCP ---------------------------------------------------------------
test("A10: MCP non-string method → -32600, batches answered, internal errors → -32603", async () => {
  const mcp = createMcpServer({ dispatch: async () => ({ status: "done", output: "ok" }), nodes: async () => [] });
  assert.equal((await mcp.handle({ jsonrpc: "2.0", id: 1, method: 5 })).error.code, -32600);
  assert.equal((await mcp.handle({ jsonrpc: "2.0", id: 2, method: { x: 1 } })).error.code, -32600);
  assert.equal((await mcp.handle({ jsonrpc: "2.0", id: 3 })).error.code, -32600);
  assert.equal((await mcp.handle(null)).error.code, -32600);
  assert.equal((await mcp.handle(7)).error.code, -32600);
  assert.equal((await mcp.handle([])).error.code, -32600, "empty batch");
  const batch = await mcp.handle([
    { jsonrpc: "2.0", id: 10, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 11, method: 42 },
    { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "webclaw_tabs", arguments: {} } },
  ]);
  assert.ok(Array.isArray(batch));
  assert.deepEqual(batch.map((r) => r.id), [10, 11, 12]);
  assert.equal(batch[1].error.code, -32600);
  assert.equal(batch[2].result.content[0].text, "ok");
  assert.equal(await mcp.handle([{ jsonrpc: "2.0", method: "notifications/x" }]), null, "all-notification batch → no response");
  const boom = { jsonrpc: "2.0", id: 13, get method() { throw new Error("boom"); } };
  const r = await mcp.handle(boom);
  assert.equal(r.error.code, -32603);
  assert.equal(r.id, 13);
});

test("A10: MCP stdio answers in-flight requests before exiting on stdin end", async () => {
  const mcp = createMcpServer({ dispatch: async () => { await sleep(150); return { status: "done", output: "late" }; } });
  const input = new PassThrough(), output = new PassThrough();
  let out = "";
  output.on("data", (c) => (out += c));
  const done = new Promise((resolve) => mcp.serveStdio(input, output, resolve));
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "webclaw_tabs", arguments: {} } }) + "\n");
  input.write("[" + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "]\n");
  input.write("not json\n");
  input.end(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })); // no trailing newline
  await done;
  const lines = out.trim().split("\n").map((l) => JSON.parse(l));
  const one = lines.find((l) => l.id === 1);
  assert.equal(one.result.content[0].text, "late");
  assert.ok(lines.some((l) => Array.isArray(l) && l[0].id === 2));
  assert.ok(lines.some((l) => l.error && l.error.code === -32700));
  assert.ok(lines.some((l) => l.id === 3));
});

// ---- A11: CDP relay attach lifecycle --------------------------------------
function fakeNode() {
  const sent = []; // { method, id, params }
  const ep = createCdpEndpoint({ sendToNode: (node, ev, p) => { sent.push(p); return true; }, log: () => {} });
  const answer = (method, result) => {
    const c = sent.filter((x) => x.method === method && !x.answered).shift();
    if (!c) return false;
    c.answered = true;
    ep.onNodeFrame("webclaw@n", "cdp.reply", { id: c.id, result });
    return true;
  };
  const client = () => {
    const out = [];
    const conn = { send: (t) => out.push(JSON.parse(t)), onmessage: null, onclose: null };
    ep.attachClient(conn, "webclaw@n");
    return { conn, out, call: (m) => conn.onmessage(JSON.stringify(m)) };
  };
  return { sent, ep, answer, client, count: (m) => sent.filter((x) => x.method === m).length };
}
const TAB = { targetId: "tab-7", webclawTabId: 7, type: "page", title: "", url: "http://x/" };

test("A11: a client that disconnects mid-attach releases the tab once the attach completes", async () => {
  const n = fakeNode();
  const a = n.client();
  a.call({ id: 1, method: "Target.attachToTarget", params: { targetId: "tab-7" } });
  await until(() => n.answer("webclaw.targets", [TAB]));
  await until(() => n.count("webclaw.attach") === 1);
  a.conn.onclose(); // leaves while the node is still attaching
  n.answer("webclaw.attach", TAB);
  await until(() => n.count("webclaw.detach") === 1);
  assert.equal(n.sent.find((x) => x.method === "webclaw.detach").params.targetId, "tab-7");
  assert.equal(n.ep._refs.size, 0);
  assert.ok(!a.out.some((m) => m.method === "Target.attachedToTarget"), "nothing sent to a gone client");
});

test("A11: two clients share a tab — detach only when the last one releases", async () => {
  const n = fakeNode();
  const a = n.client(), b = n.client();
  a.call({ id: 1, method: "Target.attachToTarget", params: { targetId: "tab-7" } });
  await until(() => n.answer("webclaw.targets", [TAB]));
  await until(() => n.answer("webclaw.attach", TAB));
  await until(() => a.out.some((m) => m.id === 1));
  b.call({ id: 1, method: "Target.attachToTarget", params: { targetId: "tab-7" } });
  await until(() => n.answer("webclaw.targets", [TAB]));
  await until(() => n.answer("webclaw.attach", TAB));
  await until(() => b.out.some((m) => m.id === 1));
  assert.equal(n.ep._refs.get("webclaw@n\u00007"), 2);
  const sid = a.out.find((m) => m.id === 1).result.sessionId;
  a.call({ id: 2, method: "Target.detachFromTarget", params: { sessionId: sid } });
  await until(() => a.out.some((m) => m.id === 2));
  assert.equal(n.count("webclaw.detach"), 0, "b still holds the tab");
  b.conn.onclose();
  await until(() => n.count("webclaw.detach") === 1);
  a.conn.onclose();
  await sleep(20);
  assert.equal(n.count("webclaw.detach"), 1, "exactly one node detach");
  assert.equal(n.ep._refs.size, 0);
});

test("A11: node calls fail fast when the node leaves", async () => {
  const n = fakeNode();
  const a = n.client();
  a.call({ id: 5, method: "Target.getTargets" });
  await until(() => n.count("webclaw.targets") === 1);
  n.ep.nodeGone("webclaw@n");
  await until(() => a.out.some((m) => m.id === 5));
  assert.match(a.out.find((m) => m.id === 5).error.message, /disconnected/);
});

// ---- CLI --------------------------------------------------------------------
test("CLI flag parsing: boolean flags never consume the next argument", () => {
  assert.deepEqual(parseArgs(["do", "--json", "[DOM] x"]), { cmd: "do", positional: ["[DOM] x"], flags: { json: true } });
  assert.deepEqual(parseArgs(["goal", "--fallback", "fill the form", "--node", "webclaw@a", "--max-steps", "3"]).positional, ["fill the form"]);
  assert.equal(parseArgs(["goal", "--fallback", "g", "--node", "webclaw@a"]).flags.node, "webclaw@a");
  assert.deepEqual(parseArgs(["setup", "--standalone", "--force", "--ext-dir", "/x"]).flags, { standalone: true, force: true, "ext-dir": "/x" });
  assert.deepEqual(parseArgs(["--json", "do", "[TABS]"]), { cmd: "do", positional: ["[TABS]"], flags: { json: true } });
  assert.equal(parseArgs(["do", "--timeout=5", "[TABS]"]).flags.timeout, "5");
  assert.deepEqual(parseArgs(["do", "--", "--not-a-flag"]).positional, ["--not-a-flag"]);
  assert.throws(() => parseArgs(["do", "--node"]), /needs a value/);
  assert.throws(() => parseArgs(["do", "--node", "--json"]), /needs a value/);
});

test("CLI fallback guard: brain.fallbackUrl must not be the local brain server", () => {
  assert.equal(isSelfBrain("http://127.0.0.1:4111", 4111), true);
  assert.equal(isSelfBrain("http://localhost:4111/", 4111), true);
  assert.equal(isSelfBrain("http://[::1]:4111", 4111), true);
  assert.equal(isSelfBrain("http://127.0.0.1:4112", 4111), false);
  assert.equal(isSelfBrain("https://brain.example:4111", 4111), false);
  assert.throws(() => resolveFallback({ brain: { fallbackUrl: "http://127.0.0.1:4111" } }, 4111), /would call itself/);
  assert.throws(() => resolveFallback({ brain: {} }, 4111), /fallbackUrl/);
  assert.deepEqual(resolveFallback({ brain: { fallbackUrl: "http://127.0.0.1:9000", fallbackToken: "t" } }, 4111), { url: "http://127.0.0.1:9000", token: "t" });
});

function cli(args, home, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: Object.assign({}, process.env, { WEBCLAW_HOME: home, WEBCLAW_MODE: "", WEBCLAW_BUS: "", WEBCLAW_SECRET: "" }, env), timeout: 20000 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
  });
}
function homeFor(extra) {
  const home = tmp("home");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(Object.assign({ mode: "standalone", bus: "127.0.0.1:" + port, secret: SECRET, workKey: "WK-h" }, extra || {})));
  return home;
}

test("CLI --json: exit code 1 when status !== done, 0 when done", async () => {
  const home = homeFor();
  const bad = await cli(["do", "--json", "[CLICK] #missing"], home);
  assert.equal(bad.code, 1, bad.stderr);
  assert.equal(JSON.parse(bad.stdout).status, "failed");
  const good = await cli(["do", "[CLICK] #ok", "--json"], home);
  assert.equal(good.code, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).status, "done");
});

test("CDP token: HMAC-SHA256(secret, 'webclaw-cdp') base64url; cdp-url prints it; the secret is refused", async () => {
  const want = crypto.createHmac("sha256", SECRET).update("webclaw-cdp").digest("base64url");
  assert.equal(cdpToken(SECRET), want);
  assert.notEqual(want, SECRET);
  const r = await cli(["cdp-url"], homeFor());
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "http://127.0.0.1:" + port + "/cdp/" + want);
  assert.ok(!r.stdout.includes(SECRET));
  assert.equal((await fetch(r.stdout.trim() + "/json/version")).status, 200);
  assert.equal((await fetch(base + "/cdp/" + SECRET + "/json/version")).status, 401);
});

test("CLI setup --standalone: brainToken generated, config/ext/.bak files are 0600", async () => {
  const home = tmp("home"), ext = tmp("ext");
  const extCfg = path.join(ext, "config.local.json");
  fs.writeFileSync(extCfg, JSON.stringify({ bus: "old:1", secret: "old" }), { mode: 0o644 });
  fs.chmodSync(extCfg, 0o644);
  const r = await cli(["setup", "--standalone", "--ext-dir", ext], home);
  assert.equal(r.code, 0, r.stderr);
  const homeCfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  const extJson = JSON.parse(fs.readFileSync(extCfg, "utf8"));
  assert.match(homeCfg.brainToken, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(extJson.brainToken, homeCfg.brainToken);
  assert.equal(extJson.secret, homeCfg.secret);
  assert.equal(mode(path.join(home, "config.json")), 0o600);
  assert.equal(mode(extCfg), 0o600);
  const baks = fs.readdirSync(ext).filter((f) => f.startsWith("config.local.json.bak-"));
  assert.equal(baks.length, 1);
  assert.equal(mode(path.join(ext, baks[0])), 0o600);
  // re-run without --force keeps the token
  const again = await cli(["setup", "--standalone", "--ext-dir", ext], home);
  assert.match(again.stdout, /already configured/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).brainToken, homeCfg.brainToken);
});

test("CLI setup (bus mode): brainToken generated, existing config.local.json chmod 0600", async () => {
  const home = tmp("home"), ext = tmp("ext");
  const extCfg = path.join(ext, "config.local.json");
  fs.writeFileSync(extCfg, JSON.stringify({ bus: "127.0.0.1:1", secret: "s", workKey: "WK-b" }), { mode: 0o644 });
  fs.chmodSync(extCfg, 0o644);
  const r = await cli(["setup", "--ext-dir", ext], home);
  assert.equal(r.code, 0, r.stderr);
  const homeCfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(homeCfg.mode, "bus");
  assert.match(homeCfg.brainToken, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(mode(path.join(home, "config.json")), 0o600);
  assert.equal(mode(extCfg), 0o600);
});

test("CLI brain refuses to start without a token", async () => {
  const r = await cli(["brain"], homeFor());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /without a token/);
});
