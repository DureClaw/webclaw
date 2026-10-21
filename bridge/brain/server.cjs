// `webclaw brain` — serves the extension's existing brain contract
// (POST /brain/exec {prompt, mode?, node?, tab?} → {output}) with the System One
// goal loop, so the HUD chat and bus free-text tasks get Jev speed instead of
// an LLM turn. Only `mode: "goal"` drives the browser — Wide Worker chat and
// the auto-titler send mode chat/title and must never be mistaken for goals.
//
// Hardening: bearer token required, a present Origin must be chrome-extension://,
// JSON content-type only, 256 KB body cap, one running goal per node, and
// requests carrying `x-webclaw-brain-depth` ≥ 1 (a brain's own fallback call)
// are refused so `--fallback` can never recurse into this server.
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const { runGoal } = require("./agent.cjs");

const MAX_BODY = 256 * 1024;
const NOT_A_GOAL = '(webclaw System One brain only runs browser goals — mode:"goal")';
const OTHER_ROLE = /^(Assistant|AI|Brain|Bot|System|webclaw)\s*:/i;

// HUD standalone prompt: "...Current tab: <url>\nUser: <text>" (multi-turn: the
// LAST "User:" turn is the goal); bus delegation: free text, possibly prefixed
// by a "Site notes …" block that ends at the first blank line.
function goalFromPrompt(prompt) {
  const p = String(prompt || "");
  const cur = p.match(/^Current tab:\s*(\S+)/m);
  let tab = "";
  if (cur) { try { const u = new URL(cur[1]); tab = u.host + u.pathname; } catch (e) {} }
  const lines = p.split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^User:/.test(lines[i])) { at = i; break; }
  let goal;
  if (at >= 0) {
    const out = [lines[at].replace(/^User:\s*/, "")];
    for (let i = at + 1; i < lines.length && !OTHER_ROLE.test(lines[i]); i++) out.push(lines[i]);
    goal = out.join("\n").trim();
  } else {
    goal = /^Site notes\b/.test(p.trimStart()) ? p.trimStart().replace(/^Site notes[\s\S]*?\n\s*\n/, "") : p;
    if (/^Site notes\b/.test(goal)) goal = ""; // notes with no task after them
    goal = goal.trim();
  }
  return { goal, tab };
}

function summarize(r) {
  const s = r.stats;
  const head = r.ok ? "✅ 완료 — " + s.decisions + "번 판단, " + r.actions.length + "개 동작" : "⚠️ 중단(" + r.reason + ")" + (r.detail ? ": " + r.detail : "");
  return head + " · " + (s.totalMs / 1000).toFixed(1) + "s (Jev " + s.jevMs + "ms, 브라우저 " + s.browserMs + "ms" + (s.fallbacks ? ", 폴백 " + s.fallbacks + "회" : "") + ")" + (r.saved ? " · 레시피 저장: " + r.saved : "");
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function createBrainServer({ webclaw, jev, token, defaults = {}, log = () => {} }) {
  const running = new Set(); // nodes with a goal in flight
  return http.createServer((req, res) => {
    const send = (code, obj) => { if (res.headersSent) return; res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, brain: "system-one", model: jev.model, hasKey: jev.hasKey });
    if (req.method !== "POST" || req.url !== "/brain/exec") return send(404, { error: "not found" });
    if (Number(req.headers["x-webclaw-brain-depth"] || 0) >= 1) return send(508, { error: "brain recursion refused (x-webclaw-brain-depth ≥ 1) — point --fallback at an LLM brain, not at `webclaw brain`" });
    const origin = req.headers.origin;
    if (origin != null && !/^chrome-extension:\/\/[\w-]+\/?$/.test(origin)) return send(403, { error: "origin not allowed" });
    // fail closed: no configured token means nobody is authorized
    if (!token || !sameToken(req.headers.authorization || "", "Bearer " + token)) return send(401, { error: "unauthorized" });
    if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] || "")) return send(415, { error: "content-type must be application/json" });
    if (Number(req.headers["content-length"] || 0) > MAX_BODY) { send(413, { error: "body too large (max 256 KB)" }); return req.resume(); }
    const chunks = [];
    let size = 0, tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; send(413, { error: "body too large (max 256 KB)" }); return; }
      chunks.push(c);
    });
    req.on("end", async () => {
      if (tooBig) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) { return send(400, { error: "invalid JSON" }); }
      if (!body || typeof body !== "object") return send(400, { error: "invalid body" });
      if (body.mode !== "goal") return send(200, { output: NOT_A_GOAL });
      const { goal, tab } = goalFromPrompt(body.prompt);
      if (!goal) return send(400, { error: "empty prompt" });
      const node = (typeof body.node === "string" && body.node) || defaults.node || "";
      const key = node || "*";
      if (running.has(key)) return send(409, { error: "busy", detail: "a goal is already running on " + (node || "this node") });
      running.add(key);
      log("goal: " + goal.slice(0, 100) + (tab ? " @" + tab : "") + (node ? " node=" + node : ""));
      try {
        const opts = Object.assign({}, defaults, { webclaw, jev, goal, tab: (typeof body.tab === "string" && body.tab) || tab || defaults.tab });
        if (node) opts.node = node;
        const r = await runGoal(opts);
        send(200, { output: summarize(r), result: r });
      } catch (e) { send(200, { output: "⚠️ brain error: " + e.message }); }
      finally { running.delete(key); }
    });
  });
}

module.exports = { createBrainServer, goalFromPrompt, summarize, NOT_A_GOAL, MAX_BODY };
