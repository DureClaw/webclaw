// Holds the persistent bus WebSocket (MV3 service workers idle out; offscreen does not).
let inst = null;
async function start() {
  const { cfg } = await chrome.storage.local.get("cfg");
  if (!cfg || !cfg.bus) return;
  if (inst) inst.disconnect();
  const feed = [];
  inst = createWebclaw(cfg, {
    onLog: (m) => chrome.storage.local.set({ log: m }),
    onStatus: (s) => chrome.storage.local.set({ status: s }),
    onTask: (t) => {
      feed.unshift({ dir: t.dir, name: t.name, text: t.text, at: new Date().toLocaleTimeString() });
      feed.splice(40);
      chrome.storage.local.set({ feed });
    },
  });
}
chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === "restart") start(); });
start();
