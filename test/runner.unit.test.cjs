// Unit tests for runner.js — the [RUN] script host. Pure: helpers are checked
// by the marker strings they emit through a fake `call`.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runScript } = require("../runner.js");

function recorder(reply) {
  const sent = [];
  const call = async (text) => { sent.push(text); return typeof reply === "function" ? reply(text) : (reply ?? "ok"); };
  return { sent, call };
}

test("script body is an async function: return value + console/log lines come back", async () => {
  const { call } = recorder();
  const res = await runScript("log('a', {b:1}); console.log('c'); await sleep(1); return 42;", call);
  assert.deepEqual(res, { ok: true, result: 42, log: ['a {"b":1}', "c"] });
});

test("helpers emit the matching markers, with per-call and default tab targets", async () => {
  const { sent, call } = recorder();
  await runScript(`
    await open('https://example.com');
    useTab('example.com');
    await click('@3');
    await fill('input[name="q"]', 'a = b');
    await type('@4', 'hi', { tab: 'other.com' });
    await wait('text:Done', 2000);
    await upload('@9', ['/a.pdf', '/b.pdf']);
    await cdp('Page.reload', { ignoreCache: true });
    useSpace('leads');
    await outline();
  `, call);
  assert.deepEqual(sent, [
    "[OPEN] https://example.com",
    "[CLICK@example.com] @3",
    '[FILL@example.com] input[name="q"]\na = b',
    "[TYPE@other.com] @4\nhi",
    "[WAIT@example.com] text:Done :: 2000",
    "[UPLOAD@example.com] @9 :: /a.pdf, /b.pdf",
    '[CDP@example.com] Page.reload {"ignoreCache":true}',
    "[OUTLINE@space:leads]",
  ]);
});

test("space() creates/selects a space and makes it the script's default target", async () => {
  const { sent, call } = recorder();
  await runScript("await space('leads'); await dom('h1'); await handOff('captcha');", call);
  assert.deepEqual(sent, ["[SPACE] leads", "[DOM@space:leads] h1", "[HANDOFF] leads :: captcha"]);
});

test("JSON-returning helpers parse their output", async () => {
  const { call } = recorder((t) => (t.startsWith("[LINKS]") ? '[{"text":"x","href":"/x"}]' : "plain"));
  const res = await runScript("const l = await links(); const d = await dom(); return { n: l.length, d };", call);
  assert.deepEqual(res.result, { n: 1, d: "plain" });
});

test("a failing marker throws with its reason; uncaught → ok:false carrying it", async () => {
  const call = async () => { throw Object.assign(new Error("(no match: #x)"), { reason: "no_match" }); };
  const res = await runScript("log('before'); await click('#x'); return 1;", call);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_match");
  assert.match(res.error, /no match/);
  assert.deepEqual(res.log, ["before"]);
  const caught = await runScript("try { await click('#x'); } catch (e) { return e.reason; }", call);
  assert.deepEqual(caught.result, "no_match");
});

test("syntax errors and thrown values become script_error", async () => {
  const { call } = recorder();
  const a = await runScript("return (", call);
  assert.equal(a.ok, false);
  assert.equal(a.reason, "script_error");
  const b = await runScript("throw new Error('boom')", call);
  assert.equal(b.reason, "script_error");
  assert.equal(b.error, "boom");
});

test("args are exposed to the script (recipes)", async () => {
  const { call } = recorder();
  const res = await runScript("return args.q + '!';", call, { args: { q: "hi" } });
  assert.equal(res.result, "hi!");
});
