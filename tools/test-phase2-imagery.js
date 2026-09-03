/* The full Phase 2 list: cities, countries, towns/villages, landmarks, ambiguous pairs.
   Asserts the image is resolved AND that its geographic identity is the right one. */
const fs=require('fs'); const ROOT=require('path').dirname(__dirname);
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
global.window={localStorage:global.localStorage}; global.AbortController=AbortController;
eval(fs.readFileSync(ROOT+'/geo.js','utf8'));
const data=fs.readFileSync(ROOT+'/data.js','utf8');
eval(data.slice(0, data.indexOf("const DESTINATIONS_RAW")));
eval(fs.readFileSync(ROOT+'/imagery.js','utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const CASES = [
  // [query, expected country, group]
  ['Tokyo','Japan','city'], ['Seoul','South Korea','city'], ['Bangkok','Thailand','city'],
  ['New York City','United States','city'],
  ['Japan','Japan','country'], ['Brazil','Brazil','country'], ['Australia','Australia','country'],
  ['Hallstatt','Austria','town'], ['Chefchaouen','Morocco','town'], ['Reine','Norway','village'],
  ['Giethoorn','Netherlands','village'], ['Ronda','Spain','town'],
  ['Paris','France','ambiguous'], ['Paris Texas','United States','ambiguous'],
  ['London','United Kingdom','ambiguous'], ['London Ontario','Canada','ambiguous'],
];
(async()=>{
  let pass=0, fail=0;
  for(const [q, wantCountry, group] of CASES){
    const geo = await geoResolve(q); await sleep(1800);
    if(!geo){ fail++; console.log(`  FAIL ${q.padEnd(15)} no geocode`); continue; }
    const e = {placeId:geo.placeId, name:geo.name, kind:'destination', country:geo.country,
               countryCode:geo.countryCode, region:geo.region, placeType:geo.type,
               lat:geo.lat, lng:geo.lng, __geo:true, id:'gen-'+q.toLowerCase().replace(/\s+/g,'-')};
    let r=null; try{ r = await resolveEntityImage(e); }catch(err){}
    await sleep(1800);
    const countryOk = (geo.country||'').toLowerCase() === wantCountry.toLowerCase();
    const ok = countryOk && !!(r && r.url);
    ok ? pass++ : fail++;
    const f = r&&r.url ? decodeURIComponent(String(r.url).split('/').pop()).replace(/^\d+px-/,'').slice(0,34) : '—';
    console.log(`  ${ok?'PASS':'FAIL'} ${group.padEnd(9)} ${q.padEnd(15)} ${geo.flag} ${String(geo.country||'?').padEnd(15)}`
      + `${r?('['+r.source+']').padEnd(22):'[none]'.padEnd(22)}${f}`
      + (countryOk?'':`  ✗ expected ${wantCountry}`));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
})();
