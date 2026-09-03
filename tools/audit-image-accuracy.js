/* Audits IMAGE ACCURACY, not coverage. For each destination it records which rung of the
   chain answered and which Wikipedia article the photo came from, so a wrong-place image is
   visible rather than counted as a success. */
const fs=require('fs'); const ROOT=require('path').dirname(__dirname);
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
global.window={localStorage:global.localStorage}; global.AbortController=AbortController;
eval(fs.readFileSync(ROOT+'/geo.js','utf8'));
const data=fs.readFileSync(ROOT+'/data.js','utf8');
eval(data.slice(0, data.indexOf("const DESTINATIONS_RAW")));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const P = process.env.PLACES ? process.env.PLACES.split(',') :
 ['Beijing','Kyoto','Hoi An','Samarkand',            // Asia
  'Hallstatt','Positano','Ronda','Reine',            // Europe
  'Chefchaouen','Zanzibar','Nosy Be','Swakopmund',   // Africa
  'Banff','San Miguel de Allende','Vinales',         // N America
  'Ushuaia','Machu Picchu','Paraty',                 // S America
  'Queenstown','Bora Bora','Apia',                   // Oceania
  'Santorini','Tuscany','Patagonia','Victoria'];     // island / region / ambiguous
(async()=>{
  const rows=[];
  for(const q of P){
    const geo=await geoResolve(q); await sleep(2500);
    if(!geo){ rows.push([q,'-','NO GEOCODE','-']); console.log(`  ?    ${q.padEnd(22)} no geocode`); continue; }
    const dest={id:'gen-'+q.toLowerCase().replace(/\s+/g,'-'),name:geo.name,country:geo.country,
                region:geo.region,placeType:geo.type,lat:geo.lat,lng:geo.lng,__geo:true};
    const url=await resolveDestinationPhoto(dest); await sleep(2500);
    const tier=destPhotoTierFor(dest.id)||'none';
    const file=url?decodeURIComponent(String(url).split('/').pop()).replace(/^\d+px-/,'').slice(0,44):'—';
    rows.push([q, `${geo.flag} ${geo.name}, ${geo.country||'?'}`, tier, file]);
    console.log(`  ${(tier==='article'?'✓':tier==='landmark'?'~':'·')} ${q.padEnd(22)} ${(geo.name+', '+(geo.country||'?')).padEnd(28)} [${tier}] ${file}`);
  }
  const byTier=rows.reduce((a,r)=>{a[r[2]]=(a[r[2]]||0)+1;return a},{});
  console.log('\ntiers:', JSON.stringify(byTier));
  console.log('✓ = photo of the destination itself · ~ = a landmark inside it · · = name card');
})();
