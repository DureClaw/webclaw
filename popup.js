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
    return `<div><span class="muted">${e.at}</span> <span class="${cls}">${e.dir === "in" ? "→" : "←"} ${escapeHtml(e.name)}</span> ${escapeHtml(e.text)}</div>`;
  }).join("");
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

$("connect").onclick = async () => {
  const cfg = {};
  FIELDS.forEach((f) => (cfg[f] = $(f).value.trim()));
  cfg.role = "executor";
  cfg.caps = ["browser", "fetch", "agent", "webclaw"];
  await chrome.storage.local.set({ cfg });
  chrome.runtime.sendMessage({ type: "connect" }, () => {});
  $("status").textContent = "connecting…";
};
$("hudHere").onclick = () => chrome.runtime.sendMessage({ type: "hudHere" }, () => {});
chrome.storage.onChanged.addListener(async () => {
  const { cfg, status, feed, activeCfg } = await chrome.storage.local.get(["cfg", "status", "feed", "activeCfg"]);
  render(status, feed, activeCfg || cfg);
});
load();
