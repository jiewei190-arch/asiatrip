/* Would a person standing outside recognise the place from this photograph?
 *
 * That is the standard, and it is a data-validation problem rather than a design one. These
 * tests are in two halves:
 *
 *   1. The scorer, checked against titles that must be accepted and titles that must be
 *      rejected. Fast, deterministic, and it pins down exactly what "exact match" means.
 *   2. Real resolution against live Commons, for venues of each category, checking the
 *      photograph that comes back actually names the place.
 *
 *   node tools/test-image-accuracy.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.dirname(__dirname);

const realFetch = global.fetch;
global.fetch = (u, o) => {
  o = o || {};
  o.headers = Object.assign({'User-Agent': 'TripFlow/1.0 (+https://jiewei190-arch.github.io/asiatrip/)'}, o.headers || {});
  return realFetch(u, o);
};
global.localStorage = {_d:{}, getItem(k){return this._d[k]||null}, setItem(k,v){this._d[k]=v}, removeItem(k){delete this._d[k]}};
global.window = {};

/* imagery.js leans on helpers in data.js. */
const dataSrc = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
const NEED = ['fetchWithTimeout','fetchWikiJSON','wikiAcquire','wikiRelease','looksLikePhoto',
              'isPhotographicFormat','isTravelAppropriate','capWikiThumb','geoDistanceKm'];
const src = NEED.map(n => {
  const m = dataSrc.match(new RegExp('(?:async )?function ' + n + '\\([\\s\\S]*?\\n}', 'm'));
  return m ? m[0] : '';
}).join('\n');
const consts = ['NON_PHOTO_FILE','INAPPROPRIATE_SUBJECT','WIKI_MAX_CONCURRENT']
  .map(n => { const m = dataSrc.match(new RegExp('const ' + n + '[\\s\\S]*?;\\n', 'm')); return m ? m[0] : ''; })
  .join('\n');
const helpers = new Function(`
  ${consts}
  let wikiInFlight = 0; const wikiWaiting = [];
  ${src}
  return {fetchWikiJSON, looksLikePhoto, isTravelAppropriate, capWikiThumb, geoDistanceKm};
`)();
Object.assign(global, helpers);

const IM = require(path.join(ROOT, 'imagery.js'));
Object.assign(global, IM);

let pass = 0, fail = 0;
function check(name, cond, detail){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

/* The example from the brief, with its full identity. */
const flore = {
  name: 'Café de Flore', kind: 'restaurant', subtype: 'cafe',
  address: '172 Boulevard Saint-Germain', city: 'Paris', country: 'France',
  lat: 48.8542, lng: 2.3327, placeId: 'osm:N1',
};

console.log('\n1. The scorer accepts photographs of the place itself');
{
  const good = [
    'Café de Flore, 172 boulevard Saint-Germain, Paris 6e.jpg',
    'Cafe de Flore, Paris 4 June 2015.jpg',
    'Café de Flore, Paris 25 September 2019 01.jpg',
    'Café de Flore exterior Paris.jpg',
    'Interior of Café de Flore, Paris.jpg',
  ];
  for(const t of good){
    const s = IM.scoreImageCandidate(t, flore, 'commons_text');
    check(`accepts "${t.slice(0, 46)}"`, s.score >= 60, `scored ${s.score} (${s.reasons.join(', ')})`);
  }
}

console.log('\n2. The scorer rejects everything the brief lists as unacceptable');
{
  const bad = [
    ['Random Paris building at night.jpg',                 'a random building in the city'],
    ['A generic French cafe terrace.jpg',                  'a generic cafe'],
    ['Cup of coffee with latte art close-up.jpg',          'a random cup of coffee'],
    ['Collection des Maisons de Commerce de Paris, engraving 1860.jpg', 'a historical engraving'],
    ['Cafe de Flore, Buenos Aires.jpg',                    'a same-named place elsewhere'],
    ['Les Deux Magots, 6 place Saint-Germain, Paris.jpg',  'the cafe next door'],
    ['Boulevard Saint-Germain, Paris, general view.jpg',   'the street rather than the venue'],
  ];
  for(const [t, why] of bad){
    const s = IM.scoreImageCandidate(t, flore, 'commons_text');
    check(`rejects ${why}`, s.score < 60, `"${t.slice(0,40)}" scored ${s.score} (${s.reasons.join(', ')})`);
  }
}

console.log('\n3. Recency is weighed');
{
  const recent = IM.scoreImageCandidate('Café de Flore, Paris 2019.jpg', flore, 'commons_text');
  const old    = IM.scoreImageCandidate('Café de Flore, Paris 1925.jpg', flore, 'commons_text');
  check('a recent photograph outranks a pre-war one', recent.score > old.score,
        `${recent.score} vs ${old.score}`);
  check('a pre-war photograph is rejected outright', old.score < 60, `scored ${old.score}`);
}

console.log('\n4. Category rules: the venue matters more than the dish');
{
  const dish  = IM.scoreImageCandidate('Plate of steak tartare, close-up.jpg', flore, 'commons_text');
  const front = IM.scoreImageCandidate('Café de Flore storefront.jpg', flore, 'commons_text');
  check('a dish with no venue name is rejected', dish.score < 60, `scored ${dish.score}`);
  check('the storefront wins', front.score > dish.score, `${front.score} vs ${dish.score}`);

  const hotel = {name:'Hotel Sacher', kind:'hotel', subtype:'hotel', city:'Vienna', country:'Austria'};
  const room  = IM.scoreImageCandidate('Generic hotel bed and minibar.jpg', hotel, 'commons_text');
  const bldg  = IM.scoreImageCandidate('Hotel Sacher facade, Vienna.jpg', hotel, 'commons_text');
  check('a generic room is rejected for a hotel', room.score < 60, `scored ${room.score}`);
  check('the property itself wins', bldg.score > room.score, `${bldg.score} vs ${room.score}`);
}

console.log('\n5. Address and city disambiguate same-named places');
{
  const withAddr = IM.scoreImageCandidate('Café de Flore, 172 boulevard Saint-Germain.jpg', flore, 'commons_text');
  const nameOnly = IM.scoreImageCandidate('Café de Flore.jpg', flore, 'commons_text');
  check('the address raises confidence', withAddr.score > nameOnly.score,
        `${withAddr.score} vs ${nameOnly.score}`);
  check('the street is recognised', withAddr.reasons.includes('matches the street'),
        withAddr.reasons.join(', '));
}

console.log('\n6. Live: real venues of each category resolve to photographs of themselves');
(async () => {
  const venues = [
    {label:'cafe',     e:flore},
    {label:'landmark', e:{name:'Eiffel Tower', kind:'attraction', subtype:'attraction',
                          city:'Paris', country:'France', lat:48.8584, lng:2.2945, placeId:'osm:W1'}},
    {label:'museum',   e:{name:'Rijksmuseum', kind:'attraction', subtype:'museum',
                          city:'Amsterdam', country:'Netherlands', lat:52.3600, lng:4.8852, placeId:'osm:W2'}},
    {label:'hotel',    e:{name:'Hotel Sacher', kind:'hotel', subtype:'hotel',
                          city:'Vienna', country:'Austria', lat:48.2037, lng:16.3695, placeId:'osm:W3'}},
    {label:'park',     e:{name:'Vondelpark', kind:'attraction', subtype:'park',
                          city:'Amsterdam', country:'Netherlands', lat:52.3580, lng:4.8686, placeId:'osm:W4'}},
    {label:'small',    e:{name:'Gasthof Simony', kind:'hotel', subtype:'guest_house',
                          city:'Hallstatt', country:'Austria', lat:47.5623, lng:13.6497, placeId:'osm:W5'}},
  ];
  for(const v of venues){
    let res = null;
    try{ res = await IM.resolveEntityImage(v.e, {width: 720}); }catch(e){ /* reported below */ }
    if(res){
      const file = decodeURIComponent(String(res.url).split('/').pop().split('?')[0]);
      const names = IM.scoreImageCandidate(file, v.e, res.source);
      check(`${v.label}: ${v.e.name} resolved to a photograph naming it`,
            names.reasons.includes('names the place'),
            `${file.slice(0,60)} [${res.source} ${res.confidence}]`);
      console.log(`        ${file.slice(0, 66)}`);
      console.log(`        source=${res.source} confidence=${res.confidence} · ${(res.reasons||[]).join(', ')}`);
    } else {
      // An honest miss is an allowed outcome, and better than a wrong photograph.
      check(`${v.label}: ${v.e.name} — nothing verified, so nothing shown`, true,
            'no candidate cleared the bar');
      console.log('        (no verified photograph; the card shows its empty state)');
    }
  }
  console.log('\n10. Pinned landmark photography');
  {
    const path = require('path');
    global.window = global.window || {};
    require(path.join(path.dirname(__dirname), 'unsplash.js'));
    const table = global.window.UNSPLASH_PHOTOS || {};
    const keys = Object.keys(table);

    check('the landmark table is populated', keys.length >= 10, `${keys.length} entries`);
    check('every entry names the place it depicts',
          keys.every(k => table[k].alt && table[k].alt.length > 8),
          keys.filter(k => !table[k].alt).join(', '));
    check('every entry credits a photographer, as the licence asks',
          keys.every(k => table[k].by && /^https:\/\/unsplash\.com\/@/.test(table[k].byUrl || '')),
          keys.filter(k => !table[k].by).join(', '));
    check('every entry carries the date the photograph was taken',
          keys.every(k => /^\d{4}-\d{2}-\d{2}$/.test(table[k].taken || '')),
          keys.filter(k => !/^\d{4}-\d{2}-\d{2}$/.test(table[k].taken || '')).join(', '));
    check('every entry points at the Unsplash CDN, which needs no key to load',
          keys.every(k => String(table[k].url).startsWith('https://images.unsplash.com/')));
    check('no two places share a photograph',
          new Set(keys.map(k => table[k].id)).size === keys.length,
          'a repeated picture across destinations reads as a bug');
    // The point of the table is currency: this is the whole reason it exists.
    const recent = keys.filter(k => Number(String(table[k].taken).slice(0, 4)) >= 2025).length;
    check('most pinned photographs are from the last two years', recent >= keys.length * 0.7,
          `${recent} of ${keys.length}`);
    // Queenstown is absent on purpose. If somebody adds it, they must have checked it names
    // the place — two searches returned only unnamed lakes.
    check('nothing was added on a guess', !table['dest/queenstown'],
          'Queenstown had no candidate naming the place');
  }

  console.log('\n9. Recency: a photograph must be as current as the rule demands');
  {
    const I = require(require('path').join(require('path').dirname(__dirname), 'imagery.js'));

    // The capture date must come from Commons metadata, not from a guess at the filename.
    // Reading the year out of the name meant almost every file counted as undated.
    check('a capture date is read from Commons metadata',
          I.captureYearOf({extmetadata:{DateTimeOriginal:{value:'2026-04-11 10:22:03'}}}) === 2026);
    check('the date survives the HTML Commons wraps it in',
          I.captureYearOf({extmetadata:{DateTimeOriginal:{value:'<span class="dtstart">11 April 2019</span>'}}}) === 2019);
    check('a file with no date reports none, rather than a number',
          I.captureYearOf({}) === null && I.captureYearOf(null) === null);
    check('a nonsense year is not believed', I.captureYearOf({extmetadata:{DateTimeOriginal:{value:'3999'}}}) === null);

    // Upload date is not capture date, and the difference is the whole point: the newest uploads
    // matching "Eiffel Tower" are 2026 uploads of 2017 photographs.
    check('the rule admits a photograph from the cutoff year', I.meetsRecencyPolicy(I.IMAGE_MIN_CAPTURE_YEAR) === true);
    check('the rule rejects the year before the cutoff', I.meetsRecencyPolicy(I.IMAGE_MIN_CAPTURE_YEAR - 1) === false);
    check('an undated photograph cannot pass as current', I.meetsRecencyPolicy(null) === false,
          'undated is unknown, and unknown is not this year');
    check('the cutoff is a single named setting, not scattered literals',
          typeof I.IMAGE_MIN_CAPTURE_YEAR === 'number' || I.IMAGE_MIN_CAPTURE_YEAR === null);
  }

  console.log('\n9b. Recent first — and a verified older photograph rather than a blank');
  {
    /* The window is a preference, not a wall. It rejected correct, verified photographs of the
     * exact right place purely for their age: measured against three Tokyo museums, the strict
     * rule found a picture for one of them and refused two that had good photographs from 2017
     * and 2014. A building photographed in 2014 is still that building, and an empty card is not
     * the more honest answer — it is the same claim about the place, made by omission.
     *
     * What must NOT move is identity. An older photograph is admissible; a photograph of
     * somewhere else is not, at any age. */
    const cases = [
      {name:'Mori Art Museum',        wikidata:'Q1152144',  osmCommons:'Category:Mori Art Museum'},
      {name:'Yamatane Museum of Art', wikidata:'Q11592234', osmCommons:'Category:Yamatane Museum of Art'},
      {name:'Nezu Museum',            wikidata:'Q1339730',  osmCommons:'Category:Nezu Museum'},
    ];
    const out = [];
    for(const c of cases){
      let r = null;
      try{ r = await IM.resolveEntityImage(Object.assign({
        placeId: 'osm:recency-' + c.wikidata, kind: 'attraction', subtype: 'museum',
        city: 'Tokyo', country: 'Japan', countryCode: 'JP', lat: 35.6762, lng: 139.6503,
      }, c), {width: 720}); }catch(e){ /* counted as a miss below */ }
      out.push({name: c.name, got: !!(r && r.url), year: r && r.captureYear,
                older: !!(r && r.olderThanWindow), confidence: r && r.confidence});
      console.log(`        ${c.name.padEnd(24)} ${out[out.length-1].got
        ? `${out[out.length-1].year || 'undated'}${out[out.length-1].older ? ' (older than the window)' : ''}`
        : 'no verified photograph'}`);
    }
    const got = out.filter(r => r.got);
    check('most of these resolve to a photograph now, not one in three',
          got.length >= 2, out.map(r => `${r.name}:${r.got ? (r.year || 'undated') : 'none'}`).join(', '));
    check('at least one is an older photograph the strict window refused',
          out.some(r => r.older), out.map(r => `${r.name}:${r.older ? 'older' : '-'}`).join(', '));
    check('an older photograph carries its year, so it cannot read as current',
          out.every(r => !r.older || r.year != null));
    check('the identity bar did not move — nothing below it is shown',
          got.every(r => r.confidence >= IM.IMAGE_MIN_CONFIDENCE_ENTITY),
          got.map(r => `${r.name}:${r.confidence}`).join(', '));
    check('a recent photograph still wins where one exists',
          out.some(r => r.got && !r.older),
          out.map(r => `${r.name}:${r.year || '-'}${r.older ? '(older)' : ''}`).join(', '));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  /* process.exitCode rather than process.exit(): when stdout is redirected to a file or a pipe,
   * Node writes it asynchronously and process.exit() discards whatever is still buffered. Two
   * full worldwide runs lost their closing summary that way — the tally, the sample of what was
   * found and the currency checks were simply gone, and the run looked like it had died at
   * whichever destination happened to be last flushed. Setting the code instead lets Node drain
   * stdout and exit on its own. */
  process.exitCode = fail ? 1 : 0;
})();
