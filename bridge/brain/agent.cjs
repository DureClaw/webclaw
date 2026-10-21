// webclaw System One brain — a goal loop where every step is ONE structured
// decision (Jev, TypeSafe's System One model) instead of an LLM turn.
//
//   outline page → state {goal, page, elements, history}
//   → one Jev request, questions evaluated in parallel:
//        done   (noul)   is the goal already accomplished?
//        kind   (choice) click | type | select | wait | need_human
//        target (choice) one of the page's @refs (≤ 250)
//        value  (choice) one of the values mentioned in the goal
//   → confidence gate (low → fallback brain or the human; risky → higher bar)
//   → one marker ([CLICK]/[TYPE]/[FILL]) → repeat
//
// Jev cannot generate text, so typed values must appear in the goal; it picks
// *which* one. On success the action path is turned into a [RUN] recipe that
// replays with no model at all (`save`). Recipes never contain typed values:
// they read them from `args` ([RECIPE] passes args), and password fields are
// never recorded anywhere.
"use strict";

const RISKY = /(결제|구매|주문|송금|이체|삭제|탈퇴|해지|환불|\bpay\b|payment|purchase|buy now|checkout|place order|transfer|delete|remove account|unsubscribe)/i;
const STOP = new Set(["the", "a", "an", "to", "and", "or", "of", "in", "on", "with", "for", "as", "then", "it", "is", "be", "page", "into", "at", "my", "me", "please", "click", "type", "enter", "fill", "select", "open", "go"]);
const KINDS = new Set(["click", "type", "select", "wait", "need_human", "done"]);
// markers that act on the page may wait for a human approval (120 s) — give
// them longer than that so a pending approval is never re-requested
const MUTATING_TIMEOUT_MS = 150000;
const READ_TIMEOUT_MS = 60000;
// results that end the run: the human (or policy) said no, or the browser is gone
const STOP_REASONS = new Set(["policy_denied", "approval_denied", "approval_timeout", "handed_off", "timeout", "no_tab"]);

// One outline element line: `@N <role> <JSON string name><suffixes>`.
// Self-contained on purpose — its source is embedded into recipes so replay
// parses lines exactly like the recorder did. Tolerates the older `"…"` form.
function outlineLine(l) {
  const m = /^(@\d+) (\S+) ("(?:[^"\\]|\\.)*")(.*)$/.exec(String(l));
  if (!m) return null;
  let name;
  try { name = JSON.parse(m[3]); if (typeof name !== "string") throw new Error("not a string"); }
  catch (e) { name = m[3].slice(1, -1); }
  return { ref: m[1], role: m[2], name, suffix: m[4] };
}

// "[OUTLINE]" text → { title, url, elements:[{ref, role, name, raw, secret}], context:[…] }
function parseOutline(text) {
  const lines = String(text || "").split("\n");
  const [title, url] = (lines[0] || "").split(" | ");
  const elements = [], context = [];
  for (const l of lines.slice(2)) {
    const p = outlineLine(l);
    if (p) elements.push({ ref: p.ref, role: p.role, name: p.name, raw: l.slice(p.ref.length + 1), secret: /(^|\s)type=password(\s|$)/.test(p.suffix) });
    else if (/^#|^\[dialog\]|^== frame/.test(l)) context.push(l);
  }
  return { title: (title || "").trim(), url: (url || "").trim(), elements, context };
}

// index of `el` among the page's elements with the same role + exact name
function occurrence(elements, el) {
  let n = 0;
  for (const e of elements) {
    if (e === el || e.ref === el.ref) return n;
    if (e.role === el.role && e.name === el.name) n++;
  }
  return 0;
}

const words = (s) => String(s || "").toLowerCase().match(/[\p{L}\p{N}@._-]+/gu) || [];

// trailing Korean particles glued to a value ("alice로", "홍길동으로")
const KO_PARTICLE = /(으로|에서|이라고|라고|로|을|를|은|는|이|가|에|와|과|으로요)$/u;
function cleanToken(t) {
  t = String(t || "");
  const latin = /^([^\p{Script=Hangul}]+)\p{Script=Hangul}+$/u.exec(t);
  if (latin) return latin[1];
  if (/\p{Script=Hangul}/u.test(t) && t.length > 2) return t.replace(KO_PARTICLE, "");
  return t;
}

// values a step might need to type/select — Jev chooses among them
function valueCandidates(goal) {
  goal = String(goal || "");
  const out = [];
  const add = (v) => { v = String(v || "").trim().replace(/[.,;]+$/, ""); if (v && v.length <= 120 && !out.includes(v)) out.push(v); };
  for (const m of goal.matchAll(/["“'‘「『]([^"”'’」』]{1,120})["”'’」』]/g)) add(m[1]);
  for (const m of goal.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) add(m[0]);
  for (const m of goal.matchAll(/https?:\/\/\S+/g)) add(m[0]);
  for (const m of goal.matchAll(/\b(?:as|username|user|password|email|query|for|named|called|country|plan|code|to|=|:)\s+["“']?([^\s"”',;]+)/gi)) add(m[1]);
  // Korean: "아이디 alice", "비밀번호는 s3cret", "검색어: 노트북"
  for (const m of goal.matchAll(/(아이디|비밀번호|패스워드|이메일|검색어|이름|코드|주소|전화(?:번호)?)\s*(?:은|는|이|가|을|를|으로|로|:|=)?\s*["“'‘「『]?([^\s"”'’」』,;]+)/gu)) add(cleanToken(m[2]));
  // Latin/number tokens glued to Hangul ("alice로", "15인치")
  for (const m of goal.matchAll(/[A-Za-z0-9][\w.@+-]*(?=\p{Script=Hangul})|(?<=\p{Script=Hangul})[A-Za-z0-9][\w.@+-]*/gu)) add(m[0]);
  for (const m of goal.matchAll(/\b[A-Z]{2,}\b|\b\d[\d,.\-]*\b/g)) add(m[0]);
  return out.slice(0, 60);
}

// keep the most goal-relevant elements when a page has more than Jev's 255 options
function shortlist(elements, goal, max = 240) {
  if (elements.length <= max) return elements;
  const g = new Set(words(goal).filter((w) => !STOP.has(w)));
  const scored = elements.map((e, i) => ({ e, i, s: words(e.raw).filter((w) => g.has(w)).length + (/textbox|button|combobox/.test(e.role) ? 0.1 : 0) }));
  return scored.sort((a, b) => b.s - a.s || a.i - b.i).slice(0, max).sort((a, b) => a.i - b.i).map((x) => x.e);
}

const histLine = (h, i) => (i + 1) + ". " + h.kind + " " + (h.label || "") + (h.value != null ? " ← " + JSON.stringify(h.value) : "") + " → " + h.result;

function buildRequest(goal, page, history, values, maxOptions) {
  const els = shortlist(page.elements, goal, maxOptions || 240);
  const state = {
    goal,
    page: { title: page.title, url: page.url },
    headings: page.context.slice(0, 30),
    elements: els.map((e) => e.ref + " " + e.raw),
    history: history.slice(-12).map(histLine),
  };
  const questions = {
    done: { type: "noul", instructions: "The goal in `goal` is already fully accomplished: `page`, `headings` and `elements` show its end result, so no further action is needed." },
    kind: {
      type: "choice",
      instructions: "The kind of the next action that makes progress toward `goal` on this page, given what `history` already did.",
      criteria: {
        click: "Click a button, link, tab, checkbox, radio button or menu item",
        type: "Type text into a text field (textbox or searchbox) that is empty or holds the wrong value",
        select: "Choose an option in a dropdown (combobox)",
        wait: "Nothing to act on yet: the page is still loading or the expected content has not appeared",
        need_human: "Only the human can continue: credentials or data missing from `goal`, a CAPTCHA, a payment confirmation, or the goal is impossible here",
      },
    },
  };
  if (els.length) {
    questions.target = { type: "choice", instructions: "The element from `elements` to act on next to make progress toward `goal`.", criteria: {} };
    for (const e of els) questions.target.criteria[e.ref] = e.raw.slice(0, 200);
  }
  if (values.length) {
    questions.value = { type: "choice", instructions: "If the next action types or selects, the value from `goal` that belongs in the target element.", criteria: {} };
    values.slice(0, maxOptions || 60).forEach((v, i) => { questions.value.criteria["v" + i] = v; });
  }
  return { state, questions, shown: els };
}

// Grounding check for a "done" claimed before anything was done: two opposite
// questions, so a model biased toward "yes" cannot pass both.
function groundingQuestions() {
  return {
    shows_result: { type: "noul", instructions: "The page in `page`, `headings` and `elements` visibly shows the END RESULT that `goal` asks for (a confirmation, the requested content, or the requested final state) — not merely a page where the goal could be started." },
    needs_action: { type: "noul", instructions: "Something still has to be clicked, typed or selected on this page to accomplish `goal`." },
  };
}

// [RUN] script that replays the successful path without any model. Typed /
// selected values become `args.vN` (password fields `args.password`); the
// header lists which arg feeds which field. Elements are found by role + exact
// name + occurrence index, parsing outline lines exactly like the recorder.
// the goal text names the values (often the password itself) — the recipe
// header keeps only its shape
function redact(goal, values) {
  let g = String(goal || "");
  const vs = (values || valueCandidates(g)).filter((v) => v && v.length > 1).sort((a, b) => b.length - a.length);
  for (const v of vs) g = g.split(v).join("…");
  return g;
}

function recipeScript(goal, actions, values) {
  const argOf = [];
  let nv = 0, np = 0;
  for (const a of actions) {
    if (a.kind !== "type" && a.kind !== "select") continue;
    a.arg = a.secret ? "password" + (np++ ? np : "") : "v" + ++nv;
    argOf.push("//   args." + a.arg + " → " + a.role + " " + JSON.stringify(a.name) + (a.secret ? " (password field — never recorded)" : ""));
  }
  const lines = [
    "// webclaw System One brain — recorded path for: " + redact(goal, values).replace(/\n/g, " ").slice(0, 160),
    argOf.length ? "// args (pass with [RECIPE] … args; values are not stored in this recipe):" : "// args: none",
    ...argOf,
    "const outlineLine = " + outlineLine.toString() + ";",
    "const ref = async (role, name, nth) => {",
    "  const hits = String(await outline()).split('\\n').map(outlineLine).filter((x) => x && x.role === role && x.name === name);",
    "  const h = hits[nth || 0];",
    "  if (!h) throw Object.assign(new Error('not found: ' + role + ' ' + JSON.stringify(name) + ' #' + (nth || 0)), { reason: 'no_match' });",
    "  return h.ref;",
    "};",
    "const arg = (k) => {",
    "  const v = args && args[k];",
    "  if (v == null) throw Object.assign(new Error('missing args.' + k), { reason: 'missing_arg' });",
    "  return String(v);",
    "};",
  ];
  for (const a of actions) {
    const r = "await ref(" + JSON.stringify(a.role) + ", " + JSON.stringify(a.name) + ", " + (a.nth || 0) + ")";
    if (a.kind === "click") lines.push("await click(" + r + ");");
    else if (a.kind === "type") lines.push("await type(" + r + ", arg(" + JSON.stringify(a.arg) + "));");
    else if (a.kind === "select") lines.push("await fill(" + r + ", arg(" + JSON.stringify(a.arg) + "));");
    else if (a.kind === "wait") lines.push("await sleep(800);");
  }
  lines.push("return 'replayed " + actions.length + " step(s)';");
  for (const a of actions) delete a.arg;
  return lines.join("\n");
}

const top = (ans) => ans ? Object.entries(ans.probabilities || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, p]) => k + ":" + p.toFixed(2)).join(" ") : "";
const conf = (a) => (a ? (a.x_jev_confidence != null ? a.x_jev_confidence : a.confidence) : 0);

// Validate a fallback brain's free-form decision against the shown elements.
// → { kind, el, value } | { error }
function checkFallback(fb, shown) {
  if (!fb || typeof fb !== "object") return { error: "no decision" };
  const kind = fb.kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) return { error: "unknown kind " + JSON.stringify(kind) };
  const needsTarget = kind === "click" || kind === "type" || kind === "select";
  const needsValue = kind === "type" || kind === "select";
  let el;
  if (needsTarget) {
    el = shown.find((e) => e.ref === fb.target);
    if (!el) return { error: "target " + JSON.stringify(fb.target) + " is not one of the shown elements" };
  }
  if (needsValue && (typeof fb.value !== "string" || !fb.value)) return { error: "missing value for " + kind };
  return { kind, el, value: needsValue ? fb.value : undefined };
}

async function runGoal(o) {
  const { webclaw, jev, goal } = o;
  const tab = o.tab ? "@" + o.tab : "";
  const maxSteps = Number(o.maxSteps) || 15;
  const minConf = o.minConfidence != null && o.minConfidence !== "" ? Number(o.minConfidence) : 0.5;
  const riskyConf = o.riskyConfidence != null ? o.riskyConfidence : 0.85;
  const doneAt = o.doneThreshold != null ? o.doneThreshold : 0.8;
  const doneFirstAt = o.doneFirstThreshold != null ? o.doneFirstThreshold : 0.95; // "done" with no action yet
  const maxWaits = o.maxWaits != null ? o.maxWaits : 5;
  const waitMs = o.waitMs != null ? o.waitMs : 800;
  const deadlineMs = o.deadlineMs || 120000;
  const log = o.onStep || (() => {});
  const values = valueCandidates(goal);
  const history = [], actions = [], steps = [];
  const t0 = Date.now();
  const deadline = t0 + deadlineMs;
  let jevMs = 0, browserMs = 0, fallbacks = 0, lastSig = "", repeats = 0, waits = 0;
  const acted = () => actions.some((a) => a.kind !== "wait"); // waiting is not progress
  const finish = (ok, reason, extra) => ({ ok, reason, goal, steps, actions, history, values, stats: { totalMs: Date.now() - t0, jevMs, browserMs, decisions: steps.length, fallbacks, waits }, ...(extra || {}) });

  // resolve the node once per run (the client would otherwise ask the bus every marker)
  let node = o.node;
  if (!node && typeof webclaw.resolveNode === "function") {
    try { node = await webclaw.resolveNode(); }
    catch (e) { return finish(false, e.reason || "no_node", { detail: e.message }); }
  }
  const m = async (marker, timeoutMs) => {
    const s = Date.now();
    const op = { timeoutMs: timeoutMs || READ_TIMEOUT_MS };
    if (node) op.node = node;
    const r = await webclaw.dispatch(marker, op);
    browserMs += Date.now() - s;
    return r;
  };
  const ask = async (state, questions) => {
    const res = await jev.systemOne(state, questions, { deadline });
    jevMs += res.latencyMs || 0;
    return res;
  };
  const succeed = async (reason) => {
    const out = finish(true, reason);
    if (o.save && actions.length) {
      const [domain, name] = String(o.save).split("/");
      const lr = await m("[LEARN] " + domain + "\n" + JSON.stringify({ recipes: { [name]: recipeScript(goal, actions, values) } }), MUTATING_TIMEOUT_MS);
      out.saved = lr.status === "done" ? o.save : null;
    }
    return out;
  };

  for (let i = 0; i < maxSteps; i++) {
    if (Date.now() > deadline) return finish(false, "deadline", { detail: "goal not reached within " + Math.round(deadlineMs / 1000) + "s" });
    const ol = await m("[OUTLINE" + tab + "]");
    if (ol.status !== "done") return finish(false, ol.reason || "outline_failed", { detail: ol.output });
    const page = parseOutline(ol.output);
    const { state, questions, shown } = buildRequest(goal, page, history, values, o.maxOptions || jev.maxOptions);
    let res;
    try { res = await ask(state, questions); }
    catch (e) { return finish(false, e.reason || "jev_error", { detail: e.message }); }
    const A = res.answers || {};
    const step = { i: i + 1, url: page.url, jevMs: res.latencyMs, done: A.done && A.done.noul, kind: top(A.kind), target: top(A.target), value: top(A.value) };
    steps.push(step);
    log(step);

    // "done" — trusted after real progress; before any action it needs a
    // stricter score AND a page-grounded check, else it is ignored
    let doneUnverified = false;
    if (A.done && A.done.noul >= doneAt) {
      if (acted()) return succeed("done");
      let grounded = false;
      if (A.done.noul >= doneFirstAt) {
        try {
          const g = (await ask(state, groundingQuestions())).answers || {};
          step.grounding = { shows_result: g.shows_result && g.shows_result.noul, needs_action: g.needs_action && g.needs_action.noul };
          grounded = !!(g.shows_result && g.needs_action && g.shows_result.noul >= doneAt && g.needs_action.noul < 0.5);
        } catch (e) { return finish(false, e.reason || "jev_error", { detail: e.message }); }
      }
      if (grounded) return succeed("done");
      doneUnverified = true;
      step.doneUnverified = true;
    }

    // Jev's decision
    let kind = A.kind && A.kind.choice;
    const kConf = conf(A.kind);
    // a single option is no decision — its confidence is meaningless, treat as certain
    const tConf = A.target ? (shown.length === 1 ? 1 : conf(A.target)) : 0;
    let value = A.value ? values[Number(String(A.value.choice).slice(1))] : undefined;
    const vConf = A.value ? (Object.keys(questions.value.criteria).length === 1 ? 1 : conf(A.value)) : 0;
    let el = shown.find((e) => e.ref === (A.target && A.target.choice));
    let needsTarget = kind === "click" || kind === "type" || kind === "select";
    let needsValue = kind === "type" || kind === "select";
    let low = !KINDS.has(kind) || kind === "done" || kConf < minConf || (needsTarget && (!el || tConf < minConf)) || (needsValue && (value == null || vConf < minConf));
    let risky = needsTarget && el && RISKY.test(el.name) && tConf < riskyConf;
    let source = "jev";

    if ((low || risky) && o.fallback) {
      // confidence-gated escalation: ask the slower brain for this one step
      const fb = await o.fallback({ goal, page: state.page, elements: state.elements, history: state.history, values });
      fallbacks++;
      step.fallback = fb;
      if (fb && fb.kind === "done") {
        if (acted()) return succeed("done_by_fallback");
        return finish(false, "done_without_action", { detail: "the fallback brain said done before any action was taken" });
      }
      const d = checkFallback(fb, shown);
      if (d.error) return finish(false, "low_confidence", { detail: "fallback decision rejected: " + d.error });
      // everything below is recomputed from the FINAL decision
      kind = d.kind; el = d.el; value = d.value; source = "fallback";
      needsTarget = kind === "click" || kind === "type" || kind === "select";
      needsValue = kind === "type" || kind === "select";
      low = false;
      // the fallback has no calibrated confidence: a risky target always needs the human
      risky = !!(needsTarget && el && RISKY.test(el.name));
      if (risky) return finish(false, "needs_confirmation", { detail: "risky target '" + el.name + "' chosen by the fallback brain" });
    }
    if (risky) return finish(false, "needs_confirmation", { detail: "risky target '" + el.name + "' at confidence " + tConf.toFixed(2) + " < " + riskyConf });
    if (low) {
      if (doneUnverified) return finish(false, "done_without_action", { detail: "'done' (" + A.done.noul.toFixed(2) + ") before any action, not confirmed by the page, and no confident next action" });
      return finish(false, "low_confidence", { detail: "kind " + top(A.kind) + " | target " + top(A.target) + " | value " + top(A.value) });
    }
    if (kind === "need_human") return finish(false, "need_human");
    step.source = source;

    if (kind === "wait") {
      // waits have their own budget and do not count toward "stuck"
      if (++waits > maxWaits) return finish(false, "wait_budget", { detail: "waited " + maxWaits + "× and the page never changed enough to act" });
      await new Promise((r) => setTimeout(r, waitMs));
      history.push({ kind, label: "", result: "ok" });
      actions.push({ kind });
      continue;
    }

    const secret = !!(el && el.secret);
    const sig = kind + "|" + el.role + "|" + el.name + "|" + (secret ? "•" : value);
    repeats = sig === lastSig ? repeats + 1 : 0;
    lastSig = sig;
    if (repeats >= 2) return finish(false, "stuck", { detail: "same action 3× without reaching the goal: " + kind + " " + el.role + " " + JSON.stringify(el.name) });

    let r;
    if (kind === "click") r = await m("[CLICK" + tab + "] " + el.ref, MUTATING_TIMEOUT_MS);
    else if (kind === "type") r = await m("[TYPE" + tab + "] " + el.ref + "\n" + value, MUTATING_TIMEOUT_MS);
    else r = await m("[FILL" + tab + "] " + el.ref + "\n" + value, MUTATING_TIMEOUT_MS);
    const ok = r.status === "done";
    const shownValue = needsValue ? (secret ? "(secret)" : value) : undefined;
    history.push({ kind, label: el.role + " " + JSON.stringify(el.name), value: shownValue, result: ok ? "ok" : "failed:" + (r.reason || r.status) });
    if (ok) {
      const a = { kind, role: el.role, name: el.name, nth: occurrence(page.elements, el) };
      if (needsValue) { if (secret) a.secret = true; else a.value = value; }
      actions.push(a);
    }
    const why = r.reason || (r.status === "timeout" ? "timeout" : "");
    if (STOP_REASONS.has(why)) return finish(false, why, { detail: r.output });
  }
  return finish(false, "max_steps");
}

// Escalation to an LLM brain speaking the existing /brain/exec contract. Sends
// `x-webclaw-brain-depth: 1` so a System One server never serves (or recurses
// into) its own fallback call.
function llmFallback(brainUrl, brainToken) {
  return async (s) => {
    const prompt = [
      "You control a web browser. Pick the single next action toward the goal.",
      "Goal: " + s.goal,
      "Page: " + s.page.title + " | " + s.page.url,
      "Elements:", ...s.elements.slice(0, 200),
      "History:", ...(s.history.length ? s.history : ["(none)"]),
      'Reply with ONLY JSON: {"kind":"click|type|select|wait|need_human|done","target":"@N","value":"text to type or option"}',
    ].join("\n");
    const h = { "content-type": "application/json", "x-webclaw-brain-depth": "1" };
    if (brainToken) h.authorization = "Bearer " + brainToken;
    try {
      const r = await fetch(brainUrl.replace(/\/$/, "") + "/brain/exec", { method: "POST", headers: h, body: JSON.stringify({ prompt, mode: "chat" }), signal: AbortSignal.timeout(120000) });
      if (!r.ok) return null;
      const j = await r.json();
      const m = String(j.output || "").match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    } catch (e) { return null; }
  };
}

module.exports = { runGoal, parseOutline, outlineLine, valueCandidates, buildRequest, recipeScript, llmFallback, shortlist, checkFallback, MUTATING_TIMEOUT_MS };
