// webclaw background service worker — owns chrome.storage/tabs/scripting and the
// offscreen document that holds the persistent bus WebSocket.

// v0.7.0 modules: CDP layer, @ref outline, agent Spaces, site learnings.
importScripts("cdp.js", "refs.js", "spaces.js", "learn.js", "guard.js", "identity.js", "relay.js");

const CAP = 2000000; // raised for large grading pages (2MB)
                    // task.result frame is fine (screenshots already send ~262KB).

// SW startup can fire ensureOffscreen() from up to three places at once
// (the top-level call below, onInstalled, onStartup). Racing hasDocument()/
// createDocument() calls make Chrome tear down one document mid-load, which
// surfaces as an uncaught "Offscreen document closed before fully loading."
// Serialize every call through one chain so only one create/close is ever
// in flight, and swallow the benign race error if it still slips through.
// `force` (onInstalled/onStartup) only replaces a document left over from an
// earlier service-worker life. One this SW instance created moments ago is
// already fresh — recreating it killed its bus socket mid-task and dropped
// the first task's result right after install/update.
let offscreenChain = Promise.resolve();
let offscreenFresh = false;
function ensureOffscreen(force = false) {
  offscreenChain = offscreenChain.then(async () => {
    const has = await chrome.offscreen.hasDocument();
    if (has) {
      if (!force || offscreenFresh) return;
      await chrome.offscreen.closeDocument();
    }
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html?v=0.11.0",
        reasons: ["BLOBS"],
        justification: "Maintain a persistent WebSocket connection to the DureClaw bus.",
      });
      offscreenFresh = true;
    } catch (e) {
      if (!/closed before fully loading|single offscreen document/i.test(String(e))) throw e;
    }
  });
  return offscreenChain;
}
ensureOffscreen().catch((e) => console.warn("ensureOffscreen failed", e)); // run on SW load
chrome.runtime.onInstalled.addListener(() => ensureOffscreen(true).catch((e) => console.warn("ensureOffscreen failed", e)));
chrome.runtime.onStartup.addListener(() => ensureOffscreen(true).catch((e) => console.warn("ensureOffscreen failed", e)));

// Wide Worker side panel: clicking the toolbar icon opens the native aside; it
// also stays available on every tab.
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch {}

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
  // create the task's first tab and put it in a collapsed-able tab group.
  // Name is optional — the first chat message auto-titles the task.
  const nm = name || "새 작업";
  const win = await chrome.windows.getLastFocused();
  const tab = await chrome.tabs.create({ url: `http://localhost:4111/`, windowId: win.id, active: true });
  let groupId = null;
  try {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: nm, color: "cyan" });
  } catch {}
  const id = "t" + Date.now();
  tabs.push({ id, name: nm, groupId, chat: [], autoTitled: !!name });
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
  // ask the local brain, scoped to this task. mode:"chat" = answer only — the
  // brain drives the browser for mode:"goal" requests exclusively (A3).
  const cfg = await readCfg();
  let out = "두뇌가 설정되지 않았습니다.";
  if (cfg.brainUrl) {
    try {
      const h = { "content-type": "application/json" };
      if (cfg.brainToken) h.authorization = "Bearer " + cfg.brainToken;
      const r = await fetch(String(cfg.brainUrl).replace(/\/$/, "") + "/brain/exec", {
        method: "POST", headers: h,
        body: JSON.stringify({ prompt: `작업 "${task.name}" 컨텍스트에서 사용자 요청에 한국어로 답하라.\n요청: ${text}`, mode: "chat" }),
      });
      const j = await r.json(); out = (j.output ?? j.error ?? "").trim() || "응답 없음";
    } catch (e) { out = "brain 연결 실패: " + e; }
  }
  const cur = (await wwGetRaw()).tabs;
  const t2 = cur.find((t) => t.id === task.id);
  if (t2) {
    t2.chat.push({ role: "ai", text: out });
    // Auto-title the task from its first message (ChatGPT-style) — once.
    if (!t2.autoTitled && cfg.brainUrl) {
      t2.autoTitled = true;
      try {
        const h = { "content-type": "application/json" };
        if (cfg.brainToken) h.authorization = "Bearer " + cfg.brainToken;
        const r = await fetch(String(cfg.brainUrl).replace(/\/$/, "") + "/brain/exec", {
          method: "POST", headers: h,
          body: JSON.stringify({ prompt: `다음 요청을 2~6자 한국어 제목으로 요약. 제목만 출력(따옴표·마침표 없이):\n${text}`, mode: "title" }),
        });
        const j = await r.json();
        const title = String(j.output ?? "").trim().replace(/^["'「]|["'」.]$/g, "").split("\n")[0].slice(0, 16);
        if (title) {
          t2.name = title;
          if (t2.groupId != null) { try { await chrome.tabGroups.update(t2.groupId, { title }); } catch {} }
        }
      } catch {}
    }
    await wwSet(cur, id);
  }
}
// S1 — privileged handlers answer only our own extension pages (offscreen,
// popup, side panel), never a content context running inside a web page.
function wcExt(sender) { return wcSenderKind(sender, chrome.runtime.id) === "ext"; }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("ww") || msg.type === "wwUpdated") return;
  if (!wcExt(sender)) return;
  (async () => {
    if (msg.type === "wwState") { const s = await wwGet(); sendResponse({ ...s, open: false }); return; }
    if (msg.type === "wwNewTask") { const id = await wwNewTask(msg.name); sendResponse({ ok: true, id }); return; }
    if (msg.type === "wwSwitchTask") { await wwSwitchTask(msg.id); sendResponse({ ok: true }); return; }
    if (msg.type === "wwChat") { await wwChat(msg.id, msg.text); sendResponse({ ok: true }); return; }
    sendResponse(null);
  })();
  return true; // async
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "connect" && wcExt(sender)) {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ type: "restart" }).catch(() => {}))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => { console.warn("ensureOffscreen failed", e); sendResponse({ ok: false }); });
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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "getCfg" || !wcExt(sender)) return;
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
// Only the offscreen node's status keys — never policy/prefs/cfg.
const WC_STATE_KEYS = new Set(["log", "status", "feed", "activeCfg"]);
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "state" || !msg.patch || !wcExt(sender)) return;
  const patch = {};
  for (const k of Object.keys(msg.patch)) if (WC_STATE_KEYS.has(k)) patch[k] = msg.patch[k];
  chrome.storage.local.set(patch);
});

// #11 — HUD chat: a message typed into the on-page panel. Echo it locally and
// forward to the offscreen node, which publishes it into the per-node inbox
// slot on the bus (task_id "hud-inbox-<node>") for the orchestrator to poll.
// Read effective config (chrome.storage.cfg, else bundled config.local.json).
// v0.9.0 — human "prefs" from the popup (cdp mode, relay scope, webmcp) win
// over the connection config; the bundled file read is cached briefly since
// policy/CDP checks now consult the config on every action.
// A6 — the file's policy/cdpDeny/identity are a floor that survives a stored
// cfg (popup Connect) — see wcMergeCfg in guard.js.
let wcFileCfg = null, wcFileCfgAt = 0;
async function readFileCfg() {
  if (!wcFileCfg || Date.now() - wcFileCfgAt > 3000) {
    try { wcFileCfg = await (await fetch(chrome.runtime.getURL("config.local.json"))).json(); } catch (e) { wcFileCfg = {}; }
    wcFileCfgAt = Date.now();
  }
  return wcFileCfg || {};
}
async function readCfg() {
  const { cfg, prefs } = await chrome.storage.local.get(["cfg", "prefs"]);
  return wcMergeCfg(await readFileCfg(), cfg || null, prefs || {});
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
  const notes = lnSummary(await lnFor(url || "").catch(() => null)); // v0.7.0
  const fullPrompt = notes ? notes + "\n\n" + prompt : prompt;
  const h = { "content-type": "application/json" };
  if (cfg.brainToken) h.authorization = "Bearer " + cfg.brainToken;
  // A3 — a HUD request is a *goal*: the brain may drive this node's browser.
  // node = the identity actually joined on the bus, tab = host+path in front.
  const { activeCfg } = await chrome.storage.local.get("activeCfg");
  let tabHint = "";
  try { const u = new URL(url); tabHint = u.host + u.pathname; } catch (e) {}
  let out = "";
  try {
    const r = await fetch(String(cfg.brainUrl).replace(/\/$/, "") + "/brain/exec", {
      method: "POST", headers: h,
      body: JSON.stringify({ prompt: fullPrompt, mode: "goal", node: (activeCfg && activeCfg.name) || cfg.name || "", tab: tabHint }),
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
    // B — call the open logic directly (a SW's sendMessage never reaches its
    // own onMessage listeners, so the old self-message was silently dropped)
    if (name === "OPEN") {
      const resp = await wcOpenLogged({ url: rest });
      hudNotify(tabId, "🤖 " + String((resp && resp.text) || "").slice(0, 200), null, true);
    }
    // (other markers can be wired here; OPEN covers the common "검색/열기" case)
  } else {
    hudNotify(tabId, "🤖 master: " + out.slice(0, 300));
  }
}

// Pure decision for one hudChat runtime message (unit-tested): only our HUD in
// a tab's main frame may send it, and approvals are never taken from the page.
function wcHudChatDecision(msg, sender, extId) {
  if (wcSenderKind(sender, extId) !== "tab") return { accept: false, why: "sender" };
  if (typeof msg.text !== "string" || !msg.text.trim() || msg.text.length > 4000) return { accept: false, why: "text" };
  return { accept: true, kind: gdHudLineKind(msg.text) };
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "hudChat") return;
  const d = wcHudChatDecision(msg, sender, chrome.runtime.id);
  if (!d.accept) return;
  const tabId = sender.tab.id;
  const url = sender.url || sender.tab.url || ""; // not the page-supplied msg.url
  hudNotify(tabId, "🧑 나: " + msg.text);
  chrome.storage.local.set({ lastChatTabId: tabId });
  // S1 — /allow · /allow-site · /deny typed in the page HUD are NOT accepted
  // (a page script could forge them). A12: never forwarded to the master either.
  if (d.kind === "approval") {
    hudNotify(tabId, "🛡️ 승인은 이 페이지가 아닌 webclaw 사이드 패널(툴바 아이콘)에서만 할 수 있습니다", null, true);
    return;
  }
  // v0.7.0 — "/done" in a handed-off Space returns control to the agent and
  // tells the master (inbox) so it can resume.
  if (d.kind === "done") {
    chrome.tabs.get(tabId).then(spUserDone).then((name) => {
      if (!name) return;
      hudNotify(tabId, "🤖 제어권을 에이전트에게 돌려줬습니다 (space " + name + ")", null, true);
      chrome.runtime.sendMessage({ type: "busInbox", text: "[space " + name + "] user returned control (/done)", url }).catch(() => {});
    }).catch(() => {});
  }
  readCfg().then((cfg) => {
    if (cfg.standalone && cfg.brainUrl) {
      // single-machine: process locally, no bus/master needed.
      standaloneHandle(tabId, msg.text, url);
    } else {
      // fleet mode: publish to the inbox for a remote master to pick up.
      chrome.runtime.sendMessage({ type: "busInbox", text: msg.text, url }).catch(() => {});
    }
  });
});

// S1 — approvals are answered on extension-owned surfaces only (side panel,
// popup). Also serves the popup's effective-policy view (A6).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== "approvals" && msg.type !== "approve" && msg.type !== "effectivePolicy")) return;
  if (!wcExt(sender)) return;
  (async () => {
    if (msg.type === "approvals") return { pending: gdPendingList() };
    if (msg.type === "approve") return { ok: gdAnswerId(String(msg.id || ""), msg.answer), pending: gdPendingList() };
    const file = await readFileCfg();
    return { policy: await gdPolicy(), fileDeny: wcUnion((file.policy || {}).deny, []) };
  })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true; // async
});

// Popup quick action — turn the HUD on for the active tab.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "hudHere" || !wcExt(sender)) return;
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
    if (!tab) { sendResponse({ ok: false }); return; }
    hudNotify(tab.id, "HUD on — 이 탭에서 에이전트가 작업합니다").then(() => sendResponse({ ok: true }));
  });
  return true; // async
});

// Pick the target tab: a URL-substring match (to hit a specific logged-in
// session across many tabs), else the active tab of the last focused window.
async function pickTab(urlMatch) {
  // v0.7.0 — "space:<name>" (or the node's current space when no @ is given)
  // targets the agent Space instead of the human's active tab.
  const { space, rest } = await spTargetOf(urlMatch);
  if (space) return await spTab(space);
  urlMatch = rest;
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

// Put a webclaw-opened tab into a Chrome tab group so the fleet's tabs are
// visually clustered in the tab strip. Prefers the active task's group; else a
// shared "webclaw" group in the same window (reused if it already exists).
async function groupWebclawTab(tab) {
  try {
    const { tasks, activeId } = await wwGet();
    const active = tasks.find((t) => t.id === activeId);
    if (active && active.groupId != null) {
      try { await chrome.tabs.group({ tabIds: [tab.id], groupId: active.groupId }); return active.groupId; } catch {}
    }
    let gid = null;
    try {
      const gs = await chrome.tabGroups.query({ title: "webclaw", windowId: tab.windowId });
      if (gs[0]) gid = gs[0].id;
    } catch {}
    if (gid != null) {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: gid });
    } else {
      gid = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(gid, { title: "webclaw", color: "cyan" });
    }
    return gid;
  } catch (e) { return null; }
}

// [OPEN] <url> — open a URL in a new foreground tab (loads with the user's
// session), wait for it to finish, return title+URL. The natural way to *show*
// a result to the human (e.g. a search) instead of scraping it. The new tab is
// added to the fleet's tab group so opened tabs stay clustered.
async function wcOpen(msg) {
  const url = String(msg.url || "").trim();
  if (!url) return { text: "(bad [OPEN] — expected: [OPEN] <url>)", failed: true, reason: "bad_args" };
  const gate = await gdCheck({ url, mutating: false });
  if (gate) return gate;
  // v0.7.0 — inside a Space: new tab in the unfocused agent window.
  const { space } = await spTargetOf(msg.urlMatch);
  if (space) {
    const { spaces } = await spLoad();
    if (spaces[space] && spaces[space].owner === "user") {
      return { text: "(space '" + space + "' is handed off to the user)", failed: true, reason: "handed_off" };
    }
    const tab = await spOpen(space, url);
    await waitTabReady(tab.id, 20000);
    const t = await chrome.tabs.get(tab.id);
    return { text: "opened in space " + space + " (tab " + tab.id + "): " + (t.title || "") + " — " + (t.url || ""), _tab: t };
  }
  const tab = await chrome.tabs.create({ url, active: true });
  await groupWebclawTab(tab);
  await waitTabReady(tab.id, 20000);
  const t = await chrome.tabs.get(tab.id);
  hudNotify(tab.id, "[OPEN] " + url.slice(0, 80));
  return { text: "opened (tab " + tab.id + "): " + (t.title || "") + " — " + (t.url || ""), _tab: t };
}

// wcOpen + audit, errors → failed:true (A5). Shared by the marker and the
// standalone HUD path.
async function wcOpenLogged(msg) {
  let resp;
  try { resp = await wcOpen(msg); } catch (e) { resp = { text: "open error: " + ((e && e.message) || e), failed: true, reason: "open_error" }; }
  await gdRecordAll({ kind: "open", target: msg.url, host: gdHost(msg.url), result: resp.failed ? "failed" : "ok", reason: resp.reason, out: String(resp.text || "").slice(0, 200) },
    resp._tab || null);
  delete resp._tab;
  return resp;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "open" || !wcExt(sender)) return;
  wcOpenLogged(msg).then(sendResponse);
  return true; // async
});

// [TABS] — list open tabs so the master can see which one holds the logged-in
// session and target it with @<url-substring>.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "tabs" || !wcExt(sender)) return;
  chrome.tabs.query({}).then(async (tabs) => {
    // Map groupId → title so the listing can cluster tabs by their group.
    const gmap = {};
    try { (await chrome.tabGroups.query({})).forEach((g) => { gmap[g.id] = g.title || ("group " + g.id); }); } catch {}
    const NG = "__ungrouped";
    const groups = {};
    for (const t of tabs) {
      const key = (t.groupId != null && t.groupId !== -1) ? gmap[t.groupId] || ("group " + t.groupId) : NG;
      (groups[key] = groups[key] || []).push(t);
    }
    // Named groups first (webclaw's clusters), ungrouped last.
    const keys = Object.keys(groups).filter((k) => k !== NG).sort();
    if (groups[NG]) keys.push(NG);
    const out = keys.map((k) => {
      const head = k === NG ? "▸ (그룹 없음)" : "▸ [" + k + "]";
      const lines = groups[k]
        .map((t) => `   ${t.active ? "*" : " "} [w${t.windowId}] ${t.title || ""} — ${t.url || ""}`)
        .join("\n");
      return head + "\n" + lines;
    }).join("\n");
    sendResponse({ text: out.slice(0, CAP) || "(no tabs)" });
  });
  return true; // async
});

// [DOM] hands — read the target tab's DOM (raised cap, waits out navigation).
// mode "links" → [{text, href}] for anchors; mode "attr" → attribute values. (#8)
// Over-cap output gets an explicit truncated trailer instead of a silent cut. (#9)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "dom" || !wcExt(sender)) return;
  pickTab(msg.urlMatch).then(async (tab) => {
    if (!tab) { sendResponse({ text: "(no target tab)", failed: true, reason: "no_tab" }); return; }
    await waitTabReady(tab.id); // #4
    const gate = await gdCheck({ url: tab.url, mutating: false });
    if (gate) { sendResponse(gate); return; }
    const respond = sendResponse;
    sendResponse = (resp) => gdRecordAll({ kind: "read", action: msg.mode || "dom", target: msg.query || "(page)", host: gdHost(tab.url), mutating: false,
      result: resp && resp.failed ? "failed" : "ok", reason: resp && resp.reason }).then(() => respond(resp));
    let r;
    try { r = await wcResolve(tab, msg.query); } catch (e) { sendResponse({ text: e.message, failed: true, reason: e.reason }); return; }
    chrome.scripting.executeScript({
      target: r.target,
      func: (q, cap, mode, attr) => {
        const capped = (s) => (s.length > cap ? s.slice(0, cap) + "\n…[truncated, " + (s.length - cap) + " more bytes]" : s);
        // @refs may sit inside open shadow roots — fall back to a deep search
        const deepAll = (sel) => {
          const hits = [...document.querySelectorAll(sel)];
          if (hits.length || !/^\[data-wc-ref=/.test(sel)) return hits;
          const stack = [document];
          while (stack.length) {
            const root = stack.pop();
            for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { hits.push(...el.shadowRoot.querySelectorAll(sel)); stack.push(el.shadowRoot); }
          }
          return hits;
        };
        try {
          if (mode === "links") {
            const els = [...document.querySelectorAll(q || "a[href]")];
            return capped(JSON.stringify(els.map((a) => ({ text: (a.innerText || "").trim().slice(0, 200), href: a.href }))));
          }
          if (mode === "attr") {
            const els = deepAll(q);
            if (!els.length) return "(no match for: " + q + ")";
            return capped(JSON.stringify(els.map((e) => e.getAttribute(attr))));
          }
          if (!q) return capped(document.title + " | " + location.href + "\n" + document.body.innerText);
          const els = deepAll(q);
          if (!els.length) return "(no match for: " + q + ")";
          return capped(els.map((e) => (e.innerText || e.textContent || "").trim()).join("\n"));
        } catch (e) { return "DOM error: " + e; }
      },
      args: [r.css || "", CAP, msg.mode || "", msg.attr || ""],
    }).then((res) => {
      let out = res && res[0] ? res[0].result : "(no result)";
      if (r.ref) out = String(out).split(r.css).join(r.ref);
      hudNotify(tab.id, "[" + (msg.mode || "dom").toUpperCase() + "] " + (msg.query || "(page)") + " → " + String(out).length + " chars", null, true); // #10 working
      sendResponse({ text: out });
    }).catch((e) => sendResponse(r.ref && /document|frame/i.test(String(e))
      ? { text: "(stale ref: " + r.ref + " — run [OUTLINE] again)", failed: true, reason: "stale_ref" }
      : { text: "scripting error: " + e, failed: true, reason: "scripting_error" }));
  }).catch((e) => sendResponse({ text: "dom error: " + ((e && e.message) || e), failed: true, reason: "dom_error" }));
  return true; // async
});

// [FETCH] — extension fetch bypasses page CORS via host_permissions.
// S5 — redirects are re-checked against the deny list: an allowed URL that
// redirects to a denied host returns nothing from the denied side. (An
// extension's redirect:"manual" fetch only sees an opaque redirect with no
// Location, so the final URL is what can be checked.) A5 — non-2xx is a failure.
async function wcFetch(msg) {
  const gate = await gdCheck({ url: msg.url, mutating: false });
  if (gate) return gate;
  // v0.9.0 — Web Bot Auth signature on our own fetches when the human enabled it
  const headers = await idHeadersFor(msg.url);
  const r = await fetch(msg.url, headers ? { headers, redirect: "follow" } : { redirect: "follow" });
  const deniedHost = gdDeniedInChain([msg.url, r.url], (await gdPolicy()).deny);
  if (deniedHost) {
    try { r.body && r.body.cancel(); } catch (e) {}
    return { text: "(policy: redirected to " + deniedHost + ", which is on the deny list)", failed: true, reason: "policy_denied", signed: !!headers };
  }
  const text = await r.text();
  if (!r.ok) return { text: "HTTP " + r.status + " " + (r.statusText || "") + "\n" + text, failed: true, reason: "http_" + r.status, status: r.status, signed: !!headers };
  return { text, status: r.status, signed: !!headers };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "fetch" || !wcExt(sender)) return;
  wcFetch(msg).catch((e) => ({ text: "fetch error: " + ((e && e.message) || e), failed: true, reason: "fetch_error" })).then((resp) => {
    gdRecordAll({ kind: "fetch", target: msg.url, host: gdHost(msg.url), mutating: false, result: resp.failed ? "failed" : "ok", reason: resp.reason, signed: resp.signed });
    sendResponse(resp);
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

function waitDownloadDone(id, timeoutMs = DL_WAIT_MS, deny) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (how, deniedHost) => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChg);
      chrome.downloads.search({ id }, (items) => {
        const d = (items && items[0]) || {};
        // S5 — a redirect may have landed on a denied host: cancel + remove
        const bad = deniedHost || gdDeniedInChain([d.finalUrl], deny);
        if (bad) {
          const drop = () => chrome.downloads.erase({ id }, () => void chrome.runtime.lastError);
          chrome.downloads.cancel(id, () => {
            void chrome.runtime.lastError;
            if (d.state === "complete") chrome.downloads.removeFile(id, () => { void chrome.runtime.lastError; drop(); });
            else drop();
          });
          return resolve({ text: "(policy: download redirected to " + bad + ", which is on the deny list — cancelled and removed)", failed: true, reason: "policy_denied" });
        }
        describeDownload(id).then((desc) => {
          if (how === "timeout") return resolve({ text: desc.replace(/^download \w+/, "download in_progress") });
          if (d.state === "interrupted") return resolve({ text: desc, failed: true, reason: "download_interrupted" });
          resolve({ text: desc });
        });
      });
    };
    const onChg = (delta) => {
      if (delta.id !== id) return;
      if (delta.finalUrl && delta.finalUrl.current) {
        const bad = gdDeniedInChain([delta.finalUrl.current], deny);
        if (bad) return finish("denied", bad);
      }
      if (!delta.state) return;
      if (delta.state.current === "complete" || delta.state.current === "interrupted") finish("state");
    };
    chrome.downloads.onChanged.addListener(onChg);
    // it may already be finished by the time we attach the listener
    chrome.downloads.search({ id }, (items) => {
      const d = items && items[0];
      if (d && gdDeniedInChain([d.finalUrl], deny)) finish("denied");
      else if (d && (d.state === "complete" || d.state === "interrupted")) finish("state");
    });
    setTimeout(() => finish("timeout"), timeoutMs);
  });
}

// #7 — serialize downloads: browsers block bursts of automated downloads from
// one site, and parallel dispatch causes duplicates on blind retry. Chain every
// [DOWNLOAD]/[SHOT] through a single promise queue (concurrency 1).
let dlChain = Promise.resolve();

// Shared by [DOWNLOAD] and [SHOT] — one queue so bursts from either marker
// never collide or trigger the browser's duplicate-download blocking. `url`
// is a real page URL for DOWNLOAD, or a data: URL (captured screenshot) for
// SHOT — chrome.downloads.download accepts both identically.
// Resolves { text, failed?, reason? } (A5: errors/interruptions are failures).
function queueDownload(url, path) {
  // saveAs:false suppresses the per-file "Save as" dialog even when the
  // browser is configured to ask for a location — automated downloads land
  // directly in Downloads/ (or the given sub-path) with no human click.
  const opts = { url, conflictAction: "uniquify", saveAs: false };
  // Optional target sub-path under Downloads (sanitized) — keeps same-named
  // files from different sources apart.
  if (path) opts.filename = String(path).replace(/\.\.(\/|\\)/g, "").replace(/^[/\\]+/, "");
  return new Promise((resolveOuter) => {
    dlChain = dlChain.then(async () => {
      const deny = /^data:/i.test(url) ? [] : (await gdPolicy()).deny;
      await new Promise((resolveQueue) => {
        chrome.downloads.download(opts, (id) => {
          if (chrome.runtime.lastError) {
            resolveOuter({ text: "download error: " + chrome.runtime.lastError.message, failed: true, reason: "download_error" });
            resolveQueue();
          } else {
            waitDownloadDone(id, DL_WAIT_MS, deny).then((res) => { resolveOuter(res); resolveQueue(); }); // #2
          }
        });
      });
    }).catch(() => resolveOuter({ text: "download error: queue failure", failed: true, reason: "download_error" }));
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "download" || !wcExt(sender)) return;
  try {
    // [DOWNLOAD?] <id> — status re-query for a long-running download.
    if (msg.statusOnly) {
      describeDownload(Number(msg.url)).then((text) => sendResponse(/not found$/.test(text) ? { text, failed: true, reason: "not_found" } : { text }));
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
          if (chrome.runtime.lastError) sendResponse({ text: "cancel error: " + chrome.runtime.lastError.message, failed: true, reason: "cancel_error" });
          else describeDownload(Number(target)).then((text) => sendResponse({ text }));
        });
      }
      return true;
    }
    gdCheck({ url: msg.url, mutating: false }).then((gate) => {
      if (gate) return sendResponse(gate);
      return queueDownload(msg.url, msg.path).then(async (res) => {
        gdRecordAll({ kind: "download", target: msg.url, host: gdHost(msg.url), mutating: false, result: res.failed ? "failed" : "ok", reason: res.reason, out: msg.path || "" });
        // Downloads are tab-independent → mirror into the conversation tab
        // with a [전체] (global) badge instead of every tab's panel. S6: only
        // the state + saved file name — never the source URL (tokens) or text.
        const { lastChatTabId } = await chrome.storage.local.get("lastChatTabId");
        if (lastChatTabId) hudNotify(lastChatTabId, "⬇️ " + wcDownloadMirror(res), null, true, "global");
        sendResponse(res);
      });
    }).catch((e) => sendResponse({ text: "download error: " + e, failed: true, reason: "download_error" }));
  } catch (e) { sendResponse({ text: "download error: " + e, failed: true, reason: "download_error" }); }
  return true; // async
});

// "download complete (id=7) → /Users/me/Downloads/a.pdf (123 bytes)" → "download complete #7 · a.pdf"
function wcDownloadMirror(res) {
  const m = String((res && res.text) || "").match(/^download (\w+) \(id=(\d+)\) → (.*?)(?: \(\d+ bytes\))?(?: error=.*)?$/);
  if (m) return "download " + m[1] + " #" + m[2] + " · " + String(m[3]).split(/[\\/]/).pop().slice(0, 80);
  return res && res.failed ? "download failed (" + (res.reason || "error") + ")" : "download";
}

// #10 — visual HUD injected as a *static* extension function (isolated world,
// so page CSP that forbids eval cannot block it): a glowing "agent is working
// here" border, a ghost cursor on clicks, and a right-side action log panel so
// the human can supervise what the agent does in their browser.
// Persistent chat history, **scoped per tab + origin** (S6): survives page
// navigations within the same site, but is dropped as soon as the tab moves
// to another origin — the HUD lives in the page's DOM, so a different site
// must never be handed the previous site's conversation. Other tabs don't see
// it. Tab-independent events (downloads etc.) are mirrored into the
// conversation tab with a [전체] (global) badge so scopes are distinguishable.
// Every read-modify-write of chatHistories goes through one chain (B).
let hudChain = Promise.resolve();
function hudLocked(fn) { const run = hudChain.then(fn); hudChain = run.catch(() => {}); return run; }
function hudKey(tabId, url) { let o = ""; try { o = new URL(url).origin; } catch (e) {} return String(tabId) + "|" + o; }

function hudHistory(tabId, url, entry) {
  return hudLocked(async () => {
    const { chatHistories = {} } = await chrome.storage.local.get("chatHistories");
    const key = hudKey(tabId, url);
    const hist = chatHistories[key] || [];
    if (entry) {
      hist.push(entry);
      while (hist.length > 120) hist.shift();
      chatHistories[key] = hist;
      await chrome.storage.local.set({ chatHistories });
    }
    return hist.slice(-60);
  });
}

// Drop a tab's conversations — all of them, or all but `keepKey`.
function hudForget(tabId, keepKey) {
  return hudLocked(async () => {
    const { chatHistories = {} } = await chrome.storage.local.get("chatHistories");
    let changed = false;
    for (const k of Object.keys(chatHistories)) {
      if ((k === String(tabId) || k.startsWith(tabId + "|")) && k !== keepKey) { delete chatHistories[k]; changed = true; }
    }
    if (changed) await chrome.storage.local.set({ chatHistories });
  });
}

// SW startup: forget conversations of tabs that no longer exist (onRemoved
// does not fire for tabs closed while the worker was gone) and the old
// per-tab-only keys.
async function hudPrune() {
  const alive = new Set((await chrome.tabs.query({})).map((t) => String(t.id)));
  return hudLocked(async () => {
    const { chatHistories = {} } = await chrome.storage.local.get("chatHistories");
    let changed = false;
    for (const k of Object.keys(chatHistories)) {
      const [tid, origin] = k.split("|");
      if (origin === undefined || !alive.has(tid)) { delete chatHistories[k]; changed = true; }
    }
    if (changed) await chrome.storage.local.set({ chatHistories });
  });
}

// Closed tab → drop its conversation (a session ends with its tab); another
// origin in the same tab → drop the previous site's conversation.
chrome.tabs.onRemoved.addListener((tabId) => { hudForget(tabId, null); });
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info && info.url) hudForget(tabId, hudKey(tabId, info.url)); });

function hudNotify(tabId, text, click, working, scope) {
  const run = async () => {
    let hist = [];
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = (tab && (tab.url || tab.pendingUrl)) || "";
    if (text && text !== "__OFF__") {
      const kind = text.startsWith("🧑") ? "user" : text.startsWith("🤖 master") ? "master" : "action";
      const shown = (scope === "global" ? "[전체] " : "") + String(text).slice(0, 300);
      hist = await hudHistory(tabId, url, { at: new Date().toLocaleTimeString().slice(0, 8), kind, text: shown });
    } else if (text !== "__OFF__") {
      hist = await hudHistory(tabId, url, null);
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
      const PW = 320; // docked chat width — reserves this much page gutter (aside-style)
      if (off) {
        const r = document.getElementById(ID); if (r) r.remove();
        const s = document.getElementById(ID + "_style"); if (s) s.remove();
        // release the reserved gutter so the page reclaims full width
        document.documentElement.style.removeProperty("margin-right");
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
        // Bounds the *content* region (stops at the docked panel), not the panel.
        frame.style.cssText = "position:fixed;top:0;left:0;bottom:0;right:" + PW + "px;border:7px solid #00ffcc;animation:__wcGlow 1.4s ease-in-out infinite;pointer-events:none;opacity:0;transition:opacity .4s";
        const panel = document.createElement("div");
        panel.className = "p";
        // Docked to the right edge, full height — a reserved column (aside-style),
        // NOT a floating card. The page is pushed left by PW (margin-right below),
        // so the panel never covers page content.
        panel.style.cssText = "position:fixed;top:0;right:0;bottom:0;width:" + PW + "px;display:flex;flex-direction:column;background:rgba(10,12,24,.94);color:#c8ffee;font:12px/1.5 ui-monospace,monospace;border-left:2px solid #00ffcc;padding:12px;pointer-events:auto;box-shadow:-4px 0 24px rgba(0,0,0,.45);box-sizing:border-box;z-index:2147483647";
        panel.innerHTML = "<div style='color:#00ffcc;font-weight:700;margin-bottom:6px'>💬 webclaw chat <span style='color:#8fa3b8;font-weight:400;font-size:10px'>— 이 사이트의 대화 · 승인은 사이드 패널에서</span></div><div class='lines' style='flex:1;overflow-y:auto'></div>";
        // #11 — two-way chat: the human can instruct the agent from the page.
        const input = document.createElement("input");
        input.className = "chat";
        input.placeholder = "에이전트에게 지시… (Enter)";
        input.style.cssText = "margin-top:8px;padding:6px 8px;border:1px solid #00ffcc;border-radius:7px;background:rgba(0,0,0,.5);color:#c8ffee;font:11px ui-monospace,monospace;outline:none";
        // S1 — the input sits in the page's DOM, so page scripts can dispatch
        // synthetic key events or rewrite .value. Only a real (isTrusted)
        // Enter sends, and only the text the human actually typed: the value
        // must equal what the last trusted input event left there.
        let typed = "";
        input.addEventListener("input", (ev) => { if (ev.isTrusted) typed = input.value; });
        input.addEventListener("keydown", (ev) => {
          if (!ev.isTrusted || ev.key !== "Enter" || ev.isComposing || !input.value.trim()) return;
          ev.stopPropagation();
          if (input.value !== typed) { input.value = ""; typed = ""; return; } // tampered by the page
          const t = input.value.trim();
          input.value = ""; typed = "";
          try { chrome.runtime.sendMessage({ type: "hudChat", text: t }); } catch (e) {}
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
        // Reserve a gutter on the right so the docked panel doesn't overlap the
        // page — the page content shrinks by PW instead of being covered.
        document.documentElement.style.setProperty("transition", "margin-right .2s ease");
        document.documentElement.style.setProperty("margin-right", PW + "px", "important");
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
// v0.7.0 — selectors may be @refs from [OUTLINE]; [CLICK]/[TYPE]/[SHOT]/[JS]
// upgrade to CDP (trusted input, background capture, CSP-proof eval) when the
// debugger is available, and fall back to the scripting path otherwise.
function wcActInjected(action, selector, value, code, cap) {
  return (async () => {
        // @refs may live inside open shadow roots → deep fallback
        const q = (s) => {
          const hit = document.querySelector(s);
          if (hit || !/^\[data-wc-ref=/.test(s)) return hit;
          const stack = [document];
          while (stack.length) {
            const root = stack.pop();
            for (const el of root.querySelectorAll("*")) {
              if (!el.shadowRoot) continue;
              const m = el.shadowRoot.querySelector(s);
              if (m) return m;
              stack.push(el.shadowRoot);
            }
          }
          return null;
        };
        // ── helpers (static function scope — CSP-safe, no eval) ──────────────
        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          const st = getComputedStyle(el);
          return st.visibility !== "hidden" && st.display !== "none";
        };
        // real pointer sequence at element center (ghost cursor). Returns "@x,y"
        const ghostClick = (el) => {
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
          const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
          for (const t of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            try { el.dispatchEvent(t.startsWith("pointer") ? new PointerEvent(t, o) : new MouseEvent(t, o)); } catch (e) { el.dispatchEvent(new MouseEvent(t === "click" ? "click" : "mousedown", o)); }
          }
          return "@" + x + "," + y;
        };
        // find a clickable element by visible text / aria-label (exact→contains), dialog-first, deepest
        const findByText = (label) => {
          const sels = "button,[role=button],a,[role=option],[role=menuitem],[role=tab],[tabindex],summary,input[type=submit],input[type=button],label";
          const scopes = [document.querySelector("[role=dialog]"), document.querySelector(".modal"), document].filter(Boolean);
          for (const pass of [0, 1]) {
            for (const scope of scopes) {
              const hits = [...scope.querySelectorAll(sels)].filter(visible).filter((el) => {
                const txt = (el.getAttribute("aria-label") || el.value || el.textContent || "").trim();
                return pass === 0 ? txt === label : txt.includes(label);
              });
              const pick = hits.find((el) => !hits.some((o) => o !== el && el.contains(o))) || hits[0];
              if (pick) return pick;
            }
          }
          return null;
        };
        // structured low-noise snapshot for diffing
        const snap = () => {
          const root = document.querySelector("[role=dialog]") || document.body;
          const out = { fields: [], buttons: [], errors: [], texts: [] };
          for (const el of root.querySelectorAll("input,textarea,select")) if (visible(el)) out.fields.push((el.getAttribute("placeholder") || el.name || el.getAttribute("aria-label") || "field") + "=" + (el.value || ""));
          for (const el of root.querySelectorAll("button,[role=button]")) if (visible(el)) { const t = (el.textContent || "").trim(); if (t) out.buttons.push(t.slice(0, 20)); }
          for (const el of root.querySelectorAll("[role=alert],[aria-live],[class*=error],[class*=Error],[class*=invalid],[aria-invalid=true]")) if (visible(el)) { const t = (el.textContent || "").trim(); if (t) out.errors.push(t.slice(0, 60)); }
          out.texts = (root.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
          return out;
        };
        const diffSnap = (a, b) => {
          const sub = (x, y) => { const sy = new Set(y); return [...new Set(x)].filter((v) => !sy.has(v)); };
          return { addedFields: sub(b.fields, a.fields), removedFields: sub(a.fields, b.fields), addedButtons: sub(b.buttons, a.buttons), removedButtons: sub(a.buttons, b.buttons), addedText: sub(b.texts, a.texts).slice(0, 25), removedText: sub(a.texts, b.texts).slice(0, 25), errors: [...new Set(b.errors)] };
        };
        const valueOf = (el) => (el.isContentEditable ? el.innerText : el.value);
        try {
          // ── v0.7.0 CDP support actions ──
          if (action === "locate") {
            // scroll into view, report the center and whether a click there
            // would actually land on the element (not on an overlay)
            const el = q(selector);
            if (!el) return "(no match: " + selector + ")";
            el.scrollIntoView({ block: "center", inline: "center" });
            const r = el.getBoundingClientRect();
            const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 2));
            const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 2));
            const root = el.getRootNode();
            const hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
            return JSON.stringify({ x, y, ok: !!hit && (hit === el || el.contains(hit)) });
          }
          if (action === "focus") {
            const el = q(selector);
            if (!el) return "(no match: " + selector + ")";
            el.scrollIntoView({ block: "center" });
            el.focus();
            if (typeof el.select === "function") el.select();
            else if (el.isContentEditable) { const rg = document.createRange(); rg.selectNodeContents(el); const sl = getSelection(); sl.removeAllRanges(); sl.addRange(rg); }
            return document.activeElement === el || el.contains(document.activeElement) ? "focused" : "(focus refused: " + selector + ")";
          }
          if (action === "describe") {
            // human-readable label of the target (policy: risky-action check)
            const el = q(selector);
            if (!el) return "";
            const t = (el.getAttribute("aria-label") || el.value || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
            const f = el.form || (el.tagName === "FORM" ? el : null);
            return (t + (f && f.getAttribute("action") ? " → " + f.getAttribute("action") : "")).slice(0, 120);
          }
          if (action === "readvalue") {
            const el = q(selector);
            return el ? JSON.stringify(valueOf(el)) : "(no match: " + selector + ")";
          }
          if (action === "exists") {
            if (selector.startsWith("text:")) return (document.body && document.body.innerText.includes(selector.slice(5))) ? "yes" : "no";
            return visible(q(selector)) ? "yes" : "no";
          }
          if (action === "click") {
            const el = q(selector);
            if (!el) return "(no match: " + selector + ")";
            const r = el.getBoundingClientRect();
            el.click();
            return "clicked " + selector + " @" + Math.round(r.left + r.width / 2) + "," + Math.round(r.top + r.height / 2);
          }
          if (action === "clicktext") {
            const el = findByText(value);
            if (!el) return "(no clickable text: " + value + ")";
            return "clicked '" + value + "' <" + el.tagName.toLowerCase() + "> " + ghostClick(el);
          }
          if (action === "snap") {
            const s = snap();
            return "snap · fields:" + s.fields.length + " buttons:[" + s.buttons.join(",") + "] errors:[" + s.errors.join("|") + "]";
          }
          if (action === "diff") {
            const before = snap();
            const m = String(code || "").trim().match(/^(clicktext|click):([\s\S]+)$/);
            if (m) {
              const el = m[1] === "clicktext" ? findByText(m[2].trim()) : q(m[2].trim());
              if (!el) return "(diff: target not found: " + code + ")";
              m[1] === "clicktext" ? ghostClick(el) : el.click();
            }
            await new Promise((r) => setTimeout(r, 1300));
            return JSON.stringify(diffSnap(before, snap()));
          }
          if (action === "fill" || action === "type") {
            const el = q(selector);
            if (!el) return "(no match: " + selector + ")";
            el.focus();
            if (el.isContentEditable) {
              el.textContent = value;
              el.dispatchEvent(new Event("input", { bubbles: true }));
            } else {
              const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : el.tagName === "SELECT" ? HTMLSelectElement : HTMLInputElement;
              const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value");
              if (setter && setter.set) { setter.set.call(el, value); } else { el.value = value; }
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
            // #3 read-back: report what the page actually kept, not what we sent.
            const kept = valueOf(el);
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
  })();
}

// "[FILL] #pw → filled (6 chars)" — length only, never the value.
function wcSecretHud(reason, value) {
  const n = String(value == null ? "" : value).length;
  if (reason === "no_match" || reason === "stale_ref") return reason;
  return (reason === "value_mismatch" ? "filled, page kept a different value" : "filled") + " (" + n + " chars)";
}

function wcCapStr(s) {
  s = typeof s === "string" ? s : JSON.stringify(s);
  if (s === undefined) s = "undefined";
  return s.length > CAP ? s.slice(0, CAP) + "\n…[truncated, " + (s.length - CAP) + " more bytes]" : s;
}

async function wcInject(r, action, selector, value, code) {
  const res = await chrome.scripting.executeScript({ target: r.target, func: wcActInjected, args: [action, selector || "", value || "", code || "", CAP] });
  return res && res[0] ? String(res[0].result) : "(no result)";
}

// Trusted input & CSP-proof eval only make sense in the main frame (CDP
// coordinates/evaluation are main-frame relative).
async function wcCdpOk(tab, r, required) { return (!r || r.frameId === 0) && await WcCdp.enabled(tab.id, required); }

// Actions that change page/tab state — refused on a handed-off Space.
const WC_MUTATING = new Set(["click", "clicktext", "diff", "fill", "type", "submit", "js", "close", "cdp", "upload"]);

async function wcAct(msg) {
  const tab = await pickTab(msg.urlMatch);
  if (!tab) return { text: "(no target tab)", failed: true, reason: "no_tab" };
  await waitTabReady(tab.id); // #4
  if (WC_MUTATING.has(msg.action)) { const blocked = await spBlock(tab); if (blocked) return blocked; }
  // v0.9.0 — human policy: deny list, ask mode, risky-action confirmation
  msg._tab = { id: tab.id, url: tab.url };
  if (msg.action !== "hud") { const gate = await gdGateAct(tab, msg); if (gate) return gate; }
  // [HUD] on|off — manual toggle of the visual supervision layer. (#10)
  if (msg.action === "hud") {
    const on = String(msg.code || "").trim() !== "off";
    await hudNotify(tab.id, on ? "HUD on — 이 탭에서 에이전트가 작업합니다" : "__OFF__");
    return { text: "hud " + (on ? "on" : "off") + " @ tab " + tab.id };
  }
  // [CLOSE] — close the target tab (cleanup after batch [OPEN]/[DOM] runs so
  // hundreds of scripted tabs don't pile up in the user's browser). Native
  // chrome.tabs.remove, not page-script window.close() — CSP on the target
  // page would otherwise block it and self-close is unreliable for
  // extension-opened tabs regardless.
  if (msg.action === "close") {
    try { await chrome.tabs.remove(tab.id); return { text: "closed tab " + tab.id }; }
    catch (e) { return { text: "close error: " + e, failed: true, reason: "close_error" }; }
  }
  // [SHOT] [<relative/path.jpg>] — screenshot the target tab, saved to disk
  // through the same queue as [DOWNLOAD]. v0.7.0: CDP capture first (works on
  // background tabs, no focus stealing); fallback = focus the tab and use
  // captureVisibleTab (active-tab only). A data: URL feeds
  // chrome.downloads.download fine in an MV3 service worker —
  // URL.createObjectURL does NOT exist there, so this stays data:.
  if (msg.action === "shot") {
    try {
      const path = (msg.code || "").trim() || ("webclaw-shots/shot-" + Date.now() + ".jpg");
      let dataUrl = null, via = "";
      if (await wcCdpOk(tab)) { try { dataUrl = await WcCdp.screenshot(tab.id); via = " (cdp)"; } catch (e) {} }
      if (!dataUrl) {
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise((r) => setTimeout(r, 300));
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
      }
      const res = await queueDownload(dataUrl, path);
      const text = res.text + via;
      hudNotify(tab.id, "📸 " + wcDownloadMirror(res), null, true);
      return res.failed ? { text, failed: true, reason: res.reason } : { text };
    } catch (e) { return { text: "shot error: " + e, failed: true, reason: "shot_error" }; }
  }
  // [SAY] <text> — master's reply rendered into the HUD chat panel. (#11)
  if (msg.action === "say") {
    await hudNotify(tab.id, "🤖 master: " + String(msg.code || ""));
    return { text: "said @ tab " + tab.id };
  }
  // [OUTLINE] — @ref outline of all frames.
  if (msg.action === "outline") {
    const text = await wcOutline(tab, msg.code);
    hudNotify(tab.id, "[OUTLINE] " + text.split("\n")[1], null, true);
    return { text: wcCapStr(text) };
  }
  // [CDP] Domain.method {params} — raw protocol, deny-listed for credential dumps.
  if (msg.action === "cdp") {
    if (!(await wcCdpOk(tab, null, true))) return { text: "(cdp unavailable — debugger permission missing, cfg.cdp off, or refused by the user)", failed: true, reason: "cdp_unavailable" };
    if (await WcCdp.denied(msg.method)) return { text: "(cdp method denied by policy: " + msg.method + ")", failed: true, reason: "cdp_denied" };
    try {
      const r = await WcCdp.send(tab.id, msg.method, msg.params || {});
      hudNotify(tab.id, "[CDP] " + msg.method, null, true);
      return { text: wcCapStr(r === undefined ? {} : r) };
    } catch (e) { return { text: "cdp error: " + ((e && e.message) || e), failed: true, reason: "cdp_error" }; }
  }

  // ── selector-taking actions: resolve @refs to a frame-precise target ──
  let r;
  try { r = await wcResolve(tab, msg.selector); } catch (e) { return { text: e.message, failed: true, reason: e.reason }; }
  const label = r.ref || r.css;
  const relabel = (s) => (r.ref ? String(s).split(r.css).join(r.ref) : String(s));
  let code = msg.code || "";
  // [DIFF] click:@N — resolve the ref inside the action spec too
  if (msg.action === "diff") {
    const dm = String(code).trim().match(/^click:(@\d+)$/);
    if (dm) {
      try { r = await wcResolve(tab, dm[1]); } catch (e) { return { text: e.message, failed: true, reason: e.reason }; }
      code = "click:" + r.css;
    }
  }

  // [UPLOAD] — CDP only (scripting cannot set a FileList).
  if (msg.action === "upload") {
    if (!(await wcCdpOk(tab, r, true))) return { text: "(upload needs CDP in the main frame — unavailable here)", failed: true, reason: "cdp_unavailable" };
    try {
      const ok = await WcCdp.setFiles(tab.id, r.css, msg.files || []);
      if (!ok) return { text: "(no match: " + label + ")", failed: true, reason: r.ref ? "stale_ref" : "no_match" };
      hudNotify(tab.id, "[UPLOAD] " + label + " ← " + (msg.files || []).length + " file(s)", null, true);
      return { text: "uploaded " + (msg.files || []).join(", ") + " → " + label };
    } catch (e) { return { text: "upload error: " + ((e && e.message) || e), failed: true, reason: "cdp_error" }; }
  }

  // [WAIT] — poll until present & visible (survives navigations in between).
  if (msg.action === "wait") {
    const timeout = Number(msg.value) > 0 ? Number(msg.value) : 10000;
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if ((await wcInject(r, "exists", r.css)) === "yes") return { text: "found " + label + " after " + (Date.now() - t0) + "ms" };
      } catch (e) { if (r.ref) return { text: "(stale ref: " + r.ref + " — run [OUTLINE] again)", failed: true, reason: "stale_ref" }; }
      await new Promise((res) => setTimeout(res, 300));
    }
    return { text: "(timeout after " + timeout + "ms waiting for " + label + ")", failed: true, reason: "timeout" };
  }

  let out, click = null, via = "";
  try {
    // trusted CDP click — only if the center point really hits the element;
    // otherwise (overlay, iframe ref, no CDP) keep the scripted el.click().
    if (msg.action === "click" && await wcCdpOk(tab, r)) {
      const loc = await wcInject(r, "locate", r.css);
      if (loc.startsWith("{")) {
        const p = JSON.parse(loc);
        if (p.ok) {
          try { await WcCdp.click(tab.id, p.x, p.y); out = "clicked " + label + " (trusted) @" + p.x + "," + p.y; } catch (e) {}
        }
      }
    }
    // trusted typing: focus + select existing text, then Input.insertText
    if (!out && msg.action === "type" && msg.value && await wcCdpOk(tab, r)) {
      if ((await wcInject(r, "focus", r.css)) === "focused") {
        try {
          await WcCdp.insertText(tab.id, msg.value);
          const kept = JSON.parse(await wcInject(r, "readvalue", r.css));
          out = kept === msg.value
            ? "typed " + label + " = " + kept + " (trusted)"
            : "typed " + label + " = " + kept + " (WARNING: page kept a different value than sent: " + msg.value + ")";
        } catch (e) {}
      }
    }
    if (!out) out = relabel(await wcInject(r, msg.action, r.css, msg.value, code));
    // CSP blocked eval → retry through CDP Runtime.evaluate (no eval involved)
    if (msg.action === "js" && /^js blocked by page CSP/.test(out) && await wcCdpOk(tab, r, true)) {
      try { out = wcCapStr(await WcCdp.evaluate(tab.id, code)); via = "cdp"; }
      catch (e) { out = "js error (via cdp): " + ((e && e.message) || e); }
    }
  } catch (e) {
    if (r.ref && /document|frame/i.test(String(e))) return { text: "(stale ref: " + r.ref + " — run [OUTLINE] again)", failed: true, reason: "stale_ref" };
    return { text: "act error: " + e, failed: true, reason: "act_error" };
  }
  // #16 — [DIFF] ... :: screenshot — attach a visual capture alongside the
  // structured DOM diff, for cases the diff alone can't judge (layout
  // breakage, hidden fields, custom-widget rendering).
  if (msg.action === "diff" && msg.shot) {
    try {
      let dataUrl = null;
      if (await wcCdpOk(tab)) { try { dataUrl = await WcCdp.screenshot(tab.id); } catch (e) {} }
      if (!dataUrl) {
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise((res) => setTimeout(res, 200));
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
      }
      const shotText = (await queueDownload(dataUrl, "webclaw-shots/diff-" + Date.now() + ".jpg")).text;
      const j = JSON.parse(out);
      j.screenshot = shotText;
      out = JSON.stringify(j);
    } catch (e) { /* diff still returns without a screenshot */ }
  }
  // #14 — classify the well-known failure shapes the page script returns
  // as plain success-looking strings (unmatched selector, value mismatch)
  // so runTask can elevate them to status:"failed" instead of the master
  // having to string-sniff "(no match:" out of a "done" response.
  let reason = null;
  if (/^\(no match: |^\(no clickable text: |^\(diff: target not found: /.test(out)) reason = r.ref ? "stale_ref" : "no_match";
  else if ((msg.action === "fill" || msg.action === "type") && /WARNING: page kept a different value than sent:/.test(out)) reason = "value_mismatch";
  else if (via === "cdp" && /^js error \(via cdp\)/.test(out)) reason = "js_error";
  // #10 — mirror the action into the on-page HUD (border + log; ghost
  // cursor when the click reported its coordinates).
  const cm = out.match(/@(\d+),(\d+)$/);
  if ((msg.action === "click" || msg.action === "clicktext") && cm) click = { x: +cm[1], y: +cm[2] };
  // S6 — fill/type values (passwords!) never reach the HUD log: that log is
  // page DOM, and history the next page in this tab must not inherit.
  const secret = msg.action === "fill" || msg.action === "type";
  const hudOut = secret ? wcSecretHud(reason, msg.value) : out.slice(0, 90);
  hudNotify(tab.id, "[" + msg.action.toUpperCase() + "] " + (secret ? label : (r.ref || msg.selector || msg.value || (code || "").slice(0, 60))) + " → " + hudOut, click, true); // working
  return reason ? { text: out, failed: true, reason } : { text: out };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "act" || !wcExt(sender)) return;
  wcAct(msg).then(async (resp) => {
    // audit + recording, then minimal-CDP mode detaches right away
    if (msg._tab) await gdAuditAct(msg, msg._tab, resp);
    if (msg._tab && await WcCdp.minimal() && WcCdp.isAttached(msg._tab.id) && !wcRelayTabs.has(msg._tab.id)) WcCdp.detach(msg._tab.id);
    sendResponse(resp);
  }, (e) => sendResponse({ text: "act error: " + e, failed: true, reason: "act_error" }));
  return true; // async
});

// v0.7.0 — Spaces / hand-off, learnings.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== "space" && msg.type !== "learn" && msg.type !== "learnContext")) return;
  if (!wcExt(sender)) return;
  (async () => {
    if (msg.type === "space") return spHandle(msg);
    if (msg.type === "learn") return lnHandle(msg);
    const tab = await pickTab("");
    return { text: tab ? lnSummary(await lnFor(tab.url)) : "" };
  })().then(sendResponse, (e) => sendResponse({ text: String((e && e.message) || e), failed: true, reason: (e && e.reason) || "error" }));
  return true; // async
});

// ===== v0.9.0 — audit / recording / policy / identity / WebMCP =====

// Web Bot Auth signing of the extension's own [FETCH] requests. Enabled by the
// human only (popup / config.local.json "identity": {on, domains?, agentUrl?}).
async function idSettings() {
  const { identity } = await chrome.storage.local.get("identity");
  const cfg = await readCfg();
  return Object.assign({ on: false, domains: [], agentUrl: "" }, cfg.identity || {}, identity || {});
}
async function idKey(create) {
  let { wbaKey } = await chrome.storage.local.get("wbaKey");
  if (!wbaKey && create) { wbaKey = await WcIdentity.generateKey(); await chrome.storage.local.set({ wbaKey }); }
  return wbaKey || null;
}
async function idHeadersFor(url) {
  const s = await idSettings();
  if (!s.on) return null;
  if (s.domains && s.domains.length && !gdMatch(gdHost(url), s.domains)) return null;
  const key = await idKey(true);
  return WcIdentity.signRequest(url, key, { agentUrl: s.agentUrl || "" });
}

// WebMCP shim — registered as a MAIN-world document_start content script.
async function wmRegister() {
  const cfg = await readCfg();
  const want = cfg.webmcp !== "off";
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ["webclaw-webmcp"] }).catch(() => []);
  if (want && !existing.length) {
    await chrome.scripting.registerContentScripts([{ id: "webclaw-webmcp", js: ["webmcp-shim.js"], matches: ["<all_urls>"],
      runAt: "document_start", world: "MAIN", allFrames: false, persistAcrossSessions: true }]).catch((e) => console.warn("webmcp register", e));
  } else if (!want && existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: ["webclaw-webmcp"] }).catch(() => {});
  }
}
wmRegister();

// A9 — the shim keeps its registry in a closure; this MAIN-world function
// reaches it through the shim's document CustomEvent handshake, keyed with a
// per-install secret (see webmcp-shim.js). Replies are JSON-safe objects:
// { tools } · { result } · { error } · { interaction: callId } (tool paused
// on requestUserInteraction — background asks the human, then op "resume").
function wmInjected(key, op, payload) {
  const d = Object.assign({ key, op, reply: null }, payload || {});
  try { document.dispatchEvent(new CustomEvent("webclaw:webmcp", { detail: d })); } catch (e) {}
  if (!d.reply) return Promise.resolve({ error: "webclaw WebMCP shim not present on this page (reload the tab after enabling)" });
  return Promise.resolve(d.reply).then((r) => JSON.parse(JSON.stringify(r || {})), (e) => ({ error: String((e && e.message) || e) }));
}

async function wmKey() {
  let { wmKey } = await chrome.storage.local.get("wmKey");
  if (!wmKey) {
    wmKey = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await chrome.storage.local.set({ wmKey });
  }
  return wmKey;
}

// list / call one WebMCP tool; requestUserInteraction → human approval
// (always asked, in any policy mode — never auto-confirmed).
async function wmCall(tab, msg) {
  const key = await wmKey();
  const exec = async (op, payload) => {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: wmInjected, args: [key, op, payload] });
    return (res && res.result) || { error: "no result from the page" };
  };
  if (msg.arg === "list") return exec("list", {});
  let r = await exec("call", { name: msg.tool || "", args: msg.args || {} });
  let declined = false;
  for (let i = 0; r && r.interaction; i++) {
    if (i >= 5) { await exec("resume", { callId: r.interaction, allow: false }); return { error: "too many user-interaction requests", reason: "interaction_denied" }; }
    const ans = await gdAsk(tab.id, gdHost(tab.url), "[WEBMCP] " + (msg.tool || "") + " — 페이지 도구가 사용자 확인(requestUserInteraction)을 요청", true);
    const allow = ans === "allow" || ans === "allow-site";
    if (!allow) declined = true;
    r = await exec("resume", { callId: r.interaction, allow });
  }
  if (declined && r && r.error) r.reason = "interaction_denied";
  return r;
}

async function gdHandle(msg) {
  if (msg.op === "audit") return { text: await gdAuditTail(msg.arg) };
  if (msg.op === "rec") return { text: await gdRec(msg.arg, msg.label) };
  if (msg.op === "replay") {
    const html = await gdReplayHtml();
    if (!html) return { text: "(nothing recorded — [REC] on first)", failed: true, reason: "no_recording" };
    const path = msg.arg || ("webclaw-replays/replay-" + Date.now() + ".html");
    const b64 = btoa(unescape(encodeURIComponent(html)));
    return await queueDownload("data:text/html;base64," + b64, path);
  }
  if (msg.op === "policy") {
    const p = await gdPolicy();
    const cfg = await readCfg();
    return { text: JSON.stringify(Object.assign({}, p, { cdp: cfg.cdp || "auto", relayScope: cfg.relayScope || "space", webmcp: cfg.webmcp || "on",
      identity: (await idSettings()).on ? "on" : "off", note: "policy is set by the human in the popup — markers can read it, not change it" })) };
  }
  if (msg.op === "identity") {
    const key = await idKey(msg.arg === "init");
    const s = await idSettings();
    if (!key) return { text: JSON.stringify({ signing: s.on ? "on" : "off", key: null, hint: "[IDENTITY] init generates an Ed25519 key" }) };
    return { text: JSON.stringify({ signing: s.on ? "on" : "off", domains: s.domains, agentUrl: s.agentUrl || null,
      keyid: await WcIdentity.thumbprint(key.publicJwk), directory: await WcIdentity.directory(key.publicJwk) }) };
  }
  if (msg.op === "webmcp") {
    const tab = await pickTab(msg.urlMatch);
    if (!tab) return { text: "(no target tab)", failed: true, reason: "no_tab" };
    const gate = await gdCheck({ url: tab.url, tabId: tab.id, mutating: msg.arg === "call", what: "[WEBMCP] call " + (msg.tool || ""), label: msg.tool });
    if (gate) return gate;
    let r;
    try { r = await wmCall(tab, msg); } catch (e) { r = { error: "webmcp error: " + ((e && e.message) || e) }; }
    gdRecordAll({ kind: "webmcp", action: msg.arg, target: msg.tool || "", host: gdHost(tab.url), mutating: msg.arg === "call", result: r.error ? "failed" : "ok", reason: r.reason }, tab);
    if (r.error) return { text: JSON.stringify(r), failed: true, reason: r.reason || "webmcp_error" };
    return { text: JSON.stringify(msg.arg === "list" ? r.tools : r.result) };
  }
  return { text: "(unknown guard op: " + msg.op + ")", failed: true, reason: "bad_args" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "guard" || !wcExt(sender)) return;
  gdHandle(msg).then(sendResponse, (e) => sendResponse({ text: String((e && e.message) || e), failed: true, reason: "error" }));
  return true; // async
});
// the human toggled WebMCP in the popup → (un)register the shim
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.prefs) wmRegister(); });

// A12 / B — every service-worker start: expire approvals whose waiting caller
// died with the previous worker, re-adopt relayed tabs and detach orphaned
// debugger sessions, and drop HUD conversations of tabs that are gone.
gdExpireOrphans().catch((e) => console.warn("approval restore", e));
wcRelayRestore().catch((e) => console.warn("relay restore", e));
hudPrune().catch(() => {});
