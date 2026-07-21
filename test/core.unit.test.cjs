// Unit tests for core.js — pure marker routing + failure elevation logic,
// run fully offline against a fake bus WebSocket (no network, no live bus).
// `node test/node-test.cjs` remains the separate live-bus smoke test; this
// file only exercises code paths that don't need a real Phoenix socket.
"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// ---- fake bus WebSocket: records every frame createWebclaw() sends -------
class FakeWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    FakeWS.last = this;
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
}
global.WebSocket = FakeWS;

const { createWebclaw } = require("../core.js");

// createWebclaw() starts a 15s heartbeat setInterval — track every instance
// created across the suite and disconnect() them all in one `after()` hook
// (clears the interval), so `node --test` can exit instead of hanging on a
// live timer.
const activeNodes = [];
after(() => { for (const n of activeNodes) n.disconnect(); });

// Create a node and simulate the bus accepting the join, so `handle()` is
// reachable. Clears the phx_join frame from `sent` — tests only care about
// what a dispatched task produces.
function makeNode(hooks) {
  const cfg = { bus: "fake.bus", workKey: "WK", name: "webclaw@test" };
  const wc = createWebclaw(cfg, hooks);
  activeNodes.push(wc);
  const ws = FakeWS.last;
  ws.onopen();
  ws.sent.length = 0;
  return { wc, ws };
}

// Push a task.assign frame (as the bus would) and resolve once the node has
// sent its task.result back out (hooks.onTask fires with dir:"out" right
// after that send — see core.js handle()).
function dispatch(ws, hooks, instr, taskId) {
  taskId = taskId || "t-" + Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const prevOnTask = hooks.onTask;
    hooks.onTask = (t) => {
      if (prevOnTask) prevOnTask(t);
      if (t.dir === "out") { hooks.onTask = prevOnTask; resolve(taskId); }
    };
    ws.onmessage({
      data: JSON.stringify([null, "1", "work:WK", "task.assign",
        { task_id: taskId, to: "webclaw@test", from: "master@test", instructions: instr }]),
    });
  });
}

function resultFor(ws, taskId) {
  const f = ws.sent.find((fr) => fr[3] === "task.result" && fr[4].task_id === taskId);
  assert.ok(f, "no task.result frame sent for " + taskId);
  return f[4];
}

// ---- issue #16 — [SCREENSHOT] marker + [DIFF] ... :: screenshot ----------

test("[SCREENSHOT] and [SHOT] both route to the same shot action", async () => {
  const calls = [];
  const hooks = { act: async (p) => { calls.push(p); return "ok"; } };
  const { ws } = makeNode(hooks);
  const id1 = await dispatch(ws, hooks, "[SCREENSHOT] shots/a.jpg");
  const id2 = await dispatch(ws, hooks, "[SHOT] shots/b.jpg");
  assert.equal(calls[0].action, "shot");
  assert.equal(calls[0].code, "shots/a.jpg");
  assert.equal(calls[1].action, "shot");
  assert.equal(calls[1].code, "shots/b.jpg");
  assert.equal(resultFor(ws, id1).status, "done");
  assert.equal(resultFor(ws, id2).status, "done");
});

test("[DIFF] ... :: screenshot sets shot:true and strips the suffix from code", async () => {
  const calls = [];
  const hooks = { act: async (p) => { calls.push(p); return "{}"; } };
  const { ws } = makeNode(hooks);
  await dispatch(ws, hooks, "[DIFF] click:#submit :: screenshot");
  assert.equal(calls[0].action, "diff");
  assert.equal(calls[0].code, "click:#submit");
  assert.equal(calls[0].shot, true);
});

test("[DIFF] without the suffix leaves shot:false and code untouched", async () => {
  const calls = [];
  const hooks = { act: async (p) => { calls.push(p); return "{}"; } };
  const { ws } = makeNode(hooks);
  await dispatch(ws, hooks, "[DIFF] click:#submit");
  assert.equal(calls[0].shot, false);
  assert.equal(calls[0].code, "click:#submit");
});

// ---- issue #15 — [FILL]/[TYPE] newline-first split ------------------------

test("[FILL] splits on newline first, so '=' inside an attribute selector survives", async () => {
  const calls = [];
  const hooks = { act: async (p) => { calls.push(p); return "filled"; } };
  const { ws } = makeNode(hooks);
  await dispatch(ws, hooks, '[FILL] input[name="company"]\nAcme Inc');
  assert.equal(calls[0].selector, 'input[name="company"]');
  assert.equal(calls[0].value, "Acme Inc");
});

test("[FILL] ' = ' shorthand still works when the selector has no '=' of its own", async () => {
  const calls = [];
  const hooks = { act: async (p) => { calls.push(p); return "filled"; } };
  const { ws } = makeNode(hooks);
  await dispatch(ws, hooks, "[FILL] #company = Acme Inc");
  assert.equal(calls[0].selector, "#company");
  assert.equal(calls[0].value, "Acme Inc");
});

// ---- issue #14 — structured failure → status/exit_code/reason -------------

test("act rejection with reason:no_match elevates status/exit_code/reason", async () => {
  const hooks = { act: async () => { throw Object.assign(new Error("(no match: #missing)"), { reason: "no_match" }); } };
  const { ws } = makeNode(hooks);
  const id = await dispatch(ws, hooks, "[CLICK] #missing");
  const r = resultFor(ws, id);
  assert.equal(r.status, "failed");
  assert.equal(r.exit_code, 1);
  assert.equal(r.reason, "no_match");
  assert.match(r.output, /\(no match: #missing\)/);
});

test("act rejection with reason:value_mismatch is carried through to task.result", async () => {
  const hooks = { act: async () => { throw Object.assign(new Error("filled #x = a (WARNING: page kept a different value than sent: b)"), { reason: "value_mismatch" }); } };
  const { ws } = makeNode(hooks);
  const id = await dispatch(ws, hooks, "[FILL] #x\nb");
  const r = resultFor(ws, id);
  assert.equal(r.status, "failed");
  assert.equal(r.exit_code, 1);
  assert.equal(r.reason, "value_mismatch");
});

test("a successful act carries no `reason` field, status done / exit_code 0", async () => {
  const hooks = { act: async () => "clicked #x @1,2" };
  const { ws } = makeNode(hooks);
  const id = await dispatch(ws, hooks, "[CLICK] #x");
  const r = resultFor(ws, id);
  assert.equal(r.status, "done");
  assert.equal(r.exit_code, 0);
  assert.equal("reason" in r, false);
});

// ---- issue #5 — client-side delivery ack + reconnect re-announce ----------

test("task.ack is sent immediately on pickup, before task.result", async () => {
  let resolveAct;
  const hooks = { act: () => new Promise((res) => { resolveAct = res; }) };
  const { ws } = makeNode(hooks);
  const donePromise = dispatch(ws, hooks, "[CLICK] #x", "tid-ack");
  await new Promise((r) => setImmediate(r)); // let the ack's microtasks flush
  const ack = ws.sent.find((f) => f[3] === "task.ack" && f[4].task_id === "tid-ack");
  assert.ok(ack, "task.ack not sent on pickup");
  assert.equal(ws.sent.some((f) => f[3] === "task.result"), false, "task.result sent before act resolved");
  resolveAct("ok");
  await donePromise;
});

test("reconnect after a socket close re-announces presence via a fresh phx_join", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cfg = { bus: "fake.bus", workKey: "WK", name: "webclaw@test" };
  const wc = createWebclaw(cfg, {});
  activeNodes.push(wc);
  const ws1 = FakeWS.last;
  ws1.onopen();
  assert.equal(ws1.sent.length, 1);
  assert.equal(ws1.sent[0][3], "phx_join");
  ws1.onclose(); // schedules setTimeout(connect, 3000)
  t.mock.timers.tick(3000);
  const ws2 = FakeWS.last;
  assert.notEqual(ws1, ws2, "reconnect should open a new WebSocket");
  ws2.onopen();
  assert.equal(ws2.sent.length, 1);
  assert.equal(ws2.sent[0][3], "phx_join", "reconnect must re-join, not resume silently");
  wc.disconnect();
});

// ---- regression guard for the 0.6.1 → 0.6.3 → 0.6.4 version bump ----------

test("version string stays in sync across manifest.json, core.js, and the offscreen bootstrap", () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const coreSrc = fs.readFileSync(path.join(root, "core.js"), "utf8");
  const bgSrc = fs.readFileSync(path.join(root, "background.js"), "utf8");
  const coreVersion = coreSrc.match(/version:\s*"webclaw\/([\d.]+)"/)[1];
  const offscreenVersion = bgSrc.match(/offscreen\.html\?v=([\d.]+)/)[1];
  assert.equal(coreVersion, manifest.version, "core.js phx_join version drifted from manifest.json");
  assert.equal(offscreenVersion, manifest.version, "offscreen.html?v= cache-buster drifted from manifest.json");
});
