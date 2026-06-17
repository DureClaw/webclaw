// Holds the persistent bus WebSocket (MV3 service workers idle out; offscreen does not).
let inst = null;
async function start() {
  let { cfg } = await chrome.storage.local.get("cfg");
  if (!cfg || !cfg.bus) {
    // first-run convenience: a local (gitignored) default config auto-connects.
    try { cfg = await (await fetch(chrome.runtime.getURL("config.local.json"))).json(); } catch (e) {}
  }
    if (!cfg || !cfg.bus) return;
  if (inst) inst.disconnect();
  const feed = [];
  inst = createWebclaw(cfg, {
    onLog: (m) => chrome.storage.local.set({ log: m }),
    onStatus: (s) => chrome.storage.local.set({ status: s }),
    dom: (query) => new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "dom", query }, (r) => resolve((r && r.text) || "(no dom)"))),
    onTask: (t) => {
      feed.unshift({ dir: t.dir, name: t.name, text: t.text, at: new Date().toLocaleTimeString() });
      feed.splice(40);
      chrome.storage.local.set({ feed });
    },
  });
}
chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "restart") start(); });
start();
