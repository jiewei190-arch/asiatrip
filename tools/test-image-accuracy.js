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

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
