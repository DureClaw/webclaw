// TypeSafe Jev client (System One model) — zero dependencies.
// POST {baseUrl}/v1/systemone  { model, state, questions } → { model, answers, usage }
// Docs: https://docs.typesafe.ai/api/system-one · key: TYPESAFE_API_KEY.
// Jev is a hosted API (no local weights): the page outline you send leaves
// this machine — webclaw's policy deny list still keeps denied sites out,
// since their pages are never read.
"use strict";

function createJev(opts = {}) {
  const apiKey = opts.apiKey || process.env.TYPESAFE_API_KEY || "";
  const baseUrl = (opts.baseUrl || process.env.WEBCLAW_JEV_URL || "https://api.typesafe.ai").replace(/\/$/, "");
  const model = opts.model || process.env.WEBCLAW_JEV_MODEL || "jev-latest";
  const timeoutMs = opts.timeoutMs || 15000;

  async function systemOne(state, questions, extra = {}) {
    if (!apiKey) throw Object.assign(new Error("no TypeSafe API key — set TYPESAFE_API_KEY or jev.apiKey in ~/.webclaw/config.json"), { reason: "no_api_key" });
    const headers = { authorization: "Bearer " + apiKey, "content-type": "application/json" };
    if (extra.longContext) headers["TypeSafe-Danger-Zone-Long-Context"] = "true";
    const body = JSON.stringify({ model, state, questions });
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      let r;
      try { r = await fetch(baseUrl + "/v1/systemone", { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) }); }
      catch (e) {
        if (attempt < 2) continue;
        throw Object.assign(new Error("Jev unreachable: " + e.message), { reason: "jev_unreachable" });
      }
      if (r.status === 429 || r.status >= 500) {
        if (attempt < 3) {
          const ra = Number(r.headers.get("retry-after"));
          await new Promise((res) => setTimeout(res, ra > 0 ? ra * 1000 : 300 * 2 ** attempt));
          continue;
        }
      }
      const text = await r.text();
      if (!r.ok) throw Object.assign(new Error("Jev HTTP " + r.status + ": " + text.slice(0, 300)), { reason: r.status === 401 ? "jev_unauthorized" : "jev_error" });
      const j = JSON.parse(text);
      j.latencyMs = Date.now() - t0;
      return j;
    }
  }

  return { systemOne, model, baseUrl, hasKey: !!apiKey };
}

module.exports = { createJev };
