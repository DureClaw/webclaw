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

// ---- v0.7.0 — native CDP, @refs, [RUN], Spaces, learnings ----------------

const { runTask, parseCdp } = require("../core.js");

test("[OUTLINE] and [SNAPSHOT] route to the outline action with the target tab", async () => {
  const calls = [];
  const hooks = { act: async (p) => { calls.push(p); return "refs: 0"; } };
  await runTask("[OUTLINE@github.com] 50", {}, hooks);
  await runTask("[SNAPSHOT]", {}, hooks);
  assert.deepEqual(calls[0], { action: "outline", code: "50", urlMatch: "github.com" });
  assert.equal(calls[1].action, "outline");
});

test("[CDP] parses method + JSON params; bad JSON fails with reason bad_args", async () => {
  assert.deepEqual(parseCdp('Page.captureScreenshot {"format":"png"}'), { method: "Page.captureScreenshot", params: { format: "png" } });
  assert.deepEqual(parseCdp("Page.reload"), { method: "Page.reload", params: {} });
  const hooks = { act: async () => "{}" };
  const { ws } = makeNode(hooks);
  const id = await dispatch(ws, hooks, "[CDP] Page.reload {oops");
  const r = resultFor(ws, id);
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "bad_args");
});

test("[UPLOAD] splits the file list; [WAIT] carries the timeout", async () => {
  const calls = [];
  const hooks = { act: async (p) => { calls.push(p); return "ok"; } };
  await runTask("[UPLOAD] @7 :: /tmp/a.pdf, /tmp/b.png", {}, hooks);
  await runTask("[WAIT] text:Saved :: 5000", {}, hooks);
  assert.deepEqual(calls[0].files, ["/tmp/a.pdf", "/tmp/b.png"]);
  assert.equal(calls[0].selector, "@7");
  assert.equal(calls[1].action, "wait");
  assert.equal(calls[1].selector, "text:Saved");
  assert.equal(calls[1].value, "5000");
});

test("[TYPE] now routes to the trusted 'type' action, [FILL] stays 'fill'", async () => {
  const calls = [];
  const hooks = { act: async (p) => { calls.push(p); return "ok"; } };
  await runTask("[TYPE] @3\nhello", {}, hooks);
  await runTask("[FILL] @3\nhello", {}, hooks);
  assert.equal(calls[0].action, "type");
  assert.equal(calls[0].selector, "@3");
  assert.equal(calls[1].action, "fill");
});

test("[RUN] hands the script body and target to hooks.run", async () => {
  let got;
  const hooks = { run: async (code, o) => { got = { code, o }; return '{"result":1}'; } };
  const out = await runTask("[RUN@space:leads] const a = 1;\nreturn a;", {}, hooks);
  assert.equal(out, '{"result":1}');
  assert.equal(got.code, "const a = 1;\nreturn a;");
  assert.equal(got.o.urlMatch, "space:leads");
});

test("noBrain (script context): nested [RUN] and unknown markers fail instead of reaching the brain", async () => {
  const hooks = { run: async () => "x" };
  await assert.rejects(runTask("[RUN] 1", {}, hooks, { noBrain: true }), (e) => e.reason === "nested_run");
  await assert.rejects(runTask("[CLIK] #x", { brainUrl: "http://never" }, hooks, { noBrain: true }), (e) => e.reason === "bad_args");
});

test("[RECIPE] fetches the learned script and runs it with JSON args", async () => {
  const seen = {};
  const hooks = {
    learn: async (p) => { seen.learn = p; return "return args.q;"; },
    run: async (code, o) => { seen.run = { code, o }; return "ok"; },
  };
  await runTask('[RECIPE] github.com/search\n{"q":"webclaw"}', {}, hooks);
  assert.deepEqual(seen.learn, { op: "recipe", domain: "github.com", name: "search" });
  assert.equal(seen.run.code, "return args.q;");
  assert.deepEqual(seen.run.o.args, { q: "webclaw" });
});

test("[LEARN]/[LEARNED]/[FORGET] map to learn ops", async () => {
  const calls = [];
  const hooks = { learn: async (p) => { calls.push(p); return "ok"; } };
  await runTask('[LEARN] example.com\n{"notes":["n1"]}', {}, hooks);
  await runTask("[LEARNED]", {}, hooks);
  await runTask("[LEARNED] https://www.example.com/x", {}, hooks);
  await runTask("[FORGET] example.com", {}, hooks);
  assert.deepEqual(calls[0], { op: "set", domain: "example.com", data: { notes: ["n1"] } });
  assert.deepEqual(calls[1], { op: "list" });
  assert.deepEqual(calls[2], { op: "get", domain: "https://www.example.com/x" });
  assert.deepEqual(calls[3], { op: "forget", domain: "example.com" });
  await assert.rejects(runTask("[LEARN] example.com", {}, hooks), (e) => e.reason === "bad_args");
});

test("[SPACE]/[SPACES]/[HANDOFF]/[TAKEOVER] map to space ops; [OPEN] passes its target", async () => {
  const calls = [];
  const hooks = { space: async (p) => { calls.push(p); return "ok"; }, open: async (u, m) => { calls.push({ open: u, m }); return "ok"; } };
  await runTask("[SPACE] leads", {}, hooks);
  await runTask("[SPACES]", {}, hooks);
  await runTask("[HANDOFF] leads :: 로그인 해주세요", {}, hooks);
  await runTask("[TAKEOVER]", {}, hooks);
  await runTask("[OPEN@space:leads] https://example.com", {}, hooks);
  assert.deepEqual(calls[0], { op: "space", arg: "leads" });
  assert.deepEqual(calls[1], { op: "list" });
  assert.deepEqual(calls[2], { op: "handoff", arg: "leads", note: "로그인 해주세요" });
  assert.deepEqual(calls[3], { op: "takeover", arg: "", note: "" });
  assert.deepEqual(calls[4], { open: "https://example.com", m: "space:leads" });
});

test("brain delegation prepends learned site notes from hooks.learnContext", async () => {
  const realFetch = global.fetch;
  let body;
  global.fetch = async (_u, init) => { body = JSON.parse(init.body); return { json: async () => ({ output: "ok" }) }; };
  try {
    const out = await runTask("summarize this page", { brainUrl: "http://brain" }, { learnContext: async () => "Site notes for example.com:\n- n1" });
    assert.equal(out, "ok");
    assert.equal(body.prompt, "Site notes for example.com:\n- n1\n\nsummarize this page");
  } finally { global.fetch = realFetch; }
});
