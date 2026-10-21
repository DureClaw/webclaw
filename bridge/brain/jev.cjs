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

  const retryBaseMs = opts.retryBaseMs != null ? opts.retryBaseMs : 300;
  const maxRetryAfterMs = opts.maxRetryAfterMs != null ? opts.maxRetryAfterMs : 10000;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  // exponential backoff with a little jitter
  const backoff = (attempt) => retryBaseMs * 2 ** attempt + Math.floor(Math.random() * retryBaseMs / 2);
  // Retry-After: seconds or an HTTP date
  const retryAfter = (h) => {
    if (!h) return 0;
    const n = Number(h);
    if (Number.isFinite(n)) return Math.max(0, n * 1000);
    const d = Date.parse(h);
    return Number.isFinite(d) ? Math.max(0, d - Date.now()) : 0;
  };

  // extra.deadline (epoch ms): the whole call — retries included — ends by then
  async function systemOne(state, questions, extra = {}) {
    if (!apiKey) throw Object.assign(new Error("no " + provider + " API key — set " + P.keyEnv + " or brain.apiKey in ~/.webclaw/config.json"), { reason: "no_api_key" });
    const headers = { authorization: "Bearer " + apiKey, "content-type": "application/json" };
    if (extra.longContext) headers["TypeSafe-Danger-Zone-Long-Context"] = "true";
    const body = JSON.stringify(Object.assign({ model, state, questions }, extraBody));
    const deadline = extra.deadline || Infinity;
    const left = () => deadline - Date.now();
    const pastDeadline = () => Object.assign(new Error(provider + ": goal deadline reached"), { reason: "deadline" });
    for (let attempt = 0; ; attempt++) {
      if (left() <= 0) throw pastDeadline();
      const t0 = Date.now();
      let r;
      try { r = await fetch(baseUrl + "/v1/systemone", { method: "POST", headers, body, signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, left()))) }); }
      catch (e) {
        // network error or per-request timeout → back off and retry
        if (attempt < 3 && left() > backoff(attempt)) { await sleep(backoff(attempt)); continue; }
        if (left() <= 0) throw pastDeadline();
        const to = e && (e.name === "TimeoutError" || e.name === "AbortError");
        throw Object.assign(new Error(provider + (to ? " timed out" : " unreachable") + " at " + baseUrl + ": " + e.message + (P.local ? " — start it with `webclaw laya up`" : "")), { reason: to ? "jev_timeout" : "jev_unreachable" });
      }
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        const wait = Math.min(maxRetryAfterMs, retryAfter(r.headers.get("retry-after")) || backoff(attempt));
        if (left() > wait) {
          try { await r.body?.cancel(); } catch (e) {}
          await sleep(wait);
          continue;
        }
      }
      const text = await r.text();
      if (!r.ok) throw Object.assign(new Error(provider + " HTTP " + r.status + ": " + text.slice(0, 300)), { reason: r.status === 401 ? "jev_unauthorized" : r.status === 429 ? "jev_rate_limited" : "jev_error" });
      let j;
      try { j = JSON.parse(text); } catch (e) { j = null; }
      if (!j || typeof j !== "object" || typeof j.answers !== "object" || j.answers === null) {
        throw Object.assign(new Error(provider + " returned a non-System-One response: " + text.slice(0, 200)), { reason: "jev_bad_response" });
      }
      j.latencyMs = Date.now() - t0;
      return j;
    }
  }

  return { systemOne, model, baseUrl, provider, maxOptions, local: !!P.local, hasKey: !!apiKey };
}

module.exports = { createJev, PROVIDERS };
