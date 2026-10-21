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
// The config.local.json policy is a *floor*: popup values override it field by
// field, but its deny list is always unioned in (the popup cannot remove it).
//
// Approval is announced in the page's HUD, but answered ONLY on extension-owned
// surfaces (side panel / popup: Allow once · Allow site · Deny). The HUD lives
// inside the page's DOM, so anything typed there could be forged by the page.

const GD_RISKY = /(결제|구매|주문|송금|이체|삭제|탈퇴|해지|환불|\bpay\b|payment|purchase|buy now|checkout|place order|transfer|delete|remove account|unsubscribe|cancel subscription)/i;
const GD_ASK_MS = 120000;
const GD_AUDIT_MAX = 1000;
const GD_REC_IMG_MAX = 40;
const GD_REC_MAX = 300;

const gdDefaults = { mode: "auto", allow: [], deny: [], confirmRisky: false, audit: true };

// ── pure helpers (unit-tested in test/hardening.ext.test.cjs) ───────────────

function wcUnion(a, b) {
  const out = [];
  for (const x of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const v = String(x).trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// file policy (floor) ← stored policy (popup); deny lists are unioned.
function wcMergePolicy(defaults, filePolicy, storedPolicy) {
  const f = filePolicy || {}, s = storedPolicy || {};
  const p = Object.assign({}, defaults || {}, f, s);
  p.deny = wcUnion(f.deny, s.deny);
  return p;
}

// Effective config: chrome.storage cfg (connection) over config.local.json, plus
// popup prefs. When a stored cfg exists its connection fields win entirely (so a
// Bus/Wide Worker switch in the side panel is not undone by the file), but the
// file's policy / cdpDeny / identity are always kept as the floor.
function wcMergeCfg(file, stored, prefs) {
  file = file || {};
  const base = stored ? Object.assign({}, stored) : Object.assign({}, file);
  const out = Object.assign(base, prefs || {});
  if (file.policy || (stored && stored.policy)) out.policy = wcMergePolicy({}, file.policy, stored && stored.policy);
  if (Array.isArray(file.cdpDeny) || (stored && Array.isArray(stored.cdpDeny))) out.cdpDeny = wcUnion(file.cdpDeny, stored && stored.cdpDeny);
  if (file.identity || (stored && stored.identity)) out.identity = Object.assign({}, file.identity || {}, (stored && stored.identity) || {});
  return out;
}

// Who sent a runtime message. "ext" = an extension page of ours (offscreen,
// popup, side panel — no tab); "tab" = our injected HUD script in a tab's main
// frame. Web pages cannot reach chrome.runtime.onMessage without
// externally_connectable, but a compromised/forged content context could, so
// privileged handlers insist on "ext".
function wcSenderKind(sender, extId) {
  if (!sender || sender.id !== extId) return "foreign";
  if (sender.tab) return sender.tab.id != null && (sender.frameId == null || sender.frameId === 0) ? "tab" : "foreign";
  return "ext";
}

// What a HUD chat line is: approvals are never accepted from the page.
function gdHudLineKind(text) {
  const t = String(text || "").trim();
  if (/^\/(allow-site|allow|deny)\b/i.test(t)) return "approval";
  if (/^\/(done|return)\b/i.test(t)) return "done";
  return "chat";
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

// First denied host along a URL chain (request → redirects → final), or "".
function gdDeniedInChain(urls, deny) {
  for (const u of urls || []) { const h = gdHost(u); if (gdMatch(h, deny)) return h; }
  return "";
}

// Risk label for an act: what the human would see / what GD_RISKY scans.
// `describe` = a selector whose on-page label must be read first.
function gdActSpec(msg) {
  const a = msg.action;
  const spec = { label: "", describe: null, forceRisky: false };
  if (a === "clicktext") spec.label = String(msg.value || "");
  else if (a === "click" || a === "submit") spec.describe = msg.selector || null;
  else if (a === "diff") {
    const m = String(msg.code || "").trim().match(/^(clicktext|click):([\s\S]+)$/);
    if (m && m[1] === "clicktext") spec.label = m[2].trim();
    else if (m) spec.describe = m[2].trim();
  } else if (a === "js") spec.label = String(msg.code || ""); // whole body, not a prefix
  else if (a === "cdp") {
    const method = String(msg.method || "");
    spec.label = method + " " + JSON.stringify(msg.params || {});
    spec.forceRisky = /^Input\./.test(method); // synthetic trusted input
  }
  return spec;
}

function gdIsRisky(p, label, what, forceRisky) {
  return !!p.confirmRisky && (!!forceRisky || GD_RISKY.test(String(label || "") + " " + String(what || "")));
}

// Recorder screenshots only for executed actions on non-denied pages.
function gdRecShoot(entry, p, curUrl) {
  if (!entry || entry.result !== "ok") return false;
  if (gdMatch(entry.host, p.deny)) return false;
  if (curUrl != null && gdMatch(gdHost(curUrl), p.deny)) return false;
  return true;
}

// ── policy ──────────────────────────────────────────────────────────────────

async function gdPolicy() {
  const { policy } = await chrome.storage.local.get("policy");
  const cfg = await readCfg();
  return wcMergePolicy(gdDefaults, cfg.policy, policy);
}

async function gdSessionApproved(host) {
  const { gdApproved = [] } = await chrome.storage.session.get("gdApproved");
  return gdApproved.includes(host);
}
async function gdApproveSession(host) {
  const { gdApproved = [] } = await chrome.storage.session.get("gdApproved");
  if (!gdApproved.includes(host)) gdApproved.push(host);
  await chrome.storage.session.set({ gdApproved });
}

// ── human approval (asked in the HUD, answered in the side panel / popup) ───
const gdPending = new Map(); // tabId → { id, tabId, host, what, risky, at, resolve }
let gdPendChain = Promise.resolve();

function gdPendingList() {
  return [...gdPending.values()].map(({ id, tabId, host, what, risky, at }) => ({ id, tabId, host, what, risky, at }));
}

// Persist (A12) + badge + tell open panels. Serialized so snapshots land in order.
function gdPendingChanged() {
  const list = gdPendingList();
  gdPendChain = gdPendChain.then(() => chrome.storage.session.set({ gdPending: list })).catch(() => {});
  try { chrome.action.setBadgeText({ text: list.length ? String(list.length) : "" }); chrome.action.setBadgeBackgroundColor({ color: "#e11d48" }); } catch (e) {}
  try { chrome.runtime.sendMessage({ type: "approvalsUpdated", pending: list }).catch(() => {}); } catch (e) {}
  return gdPendChain;
}

function gdAsk(tabId, host, what, risky) {
  return new Promise((resolve) => {
    const prev = gdPending.get(tabId);
    if (prev) prev.resolve("deny"); // one open question per tab
    const id = "ap-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const t = setTimeout(() => entry.resolve("timeout"), GD_ASK_MS);
    const entry = {
      id, tabId, host, what, risky: !!risky, at: Date.now(),
      resolve: (ans) => {
        clearTimeout(t);
        if (gdPending.get(tabId) === entry) { gdPending.delete(tabId); gdPendingChanged(); }
        resolve(ans);
      },
    };
    gdPending.set(tabId, entry);
    gdPendingChanged();
    hudNotify(tabId, "🛡️ 승인 요청" + (risky ? " (위험 동작)" : "") + ": " + what + " @ " + host +
      " — 툴바의 webclaw 아이콘(사이드 패널)에서 허용/거절하세요", null, true);
    chrome.runtime.sendMessage({ type: "busInbox", text: "[approval] waiting for the human: " + what + " @ " + host, url: "" }).catch(() => {});
  });
}

// Side panel / popup → answer one pending approval by id.
function gdAnswerId(id, answer) {
  const ans = String(answer || "").toLowerCase();
  if (!["allow", "allow-site", "deny"].includes(ans)) return false;
  for (const e of gdPending.values()) if (e.id === id) { e.resolve(ans); return true; }
  return false;
}

// SW restart: the callers waiting on persisted approvals died with the old
// worker, so those questions can never be answered — expire them visibly.
async function gdExpireOrphans() {
  const { gdPending: stale = [] } = await chrome.storage.session.get("gdPending");
  if (!stale.length) return 0;
  await chrome.storage.session.set({ gdPending: gdPendingList() });
  for (const e of stale) {
    if (gdPending.has(e.tabId)) continue;
    hudNotify(e.tabId, "🛡️ 승인 요청이 만료되었습니다 (확장 재시작): " + e.what + " — 실행하지 않았습니다", null, true);
  }
  try { chrome.action.setBadgeText({ text: gdPending.size ? String(gdPending.size) : "" }); } catch (e) {}
  return stale.length;
}

// Gate one action. Returns null (go) or a failure response.
async function gdCheck({ url, tabId, mutating, what, label, forceRisky }) {
  const p = await gdPolicy();
  const host = gdHost(url);
  if (gdMatch(host, p.deny)) return gdFail("(policy: " + host + " is on the deny list)", "policy_denied");
  if (!mutating) return null;
  const risky = gdIsRisky(p, label, what, forceRisky);
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
      if (tab && imgs < GD_REC_IMG_MAX) {
        // A7 — never capture refused/failed actions or a denied page (the tab
        // may have navigated somewhere denied since the action ran)
        let cur = null;
        try { cur = (await chrome.tabs.get(tab.id)).url || ""; } catch (err) { cur = null; }
        if (cur != null && gdRecShoot(e, p, cur) && await WcCdp.enabled(tab.id)) {
          try {
            const r = await WcCdp.send(tab.id, "Page.captureScreenshot", { format: "jpeg", quality: 30 }, 5000);
            frame.img = "data:image/jpeg;base64," + r.data;
          } catch (err) {}
        }
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

// [REC] runs inside the same chain as the recorder writes, so "off" can never
// be overwritten by a frame write that read the old { on: true } state.
function gdRec(op, arg) {
  const run = gdChain.then(() => gdRecNow(op, arg));
  gdChain = run.catch(() => {});
  return run;
}
async function gdRecNow(op, arg) {
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

// Gate + label for a resolved act (click/submit/[DIFF] target text is read
// from the page; [JS] is checked whole; [CDP] Input.* counts as risky).
async function gdGateAct(tab, msg) {
  const mutating = WC_MUTATING.has(msg.action);
  const spec = gdActSpec(msg);
  let label = spec.label;
  if (mutating && spec.describe) {
    try {
      const r = await wcResolve(tab, spec.describe);
      label = await wcInject(r, "describe", r.css);
    } catch (e) {}
  }
  msg._label = String(label || "").slice(0, 200);
  const what = "[" + msg.action.toUpperCase() + "] " + (msg.selector || msg.method || (msg.action === "diff" ? String(msg.code || "").slice(0, 60) : ""));
  return gdCheck({ url: tab.url, tabId: tab.id, mutating, what, label, forceRisky: spec.forceRisky });
}

// S6 — fill/type values never reach the audit log / recorder.
function gdRedactOut(action, text) {
  const s = String(text || "");
  if (action !== "fill" && action !== "type") return s.slice(0, 200);
  return s.replace(/ = [\s\S]*$/, " = (redacted)").slice(0, 200);
}

function gdAuditAct(msg, tab, resp) {
  return gdRecordAll({
    kind: "act", action: msg.action, target: msg.selector || (msg.action === "fill" || msg.action === "type" ? "" : msg.value) || msg.method || (msg.code || "").slice(0, 80),
    host: tab ? gdHost(tab.url) : "", tabId: tab && tab.id, mutating: WC_MUTATING.has(msg.action),
    result: resp && resp.failed ? "failed" : "ok", reason: resp && resp.reason, out: gdRedactOut(msg.action, resp && resp.text),
    label: msg._label || undefined,
  }, tab);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { wcUnion, wcMergePolicy, wcMergeCfg, wcSenderKind, gdHudLineKind, gdHost, gdMatch, gdDeniedInChain, gdActSpec, gdIsRisky, gdRecShoot, gdRedactOut, GD_RISKY };
}
