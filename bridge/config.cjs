// webclaw bridge config — shared by the CLI and the MCP server.
//
// Resolution (first hit wins per field):
//   env WEBCLAW_BUS / WEBCLAW_SECRET / WEBCLAW_WORK_KEY / WEBCLAW_NODE / WEBCLAW_MODE
//   ~/.webclaw/config.json           (written by `webclaw setup`)
//   <repo>/config.local.json          (the extension's own config → bus mode)
// mode "standalone" = local mini-bus on 127.0.0.1:4777, auto-started on demand.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME_DIR = process.env.WEBCLAW_HOME || path.join(os.homedir(), ".webclaw");
const HOME_CFG = path.join(HOME_DIR, "config.json");
const REPO_DIR = path.join(__dirname, "..");
const EXT_CFG = path.join(REPO_DIR, "config.local.json");
const STANDALONE_BUS = "127.0.0.1:4777";

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } }

function loadConfig() {
  const home = readJson(HOME_CFG) || {};
  const ext = readJson(EXT_CFG) || {};
  const base = Object.keys(home).length ? home : { mode: "bus", bus: ext.bus, secret: ext.secret, workKey: ext.workKey };
  const cfg = {
    mode: process.env.WEBCLAW_MODE || base.mode || "bus",
    bus: process.env.WEBCLAW_BUS || base.bus || "",
    secret: process.env.WEBCLAW_SECRET || base.secret || "",
    workKey: process.env.WEBCLAW_WORK_KEY || base.workKey || "",
    node: process.env.WEBCLAW_NODE || base.node || "",
  };
  if (cfg.mode === "standalone") {
    cfg.bus = cfg.bus || STANDALONE_BUS;
    cfg.workKey = cfg.workKey || "WK-local";
  }
  cfg.source = Object.keys(home).length ? HOME_CFG : (Object.keys(ext).length ? EXT_CFG : "(none)");
  return cfg;
}

function saveHomeConfig(cfg) {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(HOME_CFG, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

module.exports = { loadConfig, saveHomeConfig, HOME_DIR, HOME_CFG, EXT_CFG, REPO_DIR, STANDALONE_BUS, readJson };
