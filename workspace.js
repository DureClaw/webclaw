// Wide Worker workspace — a LEFT task sidebar injected into every tab (Chrome's
// native side panel is right-only, so we overlay). Tasks map to tab groups;
// each task has its own chat. Clicking a task switches to its tab group; the
// chat talks to the local brain (standalone) per task. The heavy lifting
// (tab-group create/switch, brain calls) is done in the background service
// worker — this file is just the UI shell, namespaced and removable.
(function () {
  if (window.top !== window) return;               // top frame only
  if (document.getElementById("__ww_ws")) return;  // once per tab
  const B = (msg) => new Promise((r) => { try { chrome.runtime.sendMessage(msg, r); } catch { r(null); } });

  // ---- shell ----
  const style = document.createElement("style");
  style.id = "__ww_ws_style";
  style.textContent = `
  #__ww_ws{position:fixed;left:0;top:0;bottom:0;width:60px;z-index:2147483646;
    background:rgba(8,10,20,.92);backdrop-filter:blur(8px);border-right:1px solid rgba(0,255,204,.18);
    display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px 6px;transition:width .18s;font:12px ui-monospace,monospace;color:#cfe}
  #__ww_ws.open{width:290px;align-items:stretch}
  #__ww_ws .brand{display:flex;align-items:center;gap:8px;color:#00ffcc;font-weight:800;cursor:pointer;padding:2px 4px}
  #__ww_ws .brand .full{display:none} #__ww_ws.open .brand .full{display:inline}
  #__ww_ws .tasks{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-top:4px}
  #__ww_ws .task{display:flex;align-items:center;gap:8px;padding:8px;border-radius:9px;cursor:pointer;
    border:1px solid transparent;background:rgba(255,255,255,.03)}
  #__ww_ws .task:hover{border-color:rgba(0,255,204,.3)}
  #__ww_ws .task.active{border-color:#00ffcc;background:rgba(0,255,204,.1)}
  #__ww_ws .dot{width:22px;height:22px;min-width:22px;border-radius:7px;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg,#00ffcc,#ff00ff);color:#04121a;font-weight:800}
  #__ww_ws .nm{display:none;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} #__ww_ws.open .nm{display:block}
  #__ww_ws .add{display:flex;align-items:center;justify-content:center;gap:6px;padding:8px;border-radius:9px;cursor:pointer;
    border:1px dashed rgba(0,255,204,.35);color:#9fe} #__ww_ws .add .full{display:none} #__ww_ws.open .add .full{display:inline}
  #__ww_ws .chat{display:none;flex-direction:column;gap:6px;margin-top:8px;border-top:1px solid rgba(0,255,204,.15);padding-top:8px}
  #__ww_ws.open .chat{display:flex}
  #__ww_ws .log{max-height:34vh;overflow-y:auto;display:flex;flex-direction:column;gap:6px}
  #__ww_ws .m{padding:7px 9px;border-radius:9px;white-space:pre-wrap;word-break:break-word;font-size:11px}
  #__ww_ws .me{align-self:flex-end;background:rgba(255,209,102,.14);border:1px solid rgba(255,209,102,.3)}
  #__ww_ws .ai{align-self:flex-start;background:rgba(0,255,204,.08);border:1px solid rgba(0,255,204,.2)}
  #__ww_ws .row{display:flex;gap:6px} #__ww_ws input{flex:1;padding:8px;border-radius:8px;border:1px solid rgba(0,255,204,.3);
    background:rgba(0,0,0,.4);color:#eaf6ff;outline:none}
  #__ww_ws button.send{border:0;border-radius:8px;padding:0 12px;font-weight:700;cursor:pointer;background:linear-gradient(90deg,#00ffcc,#38bdf8);color:#04121a}
  html{margin-left:60px!important}`;   // push page over so the bar never covers content
  document.documentElement.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "__ww_ws";
  bar.innerHTML = `
    <div class="brand" id="__ww_toggle">◇<span class="full">&nbsp;Wide Worker</span></div>
    <div class="tasks" id="__ww_tasks"></div>
    <div class="add" id="__ww_add">＋<span class="full">&nbsp;새 작업</span></div>
    <div class="chat">
      <div class="log" id="__ww_log"></div>
      <div class="row"><input id="__ww_in" placeholder="이 작업에 지시…"><button class="send" id="__ww_send">↵</button></div>
    </div>`;
  document.documentElement.appendChild(bar);

  let state = { tasks: [], activeId: null, open: false };
  const $ = (id) => document.getElementById(id);

  function render() {
    bar.classList.toggle("open", state.open);
    const t = $("__ww_tasks"); t.innerHTML = "";
    state.tasks.forEach((task) => {
      const el = document.createElement("div");
      el.className = "task" + (task.id === state.activeId ? " active" : "");
      el.innerHTML = `<span class="dot">${(task.name || "?").slice(0, 1)}</span><span class="nm">${task.name}</span>`;
      el.onclick = () => B({ type: "wwSwitchTask", id: task.id }).then(load);
      t.appendChild(el);
    });
    const log = $("__ww_log"); log.innerHTML = "";
    const active = state.tasks.find((x) => x.id === state.activeId);
    (active?.chat || []).forEach((m) => {
      const d = document.createElement("div"); d.className = "m " + (m.role === "me" ? "me" : "ai"); d.textContent = m.text; log.appendChild(d);
    });
    log.scrollTop = log.scrollHeight;
  }
  async function load() { const s = await B({ type: "wwState" }); if (s) { state = s; render(); } }

  $("__ww_toggle").onclick = () => { state.open = !state.open; render(); };
  $("__ww_add").onclick = async () => {
    const name = prompt("새 작업 이름 (예: 리서치, 쇼핑 비교)");
    if (name) { await B({ type: "wwNewTask", name }); load(); }
  };
  async function send() {
    const v = $("__ww_in").value.trim(); if (!v) return; $("__ww_in").value = "";
    await B({ type: "wwChat", id: state.activeId, text: v }); load();
    // poll briefly for the AI reply the background appends
    for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 700)); await load(); }
  }
  $("__ww_send").onclick = send;
  $("__ww_in").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); e.stopPropagation(); });

  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "wwUpdated") load(); });
  load();
})();
