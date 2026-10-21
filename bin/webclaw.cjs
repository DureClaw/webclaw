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
// Flags are declared: VALUE_FLAGS take the next argument (or --name=value);
// every other --flag is boolean and never swallows a positional.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadConfig, saveHomeConfig, writeSecretFile, copySecretFile, HOME_CFG, EXT_CFG, REPO_DIR, STANDALONE_BUS, readJson } = require("../bridge/config.cjs");
const { createClient } = require("../bridge/client.cjs");
const { createMcpServer, VERSION } = require("../bridge/mcp.cjs");
const { ensureMiniBus, stopMiniBus, healthy, LOG_FILE } = require("../bridge/daemon.cjs");

const VALUE_FLAGS = new Set(["node", "timeout", "since", "ext-dir", "tab", "max-steps", "min-confidence", "save", "port", "brain"]);

// argv → { cmd, positional, flags }. Pure (unit-tested). "--" ends flag parsing.
function parseArgs(args) {
  const flags = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) { flags[name] = a.slice(eq + 1); continue; }
      if (VALUE_FLAGS.has(name)) {
        const v = args[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Error("--" + name + " needs a value");
        flags[name] = v; i++;
      } else flags[name] = true;
      continue;
    }
    pos.push(a);
  }
  return { cmd: pos[0], positional: pos.slice(1), flags };
}

// is url the local System One brain server itself (→ --fallback would recurse)?
function isSelfBrain(url, port) {
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const local = ["localhost", "::1", "0.0.0.0", "::"].includes(host) || /^127\./.test(host);
  const p = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  return local && p === Number(port);
}

// the LLM brain behind --fallback: config brain.fallbackUrl, never ourselves
function resolveFallback(cfg, port) {
  const url = (cfg.brain && cfg.brain.fallbackUrl) || "";
  if (!url) throw new Error("--fallback needs an LLM brain: set \"brain\": {\"fallbackUrl\": \"http://…\", \"fallbackToken\": \"…\"} in " + HOME_CFG + " (or WEBCLAW_BRAIN_FALLBACK_URL)");
  if (isSelfBrain(url, port)) throw new Error("refusing --fallback: brain.fallbackUrl " + url + " is this System One brain server (http://127.0.0.1:" + port + ") — it would call itself");
  return { url, token: (cfg.brain && cfg.brain.fallbackToken) || "" };
}

let cmd, positional = [], flags = {};
const flag = (name) => flags[name];

function die(msg, code = 1) { process.stderr.write(msg + "\n"); process.exit(code); }

async function prepared() {
  const cfg = loadConfig();
  if (!cfg.bus || !cfg.secret || !cfg.workKey) die("webclaw is not configured — run: webclaw setup --standalone  (or create " + EXT_CFG + ")");
  if (cfg.mode === "standalone") await ensureMiniBus(cfg);
  return { cfg, client: createClient(cfg) };
}

// result → stdout (or stderr on failure); exit code 1 whenever status !== done, --json included
function print(r) {
  if (r.status !== "done") process.exitCode = 1;
  if (flag("json")) return console.log(JSON.stringify(r));
  if (r.status === "done") return console.log(r.output);
  process.stderr.write("[" + (r.reason || r.status) + "] " + r.output + "\n");
}

async function main() {
  if (cmd === "serve") {
    const cfg = loadConfig();
    if (!cfg.secret) die("no secret configured — run: webclaw setup --standalone");
    const { createMiniBus } = require("../bridge/minibus.cjs");
    const allowRemote = !!flag("allow-remote") || process.env.WEBCLAW_ALLOW_REMOTE === "1";
    const bus = createMiniBus({ secret: cfg.secret, workKey: cfg.workKey, version: VERSION, allowRemote, registryFile: require("node:path").join(require("../bridge/config.cjs").HOME_DIR, "registry.json"), log: (m) => console.log(new Date().toISOString() + " " + m) });
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
    const newToken = () => crypto.randomBytes(24).toString("base64url");
    // the extension config: --ext-dir <dir> (unpacked extension elsewhere) or this repo
    const extDir = typeof flag("ext-dir") === "string" ? flag("ext-dir") : REPO_DIR;
    const extCfg = path.join(extDir, "config.local.json");
    const extNow = readJson(extCfg);
    // keep the user's brain/Jev settings across --force
    const keep = current ? Object.fromEntries(["jev", "brain", "node"].filter((k) => current[k] !== undefined).map((k) => [k, current[k]])) : {};
    // write the extension config, backing up the old one (both 0600)
    const writeExt = (obj) => {
      if (fs.existsSync(extCfg)) copySecretFile(extCfg, extCfg + ".bak-" + Date.now());
      writeSecretFile(extCfg, JSON.stringify(obj, null, 2) + "\n");
    };
    if (current && !flag("force")) {
      if (!current.brainToken) {
        current.brainToken = (extNow && extNow.brainToken) || newToken();
        saveHomeConfig(current);
        console.log("brain token generated → " + HOME_CFG);
      }
      if (current.mode === "standalone" && extNow && extNow.brainToken !== current.brainToken) {
        writeExt(Object.assign({}, extNow, { brainToken: current.brainToken }));
        console.log("brain token written → " + extCfg);
      }
      if (fs.existsSync(extCfg)) fs.chmodSync(extCfg, 0o600);
      fs.chmodSync(HOME_CFG, 0o600);
      console.log("already configured (" + HOME_CFG + ", mode " + current.mode + ") — use --force to redo");
    } else if (standalone) {
      const brainToken = (current && current.brainToken) || newToken();
      const cfg = Object.assign(keep, { mode: "standalone", bus: process.env.WEBCLAW_BUS || STANDALONE_BUS, secret: (current && current.secret) || crypto.randomBytes(24).toString("base64url"), workKey: "WK-local", brainToken });
      saveHomeConfig(cfg);
      // point the unpacked extension at the mini-bus (keep a backup of the old config)
      writeExt({ bus: cfg.bus, secret: cfg.secret, workKey: cfg.workKey, name: "webclaw@local", role: "executor", brainToken });
      console.log("standalone mode configured → " + HOME_CFG + "\nextension config written → " + extCfg);
    } else {
      const ext = extNow;
      if (!ext || !ext.bus) die("bus mode needs " + extCfg + " (bus/secret/workKey) — or use --standalone");
      const brainToken = (current && current.brainToken) || ext.brainToken || newToken();
      saveHomeConfig(Object.assign(keep, { mode: "bus", bus: ext.bus, secret: ext.secret, workKey: ext.workKey, brainToken }));
      fs.chmodSync(extCfg, 0o600);
      console.log("bus mode configured from " + extCfg + " → " + HOME_CFG);
      if (ext.brainToken !== brainToken) console.log("brain token stored in " + HOME_CFG + " — if you run `webclaw brain`, enter it as the extension's Brain Token");
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

  if (!cmd) usage();
  if (cmd === "brain" && !loadConfig().brainToken && !flag("insecure-no-token")) die("refusing to start the brain without a token — run `webclaw setup` (it generates brainToken) or pass --insecure-no-token");
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
      node, brainPort: Number(flag("port")) || 4111, fallback: !!flag("fallback"), onStep: flag("json") ? undefined : (st) => process.stderr.write("  step " + st.i + "  done=" + (st.done != null ? st.done.toFixed(2) : "—") + "  kind[" + st.kind + "]  target[" + st.target + "]" + (st.value ? "  value[" + st.value + "]" : "") + "  (" + st.jevMs + "ms)\n"),
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
    const token = cfg.brainToken || "";
    if (!token) process.stderr.write("WARNING: brain server without a token — any local process or web page can drive your browser\n");
    const fb = flag("fallback") ? resolveFallback(cfg, port) : null;
    const webclaw = node ? { dispatch: (mk, op) => client.dispatch(mk, Object.assign({ node }, op)) } : client;
    const srv = createBrainServer({ webclaw, jev, token, log: (m) => console.log(new Date().toISOString() + " " + m),
      defaults: fb ? { fallback: require("../bridge/brain/agent.cjs").llmFallback(fb.url, fb.token) } : {} });
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
    // a CDP-only token derived from the secret — the master secret never goes into a URL
    const { cdpToken } = require("../bridge/minibus.cjs");
    return console.log("http://" + cfg.bus + "/cdp/" + cdpToken(cfg.secret) + (node ? "?node=" + encodeURIComponent(node) : ""));
  }
  if (cmd === "inbox") {
    const since = flag("since") ? Number(flag("since")) : undefined;
    return console.log(JSON.stringify(await client.inbox(node, since), null, 1));
  }
  usage();
}

function usage() {
  die([
    "webclaw " + VERSION + " — drive your real Chrome from any agent",
    "  setup [--standalone] · doctor · nodes · do \"<marker>\" · run <file|-> [--tab <t>] · inbox · mcp · serve|up|down",
    "  audit [n] · rec on|off|status · replay [path] · policy · identity [init] · webmcp list|call <tool> [json]",
    "  learnings export [file]|import <file>|push [name]|pull [name] · cdp-url",
    "  goal \"<goal>\" [--brain jev|laya] [--tab t] [--save d/n] [--fallback] · brain [--port 4111] [--fallback] [--insecure-no-token] · laya up|down|status",
    "  serve [--allow-remote] · flags: --node <name> --timeout <s> --json",
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
  const fb = o.fallback ? resolveFallback(cfg, o.brainPort || 4111) : null;
  const fallback = fb ? llmFallback(fb.url, fb.token) : undefined;
  const webclaw = o.node ? { dispatch: (mk, op) => client.dispatch(mk, Object.assign({ node: o.node }, op)) } : client;
  return runGoal(Object.assign({}, o, { webclaw, jev, fallback }));
}

module.exports = { parseArgs, isSelfBrain, resolveFallback, VALUE_FLAGS };

if (require.main === module) {
  try { ({ cmd, positional, flags } = parseArgs(process.argv.slice(2))); } catch (e) { die(e.message); }
  // flush stdout before exiting (pipes are async on macOS; results can be MBs)
  main().then(() => { if (cmd !== "serve" && cmd !== "mcp") process.stdout.write("", () => process.exit(process.exitCode || 0)); }, (e) => die(String((e && e.message) || e)));
}
