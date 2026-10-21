// webclaw benchmark tasks — deterministic fixtures in bench/site/.
// Each task has three implementations of the same job:
//   step(A)  — what a ref-reading agent does: one marker per tool call
//              (outline → pick @ref → act → read), A.m() = one round-trip
//   run      — the same job as ONE [RUN] script (single round-trip)
//   relay(p) — the same job through the CDP relay with Puppeteer (page p)
// verify(A) reads the final state (not counted in the metrics).
"use strict";

const ref = (outline, re) => {
  const line = outline.split("\n").find((l) => re.test(l));
  if (!line) throw new Error("ref not found for " + re + "\n" + outline.slice(0, 400));
  return line.split(" ")[0];
};

module.exports = [
  {
    id: "login", page: "login.html", title: "Log in through a form",
    async step(A) {
      const o = await A.m("[OUTLINE]");
      await A.m("[TYPE] " + ref(o, /textbox "Username"/) + "\nalice");
      await A.m("[TYPE] " + ref(o, /textbox "Password"/) + "\ns3cret");
      await A.m("[CLICK] " + ref(o, /button "Sign in"/));
      await A.m("[WAIT] #done :: 5000");
    },
    run: `await type('input[name=u]', 'alice'); await type('input[name=p]', 's3cret'); await click('button[type=submit]'); await wait('#done', 5000); return await dom('#done');`,
    async relay(p) { await p.type("input[name=u]", "alice"); await p.type("input[name=p]", "s3cret"); await p.click("button[type=submit]"); await p.waitForSelector("#done"); },
    verify: async (A) => (await A.m("[DOM] #done")).trim() === "Welcome, alice",
  },
  {
    id: "search", page: "search.html", title: "Search and extract result rows",
    async step(A) {
      const o = await A.m("[OUTLINE]");
      await A.m("[TYPE] " + ref(o, /textbox "Search products"/) + "\napple");
      await A.m("[CLICK] " + ref(o, /button "Search"/));
      A.result = await A.m("[DOM] #res tbody tr");
    },
    run: `await type('#q', 'apple'); await click('#go'); return (await dom('#res tbody tr')).split('\\n');`,
    async relay(p) { await p.type("#q", "apple"); await p.click("#go"); return p.$$eval("#res tbody tr", (r) => r.length); },
    verify: async (A) => (await A.m("[DOM] #res tbody tr")).trim().split("\n").length === 5,
  },
  {
    id: "wizard", page: "wizard.html", title: "3-step wizard (radio, select, checkbox)",
    async step(A) {
      let o = await A.m("[OUTLINE]");
      await A.m("[CLICK] " + ref(o, /radio "Pro plan"/));
      await A.m("[CLICK] " + ref(o, /button "Next"/));
      o = await A.m("[OUTLINE]");
      await A.m("[FILL] " + ref(o, /combobox "Country/) + "\nKR");
      await A.m("[CLICK] " + ref(o, /button "Next"/));
      o = await A.m("[OUTLINE]");
      await A.m("[CLICK] " + ref(o, /checkbox "I accept the terms"/));
      await A.m("[CLICK] " + ref(o, /button "Finish"/));
    },
    run: `await click('input[value=pro]'); await click('#n1'); await fill('#c', 'KR'); await click('#n2'); await click('#tos'); await click('#n3'); return await dom('#code');`,
    async relay(p) { await p.click("input[value=pro]"); await p.click("#n1"); await p.waitForSelector("#c"); await p.select("#c", "KR"); await p.click("#n2"); await p.waitForSelector("#tos"); await p.click("#tos"); await p.click("#n3"); },
    verify: async (A) => (await A.m("[DOM] #code")).trim() === "CODE-PRO-KR",
  },
  {
    id: "controlled-input", page: "react.html", title: "Framework-controlled input enables a button",
    async step(A) {
      const o = await A.m("[OUTLINE]");
      await A.m("[TYPE] " + ref(o, /textbox "Email address"/) + "\nme@example.com");
      await A.m("[CLICK] " + ref(o, /button "Subscribe"/));
    },
    run: `await type('#email', 'me@example.com'); await click('#sub'); return await dom('#out');`,
    async relay(p) { await p.type("#email", "me@example.com"); await p.click("#sub"); },
    verify: async (A) => (await A.m("[DOM] #out")).trim() === "subscribed me@example.com",
  },
  {
    id: "cross-origin-iframe", page: "frame-host.html", title: "Click inside a cross-origin iframe",
    async step(A) {
      const o = await A.m("[OUTLINE]");
      await A.m("[CLICK] " + ref(o, /button "Confirm order"/));
      await A.m("[WAIT] text:confirmed W-42 :: 5000");
    },
    run: `const o = await outline(); const r = o.split('\\n').find((l) => /Confirm order/.test(l)).split(' ')[0]; await click(r); await wait('text:confirmed W-42', 5000); return await dom('#status');`,
    async relay(p) { const f = p.frames().find((x) => /frame-widget/.test(x.url())); await f.click("#confirm"); await p.waitForFunction(() => /confirmed/.test(document.getElementById("status").textContent)); },
    verify: async (A) => (await A.m("[DOM] #status")).trim() === "confirmed W-42",
  },
  {
    id: "shadow-dom", page: "shadow.html", title: "Button inside an open shadow root",
    async step(A) {
      const o = await A.m("[OUTLINE]");
      await A.m("[CLICK] " + ref(o, /button "Enable dark mode"/));
    },
    run: `const o = await outline(); await click(o.split('\\n').find((l) => /Enable dark mode/.test(l)).split(' ')[0]); return await dom('#state');`,
    async relay(p) { await p.click("settings-panel >>> #toggle"); },
    verify: async (A) => (await A.m("[DOM] #state")).trim() === "dark mode on",
  },
  {
    id: "pagination", page: "pages.html", title: "Collect 30 items across 3 pages",
    async step(A) {
      const items = [];
      for (let i = 0; i < 3; i++) {
        items.push(...(await A.m("[DOM] #items li")).trim().split("\n"));
        if (i < 2) { const o = await A.m("[OUTLINE]"); await A.m("[CLICK] " + ref(o, /button "Next page"/)); }
      }
      A.result = items;
    },
    run: `const all = []; for (let i = 0; i < 3; i++) { all.push(...(await dom('#items li')).split('\\n')); if (i < 2) await click('#next'); } return all.length;`,
    async relay(p) { const all = []; for (let i = 0; i < 3; i++) { all.push(...await p.$$eval("#items li", (l) => l.map((x) => x.textContent))); if (i < 2) await p.click("#next"); } return all.length; },
    verify: async (A) => (await A.m("[DOM] #pg")).trim() === "page 3/3" && (!A.result || A.result.length === 30),
  },
  {
    id: "upload", page: "upload.html", title: "Attach a local file",
    async step(A) {
      const o = await A.m("[OUTLINE]");
      await A.m("[UPLOAD] " + ref(o, /^@\d+ file/) + " :: " + A.uploadFile);
    },
    run: (A) => `await upload('#doc', [${JSON.stringify(A.uploadFile)}]); return await dom('#got');`,
    async relay(p, A) { const h = await p.$("#doc"); await h.uploadFile(A.uploadFile); await p.waitForFunction(() => /attached/.test(document.getElementById("got").textContent)); },
    verify: async (A) => /^attached upload-sample\.txt/.test((await A.m("[DOM] #got")).trim()),
  },
  {
    id: "delayed", page: "delayed.html", title: "Wait for late content and read it",
    async step(A) {
      await A.m("[WAIT] #total :: 8000");
      A.result = await A.m("[DOM] #total");
    },
    run: `await wait('#total', 8000); return await dom('#total');`,
    async relay(p) { await p.waitForSelector("#total"); return p.$eval("#total", (e) => e.textContent); },
    verify: async (A) => (await A.m("[DOM] #total")).trim() === "Total revenue: 1,234,567",
  },
  {
    id: "modal", page: "modal.html", title: "Confirm inside a modal dialog",
    async step(A) {
      let o = await A.m("[OUTLINE]");
      await A.m("[CLICK] " + ref(o, /button "Archive project"/));
      o = await A.m("[OUTLINE]");
      await A.m("[CLICK] " + ref(o, /button "Yes, archive"/));
    },
    run: `await click('#del'); await clickText('Yes, archive'); return await dom('#msg');`,
    async relay(p) { await p.click("#del"); await p.click("#ok"); },
    verify: async (A) => (await A.m("[DOM] #msg")).trim() === "archived alpha",
  },
];
