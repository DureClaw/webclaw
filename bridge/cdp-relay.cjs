// CDP endpoint on the mini-bus (v0.9.0): makes a webclaw node look like a
// Chrome DevTools browser endpoint, so unmodified CDP clients work:
//   puppeteer.connect({ browserURL: "http://127.0.0.1:4777/cdp/<cdp-token>" })
//   chromium.connectOverCDP("http://127.0.0.1:4777/cdp/<cdp-token>")
// (<cdp-token> = `webclaw cdp-url`, derived from the secret — never the secret)
// Browser-level domains (Browser.*, Target.*) are emulated here; page-session
// commands go to the node ("cdp.call" → chrome.debugger) and its events come
// back ("cdp.event"). Targets are the node's exposed tabs (agent Space "cdp"
// by default). Browser contexts can't be created — this is the user's real
// profile — so clients must use the default context.
//
// Several clients may share a tab: attachments are reference-counted per
// (node, tab) and webclaw.detach goes to the node only when the last client
// releases it. A client that leaves while an attach is in flight releases
// that attach as soon as it completes.
"use strict";

let seq = 0;
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

function createCdpEndpoint({ sendToNode, log }) {
  const calls = new Map(); // id → { resolve, reject, t, node }
  const clients = new Set();
  const refs = new Map(); // node + "\0" + tabId → number of clients attached

  function nodeCall(node, method, params, tabId, sessionId) {
    const id = "c" + ++seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { calls.delete(id); reject(new Error("node did not answer " + method + " within 60s")); }, 60000);
      if (t.unref) t.unref(); // a pending call must not keep the process alive
      calls.set(id, { resolve, reject, t, node });
      let sent = false;
      try { sent = sendToNode(node, "cdp.call", { to: node, id, method, params: params || {}, tabId, sessionId }); } catch (e) {}
      if (!sent) { clearTimeout(t); calls.delete(id); reject(new Error("node " + node + " is not connected")); }
    });
  }

  const refKey = (node, tabId) => node + "\0" + tabId;
  function acquire(node, tabId) { const k = refKey(node, tabId); refs.set(k, (refs.get(k) || 0) + 1); }
  // → true when this was the last holder (the caller then detaches on the node)
  function release(node, tabId) {
    const k = refKey(node, tabId);
    const n = (refs.get(k) || 0) - 1;
    if (n > 0) { refs.set(k, n); return false; }
    const had = refs.has(k);
    refs.delete(k);
    return had;
  }
  const nodeDetach = (node, targetId) => nodeCall(node, "webclaw.detach", { targetId }).catch(() => {});

  // node → endpoint
  function onNodeFrame(node, event, p) {
    if (!isObj(p)) return;
    if (event === "cdp.reply") {
      const c = calls.get(p.id);
      if (!c) return;
      calls.delete(p.id); clearTimeout(c.t);
      if (p.error) c.reject(Object.assign(new Error((p.error && p.error.message) || "cdp error"), { code: p.error && p.error.code }));
      else c.resolve(p.result);
      return;
    }
    if (event === "cdp.event") {
      // the node lost the tab for everyone — nobody holds it any more
      if (p.method === "webclaw.detached" || p.method === "webclaw.targetDestroyed") refs.delete(refKey(node, Number(p.tabId)));
      for (const cl of clients) if (cl.node === node) { try { cl.onNodeEvent(p); } catch (e) { log("cdp event error: " + e.message); } }
    }
  }

  // a node left the bus: fail its in-flight calls now instead of in 60 s
  function nodeGone(node) {
    for (const [id, c] of calls) if (c.node === node) { calls.delete(id); clearTimeout(c.t); c.reject(new Error("node " + node + " disconnected")); }
    for (const k of [...refs.keys()]) if (k.startsWith(node + "\0")) refs.delete(k);
  }

  function attachClient(conn, node) {
    const sessions = new Map(); // sessionId → tabId (page sessions we created)
    const children = new Map(); // chrome child sessionId → tabId
    const tabSession = new Map(); // tabId → sessionId
    let autoAttach = false, discover = false;
    const cl = { node, onNodeEvent: null, gone: false };
    clients.add(cl);

    const send = (obj) => { if (!cl.gone) conn.send(JSON.stringify(obj)); };
    const targetOfTab = new Map(); // tabId → real CDP target id (learned from node target infos)
    const learn = (t) => { if (isObj(t) && t.webclawTabId != null) targetOfTab.set(Number(t.webclawTabId), t.targetId); return t; };
    const tabOfTarget = (targetId) => { for (const [tab, tid] of targetOfTab) if (tid === targetId) return tab; return NaN; };
    const targetIdOf = (tabId) => targetOfTab.get(tabId) || "tab-" + tabId;
    // strip our routing field before handing infos to the client
    const info = (t) => { learn(t); const { webclawTabId, ...rest } = t; return Object.assign(rest, { attached: tabSession.has(Number(webclawTabId)) }); };
    const targets = async () => {
      const r = await nodeCall(node, "webclaw.targets");
      return (Array.isArray(r) ? r : []).filter(isObj).map(learn);
    };

    const attaching = new Map(); // tabId → Promise<sessionId> (auto-attach and createTarget can race)
    function attach(target) {
      learn(target);
      const tabId = Number(target.webclawTabId != null ? target.webclawTabId : tabOfTarget(target.targetId));
      if (tabSession.has(tabId)) return Promise.resolve(tabSession.get(tabId));
      if (!attaching.has(tabId)) attaching.set(tabId, doAttach(target, tabId).finally(() => attaching.delete(tabId)));
      return attaching.get(tabId);
    }
    async function doAttach(target, tabId) {
      const t = learn(await nodeCall(node, "webclaw.attach", { targetId: target.targetId }));
      acquire(node, tabId);
      if (cl.gone) { // client left while we were attaching — give the tab back
        if (release(node, tabId)) await nodeDetach(node, targetIdOf(tabId));
        throw new Error("client disconnected");
      }
      const sessionId = "S" + tabId + "-" + Math.random().toString(36).slice(2, 8);
      sessions.set(sessionId, tabId);
      tabSession.set(tabId, sessionId);
      send({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: Object.assign(info(isObj(t) ? t : { targetId: target.targetId }), { attached: true }), waitingForDebugger: false } });
      return sessionId;
    }
    // drop this client's session for a tab (node detach is the caller's call)
    function detached(tabId, destroyed) {
      const sessionId = tabSession.get(tabId);
      if (sessionId) {
        sessions.delete(sessionId); tabSession.delete(tabId);
        for (const [cs, t] of children) if (t === tabId) children.delete(cs);
        send({ method: "Target.detachedFromTarget", params: { sessionId, targetId: targetIdOf(tabId) } });
      }
      if (destroyed && discover) send({ method: "Target.targetDestroyed", params: { targetId: targetIdOf(tabId) } });
    }
    // client-initiated release of one tab: node detach only for the last holder
    async function releaseTab(tabId) {
      if (!tabSession.has(tabId)) return;
      if (release(node, tabId)) await nodeDetach(node, targetIdOf(tabId));
      detached(tabId, false);
    }

    cl.onNodeEvent = (p) => {
      const tabId = Number(p.tabId);
      if (p.method === "webclaw.detached") return detached(tabId, false);
      if (p.method === "webclaw.targetDestroyed") return detached(tabId, true);
      const page = tabSession.get(tabId);
      if (!page) return;
      if (p.method === "Target.attachedToTarget" && isObj(p.params) && p.params.sessionId) children.set(p.params.sessionId, tabId);
      if (p.method === "Target.detachedFromTarget" && isObj(p.params) && p.params.sessionId) children.delete(p.params.sessionId);
      send({ method: p.method, params: p.params || {}, sessionId: p.sessionId || page });
    };

    async function browserLevel(m) {
      const P = isObj(m.params) ? m.params : {};
      switch (m.method) {
        case "Browser.getVersion":
          return { protocolVersion: "1.3", product: "Chrome/webclaw-relay", revision: "0", userAgent: "webclaw-relay", jsVersion: "0" };
        case "Browser.close": return {}; // never close the human's browser
        case "Target.getBrowserContexts": return { browserContextIds: [] };
        case "Target.createBrowserContext":
          throw Object.assign(new Error("webclaw relay drives the user's real profile — new browser contexts are not supported; use the default context"), { code: -32000 });
        case "Target.getTargets":
          return { targetInfos: (await targets()).map(info) };
        case "Target.getTargetInfo": {
          if (!P.targetId) return { targetInfo: { targetId: "browser", type: "browser", title: "", url: "", attached: true, canAccessOpener: false } };
          const t = (await targets()).find((x) => x.targetId === P.targetId);
          if (!t) throw Object.assign(new Error("No target with given id found"), { code: -32602 });
          return { targetInfo: info(t) };
        }
        case "Target.setDiscoverTargets": {
          discover = !!P.discover;
          if (discover) setImmediate(async () => {
            try { for (const t of await targets().catch(() => [])) send({ method: "Target.targetCreated", params: { targetInfo: info(t) } }); }
            catch (e) { log("discover failed: " + e.message); }
          });
          return {};
        }
        case "Target.setAutoAttach": {
          autoAttach = !!P.autoAttach;
          if (autoAttach) setImmediate(async () => {
            try { for (const t of await targets().catch(() => [])) { if (cl.gone) break; await attach(t).catch((e) => log("auto-attach failed: " + e.message)); } }
            catch (e) { log("auto-attach failed: " + e.message); }
          });
          return {};
        }
        case "Target.attachToTarget": {
          const t = (await targets()).find((x) => x.targetId === P.targetId);
          if (!t) throw Object.assign(new Error("No target with given id found"), { code: -32602 });
          return { sessionId: await attach(t) };
        }
        case "Target.detachFromTarget": {
          const tabId = sessions.get(P.sessionId);
          if (tabId != null) await releaseTab(tabId);
          return {};
        }
        case "Target.createTarget": {
          const t = learn(await nodeCall(node, "webclaw.create", { url: P.url || "about:blank" }));
          if (!isObj(t)) throw Object.assign(new Error("node returned no target"), { code: -32000 });
          if (discover) send({ method: "Target.targetCreated", params: { targetInfo: info(t) } });
          if (autoAttach) await attach(t);
          return { targetId: t.targetId };
        }
        case "Target.closeTarget": {
          const tabId = tabOfTarget(P.targetId);
          await nodeCall(node, "webclaw.close", { targetId: P.targetId });
          if (tabSession.has(tabId)) release(node, tabId);
          detached(tabId, true);
          return { success: true };
        }
        default:
          return {}; // Browser.setDownloadBehavior, grantPermissions, Target.activateTarget… — accepted as no-ops
      }
    }

    conn.onmessage = async (text) => {
      let m;
      try { m = JSON.parse(text); } catch (e) { return; }
      if (!isObj(m)) return; // null / numbers / arrays: not a CDP command
      const tag = (obj) => Object.assign(obj, typeof m.sessionId === "string" ? { sessionId: m.sessionId } : {});
      const reply = (result) => send(tag({ id: m.id, result: result === undefined ? {} : result }));
      const fail = (e) => send(tag({ id: m.id, error: { code: (e && typeof e.code === "number") ? e.code : -32000, message: String((e && e.message) || e || "error") } }));
      try {
        if (typeof m.method !== "string") throw Object.assign(new Error("method must be a string"), { code: -32600 });
        if (!m.sessionId) return reply(await browserLevel(m));
        const tabId = sessions.has(m.sessionId) ? sessions.get(m.sessionId) : children.get(m.sessionId);
        if (tabId == null) throw Object.assign(new Error("Session with given id not found."), { code: -32001 });
        const child = sessions.has(m.sessionId) ? undefined : m.sessionId;
        reply(await nodeCall(node, m.method, m.params, tabId, child));
      } catch (e) { try { fail(e); } catch (e2) {} }
    };
    conn.onclose = () => {
      if (cl.gone) return;
      cl.gone = true;
      clients.delete(cl);
      for (const tabId of tabSession.keys()) if (release(node, tabId)) nodeDetach(node, targetIdOf(tabId));
      sessions.clear(); children.clear(); tabSession.clear(); // targetOfTab stays: in-flight attaches still need the ids
      log("cdp client left (" + node + ")");
    };
  }

  return { attachClient, onNodeFrame, nodeGone, _refs: refs };
}

module.exports = { createCdpEndpoint };
