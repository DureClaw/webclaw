// Test double for TypeSafe's /v1/systemone — an *oracle*, not a model: for a
// known goal it answers the scripted next step (so the tests exercise webclaw's
// System One loop — state building, option mapping, gating, execution — not
// any intelligence). Unknown goals get a flat distribution (low confidence).
"use strict";
const http = require("node:http");

function pick(criteria, pred) {
  const keys = Object.keys(criteria || {});
  const hit = keys.find((k) => pred(k, criteria[k]));
  return { keys, hit };
}
function choiceAnswer(keys, hit, p = 0.9) {
  const probs = {};
  if (!hit) { keys.forEach((k) => (probs[k] = 1 / keys.length)); return { type: "choice", choice: keys[0], probabilities: probs, confidence: 0 }; }
  const rest = keys.length > 1 ? (1 - p) / (keys.length - 1) : 0;
  keys.forEach((k) => (probs[k] = k === hit ? p : rest));
  return { type: "choice", choice: hit, probabilities: probs, confidence: keys.length === 1 ? 1 : (p - 1 / keys.length) / (1 - 1 / keys.length) };
}

function createMockJev({ scripts, latencyMs = 0, apiKey = "test-key" }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      if (req.headers.authorization !== "Bearer " + apiKey) { res.writeHead(401); return res.end('{"detail":"bad key"}'); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push(body);
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      const script = scripts[body.state.goal];
      const done = body.state.history.filter((h) => / → ok$/.test(h)).length;
      const step = script && script[done];
      const answers = {};
      const q = body.questions;
      answers.done = { type: "noul", noul: script && done >= script.length ? 0.97 : 0.03 };
      { const { keys, hit } = pick(q.kind.criteria, (k) => step && k === step.kind); answers.kind = choiceAnswer(keys, hit); }
      if (q.target) { const { keys, hit } = pick(q.target.criteria, (k, d) => step && step.target && d.includes(step.target)); answers.target = choiceAnswer(keys, hit, step && step.p ? step.p : 0.9); }
      if (q.value) { const { keys, hit } = pick(q.value.criteria, (k, d) => step && d === step.value); answers.value = choiceAnswer(keys, hit); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "jev-mock", answers, usage: { input_tokens: JSON.stringify(body).length / 4 | 0, output_tokens: 8 } }));
    });
  });
  return { server, calls, listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))), close: () => new Promise((r) => server.close(r)) };
}

module.exports = { createMockJev };
