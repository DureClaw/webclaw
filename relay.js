// webclaw CDP relay — background side (v0.9.0). Loaded via importScripts().
//
// Lets an unmodified CDP client (Puppeteer `connect`, Playwright
// `connectOverCDP`, Stagehand, browser-use…) drive tabs of the user's real
// Chrome through chrome.debugger. The bridge's mini-bus emulates the
// browser-level Target/Browser domains and forwards page-session traffic here
// ("cdp.call" over the bus → offscreen → this file); events flow back the
// same way ("cdp.event"). Exposed tabs = the agent Space "cdp" by default
// (cfg.relayScope = "all" exposes every tab) so a connecting client does not
// grab the human's own tabs.
//
// Policy applies exactly like it does to markers: attach needs CDP enabled
// (cfg.cdp ≠ off, debugging bar not cancelled), a tab not handed off to the
// user, and gdCheck (deny list, ask mode); every page command re-checks those,
// runs risky input through gdCheck, and the raw-[CDP] deny list. Events and
// child sessions of a denied site (navigation, OOPIF, subresource requests)
// are never forwarded.

const wcRelayTabs = new Set();
const WC_RELAY_SPACE = "cdp";
const WC_RELAY_PAGE_TARGET = new Set(["Target.setAutoAttach", "Target.detachFromTarget", "Target.getTargetInfo"]);
// commands that synthesize input / run page code → human policy (ask / risky)
const WC_RELAY_RISKY = /^(Input\.|Runtime\.evaluate$|Runtime\.callFunctionOn$)/;

// Per-tab filter state: current main-frame URL, child session URLs, request
// ids that belong to a denied host. Kept synchronous (events must stay in
// order), the deny list is a cache refreshed on every relayed call.
const wcRelayState = { tabUrl: new Map(), sessionUrl: new Map(), deniedReq: new Set(), deny: [] };
const wcRelayInputOk = new Set(); // tabIds whose synthetic input the human approved (until detach)

// Pure: should this debugger event reach the CDP client? Updates `st` from
// navigation / attach / request events first, so the event that *enters* a
// denied site is itself dropped.
function wcRelayEventAllowed(st, src, method, params) {
  params = params || {};
  const denied = (u) => !!u && gdMatch(gdHost(u), st.deny);
  if (src.sessionId) {
    if (denied(st.sessionUrl.get(src.sessionId))) return false;
  } else {
    if (method === "Page.frameNavigated" && params.frame && !params.frame.parentId) st.tabUrl.set(src.tabId, params.frame.url || "");
    if (denied(st.tabUrl.get(src.tabId))) return false;
  }
  if (method === "Target.attachedToTarget" || method === "Target.targetInfoChanged") {
    const ti = params.targetInfo || {};
    if (params.sessionId) st.sessionUrl.set(params.sessionId, ti.url || "");
    if (denied(ti.url)) return false;
  }
  if (method === "Target.detachedFromTarget" && params.sessionId) st.sessionUrl.delete(params.sessionId);
  if (/^(Network|Fetch)\./.test(method)) {
    const u = (params.request && params.request.url) || (params.response && params.response.url) || params.documentURL || "";
    if (params.requestId && denied(u)) {
      if (st.deniedReq.size > 5000) st.deniedReq.clear();
      st.deniedReq.add(params.requestId);
    }
    if (params.requestId && st.deniedReq.has(params.requestId)) return false;
    if (denied(u)) return false;
  }
  return true;
}

// Pure: may a client command go out? (null = yes, else the refusal text)
function wcRelayCommandRefusal(st, tabId, m) {
  const denied = (u) => !!u && gdMatch(gdHost(u), st.deny);
  const tu = st.tabUrl.get(tabId);
  if (denied(tu)) return "policy: " + gdHost(tu) + " is on the deny list";
  if (m.sessionId && denied(st.sessionUrl.get(m.sessionId))) return "policy: " + gdHost(st.sessionUrl.get(m.sessionId)) + " is on the deny list";
  const p = m.params || {};
  if (p.requestId && st.deniedReq.has(p.requestId)) return "policy: request belongs to a denied site";
  if (/^(Page\.navigate|Target\.createTarget)$/.test(m.method) && denied(p.url)) return "policy: " + gdHost(p.url) + " is on the deny list";
  return null;
}

// CDP clients (Playwright especially) assume a page target's id == its main
// frame id, so report Chrome's real target ids (chrome.debugger.getTargets),
// plus webclawTabId for the mini-bus to route by.
async function wcRelayIds() {
  const m = new Map();
  for (const t of await chrome.debugger.getTargets()) if (t.tabId != null && t.type === "page") m.set(t.tabId, t.id);
  return m;
}
function wcRelayTarget(t, ids) {
  return { targetId: (ids && ids.get(t.id)) || "tab-" + t.id, webclawTabId: t.id, type: "page", title: t.title || "",
    url: t.url || t.pendingUrl || "about:blank", attached: wcRelayTabs.has(t.id), canAccessOpener: false, browserContextId: "webclaw" };
}
async function wcRelayTabOf(targetId) {
  if (/^tab-\d+$/.test(String(targetId))) return Number(String(targetId).slice(4));
  for (const t of await chrome.debugger.getTargets()) if (t.id === targetId && t.tabId != null) return t.tabId;
  return NaN;
}

async function wcRelayExposed() {
  const cfg = await readCfg();
  if (cfg.relayScope === "all") return (await chrome.tabs.query({})).filter((t) => !/^(chrome|chrome-extension|devtools):/.test(t.url || ""));
  const sp = await spEnsure(WC_RELAY_SPACE);
  return chrome.tabs.query({ groupId: sp.groupId });
}

// A12 — relayed tabs survive a service-worker restart (storage.session).
function wcRelaySave() { return chrome.storage.session.set({ wcRelayTabs: [...wcRelayTabs] }).catch(() => {}); }

function wcRelayEvent(payload) { chrome.runtime.sendMessage(Object.assign({ type: "cdpEvent" }, payload)).catch(() => {}); }

function wcRelayDetached(tabId, reason) {
  wcRelayState.tabUrl.delete(tabId); wcRelayInputOk.delete(tabId);
  if (!wcRelayTabs.delete(tabId)) return;
  wcRelaySave();
  wcRelayEvent({ tabId, method: "webclaw.detached", params: { reason } });
}

async function wcRelayRefreshDeny() { wcRelayState.deny = (await gdPolicy()).deny; }

if (typeof chrome !== "undefined" && chrome.debugger) {
  chrome.debugger.onEvent.addListener((src, method, params) => {
    if (src.tabId == null || !wcRelayTabs.has(src.tabId)) return;
    if (!wcRelayEventAllowed(wcRelayState, src, method, params)) return;
    wcRelayEvent({ tabId: src.tabId, sessionId: src.sessionId, method, params });
  });
}
chrome.tabs.onRemoved.addListener((tabId) => {
  wcRelayState.tabUrl.delete(tabId); wcRelayInputOk.delete(tabId);
  if (wcRelayTabs.delete(tabId)) { wcRelaySave(); wcRelayEvent({ tabId, method: "webclaw.targetDestroyed", params: {} }); }
});
// the tab's URL also changes without a Page event (omnibox, SW restart gaps)
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info && info.url && wcRelayTabs.has(tabId)) wcRelayState.tabUrl.set(tabId, info.url);
});
// keep the event filter's deny list current when the human edits the policy
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.policy || ch.cfg)) wcRelayRefreshDeny().catch(() => {}); });
}

// SW startup: re-adopt the relayed tabs, and detach debugger sessions this
// extension left behind (a dead worker's idle timers never fired). detach()
// only succeeds for our own sessions, so foreign debuggers are untouched.
async function wcRelayRestore() {
  if (typeof chrome === "undefined" || !chrome.debugger) return;
  const { wcRelayTabs: saved = [] } = await chrome.storage.session.get("wcRelayTabs");
  await wcRelayRefreshDeny().catch(() => {});
  for (const t of await chrome.debugger.getTargets()) {
    if (!t.attached || t.tabId == null || t.type !== "page") continue;
    if (saved.includes(t.tabId)) {
      wcRelayTabs.add(t.tabId);
      wcRelayState.tabUrl.set(t.tabId, t.url || "");
      WcCdp.pin(t.tabId, true);
    } else if (!WcCdp.isAttached(t.tabId)) { // not one this worker attached meanwhile
      try { await chrome.debugger.detach({ tabId: t.tabId }); } catch (e) {}
    }
  }
  wcRelaySave();
}

async function wcRelayCall(m) {
  if (m.method === "webclaw.targets") { const ids = await wcRelayIds(); return (await wcRelayExposed()).map((t) => wcRelayTarget(t, ids)); }
  if (m.method === "webclaw.attach") {
    const tabId = await wcRelayTabOf(m.params.targetId);
    const exposed = await wcRelayExposed();
    const t = exposed.find((x) => x.id === tabId);
    if (!t) throw new Error("target not exposed: " + m.params.targetId);
    if (!(await WcCdp.enabled(tabId, true))) throw new Error("cdp unavailable — cfg.cdp off, debugger permission missing, or the user cancelled the debugging bar");
    const blocked = await spBlock(t);
    if (blocked) throw new Error(blocked.text);
    const gate = await gdCheck({ url: t.url, tabId, mutating: true, what: "[RELAY] attach" });
    if (gate) throw new Error(gate.text);
    await wcRelayRefreshDeny();
    WcCdp.pin(tabId, true);
    wcRelayTabs.add(tabId);
    wcRelayState.tabUrl.set(tabId, t.url || "");
    wcRelaySave();
    await WcCdp.send(tabId, "Runtime.evaluate", { expression: "1" }); // forces attach
    gdRecordAll({ kind: "relay", action: "attach", target: "tab-" + tabId, host: gdHost(t.url), mutating: false, result: "ok" });
    return wcRelayTarget(await chrome.tabs.get(tabId), await wcRelayIds());
  }
  if (m.method === "webclaw.detach") {
    // only sessions the relay itself attached — never unpin someone else's tab
    const tabId = await wcRelayTabOf(m.params.targetId);
    if (!wcRelayTabs.has(tabId)) return {};
    wcRelayTabs.delete(tabId);
    wcRelayState.tabUrl.delete(tabId); wcRelayInputOk.delete(tabId);
    wcRelaySave();
    WcCdp.pin(tabId, false);
    return {};
  }
  if (m.method === "webclaw.create") {
    const cfg = await readCfg();
    const url = m.params.url || "about:blank";
    const gate = await gdCheck({ url, mutating: false });
    if (gate) throw new Error(gate.text);
    const tab = cfg.relayScope === "all" ? await chrome.tabs.create({ url, active: false }) : await spOpen(WC_RELAY_SPACE, url, { fresh: true });
    await waitTabReady(tab.id, 20000);
    return wcRelayTarget(await chrome.tabs.get(tab.id), await wcRelayIds());
  }
  if (m.method === "webclaw.close") {
    // B — only tabs the relay exposes (the human's own tabs stay safe)
    const tabId = await wcRelayTabOf(m.params.targetId);
    const t = (await wcRelayExposed()).find((x) => x.id === tabId);
    if (!t) throw new Error("target not exposed: " + m.params.targetId);
    const blocked = await spBlock(t);
    if (blocked) throw new Error(blocked.text);
    await chrome.tabs.remove(tabId).catch(() => {});
    return { success: true };
  }
  // page / child-session command
  const tabId = Number(m.tabId);
  if (!wcRelayTabs.has(tabId)) throw new Error("tab " + tabId + " is not attached through the relay");
  // cfg.cdp may have been switched off, or the human cancelled the bar
  if (!(await WcCdp.enabled(tabId, true))) throw new Error("cdp unavailable — cfg.cdp off or refused by the user");
  // page-scoped Target.* (child-frame auto-attach) is how clients reach OOPIFs
  // inside *this* tab — allowed; the rest of the raw-[CDP] deny list applies
  if (!WC_RELAY_PAGE_TARGET.has(m.method) && await WcCdp.denied(m.method)) throw new Error("cdp method denied by policy: " + m.method);
  const tab = await chrome.tabs.get(tabId);
  await wcRelayRefreshDeny();
  wcRelayState.tabUrl.set(tabId, tab.url || wcRelayState.tabUrl.get(tabId) || "");
  const refusal = wcRelayCommandRefusal(wcRelayState, tabId, m);
  if (refusal) throw new Error(refusal);
  const blocked = await spBlock(tab);
  if (blocked) throw new Error(blocked.text);
  if (WC_RELAY_RISKY.test(m.method)) {
    // ask mode → first input/eval per site asks (allow-site sticks); code and
    // typed text are scanned for risky words. Under confirmRisky, synthetic
    // input asks once per attachment (a per-mouse-move prompt is unusable).
    const p = m.params || {};
    const isInput = /^Input\./.test(m.method);
    const gate = await gdCheck({ url: tab.url, tabId, mutating: true, what: "[RELAY] " + m.method,
      label: String(p.expression || p.functionDeclaration || p.text || ""), forceRisky: isInput && !wcRelayInputOk.has(tabId) });
    if (gate) throw new Error(gate.text);
    if (isInput) wcRelayInputOk.add(tabId);
  }
  return await WcCdp.send(tabId, m.method, m.params || {}, 60000, m.sessionId || undefined);
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "cdpRelay") return;
    if (wcSenderKind(sender, chrome.runtime.id) !== "ext") { sendResponse({ error: { code: -32000, message: "forbidden sender" } }); return; }
    wcRelayCall(msg).then((result) => sendResponse({ result: result === undefined ? {} : result }),
      (e) => sendResponse({ error: { code: -32000, message: String((e && e.message) || e) } }));
    return true; // async
  });
}

if (typeof module !== "undefined" && module.exports) module.exports = { wcRelayEventAllowed, wcRelayCommandRefusal };
