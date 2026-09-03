/* End-to-end check of Phase 2 across the world.
 *
 * For each destination: geocode it, confirm the country, discover real places to eat and stay,
 * confirm every one of them passes the containment rules, and confirm the local currency is
 * right and convertible. Nothing here is mocked — it hits the same keyless services the browser
 * does, so a failure means a traveller would have seen it.
 *
 *   node tools/test-global-places.js            # the standard spread
 *   ONLY="Seoul,Tokyo" node tools/test-global-places.js
 *
 * Note on rate limits: the public Overpass mirrors throttle, and a long run can trip that. A
 * destination reported as SLOW/EMPTY here is worth re-running on its own before believing it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);

/* Node sends no User-Agent by default and the Overpass mirrors reject that with a 429. A browser
 * always sends one, so adding it here makes the harness behave like the thing it stands in for
 * rather than measuring an artefact of Node. */
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  opts = opts || {};
  opts.headers = Object.assign(
    {'User-Agent': 'TripFlow/1.0 (+https://jiewei190-arch.github.io/asiatrip/)'}, opts.headers || {});
  return realFetch(url, opts);
};
global.AbortController = AbortController;
global.localStorage = {
  _d: {}, getItem(k){ return this._d[k] || null; },
  setItem(k, v){ this._d[k] = v; }, removeItem(k){ delete this._d[k]; },
};
global.window = { dispatchEvent(){} };
global.CustomEvent = function(n, o){ this.type = n; Object.assign(this, o); };

/* Load the geographic helpers out of data.js without executing the whole catalogue. */
const dataSrc = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
const DEST_RADIUS_KM = eval('(' + dataSrc.match(/const DEST_RADIUS_KM = (\{[\s\S]*?\});/)[1] + ')');
global.DEST_RADIUS_KM = DEST_RADIUS_KM;
for(const fn of ['geoDistanceKm', 'hasVerifiedGeo', 'destinationRadiusKm', 'placeWithinDestination']){
  const src = dataSrc.match(new RegExp('function ' + fn + '\\([\\s\\S]*?\\n}', 'm'))[0];
  eval(src);
  global[fn] = eval(fn);
}

const Places = require(path.join(ROOT, 'places.js'));
const CurrencyData = require(path.join(ROOT, 'currency-data.js'));
Object.assign(global, CurrencyData);
const Currency = require(path.join(ROOT, 'currency.js'));

/* ---------------- the spread ---------------- */

const CASES = [
  {q:'Seoul',                  kind:'city',         country:'South Korea', currency:'KRW'},
  {q:'Tokyo',                  kind:'city',         country:'Japan',       currency:'JPY'},
  {q:'Paris',                  kind:'city',         country:'France',      currency:'EUR'},
  {q:'Marrakesh',              kind:'city',         country:'Morocco',     currency:'MAD'},
  {q:'Hanoi',                  kind:'city',         country:'Vietnam',     currency:'VND'},
  {q:'Mexico City',            kind:'city',         country:'Mexico',      currency:'MXN'},
  {q:'Reykjavik',              kind:'city',         country:'Iceland',     currency:'ISK'},
  {q:'Hallstatt',              kind:'village/town', country:'Austria',     currency:'EUR'},
  {q:'Giethoorn',              kind:'village',      country:'Netherlands', currency:'EUR'},
  {q:'Reine, Norway',          kind:'village',      country:'Norway',      currency:'NOK'},
  {q:'Queenstown, New Zealand',kind:'town',         country:'New Zealand', currency:'NZD'},
  {q:'Zanzibar',               kind:'island',       country:'Tanzania',    currency:'TZS'},
  {q:'Paris, Texas',           kind:'ambiguous',    country:'United States', currency:'USD'},
  {q:'London, Ontario',        kind:'ambiguous',    country:'Canada',      currency:'CAD'},

  /* The spread asked for in the foundation brief: major cities, mid-size cities, islands,
     whole countries, and places nobody optimises for. */
  {q:'New York City',          kind:'city',         country:'United States', currency:'USD'},
  {q:'London',                 kind:'city',         country:'United Kingdom', currency:'GBP'},
  {q:'Chengdu',                kind:'city',         country:'China',       currency:'CNY'},
  {q:'Kyoto',                  kind:'city',         country:'Japan',       currency:'JPY'},
  {q:'Porto',                  kind:'city',         country:'Portugal',    currency:'EUR'},
  {q:'Medellin',               kind:'city',         country:'Colombia',    currency:'COP'},
  {q:'Bali',                   kind:'island',       country:'Indonesia',   currency:'IDR'},
  {q:'Santorini',              kind:'island',       country:'Greece',      currency:'EUR'},
  {q:'Madeira',                kind:'island',       country:'Portugal',    currency:'EUR'},
  {q:'Cape Verde',             kind:'country',      country:'Cabo Verde',  currency:'CVE'},
  {q:'Morocco',                kind:'country',      country:'Morocco',     currency:'MAD'},
  {q:'Indonesia',              kind:'country',      country:'Indonesia',   currency:'IDR'},
  {q:'Ushuaia',                kind:'remote town',  country:'Argentina',   currency:'ARS'},
  {q:'Longyearbyen',           kind:'remote town',  country:'Svalbard and Jan Mayen', currency:'NOK'},
];

/* ---------------- geocoding (the same keyless source geo.js uses) ---------------- */

/** Photon throttles a long run, and a throttled request looks identical to "this place does not
 *  exist" unless you retry. Six destinations in the first full run reported as ungeocodable and
 *  every one of them resolved first try on its own, so the failures were mine, not the data's. */
async function geocodeOnce(query){
  const url = `https://photon.komoot.io/api?q=${encodeURIComponent(query)}&limit=8&lang=en`;
  const res = await fetch(url, {headers:{'Accept':'application/json'}});
  if(!res.ok) throw new Error('geocode http ' + res.status);
  return res.json();
}

async function geocode(query){
  let json = null, lastErr = null;
  for(let attempt = 0; attempt < 3; attempt++){
    if(attempt) await new Promise(r => setTimeout(r, 1500 * attempt));
    try{ json = await geocodeOnce(query); lastErr = null; break; }
    catch(e){ lastErr = e; }
  }
  if(lastErr) throw lastErr;
  const PLACE_TYPES = new Set(['city','town','village','hamlet','state','region','county',
                               'country','island','municipality','locality','district','suburb']);
  const feats = (json.features || []).filter(f => {
    const p = f.properties || {};
    return PLACE_TYPES.has(p.osm_value) || PLACE_TYPES.has(p.type);
  });
  const f = feats[0] || (json.features || [])[0];
  if(!f) return null;
  const p = f.properties || {}, c = (f.geometry || {}).coordinates || [];
  const ext = Array.isArray(p.extent) && p.extent.length === 4 ? p.extent : null;
  return {
    name: p.name, country: p.country, countryCode: (p.countrycode || '').toUpperCase(),
    lat: c[1], lng: c[0], placeType: p.osm_value || p.type, geoVerified: true,
    id: 'test-' + (p.osm_id || p.name), placeId: `osm:${p.osm_type || 'X'}${p.osm_id || 0}`,
    bbox: ext ? {minLng:Math.min(ext[0],ext[2]), maxLng:Math.max(ext[0],ext[2]),
                 minLat:Math.min(ext[1],ext[3]), maxLat:Math.max(ext[1],ext[3])} : null,
  };
}

/* ---------------- run ---------------- */

let pass = 0, fail = 0, warn = 0;
const notes = [];

function mark(ok, soft){
  if(ok) { pass++; return ' ok '; }
  if(soft){ warn++; return 'WARN'; }
  fail++; return 'FAIL';
}

(async () => {
  // Split on "|" — several destination names contain a comma ("Reine, Norway").
  const only = process.env.ONLY ? process.env.ONLY.split('|').map(s=>s.trim().toLowerCase()) : null;
  const cases = only ? CASES.filter(c => only.includes(c.q.toLowerCase())) : CASES;

  console.log('\nquery                  geo   country            cur   eat   stay  bounds  notes');
  console.log('-'.repeat(96));

  for(const c of cases){
    // Swallowing the reason here cost me an hour chasing a "could not geocode" that turned out
    // to be a rate limit. Say what actually happened.
    let dest = null, geoErr = '';
    try{ dest = await geocode(c.q); }catch(e){ geoErr = e.message || String(e); }

    if(!dest || !hasVerifiedGeo(dest)){
      fail++;
      const why = geoErr ? geoErr
        : !dest ? 'no result matched'
        : `unverified: lat=${dest.lat} lng=${dest.lng}`;
      console.log(`${c.q.padEnd(22)} FAIL  (geocode: ${why})`);
      continue;
    }

    const countryOk = (dest.country || '').toLowerCase() === c.country.toLowerCase();
    const detected = Currency.currencyForDestination(dest);
    const currencyOk = detected === c.currency;

    const eat  = await Places.discoverPlaces(dest, 'restaurant');
    const stay = await Places.discoverPlaces(dest, 'hotel');

    // Every discovered place must pass the same containment rules the app applies.
    const all = eat.concat(stay);
    const outside = all.filter(p => !placeWithinDestination(p, dest));
    const unnamed = all.filter(p => !p.name);
    const noId    = all.filter(p => !/^osm:/.test(p.placeId || ''));
    const fakeNum = all.filter(p => p.rating != null || p.reviews != null);
    // Duplicates mean the SAME entity listed twice within one category. A place appearing under
    // both food and stays is not a duplicate: OSM tags a hotel-with-restaurant as both, and
    // showing it in each list is correct. Giethoorn's De Kruumte is exactly that.
    const dupeIn = list => list.length - new Set(list.map(p=>p.placeId)).size;
    const dupes   = dupeIn(eat) + dupeIn(stay);
    const dualUse = stay.filter(p => eat.some(e => e.placeId === p.placeId)).length;

    const boundsOk = outside.length === 0 && unnamed.length === 0 && noId.length === 0
                     && fakeNum.length === 0 && dupes === 0;

    // Empty is a legitimate answer for a small village; it is only a problem in a city.
    const eatSoft  = !/city/.test(c.kind);
    const staySoft = true;   // accommodation is mapped far more thinly than food, everywhere

    const row = [
      c.q.padEnd(22),
      mark(true).padEnd(5),
      (mark(countryOk) + ' ' + (dest.country || '?')).padEnd(19),
      (mark(currencyOk) + ' ' + (detected || '?')).padEnd(10),
      (mark(eat.length > 0, eatSoft) + String(eat.length).padStart(4)).padEnd(6),
      (mark(stay.length > 0, staySoft) + String(stay.length).padStart(4)).padEnd(6),
      mark(boundsOk).padEnd(7),
    ].join(' ');

    const why = [];
    if(!countryOk) why.push(`expected ${c.country}`);
    if(!currencyOk) why.push(`expected ${c.currency}`);
    if(outside.length) why.push(`${outside.length} out of bounds`);
    if(fakeNum.length) why.push(`${fakeNum.length} carry invented ratings`);
    if(dupes) why.push(`${dupes} duplicates within a category`);
    if(dualUse) why.push(`${dualUse} hotel${dualUse===1?'':'s'} with a restaurant (listed in both, correctly)`);
    if(!eat.length) why.push('no food mapped');
    if(!stay.length) why.push('no stays mapped');
    console.log(row + (why.length ? '  ' + why.join('; ') : ''));

    if(eat.length){
      const withCuisine = eat.filter(p=>p.cuisine && p.cuisine !== p.category).length;
      const withHours = eat.filter(p=>p.hours).length;
      notes.push(`${c.q}: ${eat.length} eat (${withCuisine} with cuisine, ${withHours} with hours), ` +
                 `${stay.length} stay — e.g. ${eat.slice(0,3).map(p=>p.name).join(', ')}`);
    }
  }

  console.log('\nSample of what was found:');
  notes.forEach(n => console.log('  ' + n));

  // Currency conversion is separate from discovery and should be checked on its own.
  console.log('\nCurrency conversion:');
  for(const [amt, from, to] of [[12000,'KRW','USD'], [250000,'VND','GBP'], [100,'MAD','EUR'], [50,'USD','JPY']]){
    const r = await Currency.convertCurrency(amt, from, to);
    const ok = r && isFinite(r.amount);
    console.log(`  ${mark(!!ok)} ${Currency.formatMoney(amt, from)} -> ` +
                (ok ? Currency.formatMoney(r.amount, to) : 'no rate'));
  }

  console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings (thin map data, not defects)\n`);
  process.exit(fail ? 1 : 0);
})();
