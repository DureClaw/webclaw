// Wide Worker side panel — native aside (not a page overlay). Tasks (= tab
// groups) across the top, per-task chat below. "새 작업" creates a task
// immediately; the first message auto-titles it. All state + brain calls live
// in the background service worker.
const B = (msg) => new Promise((r) => { try { chrome.runtime.sendMessage(msg, r); } catch { r(null); } });
const $ = (id) => document.getElementById(id);
let state = { tasks: [], activeId: null };

function render() {
  const t = $("tasks");
  [...t.querySelectorAll(".task")].forEach((e) => e.remove());
  const add = $("add");
  state.tasks.forEach((task) => {
    const el = document.createElement("div");
    el.className = "task" + (task.id === state.activeId ? " active" : "");
    el.innerHTML = `<span class="d"></span>${task.name || "새 작업"}`;
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
  try {
    const { cfg } = await chrome.storage.local.get("cfg");
    const base = (cfg && cfg.brainUrl) || "http://localhost:4111";
    const j = await (await fetch(base.replace(/\/$/, "") + "/health")).json();
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
load(); health(); setInterval(health, 5000);
