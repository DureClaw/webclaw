// Holds the persistent bus WebSocket (MV3 service workers idle out; offscreen does not).
// NOTE: an offscreen document only gets `chrome.runtime` — NOT chrome.storage/tabs.
// So config reads and state writes are proxied through the background service worker.
let inst = null;
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
  inst = createWebclaw(cfg, {
    onLog: (m) => save({ log: m }),
    onStatus: (s) => save({ status: s }),
    onJoined: (info) => save({ activeCfg: info }),
    dom: (query, urlMatch) => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "dom", query, urlMatch }, (r) => resolve((r && r.text) || "(no dom)"))),
    tabs: () => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "tabs" }, (r) => resolve((r && r.text) || "(no tabs)"))),
    act: (payload) => new Promise((resolve) =>
      chrome.runtime.sendMessage(Object.assign({ type: "act" }, payload), (r) => resolve((r && r.text) || "(no result)"))),
    download: (url, path) => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "download", url, path }, (r) => resolve((r && r.text) || "(no result)"))),
    downloadStatus: (id) => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "download", url: id, statusOnly: true }, (r) => resolve((r && r.text) || "(no result)"))),
    downloadCancel: (id) => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "download", url: id, cancel: true }, (r) => resolve((r && r.text) || "(no result)"))),
    domEx: (p) => new Promise((resolve) =>
      chrome.runtime.sendMessage(Object.assign({ type: "dom" }, p), (r) => resolve((r && r.text) || "(no result)"))),
    open: (url) => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "open", url }, (r) => resolve((r && r.text) || "(no result)"))),
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
