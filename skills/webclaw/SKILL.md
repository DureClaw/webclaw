---
name: webclaw
description: Drive the user's REAL, logged-in Chrome (their sessions, cookies, extensions) from any agent through the webclaw extension — open pages, outline interactive elements as @refs, click/type with trusted input, run multi-step JS scripts in one round-trip, work in an agent Space that doesn't take over the user's tab, and hand off to the human for logins/CAPTCHAs. Use when a task needs the user's own browser session (SaaS admin, webmail, intranet, sites that block cloud browsers), or when the user says "webclaw", "my browser", "내 브라우저로".
---

# webclaw — your agent's hands in the user's real Chrome

Requires the webclaw Chrome extension (load unpacked from https://github.com/DureClaw/webclaw)
and the bridge (`bin/webclaw.cjs` in the same repo, Node 22+).

## Setup (once)

```bash
git clone https://github.com/DureClaw/webclaw && cd webclaw
node bin/webclaw.cjs setup --standalone   # local mini-bus, no server needed; writes the extension config
# chrome://extensions → Developer mode → Load unpacked → this folder (or reload it)
node bin/webclaw.cjs doctor               # ✓ config ✓ bus ✓ auth ✓ node ✓ round-trip
claude mcp add webclaw -- node "$PWD/bin/webclaw.cjs" mcp    # or: codex mcp add webclaw -- …
```

Already running a DureClaw bus? `node bin/webclaw.cjs setup` (bus mode, reads `config.local.json`).

## Use — MCP tools (preferred) or the CLI

| goal | MCP tool | CLI |
|---|---|---|
| which browsers are connected | `webclaw_nodes` | `webclaw nodes` |
| see tabs | `webclaw_tabs` | `webclaw do "[TABS]"` |
| work without touching the user's tab | `webclaw_marker` `[SPACE] job` | `webclaw do "[SPACE] job"` |
| open a page | `webclaw_open` {url, space} | `webclaw do "[OPEN@space:job] https://…"` |
| what can I click | `webclaw_outline` | `webclaw do "[OUTLINE]"` |
| click / type | `webclaw_click` {target:"@12"} · `webclaw_type` | `webclaw do "[CLICK] @12"` |
| read text | `webclaw_read` {selector} | `webclaw do "[DOM] h1"` |
| many steps at once | `webclaw_run` {script} | `webclaw run flow.js` |
| reach a goal fast (no LLM per step) | `webclaw_goal` {goal, tab, save} | `webclaw goal '<goal with values>' [--brain jev\|laya]` |
| ask the human | `webclaw_marker` `[HANDOFF] job :: please log in` → poll `webclaw_inbox` for `/done` | `webclaw inbox` |

## Rules of thumb

1. **Outline, then act by ref.** `@N` refs come from `webclaw_outline`; they die on navigation —
   re-outline after any page change (`reason: stale_ref`).
2. **Batch with `webclaw_run`.** The script is the body of an async function; helpers:
   `open, outline, dom, links, attr, click, clickText, fill, type, submit, upload, wait, js, cdp,
   shot, snap, diff, close, tabs, fetchText, download, say, learned, space, useSpace, useTab,
   handOff, log, sleep, marker`. A failed step throws with `e.reason`. Return what you need:
   ```js
   await space('job'); await open('https://example.com/login');
   const o = await outline(); log(o.split('\n').slice(0, 20).join('\n'));
   await type('@3', 'me@example.com'); await click('@5'); await wait('text:Dashboard', 15000);
   return await links('nav a');
   ```
3. **Don't hijack.** Work in a Space (`[SPACE] <name>` / `space(name)` / `tab:"space:<name>"`).
   Without one, markers hit the user's active tab.
4. **Write → read back.** After `type`/`fill`, check the reported kept value; after saving,
   re-read the page. `reason: value_mismatch` means the page rejected your input.
5. **Humans for humans' steps.** Logins with 2FA, CAPTCHAs, payments, irreversible deletes:
   `[HANDOFF] <space> :: <what>` (mutations are blocked until they type `/done` or you `[TAKEOVER]`).
6. **The human's policy is final.** `policy_denied` (site on the deny list), `approval_denied` /
   `approval_timeout` (they said no in the HUD, or weren't there) — report it, don't route around it.
   `[POLICY]` shows the rules; only the human can change them.
7. **Failure reasons** to branch on: `no_match`, `stale_ref`, `timeout`, `value_mismatch`,
   `handed_off`, `policy_denied`, `approval_denied`, `approval_timeout`, `cdp_unavailable`,
   `cdp_denied`, `script_error`, `webmcp_error`, `no_node`, `ambiguous_node`, `no_tab`, `http_<status>`,
   `missing_arg`, `done_without_action`, `needs_confirmation`, `low_confidence`, `stuck`.

## v0.9–v0.11 extras

- **Approvals happen off-page.** In ask mode the human answers in webclaw's side panel/popup, never in
  the page HUD; `approval_timeout` means nobody answered within 120 s — tell the user, don't retry in a loop.
- **System One brain:** `webclaw_goal` decides each step with one structured call (TypeSafe Jev, or
  local Laya) — values to type must be in the goal text. Saved brain recipes hold no values: replay with
  `[RECIPE] <domain>/<name>\n{"v1": "…"}` (missing args are refused before any action).

- **Save what worked:** start a `webclaw_run` script with `// @save <domain>/<name>` — on success it
  becomes a recipe; later `[RECIPE] <domain>/<name>` (with `\n{json args}`). Share with
  `webclaw learnings push|pull` (bus skill registry) or `export|import` (file).
- **Show your work:** `[REC] on <label>` … `[REC] off` → `[REPLAY]` writes an HTML timeline with a
  screenshot per step to Downloads. `webclaw_audit` lists every action taken.
- **Site tools:** `webclaw_webmcp_list` / `webclaw_webmcp_call` relay a page's WebMCP tools
  (`navigator.modelContext`) — prefer them over clicking when a page offers them.
- **Bring your own CDP client** (standalone mode): `webclaw cdp-url` → `puppeteer.connect({browserURL})`
  or `chromium.connectOverCDP(url)`; pages open in the agent Space "cdp"; use the default context.

More: `[SHOT] path.jpg` (screenshot to Downloads), `[UPLOAD] @N :: /abs/file.pdf`,
`[WAIT] text:Saved :: 5000`, `[DOWNLOAD] url :: dir/name`, `[LEARN] <domain>\n{json}`,
`[RECIPE] <domain>/<name>` — full marker reference in the repo README.
