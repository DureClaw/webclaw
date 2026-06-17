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

// [DOM] hands — read the active tab's DOM on request from the offscreen node.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "dom") return;
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
    if (!tab) { sendResponse({ text: "(no active tab)" }); return; }
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (q) => {
        try {
          if (!q) return (document.title + " | " + location.href + "\n" + document.body.innerText).slice(0, 1500);
          const els = [...document.querySelectorAll(q)];
          if (!els.length) return "(no match for: " + q + ")";
          return els.map((e) => (e.innerText || e.textContent || "").trim()).join("\n").slice(0, 1500);
        } catch (e) { return "DOM error: " + e; }
      },
      args: [msg.query || ""],
    }).then((res) => sendResponse({ text: res && res[0] ? res[0].result : "(no result)" }))
      .catch((e) => sendResponse({ text: "scripting error: " + e }));
  });
  return true; // async
});
