// CDP endpoint on the mini-bus (v0.9.0): makes a webclaw node look like a
// Chrome DevTools browser endpoint, so unmodified CDP clients work:
//   puppeteer.connect({ browserURL: "http://127.0.0.1:4777/cdp/<secret>" })
//   chromium.connectOverCDP("http://127.0.0.1:4777/cdp/<secret>")
// Browser-level domains (Browser.*, Target.*) are emulated here; page-session
// commands go to the node ("cdp.call" → chrome.debugger) and its events come
// back ("cdp.event"). Targets are the node's exposed tabs (agent Space "cdp"
// by default). Browser contexts can't be created — this is the user's real
// profile — so clients must use the default context.
"use strict";

let seq = 0;

function createCdpEndpoint({ sendToNode, log }) {
  const calls = new Map(); // id → { resolve, reject, t }
  const clients = new Set();

  function nodeCall(node, method, params, tabId, sessionId) {
    const id = "c" + ++seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { calls.delete(id); reject(new Error("node did not answer " + method + " within 60s")); }, 60000);
      calls.set(id, { resolve, reject, t });
      if (!sendToNode(node, "cdp.call", { to: node, id, method, params: params || {}, tabId, sessionId })) {
        clearTimeout(t); calls.delete(id); reject(new Error("node " + node + " is not connected"));
      }
    });
  }

  // node → endpoint
  function onNodeFrame(node, event, p) {
    if (event === "cdp.reply") {
      const c = calls.get(p.id);
      if (!c) return;
      calls.delete(p.id); clearTimeout(c.t);
      if (p.error) c.reject(Object.assign(new Error(p.error.message || "cdp error"), { code: p.error.code }));
      else c.resolve(p.result);
      return;
    }
    if (event === "cdp.event") for (const cl of clients) if (cl.node === node) cl.onNodeEvent(p);
  }

  function attachClient(conn, node) {
    const sessions = new Map(); // sessionId → tabId (page sessions we created)
    const children = new Map(); // chrome child sessionId → tabId
    const tabSession = new Map(); // tabId → sessionId
    let autoAttach = false, discover = false;
    const cl = { node, onNodeEvent: null };
    clients.add(cl);

    const send = (obj) => conn.send(JSON.stringify(obj));
    const targetOfTab = new Map(); // tabId → real CDP target id (learned from node target infos)
    const learn = (t) => { if (t && t.webclawTabId != null) targetOfTab.set(Number(t.webclawTabId), t.targetId); return t; };
    const tabOfTarget = (targetId) => { for (const [tab, tid] of targetOfTab) if (tid === targetId) return tab; return NaN; };
    // strip our routing field before handing infos to the client
    const info = (t) => { learn(t); const { webclawTabId, ...rest } = t; return Object.assign(rest, { attached: tabSession.has(Number(webclawTabId)) }); };
    const targets = async () => (await nodeCall(node, "webclaw.targets")).map(learn);

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
      const sessionId = "S" + tabId + "-" + Math.random().toString(36).slice(2, 8);
      sessions.set(sessionId, tabId);
      tabSession.set(tabId, sessionId);
      send({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: Object.assign(info(t), { attached: true }), waitingForDebugger: false } });
      return sessionId;
    }
    function detached(tabId, destroyed) {
      const sessionId = tabSession.get(tabId);
      if (sessionId) {
        sessions.delete(sessionId); tabSession.delete(tabId);
        send({ method: "Target.detachedFromTarget", params: { sessionId, targetId: targetOfTab.get(tabId) || "tab-" + tabId } });
      }
      if (destroyed && discover) send({ method: "Target.targetDestroyed", params: { targetId: targetOfTab.get(tabId) || "tab-" + tabId } });
    }

    cl.onNodeEvent = (p) => {
      const tabId = Number(p.tabId);
      if (p.method === "webclaw.detached") return detached(tabId, false);
      if (p.method === "webclaw.targetDestroyed") return detached(tabId, true);
      const page = tabSession.get(tabId);
      if (!page) return;
      if (p.method === "Target.attachedToTarget" && p.params && p.params.sessionId) children.set(p.params.sessionId, tabId);
      if (p.method === "Target.detachedFromTarget" && p.params && p.params.sessionId) children.delete(p.params.sessionId);
      send({ method: p.method, params: p.params || {}, sessionId: p.sessionId || page });
    };

    async function browserLevel(m) {
      const P = m.params || {};
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
            for (const t of await targets().catch(() => [])) send({ method: "Target.targetCreated", params: { targetInfo: info(t) } });
          });
          return {};
        }
        case "Target.setAutoAttach": {
          autoAttach = !!P.autoAttach;
          if (autoAttach) setImmediate(async () => {
            for (const t of await targets().catch(() => [])) await attach(t).catch((e) => log("auto-attach failed: " + e.message));
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
          if (tabId != null) { await nodeCall(node, "webclaw.detach", { targetId: targetOfTab.get(tabId) || "tab-" + tabId }).catch(() => {}); detached(tabId, false); }
          return {};
        }
        case "Target.createTarget": {
          const t = learn(await nodeCall(node, "webclaw.create", { url: P.url || "about:blank" }));
          if (discover) send({ method: "Target.targetCreated", params: { targetInfo: info(t) } });
          if (autoAttach) await attach(t);
          return { targetId: t.targetId };
        }
        case "Target.closeTarget": {
          const tabId = tabOfTarget(P.targetId);
          await nodeCall(node, "webclaw.close", { targetId: P.targetId });
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
      const reply = (result) => send(m.sessionId ? { id: m.id, sessionId: m.sessionId, result } : { id: m.id, result });
      const fail = (e) => send(Object.assign({ id: m.id, error: { code: e.code || -32000, message: e.message } }, m.sessionId ? { sessionId: m.sessionId } : {}));
      try {
        if (!m.sessionId) return reply(await browserLevel(m));
        const tabId = sessions.has(m.sessionId) ? sessions.get(m.sessionId) : children.get(m.sessionId);
        if (tabId == null) throw Object.assign(new Error("Session with given id not found."), { code: -32001 });
        const child = sessions.has(m.sessionId) ? undefined : m.sessionId;
        reply(await nodeCall(node, m.method, m.params, tabId, child));
      } catch (e) { fail(e); }
    };
    conn.onclose = () => {
      clients.delete(cl);
      for (const tabId of tabSession.keys()) nodeCall(node, "webclaw.detach", { targetId: targetOfTab.get(tabId) || "tab-" + tabId }).catch(() => {});
      log("cdp client left (" + node + ")");
    };
  }

  return { attachClient, onNodeFrame };
}

module.exports = { createCdpEndpoint };
