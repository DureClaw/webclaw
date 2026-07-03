// webclaw background service worker — owns chrome.storage/tabs/scripting and the
// offscreen document that holds the persistent bus WebSocket.

const CAP = 2000000; // raised for large grading pages (2MB)
                    // task.result frame is fine (screenshots already send ~262KB).

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Maintain a persistent WebSocket connection to the DureClaw bus.",
  });
}
ensureOffscreen(); // run on SW load
chrome.runtime.onInstalled.addListener(ensureOffscreen);
chrome.runtime.onStartup.addListener(ensureOffscreen);

// ===== Wide Worker workspace: tasks = tab groups, per-task chat (v0.5.0) =====
// State: { tasks:[{id,name,groupId,chat:[{role,text}]}], activeId } in storage.
async function wwGet() {
  const { wwTasks = [], wwActive = null } = await chrome.storage.local.get(["wwTasks", "wwActive"]);
  return { tasks: wwTasks, activeId: wwActive };
}
async function wwSet(tasks, activeId) {
  await chrome.storage.local.set({ wwTasks: tasks, wwActive: activeId });
  // ping open tabs so every workspace bar refreshes
  const all = await chrome.tabs.query({});
  all.forEach((t) => { try { chrome.tabs.sendMessage(t.id, { type: "wwUpdated" }); } catch {} });
}
async function wwNewTask(name) {
  const { tabs } = await wwGetRaw();
  // create the task's first tab and put it in a collapsed-able tab group
  const win = await chrome.windows.getLastFocused();
  const tab = await chrome.tabs.create({ url: `http://localhost:4111/`, windowId: win.id, active: true });
  let groupId = null;
  try {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: name, color: "cyan" });
  } catch {}
  const id = "t" + Date.now();
  tabs.push({ id, name, groupId, chat: [] });
  await chrome.storage.local.set({ wwTasks: tabs, wwActive: id });
  await wwSet(tabs, id);
  return id;
}
async function wwGetRaw() { const { wwTasks = [] } = await chrome.storage.local.get("wwTasks"); return { tabs: wwTasks }; }
async function wwSwitchTask(id) {
  const { tabs } = await wwGetRaw();
  const task = tabs.find((t) => t.id === id);
  await chrome.storage.local.set({ wwActive: id });
  // focus the group's tabs (uncollapse this one, collapse others)
  for (const t of tabs) {
    if (t.groupId == null) continue;
    try { await chrome.tabGroups.update(t.groupId, { collapsed: t.id !== id }); } catch {}
  }
  if (task && task.groupId != null) {
    try {
      const gtabs = await chrome.tabs.query({ groupId: task.groupId });
      if (gtabs[0]) await chrome.tabs.update(gtabs[0].id, { active: true });
    } catch {}
  }
  await wwSet(tabs, id);
}
async function wwChat(id, text) {
  const { tabs } = await wwGetRaw();
  const task = tabs.find((t) => t.id === id) || tabs[0];
  if (!task) return;
  task.chat = task.chat || [];
  task.chat.push({ role: "me", text });
  await chrome.storage.local.set({ wwTasks: tabs });
  await wwSet(tabs, id);
  // ask the local brain, scoped to this task
  const cfg = await readCfg();
  let out = "두뇌가 설정되지 않았습니다.";
  if (cfg.brainUrl) {
    try {
      const h = { "content-type": "application/json" };
      if (cfg.brainToken) h.authorization = "Bearer " + cfg.brainToken;
      const r = await fetch(String(cfg.brainUrl).replace(/\/$/, "") + "/brain/exec", {
        method: "POST", headers: h,
        body: JSON.stringify({ prompt: `작업 "${task.name}" 컨텍스트에서 사용자 요청에 한국어로 답하라.\n요청: ${text}` }),
      });
      const j = await r.json(); out = (j.output ?? j.error ?? "").trim() || "응답 없음";
    } catch (e) { out = "brain 연결 실패: " + e; }
  }
  const cur = (await wwGetRaw()).tabs;
  const t2 = cur.find((t) => t.id === task.id);
  if (t2) { t2.chat.push({ role: "ai", text: out }); await chrome.storage.local.set({ wwTasks: cur }); await wwSet(cur, id); }
}
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || !msg.type || !msg.type.startsWith("ww")) return;
  (async () => {
    if (msg.type === "wwState") { const s = await wwGet(); sendResponse({ ...s, open: false }); return; }
    if (msg.type === "wwNewTask") { await wwNewTask(msg.name); sendResponse({ ok: true }); return; }
    if (msg.type === "wwSwitchTask") { await wwSwitchTask(msg.id); sendResponse({ ok: true }); return; }
    if (msg.type === "wwChat") { await wwChat(msg.id, msg.text); sendResponse({ ok: true }); return; }
    sendResponse(null);
  })();
  return true; // async
});

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg && msg.type === "connect") {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ type: "restart" }).catch(() => {}))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

// Stable per-install id so two Chrome profiles running webclaw show up as
// distinct nodes (webclaw@chrome-ab12) instead of colliding on one name and
// both answering the same task.
async function instanceId() {
  let { instanceId } = await chrome.storage.local.get("instanceId");
  if (!instanceId) {
    instanceId = Math.random().toString(36).slice(2, 6);
    await chrome.storage.local.set({ instanceId });
  }
  return instanceId;
}

// Config provider — the offscreen node can't read chrome.storage, so it asks here.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "getCfg") return;
  chrome.storage.local.get("cfg").then(async ({ cfg }) => {
    if (!cfg || !cfg.bus) {
      try { cfg = await (await fetch(chrome.runtime.getURL("config.local.json"))).json(); } catch (e) {}
    }
    if (cfg && cfg.bus) {
      const id = await instanceId();
      if (cfg.name && !cfg.name.endsWith("-" + id)) cfg.name = cfg.name + "-" + id;
    }
    sendResponse(cfg && cfg.bus ? cfg : null);
  });
  return true; // async
});

// State sink — the offscreen node can't write chrome.storage, so it routes here (for the popup).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "state" && msg.patch) chrome.storage.local.set(msg.patch);
});

// #11 — HUD chat: a message typed into the on-page panel. Echo it locally and
// forward to the offscreen node, which publishes it into the per-node inbox
// slot on the bus (task_id "hud-inbox-<node>") for the orchestrator to poll.
// Read effective config (chrome.storage.cfg, else bundled config.local.json).
async function readCfg() {
  let { cfg } = await chrome.storage.local.get("cfg");
  if (!cfg) { try { cfg = await (await fetch(chrome.runtime.getURL("config.local.json"))).json(); } catch (e) {} }
  return cfg || {};
}

// Standalone brain call: ask the local Wide Worker brain to turn a chat line
// into ONE webclaw marker (or a plain answer), run it, and reply — so a single
// machine works with no fleet master polling the inbox.
async function standaloneHandle(tabId, text, url) {
  const cfg = await readCfg();
  const prompt =
    "You drive a browser via single-line markers. Given the user's request, reply with EXACTLY ONE line:\n" +
    "- to search/open a site: [OPEN] <url>\n- to read: [DOM] <css?>\n- to click: [CLICK] <css>\n" +
    "- to fill: [FILL] <css> = <value>\n- to download: [DOWNLOAD] <url> [:: name]\n" +
    "- otherwise answer the user in one short sentence (no marker).\n" +
    "Current tab: " + (url || "") + "\nUser: " + text;
  const h = { "content-type": "application/json" };
  if (cfg.brainToken) h.authorization = "Bearer " + cfg.brainToken;
  let out = "";
  try {
    const r = await fetch(String(cfg.brainUrl).replace(/\/$/, "") + "/brain/exec", {
      method: "POST", headers: h, body: JSON.stringify({ prompt }),
    });
    const j = await r.json();
    out = (j.output ?? j.error ?? "").trim();
  } catch (e) { out = "brain 연결 실패: " + e; }

  const line = out.split("\n").find((l) => l.trim().startsWith("[")) || out;
  const mk = line.match(/^\s*\[([A-Za-z]+\??)\]/);
  if (mk) {
    // execute the chosen marker locally (reuse the same handlers)
    const rest = line.replace(/^\s*\[[A-Za-z?]+\]\s*/, "").trim();
    const name = mk[1].toUpperCase();
    hudNotify(tabId, "🤖 " + line, null, true);
    if (name === "OPEN") { const t = await pickTab(); await new Promise((res) => chrome.runtime.sendMessage({ type: "open", url: rest }, res)); }
    // (other markers can be wired here; OPEN covers the common "검색/열기" case)
  } else {
    hudNotify(tabId, "🤖 master: " + out.slice(0, 300));
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "hudChat") return;
  const tabId = sender.tab && sender.tab.id;
  if (tabId) {
    hudNotify(tabId, "🧑 나: " + msg.text);
    chrome.storage.local.set({ lastChatTabId: tabId });
  }
  readCfg().then((cfg) => {
    if (cfg.standalone && cfg.brainUrl) {
      // single-machine: process locally, no bus/master needed.
      if (tabId) standaloneHandle(tabId, msg.text, msg.url || "");
    } else {
      // fleet mode: publish to the inbox for a remote master to pick up.
      chrome.runtime.sendMessage({ type: "busInbox", text: msg.text, url: msg.url || "" }).catch(() => {});
    }
  });
});

// Popup quick action — turn the HUD on for the active tab.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "hudHere") return;
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
    if (!tab) { sendResponse({ ok: false }); return; }
    hudNotify(tab.id, "HUD on — 이 탭에서 에이전트가 작업합니다").then(() => sendResponse({ ok: true }));
  });
  return true; // async
});

// Pick the target tab: a URL-substring match (to hit a specific logged-in
// session across many tabs), else the active tab of the last focused window.
async function pickTab(urlMatch) {
  if (urlMatch) {
    const tabs = await chrome.tabs.query({});
    // Skip discarded (memory-unloaded) tabs — scripting cannot reach them and
    // fails with a misleading "must request permission" error. Prefer active,
    // then most-recently-accessed, among the matches.
    const hits = tabs.filter((t) => (t.url || "").includes(urlMatch) && !t.discarded);
    if (hits.length) {
      hits.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
      return hits[0];
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return active || null;
}

// #4 — navigation-triggering actions race with tab state: if the target tab is
// still loading (e.g. a previous CLICK/SUBMIT navigated it), wait for the new
// document to finish before injecting, so follow-up DOM/JS reads see the real
// page rather than a half-loaded one.
function waitTabReady(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(onUpd); resolve(); } };
    const onUpd = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError || !t || t.status === "complete") return finish();
      chrome.tabs.onUpdated.addListener(onUpd);
      setTimeout(finish, timeoutMs);
    });
  });
}

// [OPEN] <url> — open a URL in a new foreground tab (loads with the user's
// session), wait for it to finish, return title+URL. The natural way to *show*
// a result to the human (e.g. a search) instead of scraping it.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "open") return;
  chrome.tabs.create({ url: msg.url, active: true }).then(async (tab) => {
    await waitTabReady(tab.id, 20000);
    const t = await chrome.tabs.get(tab.id);
    hudNotify(tab.id, "[OPEN] " + msg.url.slice(0, 80));
    sendResponse({ text: "opened (tab " + tab.id + "): " + (t.title || "") + " — " + (t.url || "") });
  }).catch((e) => sendResponse({ text: "open error: " + e }));
  return true; // async
});

// [TABS] — list open tabs so the master can see which one holds the logged-in
// session and target it with @<url-substring>.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "tabs") return;
  chrome.tabs.query({}).then((tabs) => {
    const list = tabs
      .map((t) => `${t.active ? "*" : " "} [${t.windowId}] ${t.title || ""} — ${t.url || ""}`)
      .join("\n");
    sendResponse({ text: list.slice(0, CAP) || "(no tabs)" });
  });
  return true; // async
});

// [DOM] hands — read the target tab's DOM (raised cap, waits out navigation).
// mode "links" → [{text, href}] for anchors; mode "attr" → attribute values. (#8)
// Over-cap output gets an explicit truncated trailer instead of a silent cut. (#9)
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "dom") return;
  pickTab(msg.urlMatch).then(async (tab) => {
    if (!tab) { sendResponse({ text: "(no target tab)" }); return; }
    await waitTabReady(tab.id); // #4
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (q, cap, mode, attr) => {
        const capped = (s) => (s.length > cap ? s.slice(0, cap) + "\n…[truncated, " + (s.length - cap) + " more bytes]" : s);
        try {
          if (mode === "links") {
            const els = [...document.querySelectorAll(q || "a[href]")];
            return capped(JSON.stringify(els.map((a) => ({ text: (a.innerText || "").trim().slice(0, 200), href: a.href }))));
          }
          if (mode === "attr") {
            const els = [...document.querySelectorAll(q)];
            if (!els.length) return "(no match for: " + q + ")";
            return capped(JSON.stringify(els.map((e) => e.getAttribute(attr))));
          }
          if (!q) return capped(document.title + " | " + location.href + "\n" + document.body.innerText);
          const els = [...document.querySelectorAll(q)];
          if (!els.length) return "(no match for: " + q + ")";
          return capped(els.map((e) => (e.innerText || e.textContent || "").trim()).join("\n"));
        } catch (e) { return "DOM error: " + e; }
      },
      args: [msg.query || "", CAP, msg.mode || "", msg.attr || ""],
    }).then((res) => {
      const out = res && res[0] ? res[0].result : "(no result)";
      hudNotify(tab.id, "[" + (msg.mode || "dom").toUpperCase() + "] " + (msg.query || "(page)") + " → " + String(out).length + " chars", null, true); // #10 working
      sendResponse({ text: out });
    }).catch((e) => sendResponse({ text: "scripting error: " + e }));
  });
  return true; // async
});

// [DOWNLOAD] <url> — trigger a real browser download (session cookies included,
// saved to disk). #2 — resolve on *completion*, not start: wait for the download
// to finish (or fail) and report the final path/size, so the master never has to
// poll the filesystem. Long downloads time out to "in_progress" and can be
// re-queried with [DOWNLOAD?] <id>.
const DL_WAIT_MS = 120000;

function describeDownload(id) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id }, (items) => {
      const d = items && items[0];
      if (!d) return resolve("download id=" + id + " not found");
      resolve(
        "download " + d.state + " (id=" + id + ") → " + (d.filename || d.url) +
        (d.fileSize > 0 ? " (" + d.fileSize + " bytes)" : "") +
        (d.error ? " error=" + d.error : "")
      );
    });
  });
}

function waitDownloadDone(id, timeoutMs = DL_WAIT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChg);
      describeDownload(id).then((desc) => resolve(how === "timeout" ? desc.replace(/^download \w+/, "download in_progress") : desc));
    };
    const onChg = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete" || delta.state.current === "interrupted") finish("state");
    };
    chrome.downloads.onChanged.addListener(onChg);
    // it may already be finished by the time we attach the listener
    chrome.downloads.search({ id }, (items) => {
      const d = items && items[0];
      if (d && (d.state === "complete" || d.state === "interrupted")) finish("state");
    });
    setTimeout(() => finish("timeout"), timeoutMs);
  });
}

// #7 — serialize downloads: browsers block bursts of automated downloads from
// one site, and parallel dispatch causes duplicates on blind retry. Chain every
// [DOWNLOAD] through a single promise queue (concurrency 1).
let dlChain = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "download") return;
  try {
    // [DOWNLOAD?] <id> — status re-query for a long-running download.
    if (msg.statusOnly) {
      describeDownload(Number(msg.url)).then((text) => sendResponse({ text }));
      return true;
    }
    // [CANCEL] <id|all> — stop a runaway download without manual browser UI. (#7)
    if (msg.cancel) {
      const target = String(msg.url).trim();
      if (target === "all") {
        chrome.downloads.search({ state: "in_progress" }, (items) => {
          (items || []).forEach((d) => chrome.downloads.cancel(d.id));
          sendResponse({ text: "cancelled " + (items || []).length + " in-progress download(s)" });
        });
      } else {
        chrome.downloads.cancel(Number(target), () => {
          if (chrome.runtime.lastError) sendResponse({ text: "cancel error: " + chrome.runtime.lastError.message });
          else describeDownload(Number(target)).then((text) => sendResponse({ text }));
        });
      }
      return true;
    }
    // saveAs:false suppresses the per-file "Save as" dialog even when the
    // browser is configured to ask for a location — automated downloads land
    // directly in Downloads/ (or the given sub-path) with no human click.
    const opts = { url: msg.url, conflictAction: "uniquify", saveAs: false };
    // Optional target sub-path under Downloads (sanitized) — keeps same-named
    // files from different sources apart.
    if (msg.path) opts.filename = String(msg.path).replace(/\.\.(\/|\\)/g, "").replace(/^[/\\]+/, "");
    dlChain = dlChain.then(() => new Promise((resolveQueue) => {
      chrome.downloads.download(opts, (id) => {
        if (chrome.runtime.lastError) { sendResponse({ text: "download error: " + chrome.runtime.lastError.message }); resolveQueue(); }
        else waitDownloadDone(id).then(async (text) => {
          // Downloads are tab-independent → mirror into the conversation tab
          // with a [전체] (global) badge instead of every tab's panel.
          const { lastChatTabId } = await chrome.storage.local.get("lastChatTabId");
          if (lastChatTabId) hudNotify(lastChatTabId, "⬇️ " + text.slice(0, 140), null, true, "global");
          sendResponse({ text });
          resolveQueue();
        }); // #2
      });
    })).catch(() => {});
  } catch (e) { sendResponse({ text: "download error: " + e }); }
  return true; // async
});

// #10 — visual HUD injected as a *static* extension function (isolated world,
// so page CSP that forbids eval cannot block it): a glowing "agent is working
// here" border, a ghost cursor on clicks, and a right-side action log panel so
// the human can supervise what the agent does in their browser.
// Persistent chat history, **scoped per tab** (like one session per tab):
// survives page navigations within the tab, but other tabs don't see it.
// Tab-independent events (downloads etc.) are mirrored into the conversation
// tab with a [전체] (global) badge so scopes are distinguishable.
async function hudHistory(tabId, entry) {
  const { chatHistories = {} } = await chrome.storage.local.get("chatHistories");
  const key = String(tabId);
  const hist = chatHistories[key] || [];
  if (entry) {
    hist.push(entry);
    while (hist.length > 120) hist.shift();
    chatHistories[key] = hist;
    await chrome.storage.local.set({ chatHistories });
  }
  return hist.slice(-60);
}

// Closed tab → drop its conversation (a session ends with its tab).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { chatHistories = {} } = await chrome.storage.local.get("chatHistories");
  if (chatHistories[String(tabId)]) {
    delete chatHistories[String(tabId)];
    chrome.storage.local.set({ chatHistories });
  }
});

function hudNotify(tabId, text, click, working, scope) {
  const run = async () => {
    let hist = [];
    if (text && text !== "__OFF__") {
      const kind = text.startsWith("🧑") ? "user" : text.startsWith("🤖 master") ? "master" : "action";
      const shown = (scope === "global" ? "[전체] " : "") + String(text).slice(0, 300);
      hist = await hudHistory(tabId, { at: new Date().toLocaleTimeString().slice(0, 8), kind, text: shown });
    } else if (text !== "__OFF__") {
      hist = await hudHistory(tabId, null);
    }
    return chrome.scripting.executeScript({
      target: { tabId },
      func: hudInjected,
      args: [text || "", click || null, text === "__OFF__", !!working, hist, scope || "tab"],
    });
  };
  return run().catch(() => {});
}

function hudInjected(text, click, off, working, hist, scope) {
      const ID = "__wc_hud";
      if (off) {
        const r = document.getElementById(ID); if (r) r.remove();
        const s = document.getElementById(ID + "_style"); if (s) s.remove();
        return "hud off";
      }
      if (!document.getElementById(ID + "_style")) {
        const s = document.createElement("style");
        s.id = ID + "_style";
        s.textContent =
          "@keyframes __wcGlow{0%,100%{box-shadow:inset 0 0 28px 6px #00ffcc;border-color:#00ffcc}50%{box-shadow:inset 0 0 64px 16px #ff00ff;border-color:#ff00ff}}" +
          "@keyframes __wcRipple{from{transform:scale(.35);opacity:.95}to{transform:scale(2.6);opacity:0}}";
        document.documentElement.appendChild(s);
      }
      let root = document.getElementById(ID);
      if (!root) {
        root = document.createElement("div");
        root.id = ID;
        root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
        const frame = document.createElement("div");
        frame.className = "f";
        // The glow border only shows *while an action is executing* (fades out
        // a few seconds after the last action) — a steady blink is noise.
        frame.style.cssText = "position:fixed;inset:0;border:7px solid #00ffcc;border-radius:12px;animation:__wcGlow 1.4s ease-in-out infinite;pointer-events:none;opacity:0;transition:opacity .4s";
        const panel = document.createElement("div");
        panel.className = "p";
        panel.style.cssText = "position:fixed;top:14px;right:14px;bottom:14px;width:280px;display:flex;flex-direction:column;background:rgba(10,12,24,.88);color:#c8ffee;font:11px/1.5 ui-monospace,monospace;border:1px solid #00ffcc;border-radius:10px;padding:10px;pointer-events:auto;backdrop-filter:blur(3px)";
        panel.innerHTML = "<div style='color:#00ffcc;font-weight:700;margin-bottom:6px'>💬 webclaw chat <span style='color:#8fa3b8;font-weight:400;font-size:10px'>— 이 탭의 대화</span></div><div class='lines' style='flex:1;overflow-y:auto'></div>";
        // #11 — two-way chat: the human can instruct the agent from the page.
        const input = document.createElement("input");
        input.className = "chat";
        input.placeholder = "에이전트에게 지시… (Enter)";
        input.style.cssText = "margin-top:8px;padding:6px 8px;border:1px solid #00ffcc;border-radius:7px;background:rgba(0,0,0,.5);color:#c8ffee;font:11px ui-monospace,monospace;outline:none";
        input.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" || !input.value.trim()) return;
          ev.stopPropagation();
          const t = input.value.trim();
          input.value = "";
          try { chrome.runtime.sendMessage({ type: "hudChat", text: t, url: location.href }); } catch (e) {}
        });
        input.addEventListener("keydown", (ev) => ev.stopPropagation());
        input.addEventListener("keyup", (ev) => ev.stopPropagation());
        panel.appendChild(input);
        const cur = document.createElement("div");
        cur.className = "c";
        cur.style.cssText = "position:fixed;left:-100px;top:-100px;width:26px;height:26px;pointer-events:none;transition:left .35s ease,top .35s ease;font-size:22px;line-height:1;filter:drop-shadow(0 0 6px #ff00ff)";
        cur.textContent = "🖱️";
        root.append(frame, panel, cur);
        document.documentElement.appendChild(root);
      }
      if (working) {
        const frame = root.querySelector(".f");
        frame.style.opacity = "1";
        clearTimeout(window.__wcHudGlowT);
        window.__wcHudGlowT = setTimeout(() => { frame.style.opacity = "0"; }, 3000);
      }
      if (click && typeof click.x === "number") {
        const cur = root.querySelector(".c");
        cur.style.left = click.x - 4 + "px";
        cur.style.top = click.y - 2 + "px";
        const rip = document.createElement("div");
        rip.style.cssText = "position:fixed;left:" + (click.x - 18) + "px;top:" + (click.y - 18) + "px;width:36px;height:36px;border:3px solid #ff00ff;border-radius:50%;animation:__wcRipple .8s ease-out forwards;pointer-events:none";
        root.appendChild(rip);
        setTimeout(() => rip.remove(), 900);
      }
      // Render the persisted conversation (session-like): on a fresh panel the
      // whole recent history is restored — the current `text` is already its
      // last entry — so the dialogue continues across page navigations.
      const lines = root.querySelector(".p .lines");
      const addLine = (at, kind, txt) => {
        const line = document.createElement("div");
        const color = kind === "user" ? ";color:#ffd166" : kind === "master" ? ";color:#7ef9dd" : ";color:#8fa3b8;font-size:10px";
        line.style.cssText = "margin:2px 0;border-bottom:1px dashed rgba(0,255,204,.12);padding-bottom:2px;word-break:break-all" + color;
        line.textContent = at + " " + txt;
        lines.appendChild(line);
      };
      if (lines.dataset.restored !== "1") {
        lines.dataset.restored = "1";
        (hist || []).forEach((h) => addLine(h.at, h.kind, h.text));
      } else if (text) {
        const kind = text.startsWith("🧑") ? "user" : text.startsWith("🤖 master") ? "master" : "action";
        addLine(new Date().toLocaleTimeString().slice(0, 8), kind, (scope === "global" ? "[전체] " : "") + String(text).slice(0, 300));
      }
      while (lines.children.length > 80) lines.removeChild(lines.children[0]);
      lines.scrollTop = lines.scrollHeight;
      return "hud ok";
}

// [CLICK]/[FILL]/[TYPE]/[SUBMIT]/[JS] — act on the target tab (real interaction).
// #6 — the injected function is async and awaits thenable eval results, so [JS]
// bodies can use `await` (via async IIFE) for wait-then-read workflows.
// #3 — fill re-reads the value after dispatching events and reports the value
// the page actually kept (framework handlers may transform or reject it).
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.type !== "act") return;
  pickTab(msg.urlMatch).then(async (tab) => {
    if (!tab) { sendResponse({ text: "(no target tab)" }); return; }
    await waitTabReady(tab.id); // #4
    // [HUD] on|off — manual toggle of the visual supervision layer. (#10)
    if (msg.action === "hud") {
      const on = String(msg.code || "").trim() !== "off";
      hudNotify(tab.id, on ? "HUD on — 이 탭에서 에이전트가 작업합니다" : "__OFF__")
        .then(() => sendResponse({ text: "hud " + (on ? "on" : "off") + " @ tab " + tab.id }));
      return;
    }
    // [SAY] <text> — master's reply rendered into the HUD chat panel. (#11)
    if (msg.action === "say") {
      hudNotify(tab.id, "🤖 master: " + String(msg.code || ""))
        .then(() => sendResponse({ text: "said @ tab " + tab.id }));
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (action, selector, value, code, cap) => {
        const q = (s) => document.querySelector(s);
        try {
          if (action === "click") {
            const el = q(selector);
            if (!el) return "(no match: " + selector + ")";
            const r = el.getBoundingClientRect();
            el.click();
            return "clicked " + selector + " @" + Math.round(r.left + r.width / 2) + "," + Math.round(r.top + r.height / 2);
          }
          if (action === "fill" || action === "type") {
            const el = q(selector);
            if (!el) return "(no match: " + selector + ")";
            el.focus();
            const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
            const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value");
            if (setter && setter.set) { setter.set.call(el, value); } else { el.value = value; }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            // #3 read-back: report what the page actually kept, not what we sent.
            const kept = el.value;
            return kept === value
              ? "filled " + selector + " = " + kept
              : "filled " + selector + " = " + kept + " (WARNING: page kept a different value than sent: " + value + ")";
          }
          if (action === "submit") {
            const el = q(selector);
            if (!el) return "(no match: " + selector + ")";
            if (el.tagName === "FORM") el.submit();
            else if (el.form) el.form.submit();
            else el.click();
            return "submitted " + selector;
          }
          if (action === "js") {
            // eslint-disable-next-line no-eval
            let r = eval(code);
            if (r && typeof r.then === "function") r = await r; // #6 async support
            const s = typeof r === "object" ? JSON.stringify(r) : String(r);
            return s.length > cap ? s.slice(0, cap) + "\n…[truncated, " + (s.length - cap) + " more bytes]" : s; // #9
          }
          return "(unknown action: " + action + ")";
        } catch (e) {
          // #9 — distinguish "page policy" from "code bug": CSP'd pages reject
          // eval; the static markers ([DOM]/[CLICK]/[FILL]/[SUBMIT]) still work.
          const m = String(e);
          if (action === "js" && /unsafe-eval|Content Security Policy|EvalError/i.test(m))
            return "js blocked by page CSP (eval forbidden on this site) — use the static markers [DOM]/[CLICK]/[FILL]/[SUBMIT] instead. " + m;
          return action + " error: " + e;
        }
      },
      args: [msg.action, msg.selector || "", msg.value || "", msg.code || "", CAP],
    }).then((res) => {
      const out = res && res[0] ? String(res[0].result) : "(no result)";
      // #10 — mirror the action into the on-page HUD (border + log; ghost
      // cursor when the click reported its coordinates).
      let click = null;
      const cm = out.match(/@(\d+),(\d+)$/);
      if (msg.action === "click" && cm) click = { x: +cm[1], y: +cm[2] };
      hudNotify(tab.id, "[" + msg.action.toUpperCase() + "] " + (msg.selector || (msg.code || "").slice(0, 60)) + " → " + out.slice(0, 90), click, true); // working
      sendResponse({ text: out });
    }).catch((e) => sendResponse({ text: "act error: " + e }));
  });
  return true; // async
});
