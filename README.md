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
  page — the browser holds no model and no API cost.

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
npm test   # offline unit tests — marker routing + failure elevation, no bus needed
```

`test/core.unit.test.cjs` runs `core.js` against a fake bus WebSocket (Node's built-in
`node:test`, zero dependencies) to cover marker parsing/routing and the
`status`/`exit_code`/`reason` failure-elevation path without any network access. Run it
directly, not via a bare `node --test` — that glob also picks up the live-bus script
below, which needs a real bus and will hang without one.

For an end-to-end check against a live bus instead:

```bash
OAH_SECRET=<token> node test/node-test.cjs
```

Verified end-to-end: LLM via master-brain delegation **and** `[FETCH]` browser hands.

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
These fields mirror the `task.result` payload webclaw sends over the bus: `status` is
`"done"` or `"failed"`, `exit_code` is non-zero on failure, and `reason` (added for
issue #14) is set for a couple of well-known failure shapes — `"no_match"` (a
`[FILL]`/`[CLICK]`/`[SUBMIT]`/`[DIFF]` selector didn't match anything) and
`"value_mismatch"` (the page rejected/transformed a `[FILL]`ed value) — so a caller can
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

- `[WAIT] <css>` — wait for a selector before reading/acting (SPA readiness)
- Bus-side `no_executor` fast-fail on `/api/task` submit when nobody joined the target
  `to:` under `work_key` (issue #5 — needs bus-side cooperation; the client half —
  `task.ack` on pickup + re-join on reconnect — is already in place)
- LLM-over-bus option (no HTTP at all) · popup status polish · Firefox/Edge
- (done) `[DOM] <css>` read · `[CLICK]`/`[FILL]`/`[SUBMIT]`/`[JS]` act · `[TABS]` list ·
  `@<url>` tab targeting · per-profile node ids · 200 KB output cap ·
  `[SHOT]`/`[SCREENSHOT]` capture (+ `[DIFF] ... :: screenshot` combo) ·
  `status`/`exit_code`/`reason` failure signal for `[FILL]`/`[CLICK]`/`[SUBMIT]`

---

_Family: [edgeclaw](https://github.com/DureClaw/edgeclaw) (OS node, Go) ·
**webclaw** (browser node) · [deskclaw](https://github.com/DureClaw/deskclaw) (desktop GUI node) ·
adapters: picoclaw · nanobot · zeroclaw · nullclaw.
Data at the edge · brains distributed · learning in a closed loop · humans decide._
