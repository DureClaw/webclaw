// webclaw CDP layer (v0.7.0) — native browser access through chrome.debugger.
// Loaded into the background service worker via importScripts().
//
// What it buys over chrome.scripting: trusted input (isTrusted clicks/typing
// that React & friends accept), background-tab screenshots without stealing
// focus, CSP-proof JS evaluation, file-input uploads, and a raw [CDP] escape
// hatch. Every caller treats CDP as an *upgrade*: when it is off, refused, or
// fails, the existing scripting path still runs.
//
// Attaching shows Chrome's "webclaw started debugging this browser" bar, so
// sessions are short-lived: auto-detach after IDLE_MS without commands. If the
// human dismisses the bar ("Cancel"), that tab is left alone for COOLDOWN_MS.
const WcCdp = (() => {
  const PROTOCOL = "1.3";
  const IDLE_MS = 30000;
  const COOLDOWN_MS = 10 * 60 * 1000;
  const attached = new Map(); // tabId → idle-detach timer
  const refusedUntil = new Map(); // tabId → epoch ms (user cancelled the bar)

  // Raw [CDP] calls that would dump credentials for *every* site, or reach
  // outside the target tab, are refused by default (cfg.cdpDeny overrides).
  const DEFAULT_DENY = ["Network.getAllCookies", "Network.getCookies", "Storage.getCookies", "Browser.", "Target.", "SystemInfo."];

  function available() { return typeof chrome !== "undefined" && !!chrome.debugger; }

  async function enabled(tabId) {
    if (!available()) return false;
    const cfg = await readCfg();
    if (cfg.cdp === "off") return false;
    const until = refusedUntil.get(tabId);
    return !(until && until > Date.now());
  }

  function touch(tabId) {
    clearTimeout(attached.get(tabId));
    attached.set(tabId, setTimeout(() => detach(tabId), IDLE_MS));
  }

  async function attach(tabId) {
    if (attached.has(tabId)) return touch(tabId);
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL);
    } catch (e) {
      // After a service-worker restart we lose `attached` but Chrome may still
      // hold our session — treat "already attached" as success; a foreign
      // debugger surfaces later as a sendCommand error and triggers fallback.
      if (!/already attached/i.test(String((e && e.message) || e))) throw e;
    }
    touch(tabId);
  }

  async function detach(tabId) {
    clearTimeout(attached.get(tabId));
    attached.delete(tabId);
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }

  if (available()) {
    chrome.debugger.onDetach.addListener((src, reason) => {
      if (src.tabId == null) return;
      clearTimeout(attached.get(src.tabId));
      attached.delete(src.tabId);
      if (reason === "canceled_by_user") refusedUntil.set(src.tabId, Date.now() + COOLDOWN_MS);
    });
  }

  function withTimeout(p, ms, what) {
    let t;
    return Promise.race([
      p.finally(() => clearTimeout(t)),
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error("cdp timeout: " + what)), ms); }),
    ]);
  }

  async function send(tabId, method, params, timeoutMs = 15000) {
    await attach(tabId);
    const r = await withTimeout(chrome.debugger.sendCommand({ tabId }, method, params || {}), timeoutMs, method);
    touch(tabId);
    return r;
  }

  async function denied(method) {
    const cfg = await readCfg();
    const deny = Array.isArray(cfg.cdpDeny) ? cfg.cdpDeny : DEFAULT_DENY;
    return deny.some((d) => (d.endsWith(".") ? method.startsWith(d) : method === d));
  }

  // Trusted left click at viewport CSS-pixel coordinates (main frame).
  async function click(tabId, x, y) {
    const base = { x, y, button: "left", clickCount: 1 };
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send(tabId, "Input.dispatchMouseEvent", Object.assign({ type: "mousePressed" }, base));
    await send(tabId, "Input.dispatchMouseEvent", Object.assign({ type: "mouseReleased" }, base));
  }

  // Trusted text input into whatever currently has focus (IME-style insert).
  function insertText(tabId, text) { return send(tabId, "Input.insertText", { text }); }

  // Background tabs may never produce a frame — keep the timeout short so the
  // caller can fall back to focus + captureVisibleTab.
  async function screenshot(tabId) {
    const r = await send(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 85 }, 6000);
    return "data:image/jpeg;base64," + r.data;
  }

  // Page-world evaluation that page CSP cannot block (no eval involved).
  async function evaluate(tabId, expression) {
    const r = await send(tabId, "Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: true, replMode: true,
    }, 30000);
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      throw new Error("js exception: " + ((ex && ex.description) || r.exceptionDetails.text));
    }
    const res = r.result || {};
    return res.value !== undefined ? res.value : (res.description || res.type);
  }

  // Point a <input type=file> (found by CSS, open shadow roots included) at
  // local files. Only CDP can do this — scripting cannot set FileList.
  async function setFiles(tabId, css, files) {
    const expr = "(" + wcDeepQuery.toString() + ")(" + JSON.stringify(css) + ")";
    const r = await send(tabId, "Runtime.evaluate", { expression: expr });
    if (!r.result || !r.result.objectId) return false;
    await send(tabId, "DOM.setFileInputFiles", { files, objectId: r.result.objectId });
    return true;
  }

  return { available, enabled, send, denied, click, insertText, screenshot, evaluate, setFiles, detach };
})();

// document.querySelector that also descends into open shadow roots. Used both
// in-page (serialized) and as a source string for CDP evaluation.
function wcDeepQuery(sel) {
  const hit = document.querySelector(sel);
  if (hit) return hit;
  const stack = [document];
  while (stack.length) {
    const root = stack.pop();
    for (const el of root.querySelectorAll("*")) {
      if (!el.shadowRoot) continue;
      const m = el.shadowRoot.querySelector(sel);
      if (m) return m;
      stack.push(el.shadowRoot);
    }
  }
  return null;
}
