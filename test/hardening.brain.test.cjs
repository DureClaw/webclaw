// System One brain hardening — regression tests for the 2026-10-21 review
// (S2, S7, A1–A4, B-brain): recipes are EXECUTED through runner.js against a
// fake page using refs.js's JSON-name outline format, fallback decisions are
// validated and gated, "done" before any action is not success, the brain
// server rejects everything that is not an authenticated extension goal.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { runGoal, valueCandidates, recipeScript, llmFallback, MUTATING_TIMEOUT_MS } = require("../bridge/brain/agent.cjs");
const { createJev } = require("../bridge/brain/jev.cjs");
const { createBrainServer, NOT_A_GOAL } = require("../bridge/brain/server.cjs");
const { runScript } = require("../runner.js");
const { createMockJev } = require("./mock-jev.cjs");

const SHOP = 'Search for "kbd" and add the second item';
const TRICKY = 'Search "q" \\ box'; // quotes + backslash in an accessible name
const NAMEBOX = 'Put "bob" in the name box';
const DEL = "Remove the old account";
const WAITER = "Wait for the slow page";
const LOGIN = 'Log in as alice with password "s3cret"';

let mock, jev;
before(async () => {
  mock = createMockJev({
    scripts: {
      [SHOP]: [{ kind: "type", ref: "@1", value: "kbd" }, { kind: "click", ref: "@3" }],
      [NAMEBOX]: [{ kind: "click", target: 'textbox "Name"', p: 0.3 }],
      "Delete it carefully": [{ kind: "click", target: 'button "Delete account"', p: 0.85 }],
      "Already there": [],
      "Almost sure it is there": [],
      [WAITER]: Array.from({ length: 10 }, () => ({ kind: "wait" })),
      [LOGIN]: [{ kind: "type", target: 'textbox "Username"', value: "alice" }, { kind: "type", target: 'textbox "Password"', value: "s3cret" }, { kind: "click", target: 'button "Sign in"' }],
    },
    nouls: {
      "Always yes": { done: 1, shows_result: 1, needs_action: 1 }, // a model biased to "yes" (zero-shot Laya)
      "Almost sure it is there": { done: 0.9 },
    },
  });
  const port = await mock.listen();
  jev = createJev({ apiKey: "test-key", baseUrl: "http://127.0.0.1:" + port });
});
after(() => mock.close());

// ── fake pages ────────────────────────────────────────────────────────────
// outline lines exactly as refs.js now prints them: `@N role JSON(name)…`
const line = (n, role, name, suffix) => "@" + n + " " + role + " " + JSON.stringify(name) + (suffix || "");

// shop: a search box with a tricky name and two "Add" buttons (duplicate names).
// `shifted` prepends a link so every ref moves — replay must not rely on refs.
function shop(shifted) {
  const st = { typed: null, added: null };
  const els = [];
  if (shifted) els.push(["link", "Home", " → /"]);
  els.push(["searchbox", TRICKY, ""], ["button", "Add", ""], ["button", "Add", ""]);
  const refOf = {}; // "@N" → index into els
  const outline = () => "Shop | http://s/\nrefs: " + els.length + "\n# Items\n" + els.map((e, i) => { refOf["@" + (i + 1)] = i; return line(i + 1, e[0], e[1], e[2] + (e[0] === "searchbox" && st.typed ? " value=" + JSON.stringify(st.typed) : "")); }).join("\n");
  const sent = [];
  const dispatch = async (mk) => {
    sent.push(mk);
    if (mk.startsWith("[OUTLINE")) return { status: "done", output: outline() };
    let m;
    if ((m = mk.match(/^\[TYPE[^\]]*\] (@\d+)\n([\s\S]*)$/))) {
      const e = els[refOf[m[1]]];
      if (!e || e[0] !== "searchbox") return { status: "failed", reason: "no_match", output: "?" };
      st.typed = m[2]; return { status: "done", output: "typed" };
    }
    if ((m = mk.match(/^\[CLICK[^\]]*\] (@\d+)$/))) {
      const i = refOf[m[1]], e = els[i];
      if (!e || e[1] !== "Add") return { status: "failed", reason: "no_match", output: "?" };
      st.added = els.slice(0, i).filter((x) => x[1] === "Add").length === 0 ? "A" : "B";
      return { status: "done", output: "clicked" };
    }
    if (mk.startsWith("[LEARN]")) return { status: "done", output: "learned" };
    return { status: "failed", reason: "no_match", output: "?" };
  };
  // runner.js host: marker → output text, failures throw with .reason
  const call = async (mk) => { const r = await dispatch(mk); if (r.status !== "done") throw Object.assign(new Error(r.output), { reason: r.reason }); return r.output; };
  return { st, sent, dispatch, call };
}

function staticPage(outline, onAct) {
  const sent = [];
  return { sent, dispatch: async (mk, op) => {
    sent.push(mk);
    if (mk.startsWith("[OUTLINE")) return { status: "done", output: outline };
    return onAct ? onAct(mk, op) : { status: "done", output: "ok" };
  } };
}
const mutating = (sent) => sent.filter((s) => /^\[(CLICK|TYPE|FILL)/.test(s));

const recipeOf = (page, name) => {
  const learn = page.sent.find((s) => s.startsWith("[LEARN] "));
  return JSON.parse(learn.slice(learn.indexOf("\n") + 1)).recipes[name];
};

// ── A4 + S7: recorded recipes replay through runner.js ──────────────────────
test("A4/S7: recipe is executed by runner.js — JSON names, duplicate names (nth), args placeholders", async () => {
  const page = shop(false);
  const r = await runGoal({ webclaw: page, jev, goal: SHOP, save: "s/add2" });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 500));
  assert.equal(page.st.added, "B");
  assert.deepEqual(r.actions.map((a) => a.kind + ":" + a.name + "#" + a.nth), ["type:" + TRICKY + "#0", "click:Add#1"]);
  const script = recipeOf(page, "add2");
  assert.ok(!script.includes("kbd"), "typed value is not stored in the recipe");
  assert.match(script, /args\.v1 → searchbox /);

  // replay on a page where every ref has shifted
  const again = shop(true);
  const out = await runScript(script, again.call, { args: { v1: "kbd" } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(again.st.typed, "kbd");
  assert.equal(again.st.added, "B", "the SECOND 'Add' was clicked, not the first");
  assert.ok(again.sent.includes("[TYPE] @2\nkbd") && again.sent.includes("[CLICK] @4"), JSON.stringify(again.sent));

  // no args → refuses instead of typing "undefined"
  const noArgs = await runScript(script, shop(true).call, {});
  assert.equal(noArgs.ok, false);
  assert.equal(noArgs.reason, "missing_arg");
});

test("S7: password fields are never recorded — recipe uses args.password, goal text redacted", async () => {
  const st = { u: "", p: "", in: false };
  const page = { sent: [], dispatch: async (mk) => {
    page.sent.push(mk);
    if (mk.startsWith("[OUTLINE")) return { status: "done", output: st.in ? "Home | http://x/home\nrefs: 1\n# Welcome\n" + line(1, "link", "Log out") : "Login | http://x/login\nrefs: 3\n" + line(1, "textbox", "Username", st.u ? " value=" + JSON.stringify(st.u) : "") + "\n" + line(2, "textbox", "Password", " type=password") + "\n" + line(3, "button", "Sign in") };
    let m;
    if ((m = mk.match(/^\[TYPE[^\]]*\] (@\d)\n([\s\S]*)$/))) { if (m[1] === "@1") st.u = m[2]; else st.p = m[2]; return { status: "done", output: "typed" }; }
    if (/^\[CLICK[^\]]*\] @3$/.test(mk)) { st.in = st.u === "alice" && st.p === "s3cret"; return { status: "done", output: "clicked" }; }
    return { status: "done", output: "learned" };
  } };
  const r = await runGoal({ webclaw: page, jev, goal: LOGIN, save: "x/login" });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  const script = recipeOf(page, "login");
  assert.ok(!script.includes("s3cret"), script);
  assert.ok(!script.includes("alice"), "goal text in the header is redacted");
  assert.match(script, /arg\("password"\)/);
  assert.match(script, /args\.password → textbox "Password" \(password field — never recorded\)/);
  assert.ok(!JSON.stringify(r.actions).includes("s3cret") && !JSON.stringify(r.history).includes("s3cret"));
  // the history Jev sees on later steps never carries the password either
  assert.ok(!mock.calls.filter((c) => c.state.goal === LOGIN).some((c) => c.state.history.join("\n").includes("s3cret")));
});

// ── A2: fallback decisions are validated and gated ──────────────────────────
const NAME_PAGE = "F | http://f/\nrefs: 2\n" + line(1, "textbox", "Name") + "\n" + line(2, "button", "Save");

test("A2: fallback says type while Jev said click → the typed value is executed and recorded (as a placeholder)", async () => {
  const page = staticPage(NAME_PAGE, (mk) => ({ status: "done", output: mk.startsWith("[LEARN]") ? "learned" : "ok" }));
  let n = 0;
  const r = await runGoal({ webclaw: page, jev, goal: NAMEBOX, save: "f/name", fallback: async () => (++n === 1 ? { kind: "type", target: "@1", value: "bob" } : { kind: "done" }) });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  assert.equal(r.reason, "done", "Jev confirms the goal after the fallback-typed step");
  assert.ok(r.steps[0].kind.startsWith("click:"), "Jev's (low-confidence) pick was click");
  assert.deepEqual(mutating(page.sent), ["[TYPE] @1\nbob"]);
  assert.deepEqual(r.actions, [{ kind: "type", role: "textbox", name: "Name", nth: 0, value: "bob" }]);
  assert.equal(r.history[0].kind, "type");
  assert.equal(r.history[0].value, "bob");
  const script = recipeOf(page, "name");
  assert.match(script, /await type\(await ref\("textbox", "Name", 0\), arg\("v1"\)\);/);
  assert.ok(!script.includes("bob"));
});

test("A2: invalid fallback decisions → low_confidence, nothing executed", async () => {
  const bad = [null, "click @1", {}, { kind: "fly" }, { kind: "click" }, { kind: "click", target: "@99" }, { kind: "click", target: "div.secret" },
    { kind: "type", target: "@1" }, { kind: "type", target: "@1", value: "" }, { kind: "select", target: "@1", value: 42 }];
  for (const fb of bad) {
    const page = staticPage(NAME_PAGE);
    const r = await runGoal({ webclaw: page, jev, goal: "Unknown goal for the oracle", fallback: async () => fb });
    assert.equal(r.reason, "low_confidence", JSON.stringify(fb) + " → " + r.reason);
    assert.match(r.detail, /fallback decision rejected/);
    assert.deepEqual(mutating(page.sent), [], JSON.stringify(fb));
  }
});

const DEL_PAGE = "A | http://a/\nrefs: 2\n" + line(1, "button", "Delete account") + "\n" + line(2, "button", "Cancel");

test("A2: risky target at confidence 0.70 (≥ min 0.5, < risky 0.85) → needs_confirmation", async () => {
  const page = staticPage(DEL_PAGE);
  const r = await runGoal({ webclaw: page, jev, goal: "Delete it carefully" });
  assert.equal(r.reason, "needs_confirmation");
  assert.match(r.detail, /confidence 0\.70 < 0\.85/);
  assert.deepEqual(mutating(page.sent), []);
});

test("A2: a risky target chosen by the fallback brain → needs_confirmation (gate applies to fallbacks)", async () => {
  const page = staticPage(DEL_PAGE);
  const r = await runGoal({ webclaw: page, jev, goal: DEL, fallback: async () => ({ kind: "click", target: "@1" }) });
  assert.equal(r.reason, "needs_confirmation");
  assert.match(r.detail, /fallback/);
  assert.deepEqual(mutating(page.sent), []);
});

// ── A1: "done" before any action ─────────────────────────────────────────────
const HOME = "H | http://h/\nrefs: 2\n# Welcome\n" + line(1, "link", "Docs") + "\n" + line(2, "button", "Sign up");

test("A1: 'done' before any action is not success (yes-biased model, sub-0.95 done, fallback done)", async () => {
  const r1 = await runGoal({ webclaw: staticPage(HOME), jev, goal: "Always yes" });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "done_without_action");
  assert.equal(r1.steps[0].grounding.needs_action, 1, "the grounding pair was asked");
  const r2 = await runGoal({ webclaw: staticPage(HOME), jev, goal: "Almost sure it is there" });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "done_without_action");
  assert.equal(r2.steps[0].grounding, undefined, "0.90 < 0.95: no grounding call, not trusted");
  const r3 = await runGoal({ webclaw: staticPage(HOME), jev, goal: "Unknown goal for the oracle", fallback: async () => ({ kind: "done" }) });
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, "done_without_action");
});

test("A1: a page-grounded 'already done' (≥0.95 + shows result + nothing left to do) is still success", async () => {
  const r = await runGoal({ webclaw: staticPage(HOME), jev, goal: "Already there" });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "done");
  assert.equal(r.actions.length, 0);
});

// ── B-brain ──────────────────────────────────────────────────────────────────
test("B: Korean goals yield value candidates", () => {
  const v = valueCandidates("아이디 alice, 비밀번호는 s3cret로 로그인하고 검색어 「무선 키보드」 를 검색");
  for (const x of ["alice", "s3cret", "무선 키보드"]) assert.ok(v.includes(x), x + " in " + JSON.stringify(v));
  assert.ok(!v.includes("s3cret로"), "particle stripped");
  assert.ok(valueCandidates("kim로 로그인해줘").includes("kim"));
  assert.ok(valueCandidates("이름은 홍길동으로 입력").includes("홍길동"));
  assert.ok(valueCandidates("이메일: a@b.co 로 가입").includes("a@b.co"));
  assert.ok(valueCandidates("『노트북 15인치』 장바구니").includes("노트북 15인치"));
  assert.ok(valueCandidates("“한글 따옴표” 검색").includes("한글 따옴표"));
});

test("B: waits have their own budget (5) and never count as 'stuck'", async () => {
  const r = await runGoal({ webclaw: staticPage(HOME), jev, goal: WAITER, waitMs: 1 });
  assert.equal(r.reason, "wait_budget");
  assert.equal(r.stats.waits, 6);
  assert.equal(r.history.length, 5);
});

test("B: node resolved once, mutating markers wait ≥150 s, run stops on timeout / no_tab", async () => {
  let resolves = 0;
  const ops = [];
  const page = staticPage(NAME_PAGE, (mk, op) => ({ status: "done", output: "ok" }));
  const wc = { resolveNode: async () => { resolves++; return "webclaw@one"; }, dispatch: async (mk, op) => { ops.push([mk, op]); return page.dispatch(mk, op); } };
  await runGoal({ webclaw: wc, jev, goal: NAMEBOX, fallback: async () => ({ kind: "type", target: "@1", value: "bob" }), maxSteps: 2 });
  assert.equal(resolves, 1);
  assert.ok(ops.every(([, op]) => op.node === "webclaw@one"));
  for (const [mk, op] of ops) assert.ok(/^\[TYPE/.test(mk) ? op.timeoutMs >= 150000 : op.timeoutMs === 60000, mk + " " + op.timeoutMs);
  assert.ok(MUTATING_TIMEOUT_MS >= 150000);

  for (const reason of ["timeout", "no_tab"]) {
    const p = staticPage(NAME_PAGE, () => ({ status: reason === "timeout" ? "timeout" : "failed", reason, output: "x" }));
    const r = await runGoal({ webclaw: p, jev, goal: NAMEBOX, fallback: async () => ({ kind: "type", target: "@1", value: "bob" }) });
    assert.equal(r.reason, reason);
    assert.equal(mutating(p.sent).length, 1, "no retry of the same marker after " + reason);
  }
  // explicit node wins, resolveNode not consulted
  const r = await runGoal({ webclaw: { resolveNode: async () => { throw new Error("nope"); }, dispatch: async (mk, op) => { assert.equal(op.node, "webclaw@two"); return { status: "failed", reason: "no_tab", output: "" }; } }, jev, goal: NAMEBOX, node: "webclaw@two" });
  assert.equal(r.reason, "no_tab");
});

test("B: per-goal deadline", async () => {
  const slow = { dispatch: async (mk) => { await new Promise((r) => setTimeout(r, 40)); return { status: "done", output: NAME_PAGE }; } };
  const r = await runGoal({ webclaw: slow, jev, goal: NAMEBOX, deadlineMs: 20, fallback: async () => ({ kind: "type", target: "@1", value: "bob" }) });
  assert.equal(r.reason, "deadline");
});

test("B: recipe wait steps replay as a fixed sleep", () => {
  assert.match(recipeScript("g", [{ kind: "wait" }]), /await sleep\(800\);/);
});

// ── jev.cjs ──────────────────────────────────────────────────────────────────
function tinyJev(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => { req.resume(); req.on("end", () => { calls.push(Date.now()); handler(calls.length, res); }); });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, calls, url: "http://127.0.0.1:" + srv.address().port })));
}
const OK = JSON.stringify({ answers: { done: { type: "noul", noul: 0.1 } } });

test("jev: 429 honours Retry-After, 5xx backs off, bad JSON → jev_bad_response", async () => {
  const a = await tinyJev((n, res) => { if (n === 1) { res.writeHead(429, { "retry-after": "1" }); return res.end("slow down"); } res.writeHead(200); res.end(OK); });
  const t = Date.now();
  const j = await createJev({ apiKey: "k", baseUrl: a.url }).systemOne({}, {});
  assert.equal(j.answers.done.noul, 0.1);
  assert.equal(a.calls.length, 2);
  assert.ok(Date.now() - t >= 900, "waited for Retry-After: 1");
  a.srv.close();

  const b = await tinyJev((n, res) => { res.writeHead(n < 3 ? 503 : 200); res.end(n < 3 ? "busy" : OK); });
  await createJev({ apiKey: "k", baseUrl: b.url, retryBaseMs: 5 }).systemOne({}, {});
  assert.equal(b.calls.length, 3);
  b.srv.close();

  for (const body of ["<html>oops</html>", "{\"model\":\"x\"}", "null"]) {
    const c = await tinyJev((n, res) => { res.writeHead(200); res.end(body); });
    await assert.rejects(createJev({ apiKey: "k", baseUrl: c.url }).systemOne({}, {}), (e) => e.reason === "jev_bad_response", body);
    c.srv.close();
  }
});

test("jev: network errors back off then fail; the goal deadline caps retries", async () => {
  const d = await tinyJev(() => {});
  const dead = d.url; d.srv.close(); // nothing listens there now
  await assert.rejects(createJev({ apiKey: "k", baseUrl: dead, retryBaseMs: 5 }).systemOne({}, {}), (e) => e.reason === "jev_unreachable");
  const hang = await tinyJev(() => {}); // never answers
  const t = Date.now();
  await assert.rejects(createJev({ apiKey: "k", baseUrl: hang.url, retryBaseMs: 5 }).systemOne({}, {}, { deadline: Date.now() + 150 }), (e) => e.reason === "deadline" || e.reason === "jev_timeout");
  assert.ok(Date.now() - t < 1500);
  hang.srv.closeAllConnections(); hang.srv.close();
});

// ── S2 / A3: the brain server ────────────────────────────────────────────────
async function serve(opts) {
  const srv = createBrainServer(Object.assign({ jev, token: "tok" }, opts));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + srv.address().port + "/brain/exec";
  const post = (body, headers) => fetch(url, { method: "POST", headers: Object.assign({ authorization: "Bearer tok", "content-type": "application/json" }, headers || {}), body: typeof body === "string" ? body : JSON.stringify(body) });
  return { srv, url, post };
}

test("S2/A3: brain server — chat/title/no mode never act; auth, origin, content-type, size, depth", async () => {
  const page = staticPage(NAME_PAGE);
  const { srv, post } = await serve({ webclaw: page });
  for (const mode of ["chat", "title", undefined]) {
    const r = await post({ prompt: "User: " + NAMEBOX, mode });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).output, NOT_A_GOAL);
  }
  assert.deepEqual(page.sent, [], "no marker sent for chat/title prompts");
  assert.equal((await post({ mode: "goal", prompt: "x" }, { authorization: "" })).status, 401);
  assert.equal((await post({ mode: "goal", prompt: "x" }, { authorization: "Bearer tok2" })).status, 401);
  assert.equal((await post({ mode: "goal", prompt: "x" }, { authorization: "Bearer töö" })).status, 401, "non-ASCII token does not crash");
  assert.equal((await post({ mode: "goal", prompt: "x" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ mode: "chat", prompt: "x" }, { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" })).status, 200);
  assert.equal((await post({ mode: "goal", prompt: "x" }, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post(JSON.stringify({ mode: "goal", prompt: "x".repeat(300 * 1024) }))).status, 413);
  assert.equal((await post({ mode: "goal", prompt: "x" }, { "x-webclaw-brain-depth": "1" })).status, 508);
  assert.equal((await post("{not json")).status, 400);
  assert.deepEqual(page.sent, []);
  srv.close();
  // no configured token → fail closed
  const open = await serve({ webclaw: page, token: "" });
  assert.equal((await open.post({ mode: "goal", prompt: "x" }, { authorization: "Bearer " })).status, 401);
  open.srv.close();
});

test("S2: one running goal per node → 409 busy; other nodes are independent", async () => {
  const slow = { dispatch: async (mk) => { await new Promise((r) => setTimeout(r, 150)); return { status: "failed", reason: "no_tab", output: "" }; } };
  const { srv, post } = await serve({ webclaw: slow });
  const body = { mode: "goal", prompt: "User: " + NAMEBOX, node: "webclaw@a" };
  const [a, b, c] = await Promise.all([post(body), new Promise((r) => setTimeout(r, 30)).then(() => post(body)), new Promise((r) => setTimeout(r, 30)).then(() => post(Object.assign({}, body, { node: "webclaw@b" })))]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  assert.equal((await b.json()).error, "busy");
  assert.equal(c.status, 200);
  assert.equal((await post(body)).status, 200, "free again after the first goal ended");
  srv.close();
});

test("B: llmFallback marks its call with depth 1 — a System One server refuses it (no recursion)", async () => {
  const page = staticPage(NAME_PAGE);
  const { srv, url } = await serve({ webclaw: page });
  const fb = llmFallback(url.replace(/\/brain\/exec$/, ""), "tok");
  assert.equal(await fb({ goal: "g", page: { title: "t", url: "u" }, elements: [], history: [] }), null);
  assert.deepEqual(page.sent, []);
  srv.close();
});

test("recipe checks every arg before acting (no half-done page on a missing value)", async () => {
  const { recipeScript } = require("../bridge/brain/agent.cjs");
  const { runScript } = require("../runner.js");
  const script = recipeScript("g", [
    { kind: "click", role: "radio", name: "Pro plan", nth: 0 },
    { kind: "select", role: "combobox", name: "Country", nth: 0, value: "KR" },
  ]);
  const sent = [];
  const res = await runScript(script, async (m) => { sent.push(m); return '@1 radio "Pro plan"\n@2 combobox "Country"'; }, { args: {} });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing_arg");
  assert.equal(sent.filter((m) => /^\[CLICK|^\[FILL/.test(m)).length, 0, "no action ran before the arg check");
});

test("torn kind + clear target: the target's role decides (button → click)", async () => {
  const { runGoal } = require("../bridge/brain/agent.cjs");
  let n = 0;
  const jev = { maxOptions: 240, systemOne: async (state, q) => {
    n++;
    if (n === 1) return { answers: {
      done: { noul: 0.02 },
      kind: { choice: "type", confidence: 0.01, probabilities: { click: 0.49, type: 0.5, select: 0, wait: 0, need_human: 0.01 } },
      target: { choice: "@2", confidence: 0.81, probabilities: { "@1": 0.05, "@2": 0.95 } } } };
    return { answers: { done: { noul: 0.97 }, kind: { choice: "wait", confidence: 0.9, probabilities: {} } } };
  } };
  const sent = [];
  const page = { dispatch: async (mk) => { sent.push(mk); return mk.startsWith("[OUTLINE") ? { status: "done", output: 'P | http://p\nrefs: 2\n@1 textbox "Name" value="x"\n@2 button "Send"' } : { status: "done", output: "ok" }; } };
  const r = await runGoal({ webclaw: page, jev, goal: "send it" });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.ok(sent.includes("[CLICK] @2"), "button target → click, not type");
  assert.equal(r.steps[0].kindFromRole, "click");
});
