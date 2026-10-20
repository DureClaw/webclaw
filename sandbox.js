// [RUN] host inside the sandbox iframe. Parent = offscreen document.
// parent → { kind:"run", runId, code, tab, args }
// sandbox → { kind:"rpc", runId, callId, text }   (one marker)
// parent → { kind:"rpcResult", callId, ok, text, reason }
// sandbox → { kind:"runDone", runId, res }
const pending = new Map();
let seq = 0;

function call(runId, text) {
  const callId = runId + ":" + ++seq;
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    window.parent.postMessage({ kind: "rpc", runId, callId, text }, "*");
  });
}

window.addEventListener("message", async (ev) => {
  if (ev.source !== window.parent) return;
  const m = ev.data || {};
  if (m.kind === "ping") { window.parent.postMessage({ kind: "sandboxReady" }, "*"); return; }
  if (m.kind === "rpcResult") {
    const p = pending.get(m.callId);
    if (!p) return;
    pending.delete(m.callId);
    if (m.ok) p.resolve(m.text);
    else p.reject(Object.assign(new Error(m.text), { reason: m.reason || "marker_failed" }));
    return;
  }
  if (m.kind === "run") {
    const res = await webclawRunner.runScript(m.code, (text) => call(m.runId, text), { tab: m.tab, args: m.args });
    // results must survive structured clone (no functions/DOM) — JSON-normalize
    let safe;
    try { safe = JSON.parse(JSON.stringify(res)); } catch (e) { safe = Object.assign({}, res, { result: String(res.result) }); }
    window.parent.postMessage({ kind: "runDone", runId: m.runId, res: safe }, "*");
  }
});
window.parent.postMessage({ kind: "sandboxReady" }, "*");
