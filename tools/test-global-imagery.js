/* Runs the SHIPPED geo.js + destination-photo chain against the live network and reports how
   many real destinations get a real photograph. Node only shims localStorage; nothing here
   reimplements the app's logic. Pace it: Wikipedia throttles bursts, and a throttled run
   measures the retry logic rather than the coverage.

     node tools/test-global-imagery.js
     PLACES="Kyoto,Lima,Tbilisi" node tools/test-global-imagery.js
*/
const fs=require('fs'); const ROOT=require('path').dirname(__dirname);
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
global.window={localStorage:global.localStorage}; global.AbortController=AbortController;
eval(fs.readFileSync(ROOT+'/geo.js','utf8'));
const data=fs.readFileSync(ROOT+'/data.js','utf8');
eval(data.slice(0, data.indexOf("/* ---- Geocoding via OpenStreetMap Nominatim")));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// One per continent plus the awkward cases, paced like a real user rather than a scraper.
// One per continent plus the awkward cases: a vast region, a tiny Arctic village, an island
// with almost no articles, a coast OSM does not carry as a place.
const P = process.env.PLACES ? process.env.PLACES.split(',') :
  ['Beijing','Chefchaouen','Banff','Queenstown','Reine','Nosy Be','Socotra',
   'Amalfi Coast','Machu Picchu','Zanzibar','Tuscany','Patagonia'];
(async()=>{
  let ok=0; const bad=[];
  for(const q of P){
    const geo=await geoResolve(q); await sleep(4000);
    if(!geo){ bad.push(q+' (geo)'); console.log(`  MISS ${q.padEnd(16)} no geocode`); continue; }
    const dest={id:'gen-'+q.toLowerCase().replace(/\s+/g,'-'),name:geo.name,country:geo.country,
                region:geo.region,placeType:geo.type,lat:geo.lat,lng:geo.lng,__geo:true};
    const url=await resolveDestinationPhoto(dest); await sleep(4000);
    if(url){ ok++; console.log(`  ok   ${q.padEnd(16)} ${geo.flag} ${geo.name.padEnd(20)} ${decodeURIComponent(String(url).split('/').pop()).slice(0,40)}`); }
    else { bad.push(q); console.log(`  MISS ${q.padEnd(16)} ${geo.name}`); }
  }
  console.log(`\ncoverage: ${ok}/${P.length} = ${Math.round(100*ok/P.length)}%`);
  if(bad.length) console.log('misses:', bad.join(', '));
})();
