/* Regression tests for the geographic-integrity rules.
 *
 * The bug these exist to prevent: a destination created without a verified geocode used to seed
 * its coordinates from a hash of its own name. "Seoul Korea" hashed to 36.859, -5.346 — a
 * hillside near Zahara de la Sierra in Andalusia — and the destination map, the day route and
 * every generated place then rendered Spain with complete confidence. The screenshot that
 * started this showed a Seoul itinerary drawn across southern Spain.
 *
 *   node tools/test-geo-integrity.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const dataSrc = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');

// Pull the geographic helpers out of data.js without executing the whole catalogue.
const ctx = {};
for(const fn of ['geoDistanceKm', 'hasVerifiedGeo', 'destinationRadiusKm', 'placeWithinDestination', 'seededRandom']){
  const m = dataSrc.match(new RegExp('function ' + fn + '\\([\\s\\S]*?\\n}', 'm'));
  if(!m) throw new Error('could not find ' + fn + ' in data.js');
  ctx[fn] = m[0];
}
const radiusTable = dataSrc.match(/const DEST_RADIUS_KM = (\{[\s\S]*?\});/);
if(!radiusTable) throw new Error('DEST_RADIUS_KM not found in data.js');

const DEST_RADIUS_KM = eval('(' + radiusTable[1] + ')');
eval(ctx.geoDistanceKm);
eval(ctx.hasVerifiedGeo);
eval(ctx.destinationRadiusKm);
eval(ctx.placeWithinDestination);
eval(ctx.seededRandom);

let pass = 0, fail = 0;
function check(name, cond, detail){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

console.log('\n1. The fabrication is gone from the source');
{
  // The exact expression that produced the Spanish coordinates.
  const fabricates = /lat:\s*20\s*\+\s*\(rnd\(\)\*40-20\)/.test(dataSrc);
  check('data.js no longer seeds coordinates from a name hash', !fabricates,
        'the "20 + rnd()*40-20" fallback is still present');

  // Show what that expression used to produce, so the test documents the actual failure.
  const rnd = seededRandom('gen-seoul-korea');
  const ghostLat = 20 + (rnd() * 40 - 20), ghostLng = (rnd() * 340 - 170);
  const inSpain = ghostLat > 36 && ghostLat < 44 && ghostLng > -9.5 && ghostLng < 3.5;
  check('the old formula demonstrably put "Seoul Korea" in Spain', inSpain,
        `it produced ${ghostLat.toFixed(3)}, ${ghostLng.toFixed(3)}`);

  const generates = /const restNames = \[/.test(dataSrc) || /Market Street Kitchen'/.test(dataSrc);
  check('data.js no longer invents restaurants with fake names', !generates);
  const fakeRatings = /rating:\+\(4\.2\+rnd\(\)\*0\.6\)/.test(dataSrc);
  check('data.js no longer invents star ratings', !fakeRatings);
}

console.log('\n2. hasVerifiedGeo refuses anything unproven');
{
  check('rejects null coordinates', !hasVerifiedGeo({name:'X', lat:null, lng:null}));
  check('rejects undefined coordinates', !hasVerifiedGeo({name:'X'}));
  check('rejects NaN', !hasVerifiedGeo({name:'X', lat:NaN, lng:0}));
  check('rejects out-of-range latitude', !hasVerifiedGeo({name:'X', lat:120, lng:0}));
  check('rejects out-of-range longitude', !hasVerifiedGeo({name:'X', lat:0, lng:200}));
  check('rejects coordinates explicitly flagged unverified',
        !hasVerifiedGeo({name:'X', lat:37.5665, lng:126.978, geoVerified:false}));
  check('accepts a verified position', hasVerifiedGeo({name:'Seoul', lat:37.5665, lng:126.978, geoVerified:true}));
  check('accepts a curated destination that predates the flag', hasVerifiedGeo({name:'Tokyo', lat:35.6762, lng:139.6503}));
}

console.log('\n3. Places must belong to their destination');
{
  const seoul = {name:'Seoul', lat:37.5665, lng:126.9780, placeType:'city', geoVerified:true};
  const gyeongbokgung = {name:'Gyeongbokgung', lat:37.5796, lng:126.9770};
  const zahara = {name:'Zahara de la Sierra', lat:36.8398, lng:-5.3936};   // where the bug pointed
  const busan = {name:'Busan', lat:35.1796, lng:129.0756};

  check('a real Seoul landmark is inside Seoul', placeWithinDestination(gyeongbokgung, seoul),
        `${geoDistanceKm(gyeongbokgung, seoul).toFixed(1)} km away`);
  check('the Spanish phantom is rejected', !placeWithinDestination(zahara, seoul),
        `${Math.round(geoDistanceKm(zahara, seoul))} km away`);
  check('another Korean city is rejected', !placeWithinDestination(busan, seoul),
        `${Math.round(geoDistanceKm(busan, seoul))} km away`);
  check('nothing is inside an unverified destination',
        !placeWithinDestination(gyeongbokgung, {name:'Seoul', lat:null, lng:null}));
  check('a place without coordinates is never plotted',
        !placeWithinDestination({name:'Somewhere'}, seoul));

  // A village must not swallow half a country, and a country must not exile its own cities.
  const hallstatt = {name:'Hallstatt', lat:47.5622, lng:13.6493, placeType:'village', geoVerified:true};
  check('a village radius stays tight', destinationRadiusKm(hallstatt) <= 10,
        `${destinationRadiusKm(hallstatt)} km`);
  // A real country destination carries the boundary box Photon returns and its ISO code.
  const japan = {name:'Japan', lat:36.2048, lng:138.2529, placeType:'country', geoVerified:true,
                 countryCode:'JP',
                 bbox:{minLng:122.7141754, maxLng:154.205541, minLat:20.2145811, maxLat:45.7112046}};
  check('Tokyo counts as being in Japan',
        placeWithinDestination({name:'Tokyo', lat:35.6762, lng:139.6503, countryCode:'JP'}, japan));
  check('Okinawa, 1500 km from the centroid, still counts as Japan',
        placeWithinDestination({name:'Naha', lat:26.2124, lng:127.6809, countryCode:'JP'}, japan),
        'a radius-only test would have exiled it');
  // Japan's boundary box reaches west past Seoul's longitude, so geometry alone says yes here.
  // The country code is what actually settles it, which is why it is checked first.
  check('Seoul is inside Japan\'s bounding box (documents why the code check is needed)',
        (37.5665 >= 20.2145811 && 37.5665 <= 45.7112046 && 126.978 >= 122.7141754 && 126.978 <= 154.205541));
  check('Seoul is still rejected from Japan, on its country code',
        !placeWithinDestination({name:'Seoul', lat:37.5665, lng:126.978, countryCode:'KR'}, japan));
  check('a country box still rejects somewhere plainly outside it',
        !placeWithinDestination({name:'Lisbon', lat:38.7223, lng:-9.1393}, japan));
}

console.log('\n4. Distance measurement is sane');
{
  const d = geoDistanceKm({lat:48.8566, lng:2.3522}, {lat:51.5074, lng:-0.1278});  // Paris-London
  check('Paris to London is about 344 km', Math.abs(d - 344) < 6, `got ${d.toFixed(1)} km`);
  check('a point is zero from itself', geoDistanceKm({lat:1,lng:1}, {lat:1,lng:1}) === 0);
  check('missing coordinates give Infinity, not 0', geoDistanceKm({lat:1,lng:1}, {}) === Infinity);
}

console.log('\n5. The map refuses to draw an unverified location');
{
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  check('a fail-safe panel exists', /function mapUnverifiedHTML/.test(appSrc));
  check('it carries the wording the spec asks for', /Unable to verify map location/.test(appSrc));
  check('the planner route checks the destination first',
        /if\(!hasVerifiedGeo\(dest\)\)\{[\s\S]{0,200}mapUnverifiedHTML/.test(appSrc));
  check('the route only plots validated stops', /stops\.filter\(s=>placeWithinDestination\(s, dest\)\)/.test(appSrc));
  check('the destination map uses coordinates, not a name search',
        /gmapsCoordEmbedUrl\(dest\.lat, dest\.lng, 13\)/.test(appSrc));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
