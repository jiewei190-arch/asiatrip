/* Drives the real geo.js against REAL captured Photon/Wikipedia payloads.
   The browser here has no outbound network, so fetch is stubbed with recorded responses —
   the parsing, filtering, ranking and rendering under test are the shipped code. */
const { chromium } = require('playwright');
const fs = require('fs');
const FIX = JSON.parse(fs.readFileSync(process.env.GEO_FIXTURES || require('path').join(__dirname,'geo-fixtures.json'),'utf8'));
const CASES = ['Bei','Beijing','Hallstatt','Chefchaouen','Hoi An','Banff','Queenstown',
  'Machu Picchu','Patagonia','Bora Bora','Japan','Tuscany','Roma','Munchen','Ho Chi Minh',
  'Jeju Island','Phuket','Cape Town','Interlaken','Positano','Amalfi Coast','NYC'];
(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await b.newContext();
  await ctx.addInitScript(fixtures => {
    window.__FIX = fixtures;
    const real = window.fetch;
    window.fetch = (url, opts) => {
      const u = String(url);
      let key = null;
      if(u.includes('photon.komoot.io/api')){
        const q = decodeURIComponent((u.match(/[?&]q=([^&]*)/) || [])[1] || '');
        key = 'photon:' + q.toLowerCase();
      } else if(u.includes('wikipedia.org') && u.includes('gsrsearch')){
        const q = decodeURIComponent((u.match(/gsrsearch=([^&]*)/) || [])[1] || '');
        key = 'wiki:' + q.toLowerCase();
      }
      if(key && window.__FIX[key]){
        return Promise.resolve({ ok:true, status:200, json:() => Promise.resolve(window.__FIX[key]) });
      }
      if(key) return Promise.resolve({ ok:true, status:200, json:() => Promise.resolve({features:[]}) });
      return real(url, opts);
    };
  }, FIX);
  const p = await ctx.newPage();
  const errs=[]; p.on('pageerror', e=>errs.push(e.message.slice(0,140)));
  await p.goto('http://127.0.0.1:8099/index.html#/', {waitUntil:'load'});
  await p.waitForTimeout(2000);

  let bad = 0;
  for(const q of CASES){
    const r = await p.evaluate(async query => {
      try {
        const res = await geoSearch(query, { limit: 3 });
        return res.map(x => ({ n:x.name, c:x.country, cc:x.countryCode, t:x.typeLabel,
                               flag:x.flag, lat:x.lat, lng:x.lng, dn:x.displayName }));
      } catch(e){ return { error: e.message }; }
    }, q);
    if(r.error || !r.length){ bad++; console.log(`✗ ${q.padEnd(14)} → ${r.error || 'NO RESULTS'}`); continue; }
    const top = r[0];
    const ok = top.n && top.lat != null && top.lng != null;
    if(!ok) bad++;
    console.log(`${ok?'✓':'✗'} ${q.padEnd(14)} → ${top.flag} ${top.n} · ${top.c||'—'} (${top.cc||'--'}) · ${top.t} · ${Number(top.lat).toFixed(2)},${Number(top.lng).toFixed(2)}`);
  }
  console.log(`\nfailures: ${bad}/${CASES.length} · page errors: ${errs.length}`);
  errs.forEach(e=>console.log('  '+e));
  await b.close();
})();
