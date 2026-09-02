const { chromium } = require('playwright');
const fs=require('fs');
const HASH={}; fs.readFileSync(process.env.TRIPFLOW_HASHES || 'hashes.tsv','utf8').trim().split('\n').forEach(l=>{const[k,v]=l.split('\t');HASH[k]=v;});
const DESTS = ['tokyo','paris','bali','santorini','new-york','rome','bangkok','barcelona','queenstown','reykjavik','ljubljana','marrakech'];
(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await b.newContext({viewport:{width:1440,height:950}});
  await ctx.addInitScript(() => { try{ const k='tripflow_state_v1'; const s=JSON.parse(localStorage.getItem(k)||'{}');
    s.settings=Object.assign({},s.settings,{onboarded:true}); localStorage.setItem(k,JSON.stringify(s)); }catch(e){} });
  const p = await ctx.newPage();
  let worst = 0, worstWhere = '';
  for(const d of DESTS){
    await p.goto('http://127.0.0.1:8099/index.html#/destination/'+d, {waitUntil:'load'});
    await p.waitForTimeout(1800);
    const all = {};                     // src -> count, across every tab of this destination
    for(const label of ['Things To Do','Restaurants','Hotels']){
      await p.evaluate(l=>{ const t=[...document.querySelectorAll('.tab,[data-tab]')]
        .find(e=>e.textContent.trim()===l); if(t) t.click(); }, label);
      await p.waitForTimeout(900);
      const srcs = await p.evaluate(()=>[...document.querySelectorAll('.placeCard img')]
        .map(i=>(i.currentSrc||i.src||'').split('/').slice(-2).join('/')));
      srcs.forEach(s=>{ const k=HASH[s]||s; (all[k]=all[k]||[]).push(s); });
    }
    const total = Object.values(all).reduce((a,b)=>a+b.length,0);
    const dups = Object.entries(all).filter(([,v])=>v.length>1).sort((a,b)=>b[1].length-a[1].length);
    const maxRep = dups.length ? dups[0][1].length : 1;
    if(maxRep > worst){ worst = maxRep; worstWhere = d; }
    console.log(`${d.padEnd(11)} places=${String(total).padStart(2)} distinct=${String(Object.keys(all).length).padStart(2)}  ` +
      (dups.length ? 'REPEATS ' + dups.map(([,v])=>v.join('=')).join('  |  ') : 'all unique'));
  }
  console.log(`\nworst repetition: ×${worst}` + (worstWhere?` (${worstWhere})`:''));
  await b.close();
})();
