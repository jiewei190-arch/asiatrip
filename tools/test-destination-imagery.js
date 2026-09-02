/* Does the new Commons rung IMPROVE or REGRESS destination imagery vs the Phase 1 path? */
const fs=require('fs'); const ROOT=require('path').dirname(__dirname);
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
global.window={localStorage:global.localStorage}; global.AbortController=AbortController;
eval(fs.readFileSync(ROOT+'/geo.js','utf8'));
const data=fs.readFileSync(ROOT+'/data.js','utf8');
eval(data.slice(0, data.indexOf("const DESTINATIONS_RAW")));
eval(fs.readFileSync(ROOT+'/imagery.js','utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const P = process.env.PLACES ? process.env.PLACES.split(',') :
  ['Tokyo','Seoul','Paris','Bangkok','Japan','France','Hallstatt','Chefchaouen','Reine'];
(async()=>{
  for(const q of P){
    const geo = await geoResolve(q); await sleep(1800);
    if(!geo){ console.log(`  ?  ${q.padEnd(14)} no geocode`); continue; }
    const e = {placeId:geo.placeId, name:geo.name, kind:'destination', country:geo.country,
               countryCode:geo.countryCode, region:geo.region, placeType:geo.type,
               lat:geo.lat, lng:geo.lng, __geo:true, id:'gen-'+q.toLowerCase()};
    let r=null; try{ r = await resolveEntityImage(e); }catch(err){}
    await sleep(1800);
    const f = r&&r.url ? decodeURIComponent(String(r.url).split('/').pop()).replace(/^\d+px-/,'').slice(0,44) : '—';
    console.log(`  ${r?'✓':'·'} ${q.padEnd(14)} ${geo.flag} ${String(geo.name).padEnd(14)} [${r?r.source+' '+r.confidence:'none'}]`.padEnd(66)+f);
  }
})();
