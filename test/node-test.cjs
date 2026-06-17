const { createWebclaw } = require("../core.js");
const SEC = process.env.OAH_SECRET, BUS="127.0.0.1:4000";
const cfg = { bus:BUS, secret:SEC, workKey:"WK-2a56b4f1", name:"webclaw@node-test", role:"executor",
  caps:["browser","fetch","agent","test"], brainUrl:"http://127.0.0.1:4111", brainToken:"922cee741d8b73aac4a556f2c5957861" };
const wc = createWebclaw(cfg, { onLog:m=>console.log("  [webclaw]",m), onStatus:s=>console.log("  [status]",s) });
async function req(path, body){ const r=await fetch("http://"+BUS+path,{method:body?"POST":"GET",headers:{"authorization":"Bearer "+SEC,"content-type":"application/json"},body:body?JSON.stringify(body):undefined}); return [r.status, await r.text()]; }
(async ()=>{
  await new Promise(r=>setTimeout(r,2500)); // wait for join
  for (const [label,instr] of [["LLM(브레인 위임)","In one sentence: what causes flash in injection molding?"],["[FETCH]","[FETCH] http://127.0.0.1:4000/api/health"]]){
    const tid="wc-"+label.replace(/\W/g,'')+Date.now();
    await req("/api/task",{to:"webclaw@node-test",role:"executor",work_key:"WK-2a56b4f1",task_id:tid,instructions:instr});
    let done=false;
    for(let s=0;s<40;s++){ await new Promise(r=>setTimeout(r,1000)); const [c,b]=await req("/api/task-result/"+tid); if(c===200){ const o=JSON.parse(b); console.log(`  ✅ ${label} (${s+1}s, backend=${o.backend}): ${String(o.output).trim().slice(0,130)}`); done=true; break; } }
    if(!done) console.log("  ❌ "+label+" 무응답");
  }
  wc.disconnect(); process.exit(0);
})();
