#!/usr/bin/env node
// webclaw benchmark runner — same 10 deterministic tasks, three strategies:
//   step  : one marker per round-trip (outline → @ref → act), like a tool-calling agent
//   run   : the whole task as one [RUN] script (one round-trip)
//   relay : Puppeteer through the CDP relay (standalone mode, needs puppeteer-core)
// Metrics per task: success, wall time (median of --reps), round-trips, bytes
// returned to the agent (≈ tokens × 4). No LLM is involved — this measures the
// browser-tool layer an agent pays for on every turn, not agent reasoning.
//
//   node bench/run.cjs [--reps 3] [--strategies step,run,relay] [--label "<env>"] [--out bench/results]
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { loadConfig } = require("../bridge/config.cjs");
const { createClient } = require("../bridge/client.cjs");
const { ensureMiniBus } = require("../bridge/daemon.cjs");
const { cdpToken } = require("../bridge/minibus.cjs");
const TASKS = require("./tasks.cjs");

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const REPS = Number(arg("reps", 3));
const STRATS = arg("strategies", "step,run,relay").split(",");
const OUT = path.resolve(arg("out", path.join(__dirname, "results")));
const LABEL = arg("label", "");
const SITE = path.join(__dirname, "site");
const UPLOAD = path.join(SITE, "upload-sample.txt");
const SPACE = "bench";

function serve(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = path.join(SITE, path.basename(req.url.split("?")[0]));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(fs.readFileSync(f));
    }).listen(port, "127.0.0.1", () => resolve(srv));
  });
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
// put a tab target into a marker: "[DOM] x" → "[DOM@space:bench] x"
const target = (marker, t) => marker.replace(/^\[([A-Za-z?]+)(@[^\]]*)?\]/, (m0, n, at) => (at ? m0 : "[" + n + "@" + t + "]"));

async function main() {
  const cfg = loadConfig();
  if (cfg.mode === "standalone") await ensureMiniBus(cfg);
  const client = createClient(cfg);
  const servers = [await serve(4811), await serve(4812)];
  const url = (t) => "http://127.0.0.1:4811/" + t.page;

  const mk = (spaceTarget, counter) => ({
    uploadFile: UPLOAD,
    async m(marker) {
      const r = await client.dispatch(target(marker, spaceTarget), { timeoutMs: 60000 });
      if (counter) { counter.trips++; counter.bytes += r.output.length; }
      if (r.status !== "done") throw new Error("[" + (r.reason || r.status) + "] " + marker.split("\n")[0] + " → " + r.output.slice(0, 200));
      return r.output;
    },
  });
  const quiet = mk("space:" + SPACE, null);

  await client.dispatch("[SPACE] " + SPACE);
  let browser = null;
  if (STRATS.includes("relay")) {
    try {
      const puppeteer = require(process.env.PUPPETEER_PATH || "puppeteer-core");
      const cdpUrl = "http://" + cfg.bus + "/cdp/" + cdpToken(cfg.secret); // CDP-only token, never the secret
      browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null, protocolTimeout: 60000 });
    } catch (e) { console.error("relay strategy skipped: " + e.message.split("\n")[0]); }
  }

  const rows = [];
  for (const t of TASKS) {
    for (const strat of STRATS) {
      if (strat === "relay" && !browser) continue;
      const runs = [];
      for (let rep = 0; rep < REPS; rep++) {
        const c = { trips: 0, bytes: 0 };
        let ok = false, err = "", ms = 0;
        try {
          if (strat === "relay") {
            const page = await browser.newPage();
            await page.goto(url(t), { waitUntil: "load" });
            const t0 = Date.now();
            await t.relay(page, { uploadFile: UPLOAD });
            ms = Date.now() - t0;
            ok = await t.verify(mk("space:cdp", null));
            await page.close();
          } else {
            await quiet.m("[OPEN@space:" + SPACE + "] " + url(t));
            const A = mk("space:" + SPACE, c);
            const t0 = Date.now();
            if (strat === "step") await t.step(A);
            else await A.m("[RUN] " + (typeof t.run === "function" ? t.run(A) : t.run));
            ms = Date.now() - t0;
            ok = await t.verify(quiet);
            await quiet.m("[CLOSE]");
          }
        } catch (e) { err = String(e.message || e).split("\n")[0]; try { await quiet.m("[CLOSE]"); } catch (e2) {} }
        runs.push({ ok, ms, trips: c.trips, bytes: c.bytes, err });
        process.stdout.write((ok ? "." : "x"));
      }
      const okRuns = runs.filter((r) => r.ok);
      rows.push({ task: t.id, title: t.title, strategy: strat, success: okRuns.length + "/" + runs.length,
        ms: median(okRuns.map((r) => r.ms)), trips: median(runs.map((r) => r.trips)), bytes: median(runs.map((r) => r.bytes)),
        errors: [...new Set(runs.filter((r) => !r.ok).map((r) => r.err))] });
    }
  }
  console.log("");
  if (browser) await browser.disconnect();
  servers.forEach((s) => s.close());
  client.close();

  // ---- report ----
  fs.mkdirSync(OUT, { recursive: true });
  const meta = { date: new Date().toISOString(), webclaw: require("../manifest.json").version, node: process.version, reps: REPS, mode: cfg.mode, label: LABEL };
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ meta, rows }, null, 2) + "\n");
  const sum = (s, k) => rows.filter((r) => r.strategy === s && r[k] != null).reduce((a, r) => a + r[k], 0);
  const succ = (s) => { const rs = rows.filter((r) => r.strategy === s); const ok = rs.reduce((a, r) => a + Number(r.success.split("/")[0]), 0); const all = rs.reduce((a, r) => a + Number(r.success.split("/")[1]), 0); return all ? ok + "/" + all + " (" + Math.round((100 * ok) / all) + "%)" : "—"; };
  const strats = STRATS.filter((s) => rows.some((r) => r.strategy === s));
  const fmt = (r) => r ? r.success + " · " + (r.ms != null ? r.ms + " ms" : "—") + (r.strategy !== "relay" ? " · " + r.trips + " rt · " + (r.bytes / 1024).toFixed(1) + " KB" : "") : "—";
  const md = [
    "# webclaw benchmark results",
    "",
    "- date: " + meta.date + " · webclaw " + meta.webclaw + " · node " + meta.node + " · mode " + meta.mode + (LABEL ? " · " + LABEL : ""),
    "- " + TASKS.length + " deterministic local tasks × " + REPS + " reps; time = median of successful reps, measured after the page loaded",
    "- rt = round-trips (each one is an agent turn in a tool-calling loop) · KB = bytes returned to the agent (÷4 ≈ tokens)",
    "- no LLM involved: this isolates the browser-tool layer; it is not comparable 1:1 with LLM-in-the-loop benchmarks",
    "",
    "| task | " + strats.join(" | ") + " |",
    "|---|" + strats.map(() => "---").join("|") + "|",
    ...TASKS.map((t) => "| " + t.id + " — " + t.title + " | " + strats.map((s) => fmt(rows.find((r) => r.task === t.id && r.strategy === s))).join(" | ") + " |"),
    "| **total** | " + strats.map((s) => "**" + succ(s) + " · " + sum(s, "ms") + " ms" + (s !== "relay" ? " · " + sum(s, "trips") + " rt · " + (sum(s, "bytes") / 1024).toFixed(1) + " KB" : "") + "**").join(" | ") + " |",
    "",
  ];
  const errs = rows.filter((r) => r.errors.length);
  if (errs.length) md.push("## failures", "", ...errs.map((r) => "- " + r.task + " / " + r.strategy + ": " + r.errors.join(" · ")), "");
  fs.writeFileSync(path.join(OUT, "RESULTS.md"), md.join("\n"));
  console.log(md.join("\n"));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
