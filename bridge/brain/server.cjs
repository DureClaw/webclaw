// `webclaw brain` — serves the extension's existing brain contract
// (POST /brain/exec {prompt} → {output}) with the System One goal loop, so the
// HUD chat and bus free-text tasks get Jev speed instead of an LLM turn.
"use strict";
const http = require("node:http");
const { runGoal } = require("./agent.cjs");

// HUD standalone prompt: "...Current tab: <url>\nUser: <text>"; bus delegation:
// free text, possibly prefixed by "Site notes …\n\n".
function goalFromPrompt(prompt) {
  const p = String(prompt || "");
  const user = p.match(/^User:\s*([\s\S]+)$/m);
  const cur = p.match(/^Current tab:\s*(\S+)/m);
  let tab = "";
  if (cur) { try { const u = new URL(cur[1]); tab = u.host + u.pathname; } catch (e) {} }
  const goal = user ? user[1].trim() : p.split(/\n\s*\n/).pop().trim();
  return { goal, tab };
}

function summarize(r) {
  const s = r.stats;
  const head = r.ok ? "✅ 완료 — " + s.decisions + "번 판단, " + r.actions.length + "개 동작" : "⚠️ 중단(" + r.reason + ")" + (r.detail ? ": " + r.detail : "");
  return head + " · " + (s.totalMs / 1000).toFixed(1) + "s (Jev " + s.jevMs + "ms, 브라우저 " + s.browserMs + "ms" + (s.fallbacks ? ", 폴백 " + s.fallbacks + "회" : "") + ")" + (r.saved ? " · 레시피 저장: " + r.saved : "");
}

function createBrainServer({ webclaw, jev, token, defaults = {}, log = () => {} }) {
  return http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, brain: "system-one", model: jev.model, hasKey: jev.hasKey });
    if (req.method !== "POST" || req.url !== "/brain/exec") return send(404, { error: "not found" });
    if (token && (req.headers.authorization || "") !== "Bearer " + token) return send(401, { error: "unauthorized" });
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) {}
      const { goal, tab } = goalFromPrompt(body.prompt);
      if (!goal) return send(400, { error: "empty prompt" });
      log("goal: " + goal.slice(0, 100) + (tab ? " @" + tab : ""));
      try {
        const r = await runGoal(Object.assign({ webclaw, jev, goal, tab: body.tab || tab }, defaults));
        send(200, { output: summarize(r), result: r });
      } catch (e) { send(200, { output: "⚠️ brain error: " + e.message }); }
    });
  });
}

module.exports = { createBrainServer, goalFromPrompt, summarize };
