// webclaw page outline + @refs (v0.7.0). Loaded into the background SW.
//
// [OUTLINE] tags every interactive element (all frames, open shadow roots)
// with data-wc-ref=<local id> and returns a compact, LLM-readable list:
//     @12 button "Sign in"
// Line contract (parsed by the brain): `@N <role> <JSON string name>` + suffixes
// — the name is JSON.stringify'd, so quotes/backslashes in it are escaped.
// Frames whose host is on the policy deny list are left out entirely.
// The global @N → {documentId, frameId, local id} map lives in
// chrome.storage.session (survives SW restarts), keyed by tab. Any marker that
// takes a selector also accepts @N. A ref dies with its document: navigation
// or a re-render that drops the element yields reason "stale_ref" — re-run
// [OUTLINE].

const WC_OUTLINE_MAX = 400; // interactive elements per frame

// Injected into every frame (static function → page CSP cannot block it).
function wcOutlineInjected(max) {
  const ATTR = "data-wc-ref";
  const els = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) { els.push(el); if (el.shadowRoot) walk(el.shadowRoot); }
  };
  walk(document);
  for (const el of els) if (el.hasAttribute(ATTR)) el.removeAttribute(ATTR);

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  };
  const ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "combobox", "textbox", "searchbox", "switch", "slider", "spinbutton", "treeitem", "listbox"]);
  const roleOf = (el) => {
    const r = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (ROLES.has(r)) return r;
    const tag = el.tagName;
    if (tag === "A" && el.hasAttribute("href")) return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "hidden") return null;
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox" || t === "radio") return t;
      if (t === "range") return "slider";
      if (t === "file") return "file";
      return "textbox";
    }
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return "combobox";
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "textbox";
    if (el.hasAttribute("onclick")) return "clickable";
    if (el.hasAttribute("tabindex") && el.tabIndex >= 0 && getComputedStyle(el).cursor === "pointer") return "clickable";
    return null;
  };
  const nameOf = (el) => {
    const al = clean(el.getAttribute("aria-label"));
    if (al) return al;
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const root = el.getRootNode();
      const t = clean(lb.split(/\s+/).map((id) => {
        const n = (root.getElementById && root.getElementById(id)) || document.getElementById(id);
        return n ? n.textContent : "";
      }).join(" "));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = clean([...el.labels].map((l) => l.innerText).join(" "));
      if (t) return t;
    }
    for (const a of ["placeholder", "alt", "title"]) { const v = clean(el.getAttribute(a)); if (v) return v; }
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return clean(el.value);
    const txt = clean(el.innerText || el.textContent);
    if (txt) return txt;
    const img = el.querySelector && el.querySelector("img[alt]");
    return img ? clean(img.alt) : "";
  };

  const items = [];
  let n = 0, truncated = 0;
  for (const el of els) {
    if (el.closest && el.closest("#__wc_hud")) continue; // our own HUD
    const tag = el.tagName;
    if (/^H[1-3]$/.test(tag)) {
      if (visible(el)) { const t = clean(el.innerText).slice(0, 100); if (t) items.push({ line: "#".repeat(+tag[1]) + " " + t }); }
      continue;
    }
    if ((tag === "DIALOG" && el.open) || el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true") {
      if (visible(el)) items.push({ line: "[dialog] " + clean(el.getAttribute("aria-label")).slice(0, 60) });
      continue;
    }
    const role = roleOf(el);
    if (!role) continue;
    const shown = visible(el);
    // hidden checkbox/radio/file inputs are still actionable (click / upload)
    if (!shown && !["checkbox", "radio", "file"].includes(role)) continue;
    if (n >= max) { truncated++; continue; }
    const id = ++n;
    el.setAttribute(ATTR, String(id));
    let line = role + " " + JSON.stringify(nameOf(el).slice(0, 80));
    if (role === "link") {
      const h = el.getAttribute("href") || "";
      if (h && !/^javascript:/i.test(h)) line += " → " + h.slice(0, 100);
    }
    if (["textbox", "searchbox", "slider", "spinbutton"].includes(role)) {
      const v = el.isContentEditable ? clean(el.innerText) : el.value;
      // S6 — a typed password never leaves the page through the outline
      if (v) line += " value=" + JSON.stringify(tag === "INPUT" && el.type === "password" ? "•".repeat(Math.min(String(v).length, 12)) : String(v).slice(0, 80));
      if (tag === "INPUT" && el.type && el.type !== "text") line += " type=" + el.type;
    }
    if (["checkbox", "radio", "switch"].includes(role)) line += (el.checked || el.getAttribute("aria-checked") === "true") ? " [x]" : " [ ]";
    if (role === "combobox" && tag === "SELECT") {
      const o = el.selectedOptions && el.selectedOptions[0];
      line += " value=" + JSON.stringify(clean(o && o.text).slice(0, 60));
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " (disabled)";
    if (!shown) line += " (hidden)";
    items.push({ id, line });
  }
  return { url: location.href, title: document.title, items, truncated };
}

async function wcOutline(tab, max) {
  max = Number(max) > 0 ? Number(max) : WC_OUTLINE_MAX;
  let res;
  try {
    res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: wcOutlineInjected, args: [max] });
  } catch (e) {
    // one hostile subframe must not cost us the main document
    res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: wcOutlineInjected, args: [max] });
  }
  res = (res || []).filter((r) => r && r.result).sort((a, b) => a.frameId - b.frameId);
  // S5 — a denied site embedded as an iframe stays invisible and unreachable
  const deny = (await gdPolicy()).deny;
  res = res.filter((r) => r.frameId === 0 || !gdMatch(gdHost(r.result.url), deny));
  const map = {};
  const out = [];
  let g = 0;
  for (const r of res) {
    const v = r.result;
    const hasRefs = v.items.some((it) => it.id != null);
    if (r.frameId !== 0) {
      if (!hasRefs) continue; // skip ad/tracker frames with nothing to act on
      out.push("== frame " + String(v.url).slice(0, 120));
    }
    for (const it of v.items) {
      if (it.id == null) { out.push(it.line); continue; }
      g++;
      map[g] = { d: r.documentId, f: r.frameId, l: it.id, u: String(v.url || "").slice(0, 300) };
      out.push("@" + g + " " + it.line);
    }
    if (v.truncated) out.push("… " + v.truncated + " more interactive elements in this frame (cap " + max + ")");
  }
  await chrome.storage.session.set({ ["refs:" + tab.id]: map });
  const main = (res.find((r) => r.frameId === 0) || {}).result || {};
  return (main.title || "") + " | " + (main.url || tab.url || "") + "\n" +
    "refs: " + g + " (re-run [OUTLINE] after navigation or big DOM changes)\n" + out.join("\n");
}

function wcFail(text, reason) { return Object.assign(new Error(text), { reason }); }

// "@12" → frame-precise target + CSS for the tagged element; anything else is
// plain CSS against the main frame.
async function wcResolve(tab, sel) {
  const s = String(sel || "").trim();
  const m = /^@(\d+)$/.exec(s);
  if (!m) return { target: { tabId: tab.id }, css: s, frameId: 0, ref: null };
  const key = "refs:" + tab.id;
  const map = (await chrome.storage.session.get(key))[key] || {};
  const e = map[m[1]];
  if (!e) throw wcFail("(stale ref: " + s + " — run [OUTLINE] again)", "stale_ref");
  // frame refs: re-check the frame's site (the deny list may have changed)
  if (e.u && e.f !== 0 && gdMatch(gdHost(e.u), (await gdPolicy()).deny)) throw wcFail("(policy: " + gdHost(e.u) + " is on the deny list)", "policy_denied");
  const target = e.d ? { tabId: tab.id, documentIds: [e.d] } : { tabId: tab.id, frameIds: [e.f] };
  return { target, css: '[data-wc-ref="' + e.l + '"]', frameId: e.f, ref: s };
}

chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove("refs:" + tabId).catch(() => {}); });
