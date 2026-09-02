/* Shows what the autocomplete offers for ambiguous names, and flags any two suggestions a
   user could not tell apart.  Q="Paris,Victoria" node tools/test-destination-ambiguity.js */
/* What the autocomplete actually offers for ambiguous names — the shipped geoSearch, live. */
const fs=require('fs'); const ROOT=require('path').dirname(__dirname);
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
global.window={localStorage:global.localStorage}; global.AbortController=AbortController;
eval(fs.readFileSync(ROOT+'/geo.js','utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const Q = process.env.Q ? process.env.Q.split(',') : ['Paris','London','Springfield','Victoria','Bei'];
(async()=>{
  for(const q of Q){
    const rows = await geoSearch(q, { limit: 5 }); await sleep(2500);
    console.log(`\n▸ "${q}"  ->  ${rows.length} suggestion(s)`);
    rows.forEach(r => {
      const ctx = r.context || r.country || '(no context)';
      console.log(`    ${r.flag} ${r.name.padEnd(16)} │ ${ctx.padEnd(42)} │ ${r.typeLabel}`);
    });
    // Does the list let a user tell them apart?
    const labels = rows.map(r => `${r.name}|${r.context}`.toLowerCase());
    const dupes = labels.length - new Set(labels).size;
    if(dupes) console.log(`    ⚠ ${dupes} suggestion(s) indistinguishable from another`);
  }
})();
