// Holds the persistent bus WebSocket (MV3 service workers idle out; offscreen does not).
// NOTE: an offscreen document only gets `chrome.runtime` — NOT chrome.storage/tabs.
// So config reads and state writes are proxied through the background service worker.
let inst = null;
let hooks = null, curCfg = null;

// Ask the background SW; reject (with .reason) when it flags { failed:true }.
function ask(msg) {
  return new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (r && r.failed) reject(Object.assign(new Error(r.text || "failed"), { reason: r.reason }));
      else resolve((r && r.text) || "(no result)");
    }));
}

// ===== [RUN] — scripts execute in the sandbox iframe; every helper call comes
// back here as one marker and goes through the same runTask() as a bus task.
const RUN_TIMEOUT_MS = 180000;
const sbx = document.getElementById("sbx");
let sbxReady = new Promise((r) => { window.__sbxResolve = r; });
const runs = new Map(); // runId → { resolve, reject, timer }
let runSeq = 0;

window.addEventListener("message", async (ev) => {
  if (ev.source !== sbx.contentWindow) return;
  const m = ev.data || {};
  if (m.kind === "sandboxReady") { window.__sbxResolve && window.__sbxResolve(); return; }
  if (m.kind === "rpc") {
    let reply;
    try {
      const text = await webclawRunTask(String(m.text || ""), curCfg || {}, hooks || {}, { noBrain: true });
      reply = { kind: "rpcResult", callId: m.callId, ok: true, text: String(text) };
    } catch (e) {
      reply = { kind: "rpcResult", callId: m.callId, ok: false, text: String((e && e.message) || e), reason: e && e.reason };
    }
    sbx.contentWindow.postMessage(reply, "*");
    return;
  }
  if (m.kind === "runDone") {
    const r = runs.get(m.runId);
    if (!r) return;
    runs.delete(m.runId);
    clearTimeout(r.timer);
    r.resolve(m.res);
  }
});

// The sandbox announces itself on load; ping too in case it loaded before this
// listener existed (either message alone is enough to resolve readiness).
try { sbx.contentWindow.postMessage({ kind: "ping" }, "*"); } catch (e) {}

async function runInSandbox(code, o) {
  await sbxReady;
  const runId = "r" + ++runSeq;
  const res = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      runs.delete(runId);
      // a runaway script can't be interrupted — reload the sandbox to kill it
      sbxReady = new Promise((r) => { window.__sbxResolve = r; });
      sbx.src = "sandbox.html?t=" + Date.now();
      resolve({ ok: false, error: "script timeout after " + RUN_TIMEOUT_MS / 1000 + "s", reason: "timeout", log: [] });
    }, RUN_TIMEOUT_MS);
    runs.set(runId, { resolve, timer });
    sbx.contentWindow.postMessage({ kind: "run", runId, code, tab: o.urlMatch || "", args: o.args }, "*");
  });
  if (res.ok) return JSON.stringify({ result: res.result, log: res.log });
  throw Object.assign(new Error(JSON.stringify({ error: res.error, log: res.log })), { reason: res.reason || "script_error" });
}
const feed = []; // shared by onTask and HUD chat so neither overwrites the other
const save = (patch) => { try { chrome.runtime.sendMessage({ type: "state", patch }); } catch (e) {} };
const pushFeed = (e) => { feed.unshift(e); feed.splice(40); save({ feed }); };
async function start() {
  // ask the background SW for config (it owns chrome.storage)
  let cfg = null;
  try { cfg = await chrome.runtime.sendMessage({ type: "getCfg" }); } catch (e) {}
  if (!cfg || !cfg.bus) {
    // first-run convenience: a local (gitignored) default config auto-connects.
    try { cfg = await (await fetch(chrome.runtime.getURL("config.local.json"))).json(); } catch (e) {}
  }
  if (!cfg || !cfg.bus) return;
  if (inst) inst.disconnect();
  curCfg = cfg;
  inst = createWebclaw(cfg, hooks = {
    onLog: (m) => save({ log: m }),
    onStatus: (s) => save({ status: s }),
    onJoined: (info) => save({ activeCfg: info }),
    dom: (query, urlMatch) => ask({ type: "dom", query, urlMatch }),
    tabs: () => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "tabs" }, (r) => resolve((r && r.text) || "(no tabs)"))),
    // #14 — background.js flags well-known failures (unmatched selector,
    // value mismatch) with { failed:true, reason }. Reject instead of
    // resolving so core.js's handle() elevates them to status:"failed" +
    // exit_code 1, carrying `reason` through on the Error object.
    act: (payload) => new Promise((resolve, reject) =>
      chrome.runtime.sendMessage(Object.assign({ type: "act" }, payload), (r) => {
        if (r && r.failed) reject(Object.assign(new Error((r && r.text) || "act failed"), { reason: r.reason }));
        else resolve((r && r.text) || "(no result)");
      })),
    fetch: (url) => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "fetch", url }, (r) => resolve((r && r.text) || "(no result)"))),
    download: (url, path) => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "download", url, path }, (r) => resolve((r && r.text) || "(no result)"))),
    downloadStatus: (id) => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "download", url: id, statusOnly: true }, (r) => resolve((r && r.text) || "(no result)"))),
    downloadCancel: (id) => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "download", url: id, cancel: true }, (r) => resolve((r && r.text) || "(no result)"))),
    domEx: (p) => ask(Object.assign({ type: "dom" }, p)),
    open: (url, urlMatch) => ask({ type: "open", url, urlMatch }),
    // v0.7.0 — scripts, spaces, learnings
    run: (code, o) => runInSandbox(code, o || {}),
    space: (p) => ask(Object.assign({ type: "space" }, p)),
    learn: (p) => ask(Object.assign({ type: "learn" }, p)),
    learnContext: () => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "learnContext" }, (r) => resolve((r && !r.failed && r.text) || ""))),
    onTask: (t) => pushFeed({ dir: t.dir, name: t.name, text: t.text, at: new Date().toLocaleTimeString() }),
  });
}
chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "restart") start(); });
// #11 — HUD chat from the page → publish into this node's bus inbox slot,
// and mirror it into the popup feed.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "busInbox" || !inst || !inst.publishInbox) return;
  inst.publishInbox(msg.text, { url: msg.url });
  pushFeed({ dir: "out", name: "🧑 HUD", text: msg.text, at: new Date().toLocaleTimeString() });
});
start();
