/* Runs the SHIPPED resolver against real entities on the live network. */
const fs=require('fs'); const ROOT=require('path').dirname(__dirname);
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
global.window={localStorage:global.localStorage}; global.AbortController=AbortController;
eval(fs.readFileSync(ROOT+'/geo.js','utf8'));
const data=fs.readFileSync(ROOT+'/data.js','utf8');
eval(data.slice(0, data.indexOf("const DESTINATIONS_RAW")));
eval(fs.readFileSync(ROOT+'/imagery.js','utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// Named landmarks: the case OSM tags genuinely solve.
const ENTITIES = [
  {name:'Sensō-ji',        kind:'attraction', lat:35.7148, lng:139.7967,country:'Japan'},
  {name:'Shibuya Sky',     kind:'attraction', lat:35.6580, lng:139.7016,country:'Japan'},
  {name:'Louvre',          kind:'attraction', lat:48.8606, lng:2.3376,  country:'France'},
  {name:'Sagrada Familia', kind:'attraction', lat:41.4036, lng:2.1744,  country:'Spain'},
  {name:'Eiffel Tower',   kind:'attraction', lat:48.8584, lng:2.2945,  country:'France'},
  {name:'Tokyo Tower',    kind:'attraction', lat:35.6586, lng:139.7454,country:'Japan'},
  {name:'Colosseum',      kind:'attraction', lat:41.8902, lng:12.4922, country:'Italy'},
  {name:'Sensō-ji',       kind:'attraction', lat:35.7148, lng:139.7967,country:'Japan'},
  {name:'Marina Bay Sands',kind:'hotel',     lat:1.2834,  lng:103.8607,country:'Singapore'},
];
(async()=>{
  for(const e of ENTITIES){
    e.placeId = 'test:'+e.name.toLowerCase().replace(/\s+/g,'-');
    let r=null;
    try { r = await resolveEntityImage(e); } catch(err){ console.log('  ERR', err.message); }
    const f = r && r.url ? decodeURIComponent(String(r.url).split('/').pop()).replace(/^\d+px-/,'').slice(0,46) : '—';
    console.log(`  ${r?'✓':'·'} ${e.name.padEnd(18)} [${r?r.source:'none'}${r?' '+r.confidence:''}]`.padEnd(48) + f);
    await sleep(2000);
  }
})();
