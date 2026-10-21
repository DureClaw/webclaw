// TypeSafe Jev client (System One model) — zero dependencies.
// POST {baseUrl}/v1/systemone  { model, state, questions } → { model, answers, usage }
// Docs: https://docs.typesafe.ai/api/system-one · key: TYPESAFE_API_KEY.
// Jev is a hosted API (no local weights): the page outline you send leaves
// this machine — webclaw's policy deny list still keeps denied sites out,
// since their pages are never read.
"use strict";

// Providers speaking the same /v1/systemone contract:
//   jev  — TypeSafe's hosted model (API key, cloud)
//   laya — Laya, the Apache-2.0 open alternative, served locally by `laya-serve`
//          (`webclaw laya up`): no key, nothing leaves the machine; fewer
//          options per choice work best (≤ ~20), so the agent shortlists to 16.
const PROVIDERS = {
  jev: { baseUrl: "https://api.typesafe.ai", model: "jev-latest", keyEnv: "TYPESAFE_API_KEY", maxOptions: 240 },
  laya: { baseUrl: "http://127.0.0.1:8077", model: "multilingual", keyEnv: "LAYA_API_KEY", maxOptions: 16, extraBody: { max_len: 4096 }, local: true },
};

function createJev(opts = {}) {
  const provider = opts.provider || process.env.WEBCLAW_BRAIN || "jev";
  const P = PROVIDERS[provider] || PROVIDERS.jev;
  const apiKey = opts.apiKey || process.env[P.keyEnv] || (P.local ? "laya-local" : "");
  const baseUrl = (opts.baseUrl || process.env.WEBCLAW_JEV_URL || P.baseUrl).replace(/\/$/, "");
  const model = opts.model || process.env.WEBCLAW_JEV_MODEL || P.model;
  const timeoutMs = opts.timeoutMs || (P.local ? 60000 : 15000);
  const extraBody = Object.assign({}, P.extraBody || {}, opts.extraBody || {});
  const maxOptions = opts.maxOptions || P.maxOptions;

  async function systemOne(state, questions, extra = {}) {
    if (!apiKey) throw Object.assign(new Error("no " + provider + " API key — set " + P.keyEnv + " or brain.apiKey in ~/.webclaw/config.json"), { reason: "no_api_key" });
    const headers = { authorization: "Bearer " + apiKey, "content-type": "application/json" };
    if (extra.longContext) headers["TypeSafe-Danger-Zone-Long-Context"] = "true";
    const body = JSON.stringify(Object.assign({ model, state, questions }, extraBody));
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      let r;
      try { r = await fetch(baseUrl + "/v1/systemone", { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) }); }
      catch (e) {
        if (attempt < 2) continue;
        throw Object.assign(new Error(provider + " unreachable at " + baseUrl + ": " + e.message + (P.local ? " — start it with `webclaw laya up`" : "")), { reason: "jev_unreachable" });
      }
      if (r.status === 429 || r.status >= 500) {
        if (attempt < 3) {
          const ra = Number(r.headers.get("retry-after"));
          await new Promise((res) => setTimeout(res, ra > 0 ? ra * 1000 : 300 * 2 ** attempt));
          continue;
        }
      }
      const text = await r.text();
      if (!r.ok) throw Object.assign(new Error(provider + " HTTP " + r.status + ": " + text.slice(0, 300)), { reason: r.status === 401 ? "jev_unauthorized" : "jev_error" });
      const j = JSON.parse(text);
      j.latencyMs = Date.now() - t0;
      return j;
    }
  }

  return { systemOne, model, baseUrl, provider, maxOptions, local: !!P.local, hasKey: !!apiKey };
}

module.exports = { createJev, PROVIDERS };
