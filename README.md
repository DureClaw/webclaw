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
- Output cap raised to ~200 KB (was 1.5 KB) — full tables/pages come back.

## Install (load unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Click the **webclaw** toolbar icon → fill in **Bus**, **Token**, **Work Key**,
   **Brain URL/token** → **Connect to fleet**

> Tip: copy `config.local.json.example` → `config.local.json` (gitignored) to **auto-connect on load** — no popup typing.

The node appears in the fleet's presence; a master can fan-out tasks to it, and the
popup shows a live task feed.

## Tests

```bash
npm test   # offline unit tests — marker routing + failure elevation + [RUN] runner, no bus needed
```

`test/core.unit.test.cjs` runs `core.js` against a fake bus WebSocket (Node's built-in
`node:test`, zero dependencies) to cover marker parsing/routing and the
`status`/`exit_code`/`reason` failure-elevation path without any network access;
`test/runner.unit.test.cjs` covers the `[RUN]` script host (helper → marker mapping,
failure reasons, args). Run them
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
