// Holds the persistent bus WebSocket (MV3 service workers idle out; offscreen does not).
// NOTE: an offscreen document only gets `chrome.runtime` — NOT chrome.storage/tabs.
// So config reads and state writes are proxied through the background service worker.
let inst = null;
const save = (patch) => { try { chrome.runtime.sendMessage({ type: "state", patch }); } catch (e) {} };
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
  const feed = [];
  inst = createWebclaw(cfg, {
    onLog: (m) => save({ log: m }),
    onStatus: (s) => save({ status: s }),
    dom: (query, urlMatch) => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "dom", query, urlMatch }, (r) => resolve((r && r.text) || "(no dom)"))),
    tabs: () => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "tabs" }, (r) => resolve((r && r.text) || "(no tabs)"))),
    act: (payload) => new Promise((resolve) =>
      chrome.runtime.sendMessage(Object.assign({ type: "act" }, payload), (r) => resolve((r && r.text) || "(no result)"))),
    download: (url) => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "download", url }, (r) => resolve((r && r.text) || "(no result)"))),
    onTask: (t) => {
      feed.unshift({ dir: t.dir, name: t.name, text: t.text, at: new Date().toLocaleTimeString() });
      feed.splice(40);
      save({ feed });
    },
  });
}
chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "restart") start(); });
start();
