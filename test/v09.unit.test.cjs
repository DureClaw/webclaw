// v0.9.0 unit tests — Web Bot Auth signing, new marker routing, mini-bus
// skill registry and the CDP endpoint emulation (fake node, raw CDP client).
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const id = require("../identity.js");
const { runTask } = require("../core.js");
const { createMiniBus } = require("../bridge/minibus.cjs");
const { createClient } = require("../bridge/client.cjs");
const { createWebclaw } = require("../core.js");

// ---- identity -----------------------------------------------------------
test("Web Bot Auth: sign → verify round-trip; tamper, expiry and wrong key fail", async () => {
  const key = await id.generateKey();
  const url = "https://shop.example.com:8443/path?q=1";
  const h = await id.signRequest(url, key, { agentUrl: "https://agent.example" });
  assert.match(h["Signature-Input"], /^sig1=\("@authority" "signature-agent"\);created=\d+;expires=\d+;keyid="[^"]+";alg="ed25519";nonce="[^"]+";tag="web-bot-auth"$/);
  assert.match(h.Signature, /^sig1=:[A-Za-z0-9+/=]+:$/);
  assert.equal(h["Signature-Agent"], '"https://agent.example"');
  assert.deepEqual(await id.verifyRequest(url, h, key.publicJwk), { ok: true, keyid: await id.thumbprint(key.publicJwk) });
  assert.equal((await id.verifyRequest("https://evil.example/", h, key.publicJwk)).ok, false, "authority is covered");
  assert.equal((await id.verifyRequest(url, Object.assign({}, h, { "Signature-Agent": '"https://other"' }), key.publicJwk)).ok, false, "signature-agent is covered");
  assert.equal((await id.verifyRequest(url, h, key.publicJwk, Date.now() + 120000)).reason, "expired");
  const other = await id.generateKey();
  assert.equal((await id.verifyRequest(url, h, other.publicJwk)).reason, "unknown keyid");
  assert.equal(id.authorityOf("https://A.example.com:443/x"), "a.example.com");
  const dir = await id.directory(key.publicJwk);
  assert.equal(dir.keys[0].kty, "OKP");
  assert.equal(dir.keys[0].crv, "Ed25519");
});

test("RFC 7638 thumbprint matches the RFC 8037 Ed25519 test vector", async () => {
  // RFC 8037 §A.3: thumbprint of the example public key
  assert.equal(await id.thumbprint({ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" }), "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
});

// ---- routing ------------------------------------------------------------
test("[AUDIT]/[REC]/[REPLAY]/[POLICY]/[IDENTITY]/[WEBMCP] route to hooks.guard", async () => {
  const calls = [];
  const hooks = { guard: async (p) => { calls.push(p); return "ok"; } };
  await runTask("[AUDIT] 20", {}, hooks);
  await runTask("[REC] on checkout flow", {}, hooks);
  await runTask("[REC]", {}, hooks);
  await runTask("[REPLAY] r/x.html", {}, hooks);
  await runTask("[POLICY]", {}, hooks);
  await runTask("[IDENTITY] init", {}, hooks);
  await runTask('[WEBMCP@shop.example] call addToCart {"sku":"A1","qty":2}', {}, hooks);
  await runTask("[WEBMCP] list", {}, hooks);
  assert.deepEqual(calls[0], { op: "audit", arg: "20", urlMatch: "" });
  assert.deepEqual(calls[1], { op: "rec", arg: "on", label: "checkout flow" });
  assert.deepEqual(calls[2], { op: "rec", arg: "status", label: "" });
  assert.deepEqual(calls[3], { op: "replay", arg: "r/x.html" });
  assert.deepEqual(calls[4], { op: "policy" });
  assert.deepEqual(calls[5], { op: "identity", arg: "init" });
  assert.deepEqual(calls[6], { op: "webmcp", arg: "call", tool: "addToCart", args: { sku: "A1", qty: 2 }, urlMatch: "shop.example" });
  assert.deepEqual(calls[7], { op: "webmcp", arg: "list", tool: "", args: {}, urlMatch: "" });
  await assert.rejects(runTask("[WEBMCP] call x {bad", {}, hooks), (e) => e.reason === "bad_args");
});

test("[RUN] // @save <domain>/<name> stores the script as a recipe after success only", async () => {
  const learned = [];
  let ok = true;
  const hooks = {
    run: async () => { if (!ok) throw Object.assign(new Error("boom"), { reason: "script_error" }); return '{"result":1,"log":[]}'; },
    learn: async (p) => { learned.push(p); return "ok"; },
  };
  const out = await runTask("[RUN] // @save example.com/heading\nreturn await dom('h1');", {}, hooks);
  assert.equal(JSON.parse(out).saved, "example.com/heading");
  assert.deepEqual(learned[0], { op: "set", domain: "example.com", data: { recipes: { heading: "return await dom('h1');" } } });
  ok = false;
  await assert.rejects(runTask("[RUN] // @save example.com/bad\nthrow 1", {}, hooks));
  assert.equal(learned.length, 1, "failed scripts are not saved");
});

test("[LEARNINGS] export/import route to learn ops", async () => {
  const calls = [];
  const hooks = { learn: async (p) => { calls.push(p); return "ok"; } };
  await runTask("[LEARNINGS] export", {}, hooks);
  await runTask('[LEARNINGS] import\n{"a.com":{"notes":["x"]}}', {}, hooks);
  assert.deepEqual(calls, [{ op: "export" }, { op: "import", data: { "a.com": { notes: ["x"] } } }]);
});

// ---- mini-bus: registry + CDP endpoint ----------------------------------
const SECRET = "s3cret-v09";
let bus, port, node, client;
const relayed = [];
let pushEvent;

before(async () => {
  bus = createMiniBus({ secret: SECRET, workKey: "WK-t" });
  port = await bus.listen(0, "127.0.0.1");
  const tabs = [{ targetId: "tab-7", webclawTabId: 7, type: "page", title: "Home", url: "http://x/", attached: false, canAccessOpener: false, browserContextId: "webclaw" }];
  node = createWebclaw({ bus: "127.0.0.1:" + port, secret: SECRET, workKey: "WK-t", name: "webclaw@relay" }, {
    cdpRelay: async (c) => {
      relayed.push(c);
      if (c.method === "webclaw.targets") return { result: tabs };
      if (c.method === "webclaw.attach") return { result: Object.assign({}, tabs[0], { attached: true }) };
      if (c.method === "webclaw.create") { tabs.push({ targetId: "tab-8", webclawTabId: 8, type: "page", title: "", url: c.params.url, attached: false }); return { result: tabs[1] }; }
      if (c.method === "Runtime.evaluate") {
        setTimeout(() => pushEvent("cdp.event", { tabId: c.tabId, method: "Runtime.consoleAPICalled", params: { type: "log" } }), 5);
        return { result: { result: { type: "number", value: 42 } } };
      }
      if (c.method === "Page.crash") return { error: { code: -32000, message: "nope" } };
      return { result: {} };
    },
  });
  pushEvent = node.pushEvent;
  client = createClient({ bus: "127.0.0.1:" + port, secret: SECRET, workKey: "WK-t" });
  for (let i = 0; i < 50; i++) {
    try { if ((await client.nodes()).some((n) => n.name === "webclaw@relay")) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 50));
  }
});
after(async () => { node.disconnect(); await bus.close(); });

test("skill registry: publish → list → download", async () => {
  const j = await client.registryPublish("webclaw-learnings", "20261021T000000", '{"a.com":{}}', "test");
  assert.equal(j.ok, true);
  const e = await client.registryGet("webclaw-learnings");
  assert.equal(e.version, "20261021T000000");
  assert.equal(e.content, '{"a.com":{}}');
  await assert.rejects(client.registryGet("missing"), (err) => err.reason === "not_found");
});

test("CDP endpoint: discovery needs the secret in the path and a loopback Host", async () => {
  const base = "http://127.0.0.1:" + port;
  assert.equal((await fetch(base + "/cdp/wrong/json/version")).status, 401, "wrong secret falls through to the authenticated REST surface");
  const v = await (await fetch(base + "/cdp/" + SECRET + "/json/version/")).json();
  assert.match(v.webSocketDebuggerUrl, new RegExp("^ws://127\\.0\\.0\\.1:" + port + "/cdp/" + SECRET + "/devtools/browser/webclaw%40relay$"));
  const http = require("node:http");
  const code = await new Promise((res) => http.get({ host: "127.0.0.1", port, path: "/cdp/" + SECRET + "/json/version", headers: { host: "evil.example" } }, (r) => res(r.statusCode)));
  assert.equal(code, 403, "DNS-rebinding guard");
});

test("CDP endpoint: browser-level emulation, auto-attach, session forwarding, events, errors", async () => {
  const v = await (await fetch("http://127.0.0.1:" + port + "/cdp/" + SECRET + "/json/version")).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); inbox.push(m); waiters.forEach((w) => w()); };
  await new Promise((r) => (ws.onopen = r));
  let nextId = 0;
  const call = (method, params, sessionId) => new Promise((resolve) => {
    const id = ++nextId;
    ws.send(JSON.stringify(Object.assign({ id, method, params: params || {} }, sessionId ? { sessionId } : {})));
    const check = () => { const m = inbox.find((x) => x.id === id); if (m) resolve(m); };
    waiters.push(check); check();
  });
  const waitFor = (pred) => new Promise((resolve) => { const check = () => { const m = inbox.find(pred); if (m) resolve(m); }; waiters.push(check); check(); });

  assert.equal((await call("Browser.getVersion")).result.protocolVersion, "1.3");
  const tg = await call("Target.getTargets");
  assert.equal(tg.result.targetInfos[0].targetId, "tab-7");
  assert.equal((await call("Target.createBrowserContext")).error.code, -32000);
  await call("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });
  const att = await waitFor((m) => m.method === "Target.attachedToTarget");
  const sid = att.params.sessionId;
  assert.equal(att.params.targetInfo.targetId, "tab-7");
  const ev = await call("Runtime.evaluate", { expression: "6*7" }, sid);
  assert.equal(ev.sessionId, sid);
  assert.equal(ev.result.result.value, 42);
  const fwd = relayed.find((c) => c.method === "Runtime.evaluate");
  assert.equal(fwd.tabId, 7);
  const evt = await waitFor((m) => m.method === "Runtime.consoleAPICalled");
  assert.equal(evt.sessionId, sid, "events carry the page session id");
  const bad = await call("Page.crash", {}, sid);
  assert.equal(bad.error.message, "nope");
  assert.equal((await call("Runtime.evaluate", {}, "no-such-session")).error.code, -32001);
  const created = await call("Target.createTarget", { url: "about:blank" });
  assert.equal(created.result.targetId, "tab-8");
  ws.close();
});
