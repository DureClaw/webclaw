#!/usr/bin/env node
// Download the gated Online-Mind2Web task file (osunlp/Online-Mind2Web, CC-BY-4.0) into
// ~/.webclaw/om2w/ — never into the repo. Needs HF_TOKEN (read) after access is granted.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
for (const f of [path.join(__dirname, "..", "..", ".env"), path.join(os.homedir(), ".webclaw", ".env")]) { try { if (fs.existsSync(f)) process.loadEnvFile(f); } catch (e) {} }

const REPO = "osunlp/Online-Mind2Web";
const OUT = path.join(os.homedir(), ".webclaw", "om2w");
const token = process.env.HF_TOKEN;
if (!token) { console.error("HF_TOKEN missing — request access at https://huggingface.co/datasets/" + REPO + " and add a read token to .env"); process.exit(1); }
const H = { authorization: "Bearer " + token };

(async () => {
  const tree = await fetch("https://huggingface.co/api/datasets/" + REPO + "/tree/main?recursive=1", { headers: H });
  if (tree.status === 401 || tree.status === 403) { console.error("HF says " + tree.status + " — is access to " + REPO + " approved for this token's account?"); process.exit(1); }
  const files = (await tree.json()).filter((f) => f.type === "file" && /\.json$/i.test(f.path));
  if (!files.length) { console.error("no .json task file found in " + REPO); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  for (const f of files) {
    const r = await fetch("https://huggingface.co/datasets/" + REPO + "/resolve/main/" + f.path, { headers: H });
    if (!r.ok) { console.error("download failed " + f.path + ": HTTP " + r.status); continue; }
    const dest = path.join(OUT, path.basename(f.path));
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    let n = "?"; try { const j = JSON.parse(fs.readFileSync(dest, "utf8")); n = Array.isArray(j) ? j.length : Object.keys(j).length; } catch (e) {}
    console.log("saved " + dest + " (" + n + " records)");
  }
})().catch((e) => { console.error(e); process.exit(1); });
