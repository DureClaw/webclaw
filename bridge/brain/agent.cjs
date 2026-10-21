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
// replays with no model at all (`save`).
"use strict";

const RISKY = /(결제|구매|주문|송금|이체|삭제|탈퇴|해지|환불|\bpay\b|payment|purchase|buy now|checkout|place order|transfer|delete|remove account|unsubscribe)/i;
const STOP = new Set(["the", "a", "an", "to", "and", "or", "of", "in", "on", "with", "for", "as", "then", "it", "is", "be", "page", "into", "at", "my", "me", "please", "click", "type", "enter", "fill", "select", "open", "go"]);

// "[OUTLINE]" text → { title, url, elements:[{ref, role, name, raw}], context:[…] }
function parseOutline(text) {
  const lines = String(text || "").split("\n");
  const [title, url] = (lines[0] || "").split(" | ");
  const elements = [], context = [];
  for (const l of lines.slice(2)) {
    const m = l.match(/^(@\d+) (\S+) "((?:[^"\\]|\\.)*)"(.*)$/);
    if (m) elements.push({ ref: m[1], role: m[2], name: m[3], raw: l.slice(m[1].length + 1) });
    else if (/^#|^\[dialog\]|^== frame/.test(l)) context.push(l);
  }
  return { title: (title || "").trim(), url: (url || "").trim(), elements, context };
}

const words = (s) => String(s || "").toLowerCase().match(/[\p{L}\p{N}@._-]+/gu) || [];

// values a step might need to type/select — Jev chooses among them
function valueCandidates(goal) {
  const out = [];
  const add = (v) => { v = String(v || "").trim().replace(/[.,;]+$/, ""); if (v && v.length <= 120 && !out.includes(v)) out.push(v); };
  for (const m of goal.matchAll(/["“'‘「]([^"”'’」]{1,120})["”'’」]/g)) add(m[1]);
  for (const m of goal.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) add(m[0]);
  for (const m of goal.matchAll(/https?:\/\/\S+/g)) add(m[0]);
  for (const m of goal.matchAll(/\b(?:as|username|user|password|email|query|for|named|called|country|plan|code|to|=|:)\s+["“']?([^\s"”',;]+)/gi)) add(m[1]);
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

function buildRequest(goal, page, history, values, maxOptions) {
  const els = shortlist(page.elements, goal, maxOptions || 240);
  const state = {
    goal,
    page: { title: page.title, url: page.url },
    headings: page.context.slice(0, 30),
    elements: els.map((e) => e.ref + " " + e.raw),
    history: history.slice(-12).map((h, i) => (i + 1) + ". " + h.kind + " " + (h.label || "") + (h.value != null ? " ← " + JSON.stringify(h.value) : "") + " → " + h.result),
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

// [RUN] script that replays the successful path without any model
function recipeScript(goal, actions) {
  const lines = [
    "// webclaw System One brain — recorded path for: " + goal.replace(/\n/g, " ").slice(0, 160),
    "const ref = async (role, name) => {",
    "  const o = await outline();",
    "  const l = o.split('\\n').find((x) => x.includes(role + ' ' + JSON.stringify(name)));",
    "  if (!l) throw Object.assign(new Error('not found: ' + role + ' ' + name), { reason: 'no_match' });",
    "  return l.split(' ')[0];",
    "};",
  ];
  for (const a of actions) {
    const r = "await ref(" + JSON.stringify(a.role) + ", " + JSON.stringify(a.name) + ")";
    if (a.kind === "click") lines.push("await click(" + r + ");");
    else if (a.kind === "type") lines.push("await type(" + r + ", " + JSON.stringify(a.value) + ");");
    else if (a.kind === "select") lines.push("await fill(" + r + ", " + JSON.stringify(a.value) + ");");
    else if (a.kind === "wait") lines.push("await sleep(800);");
  }
  lines.push("return 'replayed " + actions.length + " step(s)';");
  return lines.join("\n");
}

const top = (ans) => ans ? Object.entries(ans.probabilities || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, p]) => k + ":" + p.toFixed(2)).join(" ") : "";

async function runGoal(o) {
  const { webclaw, jev, goal } = o;
  const tab = o.tab ? "@" + o.tab : "";
  const maxSteps = o.maxSteps || 15;
  const minConf = o.minConfidence != null ? o.minConfidence : 0.5;
  const riskyConf = o.riskyConfidence != null ? o.riskyConfidence : 0.85;
  const doneAt = o.doneThreshold != null ? o.doneThreshold : 0.8;
  const log = o.onStep || (() => {});
  const values = valueCandidates(goal);
  const history = [], actions = [], steps = [];
  const t0 = Date.now();
  let jevMs = 0, browserMs = 0, fallbacks = 0, lastSig = "", repeats = 0;

  const m = async (marker) => {
    const s = Date.now();
    const r = await webclaw.dispatch(marker, { timeoutMs: 60000 });
    browserMs += Date.now() - s;
    return r;
  };
  const finish = (ok, reason, extra) => ({ ok, reason, goal, steps, actions, history, values, stats: { totalMs: Date.now() - t0, jevMs, browserMs, decisions: steps.length, fallbacks }, ...(extra || {}) });

  for (let i = 0; i < maxSteps; i++) {
    const ol = await m("[OUTLINE" + tab + "]");
    if (ol.status !== "done") return finish(false, ol.reason || "outline_failed", { detail: ol.output });
    const page = parseOutline(ol.output);
    const { state, questions, shown } = buildRequest(goal, page, history, values, o.maxOptions || jev.maxOptions);
    let res;
    try { res = await jev.systemOne(state, questions); }
    catch (e) { return finish(false, e.reason || "jev_error", { detail: e.message }); }
    jevMs += res.latencyMs || 0;
    const A = res.answers || {};
    const step = { i: i + 1, url: page.url, jevMs: res.latencyMs, done: A.done && A.done.noul, kind: top(A.kind), target: top(A.target), value: top(A.value) };
    steps.push(step);
    log(step);

    if (A.done && A.done.noul >= doneAt) {
      const out = finish(true, "done");
      if (o.save && actions.length) {
        const [domain, name] = o.save.split("/");
        const lr = await m("[LEARN] " + domain + "\n" + JSON.stringify({ recipes: { [name]: recipeScript(goal, actions) } }));
        out.saved = lr.status === "done" ? o.save : null;
      }
      return out;
    }

    const conf = (a) => (a ? (a.x_jev_confidence != null ? a.x_jev_confidence : a.confidence) : 0);
    let kind = A.kind && A.kind.choice, kConf = conf(A.kind);
    // a single option is no decision — its confidence is meaningless, treat as certain
    let target = A.target && A.target.choice, tConf = A.target ? (shown.length === 1 ? 1 : conf(A.target)) : 0;
    let value = A.value ? values[Number(String(A.value.choice).slice(1))] : undefined, vConf = A.value ? (Object.keys(questions.value.criteria).length === 1 ? 1 : conf(A.value)) : 0;
    const el = shown.find((e) => e.ref === target);
    const needsTarget = kind === "click" || kind === "type" || kind === "select";
    const needsValue = kind === "type" || kind === "select";
    let low = kConf < minConf || (needsTarget && (!el || tConf < minConf)) || (needsValue && (value == null || vConf < minConf));
    const risky = el && RISKY.test(el.name) && tConf < riskyConf;

    if ((low || risky) && o.fallback) {
      // confidence-gated escalation: ask the slower brain for this one step
      const fb = await o.fallback({ goal, page: state.page, elements: state.elements, history: state.history, values });
      fallbacks++;
      step.fallback = fb;
      if (fb && fb.kind === "done") return finish(true, "done_by_fallback");
      if (fb && fb.kind) {
        kind = fb.kind; target = fb.target; value = fb.value;
        low = false;
      }
    }
    if (risky && !step.fallback) return finish(false, "needs_confirmation", { detail: "risky target '" + (el && el.name) + "' at confidence " + tConf.toFixed(2) + " < " + riskyConf });
    if (low) return finish(false, "low_confidence", { detail: "kind " + top(A.kind) + " | target " + top(A.target) + " | value " + top(A.value) });
    if (kind === "need_human") return finish(false, "need_human");

    const tEl = shown.find((e) => e.ref === target) || el;
    const sig = kind + "|" + (tEl && tEl.name) + "|" + value;
    repeats = sig === lastSig ? repeats + 1 : 0;
    lastSig = sig;
    if (repeats >= 2) return finish(false, "stuck", { detail: "same action 3× without reaching the goal: " + sig });

    let r = { status: "done", output: "" };
    if (kind === "wait") await new Promise((res) => setTimeout(res, 800));
    else if (kind === "click") r = await m("[CLICK" + tab + "] " + target);
    else if (kind === "type") r = await m("[TYPE" + tab + "] " + target + "\n" + value);
    else if (kind === "select") r = await m("[FILL" + tab + "] " + target + "\n" + value);
    const label = tEl ? tEl.role + ' "' + tEl.name + '"' : "";
    history.push({ kind, label, value: needsValue ? value : undefined, result: r.status === "done" ? "ok" : "failed:" + (r.reason || r.status) });
    if (r.status === "done" && tEl) actions.push({ kind, role: tEl.role, name: tEl.name, value: needsValue ? value : undefined });
    if (r.status === "done" && kind === "wait") actions.push({ kind });
    if (r.reason === "policy_denied" || r.reason === "approval_denied" || r.reason === "approval_timeout" || r.reason === "handed_off") return finish(false, r.reason);
  }
  return finish(false, "max_steps");
}

// Escalation to an LLM brain speaking the existing /brain/exec contract.
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
    const h = { "content-type": "application/json" };
    if (brainToken) h.authorization = "Bearer " + brainToken;
    try {
      const r = await fetch(brainUrl.replace(/\/$/, "") + "/brain/exec", { method: "POST", headers: h, body: JSON.stringify({ prompt }), signal: AbortSignal.timeout(120000) });
      const j = await r.json();
      const m = String(j.output || "").match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    } catch (e) { return null; }
  };
}

module.exports = { runGoal, parseOutline, valueCandidates, buildRequest, recipeScript, llmFallback, shortlist };
