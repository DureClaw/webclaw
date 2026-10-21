// webclaw core — DureClaw Phoenix-Channel bus client.
// Runs in the browser (offscreen document) AND in Node (for tests) — uses only
// global WebSocket + fetch. No build step. The master brings the brain; this
// node brings browser hands (fetch / DOM) + delegates LLM to the master.
(function (root) {
  var CAP = 2000000; // 채점 페이지 등 대형 HTML 위해 상향 (2MB)

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
          capabilities: cfg.caps || ["browser", "fetch", "download", "dom", "click", "form", "js", "tabs", "agent", "cdp", "outline", "run", "space"],
          preferred_model: "browser", version: "webclaw/0.11.1",
        }]);
        clearInterval(hb);
        hb = setInterval(() => send([null, nref(), "phoenix", "heartbeat", {}]), 15000);
        log("joined work:" + cfg.workKey + " as " + cfg.name);
        hooks.onStatus && hooks.onStatus("connected");
        // expose the *actual* joined identity (instance-suffixed name etc.)
        // so the popup can show exactly which node this browser is.
        hooks.onJoined && hooks.onJoined({ name: cfg.name, bus: cfg.bus, workKey: cfg.workKey, version: "webclaw/0.11.1" });
      };
      ws.onmessage = (ev) => {
        let f; try { f = JSON.parse(ev.data); } catch (e) { return; }
        if (!Array.isArray(f) || f.length !== 5) return;
        // v0.9.0 — CDP relay: the local mini-bus forwards page-session
        // commands of an external CDP client (Puppeteer/Playwright) here.
        if (f[3] === "cdp.call" && f[4] && f[4].to === cfg.name && hooks.cdpRelay) {
          const c = f[4];
          Promise.resolve(hooks.cdpRelay(c)).then((r) => r || {}, (e) => ({ error: { code: -32000, message: String((e && e.message) || e) } }))
            .then((r) => send([joinRef, nref(), "work:" + cfg.workKey, "cdp.reply", Object.assign({ id: c.id, from: cfg.name }, r)]));
          return;
        }
        if (f[3] !== "task.assign") return;
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
      // #5 delivery ack — tell the controller the task was actually picked up,
      // so an eternally-pending task can be distinguished from a working one.
      // Sent as a separate "task.ack" event (NOT task.result) so buses that
      // don't know it simply ignore it and the real result is never shadowed.
      send([joinRef, nref(), "work:" + cfg.workKey, "task.ack", {
        task_id: p.task_id, to: from, from: cfg.name, backend: "webclaw",
      }]);
      // #14 — hooks.act rejects (instead of resolving) known-bad outcomes
      // (unmatched selector, value mismatch) with an Error carrying a
      // `.reason` code, so those land here as real failures — status:"failed"
      // + exit_code 1 — instead of a success response the master has to
      // string-sniff for "(no match:" to tell apart from a real success.
      let out, code = 0, reason = null;
      try { out = await runTask(instr, cfg, hooks); } catch (e) { out = String(e); code = 1; reason = e && e.reason; }
      const result = {
        task_id: p.task_id, to: from, from: cfg.name,
        status: code ? "failed" : "done", output: String(out).slice(0, CAP),
        exit_code: code, backend: "webclaw",
      };
      if (reason) result.reason = reason;
      send([joinRef, nref(), "work:" + cfg.workKey, "task.result", result]);
      hooks.onTask && hooks.onTask({ dir: "out", name: cfg.name, text: String(out).slice(0, 120) });
    }

    connect();
    return {
      // v0.9.0 — push a node-originated event (CDP relay events) onto the bus
      pushEvent(event, payload) { send([joinRef, nref(), "work:" + cfg.workKey, event, Object.assign({ from: cfg.name }, payload)]); },
      disconnect() { closed = true; try { clearInterval(hb); ws && ws.close(); } catch (e) {} },
      // #11 — publish a human message from the on-page HUD into this node's
      // fixed inbox slot ("hud-inbox-<node>") as a task.result, so any
      // orchestrator can poll GET /api/task-result/<slot> with no bus changes.
      publishInbox(text, meta) {
        const payload = JSON.stringify({ text, url: (meta && meta.url) || "", seq: Date.now() });
        send([joinRef, nref(), "work:" + cfg.workKey, "task.result", {
          task_id: "hud-inbox-" + cfg.name, to: "http@controller", from: cfg.name,
          status: "done", output: payload, exit_code: 0, backend: "webclaw-hud",
        }]);
        log("hud chat → inbox: " + String(text).slice(0, 60));
      },
    };
  }

  // Parse a leading marker: [NAME] or [NAME@<url-substring>] then the rest.
  // The optional @<url-substring> picks a specific tab (e.g. the logged-in
  // session) instead of the active one.
  function parseMarker(t) {
    const m = t.match(/^\[([A-Za-z]+\??)(?:@([^\]]+))?\]\s*([\s\S]*)$/);
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

  function fail(text, reason) { return Object.assign(new Error(text), { reason }); }

  // "[CDP] Domain.method {json params}" → { method, params }.
  function parseCdp(rest) {
    const m = String(rest).trim().match(/^([A-Za-z]+\.[A-Za-z]+)\s*([\s\S]*)$/);
    if (!m) throw fail("(bad [CDP] call — expected: [CDP] Domain.method {json params})", "bad_args");
    let params = {};
    if (m[2].trim()) {
      try { params = JSON.parse(m[2]); } catch (e) { throw fail("(bad [CDP] params JSON: " + e.message + ")", "bad_args"); }
    }
    return { method: m[1], params };
  }

  // "<head>\n<json>" → { head, data } (data null when no body).
  function splitHeadJson(rest) {
    const nl = rest.indexOf("\n");
    const head = (nl >= 0 ? rest.slice(0, nl) : rest).trim();
    const body = nl >= 0 ? rest.slice(nl + 1).trim() : "";
    if (!body) return { head, data: null };
    try { return { head, data: JSON.parse(body) }; } catch (e) { throw fail("(bad JSON body: " + e.message + ")", "bad_args"); }
  }

  // Task execution — browser hands + LLM delegation to the master (keyless to the page).
  // opts.noBrain: unknown markers/free text throw instead of reaching the brain
  // (used for markers issued from inside [RUN] scripts).
  async function runTask(instr, cfg, hooks, opts) {
    opts = opts || {};
    const t = instr.trim();
    const mk = parseMarker(t);
    if (mk) {
      const { name, urlMatch, rest } = mk;
      // ── v0.7.0: native (CDP) access, @refs, scripts, spaces, learnings ──
      // [OUTLINE]/[SNAPSHOT] [max] — interactive elements of every frame as @refs.
      if ((name === "OUTLINE" || name === "SNAPSHOT") && hooks.act) return await hooks.act({ action: "outline", code: rest.trim(), urlMatch });
      // [CDP] Domain.method {json} — raw Chrome DevTools Protocol on the target tab.
      if (name === "CDP" && hooks.act) return await hooks.act(Object.assign({ action: "cdp", urlMatch }, parseCdp(rest)));
      // [UPLOAD] <css|@ref> :: <abs path>[, <abs path>…] — set a file input (CDP).
      if (name === "UPLOAD" && hooks.act) {
        const parts = rest.split(" :: ");
        const files = (parts[1] || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!files.length) throw fail("(bad [UPLOAD] — expected: [UPLOAD] <css|@ref> :: <abs path>[, …])", "bad_args");
        return await hooks.act({ action: "upload", selector: parts[0].trim(), files, urlMatch });
      }
      // [WAIT] <css|@ref|text:label> [:: timeoutMs] — until present & visible.
      if (name === "WAIT" && hooks.act) {
        const parts = rest.split(" :: ");
        return await hooks.act({ action: "wait", selector: parts[0].trim(), value: (parts[1] || "").trim(), urlMatch });
      }
      // [RUN] <js> — batch script with injected helpers, one round-trip.
      // v0.9.0: a first line "// @save <domain>/<name>" stores the script as a
      // learned recipe once it succeeds (self-saving recipes).
      if (name === "RUN" && hooks.run) {
        if (opts.noBrain) throw fail("(nested [RUN] is not allowed inside a script)", "nested_run");
        const save = rest.match(/^\s*\/\/\s*@save\s+(\S+)\/([^\s/]+)\s*$/m);
        const out = await hooks.run(rest, { urlMatch });
        if (save && hooks.learn) {
          await hooks.learn({ op: "set", domain: save[1], data: { recipes: { [save[2]]: rest.replace(/^\s*\/\/\s*@save[^\n]*\n?/m, "") } } });
          return out.replace(/\}$/, ',"saved":"' + save[1] + "/" + save[2] + '"}');
        }
        return out;
      }
      // [AUDIT] [n] · [REC] on [label]|off|status · [REPLAY] [path] · [POLICY]
      // · [IDENTITY] [init] · [WEBMCP] list | call <tool> {json}
      if (name === "AUDIT" && hooks.guard) return await hooks.guard({ op: "audit", arg: rest.trim(), urlMatch });
      if (name === "REC" && hooks.guard) {
        const m = rest.trim().match(/^(on|off|status)?\s*([\s\S]*)$/i);
        return await hooks.guard({ op: "rec", arg: ((m && m[1]) || "status").toLowerCase(), label: (m && m[2]) || "" });
      }
      if (name === "REPLAY" && hooks.guard) return await hooks.guard({ op: "replay", arg: rest.trim() });
      if (name === "POLICY" && hooks.guard) return await hooks.guard({ op: "policy" });
      if (name === "IDENTITY" && hooks.guard) return await hooks.guard({ op: "identity", arg: rest.trim() });
      if (name === "WEBMCP" && hooks.guard) {
        const m = rest.trim().match(/^(list|call)\s*(\S*)\s*([\s\S]*)$/i);
        if (!m) throw fail("(bad [WEBMCP] — expected: [WEBMCP] list | [WEBMCP] call <tool> {json})", "bad_args");
        let args = {};
        if (m[3].trim()) { try { args = JSON.parse(m[3]); } catch (e) { throw fail("(bad [WEBMCP] args JSON: " + e.message + ")", "bad_args"); } }
        return await hooks.guard({ op: "webmcp", arg: m[1].toLowerCase(), tool: m[2], args, urlMatch });
      }
      // [LEARNINGS] export · [LEARNINGS] import\n<json {domain: {...}}>
      if (name === "LEARNINGS" && hooks.learn) {
        const { head, data } = splitHeadJson(rest);
        if (head === "export") return await hooks.learn({ op: "export" });
        if (head === "import" && data) return await hooks.learn({ op: "import", data });
        throw fail("(bad [LEARNINGS] — expected: export | import\\n<json>)", "bad_args");
      }
      // [RECIPE] <domain>/<name> [\n<json args>] — run a learned site script.
      if (name === "RECIPE" && hooks.learn && hooks.run) {
        if (opts.noBrain) throw fail("(nested [RECIPE] is not allowed inside a script)", "nested_run");
        const { head, data } = splitHeadJson(rest);
        const slash = head.lastIndexOf("/");
        if (slash <= 0) throw fail("(bad [RECIPE] — expected: [RECIPE] <domain>/<name>)", "bad_args");
        const code = await hooks.learn({ op: "recipe", domain: head.slice(0, slash), name: head.slice(slash + 1) });
        return await hooks.run(code, { urlMatch, args: data });
      }
      // [LEARN] <domain>\n<json {notes,selectors,recipes}> · [LEARNED] [<domain|url>] · [FORGET] <domain>
      if (name === "LEARN" && hooks.learn) {
        const { head, data } = splitHeadJson(rest);
        if (!head || !data) throw fail("(bad [LEARN] — expected: [LEARN] <domain>\\n<json>)", "bad_args");
        return await hooks.learn({ op: "set", domain: head, data });
      }
      if (name === "LEARNED" && hooks.learn) return await hooks.learn(rest.trim() ? { op: "get", domain: rest.trim() } : { op: "list" });
      if (name === "FORGET" && hooks.learn) return await hooks.learn({ op: "forget", domain: rest.trim() });
      // [SPACE] <name>|off|close <name> · [SPACES] · [HANDOFF] [name] [:: note] · [TAKEOVER] [name]
      if (name === "SPACE" && hooks.space) return await hooks.space({ op: "space", arg: rest.trim() });
      if (name === "SPACES" && hooks.space) return await hooks.space({ op: "list" });
      if ((name === "HANDOFF" || name === "TAKEOVER") && hooks.space) {
        const parts = rest.split(" :: ");
        return await hooks.space({ op: name.toLowerCase(), arg: parts[0].trim(), note: (parts[1] || "").trim() });
      }
      // [FETCH] <url> — extension fetch bypasses page CORS (host_permissions).
      if (name === "FETCH" && hooks.fetch) {
        return (await hooks.fetch(rest.trim())).slice(0, CAP);
      }
      // [DOWNLOAD] <url> [:: <relative/path.ext>] — real browser download to disk
      // (session cookies incl.). Waits for completion and reports final path/size
      // (long downloads return in_progress; re-query with [DOWNLOAD?] <id>).
      // Optional target path saves into a sub-folder of Downloads so many
      // same-named files don't collide.
      if (name === "DOWNLOAD" && hooks.download) {
        const parts = rest.split(" :: ");
        return await hooks.download(parts[0].trim(), (parts[1] || "").trim());
      }
      // [DOWNLOAD?] <id> — status of a previously started download.
      if (name === "DOWNLOAD?" && hooks.downloadStatus) return await hooks.downloadStatus(rest.trim());
      // [CANCEL] <id|all> — cancel in-progress download(s).
      if (name === "CANCEL" && hooks.downloadCancel) return await hooks.downloadCancel(rest.trim());
      // [LINKS] <css?> — anchors as [{text, href}] JSON (defaults to a[href]).
      if (name === "LINKS" && hooks.domEx) return await hooks.domEx({ mode: "links", query: rest.trim(), urlMatch });
      // [ATTR] <css> :: <attribute> — attribute values of matched elements.
      if (name === "ATTR" && hooks.domEx) {
        const parts = rest.split(" :: ");
        return await hooks.domEx({ mode: "attr", query: (parts[0] || "").trim(), attr: (parts[1] || "").trim(), urlMatch });
      }
      // [DOM] <query> — read the target tab's DOM (empty query = page text).
      if (name === "DOM" && hooks.dom) return await hooks.dom(rest.trim(), urlMatch);
      // [TABS] — list open tabs so the master can target the logged-in session.
      if (name === "TABS" && hooks.tabs) return await hooks.tabs();
      // [CLICK] <selector>
      if (name === "CLICK" && hooks.act) return await hooks.act({ action: "click", selector: rest.trim(), urlMatch });
      // [CLICKTEXT] <label> — click by visible text / aria-label (no CSS). For React/headless-ui modals.
      if (name === "CLICKTEXT" && hooks.act) return await hooks.act({ action: "clicktext", value: rest.trim(), urlMatch });
      // [SNAP] — structured DOM snapshot (baseline). [DIFF] <action…> — run action, return only what changed.
      // Optional trailing " :: screenshot" (issue #16) also attaches a visual
      // capture alongside the structured diff — useful when the diff alone
      // can't tell layout breakage / hidden fields / custom-widget rendering.
      if (name === "SNAP" && hooks.act) return await hooks.act({ action: "snap", urlMatch });
      if (name === "DIFF" && hooks.act) {
        const withShot = / :: screenshot\s*$/i.test(rest);
        const code = withShot ? rest.replace(/ :: screenshot\s*$/i, "") : rest;
        return await hooks.act({ action: "diff", code, urlMatch, shot: withShot });
      }
      // [FILL]/[TYPE] <selector> = <value>   (or selector\nvalue)
      // [TYPE] = trusted keystroke-level insert via CDP (falls back to FILL).
      if ((name === "FILL" || name === "TYPE") && hooks.act) {
        const { selector, value } = splitSelVal(rest);
        return await hooks.act({ action: name === "TYPE" ? "type" : "fill", selector, value, urlMatch });
      }
      // [SUBMIT] <selector> — submit a form (or the element's form / click).
      if (name === "SUBMIT" && hooks.act) return await hooks.act({ action: "submit", selector: rest.trim(), urlMatch });
      // [JS] <code> — run JS in the target page, return the result (grading etc.).
      if (name === "JS" && hooks.act) return await hooks.act({ action: "js", code: rest, urlMatch });
      // [HUD] on|off — visual supervision layer on the target tab: glowing
      // working-border, ghost cursor on clicks, on-page action log panel.
      if (name === "HUD" && hooks.act) return await hooks.act({ action: "hud", code: rest.trim() || "on", urlMatch });
      // [SAY] <text> — master's chat reply rendered into the HUD panel.
      if (name === "SAY" && hooks.act) return await hooks.act({ action: "say", code: rest, urlMatch });
      // [OPEN] <url> — open in a new foreground tab (user's session), wait for
      // load, return title+URL. Shows results to the human directly.
      // [OPEN@space:<name>] opens inside that agent Space instead.
      if (name === "OPEN" && hooks.open) return await hooks.open(rest.trim(), urlMatch);
      // [CLOSE] — close the target tab (cleanup after batch [OPEN]/[DOM] work).
      // Routed through hooks.act (like HUD/SAY) since background.js owns tabs.
      if (name === "CLOSE" && hooks.act) return await hooks.act({ action: "close", urlMatch });
      // [SHOT]/[SCREENSHOT] [<relative/path.jpg>] — screenshot the target tab's
      // visible viewport, saved to disk via the same download queue as
      // [DOWNLOAD]. [SCREENSHOT] is the long form tracked in the README
      // roadmap and issue #16; [SHOT] is a short alias for the same action.
      // No "::" separator (unlike DOWNLOAD) — there's no URL argument here,
      // just the optional path, taken as the whole rest of the instruction.
      // Defaults to a timestamped name under webclaw-shots/ if no path given.
      if ((name === "SHOT" || name === "SCREENSHOT") && hooks.act) return await hooks.act({ action: "shot", code: rest.trim(), urlMatch });
    }
    if (opts.noBrain) throw fail("(unknown marker: " + t.slice(0, 60) + ")", "bad_args");
    // default → delegate LLM to the master brain (the master does the thinking).
    if (cfg.brainUrl) {
      const h = { "content-type": "application/json" };
      if (cfg.brainToken) h.authorization = "Bearer " + cfg.brainToken;
      // v0.7.0 — prepend learned site notes for the tab in front of the agent.
      let prompt = instr;
      if (hooks.learnContext) {
        try { const ctx = await hooks.learnContext(); if (ctx) prompt = ctx + "\n\n" + instr; } catch (e) {}
      }
      // mode:"chat" — an LLM-style request; the brain drives the browser only
      // for mode:"goal" (HUD standalone), so a bus task can't recurse into it.
      const r = await fetch(cfg.brainUrl.replace(/\/$/, "") + "/brain/exec", {
        method: "POST", headers: h, body: JSON.stringify({ prompt, mode: "chat" }),
      });
      const j = await r.json();
      return j.output != null ? j.output : JSON.stringify(j);
    }
    return "[webclaw] no brain configured. echo: " + instr;
  }

  root.createWebclaw = createWebclaw;
  root.webclawRunTask = runTask;
  if (typeof module !== "undefined" && module.exports) module.exports = { createWebclaw, runTask, parseCdp };
})(typeof globalThis !== "undefined" ? globalThis : self);
