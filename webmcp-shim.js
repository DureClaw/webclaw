// webclaw WebMCP shim (v0.9.0) — runs in the page's MAIN world at
// document_start (registered by background.js; off with cfg.webmcp = "off").
//
// WebMCP (W3C webmachinelearning/webmcp draft, Chrome origin trial) lets a
// page expose tools to the browser's agent via navigator.modelContext.
// Browsers give no way to *list* those tools from outside, and only their own
// agent may call them. This shim records every tool the page registers —
// wrapping a native navigator.modelContext when present, polyfilling it when
// absent — so [WEBMCP] list/call can relay them to ANY agent over the bus.
//
// Hardening (A9): the polyfill is a configurable accessor that prefers a native
// navigator.modelContext the moment one exists (and stays assignable), wrapped
// methods forward all arguments, and the registry lives only in this closure —
// nothing on window. background.js reaches it with a document CustomEvent
// carrying a per-install key (first key seen is pinned; the window-capture
// listener is registered before any page script, so pages never observe it).
// A tool's requestUserInteraction() pauses the call until the human answers in
// the extension's side panel — it is never auto-confirmed.
(function () {
  const EVT = "webclaw:webmcp";
  const TOOL_MS = 60000;
  const tools = new Map();
  const calls = new Map(); // callId → call state (see start())
  let armedKey = null, seq = 0;

  const keep = (t) => { if (t && t.name && typeof t.execute === "function") tools.set(t.name, t); };
  const record = (fn, args) => {
    const arg = args[0];
    if (fn === "provideContext") { tools.clear(); ((arg && arg.tools) || []).forEach(keep); }
    else if (fn === "registerTool") keep(arg);
    else if (fn === "unregisterTool") tools.delete(typeof arg === "string" ? arg : arg && arg.name);
    else if (fn === "clearContext") tools.clear();
  };
  const FNS = ["provideContext", "registerTool", "unregisterTool", "clearContext"];

  // native: record, then delegate with every argument
  const wrapped = new WeakSet();
  function wrapNative(mc) {
    if (!mc || typeof mc !== "object" || wrapped.has(mc)) return mc;
    wrapped.add(mc);
    for (const fn of FNS) {
      const orig = mc[fn];
      if (typeof orig !== "function") continue;
      try {
        Object.defineProperty(mc, fn, { configurable: true, writable: true, enumerable: false,
          value: function (...args) { record(fn, args); return orig.apply(this === undefined ? mc : this, args); } });
      } catch (e) {}
    }
    return mc;
  }
  const poly = {
    provideContext(...args) { record("provideContext", args); },
    registerTool(...args) {
      record("registerTool", args);
      const tool = args[0];
      return { unregister: () => { if (tool && tools.get(tool.name) === tool) tools.delete(tool.name); } };
    },
    unregisterTool(...args) { record("unregisterTool", args); },
    clearContext(...args) { record("clearContext", args); },
  };
  const nativeMc = () => {
    try {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), "modelContext");
      return (d && (d.get ? d.get.call(navigator) : d.value)) || null;
    } catch (e) { return null; }
  };
  const own = Object.getOwnPropertyDescriptor(navigator, "modelContext");
  if (own) {
    wrapNative(own.get ? own.get.call(navigator) : own.value); // someone already defined it — wrap, don't replace
  } else {
    let assigned; // page assigned its own value → that wins (writable semantics)
    try {
      Object.defineProperty(navigator, "modelContext", {
        configurable: true, enumerable: true,
        get() { if (assigned !== undefined) return assigned; const n = nativeMc(); return n ? wrapNative(n) : poly; },
        set(v) { assigned = v; },
      });
    } catch (e) {}
  }

  // ── bridge to background.js (executeScript in MAIN world) ────────────────
  const clone = (r) => (r === undefined ? null : JSON.parse(JSON.stringify(r)));

  // Resolve with the next thing background must see: the result, or a pending
  // requestUserInteraction (→ background asks the human, then "resume").
  function next(c) {
    return new Promise((resolve) => {
      let t = null;
      const once = (x) => { if (!c.waiter) return; c.waiter = null; clearTimeout(t); resolve(x); };
      c.waiter = once;
      if (c.out) return once(c.out);
      if (c.ask && !c.ask.reported) { c.ask.reported = true; return once({ interaction: c.id }); }
      t = setTimeout(() => once({ error: "webmcp tool did not finish within " + TOOL_MS / 1000 + "s" }), TOOL_MS);
    });
  }

  function start(name, args) {
    const t = tools.get(name);
    if (!t) return Promise.resolve({ error: "no such WebMCP tool: " + name, available: [...tools.keys()] });
    const c = { id: "c" + ++seq, out: null, ask: null, waiter: null };
    calls.set(c.id, c);
    const finish = (x) => { c.out = x; calls.delete(c.id); if (c.waiter) c.waiter(x); };
    const client = {
      requestUserInteraction: (cb) => new Promise((res, rej) => {
        if (c.ask) return rej(new Error("one user interaction at a time"));
        c.ask = { cb, res, rej, reported: false };
        if (c.waiter) { c.ask.reported = true; c.waiter({ interaction: c.id }); }
      }),
    };
    Promise.resolve().then(() => t.execute(args || {}, client)).then(
      (r) => { try { finish({ result: clone(r) }); } catch (e) { finish({ error: "tool result is not JSON-serializable" }); } },
      (e) => finish({ error: String((e && e.message) || e) }));
    return next(c);
  }

  function resume(callId, allow) {
    const c = calls.get(callId);
    if (!c || !c.ask) return Promise.resolve({ error: "no pending interaction: " + callId });
    const a = c.ask;
    c.ask = null;
    if (allow) Promise.resolve().then(() => (typeof a.cb === "function" ? a.cb() : undefined)).then(a.res, a.rej);
    else a.rej(new Error("the human declined the interaction"));
    return next(c);
  }

  function handle(d) {
    if (d.op === "list") return Promise.resolve({ tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || {} })) });
    if (d.op === "call") return start(String(d.name || ""), d.args);
    if (d.op === "resume") return resume(String(d.callId || ""), !!d.allow);
    return Promise.resolve({ error: "bad webmcp op: " + d.op });
  }

  window.addEventListener(EVT, (ev) => {
    const d = ev.detail;
    if (!d || typeof d !== "object" || typeof d.key !== "string" || d.key.length < 16) return;
    if (armedKey === null) armedKey = d.key;
    if (d.key !== armedKey) return;
    ev.stopImmediatePropagation();
    d.reply = handle(d);
  }, true);
})();
