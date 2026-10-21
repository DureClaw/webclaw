// webclaw MCP server (stdio, JSON-RPC 2.0, zero dependencies).
// Every tool is one marker dispatched through the bus to a webclaw node, so
// any MCP client (Claude Code, Codex, Cursor, …) drives the user's real,
// logged-in Chrome with the same semantics as a fleet master.
"use strict";

const VERSION = require("../manifest.json").version; // single source of truth
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const OUT_CAP = 60000; // chars per tool result — protects the agent's context

const INSTRUCTIONS = [
  "webclaw drives the user's REAL Chrome (their logins) through the webclaw extension.",
  "Workflow: webclaw_outline → pick @N refs → webclaw_click / webclaw_type with target \"@N\" (refs die on navigation: re-outline).",
  "Prefer webclaw_run for multi-step work: one round-trip, helpers open/outline/click/type/fill/wait/dom/links/js/shot/say/space/useSpace, failures throw e.reason.",
  "Don't take over the human's tab: start with webclaw_marker \"[SPACE] <name>\" (unfocused agent window) or pass tab=\"space:<name>\".",
  "Need the human (login, CAPTCHA, payment)? webclaw_marker \"[HANDOFF] <space> :: <what to do>\", then poll webclaw_inbox for their /done.",
  "Policy is the human's: approval prompts (reason approval_timeout/approval_denied) and deny-listed sites (policy_denied) are final — tell the user, don't work around them.",
  "Record a session with [REC] on … [REC] off, then [REPLAY] for an HTML timeline. Save a working script as a recipe by starting it with \"// @save <domain>/<name>\".",
  "tab = URL substring of an existing tab (e.g. \"mail.google.com\") or \"space:<name>\"; omitted = the node's current space or active tab.",
].join("\n");

const tab = { type: "string", description: "Target tab: URL substring, or \"space:<name>\". Optional." };
const node = { type: "string", description: "Node name (webclaw@chrome-xxxx) when several are joined. Optional." };

const TOOLS = [
  { name: "webclaw_nodes", description: "List webclaw nodes (browsers) joined to the bus.", inputSchema: { type: "object", properties: {} } },
  { name: "webclaw_tabs", description: "List the node's open tabs, grouped by tab group.", inputSchema: { type: "object", properties: { node } } },
  { name: "webclaw_open", description: "Open a URL (waits for load). With space, opens inside that agent Space instead of the user's window.", inputSchema: { type: "object", properties: { url: { type: "string" }, space: { type: "string" }, node }, required: ["url"] } },
  { name: "webclaw_outline", description: "Interactive elements of the page (all frames, shadow DOM) as @N refs: `@12 button \"Sign in\"`.", inputSchema: { type: "object", properties: { tab, max: { type: "number" }, node } } },
  { name: "webclaw_click", description: "Click an element (@N ref or CSS). Uses trusted mouse input when possible.", inputSchema: { type: "object", properties: { target: { type: "string" }, tab, node }, required: ["target"] } },
  { name: "webclaw_type", description: "Type text into an input (@N ref or CSS), replacing its content; reports the value the page kept.", inputSchema: { type: "object", properties: { target: { type: "string" }, text: { type: "string" }, tab, node }, required: ["target", "text"] } },
  { name: "webclaw_read", description: "Read text: whole page when selector is omitted, else the matching elements (@N or CSS).", inputSchema: { type: "object", properties: { selector: { type: "string" }, tab, node } } },
  { name: "webclaw_run", description: "Run a multi-step JS script (body of an async function) with injected helpers in one round-trip. Returns {result, log}.", inputSchema: { type: "object", properties: { script: { type: "string" }, tab, timeout_s: { type: "number" }, node }, required: ["script"] } },
  { name: "webclaw_marker", description: "Send any raw webclaw marker line, e.g. \"[SHOT] a.jpg\", \"[SPACE] job\", \"[HANDOFF] job :: log in please\", \"[WAIT] text:Saved :: 5000\", \"[CDP] Page.reload {}\".", inputSchema: { type: "object", properties: { marker: { type: "string" }, timeout_s: { type: "number" }, node }, required: ["marker"] } },
  { name: "webclaw_say", description: "Show a message to the human in the page's HUD chat.", inputSchema: { type: "object", properties: { text: { type: "string" }, tab, node }, required: ["text"] } },
  { name: "webclaw_webmcp_list", description: "Tools the page exposes via WebMCP (navigator.modelContext), relayed by webclaw.", inputSchema: { type: "object", properties: { tab, node } } },
  { name: "webclaw_webmcp_call", description: "Call a page's WebMCP tool with JSON arguments.", inputSchema: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" }, tab, node }, required: ["tool"] } },
  { name: "webclaw_audit", description: "Last n entries of the node's audit log (every action, result, approvals).", inputSchema: { type: "object", properties: { n: { type: "number" }, node } } },
  { name: "webclaw_inbox", description: "Messages the human typed into the HUD chat (e.g. /done after a hand-off). Pass since = last seq seen.", inputSchema: { type: "object", properties: { since: { type: "number" }, node } } },
];

const at = (t) => (t ? "@" + t : "");

// tool call → marker line (pure; unit-tested)
function toMarker(name, a) {
  switch (name) {
    case "webclaw_tabs": return "[TABS]";
    case "webclaw_open": return "[OPEN" + at(a.space ? "space:" + a.space : "") + "] " + a.url;
    case "webclaw_outline": return "[OUTLINE" + at(a.tab) + "]" + (a.max ? " " + a.max : "");
    case "webclaw_click": return "[CLICK" + at(a.tab) + "] " + a.target;
    case "webclaw_type": return "[TYPE" + at(a.tab) + "] " + a.target + "\n" + a.text;
    case "webclaw_read": return "[DOM" + at(a.tab) + "] " + (a.selector || "");
    case "webclaw_run": return "[RUN" + at(a.tab) + "] " + a.script;
    case "webclaw_marker": return String(a.marker || "");
    case "webclaw_say": return "[SAY" + at(a.tab) + "] " + a.text;
    case "webclaw_webmcp_list": return "[WEBMCP" + at(a.tab) + "] list";
    case "webclaw_webmcp_call": return "[WEBMCP" + at(a.tab) + "] call " + a.tool + " " + JSON.stringify(a.args || {});
    case "webclaw_audit": return "[AUDIT] " + (a.n || 50);
    default: return null;
  }
}

function cap(s) { return s.length > OUT_CAP ? s.slice(0, OUT_CAP) + "\n…[truncated " + (s.length - OUT_CAP) + " chars — narrow the selector or return less from the script]" : s; }

function createMcpServer(client, opts = {}) {
  const prepare = opts.prepare || (async () => {});

  async function callTool(name, a) {
    a = a || {};
    await prepare();
    if (name === "webclaw_nodes") {
      const ns = await client.nodes();
      return ns.length ? ns.map((n) => n.name + "  machine=" + (n.machine || "?") + (n.version ? "  " + n.version : "")).join("\n") : "(no nodes joined)";
    }
    if (name === "webclaw_inbox") {
      const msgs = await client.inbox(a.node, a.since);
      return msgs.length ? JSON.stringify(msgs) : "(no new messages)";
    }
    const marker = toMarker(name, a);
    if (marker == null) throw Object.assign(new Error("unknown tool: " + name), { code: -32602 });
    const timeoutMs = (a.timeout_s ? a.timeout_s * 1000 : name === "webclaw_run" ? 200000 : 60000);
    const r = await client.dispatch(marker, { node: a.node, timeoutMs });
    if (r.status === "done") return r.output;
    throw Object.assign(new Error((r.reason ? "[" + r.reason + "] " : "") + r.output), { toolError: true });
  }

  // one JSON-RPC message → response object (or null for notifications)
  async function handle(msg) {
    const { id, method, params } = msg || {};
    const ok = (result) => (id === undefined ? null : { jsonrpc: "2.0", id, result });
    const err = (code, message) => (id === undefined ? null : { jsonrpc: "2.0", id, error: { code, message } });
    if (method === "initialize") {
      const want = params && params.protocolVersion;
      return ok({
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "webclaw", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === "ping") return ok({});
    if (method === "tools/list") return ok({ tools: TOOLS });
    if (method === "tools/call") {
      try {
        const text = await callTool(params && params.name, params && params.arguments);
        return ok({ content: [{ type: "text", text: cap(String(text)) }] });
      } catch (e) {
        if (e.code === -32602) return err(-32602, e.message);
        return ok({ content: [{ type: "text", text: cap(String(e.message || e)) }], isError: true });
      }
    }
    if (method && method.startsWith("notifications/")) return null;
    return err(-32601, "method not found: " + method);
  }

  // newline-delimited JSON-RPC over stdio; logs go to stderr only
  function serveStdio(input = process.stdin, output = process.stdout) {
    let buf = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n"); continue; }
        Promise.resolve(handle(msg)).then((res) => { if (res) output.write(JSON.stringify(res) + "\n"); });
      }
    });
    input.on("end", () => process.exit(0));
  }

  return { handle, serveStdio, callTool };
}

module.exports = { createMcpServer, toMarker, TOOLS, VERSION };
