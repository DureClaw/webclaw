#!/usr/bin/env node
// Online-Mind2Web runner for webclaw — produces leaderboard-format (schema v2) trajectories.
//
//   node bench/online-mind2web/run.cjs --tasks ~/.webclaw/om2w/<file>.json \
//        [--sample 30 --seed 42 | --ids id1,id2 | --all] [--llm sonnet] [--jev-model jev-latest] \
//        [--max-steps 25] [--out bench/online-mind2web/runs/<run-id>] [--headed]
//   then: bash bench/online-mind2web/eval.sh <run dir>      (official WebJudge, o4-mini)
//
// Agent = webclaw hands + System One brain (TypeSafe Jev) per step, Claude (claude -p) for
// low-confidence steps and for writing the final answer from the final page. Every task
// gets a fresh Chrome for Testing profile (no cookies, no logins) and starts at the task's
// own website, as the benchmark rules require. Tasks are never modified.
// Needs: CHROME_BIN (Chrome for Testing / Chromium), TYPESAFE_API_KEY, the `claude` CLI.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile, execFileSync } = require("node:child_process");
const ROOT = path.join(__dirname, "..", "..");
for (const f of [path.join(ROOT, ".env"), path.join(os.homedir(), ".webclaw", ".env")]) { try { if (fs.existsSync(f)) process.loadEnvFile(f); } catch (e) {} }
const { createMiniBus } = require("../../bridge/minibus.cjs");
const { createClient } = require("../../bridge/client.cjs");
const { createJev } = require("../../bridge/brain/jev.cjs");
const { runGoal } = require("../../bridge/brain/agent.cjs");

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf("--" + k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : d; };
const CHROME = process.env.CHROME_BIN;
const LLM = arg("llm", "sonnet");
const JEV_MODEL = arg("jev-model", process.env.WEBCLAW_JEV_MODEL || "jev-latest");
const MAX_STEPS = Number(arg("max-steps", 25));
const TASK_DEADLINE_MS = Number(arg("task-timeout", 420)) * 1000;
const RUN_ID = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "-webclaw-jev";
const OUT = path.resolve(String(arg("out", path.join(__dirname, "runs", RUN_ID))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── tasks ────────────────────────────────────────────────────────────────────
function loadTasks(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return list.map((t) => ({
    id: String(t.task_id || t.id).replace(/^tasks\//, ""),
    task: t.confirmed_task || t.task || t.instruction,
    website: t.website || t.start_url || t.url,
    level: String(t.level || t.difficulty || "unknown").toLowerCase(),
    reference_length: Number(t.reference_length || t.reference_steps || 1) || 1,
  })).filter((t) => t.id && t.task && t.website);
}
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// stratified by level, seeded — the pilot sample is reproducible from (file, seed, n)
function sample(tasks, n, seed) {
  const r = rng(seed), by = {};
  for (const t of tasks) (by[t.level] = by[t.level] || []).push(t);
  const levels = Object.keys(by).sort();
  for (const l of levels) by[l].sort((a, b) => a.id.localeCompare(b.id)).forEach((t) => (t._k = r())), by[l].sort((a, b) => a._k - b._k);
  const out = [];
  for (let i = 0; out.length < n && i < tasks.length; i++) for (const l of levels) if (out.length < n && by[l][i]) out.push(by[l][i]);
  return out;
}

// ── LLM (Claude CLI) ─────────────────────────────────────────────────────────
function claude(prompt, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // isolated from the operator's own Claude setup (CLAUDE.md, settings, MCP servers, tools) so the
    // agent is reproducible; English, as the benchmark and its judge are English
    execFile("claude", ["-p", "--model", LLM, "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--tools", "",
      "--system-prompt", "You are a component of a web-agent benchmark harness. Follow the user message exactly. Always answer in English.", prompt],
      { timeout: timeoutMs, maxBuffer: 4 << 20, cwd: os.tmpdir() }, (err, stdout) => resolve({ text: String(stdout || "").trim(), ms: Date.now() - t0, err }));
  });
}
const stats = { llmCalls: 0, llmMs: 0 };
async function claudeDecide(s) {
  const prompt = [
    "You control a web browser to accomplish a task. Pick the single next action.",
    "Task: " + s.goal, "Page: " + s.page.title + " | " + s.page.url,
    "Page text (excerpt):", String(s.text || "").slice(0, 3000),
    "Interactive elements:", ...s.elements.slice(0, 200),
    "History:", ...(s.history.length ? s.history : ["(none)"]),
    'Reply with ONLY JSON: {"kind":"click|type|select|scroll|press_enter|back|done","target":"@N","value":"text"} — target for click/type/select, value for type/select. Use "done" only when the page already shows the task\'s end result.',
  ].join("\n");
  const r = await claude(prompt);
  stats.llmCalls++; stats.llmMs += r.ms;
  const m = r.text.match(/\{[\s\S]*?\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch (e) { return null; }
}
async function claudeAnswer(task, page, history, outcome) {
  const prompt = [
    "A browser agent worked on this task. Using ONLY the evidence below, write the agent's final answer in 1-3 sentences:",
    "report the requested information if it is visible, or state what was done/displayed. If the evidence does not show the task was completed, say so plainly. No speculation.",
    "Task: " + task, "Agent outcome: " + outcome, "Final page: " + page.title + " | " + page.url,
    "Final page text (excerpt):", String(page.text || "").slice(0, 6000),
    "Actions taken:", ...history,
  ].join("\n");
  const r = await claude(prompt);
  stats.llmCalls++; stats.llmMs += r.ms;
  return r.text || null;
}

// ── browser per task ────────────────────────────────────────────────────────
let EXT = null;
function prepareExtension(busPort, secret, tmp) {
  const ext = path.join(tmp, "ext");
  fs.cpSync(ROOT, ext, { recursive: true, filter: (p) => !/[/\\](\.git|\.claude|node_modules|test|bench|\.env)([/\\]|$)/.test(p.slice(ROOT.length)) && !/config\.local\.json$/.test(p) });
  fs.writeFileSync(path.join(ext, "config.local.json"), JSON.stringify({ bus: "127.0.0.1:" + busPort, secret, workKey: "WK-om2w", name: "webclaw@om2w" }));
  return ext;
}
function chromeVersion() { try { return execFileSync(CHROME, ["--version"]).toString().trim(); } catch (e) { return "unknown"; } }
function launch(profile) {
  const ver = (chromeVersion().match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1] || "150.0.0.0";
  // a regular desktop UA (headless Chrome advertises "HeadlessChrome"); window = viewport for screenshots
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + ver + " Safari/537.36";
  const flags = ["--user-data-dir=" + profile, "--load-extension=" + EXT, "--disable-extensions-except=" + EXT, "--no-first-run", "--no-default-browser-check",
    "--window-size=1280,900", "--user-agent=" + ua, "--lang=en-US", "about:blank"];
  if (!arg("headed")) flags.unshift("--headless=new");
  return spawn(CHROME, flags, { stdio: "ignore" });
}

const grammarTarget = (el) => el ? "[role=" + JSON.stringify(el.role) + "][name=" + JSON.stringify(el.name.slice(0, 60)) + "]" : "page";
function actionString(a, ok) {
  const st = ok ? "SUCCESS" : "FAILED";
  if (a.kind === "click") return "CLICK " + grammarTarget(a.el) + " -> click " + a.el.role + " " + JSON.stringify(a.el.name.slice(0, 80)) + " | " + st;
  if (a.kind === "type") return "TYPE " + grammarTarget(a.el) + " -> " + (a.secret ? "type a password" : "type " + JSON.stringify(a.value)) + " | " + st;
  if (a.kind === "select") return "SELECT " + grammarTarget(a.el) + " -> select " + JSON.stringify(a.value) + " | " + st;
  if (a.kind === "scroll") return "SCROLL page -> scroll down | " + st;
  if (a.kind === "press_enter") return "PRESS_KEY page -> press Enter | " + st;
  if (a.kind === "back") return "page -> GO_BACK -> return to the previous page | " + st;
  return "WAIT page -> wait for the page to update";
}
const thoughtOf = (d) => d ? ("System One decision (" + (d.source || "jev") + "): kind[" + d.kind + "] target[" + (d.target || "") + "]" + (d.value ? " value[" + d.value + "]" : "") + " done=" + (d.done != null ? Number(d.done).toFixed(2) : "?")) : null;

async function runTask(t, bus, client, jev) {
  const dir = path.join(OUT, t.id), traj = path.join(dir, "trajectory");
  fs.mkdirSync(traj, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "om2w-prof-"));
  const chrome = launch(profile);
  const steps = [];
  const meta = { task_id: t.id, level: t.level, started: new Date().toISOString() };
  const T = (m, ms) => client.dispatch(m, { timeoutMs: ms || 60000 });
  const shot = async () => {
    const r = await T('[CDP@space:om2w] Page.captureScreenshot {"format":"jpeg","quality":80}', 30000);
    if (r.status !== "done") return null;
    try { const b = JSON.parse(r.output).data; const name = String(steps.length).padStart(4, "0") + ".jpg"; fs.writeFileSync(path.join(traj, name), Buffer.from(b, "base64")); return name; } catch (e) { return null; }
  };
  const pageNow = async () => {
    const d = await T("[DOM@space:om2w]");
    const lines = String(d.output || "").split("\n");
    const [title, url] = (lines[0] || "").split(" | ");
    return { title: title || "", url: (url || "").trim(), text: lines.slice(1).join("\n") };
  };
  try {
    let joined = false;
    for (let i = 0; i < 60 && !joined; i++) { try { joined = (await client.nodes()).some((n) => /^webclaw@om2w/.test(n.name)); } catch (e) {} if (!joined) await sleep(500); }
    if (!joined) throw new Error("extension did not join");
    await sleep(1500);
    await T("[SPACE] om2w");
    const open = await T("[OPEN@space:om2w] " + t.website, 90000);
    await sleep(1500);
    const p0 = await pageNow();
    steps.push({ step: 0, screenshot: await shot(), url: p0.url || t.website, action: "page -> NAVIGATE -> Initial navigation to the provided URL", action_status: null, thought: "Navigating to the initial URL provided by the task." });
    if (open.status !== "done") meta.openError = open.output;
    let pending = null;
    const g = await runGoal({
      webclaw: client, jev, goal: t.task, tab: "space:om2w", maxSteps: MAX_STEPS, deadlineMs: TASK_DEADLINE_MS, fallback: claudeDecide,
      beforeAction: async (a) => { const s = await shot(); pending = { a, screenshot: s, url: a.url }; },
      afterAction: async ({ ok }) => {
        if (!pending) return;
        const st = ok ? "SUCCESS" : "FAILED";
        steps.push({ step: steps.length, screenshot: pending.screenshot, url: pending.url, action: actionString(pending.a, ok), action_status: pending.a.kind === "wait" ? null : st, thought: thoughtOf(pending.a.decision) });
        pending = null;
      },
    });
    if (pending) steps.push({ step: steps.length, screenshot: pending.screenshot, url: pending.url, action: actionString(pending.a, true), action_status: null, thought: thoughtOf(pending.a.decision) });
    const fin = await pageNow();
    const answer = await claudeAnswer(t.task, fin, g.history.map((h, i) => (i + 1) + ". " + h.kind + " " + (h.label || "") + (h.value ? " ← " + h.value : "") + " → " + h.result), g.ok ? "finished (" + g.reason + ")" : "stopped (" + g.reason + ")");
    steps.push({ step: steps.length, screenshot: await shot(), url: fin.url, action: "TASK_COMPLETE -> ANSWER: " + (answer || ""), action_status: null, thought: g.ok ? "The page shows the task's end result." : "Stopped: " + g.reason + (g.detail ? " — " + String(g.detail).slice(0, 200) : "") });
    Object.assign(meta, { ok: g.ok, reason: g.reason, decisions: g.stats.decisions, actions: g.actions.length, jevMs: g.stats.jevMs, browserMs: g.stats.browserMs, inputTokens: g.stats.inputTokens, fallbacks: g.stats.fallbacks, totalMs: g.stats.totalMs, answer });
    // drop steps whose screenshot failed — the schema requires every referenced file to exist
    const kept = steps.filter((s) => s.screenshot).map((s, i) => Object.assign(s, { step: i }));
    const renamed = kept.map((s, i) => { const n = String(i).padStart(4, "0") + ".jpg"; if (s.screenshot !== n) fs.renameSync(path.join(traj, s.screenshot), path.join(traj, n + ".tmp")); return Object.assign(s, { screenshot: n }); });
    for (const f of fs.readdirSync(traj)) if (f.endsWith(".tmp")) fs.renameSync(path.join(traj, f), path.join(traj, f.slice(0, -4)));
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ schema_version: "online-mind2web-v2", task: t.task, task_id: t.id, agent_final_answer: answer, reference_length: t.reference_length, action_history: renamed }, null, 2) + "\n");
  } catch (e) {
    meta.error = String(e.message || e);
    // still leave a valid (failed) attempt so the task is scored, not silently dropped
    if (!fs.existsSync(path.join(dir, "result.json")) && steps.length) {
      const kept = steps.filter((s) => s.screenshot);
      if (kept.length) fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ schema_version: "online-mind2web-v2", task: t.task, task_id: t.id, agent_final_answer: null, reference_length: t.reference_length,
        action_history: kept.map((s, i) => Object.assign(s, { step: i })) }, null, 2) + "\n");
    }
  } finally {
    chrome.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  meta.finished = new Date().toISOString();
  return meta;
}

(async () => {
  if (!CHROME) { console.error("set CHROME_BIN to Chrome for Testing / Chromium"); process.exit(1); }
  if (!process.env.TYPESAFE_API_KEY) { console.error("TYPESAFE_API_KEY missing (.env)"); process.exit(1); }
  const file = String(arg("tasks", ""));
  if (!file || !fs.existsSync(file)) { console.error("--tasks <Online-Mind2Web json> (run fetch.cjs first)"); process.exit(1); }
  let tasks = loadTasks(file);
  const total = tasks.length;
  if (arg("ids")) { const ids = new Set(String(arg("ids")).split(",")); tasks = tasks.filter((t) => ids.has(t.id)); }
  else if (!arg("all")) tasks = sample(tasks, Number(arg("sample", 30)), Number(arg("seed", 42)));
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "om2w-"));
  const secret = "om2w-" + Math.random().toString(36).slice(2, 14) + "-local-bus";
  const bus = createMiniBus({ secret, workKey: "WK-om2w" });
  const busPort = await bus.listen(0, "127.0.0.1");
  EXT = prepareExtension(busPort, secret, tmp);
  const client = createClient({ bus: "127.0.0.1:" + busPort, secret, workKey: "WK-om2w" });
  const jev = createJev({ model: JEV_MODEL });
  const manifest = {
    benchmark: "Online-Mind2Web", schema: "online-mind2web-v2", run_id: path.basename(OUT), date: new Date().toISOString(),
    agent: "webclaw " + require("../../manifest.json").version + " + System One brain (TypeSafe " + JEV_MODEL + ") + Claude (" + LLM + ", claude -p isolated: no user settings/CLAUDE.md/MCP/tools) fallback & final answer",
    browser: chromeVersion() + (arg("headed") ? " headed" : " headless=new") + ", 1280x900, fresh profile per task, desktop UA",
    selection: arg("ids") ? "explicit ids" : arg("all") ? "all " + total : "stratified sample n=" + tasks.length + " seed=" + Number(arg("seed", 42)) + " of " + total,
    max_steps: MAX_STEPS, task_timeout_s: TASK_DEADLINE_MS / 1000, tasks_file: path.basename(file), task_ids: tasks.map((t) => t.id),
  };
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("run " + manifest.run_id + " — " + tasks.length + " task(s) → " + OUT);
  const metas = [];
  for (const [i, t] of tasks.entries()) {
    process.stdout.write("[" + (i + 1) + "/" + tasks.length + "] " + t.level + " " + t.id + " … ");
    const m = await runTask(t, bus, client, jev);
    metas.push(m);
    fs.writeFileSync(path.join(OUT, "run-meta.json"), JSON.stringify({ manifest, stats, tasks: metas }, null, 2) + "\n");
    console.log((m.error ? "ERROR " + m.error : (m.ok ? "agent:done" : "agent:stopped(" + m.reason + ")")) + " · " + Math.round((m.totalMs || 0) / 1000) + "s · " + (m.decisions || 0) + " decisions · " + (m.fallbacks || 0) + " fallbacks");
  }
  client.close(); await bus.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log("done. next: bash bench/online-mind2web/eval.sh " + OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
