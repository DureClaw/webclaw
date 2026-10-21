// webclaw bridge client — talks to a bus (DureClaw bus or the local mini-bus)
// over the REST surface both share, and reads presence through the channel
// (the real bus's REST /api/presence can come back empty).
"use strict";
const os = require("node:os");

function createClient(cfg) {
  const base = "http://" + cfg.bus;
  const headers = { authorization: "Bearer " + cfg.secret, "content-type": "application/json" };
  // every REST call is bounded — a hung bus must not hang the CLI / MCP forever
  const T_SHORT = 10000, T_LONG = 30000;
  const get = (p, ms = T_SHORT) => fetch(base + p, { headers, signal: AbortSignal.timeout(ms) });
  const post = (p, body, ms = T_LONG) => fetch(base + p, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });

  async function health() {
    const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(3000) });
    return r.json();
  }

  // Joined nodes for the work key: [{ name, machine, role, version, online_since }]
  function nodes(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const me = "webclaw-bridge@" + os.hostname() + "-" + process.pid;
      const ws = new WebSocket("ws://" + cfg.bus + "/socket/websocket?vsn=2.0.0&token=" + encodeURIComponent(cfg.secret));
      const t = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("no join reply from " + cfg.bus + " within " + timeoutMs + "ms")); }, timeoutMs);
      ws.onerror = () => { clearTimeout(t); try { ws.close(); } catch (e) {} reject(new Error("cannot connect to ws://" + cfg.bus + " (bus down or wrong secret)")); };
      ws.onopen = () => ws.send(JSON.stringify(["1", "1", "work:" + cfg.workKey, "phx_join", { agent_name: me, role: "observer" }]));
      ws.onmessage = (ev) => {
        let f; try { f = JSON.parse(ev.data); } catch (e) { return; }
        if (!Array.isArray(f) || f[3] !== "phx_reply" || f[1] !== "1" || !f[4]) return;
        clearTimeout(t);
        try { ws.close(); } catch (e) {}
        if (f[4].status !== "ok") return reject(new Error("join refused: " + JSON.stringify(f[4].response)));
        const pres = (f[4].response || {}).presences || {};
        resolve(Object.entries(pres).filter(([n]) => n !== me).map(([name, v]) => Object.assign({ name }, (v.metas || [])[0] || {})));
      };
    });
  }

  // Which node to send to: explicit > config > the single joined webclaw node.
  async function resolveNode(explicit) {
    if (explicit) return explicit;
    if (cfg.node) return cfg.node;
    const ns = (await nodes()).filter((n) => /^webclaw@/.test(n.name));
    if (ns.length === 1) return ns[0].name;
    if (!ns.length) throw Object.assign(new Error("no webclaw node joined work:" + cfg.workKey + " — is the extension connected to " + cfg.bus + "?"), { reason: "no_node" });
    throw Object.assign(new Error("several webclaw nodes joined (" + ns.map((n) => n.name).join(", ") + ") — pass node=<name>"), { reason: "ambiguous_node" });
  }

  // Results arrive as task.result broadcasts on the work channel (both the
  // DureClaw bus and the mini-bus) — listen there instead of polling REST,
  // which quantized every round-trip to the poll interval. REST polling stays
  // as the fallback (slow, every 2 s) if the socket isn't available.
  let sub = null; // Promise<{ ws, waiters: Map }>
  function subscribe() {
    if (sub) return sub;
    const mine = new Promise((resolve, reject) => {
      const me = "webclaw-bridge-sub@" + os.hostname() + "-" + process.pid + "-" + Math.random().toString(36).slice(2, 6);
      const ws = new WebSocket("ws://" + cfg.bus + "/socket/websocket?vsn=2.0.0&token=" + encodeURIComponent(cfg.secret));
      const waiters = new Map();
      const shut = () => { try { ws.close(); } catch (e) {} };
      const t = setTimeout(() => { shut(); reject(new Error("subscribe timeout")); }, 4000);
      let hb = null;
      ws.onerror = () => { clearTimeout(t); shut(); reject(new Error("subscribe failed")); };
      // only forget the subscription if it is still this one (a newer one may exist)
      ws.onclose = () => { clearTimeout(t); clearInterval(hb); if (sub === mine) sub = null; reject(new Error("subscription closed")); };
      ws.onopen = () => ws.send(JSON.stringify(["s1", "s1", "work:" + cfg.workKey, "phx_join", { agent_name: me, role: "observer" }]));
      ws.onmessage = (ev) => {
        let f; try { f = JSON.parse(ev.data); } catch (e) { return; }
        if (f[3] === "phx_reply" && f[1] === "s1") {
          clearTimeout(t);
          hb = setInterval(() => { try { ws.send(JSON.stringify([null, "hb", "phoenix", "heartbeat", {}])); } catch (e) {} }, 15000);
          if (hb.unref) hb.unref();
          return resolve({ ws, waiters });
        }
        if (Array.isArray(f) && f[3] === "task.result" && f[4] && waiters.has(f[4].task_id)) waiters.get(f[4].task_id)(f[4]);
      };
    });
    sub = mine;
    mine.catch(() => { if (sub === mine) sub = null; });
    return mine;
  }
  function close() { if (sub) sub.then((s) => { try { s.ws.close(); } catch (e) {} }, () => {}); sub = null; }

  // Send one marker line and wait for its task.result.
  // → { status, output, exit_code, reason?, node, task_id }
  async function dispatch(instructions, opts = {}) {
    const node = await resolveNode(opts.node);
    const taskId = "wcb-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    let s = null;
    try { s = await subscribe(); } catch (e) { s = null; }
    let pushed = null;
    const viaPush = s ? new Promise((res) => { pushed = res; s.waiters.set(taskId, res); }) : null;
    let r;
    try {
      r = await post("/api/task", { to: node, role: "executor", work_key: cfg.workKey, task_id: taskId, instructions });
    } catch (e) { if (s) s.waiters.delete(taskId); throw e; }
    if (r.status === 401) throw Object.assign(new Error("bus rejected the secret (401)"), { reason: "unauthorized" });
    if (!r.ok) throw new Error("bus refused the task: HTTP " + r.status + " " + (await r.text()).slice(0, 200));
    // older buses ignore our task_id and return their own — wait on that one
    const id = (await r.json()).task_id || taskId;
    const deadline = Date.now() + (opts.timeoutMs || 60000);
    const shape = (res) => ({ status: res.status, output: String(res.output), exit_code: res.exit_code, reason: res.reason, node, task_id: id });
    if (s && id !== taskId) { s.waiters.delete(taskId); s.waiters.set(id, pushed); }
    if (viaPush) {
      // push first; REST every 2 s as a safety net (e.g. a missed broadcast)
      while (Date.now() < deadline) {
        const hit = await Promise.race([viaPush, new Promise((res) => setTimeout(() => res(null), Math.min(2000, Math.max(0, deadline - Date.now()))))]);
        if (hit) { s.waiters.delete(id); return shape(hit); }
        const p = await get("/api/task/" + encodeURIComponent(id)).catch(() => null);
        if (p && p.status === 200) {
          const j = await p.json();
          const res = Array.isArray(j.results) ? j.results.filter((x) => !x.event || x.event === "task.result").pop() : j;
          if (res && res.output !== undefined) { s.waiters.delete(id); return shape(res); }
        }
      }
      s.waiters.delete(id);
      return { status: "timeout", output: "(no result within " + Math.round((opts.timeoutMs || 60000) / 1000) + "s — the node may still be working)", reason: "timeout", node, task_id: id };
    }
    let wait = 250;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, wait));
      wait = Math.min(wait * 1.5, 1500);
      const p = await get("/api/task/" + encodeURIComponent(id)).catch(() => null);
      if (!p || p.status !== 200) continue;
      const j = await p.json();
      const res = Array.isArray(j.results) ? j.results.filter((x) => !x.event || x.event === "task.result").pop() : j;
      if (!res || res.output === undefined) continue;
      return shape(res);
    }
    return { status: "timeout", output: "(no result within " + Math.round((opts.timeoutMs || 60000) / 1000) + "s — the node may still be working)", reason: "timeout", node, task_id: id };
  }

  // HUD chat lines the human typed (fleet inbox slot "hud-inbox-<node>").
  async function inbox(node, sinceSeq) {
    const n = await resolveNode(node);
    const p = await get("/api/task/" + encodeURIComponent("hud-inbox-" + n));
    if (p.status !== 200) return [];
    const j = await p.json();
    const list = Array.isArray(j.results) ? j.results : [j];
    return list.map((x) => { try { return JSON.parse(x.output); } catch (e) { return null; } })
      .filter((x) => x && (!sinceSeq || x.seq > sinceSeq));
  }

  // Skill registry (DureClaw bus ≥ registry build, or the mini-bus) — used to
  // share learnings. Throws reason "no_registry" when the bus lacks the API.
  async function registryPublish(name, version, content, description) {
    const r = await post("/api/skill-registry/publish", { name, version, content, description: description || "", published_by: "webclaw-cli" });
    if (r.status === 404) throw Object.assign(new Error("this bus has no skill registry (/api/skill-registry) — use `webclaw learnings export/import` with a file"), { reason: "no_registry" });
    if (!r.ok) throw new Error("registry publish failed: HTTP " + r.status + " " + (await r.text()).slice(0, 200));
    return r.json();
  }
  async function registryGet(name) {
    const r = await get("/api/skill-registry/download/" + encodeURIComponent(name), T_LONG);
    if (r.status === 404) {
      const probe = await get("/api/skill-registry");
      throw Object.assign(new Error(probe.status === 404 ? "this bus has no skill registry" : "no registry entry named " + name), { reason: probe.status === 404 ? "no_registry" : "not_found" });
    }
    if (!r.ok) throw new Error("registry download failed: HTTP " + r.status);
    return r.json();
  }

  return { health, nodes, resolveNode, dispatch, inbox, registryPublish, registryGet, close };
}

module.exports = { createClient };
