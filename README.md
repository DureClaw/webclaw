# webclaw

> The **DureClaw browser node** — a Chrome (MV3) extension that joins a
> [DureClaw](https://github.com/DureClaw/dureclaw) fleet from your browser.
> **The master brings the brain; this node brings browser hands.** Zero-install for
> users, always-on, **CORS-free**.

## Why an extension (not a web page)

| | web page (tab) | **extension (this)** |
|---|---|---|
| CORS | bound to page origin | ✅ **bypassed** via `host_permissions` — master needs no CORS cooperation |
| persistence | dies on tab close | ✅ **always-on** background (offscreen document holds the socket) |
| hands | one page's DOM | ✅ fetch + any-tab DOM/click/fill/JS/screenshot |

The bus speaks plain WebSocket + JSON frames, so webclaw is **pure JS — no build, no wasm**.
The same `core.js` runs in the extension *and* in Node (see `test/`).

## How it works

```
DureClaw bus ──task.assign──▶ webclaw (offscreen WS) ──▶ task.result
```

### Marker vocabulary

`[NAME]` runs against the active tab; `[NAME@<url-substring>]` targets a specific tab
(e.g. `[DOM@lms.example.com] table.grades` picks the tab whose URL contains that
substring — the logged-in session — instead of the active one).

- `[FETCH] <url>` — extension fetch, bypasses page CORS (`host_permissions`).
- `[DOWNLOAD] <url> [:: <relative/path.ext>]` — real browser download to disk (session
  cookies included), waits for completion. `[DOWNLOAD?] <id>` re-queries a long-running
  one; `[CANCEL] <id|all>` stops it.
- `[DOM] <css?>` — read a tab's DOM (empty = full page text). `[LINKS] <css?>` — anchors
  as `[{text, href}]`. `[ATTR] <css> :: <attribute>` — attribute values of matches.
- `[TABS]` — list open tabs, to find the logged-in one.
- `[CLICK] <css>` — click an element. `[CLICKTEXT] <label>` — click by visible
  text/`aria-label` (no CSS, ghost cursor) — for React/modal buttons without stable
  selectors.
- `[SNAP]` — structured DOM snapshot (baseline: fields/buttons/errors/text).
  `[DIFF] clicktext:<label>|click:<sel>` — run that action, return only what changed vs.
  the last `[SNAP]` — state judgment without a screenshot. Append `" :: screenshot"`
  (e.g. `[DIFF] click:#submit :: screenshot`) to also attach a visual capture alongside
  the structured diff, for cases the diff alone can't judge (layout breakage, hidden
  fields, custom-widget rendering).
- `[FILL]`/`[TYPE] <css>\n<value>` — set an input's value (+ `input`/`change` events),
  **selector and value separated by a newline** — required when the selector itself
  contains `=`, e.g. an attribute selector like `input[name="company"]`. The shorthand
  `<css> = <value>` (space-equals-space) still works, but only use it when the selector
  has no `=` of its own.
- `[SUBMIT] <css>` — submit a form (or the element's `.form`, or click it).
- `[JS] <code>` — run JS in the page (async/`await` supported), return the result.
- `[SHOT]`/`[SCREENSHOT] [<relative/path.jpg>]` — capture the target tab's visible
  viewport, saved to disk (defaults to a timestamped name under `webclaw-shots/`).
- `[HUD] on|off` — visual supervision layer on the target tab (glowing working-border,
  ghost cursor, on-page action log + two-way chat).
- `[SAY] <text>` — master's chat reply rendered into the HUD panel.
- `[OPEN] <url>` — open a new foreground tab (user's session), wait for load, return
  title+URL. `[CLOSE]` — close the target tab (cleanup after batch `[OPEN]`/`[DOM]` runs).
- default (no marker) — delegate to the **master brain** (`Brain URL`), keyless to the
  page — the browser holds no model and no API cost. Learned site notes for the tab in
  front of the agent (see `[LEARN]`) are prepended to the prompt.

### Native access, refs, scripts, spaces, learnings (v0.7.0)

webclaw now also drives the tab through the **Chrome DevTools Protocol** (`chrome.debugger`),
the same channel ego-lite's native bindings use. CDP is an *upgrade, never a requirement*:
when it is unavailable (`"cdp": "off"` in config, a foreign debugger attached, or the human
dismissed Chrome's "started debugging" bar — respected for 10 min per tab) every marker
falls back to the scripting path. Sessions auto-detach after 30 s idle so the bar goes away.

- `[CLICK]` — real trusted mouse events (`isTrusted: true`) when the element's center is not
  covered by an overlay; otherwise the scripted `el.click()`. Output says `(trusted)`.
- `[TYPE] <css|@ref>\n<text>` — trusted text insertion (`Input.insertText`) + read-back.
  `[FILL]` keeps the old value-setter behavior.
- `[SHOT]` — CDP capture first: background tabs, no focus stealing (`(cdp)` in output).
- `[JS]` — if page CSP blocks eval, retried via CDP `Runtime.evaluate` (no eval involved).
- `[UPLOAD] <css|@ref> :: <abs path>[, <abs path>…]` — set a file input (CDP only).
- `[CDP] Domain.method {json}` — raw protocol on the target tab. Credential dumps and
  out-of-tab domains (`Network.getAllCookies`, `Storage.getCookies`, `Browser.*`,
  `Target.*`, `SystemInfo.*`) are refused (`reason: cdp_denied`; override with `cdpDeny`).
- `[OUTLINE]`/`[SNAPSHOT] [max]` — interactive elements of **every frame** (cross-origin
  iframes, open shadow roots) as numbered refs: `@12 button "Sign in"`. Any selector
  argument (`[CLICK]`, `[FILL]`, `[TYPE]`, `[DOM]`, `[ATTR]`, `[UPLOAD]`, `[WAIT]`,
  `[DIFF] click:@N`) accepts `@N`. Refs die with their document → `reason: stale_ref`,
  re-run `[OUTLINE]`.
- `[WAIT] <css|@ref|text:<label>> [:: ms]` — until present & visible (default 10 s;
  `reason: timeout`).
- `[RUN] <js>` — **a whole workflow in one round-trip** (ego-style code instead of one
  marker per task). The body is an async function running in the extension sandbox
  (page CSP irrelevant) with helpers injected: `open, outline, dom, links, attr, click,
  clickText, fill, type, submit, upload, wait, js, cdp, shot, snap, diff, close, tabs,
  fetchText, download, say, learned, space, useSpace, useTab, handOff, log, sleep,
  marker`. Each helper is one marker through the same code path as a bus task; a failed
  marker throws with `e.reason`. Returns `{"result": …, "log": […]}`; 180 s timeout.
  ```
  [RUN@shop.example.com]
  await click('@4'); await type('@7', 'webclaw'); await wait('text:Results');
  return await links('.result a');
  ```
- **Spaces** — `[SPACE] <name>` creates/selects a tab group in a separate, **unfocused**
  agent window; markers without `@` then target it, so the human's tab, focus and mouse
  are never taken. `[OPEN]` opens inside it. Per-marker: `[CLICK@space:<name>] …`
  (scripts: `useSpace(name)` / `space(name)`, so parallel scripts don't collide).
  `[SPACES]` lists, `[SPACE] off` releases, `[SPACE] close <name>` closes its tabs.
- **Hand-off** — `[HANDOFF] [name] [:: note]` gives a space to the human (focuses it, HUD
  shows the note, group turns 🙋). Mutating markers on it fail with `reason: handed_off`
  (reads still work) until the human types `/done` in the HUD chat (the master gets an
  inbox message) or the master sends `[TAKEOVER] [name]`.
- **Site learnings** — reusable per-domain experience: `{notes, selectors, recipes}`.
  Bundled in `learnings/<domain>.json` (listed in `learnings/index.json`), learned at
  runtime with `[LEARN] <domain>\n<json>` (merged), shown by `[LEARNED] [domain|url]`,
  removed by `[FORGET] <domain>`. `[RECIPE] <domain>/<name> [\n<json args>]` runs a
  stored `[RUN]` script with `args`.

### Other notable behaviors

- Joins the bus, presence + heartbeat (offscreen document → survives MV3 idle).
- **Read _and act_**: `[DOM]`/`[JS]` read; `[CLICK]`/`[FILL]`/`[SUBMIT]` interact — real form input, not just scraping.
- **Distinct nodes per profile**: each Chrome profile registers as `webclaw@chrome-<id>`, so two profiles don't collide on one name and both answer the same task. Use `[TABS]` to see which node holds the logged-in session.
- Output cap raised to ~2 MB (was 1.5 KB) — full tables/pages come back.

## Install (load unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Click the **webclaw** toolbar icon → fill in **Bus**, **Token**, **Work Key**,
   **Brain URL/token** → **Connect to fleet**

> Tip: copy `config.local.json.example` → `config.local.json` (gitignored) to **auto-connect on load** — no popup typing.

The node appears in the fleet's presence; a master can fan-out tasks to it, and the
popup shows a live task feed.

## Use from any agent — MCP · CLI · skill (v0.8.0)

No DureClaw server required: **standalone mode** runs a tiny local bus (`127.0.0.1:4777`,
loopback-only, secret-protected, refuses WebSocket upgrades from web-page origins) that the
extension joins like a real bus. Zero npm dependencies, Node 22+.

```bash
node bin/webclaw.cjs setup --standalone   # writes ~/.webclaw/config.json + the extension's config.local.json
# chrome://extensions → reload webclaw (popup-saved settings win over config.local.json — enter the same values there)
node bin/webclaw.cjs doctor               # ✓ config ✓ bus health ✓ auth + join ✓ webclaw nodes ✓ round-trip
claude mcp add webclaw -- node "$PWD/bin/webclaw.cjs" mcp
codex  mcp add webclaw -- node "$PWD/bin/webclaw.cjs" mcp
npx skills add DureClaw/webclaw           # agent-facing guide: skills/webclaw/SKILL.md
```

Already on a DureClaw bus? `webclaw setup` (bus mode) reuses `config.local.json`; everything
below works the same against either bus. The mini-bus auto-starts in the background on first
use (`webclaw up` / `down`, log in `~/.webclaw/minibus.log`).

**MCP tools** — `webclaw_nodes`, `webclaw_tabs`, `webclaw_open` {url, space}, `webclaw_outline`,
`webclaw_click` {target: "@N"|css}, `webclaw_type`, `webclaw_read`, `webclaw_run` {script},
`webclaw_marker` (any marker: `[SPACE]`, `[HANDOFF]`, `[SHOT]`, `[WAIT]`, `[CDP]`…),
`webclaw_say`, `webclaw_inbox` (the human's HUD chat, e.g. `/done` after a hand-off),
`webclaw_webmcp_list`/`_call`, `webclaw_audit`, `webclaw_goal` (System One brain) — 15 tools. Each tool
is one marker; failures return `isError` with `[reason] …`. `tab` = URL substring or
`space:<name>`; `node` picks a browser when several are joined (one is auto-selected).

**CLI** — `webclaw nodes` · `webclaw do "<marker>"` · `webclaw run flow.js [--tab space:job]` ·
`webclaw inbox` · `--node`, `--timeout`, `--json`. Exit code 1 + `[reason]` on stderr on failure
(also with `--json`). Flags may come before or after the command; boolean flags never take a value.

## Guard rails, replay, relay, WebMCP, identity (v0.9.0)

**Policy & approval (human-set only)** — popup "🛡️ 정책" or `config.local.json` `"policy"`;
markers can read it (`[POLICY]`), never change it.
- `deny: [domains]` — off-limits for reads, actions, `[OPEN]`, `[FETCH]`, `[DOWNLOAD]`, relay (`reason: policy_denied`).
- `mode: "ask"` — the first mutating action per site asks for approval: the page HUD announces it,
  the toolbar icon shows a badge, and the human answers in the **side panel / popup** (Allow once ·
  Allow site for this browser session · Deny) — *never* in the page, which a site's own scripts could
  forge (`approval_denied`; 120 s → `approval_timeout`). `allow: [domains]` skips asking. Reads are never gated.
- Policy written in `config.local.json` is a floor: its deny list is unioned with the popup's, so the
  popup can't silently drop file-denied hosts. The deny list also covers redirects (`[FETCH]`/`[DOWNLOAD]`
  final URL), iframes (outline, @refs), and relay events/child sessions.
- `confirmRisky: true` — pay / delete / transfer-looking clicks & submits (결제·삭제·송금…) ask every
  time, incl. `[DIFF] clicktext:…`, `[CDP] Input.*` and the whole `[JS]` body.
- Typed/filled values are never echoed into the HUD, audit log or recorder (only the length), and HUD
  history is cleared when a tab changes origin.
- **Audit log** — every handled marker, result, reason and approval: `[AUDIT] [n]` (ring buffer of 1000).

**Recording / replay** — `[REC] on [label]` … `[REC] off`, then `[REPLAY] [path.html]`: a
self-contained HTML timeline (time, action, target, result, a screenshot per step) saved to Downloads.

**CDP modes** — `prefs.cdp`: `auto` (default — trusted input, background capture), `minimal`
(CDP only when required — `[CDP]`, `[UPLOAD]`, CSP-blocked `[JS]` — and detach right after, so the
"debugging" bar only flashes for those moments), `off`.

**CDP endpoint (standalone)** — unmodified CDP clients drive the node through the mini-bus:
```js
const url = execSync("webclaw cdp-url").toString().trim();   // http://127.0.0.1:4777/cdp/<cdp-token> (HMAC of the bus secret, CDP-only)
const browser = await puppeteer.connect({ browserURL: url, defaultViewport: null });
const page = await browser.newPage();                         // opens in the agent Space "cdp"
// or: const browser = await chromium.connectOverCDP(url); const page = await browser.contexts()[0].newPage();
```
Browser-level `Target`/`Browser` domains are emulated; page traffic goes through `chrome.debugger`
with real target ids (Playwright needs target id == main frame id). Exposes only the "cdp" Space's
tabs unless `prefs.relayScope = "all"`; new browser contexts are refused (it's the real profile);
`Browser.close` only disconnects. Raw-`[CDP]` deny list + policy deny list apply.

**Learnings, shared** — a `[RUN]` whose first line is `// @save <domain>/<name>` saves itself as a
recipe once it succeeds. `[LEARNINGS] export | import\n<json>`; CLI `webclaw learnings export [file]
| import <file> | push [name] | pull [name]` (push/pull use the bus skill registry
`/api/skill-registry` — the mini-bus implements it; buses without it get a clear `no_registry`).

**WebMCP relay** — a MAIN-world shim records tools a page registers via `navigator.modelContext`
(wrapping native WebMCP, polyfilling it otherwise); `[WEBMCP] list` / `[WEBMCP] call <tool> {json}`
(MCP: `webclaw_webmcp_list` / `webclaw_webmcp_call`) relay them to *any* agent. `prefs.webmcp = "off"` disables.

**Agent identity** — `[IDENTITY] init` creates an Ed25519 key; with `identity.on` (popup) the
extension's own `[FETCH]` requests carry Web Bot Auth style HTTP Message Signatures
(`Signature-Input`/`Signature`/`Signature-Agent`, RFC 9421, `tag="web-bot-auth"`); `[IDENTITY]`
prints the key directory to host at `/.well-known/http-message-signatures-directory`. Page
navigations are not signed (an extension can't sign per-request navigation headers); the draft is
still moving, so the field set is provisional.

## System One brain — Jev instead of an LLM per step (v0.10.0)

LLM turns are the slow part of a browser agent. `webclaw goal` runs a goal loop where each step is
**one structured decision** by [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
(TypeSafe's System One model: typed choices with calibrated probabilities, 70–500 ms per call per
the vendor) instead of a generated LLM reply:

```
[OUTLINE] → state {goal, page, elements(@refs), history}
→ ONE request, questions in parallel: done (noul) · kind (click|type|select|wait|need_human)
  · target (choice over ≤240 @refs; 16 for Laya) · value (choice over values found in the goal)
→ confidence gate: < 0.5 → LLM fallback (--fallback → brain.fallbackUrl, validated) or stop;
  pay/delete-looking targets need ≥ 0.85, fallback picks included → otherwise needs_confirmation;
  a "done" before any action needs ≥ 0.95 plus a page-grounded check → else done_without_action
→ one marker ([CLICK]/[TYPE]/[FILL]) → repeat; 3 identical actions without progress → stuck
```
Jev can't write text, so **values to type must appear in the goal** (quoted, emails, numbers,
"as X", codes like KR) — it picks which one goes where. On success, `--save domain/name` turns the
path into a `[RUN]` recipe that replays by role + name (+ occurrence) with **no model at all**.
Recipes store **no values**: typed/selected values become `args.v1…` (password fields `args.password`),
checked before the first action — replay with `[RECIPE] domain/name\n{"v1": "…"}`.

```bash
export TYPESAFE_API_KEY=…            # or ~/.webclaw/config.json {"jev": {"apiKey": "…", "model": "jev-latest"}}
webclaw goal 'Log in as alice with password "s3cret"' --tab space:job --save example.com/login
webclaw brain --port 4111            # serves /brain/exec → set as the extension's Brain URL (HUD chat)
                                     # needs the brainToken that `webclaw setup` generated; only mode:"goal"
                                     # requests from the extension drive the browser (Wide Worker chat is ignored)
```
MCP: `webclaw_goal {goal, tab, save}`. Jev is a hosted API — page outlines are sent to TypeSafe
(deny-listed sites are never read, so never sent).

Measured in a real browser (bench fixtures, Chrome for Testing 153 headless) — **Jev is a stand-in
here** (no API key in the test environment: a mock with the same API contract answering in 150 ms,
the low end of the vendor's range); the LLM row is a real model:

| task | System One loop (mock Jev 150 ms) | LLM per step (`claude -p --model haiku`) | recipe replay (no model) |
|---|---|---|---|
| login (3 actions) | 0.70 s · 4 decisions | 67.1 s · 6 decisions | — |
| search (2) | 0.53 s · 3 | 39.6 s · 4 | — |
| modal (2) | 0.53 s · 3 | 29.6 s · 3 | — |
| wizard (6) | 1.26 s · 7 | — | 0.15 s |

**Real Jev (measured 2026-10-22, same 5 fixture tasks)** — jev-latest and jev-preview each completed
**4/5** goals (≈1.0–1.1 s per task, ≈230 ms per decision, ≈16k input tokens ≈ $0.0007 for all five).
Every action on all five tasks was correct; the one stop is the wizard, whose final page shows only a
code with no confirmation text, so the grounded "done" check declined and the loop stopped
(`low_confidence`) instead of claiming success. Results: `bench/results/brain-e2e-real-*.json`.

**Laya (local, open source)** — `webclaw laya up` runs [Laya](https://github.com/NandhaKishorM/laya)'s
`laya-serve` (same `/v1/systemone` protocol, Apache-2.0) on this Mac (MPS); `webclaw goal … --brain laya`
keeps page content on the machine. Measured: ~0.16–0.7 s per decision, but the shipped checkpoints
are **not usable zero-shot** for page actions — near-random choices, and the default multilingual one
answers "done" at 1.00 from the start. The loop stops with `done_without_action` / `low_confidence`
instead of acting (a "done" before any action must pass a page-grounded check a yes-biased model can't).
Fine-tuning on webclaw decisions is the next step.

Loop overhead outside the model is ~25–35 ms per decision. The LLM column includes `claude -p`
process start-up (≈10 s per decision end to end), so it overstates raw API latency; even so,
per-step LLM decisions are seconds where System One decisions are hundreds of milliseconds.
Real-Jev accuracy on these pages is **not measured yet** (needs a key) — details in
[docs/report-system-one-brain-2026-10.md](docs/report-system-one-brain-2026-10.md).

### Benchmark

`node bench/run.cjs` — 10 deterministic local tasks (form login, search+extract, 3-step wizard,
controlled input, cross-origin iframe, shadow DOM, pagination, upload, late content, modal) × 3 reps,
three strategies; results in [bench/results/RESULTS.md](bench/results/RESULTS.md). Latest
(Chrome for Testing 153 headless, macOS arm64):

| strategy | success | time (sum of medians) | round-trips | bytes to the agent |
|---|---|---|---|---|
| step — one marker per tool call (outline → @ref → act) | 30/30 | 2154 ms | 41 | 3.2 KB |
| run — whole task as one `[RUN]` | 30/30 | 2020 ms | **10** | **0.4 KB** |
| relay — Puppeteer via the CDP endpoint | 30/30 | 2221 ms | (CDP) | — |

Tool-layer latency is now ~10 ms per round-trip (results are pushed over the bus socket — the
first run, still REST-polling, measured 12.3 s for `step`); the real cost difference in an agent
loop is the **4× fewer turns and 8× fewer bytes** of `[RUN]`. No LLM is involved, so this is not
comparable 1:1 with LLM-in-the-loop benchmarks such as ego's.

## Tests

```bash
npm test           # offline: unit + hardening regression tests (119), no bus, no browser
npm run test:e2e   # real browser smoke — needs CHROME_BIN = Chrome for Testing / Chromium (≈5 s)
```

`test/core.unit.test.cjs` runs `core.js` against a fake bus WebSocket (Node's built-in
`node:test`, zero dependencies) to cover marker parsing/routing and the
`status`/`exit_code`/`reason` failure-elevation path without any network access;
`test/runner.unit.test.cjs` covers the `[RUN]` script host (helper → marker mapping,
failure reasons, args); `test/bridge.unit.test.cjs` runs a real `core.js` node against an
in-process mini-bus and exercises the REST client, auth/origin refusal and the MCP server
end to end; `test/brain.unit.test.cjs` runs the System One goal loop against a mock Jev oracle
(gating, fallback, stuck detection, recipes, the /brain/exec contract); `test/v09.unit.test.cjs` covers Web Bot Auth signing (incl. the RFC 8037 thumbprint
vector), the v0.9 markers, the registry and the CDP endpoint emulation. Run them
directly, not via a bare `node --test` — that glob also picks up the live-bus script
below, which needs a real bus and will hang without one.

For an end-to-end check against a live bus instead:

```bash
OAH_SECRET=<token> node test/node-test.cjs
```

Verified end-to-end: LLM via master-brain delegation **and** `[FETCH]` browser hands.

## Connection test

Four checks, each covering more of the path (bus → auth → node → browser). `$SECRET` is
the bus master secret — on the bus machine it lives in `~/.oah-server/data/server.secret`
(bus ≥ 0.4.0); it's also the `secret` in your `config.local.json`.

```bash
SECRET=$(cat ~/.oah-server/data/server.secret)
BUS=127.0.0.1:4000            # or the bus's Tailscale IP from another machine

# 1. bus alive (no auth)
curl -s http://$BUS/api/health                      # {"ok":true,"version":"0.4.0",...}

# 2. auth — 200 with the secret, 401 without (from a remote machine)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $SECRET" http://$BUS/api/work-keys

# 3. which nodes are joined (asks the channel; REST /api/presence can read empty)
node test/presence.cjs [<work_key> ...]             # defaults to config.local.json's workKey
#   work:WK-…  1 node(s)
#     - webclaw@chrome-k70n  machine=browser  role=executor  webclaw/0.7.0

# 4. full round-trip through the node (sandbox only — touches no page)
TID="ping-$(date +%s)"
curl -s -X POST -H "Authorization: Bearer $SECRET" -H "content-type: application/json" \
  -d "{\"to\":\"webclaw@chrome-<id>\",\"role\":\"executor\",\"work_key\":\"<work_key>\",\"task_id\":\"$TID\",\"instructions\":\"[RUN] return 'pong';\"}" \
  http://$BUS/api/task
sleep 2; curl -s -H "Authorization: Bearer $SECRET" http://$BUS/api/task-result/$TID
#   … "output":"{\"result\":\"pong\",\"log\":[]}","status":"done" …   (202 = still pending)
```

| symptom | check |
|---|---|
| no health reply | `lsof -nP -iTCP:4000 -sTCP:LISTEN`; start the bus (`~/.oah-server/start-bus.sh` on the reference box) |
| 401 / `presence.cjs` "cannot connect" | client secret ≠ `server.secret` |
| 202 forever | node not joined (step 3), `to`/`work_key` typo, or reload the extension |
| 404 on `/api/task-result` | bus < 0.4.0 — poll `GET /api/task/<id returned by POST>` instead |
| bus logs | `tail -f ~/.oah-server/tmp/log/erlang.log.*` |

Bus ≥ 0.4.0 notes: it binds the Tailscale IP only unless `OAH_BIND_IP=0.0.0.0`;
`OAH_TRUST_LOOPBACK=1` lets same-box tools call REST without the secret (remote callers
still need it); only the master secret may *originate* tasks — per-node tokens can
connect, receive and report.

## Master-side integration

webclaw joins the bus over WebSocket, but an external "master" (a custom orchestrator,
an LLM planner, etc.) doesn't need a WebSocket client — it dispatches and polls over the
bus's plain REST surface. This is the bus's HTTP API, documented here from the client's
point of view because `test/node-test.cjs` was previously the only executable spec of it.

**Submit a task**
```
POST http://<bus>/api/task
  headers: { authorization: "Bearer <OAH_SECRET>", content-type: "application/json" }
  body: { to, role, work_key, task_id, instructions }
```
`to` is the target node's joined name (e.g. `webclaw@chrome-ab12` — see `[TABS]` or the
popup for the exact joined identity), `work_key` scopes the fleet, `task_id` is
caller-chosen and used to poll the result below, and `instructions` is one marker line
(`[DOM] table.grades`) or free text for LLM delegation.

**Poll for the result**
```
GET http://<bus>/api/task-result/:task_id
  -> 200 { output, exit_code, status, reason?, backend }   (non-200 while pending)
```
> **Older bus releases** (e.g. the 2026-03 `0.3.0` build) ignore the caller's `task_id`
> (they return their own `http-<ms>` id in the `POST` response) and have no
> `/api/task-result` route. Always poll the `task_id` the `POST` returned, via
> `GET /api/task/:task_id` (200 = done, 202 = pending) — that works on every version.

These fields mirror the `task.result` payload webclaw sends over the bus: `status` is
`"done"` or `"failed"`, `exit_code` is non-zero on failure, and `reason` (added for
issue #14) is set for a couple of well-known failure shapes — `"no_match"` (a
`[FILL]`/`[CLICK]`/`[SUBMIT]`/`[DIFF]` selector didn't match anything) and
`"value_mismatch"` (the page rejected/transformed a `[FILL]`ed value) — plus, since
v0.7.0, `stale_ref`, `timeout`, `handed_off`, `cdp_unavailable`, `cdp_denied`,
`cdp_error`, `bad_args`, `script_error`, `nested_run`, `no_space`, `no_learning` — so a caller can
branch on `exit_code`/`reason` instead of pattern-matching the `output` text.

**Delivery acknowledgement** — immediately after receiving `task.assign` and before
running the instruction, the node sends a `task.ack` frame
(`{task_id, to, from, backend}`) over the bus, so a WebSocket-side subscriber can tell
"picked up" apart from "nobody home" before the real result arrives. This ack isn't
surfaced on the REST poll above (which only ever sees `task-result`); consuming it
requires a bus-native WebSocket subscriber, not the HTTP API.

**Minimal poll loop** (see `test/node-test.cjs` for a complete runnable version):
```js
await fetch(`http://${bus}/api/task`, {
  method: "POST", headers,
  body: JSON.stringify({ to: "webclaw@node-test", role: "executor", work_key: workKey, task_id, instructions }),
});
for (let s = 0; s < 40; s++) {
  await new Promise((r) => setTimeout(r, 1000));
  const r = await fetch(`http://${bus}/api/task-result/${task_id}`, { headers });
  if (r.status === 200) { const { output, status, exit_code, reason } = await r.json(); break; }
}
// no 200 within the timeout ⇒ either still running, or nobody ever joined `to:` under
// `work_key` (see issue #5 — the client acks on pickup, but the bus doesn't yet expose a
// fast "no_executor" failure on submit) — a caller can't yet tell those two apart from here.
```

## Comparison — webclaw is a *node*, not an *assistant*

| | what it is | LLM key | webclaw difference |
|---|---|---|---|
| **[Nanobrowser](https://github.com/nanobrowser/nanobrowser)** | open-source MV3 web-automation agent | **in the extension** (yours) | webclaw is **keyless** — the master brings the brain |
| **[browser-use](https://github.com/browser-use/browser-use) / Open Operator** | LLM *drives* the browser via DOM | in the agent | webclaw lends the browser to a fleet; it isn't driven |
| **OpenAI Operator · Codex ext · Do Browser** | single-user browser assistants | in/with the product | webclaw is a **fleet node**, one of many heterogeneous workers |
| **Browserless · Cloudflare · Bedrock AgentCore** | *cloud* browser pools driven by agents | n/a | webclaw is **your real browser** as an edge node, no cloud pool |

> "Nanobrowser **drives** the browser; webclaw **lends** the browser to a fleet."

What's unique is the combination: **distributed fleet node + keyless (master-delegated LLM)
+ always-on extension + CORS-free browser hands.** The browser is a *capability the fleet
can call* (fetch, DOM, screenshot), not the thing being automated for one user.

### Reference groups (2026-10)

ego lite's "Stop bouncing between browsers" table (5 groups × 11 criteria), re-scored
from webclaw's point of view with 5 extra criteria (12–16). Group-typical scores from
parallel web research on 2026-10-21 — ✓ yes · △ partial · ✗ no. Full analysis, per-product
scores, predictions and sources (Korean): [docs/competitive-analysis-2026-10.md](docs/competitive-analysis-2026-10.md).

**Criteria** — 1 works with any AI agent · 2 uses your browser logins · 3 fewer CAPTCHAs ·
4 whole computer · 5 doesn't hijack your browser · 6 parallel · 7 large scraping ·
8 daily browser · 9 free · 10 data local · 11 reusable skills · **12 distributed fleet ·
13 keyless · 14 on-page human-in-the-loop · 15 open source · 16 API for external orchestrators**

| group (representative products) | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **webclaw v0.9.0** | ✓ | ✓ | ✓ | △¹ | △² | ✓ | △ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓³ |
| Browser extensions (Claude in Chrome, Codex for Chrome, Nanobrowser, Playwright MCP Bridge, HARPA) | △ | ✓ | ✓ | ✗ | △ | △ | △ | ✓ | △ | △ | △ | ✗ | △ | △ | △ | △ |
| Built-in agent browsers (Claude Cowork, ChatGPT desktop/Work, Chrome auto browse, Manus) | ✗ | △ | △ | △ | ✓ | △ | ✗ | ✗ | ✗ | △ | ✓ | ✗ | △ | △ | ✗ | ✗ |
| AI browsers (Comet, Dia, Opera Neon, Edge, Genspark/Fellou) | ✗ | ✓ | ✓ | ✗ | △ | △ | ✗ | ✓ | △ | △ | △ | ✗ | △ | ✓ | ✗ | ✗ |
| Cloud browsers (Browserbase, Browser Use, Kernel, Steel, Cloudflare, AgentCore) | ✓ | △ | △ | ✗ | ✓ | ✓ | ✓ | ✗ | △ | ✗ | △ | △ | ✓ | ✓ | △ | ✓ |
| Browser CLIs / MCP (playwright-cli/MCP, Chrome DevTools MCP, agent-browser, Browser Harness, Stagehand) | ✓ | △ | △ | ✗ | △ | △ | △ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ |
| Agent-native browsers (ego lite as assessed, BrowserOS neo, Lightpanda, Donut) | ✓ | △ | △ | ✗ | ✓ | ✓ | △ | △ | ✓ | ✓ | ✗⁴ | ✗ | ✓ | ✓ | △ | △ |

¹ browser only — whole-computer reach comes from other DureClaw fleet nodes (shell/desktop).
² Spaces keep the user's tab, but CDP shows Chrome's "debugging" bar; no true context isolation from an extension.
³ REST/WebSocket bus + (v0.8.0) MCP server, CLI and `npx skills add` — the #1 gap from this analysis, now closed.
⁴ ego's own table claims ✓ on all 11; assessed: 4 and 11 ✗ (skills still "coming soon"), 2·3·7·8 △.

**Where it lands**

| | |
|---|---|
| commoditizing within ~12 months | 5 no-hijack · 6 parallel (everyone converges on CDP + agent tab groups) · 14 hand-off (Cloudflare handoff API, Browser Use takeover) · 2 logins (cloud profiles, Chrome autoConnect) · 11 skills |
| durable differentiator | the **combination** 12 fleet + 13 keyless + 1 any agent + real Chrome with no migration + 15 open source — no group has it |
| biggest gaps | ~~no MCP/CLI/skill install path~~ · ~~bus/master setup friction~~ (v0.8.0) · ~~no public benchmark~~ · ~~no policy layer~~ · ~~no session replay~~ (v0.9.0) — left: Web Store distribution, an LLM-in-the-loop benchmark on live sites |
| top threats | vendor extensions/desktop browsers taking the same surface (Atlas shut down, Claude in Chrome GA) · cloud "sync your local login" · Chrome tightening `chrome.debugger` |

**Positioning** — *the real-browser control plane for agent teams*: no browser switch, any
agent, many machines' real logged-in sessions on one bus, a human supervising on the page.
Hybrid with cloud browsers: discover/scale in the cloud, act on the edge.

**Done** — ~~P0 MCP/CLI/skill, standalone~~ (v0.8.0) · ~~P1 benchmark, policy layer, replay~~ ·
~~P2 CDP endpoint, shared learnings + self-saving recipes, minimal-CDP mode~~ · ~~P3 WebMCP relay,
Web Bot Auth identity~~ (v0.9.0). Report: [docs/report-p1-p3-2026-10.md](docs/report-p1-p3-2026-10.md).

## Roadmap

- Bus-side `no_executor` fast-fail on `/api/task` submit when nobody joined the target
  `to:` under `work_key` (issue #5 — needs bus-side cooperation; the client half —
  `task.ack` on pickup + re-join on reconnect — is already in place)
- LLM-over-bus option (no HTTP at all) · popup status polish · Firefox/Edge
- (done) `[DOM] <css>` read · `[CLICK]`/`[FILL]`/`[SUBMIT]`/`[JS]` act · `[TABS]` list ·
  `@<url>` tab targeting · per-profile node ids · 200 KB output cap ·
  `[SHOT]`/`[SCREENSHOT]` capture (+ `[DIFF] ... :: screenshot` combo) ·
  `status`/`exit_code`/`reason` failure signal for `[FILL]`/`[CLICK]`/`[SUBMIT]` ·
  v0.7.0: CDP native access (trusted click/type, background `[SHOT]`, CSP-proof `[JS]`,
  `[UPLOAD]`, raw `[CDP]`) · `[OUTLINE]` @refs across frames/shadow DOM · `[WAIT]` ·
  `[RUN]` scripts · agent Spaces + hand-off · site learnings + `[RECIPE]`

---

_Family: [edgeclaw](https://github.com/DureClaw/edgeclaw) (OS node, Go) ·
**webclaw** (browser node) · [deskclaw](https://github.com/DureClaw/deskclaw) (desktop GUI node) ·
adapters: picoclaw · nanobot · zeroclaw · nullclaw.
Data at the edge · brains distributed · learning in a closed loop · humans decide._
