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
| hands | one page's DOM | ✅ fetch + (any-tab DOM/screenshot, next) |

The bus speaks plain WebSocket + JSON frames, so webclaw is **pure JS — no build, no wasm**.
The same `core.js` runs in the extension *and* in Node (see `test/`).

## How it works

```
DureClaw bus ──task.assign──▶ webclaw (offscreen WS) ──▶ task.result
   • [FETCH] <url>            → extension fetch (CORS-free)
   • [DOM] <css>              → read a tab's DOM / page text
   • [CLICK] <css>            → click an element
   • [FILL] <css> = <value>   → set an input's value (+ input/change events)
   • [SUBMIT] <css>           → submit a form
   • [JS] <code>              → run JS in the page, return the result
   • [TABS]                   → list open tabs (to find the logged-in one)
   • default (LLM)            → delegate to the master brain (keyless to the page)
```

- Joins the bus, presence + heartbeat (offscreen document → survives MV3 idle).
- **Read _and act_**: `[DOM]`/`[JS]` read; `[CLICK]`/`[FILL]`/`[SUBMIT]` interact — real form input, not just scraping.
- **Target a specific tab** with `[<MARKER>@<url-substring>] …` — e.g. `[DOM@lms.example.com] table.grades` picks the tab whose URL contains `lms.example.com` (the logged-in session) instead of the active one.
- **Distinct nodes per profile**: each Chrome profile registers as `webclaw@chrome-<id>`, so two profiles don't collide on one name and both answer the same task. Use `[TABS]` to see which node holds the logged-in session.
- Output cap raised to ~200 KB (was 1.5 KB) — full tables/pages come back.
- `[FETCH] <url>` runs an extension fetch (no page-CORS limits).
- Anything without a marker → POSTs to the **master brain** (`Brain URL`) so the heavy thinking
  stays on the master — the browser holds no model and no API cost.

## Install (load unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Click the **webclaw** toolbar icon → fill in **Bus**, **Token**, **Work Key**,
   **Brain URL/token** → **Connect to fleet**

> Tip: copy `config.local.json.example` → `config.local.json` (gitignored) to **auto-connect on load** — no popup typing.

The node appears in the fleet's presence; a master can fan-out tasks to it, and the
popup shows a live task feed.

## Verify (Node, against a live bus)

```bash
OAH_SECRET=<token> node test/node-test.cjs
```

Verified end-to-end: LLM via master-brain delegation **and** `[FETCH]` browser hands.

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

- `[SCREENSHOT]` — capture the target tab for the fleet
- `[WAIT] <css>` — wait for a selector before reading/acting (SPA readiness)
- LLM-over-bus option (no HTTP at all) · popup status polish · Firefox/Edge
- (done) `[DOM] <css>` read · `[CLICK]`/`[FILL]`/`[SUBMIT]`/`[JS]` act · `[TABS]` list · `@<url>` tab targeting · per-profile node ids · 200 KB output cap

---

_Family: [edgeclaw](https://github.com/DureClaw/edgeclaw) (OS node, Go) ·
**webclaw** (browser node) · [deskclaw](https://github.com/DureClaw/deskclaw) (desktop GUI node) ·
adapters: picoclaw · nanobot · zeroclaw · nullclaw.
Data at the edge · brains distributed · learning in a closed loop · humans decide._
