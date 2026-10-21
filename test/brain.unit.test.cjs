// System One brain tests — the goal loop against the mock Jev oracle and a
// fake page (no browser): state building, option mapping, confidence gating,
// fallback, stuck detection, recipe crystallization, the brain HTTP contract.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { runGoal, parseOutline, valueCandidates, buildRequest, recipeScript, shortlist } = require("../bridge/brain/agent.cjs");
const { createJev } = require("../bridge/brain/jev.cjs");
const { goalFromPrompt, createBrainServer } = require("../bridge/brain/server.cjs");
const { createMockJev } = require("./mock-jev.cjs");

const GOAL = 'Log in as alice with password "s3cret"';
let mock, jev;
before(async () => {
  mock = createMockJev({ scripts: {
    [GOAL]: [{ kind: "type", target: 'textbox "Username"', value: "alice" }, { kind: "type", target: 'textbox "Password"', value: "s3cret" }, { kind: "click", target: 'button "Sign in"' }],
    "Delete the account": [{ kind: "click", target: 'button "Delete account"', p: 0.6 }],
    "Press OK forever": [{ kind: "click", target: 'button "OK"' }, { kind: "click", target: 'button "OK"' }, { kind: "click", target: 'button "OK"' }, { kind: "click", target: 'button "OK"' }],
  } });
  const port = await mock.listen();
  jev = createJev({ apiKey: "test-key", baseUrl: "http://127.0.0.1:" + port });
});
after(() => mock.close());

// a fake login page driven by markers
function fakeLogin() {
  const st = { u: "", p: "", in: false };
  const outline = () => st.in
    ? "Home | http://x/home\nrefs: 1\n# Welcome, alice\n@1 link \"Log out\" → /logout"
    : 'Login | http://x/login\nrefs: 3\n# Sign in\n@1 textbox "Username" value=' + JSON.stringify(st.u) + '\n@2 textbox "Password" type=password\n@3 button "Sign in"';
  const sent = [];
  return { st, sent, dispatch: async (mk) => {
    sent.push(mk);
    if (mk.startsWith("[OUTLINE")) return { status: "done", output: outline() };
    let m;
    if ((m = mk.match(/^\[TYPE[^\]]*\] (@\d)\n([\s\S]*)$/))) { if (m[1] === "@1") st.u = m[2]; if (m[1] === "@2") st.p = m[2]; return { status: "done", output: "typed" }; }
    if ((m = mk.match(/^\[CLICK[^\]]*\] (@\d)$/))) { if (m[1] === "@3" && st.u === "alice" && st.p === "s3cret") st.in = true; return { status: "done", output: "clicked" }; }
    if (mk.startsWith("[LEARN]")) return { status: "done", output: "learned" };
    return { status: "failed", reason: "no_match", output: "?" };
  } };
}

test("parseOutline / valueCandidates / shortlist", () => {
  const p = parseOutline('T | http://u\nrefs: 2\n# Head\n@1 textbox "Name" value="x"\n@2 button "Go \\"now\\""\n== frame http://f');
  assert.equal(p.title, "T");
  assert.deepEqual(p.elements.map((e) => e.ref), ["@1", "@2"]);
  assert.equal(p.elements[1].name, 'Go \\"now\\"');
  assert.deepEqual(p.context, ["# Head", "== frame http://f"]);
  const v = valueCandidates('Sign up as bob@x.io, country KR, plan "Pro plan" and pay 1,200');
  for (const x of ["Pro plan", "bob@x.io", "KR", "1,200"]) assert.ok(v.includes(x), x + " in " + JSON.stringify(v));
  const many = Array.from({ length: 400 }, (_, i) => ({ ref: "@" + i, role: "link", name: "n" + i, raw: 'link "n' + i + '"' }));
  many[333].raw = 'button "Checkout now"';
  const sl = shortlist(many, "checkout");
  assert.equal(sl.length, 240);
  assert.ok(sl.some((e) => e.ref === "@333"), "goal-relevant element survives the cut");
});

test("buildRequest: one fan-out request — done/kind/target/value, ≤255 options", () => {
  const p = parseOutline('L | http://x\nrefs: 2\n@1 textbox "Username"\n@2 button "Sign in"');
  const { state, questions } = buildRequest(GOAL, p, [], valueCandidates(GOAL));
  assert.deepEqual(Object.keys(questions).sort(), ["done", "kind", "target", "value"]);
  assert.equal(questions.done.type, "noul");
  assert.deepEqual(Object.keys(questions.target.criteria), ["@1", "@2"]);
  assert.ok(Object.values(questions.value.criteria).includes("alice"));
  assert.ok(Object.values(questions.value.criteria).includes("s3cret"));
  assert.equal(state.goal, GOAL);
});

test("runGoal reaches the goal: 3 actions, done detected, recipe saved", async () => {
  const page = fakeLogin();
  const r = await runGoal({ webclaw: page, jev, goal: GOAL, save: "x/login" });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  assert.equal(r.reason, "done");
  assert.equal(page.st.in, true);
  assert.deepEqual(r.actions.map((a) => a.kind + ":" + a.name + (a.value ? "=" + a.value : "")), ["type:Username=alice", "type:Password=s3cret", "click:Sign in"]);
  assert.equal(r.stats.decisions, 4, "3 acting decisions + 1 'done'");
  assert.equal(r.saved, "x/login");
  const learn = page.sent.find((s) => s.startsWith("[LEARN] x\n"));
  const script = JSON.parse(learn.slice(learn.indexOf("\n") + 1)).recipes.login;
  assert.match(script, /await type\(await ref\("textbox", "Username"\), "alice"\);/);
  assert.match(script, /await click\(await ref\("button", "Sign in"\)\);/);
});

test("low confidence stops (or escalates to the fallback brain)", async () => {
  const r = await runGoal({ webclaw: fakeLogin(), jev, goal: "Something the oracle does not know" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "low_confidence");
  const fb = [];
  const page = fakeLogin();
  const r2 = await runGoal({ webclaw: page, jev, goal: "Something the oracle does not know", maxSteps: 2,
    fallback: async (s) => { fb.push(s); return fb.length === 1 ? { kind: "click", target: "@3" } : { kind: "done" }; } });
  assert.equal(r2.ok, true);
  assert.equal(r2.reason, "done_by_fallback");
  assert.equal(r2.stats.fallbacks, 2);
  assert.ok(page.sent.includes("[CLICK] @3"), "fallback decision was executed");
});

test("risky targets need higher confidence → needs_confirmation", async () => {
  const page = { dispatch: async (mk) => mk.startsWith("[OUTLINE") ? { status: "done", output: 'A | http://a\nrefs: 2\n@1 button "Delete account"\n@2 button "Cancel"' } : { status: "done", output: "x" } };
  const r = await runGoal({ webclaw: page, jev, goal: "Delete the account" });
  assert.equal(r.reason, "needs_confirmation");
});

test("the same action three times without progress → stuck", async () => {
  const page = { dispatch: async (mk) => mk.startsWith("[OUTLINE") ? { status: "done", output: 'A | http://a\nrefs: 1\n@1 button "OK"' } : { status: "done", output: "x" } };
  const r = await runGoal({ webclaw: page, jev, goal: "Press OK forever" });
  assert.equal(r.reason, "stuck");
});

test("Jev client: bad key → jev_unauthorized; missing key → no_api_key", async () => {
  const bad = createJev({ apiKey: "nope", baseUrl: jev.baseUrl });
  await assert.rejects(bad.systemOne({ goal: "x", history: [] }, {}), (e) => e.reason === "jev_unauthorized");
  const none = createJev({ apiKey: "", baseUrl: jev.baseUrl });
  const saved = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  await assert.rejects(createJev({ baseUrl: jev.baseUrl }).systemOne({}, {}), (e) => e.reason === "no_api_key");
  if (saved) process.env.TYPESAFE_API_KEY = saved;
  assert.equal(none.hasKey, false);
});

test("brain server: HUD prompt → goal + tab, runs the loop, answers /brain/exec", async () => {
  assert.deepEqual(goalFromPrompt("You drive a browser…\nCurrent tab: http://127.0.0.1:4801/login.html?x=1\nUser: " + GOAL), { goal: GOAL, tab: "127.0.0.1:4801/login.html" });
  assert.deepEqual(goalFromPrompt("Site notes for a.com:\n- n\n\nfind the price"), { goal: "find the price", tab: "" });
  const page = fakeLogin();
  const srv = createBrainServer({ webclaw: page, jev, token: "tok" });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + srv.address().port + "/brain/exec";
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
  const j = await (await fetch(url, { method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ prompt: "Current tab: http://x/login\nUser: " + GOAL }) })).json();
  assert.match(j.output, /^✅ 완료 — 4번 판단, 3개 동작/);
  assert.equal(page.st.in, true);
  srv.close();
});

test("recipeScript replays by role+name (no refs, no model)", () => {
  const s = recipeScript("g", [{ kind: "select", role: "combobox", name: "Country", value: "KR" }, { kind: "wait" }]);
  assert.match(s, /await fill\(await ref\("combobox", "Country"\), "KR"\);/);
  assert.match(s, /await sleep\(800\);/);
});
