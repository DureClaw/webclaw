const $ = (id) => document.getElementById(id);
const FIELDS = ["bus", "secret", "workKey", "name", "brainUrl", "brainToken"];

async function load() {
  const { cfg = {}, status, feed } = await chrome.storage.local.get(["cfg", "status", "feed"]);
  FIELDS.forEach((f) => { if (cfg[f] != null) $(f).value = cfg[f]; });
  render(status, feed);
}
function render(status, feed) {
  $("status").textContent = status || "—";
  $("dot").className = "dot " + (status === "connected" ? "on" : status === "disconnected" ? "off" : "");
  $("feed").innerHTML = (feed || []).map((e) =>
    `<div><span class="muted">${e.at}</span> <span class="${e.dir}">${e.dir === "in" ? "→" : "←"} ${e.name}</span> ${escapeHtml(e.text)}</div>`
  ).join("");
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
chrome.storage.onChanged.addListener(async () => {
  const { status, feed } = await chrome.storage.local.get(["status", "feed"]);
  render(status, feed);
});
load();
