#!/usr/bin/env node
// Score a run: official WebJudge labels (predicted_label) joined with the run's task list.
// Tasks without a judged result count as failures. Prints success by level + agent cost/time.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const [run, judged] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(path.join(run, "run-meta.json"), "utf8"));
const em = fs.existsSync(path.join(run, "eval-manifest.json")) ? JSON.parse(fs.readFileSync(path.join(run, "eval-manifest.json"), "utf8")) : {};
const labels = {};
for (const f of fs.existsSync(judged || "") ? fs.readdirSync(judged).filter((x) => x.endsWith("_auto_eval_results.json")) : [])
  for (const line of fs.readFileSync(path.join(judged, f), "utf8").split("\n").filter(Boolean)) { const j = JSON.parse(line); labels[j.task_id] = j.predicted_label; }
const rows = meta.tasks.map((t) => ({ ...t, judged: labels[t.task_id] }));
const by = {};
for (const r of rows) { const k = r.level; by[k] = by[k] || { n: 0, ok: 0 }; by[k].n++; if (r.judged === 1) by[k].ok++; }
const all = { n: rows.length, ok: rows.filter((r) => r.judged === 1).length };
const pct = (a) => (a.n ? ((100 * a.ok) / a.n).toFixed(1) + "%" : "—");
const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const lines = [
  "# Online-Mind2Web — " + meta.manifest.run_id,
  "",
  "- agent: " + meta.manifest.agent,
  "- browser: " + meta.manifest.browser,
  "- selection: " + meta.manifest.selection + " · max steps " + meta.manifest.max_steps,
  "- judge: " + (em.evaluator || "?") + " / " + (em.judge_model || "?") + " · upstream " + String(em.upstream_commit || "?").slice(0, 10) + " · threshold " + (em.score_threshold || "?"),
  "",
  "| level | tasks | success (WebJudge) |",
  "|---|---|---|",
  ...Object.keys(by).sort().map((k) => "| " + k + " | " + by[k].n + " | " + by[k].ok + " (" + pct(by[k]) + ") |"),
  "| **all** | **" + all.n + "** | **" + all.ok + " (" + pct(all) + ")** |",
  "",
  "| agent metric | total | per task |",
  "|---|---|---|",
  "| wall time | " + Math.round(sum("totalMs") / 1000) + " s | " + (sum("totalMs") / 1000 / Math.max(1, rows.length)).toFixed(1) + " s |",
  "| System One decisions | " + sum("decisions") + " | " + (sum("decisions") / Math.max(1, rows.length)).toFixed(1) + " |",
  "| Jev model time | " + Math.round(sum("jevMs") / 1000) + " s | — |",
  "| Jev input tokens | " + sum("inputTokens") + " | ≈ $" + ((sum("inputTokens") * 0.042) / 1e6).toFixed(4) + " total |",
  "| LLM fallback steps | " + sum("fallbacks") + " | — |",
  "| LLM calls (incl. final answers) | " + (meta.stats.llmCalls || 0) + " | " + Math.round((meta.stats.llmMs || 0) / 1000) + " s total |",
  "| runner errors | " + rows.filter((r) => r.error).length + " | — |",
  "| not judged (counted as failure) | " + rows.filter((r) => r.judged == null).length + " | — |",
];
fs.writeFileSync(path.join(run, "SCORE.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
