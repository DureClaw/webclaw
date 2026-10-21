#!/usr/bin/env bash
# Official Online-Mind2Web automatic evaluation (WebJudge, o4-mini) on a webclaw run dir.
#   bash bench/online-mind2web/eval.sh bench/online-mind2web/runs/<run-id>
# Uses the upstream evaluator unchanged (github.com/OSU-NLP-Group/Online-Mind2Web, src/run.py),
# pinned to the commit recorded in <run>/eval-manifest.json. Needs OPENAI_API_KEY (.env).
set -euo pipefail
RUN="${1:?usage: eval.sh <run dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a
: "${OPENAI_API_KEY:?OPENAI_API_KEY missing (.env)}"
JUDGE="${JUDGE_MODEL:-o4-mini}"
UP="$HOME/.webclaw/om2w/Online-Mind2Web"; VENV="$HOME/.webclaw/om2w/venv"
if [ ! -d "$UP/.git" ]; then
  git clone --filter=blob:none --sparse https://github.com/OSU-NLP-Group/Online-Mind2Web "$UP"
  git -C "$UP" sparse-checkout set src script requirements.txt data/schema_v2
fi
COMMIT="$(git -C "$UP" rev-parse HEAD)"
if [ ! -x "$VENV/bin/python" ]; then
  uv venv --python 3.11 "$VENV" -q && VIRTUAL_ENV="$VENV" uv pip install -q -r "$UP/requirements.txt" jsonschema
fi
# 1) every result.json must validate against the official v2 schema before it is judged
"$VENV/bin/python" - "$RUN" "$UP/data/schema_v2/schema_v2.json" <<'PY'
import json, sys, glob, os
from jsonschema import Draft202012Validator
run, schema = sys.argv[1], json.load(open(sys.argv[2]))
v = Draft202012Validator(schema); bad = 0
for f in sorted(glob.glob(os.path.join(run, "*", "result.json"))):
    r = json.load(open(f)); errs = list(v.iter_errors(r))
    missing = [s["screenshot"] for s in r.get("action_history", []) if not os.path.exists(os.path.join(os.path.dirname(f), "trajectory", s["screenshot"]))]
    if errs or missing:
        bad += 1; print("INVALID", f, [e.message[:120] for e in errs[:3]], missing[:3])
print("schema check:", "all valid" if not bad else str(bad) + " invalid")
sys.exit(1 if bad else 0)
PY
RUN="$(cd "$RUN" && pwd)"
OUTP="$RUN-webjudge-$JUDGE"   # sibling dir: run.py treats every sub-directory of RUN as a task
mkdir -p "$OUTP"
printf '{"evaluator":"WebJudge_Online_Mind2Web_eval","judge_model":"%s","upstream_commit":"%s","score_threshold":3,"date":"%s"}\n' "$JUDGE" "$COMMIT" "$(date -u +%FT%TZ)" > "$RUN/eval-manifest.json"
cd "$UP"
"$VENV/bin/python" ./src/run.py --mode WebJudge_Online_Mind2Web_eval --model "$JUDGE" \
  --trajectories_dir "$RUN" --api_key "$OPENAI_API_KEY" --output_path "$OUTP" --num_worker 1 --score_threshold 3
node "$HERE/score.cjs" "$RUN" "$OUTP"
