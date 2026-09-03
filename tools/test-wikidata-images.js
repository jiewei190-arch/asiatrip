const fs=require('fs'); const ROOT=require('path').dirname(__dirname);
global.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
global.window={localStorage:global.localStorage};
const data=fs.readFileSync(ROOT+'/data.js','utf8');
eval(data.slice(0, data.indexOf("const DESTINATIONS_RAW")));
eval(fs.readFileSync(ROOT+'/imagery.js','utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Real wikidata ids as OSM tags them. This is the rung that actually fetches the photo.
const CASES=[['Eiffel Tower','Q243'],['Tokyo Tower','Q188534'],['Colosseum','Q10285'],
             ['Sensō-ji','Q206315'],['Marina Bay Sands','Q1140072'],['Machu Picchu','Q676203']];
(async()=>{
  let ok=0;
  for(const [name,qid] of CASES){
    let url=null;
    try{ url = await wikidataImage(qid, 720); }catch(e){}
    const f = url ? decodeURIComponent(String(url).split('/').pop()).replace(/^\d+px-/,'').slice(0,44) : '—';
    if(url) ok++;
    console.log(`  ${url?'✓':'·'} ${name.padEnd(18)} ${qid.padEnd(10)} ${f}`);
    await sleep(1500);
  }
  console.log(`\nwikidata P18 -> Commons thumbnail: ${ok}/${CASES.length}`);
})();
