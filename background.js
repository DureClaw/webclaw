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

// #4 — navigation-triggering actions race with tab state: if the target tab is
// still loading (e.g. a previous CLICK/SUBMIT navigated it), wait for the new
// document to finish before injecting, so follow-up DOM/JS reads see the real
// page rather than a half-loaded one.
function waitTabReady(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(onUpd); resolve(); } };
    const onUpd = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError || !t || t.status === "complete") return finish();
      chrome.tabs.onUpdated.addListener(onUpd);
      setTimeout(finish, timeoutMs);
    });
  });
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

// [DOM] hands — read the target tab's DOM (raised cap, waits out navigation).
// mode "links" → [{text, href}] for anchors; mode "attr" → attribute values. (#8)
// Over-cap output gets an explicit truncated trailer instead of a silent cut. (#9)
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "dom") return;
  pickTab(msg.urlMatch).then(async (tab) => {
    if (!tab) { sendResponse({ text: "(no target tab)" }); return; }
    await waitTabReady(tab.id); // #4
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (q, cap, mode, attr) => {
        const capped = (s) => (s.length > cap ? s.slice(0, cap) + "\n…[truncated, " + (s.length - cap) + " more bytes]" : s);
        try {
          if (mode === "links") {
            const els = [...document.querySelectorAll(q || "a[href]")];
            return capped(JSON.stringify(els.map((a) => ({ text: (a.innerText || "").trim().slice(0, 200), href: a.href }))));
          }
          if (mode === "attr") {
            const els = [...document.querySelectorAll(q)];
            if (!els.length) return "(no match for: " + q + ")";
            return capped(JSON.stringify(els.map((e) => e.getAttribute(attr))));
          }
          if (!q) return capped(document.title + " | " + location.href + "\n" + document.body.innerText);
          const els = [...document.querySelectorAll(q)];
          if (!els.length) return "(no match for: " + q + ")";
          return capped(els.map((e) => (e.innerText || e.textContent || "").trim()).join("\n"));
        } catch (e) { return "DOM error: " + e; }
      },
      args: [msg.query || "", CAP, msg.mode || "", msg.attr || ""],
    }).then((res) => sendResponse({ text: res && res[0] ? res[0].result : "(no result)" }))
      .catch((e) => sendResponse({ text: "scripting error: " + e }));
  });
  return true; // async
});

// [DOWNLOAD] <url> — trigger a real browser download (session cookies included,
// saved to disk). #2 — resolve on *completion*, not start: wait for the download
// to finish (or fail) and report the final path/size, so the master never has to
// poll the filesystem. Long downloads time out to "in_progress" and can be
// re-queried with [DOWNLOAD?] <id>.
const DL_WAIT_MS = 120000;

function describeDownload(id) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id }, (items) => {
      const d = items && items[0];
      if (!d) return resolve("download id=" + id + " not found");
      resolve(
        "download " + d.state + " (id=" + id + ") → " + (d.filename || d.url) +
        (d.fileSize > 0 ? " (" + d.fileSize + " bytes)" : "") +
        (d.error ? " error=" + d.error : "")
      );
    });
  });
}

function waitDownloadDone(id, timeoutMs = DL_WAIT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChg);
      describeDownload(id).then((desc) => resolve(how === "timeout" ? desc.replace(/^download \w+/, "download in_progress") : desc));
    };
    const onChg = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete" || delta.state.current === "interrupted") finish("state");
    };
    chrome.downloads.onChanged.addListener(onChg);
    // it may already be finished by the time we attach the listener
    chrome.downloads.search({ id }, (items) => {
      const d = items && items[0];
      if (d && (d.state === "complete" || d.state === "interrupted")) finish("state");
    });
    setTimeout(() => finish("timeout"), timeoutMs);
  });
}

// #7 — serialize downloads: browsers block bursts of automated downloads from
// one site, and parallel dispatch causes duplicates on blind retry. Chain every
// [DOWNLOAD] through a single promise queue (concurrency 1).
let dlChain = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "download") return;
  try {
    // [DOWNLOAD?] <id> — status re-query for a long-running download.
    if (msg.statusOnly) {
      describeDownload(Number(msg.url)).then((text) => sendResponse({ text }));
      return true;
    }
    // [CANCEL] <id|all> — stop a runaway download without manual browser UI. (#7)
    if (msg.cancel) {
      const target = String(msg.url).trim();
      if (target === "all") {
        chrome.downloads.search({ state: "in_progress" }, (items) => {
          (items || []).forEach((d) => chrome.downloads.cancel(d.id));
          sendResponse({ text: "cancelled " + (items || []).length + " in-progress download(s)" });
        });
      } else {
        chrome.downloads.cancel(Number(target), () => {
          if (chrome.runtime.lastError) sendResponse({ text: "cancel error: " + chrome.runtime.lastError.message });
          else describeDownload(Number(target)).then((text) => sendResponse({ text }));
        });
      }
      return true;
    }
    const opts = { url: msg.url, conflictAction: "uniquify" };
    // Optional target sub-path under Downloads (sanitized) — keeps same-named
    // files from different sources apart.
    if (msg.path) opts.filename = String(msg.path).replace(/\.\.(\/|\\)/g, "").replace(/^[/\\]+/, "");
    dlChain = dlChain.then(() => new Promise((resolveQueue) => {
      chrome.downloads.download(opts, (id) => {
        if (chrome.runtime.lastError) { sendResponse({ text: "download error: " + chrome.runtime.lastError.message }); resolveQueue(); }
        else waitDownloadDone(id).then((text) => { sendResponse({ text }); resolveQueue(); }); // #2
      });
    })).catch(() => {});
  } catch (e) { sendResponse({ text: "download error: " + e }); }
  return true; // async
});

// [CLICK]/[FILL]/[TYPE]/[SUBMIT]/[JS] — act on the target tab (real interaction).
// #6 — the injected function is async and awaits thenable eval results, so [JS]
// bodies can use `await` (via async IIFE) for wait-then-read workflows.
// #3 — fill re-reads the value after dispatching events and reports the value
// the page actually kept (framework handlers may transform or reject it).
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "act") return;
  pickTab(msg.urlMatch).then(async (tab) => {
    if (!tab) { sendResponse({ text: "(no target tab)" }); return; }
    await waitTabReady(tab.id); // #4
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (action, selector, value, code, cap) => {
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
            // #3 read-back: report what the page actually kept, not what we sent.
            const kept = el.value;
            return kept === value
              ? "filled " + selector + " = " + kept
              : "filled " + selector + " = " + kept + " (WARNING: page kept a different value than sent: " + value + ")";
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
            let r = eval(code);
            if (r && typeof r.then === "function") r = await r; // #6 async support
            const s = typeof r === "object" ? JSON.stringify(r) : String(r);
            return s.length > cap ? s.slice(0, cap) + "\n…[truncated, " + (s.length - cap) + " more bytes]" : s; // #9
          }
          return "(unknown action: " + action + ")";
        } catch (e) {
          // #9 — distinguish "page policy" from "code bug": CSP'd pages reject
          // eval; the static markers ([DOM]/[CLICK]/[FILL]/[SUBMIT]) still work.
          const m = String(e);
          if (action === "js" && /unsafe-eval|Content Security Policy|EvalError/i.test(m))
            return "js blocked by page CSP (eval forbidden on this site) — use the static markers [DOM]/[CLICK]/[FILL]/[SUBMIT] instead. " + m;
          return action + " error: " + e;
        }
      },
      args: [msg.action, msg.selector || "", msg.value || "", msg.code || "", CAP],
    }).then((res) => sendResponse({ text: res && res[0] ? String(res[0].result) : "(no result)" }))
      .catch((e) => sendResponse({ text: "act error: " + e }));
  });
  return true; // async
});
