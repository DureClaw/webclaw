// Connection check: which nodes are joined to a work key right now.
// Zero dependencies (Node 22+ global WebSocket). The REST /api/presence can
// come back empty even while nodes are connected, so this asks the channel
// itself: the phx_join reply carries the live presence list.
//
//   node test/presence.cjs [work_key ...]
//   env: BUS (default 127.0.0.1:4000), OAH_SECRET (default: config.local.json
//        "secret", else ~/.oah-server/data/server.secret)
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return {}; } }
const local = readJson(path.join(__dirname, "..", "config.local.json"));
let secret = process.env.OAH_SECRET || local.secret || "";
if (!secret) { try { secret = fs.readFileSync(path.join(os.homedir(), ".oah-server/data/server.secret"), "utf8").trim(); } catch (e) {} }
const bus = process.env.BUS || local.bus || "127.0.0.1:4000";
const keys = process.argv.slice(2).length ? process.argv.slice(2) : [local.workKey].filter(Boolean);
if (!keys.length) { console.error("usage: node test/presence.cjs <work_key> [...]"); process.exit(2); }

const ME = "presence-check@" + os.hostname();
const ws = new WebSocket("ws://" + bus + "/socket/websocket?vsn=2.0.0&token=" + encodeURIComponent(secret));
let pending = keys.length;
const timer = setTimeout(() => { console.error("timeout — no join reply from " + bus + " (bus down, wrong secret, or blocked)"); process.exit(1); }, 5000);
ws.onerror = () => { console.error("cannot connect to ws://" + bus + " (bus down or wrong secret → 403)"); process.exit(1); };
ws.onopen = () => keys.forEach((k, i) => ws.send(JSON.stringify([String(i + 1), String(i + 1), "work:" + k, "phx_join", { agent_name: ME, role: "observer" }])));
ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data);
  if (f[3] !== "phx_reply") return;
  const r = f[4] || {};
  if (r.status !== "ok") console.log(f[2] + "  join refused: " + JSON.stringify(r.response));
  else {
    const nodes = Object.entries((r.response || {}).presences || {}).filter(([n]) => n !== ME);
    console.log(f[2] + "  " + (nodes.length ? nodes.length + " node(s)" : "(no nodes)"));
    for (const [n, v] of nodes) {
      const m = (v.metas || [])[0] || {};
      console.log("  - " + n + "  machine=" + (m.machine || "?") + "  role=" + (m.role || "?") + (m.version ? "  " + m.version : "") + (m.online_since ? "  since " + m.online_since : ""));
    }
  }
  if (--pending === 0) { clearTimeout(timer); ws.close(); process.exit(0); }
};
