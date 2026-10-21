const $ = (id) => document.getElementById(id);
const FIELDS = ["bus", "secret", "workKey", "name", "brainUrl", "brainToken"];

async function load() {
  const { cfg = {}, status, feed, activeCfg } = await chrome.storage.local.get(["cfg", "status", "feed", "activeCfg"]);
  FIELDS.forEach((f) => { if (cfg[f] != null) $(f).value = cfg[f]; });
  render(status, feed, activeCfg || cfg);
}
function render(status, feed, cfg) {
  $("status").textContent = status || "—";
  $("dot").className = "dot " + (status === "connected" ? "on" : status === "disconnected" ? "off" : "");
  // Connected → collapse the config form into a one-line summary; the popup's
  // job then is status + feed, not re-entering credentials every time.
  // cfg here is activeCfg (the identity actually joined on the bus, incl. the
  // per-install instance suffix) so two profiles are distinguishable.
  const on = status === "connected";
  $("cfgBox").open = !on;
  $("summaryLine").style.display = on ? "block" : "none";
  if (on && cfg) $("summaryLine").textContent =
    "✓ " + (cfg.name || "webclaw") + "\n@ " + (cfg.bus || "?") + " · " + (cfg.workKey || "?") + (cfg.version ? " · " + cfg.version.replace("webclaw/", "v") : "");
  $("feed").innerHTML = (feed || []).map((e) => {
    const cls = e.name && e.name.includes("HUD") ? "chat" : e.dir;
    return `<div><span class="muted">${escapeHtml(e.at)}</span> <span class="${cls}">${e.dir === "in" ? "→" : "←"} ${escapeHtml(e.name)}</span> ${escapeHtml(e.text)}</div>`;
  }).join("");
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

$("connect").onclick = async () => {
  // keep everything else in the stored cfg (e.g. standalone) — only the form fields change
  const { cfg: prev = {} } = await chrome.storage.local.get("cfg");
  const cfg = Object.assign({}, prev);
  FIELDS.forEach((f) => (cfg[f] = $(f).value.trim()));
  cfg.role = "executor";
  cfg.caps = ["browser", "fetch", "agent", "webclaw"];
  await chrome.storage.local.set({ cfg });
  chrome.runtime.sendMessage({ type: "connect" }, () => {});
  $("status").textContent = "connecting…";
};

// v0.9.0 — policy / prefs / identity. Only the human sets these (markers can read them).
// A6 — the form shows the *effective* policy (config.local.json floor + popup
// values) and saving writes back only the fields the human actually changed.
// Deny entries from config.local.json are always in force; removing them here
// has no effect (shown as "파일 고정").
const lines = (v) => v.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
let shown = null, fileDeny = [];
function readForm() {
  return {
    mode: $("pMode").value, allow: lines($("pAllow").value).join("\n"), deny: lines($("pDeny").value).join("\n"),
    confirmRisky: $("pRisky").checked, audit: $("pAudit").checked,
    cdp: $("pCdp").value, relayScope: $("pRelay").value, webmcp: $("pWebmcp").checked ? "on" : "off",
    iOn: $("iOn").checked, iAgent: $("iAgent").value.trim(),
  };
}
async function loadGuard() {
  const { prefs = {}, identity = {} } = await chrome.storage.local.get(["prefs", "identity"]);
  const eff = await new Promise((r) => chrome.runtime.sendMessage({ type: "effectivePolicy" }, (x) => { void chrome.runtime.lastError; r(x || {}); }));
  const policy = eff.policy || {};
  fileDeny = eff.fileDeny || [];
  $("pMode").value = policy.mode || "auto";
  $("pAllow").value = (policy.allow || []).join("\n");
  $("pDeny").value = (policy.deny || []).join("\n");
  $("pDenyFile").textContent = fileDeny.length ? "파일 고정(config.local.json, 제거 불가): " + fileDeny.join(", ") : "";
  $("pRisky").checked = !!policy.confirmRisky;
  $("pAudit").checked = policy.audit !== false;
  $("pCdp").value = prefs.cdp || "auto";
  $("pRelay").value = prefs.relayScope || "space";
  $("pWebmcp").checked = prefs.webmcp !== "off";
  $("iOn").checked = !!identity.on;
  $("iAgent").value = identity.agentUrl || "";
  shown = readForm();
}
$("saveGuard").onclick = async () => {
  if (!shown) return;
  const now = readForm();
  const changed = (k) => now[k] !== shown[k];
  const { policy = {}, prefs = {}, identity = {} } = await chrome.storage.local.get(["policy", "prefs", "identity"]);
  if (changed("mode")) policy.mode = now.mode;
  if (changed("allow")) policy.allow = lines(now.allow);
  if (changed("deny")) policy.deny = lines(now.deny).filter((d) => !fileDeny.includes(d));
  if (changed("confirmRisky")) policy.confirmRisky = now.confirmRisky;
  if (changed("audit")) policy.audit = now.audit;
  if (changed("cdp")) prefs.cdp = now.cdp;
  if (changed("relayScope")) prefs.relayScope = now.relayScope;
  if (changed("webmcp")) prefs.webmcp = now.webmcp;
  if (changed("iOn")) identity.on = now.iOn;
  if (changed("iAgent")) identity.agentUrl = now.iAgent;
  await chrome.storage.local.set({ policy, prefs, identity });
  await loadGuard();
  $("saveGuard").textContent = "저장됨 ✓";
  setTimeout(() => ($("saveGuard").textContent = "정책 저장"), 1500);
};
loadGuard();

// S1 — pending approvals are answered here (or in the side panel), never in
// the page HUD.
function renderApprovals(list) {
  const box = $("approvals");
  box.innerHTML = "";
  box.style.display = list && list.length ? "block" : "none";
  for (const a of list || []) {
    const row = document.createElement("div");
    row.className = "ap";
    const t = document.createElement("div");
    t.textContent = "🛡️ " + (a.risky ? "(위험) " : "") + a.what + " @ " + a.host;
    row.appendChild(t);
    for (const [ans, label] of [["allow", "이번만 허용"], ["allow-site", "이 사이트 허용"], ["deny", "거절"]]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = ans === "deny" ? "ghost" : "";
      b.onclick = () => chrome.runtime.sendMessage({ type: "approve", id: a.id, answer: ans }, (r) => { void chrome.runtime.lastError; renderApprovals(r && r.pending); });
      row.appendChild(b);
    }
    box.appendChild(row);
  }
}
chrome.runtime.sendMessage({ type: "approvals" }, (r) => { void chrome.runtime.lastError; renderApprovals(r && r.pending); });
chrome.runtime.onMessage.addListener((m, sender) => {
  if (m && m.type === "approvalsUpdated" && sender.id === chrome.runtime.id && !sender.tab) renderApprovals(m.pending);
});

$("hudHere").onclick = () => chrome.runtime.sendMessage({ type: "hudHere" }, () => {});
chrome.storage.onChanged.addListener(async () => {
  const { cfg, status, feed, activeCfg } = await chrome.storage.local.get(["cfg", "status", "feed", "activeCfg"]);
  render(status, feed, activeCfg || cfg);
});
load();
