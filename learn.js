// webclaw site learnings (v0.7.0). Loaded into the background SW.
//
// Per-domain experience the fleet can reuse instead of re-discovering a site
// every time:  { notes: [..], selectors: { name: css }, recipes: { name: code } }
// - bundled:  learnings/index.json → ["example.com", ...] + learnings/<domain>.json
// - learned:  chrome.storage.local wcLearnings[domain] (written by [LEARN])
// Learned entries merge over bundled ones. Recipes are [RUN] scripts executed
// by [RECIPE] <domain>/<name> with an `args` object.

let lnBundled = null;

async function lnLoadBundled() {
  if (lnBundled) return lnBundled;
  lnBundled = {};
  try {
    const idx = await (await fetch(chrome.runtime.getURL("learnings/index.json"))).json();
    for (const d of idx) {
      try { lnBundled[d] = await (await fetch(chrome.runtime.getURL("learnings/" + d + ".json"))).json(); } catch {}
    }
  } catch {}
  return lnBundled;
}

function lnHost(s) {
  s = String(s || "").trim();
  try { if (/^[a-z]+:\/\//i.test(s)) s = new URL(s).hostname; } catch {}
  return s.replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
}

function lnMerge(a, b) {
  a = a || {}; b = b || {};
  return {
    notes: [...new Set([...(a.notes || []), ...(b.notes || [])])],
    selectors: Object.assign({}, a.selectors, b.selectors),
    recipes: Object.assign({}, a.recipes, b.recipes),
  };
}

async function lnAll() {
  const bundled = await lnLoadBundled();
  const { wcLearnings = {} } = await chrome.storage.local.get("wcLearnings");
  const all = {};
  for (const d of new Set([...Object.keys(bundled), ...Object.keys(wcLearnings)])) all[d] = lnMerge(bundled[d], wcLearnings[d]);
  return all;
}

// Exact host first, then parent domains (mail.google.com → google.com).
async function lnFor(urlOrDomain) {
  const all = await lnAll();
  const parts = lnHost(urlOrDomain).split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join(".");
    if (all[d]) return Object.assign({ domain: d }, all[d]);
  }
  return null;
}

function lnSummary(e) {
  if (!e) return "";
  const lines = ["Site notes for " + e.domain + ":"];
  for (const n of e.notes) lines.push("- " + n);
  const sels = Object.entries(e.selectors);
  if (sels.length) lines.push("selectors: " + sels.map(([k, v]) => k + " = " + v).join(" ; "));
  const rec = Object.keys(e.recipes);
  if (rec.length) lines.push("recipes ([RECIPE] " + e.domain + "/<name>): " + rec.join(", "));
  return lines.join("\n");
}

async function lnHandle(msg) {
  if (msg.op === "list") {
    const all = await lnAll();
    const ds = Object.keys(all).sort();
    return { text: ds.length ? ds.map((d) => d + " — notes:" + all[d].notes.length + " selectors:" + Object.keys(all[d].selectors).length + " recipes:" + Object.keys(all[d].recipes).length).join("\n") : "(no learnings yet — add with [LEARN] <domain>\\n<json>)" };
  }
  if (msg.op === "get") {
    const e = await lnFor(msg.domain);
    return e ? { text: lnSummary(e) } : { text: "(no learnings for " + lnHost(msg.domain) + ")", failed: true, reason: "no_learning" };
  }
  if (msg.op === "set") {
    const d = lnHost(msg.domain);
    if (!d) return { text: "(no domain)", failed: true, reason: "bad_args" };
    const { wcLearnings = {} } = await chrome.storage.local.get("wcLearnings");
    wcLearnings[d] = lnMerge(wcLearnings[d], msg.data);
    await chrome.storage.local.set({ wcLearnings });
    return { text: lnSummary(Object.assign({ domain: d }, lnMerge((await lnLoadBundled())[d], wcLearnings[d]))) };
  }
  if (msg.op === "forget") {
    const d = lnHost(msg.domain);
    const { wcLearnings = {} } = await chrome.storage.local.get("wcLearnings");
    const had = !!wcLearnings[d];
    delete wcLearnings[d];
    await chrome.storage.local.set({ wcLearnings });
    return { text: had ? "forgot learned notes for " + d + " (bundled ones stay)" : "(nothing learned for " + d + ")" };
  }
  // v0.9.0 — share learnings between nodes / through a registry
  if (msg.op === "export") {
    const { wcLearnings = {} } = await chrome.storage.local.get("wcLearnings");
    return { text: JSON.stringify(wcLearnings) };
  }
  if (msg.op === "import") {
    if (!msg.data || typeof msg.data !== "object") return { text: "(import needs a {domain: {...}} object)", failed: true, reason: "bad_args" };
    const { wcLearnings = {} } = await chrome.storage.local.get("wcLearnings");
    const ds = [];
    for (const [d, v] of Object.entries(msg.data)) { const h = lnHost(d); if (!h) continue; wcLearnings[h] = lnMerge(wcLearnings[h], v); ds.push(h); }
    await chrome.storage.local.set({ wcLearnings });
    return { text: "imported learnings for " + ds.length + " domain(s): " + ds.join(", ") };
  }
  if (msg.op === "recipe") {
    const e = await lnFor(msg.domain);
    const code = e && e.recipes[msg.name];
    if (!code) return { text: "(no recipe " + msg.name + " for " + lnHost(msg.domain) + ")", failed: true, reason: "no_learning" };
    return { text: code };
  }
  return { text: "(unknown learn op: " + msg.op + ")", failed: true, reason: "bad_args" };
}
