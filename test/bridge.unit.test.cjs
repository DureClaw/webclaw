// Bridge tests — mini-bus + REST client + MCP server, fully offline: a real
// core.js node (fake browser hooks) joins an in-process mini-bus over a real
// WebSocket, and tasks go through the same REST path the CLI/MCP use.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { encodeFrame, createParser } = require("../bridge/ws.cjs");
const { createMiniBus } = require("../bridge/minibus.cjs");
const { createClient } = require("../bridge/client.cjs");
const { createMcpServer, toMarker } = require("../bridge/mcp.cjs");
const { createWebclaw } = require("../core.js");

test("ws frames round-trip at 7-bit, 16-bit and 64-bit lengths (masked client frames)", () => {
  for (const n of [5, 300, 70000]) {
    const text = "x".repeat(n);
    // build a masked client→server frame
    const plain = encodeFrame(0x1, text);
    const hl = n < 126 ? 2 : n < 65536 ? 4 : 10;
    const mask = Buffer.from([1, 2, 3, 4]);
    const head = Buffer.from(plain.subarray(0, hl)); head[1] |= 0x80;
    const body = Buffer.from(plain.subarray(hl)); for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    const feed = createParser();
    const whole = Buffer.concat([head, mask, body]);
    // split delivery
    const a = feed(whole.subarray(0, 3));
    const b = feed(whole.subarray(3));
    assert.equal(a.length, 0);
    assert.equal(b.length, 1);
    assert.equal(b[0].data.toString(), text);
  }
});

const SECRET = "test-secret-123";
let bus, port, nodeHandle, client;
const seen = [];

before(async () => {
  bus = createMiniBus({ secret: SECRET, workKey: "WK-t" });
  port = await bus.listen(0, "127.0.0.1");
  const hooks = {
    act: async (p) => {
      seen.push(p);
      if (p.selector === "#missing") throw Object.assign(new Error("(no match: #missing)"), { reason: "no_match" });
      return p.action === "outline" ? "refs: 1\n@1 button \"OK\"" : "clicked " + p.selector + " (trusted) @1,2";
    },
    run: async (code) => JSON.stringify({ result: code.includes("pong") ? "pong" : null, log: [] }),
  };
  nodeHandle = createWebclaw({ bus: "127.0.0.1:" + port, secret: SECRET, workKey: "WK-t", name: "webclaw@unit" }, hooks);
  client = createClient({ bus: "127.0.0.1:" + port, secret: SECRET, workKey: "WK-t" });
  for (let i = 0; i < 50; i++) { // wait for the node's join
    try { if ((await client.nodes()).some((n) => n.name === "webclaw@unit")) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 50));
  }
});
after(async () => { nodeHandle.disconnect(); await bus.close(); });

test("presence via channel join lists the node; single node is auto-selected", async () => {
  const ns = await client.nodes();
  assert.deepEqual(ns.map((n) => n.name), ["webclaw@unit"]);
  assert.equal(await client.resolveNode(), "webclaw@unit");
});

test("dispatch → task.assign → node → task.result → REST poll", async () => {
  const r = await client.dispatch("[CLICK] @1");
  assert.equal(r.status, "done");
  assert.match(r.output, /clicked @1 \(trusted\)/);
  assert.equal(seen.at(-1).selector, "@1");
});

test("failures come back with status/reason", async () => {
  const r = await client.dispatch("[CLICK] #missing");
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "no_match");
});

test("REST requires the secret; WS refuses web-page origins and bad tokens", async () => {
  const base = "http://127.0.0.1:" + port;
  assert.equal((await fetch(base + "/api/health")).status, 200);
  assert.equal((await fetch(base + "/api/presence")).status, 401);
  assert.equal((await fetch(base + "/api/presence", { headers: { authorization: "Bearer nope" } })).status, 401);
  const http = require("node:http");
  const tryUpgrade = (headers, token) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/socket/websocket?vsn=2.0.0&token=" + token,
      headers: Object.assign({ connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" }, headers) });
    req.on("upgrade", (res, sock) => { sock.destroy(); resolve(101); });
    req.on("response", (res) => resolve(res.statusCode));
    req.on("error", () => resolve("error"));
    req.end();
  });
  assert.equal(await tryUpgrade({ origin: "https://evil.example" }, SECRET), 403);
  assert.equal(await tryUpgrade({}, "wrong"), 403);
  assert.equal(await tryUpgrade({ origin: "chrome-extension://abc" }, SECRET), 101);
});

test("MCP: initialize negotiates, tools/list, tools/call maps to markers and errors set isError", async () => {
  const mcp = createMcpServer(client);
  const init = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "webclaw");
  const list = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(list.result.tools.some((t) => t.name === "webclaw_run"));
  const ok = await mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "webclaw_outline", arguments: {} } });
  assert.match(ok.result.content[0].text, /@1 button "OK"/);
  assert.equal(ok.result.isError, undefined);
  const run = await mcp.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "webclaw_run", arguments: { script: "return 'pong'" } } });
  assert.match(run.result.content[0].text, /pong/);
  const bad = await mcp.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "webclaw_click", arguments: { target: "#missing" } } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /^\[no_match\]/);
  const nodes = await mcp.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "webclaw_nodes", arguments: {} } });
  assert.match(nodes.result.content[0].text, /webclaw@unit/);
  assert.equal(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await mcp.handle({ jsonrpc: "2.0", id: 7, method: "nope" })).error.code, -32601);
});

test("MCP tool → marker mapping", () => {
  assert.equal(toMarker("webclaw_open", { url: "https://x.y", space: "job" }), "[OPEN@space:job] https://x.y");
  assert.equal(toMarker("webclaw_type", { target: "@3", text: "a = b", tab: "x.com" }), "[TYPE@x.com] @3\na = b");
  assert.equal(toMarker("webclaw_read", {}), "[DOM] ");
  assert.equal(toMarker("webclaw_outline", { max: 50 }), "[OUTLINE] 50");
});
