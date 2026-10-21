// Extension hardening regressions (review 2026-10-21: S1 S4 S5 S6 A4–A9 A12
// A13 B, A3 contract). Dependency-free: the background service worker is
// loaded into a node:vm context with a small in-memory chrome.* stub, so the
// real listeners, policy and approval code run — no browser needed.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const EXT = "extid";
const j = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x)); // cross-realm compare
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const g = require("../guard.js");

// ── chrome stub ─────────────────────────────────────────────────────────────
function makeChrome(o = {}) {
  const store = { local: Object.assign({}, o.local), session: Object.assign({}, o.session) };
  const L = {};
  const ev = (n) => ({
    addListener: (f) => (L[n] = L[n] || []).push(f),
    removeListener: (f) => { const a = L[n] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    hasListener: () => false,
  });
  const clone = (x) => (x === undefined ? undefined : structuredClone(x));
  const area = (n) => ({
    get: async (keys) => {
      const s = store[n];
      const ks = keys == null ? Object.keys(s) : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of ks) if (k in s) out[k] = clone(s[k]);
      return out;
    },
    set: async (obj) => { Object.assign(store[n], clone(obj)); (L["storage.onChanged"] || []).forEach((f) => f(Object.fromEntries(Object.keys(obj).map((k) => [k, { newValue: obj[k] }])), n)); },
    remove: async (k) => { for (const x of [].concat(k)) delete store[n][x]; },
  });
  const tabs = o.tabs || [];
  const groups = new Set();
  let nextTab = 900, nextGroup = 50;
  const calls = { sendMessage: [], exec: [], created: [], removed: [], groupsMade: 0, badge: [] };
  const chrome = {
    runtime: {
      id: EXT, lastError: undefined,
      getURL: (p) => "chrome-extension://" + EXT + "/" + p,
      sendMessage: (msg, cb) => { calls.sendMessage.push(msg); if (typeof cb === "function") cb(undefined); return Promise.resolve(); },
      onMessage: ev("runtime.onMessage"), onInstalled: ev("onInstalled"), onStartup: ev("onStartup"),
    },
    storage: { local: area("local"), session: area("session"), onChanged: ev("storage.onChanged") },
    tabs: {
      query: async (q = {}) => tabs.filter((t) => (q.active == null || !!t.active === q.active) && (q.groupId == null || t.groupId === q.groupId)),
      get: (id, cb) => {
        const t = tabs.find((x) => x.id === id);
        const v = t ? Object.assign({ status: "complete" }, t) : undefined;
        if (typeof cb === "function") { cb(v); return undefined; } // callback form (waitTabReady)
        return t ? Promise.resolve(v) : Promise.reject(new Error("No tab with id: " + id));
      },
      create: async (p) => { const t = { id: ++nextTab, url: p.url, windowId: p.windowId || 1, active: !!p.active, status: "complete", groupId: -1, title: "" }; tabs.push(t); calls.created.push(t); return t; },
      update: async (id, p) => { const t = tabs.find((x) => x.id === id); if (t) Object.assign(t, p); return t; },
      remove: async (ids) => { for (const id of [].concat(ids)) { calls.removed.push(id); const i = tabs.findIndex((t) => t.id === id); if (i >= 0) tabs.splice(i, 1); } },
      group: async (p) => { await tick(5); const gid = p.groupId != null ? p.groupId : ++nextGroup; if (p.groupId == null) calls.groupsMade++; groups.add(gid); for (const id of p.tabIds) { const t = tabs.find((x) => x.id === id); if (t) t.groupId = gid; } return gid; },
      sendMessage: () => {}, captureVisibleTab: async () => "data:image/jpeg;base64,AA==",
      onUpdated: ev("tabs.onUpdated"), onRemoved: ev("tabs.onRemoved"),
    },
    tabGroups: { get: async (id) => { if (!groups.has(id)) throw new Error("no group"); return { id }; }, update: async () => ({}), query: async () => [] },
    windows: {
      getLastFocused: async () => ({ id: 1 }), update: async () => ({}),
      get: async (id) => { if (id !== 77) throw new Error("no window"); return { id }; },
      create: async () => { await tick(5); const t = { id: ++nextTab, url: "about:blank", windowId: 77, groupId: -1, status: "complete" }; tabs.push(t); return { id: 77, tabs: [t] }; },
    },
    scripting: {
      executeScript: async (p) => { calls.exec.push(p); return o.exec ? o.exec(p) : [{ frameId: 0, result: "hud ok" }]; },
      getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {},
    },
    offscreen: { hasDocument: async () => true, createDocument: async () => {}, closeDocument: async () => {} },
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    action: { setBadgeText: (b) => calls.badge.push(b.text), setBadgeBackgroundColor: () => {} },
    debugger: {
      getTargets: async () => o.targets || [], attach: async () => {}, detach: async (t) => { (calls.detached = calls.detached || []).push(t.tabId); },
      sendCommand: async () => ({}), onEvent: ev("debugger.onEvent"), onDetach: ev("debugger.onDetach"),
    },
    downloads: { download: () => {}, search: () => {}, cancel: () => {}, erase: () => {}, removeFile: () => {}, onChanged: ev("downloads.onChanged") },
  };
  return { chrome, store, L, calls, tabs };
}

// Load background.js (+ its importScripts modules) into a fresh context.
function loadBg(o = {}) {
  const env = makeChrome(o);
  const fetches = [];
  const ctx = {
    chrome: env.chrome, console, URL, TextEncoder, TextDecoder, crypto: globalThis.crypto, structuredClone, btoa, atob,
    setTimeout, clearTimeout, setInterval, clearInterval, unescape, encodeURIComponent,
    fetch: async (url, init) => {
      if (String(url).endsWith("config.local.json")) return { json: async () => structuredClone(o.fileCfg || {}) };
      if (String(url).includes("learnings/")) throw new Error("no bundled learnings");
      fetches.push({ url, init });
      if (o.fetch) return o.fetch(url, init);
      return { ok: true, status: 200, url, text: async () => "body", json: async () => ({ output: "ok" }) };
    },
  };
  ctx.self = ctx;
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f }); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx, { filename: "background.js" });
  // Dispatch one runtime message to every background listener.
  env.send = (msg, sender) => new Promise((resolve) => {
    let isAsync = false, done = false;
    const respond = (r) => { if (!done) { done = true; resolve({ responded: true, r }); } };
    for (const f of env.L["runtime.onMessage"] || []) if (f(msg, sender, respond) === true) isAsync = true;
    if (!isAsync) setTimeout(() => { if (!done) { done = true; resolve({ responded: false }); } }, 30);
  });
  env.ctx = ctx;
  env.fetches = fetches;
  return env;
}
const EXT_PAGE = { id: EXT, url: "chrome-extension://" + EXT + "/offscreen.html" };
const tabSender = (tab) => ({ id: EXT, tab, frameId: 0, url: tab.url });

// ── S1 — sender checks + HUD approvals ──────────────────────────────────────
test("S1: sender classification and HUD line kinds (pure)", () => {
  assert.equal(g.wcSenderKind({ id: EXT, url: "chrome-extension://extid/popup.html" }, EXT), "ext");
  assert.equal(g.wcSenderKind({ id: EXT, tab: { id: 3 }, frameId: 0 }, EXT), "tab");
  assert.equal(g.wcSenderKind({ id: EXT, tab: { id: 3 }, frameId: 2 }, EXT), "foreign", "subframes never speak for the HUD");
  assert.equal(g.wcSenderKind({ id: "other", url: "chrome-extension://other/x" }, EXT), "foreign");
  assert.equal(g.wcSenderKind(undefined, EXT), "foreign");
  assert.equal(g.gdHudLineKind(" /allow-site"), "approval");
  assert.equal(g.gdHudLineKind("/ALLOW"), "approval");
  assert.equal(g.gdHudLineKind("/deny"), "approval");
  assert.equal(g.gdHudLineKind("/done"), "done");
  assert.equal(g.gdHudLineKind("검색해줘"), "chat");
});

test("S1: privileged messages from a tab (content context) get no answer", async () => {
  const tab = { id: 5, url: "https://evil.example/", active: true };
  const env = loadBg({ tabs: [tab] });
  for (const type of ["act", "dom", "open", "fetch", "download", "space", "learn", "guard", "cdpRelay", "tabs", "getCfg", "approve", "approvals", "wwChat", "connect"]) {
    const res = await env.send({ type, action: "js", code: "1", url: "https://x.example/", op: "policy", id: "x", answer: "allow" }, tabSender(tab));
    if (type === "cdpRelay") assert.match(JSON.stringify(res.r), /forbidden sender/, type);
    else assert.equal(res.responded, false, type + " must not answer a tab sender");
  }
  // state patches from a page can't rewrite policy either
  await env.send({ type: "state", patch: { policy: { deny: [] } } }, tabSender(tab));
  assert.equal(env.store.local.policy, undefined);
  await env.send({ type: "state", patch: { policy: { mode: "auto" }, status: "connected" } }, EXT_PAGE);
  assert.equal(env.store.local.policy, undefined, "only status keys pass the state sink");
  assert.equal(env.store.local.status, "connected");
});

test("S1/A12: /allow typed in the page HUD never answers an approval and is not forwarded; the side panel does", async () => {
  const tab = { id: 5, url: "https://shop.example/cart", active: true };
  const env = loadBg({ tabs: [tab], local: { policy: { mode: "ask" } } });
  const gate = env.ctx.gdCheck({ url: tab.url, tabId: 5, mutating: true, what: "[CLICK] #buy" });
  await tick(10);
  const pending = j(env.ctx.gdPendingList());
  assert.equal(pending.length, 1);
  assert.equal(j(env.store.session.gdPending).length, 1, "A12: pending approvals persisted to storage.session");
  // the page HUD (valid HUD sender) types /allow-site → refused, not forwarded
  env.calls.sendMessage.length = 0;
  await env.send({ type: "hudChat", text: "/allow-site" }, tabSender(tab));
  await tick(20);
  assert.equal(env.ctx.gdPendingList().length, 1, "still pending");
  assert.ok(!env.calls.sendMessage.some((m) => m.type === "busInbox" && /allow/.test(m.text)), "approval lines never reach the master");
  // forged hudChat (no tab / foreign id) is ignored completely
  await env.send({ type: "hudChat", text: "pay now" }, { id: "other", tab, frameId: 0 });
  await env.send({ type: "hudChat", text: "pay now" }, EXT_PAGE);
  await tick(20);
  assert.ok(!env.calls.sendMessage.some((m) => m.type === "busInbox" && m.text === "pay now"));
  // side panel lists + answers it
  const list = await env.send({ type: "approvals" }, { id: EXT, url: "chrome-extension://extid/sidepanel.html" });
  assert.equal(list.r.pending[0].host, "shop.example");
  const a = await env.send({ type: "approve", id: pending[0].id, answer: "allow-site" }, { id: EXT, url: "chrome-extension://extid/sidepanel.html" });
  assert.equal(a.r.ok, true);
  assert.equal(await gate, null, "approved → action may run");
  assert.deepEqual(j(env.store.session.gdApproved), ["shop.example"]);
  assert.equal(j(env.store.session.gdPending).length, 0);
});

test("S1: a normal HUD chat line is forwarded with the sender's URL, not the page-supplied one", async () => {
  const tab = { id: 6, url: "https://a.example/p", active: true };
  const env = loadBg({ tabs: [tab] });
  await env.send({ type: "hudChat", text: "hello", url: "https://spoof.example/" }, tabSender(tab));
  await tick(30);
  const m = env.calls.sendMessage.find((x) => x.type === "busInbox");
  assert.equal(m.text, "hello");
  assert.equal(m.url, "https://a.example/p");
});

test("A12: approvals persisted by a dead worker are expired at startup", async () => {
  const env = loadBg({ tabs: [{ id: 8, url: "https://x.example/" }], session: { gdPending: [{ id: "ap-1", tabId: 8, host: "x.example", what: "[CLICK] a", risky: false, at: 1 }] } });
  await tick(30);
  assert.deepEqual(j(env.store.session.gdPending), []);
  const hud = env.calls.exec.find((c) => c.args && /만료/.test(String(c.args[0])));
  assert.ok(hud, "the human is told the question expired");
});

test("A12: relay restore re-adopts saved relayed tabs and detaches orphaned sessions", async () => {
  const env = loadBg({
    tabs: [{ id: 1, url: "https://a.example/" }, { id: 2, url: "https://b.example/" }],
    session: { wcRelayTabs: [1] },
    targets: [{ id: "T1", tabId: 1, type: "page", attached: true, url: "https://a.example/" }, { id: "T2", tabId: 2, type: "page", attached: true }, { id: "T3", tabId: 3, type: "page", attached: false }],
  });
  await tick(30);
  assert.deepEqual(j(env.calls.detached), [2]);
  assert.deepEqual(j(env.store.session.wcRelayTabs), [1]);
});

// ── A8 — risky coverage ─────────────────────────────────────────────────────
test("A8: [DIFF] targets, whole [JS] bodies and [CDP] Input.* are risk-checked", () => {
  const p = { confirmRisky: true };
  const diff = g.gdActSpec({ action: "diff", code: "clicktext:결제하기" });
  assert.equal(diff.label, "결제하기");
  assert.equal(g.gdIsRisky(p, diff.label, "[DIFF]"), true);
  assert.equal(g.gdActSpec({ action: "diff", code: "click:@12" }).describe, "@12", "click: targets are described from the page");
  const js = g.gdActSpec({ action: "js", code: "x".repeat(200) + "; document.querySelector('#checkout').click()" });
  assert.equal(g.gdIsRisky(p, js.label, "[JS]"), true, "risky words past char 80 still count");
  const cdp = g.gdActSpec({ action: "cdp", method: "Input.dispatchMouseEvent", params: { type: "mousePressed" } });
  assert.equal(cdp.forceRisky, true);
  assert.equal(g.gdIsRisky(p, cdp.label, "[CDP]", cdp.forceRisky), true);
  assert.equal(g.gdIsRisky({ confirmRisky: false }, cdp.label, "[CDP]", cdp.forceRisky), false, "only when the human enabled confirmRisky");
  assert.equal(g.gdIsRisky(p, g.gdActSpec({ action: "cdp", method: "Page.reload" }).label, "[CDP]"), false);
});

test("A8: ask flow triggers for a [DIFF] clicktext:결제하기 through gdGateAct", async () => {
  const tab = { id: 9, url: "https://pay.example/", active: true };
  const env = loadBg({ tabs: [tab], local: { policy: { confirmRisky: true } } });
  const p = env.ctx.gdGateAct(tab, { action: "diff", code: "clicktext:결제하기" });
  await tick(10);
  const pend = j(env.ctx.gdPendingList());
  assert.equal(pend.length, 1);
  assert.equal(pend[0].risky, true);
  await env.send({ type: "approve", id: pend[0].id, answer: "deny" }, EXT_PAGE);
  assert.equal((await p).reason, "approval_denied");
});

// ── A6 — config floor ───────────────────────────────────────────────────────
test("A6: file policy is a floor — deny lists unioned, survives a stored cfg", async () => {
  const merged = g.wcMergeCfg({ bus: "file:4000", policy: { deny: ["bank.example"], mode: "ask" }, cdpDeny: ["X.y"], identity: { on: true } },
    { bus: "stored:4000", name: "n" }, { cdp: "minimal" });
  assert.equal(merged.bus, "stored:4000");
  assert.equal(merged.cdp, "minimal");
  assert.deepEqual(merged.policy.deny, ["bank.example"]);
  assert.deepEqual(merged.cdpDeny, ["X.y"]);
  assert.equal(merged.identity.on, true);
  const p = g.wcMergePolicy({ mode: "auto", deny: [] }, { deny: ["bank.example"], mode: "ask" }, { deny: ["mail.example"], mode: "auto" });
  assert.deepEqual(p.deny, ["bank.example", "mail.example"]);
  assert.equal(p.mode, "auto", "other fields: popup value overrides");
  assert.equal(g.wcMergeCfg({ bus: "f" }, null, {}).bus, "f", "no stored cfg → file connection");

  const env = loadBg({ fileCfg: { policy: { deny: ["bank.example"] } }, local: { cfg: { bus: "b:1" }, policy: { deny: [] } } });
  const eff = j(await env.ctx.gdPolicy());
  assert.deepEqual(eff.deny, ["bank.example"], "popup's empty deny list cannot remove the file's");
  const r = await env.send({ type: "effectivePolicy" }, { id: EXT, url: "chrome-extension://extid/popup.html" });
  assert.deepEqual(j(r.r.fileDeny), ["bank.example"]);
});

// ── S5 — deny list holes ────────────────────────────────────────────────────
test("S5: redirect chain helper finds a denied hop", () => {
  assert.equal(g.gdDeniedInChain(["https://ok.example/a", "https://login.bank.example/x"], ["bank.example"]), "login.bank.example");
  assert.equal(g.gdDeniedInChain(["https://ok.example/a", undefined], ["bank.example"]), "");
});

test("S5/A5: [FETCH] refuses a redirect into a denied host; non-2xx is a failure", async () => {
  const env = loadBg({
    local: { policy: { deny: ["bank.example"] } },
    fetch: async (url) => url.includes("redir")
      ? { ok: true, status: 200, url: "https://www.bank.example/statement", text: async () => "SECRET", body: { cancel() {} } }
      : { ok: false, status: 404, statusText: "Not Found", url, text: async () => "nope" },
  });
  const a = await env.send({ type: "fetch", url: "https://ok.example/redir" }, EXT_PAGE);
  assert.equal(a.r.failed, true);
  assert.equal(a.r.reason, "policy_denied");
  assert.doesNotMatch(a.r.text, /SECRET/);
  const b = await env.send({ type: "fetch", url: "https://ok.example/missing" }, EXT_PAGE);
  assert.equal(b.r.reason, "http_404");
  assert.equal(b.r.status, 404);
});

test("S5: CDP default deny list covers browser-wide cookie/storage writes", () => {
  const env = loadBg();
  const d = j(vm.runInContext("WcCdp.DEFAULT_DENY", env.ctx));
  for (const m of ["Network.clearBrowserCookies", "Network.setCookie", "Network.setCookies", "Network.deleteCookies", "Storage.clearDataForOrigin", "Storage.clearCookies", "Storage.setCookies"]) assert.ok(d.includes(m), m);
});

test("S5: relay drops events/commands of a denied site (navigation, child session, subresource)", () => {
  const env = loadBg();
  const { wcRelayEventAllowed, wcRelayCommandRefusal } = env.ctx;
  const st = { tabUrl: new Map([[1, "https://ok.example/"]]), sessionUrl: new Map(), deniedReq: new Set(), deny: ["bank.example"] };
  assert.equal(wcRelayEventAllowed(st, { tabId: 1 }, "Runtime.consoleAPICalled", {}), true);
  // OOPIF of a denied site
  assert.equal(wcRelayEventAllowed(st, { tabId: 1 }, "Target.attachedToTarget", { sessionId: "S1", targetInfo: { url: "https://bank.example/frame" } }), false);
  assert.equal(wcRelayEventAllowed(st, { tabId: 1, sessionId: "S1" }, "Network.requestWillBeSent", { requestId: "r0" }), false);
  assert.match(wcRelayCommandRefusal(st, 1, { method: "Runtime.evaluate", sessionId: "S1" }), /deny list/);
  // subresource request to a denied host + its ExtraInfo (cookie headers)
  assert.equal(wcRelayEventAllowed(st, { tabId: 1 }, "Network.requestWillBeSent", { requestId: "r1", request: { url: "https://api.bank.example/me" } }), false);
  assert.equal(wcRelayEventAllowed(st, { tabId: 1 }, "Network.requestWillBeSentExtraInfo", { requestId: "r1", headers: { cookie: "sid=1" } }), false);
  assert.match(wcRelayCommandRefusal(st, 1, { method: "Network.getResponseBody", params: { requestId: "r1" } }), /denied/);
  assert.equal(wcRelayCommandRefusal(st, 1, { method: "Page.navigate", params: { url: "https://ok.example/2" } }), null);
  assert.match(wcRelayCommandRefusal(st, 1, { method: "Page.navigate", params: { url: "https://bank.example/" } }), /deny list/);
  // main frame navigates into the denied site → that event and everything after is dropped
  assert.equal(wcRelayEventAllowed(st, { tabId: 1 }, "Page.frameNavigated", { frame: { id: "F", url: "https://bank.example/login" } }), false);
  assert.equal(wcRelayEventAllowed(st, { tabId: 1 }, "Runtime.consoleAPICalled", {}), false);
  assert.match(wcRelayCommandRefusal(st, 1, { method: "Runtime.evaluate" }), /deny list/);
});

test("S4/B: relay attach honours cfg.cdp off and hand-off; close only hits exposed tabs", async () => {
  const human = { id: 3, url: "https://mine.example/", groupId: -1 };
  const env = loadBg({ tabs: [human, { id: 4, url: "https://agent.example/", groupId: 60 }],
    local: { prefs: { cdp: "off", relayScope: "all" } } });
  await assert.rejects(env.ctx.wcRelayCall({ method: "webclaw.attach", params: { targetId: "tab-4" } }), /cdp unavailable/);
  env.store.local.prefs = { relayScope: "all" };
  // tab 4 belongs to a handed-off space
  env.store.local.wcSpaces = { s: { groupId: 60, windowId: 1, owner: "user" } };
  await assert.rejects(env.ctx.wcRelayCall({ method: "webclaw.attach", params: { targetId: "tab-4" } }), /handed off/);
  // close: relayScope "space" exposes only the cdp space → the human's tab is safe
  env.store.local.prefs = { relayScope: "space" };
  await assert.rejects(env.ctx.wcRelayCall({ method: "webclaw.close", params: { targetId: "tab-3" } }), /not exposed/);
  assert.ok(!env.calls.removed.includes(3));
  // detach of a tab the relay never attached is a no-op
  assert.deepEqual(j(await env.ctx.wcRelayCall({ method: "webclaw.detach", params: { targetId: "tab-3" } })), {});
});

// ── S6 — values never reach the HUD log; history per origin ─────────────────
test("S6: [FILL] logs selector + length only; audit/recorder outputs are redacted", async () => {
  const tab = { id: 12, url: "https://login.example/", active: true };
  const env = loadBg({ tabs: [tab], exec: (p) => [{ frameId: 0, result: p.func.name === "wcActInjected" ? "filled #pw = hunter2" : "hud ok" }] });
  const resp = await env.ctx.wcAct({ action: "fill", selector: "#pw", value: "hunter2" });
  assert.match(resp.text, /filled #pw/);
  await tick(20);
  const huds = env.calls.exec.filter((c) => c.func.name === "hudInjected").map((c) => String(c.args[0]));
  const line = huds.find((t) => t.startsWith("[FILL]"));
  assert.equal(line, "[FILL] #pw → filled (7 chars)");
  assert.ok(!huds.some((t) => t.includes("hunter2")));
  const hist = JSON.stringify(env.store.local.chatHistories);
  assert.ok(!hist.includes("hunter2"), "nor in the persisted HUD history");
  assert.equal(g.gdRedactOut("fill", "filled #pw = hunter2"), "filled #pw = (redacted)");
  assert.equal(g.gdRedactOut("click", "clicked #a"), "clicked #a");
});

test("S6/B: HUD history is keyed by tab+origin and dropped when the tab changes origin", async () => {
  const tab = { id: 13, url: "https://a.example/one", active: true };
  const env = loadBg({ tabs: [tab, { id: 14, url: "https://c.example/" }], local: { chatHistories: { "99|https://gone.example": [{ text: "x" }], "13": [{ text: "old format" }] } } });
  await tick(20); // startup prune
  await env.ctx.hudNotify(13, "🧑 나: hi");
  assert.deepEqual(Object.keys(env.store.local.chatHistories), ["13|https://a.example"], "dead tabs + old keys pruned");
  tab.url = "https://a.example/two";
  for (const f of env.L["tabs.onUpdated"]) f(13, { url: tab.url });
  await tick(10);
  assert.ok(env.store.local.chatHistories["13|https://a.example"], "same origin keeps the conversation");
  tab.url = "https://evil.example/";
  for (const f of env.L["tabs.onUpdated"]) f(13, { url: tab.url });
  await tick(10);
  assert.deepEqual(Object.keys(env.store.local.chatHistories), [], "another origin never sees it");
});

// ── A7 — recorder ───────────────────────────────────────────────────────────
test("A7: recorder shoots only executed actions on non-denied pages", () => {
  const p = { deny: ["bank.example"] };
  assert.equal(g.gdRecShoot({ result: "ok", host: "ok.example" }, p, "https://ok.example/"), true);
  assert.equal(g.gdRecShoot({ result: "failed", host: "ok.example", reason: "approval_denied" }, p, "https://ok.example/"), false);
  assert.equal(g.gdRecShoot({ result: "ok", host: "bank.example" }, p, "https://bank.example/"), false);
  assert.equal(g.gdRecShoot({ result: "ok", host: "ok.example" }, p, "https://www.bank.example/after-redirect"), false);
});

// ── A5 — failures are failures ──────────────────────────────────────────────
test("A5: no target tab → failed/no_tab; open errors → failed", async () => {
  const env = loadBg({ tabs: [] });
  const r = await env.ctx.wcAct({ action: "click", selector: "#a" });
  assert.equal(r.failed, true);
  assert.equal(r.reason, "no_tab");
  const d = await env.send({ type: "dom", query: "" }, EXT_PAGE);
  assert.equal(d.r.reason, "no_tab");
  env.ctx.chrome.tabs.create = async () => { throw new Error("boom"); };
  const o = await env.ctx.wcOpenLogged({ url: "https://x.example/" });
  assert.equal(o.failed, true);
  assert.equal(o.reason, "open_error");
});

// ── B — standalone [OPEN] runs directly ─────────────────────────────────────
test("B/A3: standalone HUD goal → mode:goal with node+tab; a marker reply opens directly", async () => {
  const tab = { id: 20, url: "https://news.example/a?b=1", active: true };
  const env = loadBg({
    tabs: [tab], local: { cfg: { brainUrl: "http://127.0.0.1:4111", standalone: true }, activeCfg: { name: "webclaw@chrome-ab12" } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ output: "[OPEN] https://search.example/?q=x" }) }),
  });
  await env.ctx.standaloneHandle(20, "검색해줘", tab.url);
  const body = JSON.parse(env.fetches[0].init.body);
  assert.equal(body.mode, "goal");
  assert.equal(body.node, "webclaw@chrome-ab12");
  assert.equal(body.tab, "news.example/a");
  assert.match(body.prompt, /User: 검색해줘/);
  assert.equal(env.calls.created[0].url, "https://search.example/?q=x", "[OPEN] executed without a self-sendMessage");
});

test("A3: Wide Worker chat and auto-title send mode chat / title", async () => {
  const env = loadBg({ local: { cfg: { brainUrl: "http://b" }, wwTasks: [{ id: "t1", name: "새 작업", chat: [], autoTitled: false }] } });
  await env.ctx.wwChat("t1", "환율 알려줘");
  const modes = env.fetches.map((f) => JSON.parse(f.init.body).mode);
  assert.deepEqual(modes, ["chat", "title"]);
});

test("A3: core.js free-text delegation sends mode:chat", async () => {
  const { runTask } = require("../core.js");
  const orig = global.fetch;
  let body;
  global.fetch = async (u, init) => { body = JSON.parse(init.body); return { json: async () => ({ output: "x" }) }; };
  try { await runTask("summarize", { brainUrl: "http://b" }, {}); } finally { global.fetch = orig; }
  assert.equal(body.mode, "chat");
});

// ── A13 — spaces serialized ─────────────────────────────────────────────────
test("A13: concurrent spEnsure creates one space; a parallel hand-off is not lost", async () => {
  const env = loadBg();
  const [a, b] = await Promise.all([env.ctx.spEnsure("x"), env.ctx.spEnsure("x")]);
  assert.equal(a.groupId, b.groupId);
  assert.equal(env.calls.groupsMade, 1);
  await Promise.all([env.ctx.spSetOwner("x", "user", "login"), env.ctx.spEnsure("y")]);
  const sp = env.store.local.wcSpaces;
  assert.equal(sp.x.owner, "user", "hand-off survives the concurrent write");
  assert.ok(sp.y);
});

// ── A4 — outline line contract ──────────────────────────────────────────────
function fakeDom(specs) {
  const doc = { title: "T", getElementById: () => null };
  const els = specs.map((s) => {
    const a = Object.assign({}, s.attrs);
    return Object.assign({
      tagName: s.tag, shadowRoot: null, parentElement: null, isContentEditable: false, labels: [], disabled: false, checked: false, tabIndex: -1,
      value: s.value || "", type: (s.attrs && s.attrs.type) || "", innerText: s.text || "", textContent: s.text || "",
      getAttribute: (k) => (k in a ? a[k] : null), hasAttribute: (k) => k in a, setAttribute: (k, v) => { a[k] = String(v); }, removeAttribute: (k) => { delete a[k]; },
      getBoundingClientRect: () => ({ width: 10, height: 10, left: 0, top: 0 }), closest: () => null, querySelector: () => null, getRootNode: () => doc,
    }, s.props || {});
  });
  doc.querySelectorAll = () => els;
  return doc;
}

test("A4: [OUTLINE] lines are `@N <role> <JSON name>` — quotes/backslashes escaped, plain names unchanged; passwords masked", () => {
  const doc = fakeDom([
    { tag: "BUTTON", text: "Sign in" },
    { tag: "BUTTON", text: 'Say "hi" \\ now' },
    { tag: "A", attrs: { href: "/x" }, text: "Docs" },
    { tag: "INPUT", attrs: { type: "password", placeholder: "Password" }, value: "hunter2" },
  ]);
  const ctx = { document: doc, location: { href: "https://x.example/" }, getComputedStyle: () => ({ visibility: "visible", display: "block", cursor: "auto" }),
    chrome: { tabs: { onRemoved: { addListener() {} } }, storage: { session: {} } } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "refs.js"), "utf8"), ctx, { filename: "refs.js" });
  const out = ctx.wcOutlineInjected(50);
  const lines = out.items.map((i) => i.line);
  assert.equal(lines[0], 'button "Sign in"');
  assert.equal(lines[1], "button " + JSON.stringify('Say "hi" \\ now'));
  assert.equal(lines[2], 'link "Docs" → /x');
  assert.equal(lines[3], 'textbox "Password" value="•••••••" type=password');
  // the brain parses the name with JSON.parse
  const m = ("@2 " + lines[1]).match(/^(@\d+) (\S+) ("(?:[^"\\]|\\.)*")(.*)$/);
  assert.equal(JSON.parse(m[3]), 'Say "hi" \\ now');
});

// ── A9 — WebMCP shim ────────────────────────────────────────────────────────
function shimEnv() {
  class Navigator {}
  const nav = new Navigator();
  const wl = [];
  const win = {
    addEventListener: (t, f, cap) => wl.push({ t, f, cap }),
  };
  class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init && init.detail; this._stop = false; }
    stopImmediatePropagation() { this._stop = true; }
  }
  const doc = {
    // window capture listeners run first for an event dispatched on document
    dispatchEvent: (e) => { for (const l of wl) { if (l.t === e.type) l.f(e); if (e._stop) break; } return true; },
  };
  const ctx = { navigator: nav, Navigator, window: win, document: doc, CustomEvent, setTimeout, clearTimeout, console };
  win.window = win;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "webmcp-shim.js"), "utf8"), ctx, { filename: "webmcp-shim.js" });
  const bg = loadBg();
  vm.runInContext("var wmInjected = " + bg.ctx.wmInjected.toString(), ctx);
  return { ctx, nav, Navigator, win, wl };
}
const KEY = "0123456789abcdef0123456789abcdef";

test("A9: polyfill is configurable/assignable, leaves nothing on window, and prefers a native API that appears later", async () => {
  const { ctx, nav, Navigator, win } = shimEnv();
  assert.equal(Object.getOwnPropertySymbols(win).length, 0, "no Symbol.for registry on window");
  assert.ok(!Object.keys(win).some((k) => /webclaw|webmcp/i.test(k)));
  const d = Object.getOwnPropertyDescriptor(nav, "modelContext");
  assert.equal(d.configurable, true);
  nav.modelContext.registerTool({ name: "add", description: "a+b", execute: async (x) => x.a + x.b });
  const list = await ctx.wmInjected(KEY, "list", {});
  assert.deepEqual(j(list.tools.map((t) => t.name)), ["add"]);
  assert.deepEqual(j(await ctx.wmInjected(KEY, "call", { name: "add", args: { a: 2, b: 3 } })), { result: 5 });
  // a native implementation shows up later → the getter steps aside (wrapped, args forwarded)
  const got = [];
  const native = { registerTool(...args) { got.push(args.length); } };
  Object.defineProperty(Navigator.prototype, "modelContext", { configurable: true, get: () => native });
  assert.equal(nav.modelContext, native);
  nav.modelContext.registerTool({ name: "n", execute: () => 1 }, { signal: null });
  assert.deepEqual(got, [2], "all arguments forwarded");
  assert.ok(j((await ctx.wmInjected(KEY, "list", {})).tools.map((t) => t.name)).includes("n"));
  // pages may assign their own value
  nav.modelContext = { mine: true };
  assert.equal(nav.modelContext.mine, true);
});

test("A9: requestUserInteraction pauses for the human; deny rejects, allow runs the callback; foreign keys are ignored", async () => {
  const { ctx, nav } = shimEnv();
  let ran = 0;
  nav.modelContext.registerTool({ name: "buy", execute: async (_a, client) => {
    try { await client.requestUserInteraction(async () => { ran++; return "ok"; }); return "bought"; } catch (e) { return "declined: " + e.message; }
  } });
  const first = await ctx.wmInjected(KEY, "call", { name: "buy", args: {} }); // arms the key
  assert.ok(first.interaction, "paused, not auto-confirmed");
  assert.equal(ran, 0);
  assert.match(j(await ctx.wmInjected(KEY, "resume", { callId: first.interaction, allow: false })).result, /^declined/);
  const second = await ctx.wmInjected(KEY, "call", { name: "buy", args: {} });
  assert.deepEqual(j(await ctx.wmInjected(KEY, "resume", { callId: second.interaction, allow: true })), { result: "bought" });
  assert.equal(ran, 1);
  const other = await ctx.wmInjected("ffffffffffffffffffffffffffffffff", "list", {});
  assert.match(other.error, /not present/, "a page probing with another key gets nothing");
});
