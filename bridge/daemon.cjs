// Start/stop the local mini-bus as a detached background process, so every
// CLI call and MCP session (several agents at once) share one bus on :4777.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { HOME_DIR } = require("./config.cjs");

const PID_FILE = path.join(HOME_DIR, "minibus.pid");
const LOG_FILE = path.join(HOME_DIR, "minibus.log");
const BIN = path.join(__dirname, "..", "bin", "webclaw.cjs");

async function healthy(bus) {
  try {
    const r = await fetch("http://" + bus + "/api/health", { signal: AbortSignal.timeout(800) });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

// Ensure a mini-bus answers on cfg.bus; spawn one if not. Returns its health.
async function ensureMiniBus(cfg) {
  const h = await healthy(cfg.bus);
  if (h) return h;
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const out = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [BIN, "serve"], { detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const ok = await healthy(cfg.bus);
    if (ok) return ok;
  }
  throw new Error("mini-bus did not come up on " + cfg.bus + " — see " + LOG_FILE);
}

function stopMiniBus() {
  let pid;
  try { pid = Number(fs.readFileSync(PID_FILE, "utf8")); } catch (e) { return false; }
  try { process.kill(pid, "SIGTERM"); } catch (e) {}
  try { fs.unlinkSync(PID_FILE); } catch (e) {}
  return true;
}

module.exports = { ensureMiniBus, stopMiniBus, healthy, PID_FILE, LOG_FILE };
