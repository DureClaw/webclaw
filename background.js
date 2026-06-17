async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "Maintain a persistent WebSocket connection to the DureClaw bus.",
  });
}
chrome.runtime.onInstalled.addListener(ensureOffscreen);
chrome.runtime.onStartup.addListener(ensureOffscreen);
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg && msg.type === "connect") {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ type: "restart" }).catch(() => {}))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});
