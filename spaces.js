// webclaw agent Spaces + hand-off (v0.7.0). Loaded into the background SW.
//
// A Space is a tab group inside a dedicated, *unfocused* agent window, so the
// agent can work without stealing the human's tab, focus, or mouse. Spaces
// have an owner: "agent" (automation allowed) or "user" (handed off — every
// mutating marker on its tabs is refused with reason "handed_off" until the
// human types /done in the HUD chat or the master sends [TAKEOVER]).
//
// Targeting: [SPACE] <name> makes it the node's current space (markers without
// @ then hit it). Per-marker targeting — needed for parallel scripts — is
// [CLICK@space:<name>] … ; [RUN] scripts use useSpace(name).
//
// storage.local: wcSpaces = { name: { groupId, windowId, owner, note } },
//                wcCurrentSpace = name | null, wcAgentWindowId

async function spLoad() {
  const { wcSpaces = {}, wcCurrentSpace = null } = await chrome.storage.local.get(["wcSpaces", "wcCurrentSpace"]);
  return { spaces: wcSpaces, current: wcCurrentSpace };
}
function spSave(spaces, current) {
  const patch = { wcSpaces: spaces };
  if (current !== undefined) patch.wcCurrentSpace = current;
  return chrome.storage.local.set(patch);
}

async function spGroupAlive(sp) {
  if (!sp || sp.groupId == null) return false;
  try { await chrome.tabGroups.get(sp.groupId); return true; } catch { return false; }
}

async function spAgentWindow() {
  const { wcAgentWindowId } = await chrome.storage.local.get("wcAgentWindowId");
  if (wcAgentWindowId != null) {
    try { await chrome.windows.get(wcAgentWindowId); return { windowId: wcAgentWindowId, fresh: null }; } catch {}
  }
  const win = await chrome.windows.create({ url: "about:blank", focused: false, type: "normal", width: 1280, height: 900 });
  await chrome.storage.local.set({ wcAgentWindowId: win.id });
  return { windowId: win.id, fresh: win.tabs && win.tabs[0] };
}

function spTitle(name, owner) { return (owner === "user" ? "🙋 " : "🤖 ") + name; }

// Most recently used tab of a space (null if the space or its tabs are gone).
async function spTab(name) {
  const { spaces } = await spLoad();
  const sp = spaces[name];
  if (!(await spGroupAlive(sp))) return null;
  const tabs = (await chrome.tabs.query({ groupId: sp.groupId })).filter((t) => !t.discarded);
  tabs.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  return tabs[0] || null;
}

// Which space (if any) owns this tab.
async function spOfTab(tab) {
  if (!tab || tab.groupId == null || tab.groupId === -1) return null;
  const { spaces } = await spLoad();
  for (const [name, sp] of Object.entries(spaces)) if (sp.groupId === tab.groupId) return Object.assign({ name }, sp);
  return null;
}

// Resolve "space:<name>" / current space. Returns { space, rest } where rest
// is the plain URL-substring part (if any).
async function spTargetOf(urlMatch) {
  if (urlMatch && urlMatch.startsWith("space:")) return { space: urlMatch.slice(6).trim(), rest: "" };
  if (urlMatch) return { space: null, rest: urlMatch };
  const { current } = await spLoad();
  return { space: current, rest: "" };
}

async function spEnsure(name) {
  const { spaces } = await spLoad();
  const sp = spaces[name];
  if (await spGroupAlive(sp)) return sp;
  const { windowId, fresh } = await spAgentWindow();
  const tab = fresh || await chrome.tabs.create({ windowId, url: "about:blank", active: true });
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: spTitle(name, "agent"), color: "purple" });
  spaces[name] = { groupId, windowId, owner: "agent", note: "" };
  await spSave(spaces);
  return spaces[name];
}

// Open a URL as a new tab inside a space (agent window stays unfocused).
async function spOpen(name, url, opts) {
  const sp = await spEnsure(name);
  // reuse the space's placeholder about:blank tab if that's all it has
  // (not for the CDP relay: a client's newPage must be a brand-new target)
  const tabs = await chrome.tabs.query({ groupId: sp.groupId });
  let tab;
  if (!(opts && opts.fresh) && tabs.length === 1 && /^about:blank/.test(tabs[0].url || tabs[0].pendingUrl || "")) {
    tab = await chrome.tabs.update(tabs[0].id, { url, active: true });
  } else {
    tab = await chrome.tabs.create({ windowId: sp.windowId, url, active: true });
    await chrome.tabs.group({ tabIds: [tab.id], groupId: sp.groupId });
  }
  return tab;
}

async function spSetOwner(name, owner, note) {
  const { spaces } = await spLoad();
  const sp = spaces[name];
  if (!sp) throw wcFail("(no such space: " + name + ")", "no_space");
  sp.owner = owner;
  sp.note = note || "";
  await spSave(spaces);
  try { await chrome.tabGroups.update(sp.groupId, { title: spTitle(name, owner), color: owner === "user" ? "orange" : "purple" }); } catch {}
  return sp;
}

// Mutating actions on a handed-off space are refused (reads stay allowed).
async function spBlock(tab) {
  const sp = await spOfTab(tab);
  if (sp && sp.owner === "user") {
    return { text: "(space '" + sp.name + "' is handed off to the user — wait for /done or send [TAKEOVER] " + sp.name + ")", failed: true, reason: "handed_off" };
  }
  return null;
}

async function spHandle(msg) {
  const { spaces, current } = await spLoad();
  const arg = String(msg.arg || "").trim();
  if (msg.op === "list") {
    const names = Object.keys(spaces);
    if (!names.length) return { text: "(no spaces — create one with [SPACE] <name>)" };
    const lines = [];
    for (const n of names) {
      const alive = await spGroupAlive(spaces[n]);
      const count = alive ? (await chrome.tabs.query({ groupId: spaces[n].groupId })).length : 0;
      lines.push((n === current ? "* " : "  ") + n + " — owner:" + spaces[n].owner + " tabs:" + count + (alive ? "" : " (closed)") +
        (spaces[n].note ? " note:" + spaces[n].note : ""));
    }
    return { text: lines.join("\n") };
  }
  if (msg.op === "space") {
    if (!arg || arg === "off") {
      await spSave(spaces, null);
      return { text: "space off — markers target the user's active tab again" };
    }
    const cm = arg.match(/^close\s+(.+)$/);
    if (cm) {
      const n = cm[1].trim();
      const sp = spaces[n];
      if (!sp) return { text: "(no such space: " + n + ")", failed: true, reason: "no_space" };
      if (await spGroupAlive(sp)) {
        const tabs = await chrome.tabs.query({ groupId: sp.groupId });
        if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id));
      }
      delete spaces[n];
      await spSave(spaces, current === n ? null : current);
      return { text: "closed space " + n };
    }
    const sp = await spEnsure(arg);
    await chrome.storage.local.set({ wcCurrentSpace: arg });
    return { text: "space " + arg + " ready (window " + sp.windowId + ", group " + sp.groupId + ", owner " + sp.owner + ") — markers without @ now target it; [SPACE] off to release" };
  }
  if (msg.op === "handoff" || msg.op === "takeover") {
    const name = arg || current;
    if (!name) return { text: "(no space given and no current space)", failed: true, reason: "no_space" };
    const owner = msg.op === "handoff" ? "user" : "agent";
    const sp = await spSetOwner(name, owner, msg.note);
    const tab = await spTab(name);
    if (owner === "user" && tab) {
      // bring the space in front of the human
      try { await chrome.windows.update(sp.windowId, { focused: true }); await chrome.tabs.update(tab.id, { active: true }); } catch {}
      hudNotify(tab.id, "🙋 에이전트가 이 작업을 넘겼습니다" + (msg.note ? ": " + msg.note : "") + " — 끝나면 채팅에 /done", null, true);
    } else if (tab) {
      hudNotify(tab.id, "🤖 에이전트가 다시 제어합니다", null, true);
    }
    return { text: (owner === "user" ? "handed off " : "took over ") + name };
  }
  return { text: "(unknown space op: " + msg.op + ")", failed: true, reason: "bad_args" };
}

// HUD "/done" in a handed-off space returns control to the agent.
async function spUserDone(tab) {
  const sp = await spOfTab(tab);
  if (!sp || sp.owner !== "user") return null;
  await spSetOwner(sp.name, "agent", "");
  return sp.name;
}
