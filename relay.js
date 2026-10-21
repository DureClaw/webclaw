// webclaw CDP relay — background side (v0.9.0). Loaded via importScripts().
//
// Lets an unmodified CDP client (Puppeteer `connect`, Playwright
// `connectOverCDP`, Stagehand, browser-use…) drive tabs of the user's real
// Chrome through chrome.debugger. The bridge's mini-bus emulates the
// browser-level Target/Browser domains and forwards page-session traffic here
// ("cdp.call" over the bus → offscreen → this file); events flow back the
// same way ("cdp.event"). Exposed tabs = the agent Space "cdp" by default
// (cfg.relayScope = "all" exposes every tab) so a connecting client does not
// grab the human's own tabs. Raw-[CDP] deny list and the policy deny list
// apply to every relayed command.

const wcRelayTabs = new Set();
const WC_RELAY_SPACE = "cdp";
const WC_RELAY_PAGE_TARGET = new Set(["Target.setAutoAttach", "Target.detachFromTarget", "Target.getTargetInfo"]);

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
  await spEnsure(WC_RELAY_SPACE);
  const { spaces } = await spLoad();
  return chrome.tabs.query({ groupId: spaces[WC_RELAY_SPACE].groupId });
}

function wcRelayEvent(payload) { chrome.runtime.sendMessage(Object.assign({ type: "cdpEvent" }, payload)).catch(() => {}); }

function wcRelayDetached(tabId, reason) {
  if (!wcRelayTabs.delete(tabId)) return;
  wcRelayEvent({ tabId, method: "webclaw.detached", params: { reason } });
}

if (typeof chrome !== "undefined" && chrome.debugger) {
  chrome.debugger.onEvent.addListener((src, method, params) => {
    if (src.tabId == null || !wcRelayTabs.has(src.tabId)) return;
    wcRelayEvent({ tabId: src.tabId, sessionId: src.sessionId, method, params });
  });
}
chrome.tabs.onRemoved.addListener((tabId) => {
  if (wcRelayTabs.delete(tabId)) wcRelayEvent({ tabId, method: "webclaw.targetDestroyed", params: {} });
});

async function wcRelayCall(m) {
  if (m.method === "webclaw.targets") { const ids = await wcRelayIds(); return (await wcRelayExposed()).map((t) => wcRelayTarget(t, ids)); }
  if (m.method === "webclaw.attach") {
    const tabId = await wcRelayTabOf(m.params.targetId);
    const exposed = await wcRelayExposed();
    const t = exposed.find((x) => x.id === tabId);
    if (!t) throw new Error("target not exposed: " + m.params.targetId);
    const gate = await gdCheck({ url: t.url, mutating: false });
    if (gate) throw new Error(gate.text);
    WcCdp.pin(tabId, true);
    wcRelayTabs.add(tabId);
    await WcCdp.send(tabId, "Runtime.evaluate", { expression: "1" }); // forces attach
    gdRecordAll({ kind: "relay", action: "attach", target: "tab-" + tabId, host: gdHost(t.url), mutating: false, result: "ok" });
    return wcRelayTarget(await chrome.tabs.get(tabId), await wcRelayIds());
  }
  if (m.method === "webclaw.detach") {
    const tabId = await wcRelayTabOf(m.params.targetId);
    wcRelayTabs.delete(tabId);
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
    await chrome.tabs.remove(await wcRelayTabOf(m.params.targetId)).catch(() => {});
    return { success: true };
  }
  // page / child-session command
  const tabId = Number(m.tabId);
  if (!wcRelayTabs.has(tabId)) throw new Error("tab " + tabId + " is not attached through the relay");
  // page-scoped Target.* (child-frame auto-attach) is how clients reach OOPIFs
  // inside *this* tab — allowed; the rest of the raw-[CDP] deny list applies
  if (!WC_RELAY_PAGE_TARGET.has(m.method) && await WcCdp.denied(m.method)) throw new Error("cdp method denied by policy: " + m.method);
  const tab = await chrome.tabs.get(tabId);
  if (gdMatch(gdHost(tab.url), (await gdPolicy()).deny)) throw new Error("policy: " + gdHost(tab.url) + " is on the deny list");
  return await WcCdp.send(tabId, m.method, m.params || {}, 60000, m.sessionId || undefined);
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "cdpRelay") return;
  wcRelayCall(msg).then((result) => sendResponse({ result: result === undefined ? {} : result }),
    (e) => sendResponse({ error: { code: -32000, message: String((e && e.message) || e) } }));
  return true; // async
});
