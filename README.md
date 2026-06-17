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
DureClaw bus ──task.assign──▶ webclaw (offscreen WS) ──▶ result
   • [FETCH] <url>   → extension fetch (CORS-free)
   • default (LLM)   → delegate to the master brain (keyless to the page)  ──▶ task.result
```

- Joins the bus, presence + heartbeat (offscreen document → survives MV3 idle).
- `[FETCH] <url>` runs an extension fetch (no page-CORS limits).
- Anything else → POSTs to the **master brain** (`Brain URL`) so the heavy thinking
  stays on the master — the browser holds no model and no API cost.

## Install (load unpacked)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Click the **webclaw** toolbar icon → fill in **Bus**, **Token**, **Work Key**,
   **Brain URL/token** → **Connect to fleet**

The node appears in the fleet's presence; a master can fan-out tasks to it, and the
popup shows a live task feed.

## Verify (Node, against a live bus)

```bash
OAH_SECRET=<token> node test/node-test.cjs
```

Verified end-to-end: LLM via master-brain delegation **and** `[FETCH]` browser hands.

## Roadmap

- `[DOM] <query>` / `[SCREENSHOT]` — content-script hands across any tab
- LLM-over-bus option (no HTTP at all) · popup status polish · Firefox/Edge

---

_Family: [edgeclaw](https://github.com/DureClaw/edgeclaw) (OS node, Go) ·
**webclaw** (browser node) · adapters: picoclaw · nanobot · zeroclaw · nullclaw.
Data at the edge · brains distributed · learning in a closed loop · humans decide._
