#!/usr/bin/env node
// webclaw CLI — drive the webclaw browser node from any agent or shell.
//
//   webclaw setup [--standalone] [--ext-dir <dir>] [--force]   one-time config
//   webclaw doctor                  health → auth → nodes → round-trip
//   webclaw nodes                   joined browser nodes
//   webclaw do "<marker>"           one marker, e.g. webclaw do "[OUTLINE]"
//   webclaw run <file.js | ->       [RUN] script from a file or stdin
//   webclaw inbox [--since <seq>]   HUD chat lines from the human
//   webclaw mcp                     MCP server on stdio (claude mcp add webclaw -- webclaw mcp)
//   webclaw serve | up | down       local mini-bus (standalone mode) fg / bg / stop
//   webclaw audit|rec|replay|policy|identity|webmcp|learnings|cdp-url   (v0.9.0)
//   webclaw goal "<goal>" · webclaw brain   System One brain (TypeSafe Jev)   (v0.10.0)
// Common flags: --node <name>  --timeout <s>  --json
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadConfig, saveHomeConfig, HOME_CFG, EXT_CFG, REPO_DIR, STANDALONE_BUS, readJson } = require("../bridge/config.cjs");
const { createClient } = require("../bridge/client.cjs");
const { createMcpServer, VERSION } = require("../bridge/mcp.cjs");
const { ensureMiniBus, stopMiniBus, healthy, LOG_FILE } = require("../bridge/daemon.cjs");

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => { const i = argv.indexOf("--" + name); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : undefined; };
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--") && ["node", "timeout", "since", "ext-dir", "tab", "max-steps", "min-confidence", "save", "port", "brain"].includes(arr[i - 1].slice(2))));

function die(msg, code = 1) { process.stderr.write(msg + "\n"); process.exit(code); }

async function prepared() {
  const cfg = loadConfig();
  if (!cfg.bus || !cfg.secret || !cfg.workKey) die("webclaw is not configured — run: webclaw setup --standalone  (or create " + EXT_CFG + ")");
  if (cfg.mode === "standalone") await ensureMiniBus(cfg);
  return { cfg, client: createClient(cfg) };
}

function print(r) {
  if (flag("json")) return console.log(JSON.stringify(r));
  if (r.status === "done") return console.log(r.output);
  process.stderr.write("[" + (r.reason || r.status) + "] " + r.output + "\n");
  process.exit(1);
}

async function main() {
  if (cmd === "serve") {
    const cfg = loadConfig();
    if (!cfg.secret) die("no secret configured — run: webclaw setup --standalone");
    const { createMiniBus } = require("../bridge/minibus.cjs");
    const bus = createMiniBus({ secret: cfg.secret, workKey: cfg.workKey, version: VERSION, registryFile: require("node:path").join(require("../bridge/config.cjs").HOME_DIR, "registry.json"), log: (m) => console.log(new Date().toISOString() + " " + m) });
    const [host, port] = (cfg.mode === "standalone" ? cfg.bus : STANDALONE_BUS).split(":");
    const p = await bus.listen(Number(port), host);
    console.log("webclaw mini-bus listening on " + host + ":" + p + " (work key " + cfg.workKey + ")");
    const bye = () => bus.close().then(() => process.exit(0));
    process.on("SIGTERM", bye); process.on("SIGINT", bye);
    return;
  }
  if (cmd === "laya") {
    // local Laya server (Apache-2.0 System One model) for `--brain laya`
    const os = require("node:os"), { spawn } = require("node:child_process");
    const home = require("../bridge/config.cjs").HOME_DIR;
    const venv = process.env.LAYA_VENV || path.join(home, "laya-venv");
    const bin = path.join(venv, "bin", "laya-serve");
    const pidFile = path.join(home, "laya.pid"), logFile = path.join(home, "laya-serve.log");
    const url = "http://127.0.0.1:8077";
    const healthy = async () => { try { const r = await fetch(url + "/health", { headers: { authorization: "Bearer " + (process.env.LAYA_API_KEY || "laya-local") }, signal: AbortSignal.timeout(1500) }); return r.ok ? r.json() : null; } catch (e) { return null; } };
    const op = positional[0] || "status";
    if (op === "status") { const h = await healthy(); return console.log(h ? "laya up on " + url + " · loaded " + (h.loaded || []).join(",") + " · device " + h.device : "laya not running — webclaw laya up"); }
    if (op === "down") { try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGTERM"); fs.unlinkSync(pidFile); console.log("laya stopped"); } catch (e) { console.log("(no laya pid file)"); } return; }
    if (op === "up") {
      if (await healthy()) return console.log("laya already up on " + url);
      if (!fs.existsSync(bin)) die("Laya is not installed. Install it once (≈1–2 GB with weights):\n  uv venv --python 3.12 " + venv + " && VIRTUAL_ENV=" + venv + " uv pip install 'laya[serve]'");
      const out = fs.openSync(logFile, "a");
      const child = spawn(bin, [], { detached: true, stdio: ["ignore", out, out], env: Object.assign({}, process.env, {
        LAYA_HOST: "127.0.0.1", LAYA_PORT: "8077", LAYA_API_KEY: process.env.LAYA_API_KEY || "laya-local",
        LAYA_DEVICE: process.env.LAYA_DEVICE || (os.arch() === "arm64" && os.platform() === "darwin" ? "mps" : ""), LAYA_MODELS: process.env.LAYA_MODELS || "multilingual" }) });
      child.unref();
      fs.writeFileSync(pidFile, String(child.pid));
      for (let i = 0; i < 200; i++) { await new Promise((r) => setTimeout(r, 1500)); const h = await healthy(); if (h) return console.log("laya up on " + url + " (device " + h.device + ") — webclaw goal … --brain laya"); }
      die("laya did not come up — see " + logFile);
    }
    die("usage: webclaw laya up|down|status");
  }
  if (cmd === "up") { const { cfg } = await prepared(); return console.log("mini-bus up on " + cfg.bus + " (log " + LOG_FILE + ")"); }
  if (cmd === "down") return console.log(stopMiniBus() ? "mini-bus stopped" : "(no mini-bus pid file)");

  if (cmd === "setup") {
    const standalone = !!flag("standalone");
    const current = readJson(HOME_CFG);
    if (current && !flag("force")) {
      console.log("already configured (" + HOME_CFG + ", mode " + current.mode + ") — use --force to redo");
    } else if (standalone) {
      const cfg = { mode: "standalone", bus: process.env.WEBCLAW_BUS || STANDALONE_BUS, secret: (current && current.secret) || crypto.randomBytes(24).toString("base64url"), workKey: "WK-local" };
      saveHomeConfig(cfg);
      // point the unpacked extension at the mini-bus (keep a backup of the old config)
      const extDir = typeof flag("ext-dir") === "string" ? flag("ext-dir") : REPO_DIR;
      const extCfg = path.join(extDir, "config.local.json");
      if (fs.existsSync(extCfg)) fs.copyFileSync(extCfg, extCfg + ".bak-" + Date.now());
      fs.writeFileSync(extCfg, JSON.stringify({ bus: cfg.bus, secret: cfg.secret, workKey: cfg.workKey, name: "webclaw@local", role: "executor" }, null, 2) + "\n", { mode: 0o600 });
      console.log("standalone mode configured → " + HOME_CFG + "\nextension config written → " + extCfg);
    } else {
      const ext = readJson(EXT_CFG);
      if (!ext || !ext.bus) die("bus mode needs " + EXT_CFG + " (bus/secret/workKey) — or use --standalone");
      saveHomeConfig({ mode: "bus", bus: ext.bus, secret: ext.secret, workKey: ext.workKey });
      console.log("bus mode configured from " + EXT_CFG + " → " + HOME_CFG);
    }
    const bin = path.join(REPO_DIR, "bin", "webclaw.cjs");
    console.log([
      "",
      "Next:",
      "  1. chrome://extensions → reload webclaw (if you connected via the popup before, enter the same Bus/Token/Work Key there)",
      "  2. webclaw doctor",
      "  3. register the MCP server with your agent:",
      "       claude mcp add webclaw -- node " + bin + " mcp",
      "       codex mcp add webclaw -- node " + bin + " mcp",
      "     or JSON: {\"mcpServers\":{\"webclaw\":{\"command\":\"node\",\"args\":[\"" + bin + "\",\"mcp\"]}}}",
    ].join("\n"));
    return;
  }

  if (cmd === "mcp") {
    const cfg = loadConfig();
    const client = createClient(cfg);
    const server = createMcpServer(client, {
      goal: (a) => runGoalWith(cfg, client, { goal: a.goal, tab: a.tab, maxSteps: a.max_steps, save: a.save, node: a.node }),
      prepare: async () => {
        if (!cfg.bus || !cfg.secret || !cfg.workKey) throw new Error("webclaw is not configured — run `webclaw setup --standalone` in a shell");
        if (cfg.mode === "standalone") await ensureMiniBus(cfg);
      },
    });
    process.stderr.write("webclaw MCP " + VERSION + " (" + cfg.mode + " → " + (cfg.bus || "unconfigured") + ")\n");
    return server.serveStdio();
  }

  if (cmd === "doctor") {
    const cfg = loadConfig();
    const step = (ok, label, detail) => console.log((ok ? "✓ " : "✗ ") + label + (detail ? "  " + detail : ""));
    step(!!(cfg.bus && cfg.secret && cfg.workKey), "config", cfg.mode + " · " + (cfg.bus || "?") + " · " + (cfg.workKey || "?") + " · from " + cfg.source);
    if (!cfg.bus) process.exit(1);
    if (cfg.mode === "standalone") { try { await ensureMiniBus(cfg); } catch (e) { step(false, "mini-bus", e.message); process.exit(1); } }
    const h = await healthy(cfg.bus);
    step(!!h, "bus health", h ? JSON.stringify(h) : "no answer on http://" + cfg.bus);
    if (!h) process.exit(1);
    const client = createClient(cfg);
    let ns = [];
    try { ns = await client.nodes(); step(true, "auth + channel join"); } catch (e) { step(false, "auth + channel join", e.message); process.exit(1); }
    const wc = ns.filter((n) => /^webclaw@/.test(n.name));
    step(wc.length > 0, "webclaw nodes", wc.map((n) => n.name + (n.version ? " " + n.version : "")).join(", ") || "none — reload the extension / check its Bus+Token+Work Key");
    if (!wc.length) process.exit(1);
    const t0 = Date.now();
    try {
      const r = await client.dispatch("[RUN] return 'pong';", { node: flag("node") || (wc.length === 1 ? wc[0].name : undefined), timeoutMs: 20000 });
      step(r.status === "done" && /pong/.test(r.output), "round-trip", r.node + " → " + r.output + " (" + (Date.now() - t0) + "ms)");
      process.exit(r.status === "done" ? 0 : 1);
    } catch (e) { step(false, "round-trip", e.message); process.exit(1); }
  }

  const { client } = await prepared();
  const node = typeof flag("node") === "string" ? flag("node") : undefined;
  const timeoutMs = flag("timeout") ? Number(flag("timeout")) * 1000 : undefined;
  if (cmd === "nodes") {
    const ns = await client.nodes();
    if (flag("json")) return console.log(JSON.stringify(ns));
    return console.log(ns.length ? ns.map((n) => n.name + "  machine=" + (n.machine || "?") + (n.version ? "  " + n.version : "")).join("\n") : "(no nodes joined)");
  }
  if (cmd === "do") {
    const marker = positional.join(" ");
    if (!marker) die('usage: webclaw do "<marker line>"');
    return print(await client.dispatch(marker, { node, timeoutMs }));
  }
  if (cmd === "run") {
    const src = positional[0];
    if (!src) die("usage: webclaw run <script.js | ->");
    const code = src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(src, "utf8");
    const tab = typeof flag("tab") === "string" ? "@" + flag("tab") : "";
    return print(await client.dispatch("[RUN" + tab + "] " + code, { node, timeoutMs: timeoutMs || 200000 }));
  }
  if (cmd === "goal") {
    const goal = positional.join(" ");
    if (!goal) die('usage: webclaw goal "<goal with the values to enter>" [--tab <t>] [--max-steps n] [--min-confidence 0.5] [--save domain/name] [--fallback] [--json]');
    const cfg = loadConfig();
    const r = await runGoalWith(cfg, client, {
      goal, tab: typeof flag("tab") === "string" ? flag("tab") : "", maxSteps: Number(flag("max-steps")) || undefined,
      minConfidence: flag("min-confidence") ? Number(flag("min-confidence")) : undefined, save: typeof flag("save") === "string" ? flag("save") : undefined,
      fallback: !!flag("fallback"), onStep: flag("json") ? undefined : (st) => process.stderr.write("  step " + st.i + "  done=" + (st.done != null ? st.done.toFixed(2) : "—") + "  kind[" + st.kind + "]  target[" + st.target + "]" + (st.value ? "  value[" + st.value + "]" : "") + "  (" + st.jevMs + "ms)\n"),
    });
    if (flag("json")) console.log(JSON.stringify(r));
    else console.log(require("../bridge/brain/server.cjs").summarize(r));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "brain") {
    const cfg = loadConfig();
    const { createBrainServer } = require("../bridge/brain/server.cjs");
    const { createJev } = require("../bridge/brain/jev.cjs");
    const provider = typeof flag("brain") === "string" ? flag("brain") : (cfg.jev && cfg.jev.provider);
    const jev = createJev(Object.assign({}, cfg.jev, provider ? { provider } : {}));
    const port = Number(flag("port")) || 4111;
    const srv = createBrainServer({ webclaw: client, jev, token: cfg.brainToken || "", log: (m) => console.log(new Date().toISOString() + " " + m),
      defaults: flag("fallback") && cfg.brainUrl ? { fallback: require("../bridge/brain/agent.cjs").llmFallback(cfg.brainUrl, cfg.brainToken) } : {} });
    await new Promise((r) => srv.listen(port, "127.0.0.1", r));
    console.log("webclaw System One brain on http://127.0.0.1:" + port + "/brain/exec (model " + jev.model + (jev.hasKey ? "" : ", NO API KEY") + ") — set it as the extension's Brain URL");
    await new Promise(() => {});
  }
  if (cmd === "audit") return print(await client.dispatch("[AUDIT] " + (positional[0] || 50), { node, timeoutMs }));
  if (cmd === "rec") return print(await client.dispatch("[REC] " + (positional.join(" ") || "status"), { node, timeoutMs }));
  if (cmd === "replay") return print(await client.dispatch("[REPLAY] " + (positional[0] || ""), { node, timeoutMs }));
  if (cmd === "policy") return print(await client.dispatch("[POLICY]", { node, timeoutMs }));
  if (cmd === "identity") return print(await client.dispatch("[IDENTITY] " + (positional[0] || ""), { node, timeoutMs }));
  if (cmd === "webmcp") {
    const tab = typeof flag("tab") === "string" ? "@" + flag("tab") : "";
    const [op, tool, ...rest] = positional;
    return print(await client.dispatch("[WEBMCP" + tab + "] " + (op === "call" ? "call " + tool + " " + (rest.join(" ") || "{}") : "list"), { node, timeoutMs }));
  }
  if (cmd === "learnings") {
    const [op, arg] = positional;
    if (op === "export") {
      const r = await client.dispatch("[LEARNINGS] export", { node, timeoutMs });
      if (r.status !== "done") return print(r);
      if (arg) { fs.writeFileSync(arg, JSON.stringify(JSON.parse(r.output), null, 2) + "\n"); return console.log("exported → " + arg); }
      return console.log(r.output);
    }
    if (op === "import") {
      if (!arg) die("usage: webclaw learnings import <file.json>");
      return print(await client.dispatch("[LEARNINGS] import\n" + fs.readFileSync(arg, "utf8"), { node, timeoutMs }));
    }
    if (op === "push") {
      const r = await client.dispatch("[LEARNINGS] export", { node, timeoutMs });
      if (r.status !== "done") return print(r);
      const name = arg || "webclaw-learnings";
      const version = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
      const j = await client.registryPublish(name, version, r.output, "webclaw site learnings (" + Object.keys(JSON.parse(r.output)).length + " domains)");
      return console.log("published " + name + "@" + version + (j && j.ok ? "" : " " + JSON.stringify(j)));
    }
    if (op === "pull") {
      const name = arg || "webclaw-learnings";
      const e = await client.registryGet(name);
      return print(await client.dispatch("[LEARNINGS] import\n" + e.content, { node, timeoutMs }));
    }
    die("usage: webclaw learnings export [file] | import <file> | push [name] | pull [name]");
  }
  if (cmd === "cdp-url") {
    const { cfg } = await prepared();
    if (cfg.mode !== "standalone") die("the CDP endpoint lives on the local mini-bus — standalone mode only (webclaw setup --standalone)");
    return console.log("http://" + cfg.bus + "/cdp/" + encodeURIComponent(cfg.secret) + (node ? "?node=" + encodeURIComponent(node) : ""));
  }
  if (cmd === "inbox") {
    const since = flag("since") ? Number(flag("since")) : undefined;
    return console.log(JSON.stringify(await client.inbox(node, since), null, 1));
  }
  die([
    "webclaw " + VERSION + " — drive your real Chrome from any agent",
    "  setup [--standalone] · doctor · nodes · do \"<marker>\" · run <file|-> [--tab <t>] · inbox · mcp · serve|up|down",
    "  audit [n] · rec on|off|status · replay [path] · policy · identity [init] · webmcp list|call <tool> [json]",
    "  learnings export [file]|import <file>|push [name]|pull [name] · cdp-url",
    "  goal \"<goal>\" [--brain jev|laya] [--tab t] [--save d/n] [--fallback] · brain [--port 4111] · laya up|down|status",
    "  flags: --node <name> --timeout <s> --json",
  ].join("\n"), cmd ? 1 : 0);
}

// one-shot commands exit when done (the result subscription socket would keep
// the event loop alive); serve and mcp are long-running
// System One goal loop with Jev (+ optional LLM fallback via the configured brain)
async function runGoalWith(cfg, client, o) {
  const { runGoal, llmFallback } = require("../bridge/brain/agent.cjs");
  const { createJev } = require("../bridge/brain/jev.cjs");
  const provider = typeof flag("brain") === "string" ? flag("brain") : (cfg.jev && cfg.jev.provider);
  const jev = createJev(Object.assign({}, cfg.jev, provider ? { provider } : {}));
  const fallback = o.fallback && cfg.brainUrl ? llmFallback(cfg.brainUrl, cfg.brainToken) : undefined;
  const webclaw = o.node ? { dispatch: (mk, op) => client.dispatch(mk, Object.assign({ node: o.node }, op)) } : client;
  return runGoal(Object.assign({}, o, { webclaw, jev, fallback }));
}

main().then(() => { if (cmd !== "serve" && cmd !== "mcp") process.exit(process.exitCode || 0); }, (e) => die(String((e && e.message) || e)));
