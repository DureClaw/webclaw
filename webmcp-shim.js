// webclaw WebMCP shim (v0.9.0) — runs in the page's MAIN world at
// document_start (registered by background.js; off with cfg.webmcp = "off").
//
// WebMCP (W3C webmachinelearning/webmcp draft, Chrome origin trial) lets a
// page expose tools to the browser's agent via navigator.modelContext.
// Browsers give no way to *list* those tools from outside, and only their own
// agent may call them. This shim records every tool the page registers —
// wrapping a native navigator.modelContext when present, polyfilling it when
// absent — so [WEBMCP] list/call can relay them to ANY agent over the bus.
(function () {
  const KEY = Symbol.for("webclaw.webmcp");
  if (window[KEY]) return;
  const tools = new Map();
  window[KEY] = tools;

  const keep = (t) => { if (t && t.name && typeof t.execute === "function") tools.set(t.name, t); };
  const mc = navigator.modelContext;
  if (mc) {
    // native: record, then delegate
    for (const fn of ["provideContext", "registerTool", "unregisterTool", "clearContext"]) {
      const orig = typeof mc[fn] === "function" ? mc[fn].bind(mc) : null;
      if (!orig) continue;
      mc[fn] = function (arg) {
        if (fn === "provideContext") { tools.clear(); ((arg && arg.tools) || []).forEach(keep); }
        else if (fn === "registerTool") keep(arg);
        else if (fn === "unregisterTool") tools.delete(typeof arg === "string" ? arg : arg && arg.name);
        else tools.clear();
        return orig(arg);
      };
    }
    return;
  }
  const poly = {
    provideContext(ctx) { tools.clear(); ((ctx && ctx.tools) || []).forEach(keep); },
    registerTool(tool) { keep(tool); return { unregister: () => tools.delete(tool.name) }; },
    unregisterTool(name) { tools.delete(name); },
    clearContext() { tools.clear(); },
  };
  try { Object.defineProperty(navigator, "modelContext", { value: poly, configurable: true }); } catch (e) {}
})();
