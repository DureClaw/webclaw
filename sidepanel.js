// Wide Worker side panel — native aside (not a page overlay). Tasks (= tab
// groups) across the top, per-task chat below. "새 작업" creates a task
// immediately; the first message auto-titles it. All state + brain calls live
// in the background service worker.
const B = (msg) => new Promise((r) => { try { chrome.runtime.sendMessage(msg, r); } catch { r(null); } });
const $ = (id) => document.getElementById(id);
let state = { tasks: [], activeId: null };

function isWorker(cfg) { return !!(cfg && cfg.brainUrl); }
function setModeUI(worker) {
  $("modeBus").classList.toggle("active", !worker);
  $("modeWorker").classList.toggle("active", worker);
  $("brandText").textContent = worker ? "Wide Worker" : "Bus Node";
}

function render() {
  const t = $("tasks");
  [...t.querySelectorAll(".task")].forEach((e) => e.remove());
  const add = $("add");
  state.tasks.forEach((task) => {
    const el = document.createElement("div");
    el.className = "task" + (task.id === state.activeId ? " active" : "");
    // task names come from brain output — text only, never markup
    const dot = document.createElement("span"); dot.className = "d";
    el.append(dot, document.createTextNode(task.name || "새 작업"));
    el.onclick = () => B({ type: "wwSwitchTask", id: task.id }).then(load);
    t.insertBefore(el, add);
  });
  const log = $("log"); log.innerHTML = "";
  const active = state.tasks.find((x) => x.id === state.activeId);
  if (!active) {
    log.innerHTML = `<div class="empty"><h2>작업을 시작하세요</h2><p>＋ 새 작업을 누르고 지시하면<br>브라우저를 대신 조종합니다.</p></div>`;
    return;
  }
  (active.chat || []).forEach((m) => {
    const d = document.createElement("div"); d.className = "m " + (m.role === "me" ? "me" : "ai"); d.textContent = m.text; log.appendChild(d);
  });
  log.scrollTop = log.scrollHeight;
}
async function load() { const s = await B({ type: "wwState" }); if (s) { state = s; render(); } }

async function health() {
  const { cfg, status, activeCfg } = await chrome.storage.local.get(["cfg", "status", "activeCfg"]);
  const worker = isWorker(cfg);
  setModeUI(worker);
  if (!worker) {
    // Bus mode: show offscreen bus connection status
    const on = status === "connected";
    $("dot").className = "dot " + (on ? "on" : "off");
    $("stat").textContent = on
      ? ("버스 연결 · " + (activeCfg && activeCfg.name ? activeCfg.name : cfg.name || "?"))
      : (status === "disconnected" ? "버스 끊김" : "버스 대기중");
    return;
  }
  // Wide Worker mode: brain health
  try {
    const base = String(cfg.brainUrl || "http://localhost:4111").replace(/\/$/, "");
    const j = await (await fetch(base + "/health")).json();
    const b = j.backends || {}; const on = (j.chain || []).filter((k) => b[k + "-cli"] || b[k + "-api"]);
    $("dot").className = "dot " + (on.length ? "on" : "off");
    $("stat").textContent = on.length ? on.join(" › ") : "두뇌 미연결";
  } catch { $("dot").className = "dot off"; $("stat").textContent = "brain 없음"; }
}

$("add").onclick = async () => { await B({ type: "wwNewTask" }); await load(); $("in").focus(); };
async function send() {
  const v = $("in").value.trim(); if (!v) return; $("in").value = "";
  let id = state.activeId;
  if (!id) { const r = await B({ type: "wwNewTask" }); id = r && r.id; await load(); }
  await B({ type: "wwChat", id: id || state.activeId, text: v }); await load();
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 700)); await load(); }
}
$("send").onclick = send;
$("in").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "wwUpdated") load(); });

// S1 — policy approvals are answered here (extension-owned UI), never in the
// page HUD, where a page script could type "/allow-site" itself.
function renderApprovals(list) {
  const box = $("approvals");
  box.innerHTML = "";
  box.style.display = list && list.length ? "block" : "none";
  for (const a of list || []) {
    const row = document.createElement("div"); row.className = "ap";
    const q = document.createElement("div"); q.className = "q";
    q.textContent = "🛡️ 승인 요청" + (a.risky ? " (위험 동작)" : "") + ": " + a.what + " @ " + a.host + " · tab " + a.tabId;
    const btns = document.createElement("div"); btns.className = "btns";
    for (const [ans, label] of [["allow", "이번만 허용"], ["allow-site", "이 사이트 허용"], ["deny", "거절"]]) {
      const b = document.createElement("button");
      b.textContent = label;
      if (ans === "deny") b.className = "deny";
      b.onclick = () => B({ type: "approve", id: a.id, answer: ans }).then((r) => renderApprovals(r && r.pending));
      btns.appendChild(b);
    }
    row.append(q, btns);
    box.appendChild(row);
  }
}
B({ type: "approvals" }).then((r) => renderApprovals(r && r.pending));
chrome.runtime.onMessage.addListener((m, sender) => {
  if (m && m.type === "approvalsUpdated" && sender.id === chrome.runtime.id && !sender.tab) renderApprovals(m.pending);
});

async function switchMode(worker) {
  const { cfg = {} } = await chrome.storage.local.get("cfg");
  if (worker) {
    // To Wide Worker: keep current cfg, user fills brainUrl and connects
    if (!cfg.brainUrl) cfg.brainUrl = "http://localhost:4111";
  } else {
    // To Bus: remove brain fields, restart offscreen
    delete cfg.brainUrl;
    delete cfg.brainToken;
  }
  await chrome.storage.local.set({ cfg });
  setModeUI(worker);
  chrome.runtime.sendMessage({ type: "connect" }, () => {});
  health();
}
$("modeBus").onclick = () => switchMode(false);
$("modeWorker").onclick = () => switchMode(true);

load(); health(); setInterval(health, 5000);
