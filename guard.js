// webclaw guard (v0.9.0) — policy, human approval, audit log, session recording.
// Loaded into the background SW via importScripts().
//
// Policy is set by the *human* (popup, or config.local.json "policy") — never
// by a marker, so an agent cannot switch its own guard rails off:
//   { mode: "auto" | "ask",   ask = first mutating action per site needs approval
//     allow: [domains],       always allowed (skip ask)
//     deny:  [domains],       off-limits: reads, actions, open, fetch, download
//     confirmRisky: bool,     pay/delete/transfer-looking actions always ask
//     audit: bool }           record every handled marker (default on)
// Approval is asked in the page's HUD; the human answers in the HUD chat with
// /allow (once) · /allow-site (this site, this browser session) · /deny.

const GD_RISKY = /(결제|구매|주문|송금|이체|삭제|탈퇴|해지|환불|\bpay\b|payment|purchase|buy now|checkout|place order|transfer|delete|remove account|unsubscribe|cancel subscription)/i;
const GD_ASK_MS = 120000;
const GD_AUDIT_MAX = 1000;
const GD_REC_IMG_MAX = 40;
const GD_REC_MAX = 300;

const gdDefaults = { mode: "auto", allow: [], deny: [], confirmRisky: false, audit: true };

async function gdPolicy() {
  const { policy } = await chrome.storage.local.get("policy");
  const cfg = await readCfg();
  return Object.assign({}, gdDefaults, cfg.policy || {}, policy || {});
}

function gdHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; }
}
function gdMatch(host, list) {
  return !!host && (list || []).some((d) => {
    d = String(d).trim().toLowerCase().replace(/^www\./, "");
    return d && (host === d || host.endsWith("." + d));
  });
}
function gdFail(text, reason) { return { text, failed: true, reason }; }

async function gdSessionApproved(host) {
  const { gdApproved = [] } = await chrome.storage.session.get("gdApproved");
  return gdApproved.includes(host);
}
async function gdApproveSession(host) {
  const { gdApproved = [] } = await chrome.storage.session.get("gdApproved");
  if (!gdApproved.includes(host)) gdApproved.push(host);
  await chrome.storage.session.set({ gdApproved });
}

// ── human approval through the HUD ─────────────────────────────────────────
const gdPending = new Map(); // tabId → resolve(answer)

function gdAsk(tabId, host, what, risky) {
  return new Promise((resolve) => {
    const prev = gdPending.get(tabId);
    if (prev) prev("deny"); // one open question per tab
    const t = setTimeout(() => { gdPending.delete(tabId); resolve("timeout"); }, GD_ASK_MS);
    gdPending.set(tabId, (ans) => { clearTimeout(t); gdPending.delete(tabId); resolve(ans); });
    hudNotify(tabId, "🛡️ 승인 요청" + (risky ? " (위험 동작)" : "") + ": " + what + " @ " + host +
      " — 채팅에 /allow (이번만) · /allow-site (이 사이트 계속) · /deny", null, true);
    chrome.runtime.sendMessage({ type: "busInbox", text: "[approval] waiting for the human: " + what + " @ " + host, url: "" }).catch(() => {});
  });
}

// HUD chat → pending approval. Returns true if the line was an answer.
function gdAnswer(tabId, text) {
  const m = String(text || "").trim().match(/^\/(allow-site|allow|deny)\b/i);
  const r = gdPending.get(tabId);
  if (!m || !r) return false;
  r(m[1].toLowerCase());
  return true;
}

// Gate one action. Returns null (go) or a failure response.
async function gdCheck({ url, tabId, mutating, what, label }) {
  const p = await gdPolicy();
  const host = gdHost(url);
  if (gdMatch(host, p.deny)) return gdFail("(policy: " + host + " is on the deny list)", "policy_denied");
  if (!mutating) return null;
  const risky = !!p.confirmRisky && GD_RISKY.test(String(label || "") + " " + String(what || ""));
  let ask = risky;
  if (p.mode === "ask" && host && !gdMatch(host, p.allow) && !(await gdSessionApproved(host))) ask = true;
  if (!ask) return null;
  if (tabId == null) return gdFail("(policy: approval needed but there is no tab to ask on)", "approval_required");
  const ans = await gdAsk(tabId, host, what + (label ? " '" + String(label).slice(0, 60) + "'" : ""), risky);
  if (ans === "allow-site") { await gdApproveSession(host); return null; }
  if (ans === "allow") return null;
  hudNotify(tabId, ans === "timeout" ? "🛡️ 승인 시간 초과 — 실행하지 않았습니다" : "🛡️ 거절됨 — 실행하지 않았습니다", null, true);
  return ans === "timeout"
    ? gdFail("(policy: no human approval within " + GD_ASK_MS / 1000 + "s)", "approval_timeout")
    : gdFail("(policy: the human denied this action)", "approval_denied");
}

// ── audit log + recorder (one serialized write chain) ──────────────────────
let gdChain = Promise.resolve();

function gdRecordAll(entry, tab) {
  gdChain = gdChain.then(async () => {
    const p = await gdPolicy();
    const e = Object.assign({ ts: new Date().toISOString() }, entry);
    if (p.audit !== false) {
      const { audit = [] } = await chrome.storage.local.get("audit");
      audit.push(e);
      while (audit.length > GD_AUDIT_MAX) audit.shift();
      await chrome.storage.local.set({ audit });
    }
    const { rec } = await chrome.storage.session.get("rec");
    if (rec && rec.on && entry.mutating !== false && rec.frames.length < GD_REC_MAX) {
      const frame = Object.assign({}, e);
      const imgs = rec.frames.filter((f) => f.img).length;
      if (tab && imgs < GD_REC_IMG_MAX && await WcCdp.enabled(tab.id)) {
        try {
          const r = await WcCdp.send(tab.id, "Page.captureScreenshot", { format: "jpeg", quality: 30 }, 5000);
          frame.img = "data:image/jpeg;base64," + r.data;
        } catch (err) {}
      }
      rec.frames.push(frame);
      try { await chrome.storage.session.set({ rec }); }
      catch (err) { frame.img = undefined; await chrome.storage.session.set({ rec }).catch(() => {}); } // quota → keep text
    }
  }).catch(() => {});
  return gdChain;
}

async function gdAuditTail(n) {
  const { audit = [] } = await chrome.storage.local.get("audit");
  const tail = audit.slice(-(Number(n) > 0 ? Number(n) : 50));
  if (!tail.length) return "(audit log empty)";
  return tail.map((e) => e.ts + "  " + (e.result || "").padEnd(6) + " " + e.kind + (e.action ? ":" + e.action : "") +
    (e.target ? " " + String(e.target).slice(0, 60) : "") + (e.host ? " @" + e.host : "") +
    (e.reason ? " [" + e.reason + "]" : "") + (e.approved ? " (approved:" + e.approved + ")" : "")).join("\n");
}

async function gdRec(op, arg) {
  const { rec } = await chrome.storage.session.get("rec");
  if (op === "on") {
    await chrome.storage.session.set({ rec: { on: true, label: arg || "session", started: new Date().toISOString(), frames: [] } });
    return "recording on (" + (arg || "session") + ") — mutating actions are captured with a screenshot each (first " + GD_REC_IMG_MAX + ")";
  }
  if (!rec) return "(not recording — [REC] on [label])";
  if (op === "off") {
    rec.on = false;
    await chrome.storage.session.set({ rec });
    return "recording off — " + rec.frames.length + " frame(s); [REPLAY] to export";
  }
  return "recording " + (rec.on ? "on" : "off") + " · " + rec.label + " · " + rec.frames.length + " frame(s) since " + rec.started;
}

function gdEsc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// Self-contained HTML timeline of the recording (downloaded like [SHOT]).
async function gdReplayHtml() {
  const { rec } = await chrome.storage.session.get("rec");
  if (!rec || !rec.frames.length) return null;
  const rows = rec.frames.map((f, i) =>
    "<tr><td>" + (i + 1) + "</td><td>" + gdEsc(f.ts.slice(11, 19)) + "</td><td><b>" + gdEsc(f.kind + (f.action ? ":" + f.action : "")) + "</b><br>" +
    gdEsc(String(f.target || "").slice(0, 120)) + "<br><small>" + gdEsc(f.host || "") + "</small></td><td class='" + (f.result === "ok" ? "ok" : "bad") + "'>" +
    gdEsc(f.result) + (f.reason ? " [" + gdEsc(f.reason) + "]" : "") + "<br><small>" + gdEsc(String(f.out || "").slice(0, 160)) + "</small></td><td>" +
    (f.img ? "<a href='" + f.img + "' target='_blank'><img src='" + f.img + "'></a>" : "") + "</td></tr>").join("");
  return "<!doctype html><meta charset='utf-8'><title>webclaw replay — " + gdEsc(rec.label) + "</title>" +
    "<style>body{font:13px -apple-system,sans-serif;margin:24px;color:#0f172a}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e2e8f0;padding:6px;vertical-align:top;text-align:left}img{max-width:360px;border:1px solid #cbd5e1}.ok{color:#059669}.bad{color:#e11d48}small{color:#64748b}</style>" +
    "<h1>webclaw replay — " + gdEsc(rec.label) + "</h1><p>started " + gdEsc(rec.started) + " · " + rec.frames.length + " step(s)</p>" +
    "<table><tr><th>#</th><th>time</th><th>action</th><th>result</th><th>screen</th></tr>" + rows + "</table>";
}

// Gate + label for a resolved act (click/submit text is read from the page).
async function gdGateAct(tab, msg) {
  const mutating = WC_MUTATING.has(msg.action);
  let label = msg.action === "clicktext" ? msg.value : "";
  if (mutating && (msg.action === "click" || msg.action === "submit") && msg.selector) {
    try {
      const r = await wcResolve(tab, msg.selector);
      label = await wcInject(r, "describe", r.css);
    } catch (e) {}
  }
  if (msg.action === "js" || msg.action === "cdp") label = (msg.code || msg.method || "").slice(0, 80);
  msg._label = label;
  return gdCheck({ url: tab.url, tabId: tab.id, mutating, what: "[" + msg.action.toUpperCase() + "] " + (msg.selector || msg.method || ""), label });
}

function gdAuditAct(msg, tab, resp) {
  return gdRecordAll({
    kind: "act", action: msg.action, target: msg.selector || msg.value || msg.method || (msg.code || "").slice(0, 80),
    host: tab ? gdHost(tab.url) : "", tabId: tab && tab.id, mutating: WC_MUTATING.has(msg.action),
    result: resp && resp.failed ? "failed" : "ok", reason: resp && resp.reason, out: String((resp && resp.text) || "").slice(0, 200),
    label: msg._label || undefined,
  }, tab);
}
