/* Deliberately hunts for destinations whose fields disagree. Every assertion is about ONE
   destination's identity being internally consistent — the thing that failed when a page
   showed "Seoul Korea" under the caption "Malaysia". */
const fs=require('fs'); const ROOT=require('path').dirname(__dirname);
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
global.window={localStorage:global.localStorage}; global.AbortController=AbortController;
eval(fs.readFileSync(ROOT+'/geo.js','utf8'));
const data=fs.readFileSync(ROOT+'/data.js','utf8');
eval(data.slice(0, data.indexOf("const DESTINATIONS_RAW")));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// name -> the country it MUST resolve to. Ambiguous pairs included on purpose.
const EXPECT = {
  'Seoul':'South Korea', 'Kuala Lumpur':'Malaysia', 'Tokyo':'Japan', 'Beijing':'China',
  'Paris':'France', 'London':'United Kingdom', 'Rome':'Italy', 'Cairo':'Egypt',
  'Cape Town':'South Africa', 'Rio de Janeiro':'Brazil', 'Sydney':'Australia',
  'Queenstown':'New Zealand', 'Santorini':'Greece', 'Bali':'Indonesia',
  'Seoul Korea':'South Korea',       // the exact free-text string from the bug report
  'Paris Texas':'United States',     // the pub-in-Budapest case
};
(async()=>{
  let pass=0, fail=0;
  for(const [q, wantCountry] of Object.entries(EXPECT)){
    const geo = await geoResolve(q); await sleep(2200);
    if(!geo){ fail++; console.log(`  FAIL ${q.padEnd(16)} did not resolve`); continue; }
    const dest = { id:'gen-'+q.toLowerCase().replace(/\s+/g,'-'), name:geo.name,
      country:geo.country, countryCode:geo.countryCode, flag:geo.flag, region:geo.region,
      placeType:geo.type, placeId:geo.placeId, displayName:geo.displayName,
      lat:geo.lat, lng:geo.lng, __geo:true };
    const v = geoValidateDestination(dest);
    const countryOk = (dest.country||'').toLowerCase() === wantCountry.toLowerCase();
    const flagOk = dest.flag === countryFlagEmoji(dest.countryCode);
    const idOk = !!dest.placeId;
    const coordOk = dest.lat != null && dest.lng != null;
    const ok = v.ok && countryOk && flagOk && idOk && coordOk;
    ok ? pass++ : fail++;
    console.log(`  ${ok?'PASS':'FAIL'} ${q.padEnd(16)} ${dest.flag} ${dest.name}, ${dest.country||'—'}`
      + `  id=${String(dest.placeId).slice(0,18)}`
      + (countryOk?'':`  ✗ expected ${wantCountry}`)
      + (v.ok?'':`  ✗ ${v.problems.join('; ')}`));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
})();
