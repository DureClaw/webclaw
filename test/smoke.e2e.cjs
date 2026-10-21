// Real-browser smoke test — zero dependencies, runs only when CHROME_BIN points
// at Chrome for Testing or Chromium (branded Chrome ignores --load-extension):
//
//   CHROME_BIN="…/Google Chrome for Testing" npm run test:e2e
//
// In-process mini-bus (temp secret) + bench/site fixtures + a temp copy of the
// extension, then: join → [OPEN] → [OUTLINE] → trusted [CLICK] → [DOM] →
// System One goal loop against the mock Jev oracle → saved recipe replays with
// args (and refuses without them) → policy deny list blocks reads.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const CHROME = process.env.CHROME_BIN;
const ROOT = path.join(__dirname, "..");

test("real-browser smoke (set CHROME_BIN)", { skip: !CHROME && "CHROME_BIN not set", timeout: 180000 }, async () => {
  const { createMiniBus } = require("../bridge/minibus.cjs");
  const { createClient } = require("../bridge/client.cjs");
  const { createJev } = require("../bridge/brain/jev.cjs");
  const { runGoal } = require("../bridge/brain/agent.cjs");
  const { createMockJev } = require("./mock-jev.cjs");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "webclaw-smoke-"));
  const secret = "smoke-" + Math.random().toString(36).slice(2, 12) + "-secret-xx";
  const bus = createMiniBus({ secret, workKey: "WK-smoke" });
  const busPort = await bus.listen(0, "127.0.0.1");
  const site = http.createServer((req, res) => {
    const f = path.join(ROOT, "bench", "site", path.basename(req.url.split("?")[0]));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(f));
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + site.address().port;

  // temp extension copy pointed at the in-process bus
  const ext = path.join(tmp, "ext");
  fs.cpSync(ROOT, ext, { recursive: true, filter: (p) => !/[/\\](\.git|\.claude|node_modules|test|bench)([/\\]|$)/.test(p.slice(ROOT.length)) && !/config\.local\.json/.test(p) });
  fs.writeFileSync(path.join(ext, "config.local.json"), JSON.stringify({ bus: "127.0.0.1:" + busPort, secret, workKey: "WK-smoke", name: "webclaw@smoke", policy: { deny: ["denied.invalid"] } }));
  const chrome = spawn(CHROME, ["--headless=new", "--user-data-dir=" + path.join(tmp, "profile"), "--load-extension=" + ext,
    "--disable-extensions-except=" + ext, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });

  const oracle = 'Log in as alice with password "s3cret"';
  const mock = createMockJev({ scripts: { [oracle]: [
    { kind: "type", target: 'textbox "Username"', value: "alice" },
    { kind: "type", target: 'textbox "Password"', value: "s3cret" },
    { kind: "click", target: 'button "Sign in"' },
  ] } });
  const jevPort = await mock.listen();
  try {
    const client = createClient({ bus: "127.0.0.1:" + busPort, secret, workKey: "WK-smoke" });
    let joined = false;
    for (let i = 0; i < 60 && !joined; i++) {
      try { joined = (await client.nodes()).some((n) => /^webclaw@smoke/.test(n.name)); } catch (e) {}
      if (!joined) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(joined, "extension joined the bus");
    await new Promise((r) => setTimeout(r, 1500)); // let onInstalled settle
    const T = async (m) => client.dispatch(m, { timeoutMs: 30000 });

    let r = await T("[SPACE] smoke");
    assert.match(r.output, /space smoke ready/);
    r = await T("[OPEN@space:smoke] " + base + "/login.html");
    assert.equal(r.status, "done", r.output);
    r = await T("[OUTLINE@space:smoke]");
    assert.match(r.output, /@\d+ textbox "Username"/);
    assert.match(r.output, /@\d+ button "Sign in"/);

    // System One goal loop (mock Jev) → recipe saved without values
    const jev = createJev({ apiKey: "test-key", baseUrl: "http://127.0.0.1:" + jevPort });
    const g = await runGoal({ webclaw: client, jev, goal: oracle, tab: "space:smoke", save: "127.0.0.1/login" });
    assert.equal(g.ok, true, JSON.stringify(g).slice(0, 400));
    assert.equal((await T("[DOM@space:smoke] #done")).output.trim(), "Welcome, alice");

    // replay: refused without args, works with them
    await T("[CLOSE@space:smoke]");
    await T("[OPEN@space:smoke] " + base + "/login.html");
    r = await T("[RECIPE@space:smoke] 127.0.0.1/login");
    assert.equal(r.status, "failed");
    assert.match(r.output, /missing args/);
    r = await T('[RECIPE@space:smoke] 127.0.0.1/login\n{"v1":"alice","password":"s3cret"}');
    assert.equal(r.status, "done", r.output);
    assert.equal((await T("[DOM@space:smoke] #done")).output.trim(), "Welcome, alice");

    // learned recipe must not contain the typed values
    r = await T("[LEARNINGS] export");
    assert.doesNotMatch(r.output, /s3cret/);
    assert.doesNotMatch(r.output, /"alice"/);

    // trusted click via CDP + failure elevation
    await T("[OPEN@space:smoke] " + base + "/react.html");
    r = await T("[CLICK@space:smoke] #nope");
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "no_match");
    // the deny list from config.local.json applies (fetch is refused before any request)
    r = await T("[FETCH] http://denied.invalid/");
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "policy_denied");
  } finally {
    chrome.kill();
    await mock.close();
    await bus.close();
    site.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
});
