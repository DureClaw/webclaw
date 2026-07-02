// webclaw core — DureClaw Phoenix-Channel bus client.
// Runs in the browser (offscreen document) AND in Node (for tests) — uses only
// global WebSocket + fetch. No build step. The master brings the brain; this
// node brings browser hands (fetch / DOM) + delegates LLM to the master.
(function (root) {
  var CAP = 200000; // generous output cap (raised from 1500)

  function createWebclaw(cfg, hooks) {
    hooks = hooks || {};
    const log = (m) => hooks.onLog && hooks.onLog(m);
    let ref = 0, joinRef = null, ws = null, hb = null, closed = false;
    const nref = () => String(++ref);
    const url =
      "ws://" + cfg.bus + "/socket/websocket?vsn=2.0.0" +
      (cfg.secret ? "&token=" + encodeURIComponent(cfg.secret) : "");

    function send(arr) { try { ws.send(JSON.stringify(arr)); } catch (e) {} }

    function connect() {
      ws = new WebSocket(url);
      ws.onopen = () => {
        joinRef = nref();
        send([joinRef, joinRef, "work:" + cfg.workKey, "phx_join", {
          agent_name: cfg.name, role: cfg.role || "executor", machine: cfg.machine || "browser",
          capabilities: cfg.caps || ["browser", "fetch", "dom", "click", "form", "js", "tabs", "agent"],
          preferred_model: "browser", version: "webclaw/0.2",
        }]);
        clearInterval(hb);
        hb = setInterval(() => send([null, nref(), "phoenix", "heartbeat", {}]), 15000);
        log("joined work:" + cfg.workKey + " as " + cfg.name);
        hooks.onStatus && hooks.onStatus("connected");
      };
      ws.onmessage = (ev) => {
        let f; try { f = JSON.parse(ev.data); } catch (e) { return; }
        if (!Array.isArray(f) || f.length !== 5 || f[3] !== "task.assign") return;
        const p = f[4];
        if (p.to && p.to !== cfg.name && p.to !== "broadcast") return;
        handle(p);
      };
      ws.onclose = () => {
        clearInterval(hb);
        hooks.onStatus && hooks.onStatus("disconnected");
        if (!closed) setTimeout(connect, 3000);
      };
      ws.onerror = () => log("ws error");
    }

    async function handle(p) {
      const instr = (p.instructions || "").trim();
      if (!instr) return;
      const from = p.from || "http@controller";
      log("task " + p.task_id + ": " + instr.slice(0, 70));
      hooks.onTask && hooks.onTask({ dir: "in", name: from, text: instr });
      let out, code = 0;
      try { out = await runTask(instr, cfg, hooks); } catch (e) { out = String(e); code = 1; }
      send([joinRef, nref(), "work:" + cfg.workKey, "task.result", {
        task_id: p.task_id, to: from, from: cfg.name,
        status: code ? "failed" : "done", output: String(out).slice(0, CAP),
        exit_code: code, backend: "webclaw",
      }]);
      hooks.onTask && hooks.onTask({ dir: "out", name: cfg.name, text: String(out).slice(0, 120) });
    }

    connect();
    return { disconnect() { closed = true; try { clearInterval(hb); ws && ws.close(); } catch (e) {} } };
  }

  // Parse a leading marker: [NAME] or [NAME@<url-substring>] then the rest.
  // The optional @<url-substring> picks a specific tab (e.g. the logged-in
  // session) instead of the active one.
  function parseMarker(t) {
    const m = t.match(/^\[([A-Za-z]+)(?:@([^\]]+))?\]\s*([\s\S]*)$/);
    return m ? { name: m[1].toUpperCase(), urlMatch: (m[2] || "").trim(), rest: m[3] } : null;
  }

  // Split "<selector> = <value>" or "<selector>\n<value>" (newline first so
  // attribute selectors like input[name="x"] don't get split on their own '=').
  function splitSelVal(rest) {
    const nl = rest.indexOf("\n");
    if (nl >= 0) return { selector: rest.slice(0, nl).trim(), value: rest.slice(nl + 1) };
    const eq = rest.indexOf(" = ");
    if (eq >= 0) return { selector: rest.slice(0, eq).trim(), value: rest.slice(eq + 3) };
    return { selector: rest.trim(), value: "" };
  }

  // Task execution — browser hands + LLM delegation to the master (keyless to the page).
  async function runTask(instr, cfg, hooks) {
    const t = instr.trim();
    const mk = parseMarker(t);
    if (mk) {
      const { name, urlMatch, rest } = mk;
      // [FETCH] <url> — extension fetch bypasses page CORS (host_permissions).
      if (name === "FETCH") {
        const r = await fetch(rest.trim());
        return (await r.text()).slice(0, CAP);
      }
      // [DOM] <query> — read the target tab's DOM (empty query = page text).
      if (name === "DOM" && hooks.dom) return await hooks.dom(rest.trim(), urlMatch);
      // [TABS] — list open tabs so the master can target the logged-in session.
      if (name === "TABS" && hooks.tabs) return await hooks.tabs();
      // [CLICK] <selector>
      if (name === "CLICK" && hooks.act) return await hooks.act({ action: "click", selector: rest.trim(), urlMatch });
      // [FILL]/[TYPE] <selector> = <value>   (or selector\nvalue)
      if ((name === "FILL" || name === "TYPE") && hooks.act) {
        const { selector, value } = splitSelVal(rest);
        return await hooks.act({ action: "fill", selector, value, urlMatch });
      }
      // [SUBMIT] <selector> — submit a form (or the element's form / click).
      if (name === "SUBMIT" && hooks.act) return await hooks.act({ action: "submit", selector: rest.trim(), urlMatch });
      // [JS] <code> — run JS in the target page, return the result (grading etc.).
      if (name === "JS" && hooks.act) return await hooks.act({ action: "js", code: rest, urlMatch });
    }
    // default → delegate LLM to the master brain (the master does the thinking).
    if (cfg.brainUrl) {
      const h = { "content-type": "application/json" };
      if (cfg.brainToken) h.authorization = "Bearer " + cfg.brainToken;
      const r = await fetch(cfg.brainUrl.replace(/\/$/, "") + "/brain/exec", {
        method: "POST", headers: h, body: JSON.stringify({ prompt: instr }),
      });
      const j = await r.json();
      return j.output != null ? j.output : JSON.stringify(j);
    }
    return "[webclaw] no brain configured. echo: " + instr;
  }

  root.createWebclaw = createWebclaw;
  if (typeof module !== "undefined" && module.exports) module.exports = { createWebclaw };
})(typeof globalThis !== "undefined" ? globalThis : self);
