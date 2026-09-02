/* Opens a typed-in destination's page exactly as picking a search result does, with REAL
   recorded Photon/Wikipedia payloads, and reports what every image on it actually resolves
   to. This is the test that caught the page being 12/20 generic stock photos. */
/* Drives a real generic-destination page with REAL recorded Wikipedia/Photon payloads and
   reports what every image on the page actually ends up as. */
const { chromium } = require('playwright');
const fs = require('fs');
const FIX = JSON.parse(fs.readFileSync(process.env.GEO_FIXTURES || require('path').join(__dirname,'geo-fixtures.json'),'utf8'));
(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await b.newContext({viewport:{width:1280,height:900}});
  await ctx.addInitScript(fixtures => {
    try{const k='tripflow_state_v1';const s=JSON.parse(localStorage.getItem(k)||'{}');
      s.settings=Object.assign({},s.settings,{onboarded:true});localStorage.setItem(k,JSON.stringify(s));}catch(e){}
    window.__FIX = fixtures; window.__CALLS = [];
    const real = window.fetch;
    window.fetch = (url, opts) => {
      const u = String(url); window.__CALLS.push(u.slice(0,150));
      let key = null;
      if(u.includes('photon.komoot.io/api')) key='photon:'+decodeURIComponent((u.match(/[?&]q=([^&]*)/)||[])[1]||'').toLowerCase();
      else if(u.includes('generator=search') && u.includes('coordinates')) key='wikicand:'+decodeURIComponent((u.match(/gsrsearch=([^&]*)/)||[])[1]||'').replace(/\+/g,' ').toLowerCase();
      // Enrichment (nearby POIs) and the photo fallback both use generator=geosearch; the
      // one carrying extracts is the enrichment call.
      else if(u.includes('generator=geosearch') && u.includes('extracts')) key='wikipois';
      else if(u.includes('generator=geosearch')) key='wikigeo:39.9057|116.3913';
      else if(u.includes('gsrsearch')) key='wiki:'+decodeURIComponent((u.match(/gsrsearch=([^&]*)/)||[])[1]||'').toLowerCase();
      if(key && window.__FIX[key]) return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(window.__FIX[key])});
      if(key) return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({query:{pages:{}}})});
      return real(url, opts);
    };
  }, FIX);
  const p = await ctx.newPage();
  const errs=[]; p.on('pageerror', e=>errs.push(e.message.slice(0,160)));
  await p.goto('http://127.0.0.1:8099/index.html#/', {waitUntil:'load'});
  await p.waitForTimeout(2000);

  // Create Beijing exactly as picking a search result does, then open its page.
  await p.evaluate(async () => {
    const geo = await geoResolve('Beijing');
    window.__geo = geo;
    const d = findDestination(geo.name, geo);
    location.hash = '#/destination/' + encodeURIComponent(d.id);
  });
  await p.waitForTimeout(9000);

  const out = await p.evaluate(() => {
    const dd = DESTINATIONS.find(x => x.id.startsWith('gen-'));
    window.__diag = {
      enriched: dd && dd.__enriched, enriching: dd && dd.__enriching,
      places: PLACES.filter(x=>x.destId===dd.id).map(x=>({n:x.name, s:x.source||'-', t:x.type,
        img:(x.image||'').split('/').slice(-2).join('/').slice(0,40)})),
    };
    const d = DESTINATIONS.find(x => x.id.startsWith('gen-'));
    const imgs = [...document.querySelectorAll('.view:not([hidden]) img, .destHero img, .placeCard img')];
    const kinds = {placeholder:0, category:0, real:0, bundled:0};
    const samples = [];
    imgs.forEach(i => {
      const s = i.currentSrc || i.src || '';
      let kind = 'real';
      if(s.startsWith('data:image/svg')) kind='placeholder';
      else if(s.includes('/images/category/')) kind='category';
      else if(s.includes('/images/')) kind='bundled';
      kinds[kind]++;
      if(samples.length<6) samples.push(kind+' :: '+s.slice(0,72));
    });
    return { dest: d && {name:d.name, country:d.country, lat:d.lat, geo:d.__geo, placeType:d.placeType},
             total: imgs.length, kinds, samples,
             wikiCalls: window.__CALLS.filter(c=>c.includes('wikipedia')).length,
             photonCalls: window.__CALLS.filter(c=>c.includes('photon')).length,
             diag: window.__diag };
  });
  console.log(JSON.stringify(out, null, 1));
  console.log('page errors:', errs.length); errs.forEach(e=>console.log('  '+e));
  await b.close();
})();
