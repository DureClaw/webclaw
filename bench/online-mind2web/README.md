# Online-Mind2Web with webclaw

Leaderboard-format runs of [Online-Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web)
(300 live-site tasks, schema `online-mind2web-v2`, official WebJudge evaluator).

```bash
# once: request access to the gated dataset, then put HF_TOKEN / OPENAI_API_KEY / TYPESAFE_API_KEY in .env
node bench/online-mind2web/fetch.cjs                       # → ~/.webclaw/om2w/*.json (never committed)
CHROME_BIN=".../Google Chrome for Testing" \
  node bench/online-mind2web/run.cjs --tasks ~/.webclaw/om2w/<file>.json --sample 30 --seed 42 --llm sonnet
bash bench/online-mind2web/eval.sh bench/online-mind2web/runs/<run-id>   # schema check → WebJudge (o4-mini) → SCORE.md
```

Rules followed (from the benchmark): start at each task's website, tasks verbatim, one v2 `ActionStep`
per action (action / thought / url / screenshot together, Grammar A verbs), final answer in
`agent_final_answer` and a terminal `TASK_COMPLETE`, a fresh browser profile per task.

Agent: webclaw hands + System One brain (TypeSafe Jev) per step; Claude via `claude -p` (isolated from the
operator's settings, CLAUDE.md, MCP and tools) only for low-confidence steps and the final answer.
Every run writes `manifest.json` (agent, browser, selection seed, task ids) and `run-meta.json`
(per-task time, decisions, fallbacks, Jev tokens); `eval.sh` pins the evaluator commit in `eval-manifest.json`.
