// webclaw background service worker — owns chrome.storage/tabs/scripting and the
// offscreen document that holds the persistent bus WebSocket.

const CAP = 2000000; // raised for large grading pages (2MB)
                    // task.result frame is fine (screenshots already send ~262KB).

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Maintain a persistent WebSocket connection to the DureClaw bus.",
  });
}
ensureOffscreen(); // run on SW load
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

// Stable per-install id so two Chrome profiles running webclaw show up as
// distinct nodes (webclaw@chrome-ab12) instead of colliding on one name and
// both answering the same task.
async function instanceId() {
  let { instanceId } = await chrome.storage.local.get("instanceId");
  if (!instanceId) {
    instanceId = Math.random().toString(36).slice(2, 6);
    await chrome.storage.local.set({ instanceId });
  }
  return instanceId;
}

// Config provider — the offscreen node can't read chrome.storage, so it asks here.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "getCfg") return;
  chrome.storage.local.get("cfg").then(async ({ cfg }) => {
    if (!cfg || !cfg.bus) {
      try { cfg = await (await fetch(chrome.runtime.getURL("config.local.json"))).json(); } catch (e) {}
    }
    if (cfg && cfg.bus) {
      const id = await instanceId();
      if (cfg.name && !cfg.name.endsWith("-" + id)) cfg.name = cfg.name + "-" + id;
    }
    sendResponse(cfg && cfg.bus ? cfg : null);
  });
  return true; // async
});

// State sink — the offscreen node can't write chrome.storage, so it routes here (for the popup).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "state" && msg.patch) chrome.storage.local.set(msg.patch);
});

// Pick the target tab: a URL-substring match (to hit a specific logged-in
// session across many tabs), else the active tab of the last focused window.
async function pickTab(urlMatch) {
  if (urlMatch) {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => (t.url || "").includes(urlMatch));
    if (hit) return hit;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return active || null;
}

// [TABS] — list open tabs so the master can see which one holds the logged-in
// session and target it with @<url-substring>.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "tabs") return;
  chrome.tabs.query({}).then((tabs) => {
    const list = tabs
      .map((t) => `${t.active ? "*" : " "} [${t.windowId}] ${t.title || ""} — ${t.url || ""}`)
      .join("\n");
    sendResponse({ text: list.slice(0, CAP) || "(no tabs)" });
  });
  return true; // async
});

// [DOM] hands — read the target tab's DOM (raised cap).
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "dom") return;
  pickTab(msg.urlMatch).then((tab) => {
    if (!tab) { sendResponse({ text: "(no target tab)" }); return; }
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (q, cap) => {
        try {
          if (!q) return (document.title + " | " + location.href + "\n" + document.body.innerText).slice(0, cap);
          const els = [...document.querySelectorAll(q)];
          if (!els.length) return "(no match for: " + q + ")";
          return els.map((e) => (e.innerText || e.textContent || "").trim()).join("\n").slice(0, cap);
        } catch (e) { return "DOM error: " + e; }
      },
      args: [msg.query || "", CAP],
    }).then((res) => sendResponse({ text: res && res[0] ? res[0].result : "(no result)" }))
      .catch((e) => sendResponse({ text: "scripting error: " + e }));
  });
  return true; // async
});

// [DOWNLOAD] <url> — trigger a real browser download (session cookies included,
// saved to disk) — unlike page fetch() which only returns bytes to JS. Ideal for
// bulk file/zip downloads (e.g. Moodle action=downloadall).
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "download") return;
  try {
    const opts = { url: msg.url, conflictAction: "uniquify" };
    // Optional target sub-path under Downloads (sanitized) — keeps same-named
    // files from different students apart.
    if (msg.path) opts.filename = String(msg.path).replace(/\.\.(\/|\\)/g, "").replace(/^[/\\]+/, "");
    chrome.downloads.download(opts, (id) => {
      if (chrome.runtime.lastError) sendResponse({ text: "download error: " + chrome.runtime.lastError.message });
      else sendResponse({ text: "download started (id=" + id + ") → " + (opts.filename || msg.url) });
    });
  } catch (e) { sendResponse({ text: "download error: " + e }); }
  return true; // async
});

// [CLICK]/[FILL]/[TYPE]/[SUBMIT]/[JS] — act on the target tab (real interaction).
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "act") return;
  pickTab(msg.urlMatch).then((tab) => {
    if (!tab) { sendResponse({ text: "(no target tab)" }); return; }
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (action, selector, value, code, cap) => {
        const q = (s) => document.querySelector(s);
        try {
          if (action === "click") {
            const el = q(selector);
            if (!el) return "(no match: " + selector + ")";
            el.click();
            return "clicked " + selector;
          }
          if (action === "fill" || action === "type") {
            const el = q(selector);
            if (!el) return "(no match: " + selector + ")";
            el.focus();
            const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
            const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value");
            if (setter && setter.set) { setter.set.call(el, value); } else { el.value = value; }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return "filled " + selector + " = " + value;
          }
          if (action === "submit") {
            const el = q(selector);
            if (!el) return "(no match: " + selector + ")";
            if (el.tagName === "FORM") el.submit();
            else if (el.form) el.form.submit();
            else el.click();
            return "submitted " + selector;
          }
          if (action === "js") {
            // eslint-disable-next-line no-eval
            const r = eval(code);
            const s = typeof r === "object" ? JSON.stringify(r) : String(r);
            return s.slice(0, cap);
          }
          return "(unknown action: " + action + ")";
        } catch (e) { return action + " error: " + e; }
      },
      args: [msg.action, msg.selector || "", msg.value || "", msg.code || "", CAP],
    }).then((res) => sendResponse({ text: res && res[0] ? String(res[0].result) : "(no result)" }))
      .catch((e) => sendResponse({ text: "act error: " + e }));
  });
  return true; // async
});
