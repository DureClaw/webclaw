// webclaw [RUN] script runner (v0.7.0) — ego-style "code, not one marker per
// round-trip". Runs in the extension *sandbox* page (eval allowed there, page
// CSP irrelevant) and in Node for tests. Pure: no chrome.* use.
//
// The agent's script is the body of an async function. Helpers are injected
// as parameters; each helper just issues one marker through `call(marker)`,
// which the host routes through the very same runTask() a bus task would use
// — so every marker feature (@refs, spaces, CDP upgrades, hand-off blocking)
// works identically inside scripts. A failed marker throws an Error carrying
// `.reason`, so scripts can try/catch.
(function (root) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  function makeApi(call, opts) {
    opts = opts || {};
    let tab = opts.tab || ""; // default "@…" target: URL substring or "space:<name>"
    const log = [];
    const at = (o) => {
      const t = o && o.tab != null ? o.tab : tab;
      return t ? "@" + t : "";
    };
    const mk = (name, o) => "[" + name + at(o) + "]";
    const json = (s) => { try { return JSON.parse(s); } catch (e) { return s; } };
    const str = (v) => (typeof v === "string" ? v : JSON.stringify(v));

    const api = {
      // targeting
      useTab(t) { tab = t || ""; },
      useSpace(name) { tab = name ? "space:" + name : ""; },
      space: async (name) => { const r = await call("[SPACE] " + name); tab = "space:" + name; return r; },
      handOff: (note, o) => call("[HANDOFF] " + spaceName(o) + (note ? " :: " + note : "")),
      // utilities
      log: (...a) => { log.push(a.map(str).join(" ")); },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      marker: (text) => call(text),
      // tabs & navigation
      tabs: () => call("[TABS]"),
      open: (url, o) => call(mk("OPEN", o) + " " + url),
      close: (o) => call(mk("CLOSE", o)),
      // reading
      outline: (o) => call(mk("OUTLINE", o)),
      dom: (css, o) => call(mk("DOM", o) + " " + (css || "")),
      links: async (css, o) => json(await call(mk("LINKS", o) + " " + (css || ""))),
      attr: async (css, name, o) => json(await call(mk("ATTR", o) + " " + css + " :: " + name)),
      snap: (o) => call(mk("SNAP", o)),
      diff: async (action, o) => json(await call(mk("DIFF", o) + " " + action)),
      wait: (target, ms, o) => call(mk("WAIT", o) + " " + target + (ms ? " :: " + ms : "")),
      // acting
      click: (target, o) => call(mk("CLICK", o) + " " + target),
      clickText: (label, o) => call(mk("CLICKTEXT", o) + " " + label),
      fill: (target, value, o) => call(mk("FILL", o) + " " + target + "\n" + value),
      type: (target, value, o) => call(mk("TYPE", o) + " " + target + "\n" + value),
      submit: (target, o) => call(mk("SUBMIT", o) + " " + target),
      upload: (target, files, o) => call(mk("UPLOAD", o) + " " + target + " :: " + [].concat(files).join(", ")),
      js: async (code, o) => json(await call(mk("JS", o) + " " + code)),
      cdp: async (method, params, o) => json(await call(mk("CDP", o) + " " + method + " " + JSON.stringify(params || {}))),
      shot: (path, o) => call(mk("SHOT", o) + " " + (path || "")),
      // network & files
      fetchText: (url) => call("[FETCH] " + url),
      download: (url, path) => call("[DOWNLOAD] " + url + (path ? " :: " + path : "")),
      // human & memory
      say: (text, o) => call(mk("SAY", o) + " " + text),
      learned: (domain) => call("[LEARNED] " + (domain || "")),
    };
    function spaceName(o) {
      const t = o && o.space ? "space:" + o.space : tab;
      return t.startsWith("space:") ? t.slice(6) : "";
    }
    return { api, log };
  }

  // → { ok:true, result, log } | { ok:false, error, reason, log }
  async function runScript(code, call, opts) {
    opts = opts || {};
    const { api, log } = makeApi(call, opts);
    const names = Object.keys(api);
    const consoleShim = { log: api.log, info: api.log, warn: api.log, error: api.log };
    try {
      const fn = new AsyncFunction(...names, "args", "console", String(code || ""));
      const value = await fn(...names.map((n) => api[n]), opts.args, consoleShim);
      return { ok: true, result: value === undefined ? null : value, log };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), reason: (e && e.reason) || "script_error", log };
    }
  }

  root.webclawRunner = { runScript, makeApi };
  if (typeof module !== "undefined" && module.exports) module.exports = { runScript, makeApi };
})(typeof globalThis !== "undefined" ? globalThis : self);
