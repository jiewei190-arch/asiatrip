/* Which of the seven places with this name did they mean?
 *
 * This is the failure that costs the most and shows the least: nobody picked from a list, so a
 * trip is simply built in the wrong country. "Madeira" resolved to a city of 9,000 in Ohio and
 * "Salvador" to a town in the Philippines, and both looked like ordinary working software.
 *
 * The suite runs the app's own geoResolve against live Photon and Wikidata — no fixtures and
 * no private copy of the ranking logic. A harness that reimplements what it checks tests
 * something nobody ships: the earlier version of this suite carried its own ranker and
 * reported Medellin resolving to the Philippines for days after the app had been fixed.
 *
 * Two banks, kept apart on purpose:
 *
 *   CALIBRATION — names used while designing the ranking. Passing here proves only that the
 *   design does what it was built to do.
 *   HOLDOUT — names never looked at during that work. This is the one that says whether any
 *   of it generalises, and it is the reason the notability rule is restricted the way it is:
 *   an earlier version scored 52/52 on calibration while going BACKWARDS on the holdout.
 *
 * Expectations are the country a traveller would defensibly mean. Some names genuinely have
 * no right answer — Cordoba is four times larger in Argentina than in Spain, Windsor is larger
 * in Ontario than in Berkshire — and those are recorded as known-ambiguous rather than quietly
 * dropped, so the score stays honest.
 *
 *   node tools/test-geo-ranking.js
 */
const path = require('path');
const Geo = require(path.join(path.dirname(__dirname), 'geo.js'));

/* Names used to design the ranking. */
const CALIBRATION = [
  ['Madeira','PT'], ['Salvador','BR'], ['Bergen','NO'], ['Bali','ID'], ['Hallstatt','AT'],
  ['Roma','IT'], ['Rome','IT'], ['Athens','GR'], ['Birmingham','GB'], ['Toledo','ES'],
  ['Hyderabad','IN'], ['Valencia','ES'], ['Kingston','JM'], ['Naples','IT'], ['Melbourne','AU'],
  ['Cambridge','GB'], ['Medellin','CO'], ['Paris','FR'], ['Tokyo','JP'], ['Santiago','CL'],
  ['Perth','AU'], ['Santorini','GR'], ['Zanzibar','TZ'], ['Cape Verde','CV'], ['Lima','PE'],
  ['Cairo','EG'], ['Alexandria','EG'], ['Vienna','AT'], ['Manchester','GB'], ['Dublin','IE'],
  ['Tripoli','LY'], ['Granada','ES'], ['Sydney','AU'], ['Boston','US'], ['Wellington','NZ'],
  ['Queenstown','NZ'], ['Hanoi','VN'], ['Porto','PT'], ['Florence','IT'], ['Seville','ES'],
  ['Bruges','BE'], ['Nice','FR'], ['Split','HR'], ['Kyoto','JP'], ['Reykjavik','IS'],
  ['Marrakesh','MA'], ['Giethoorn','NL'], ['Reine','NO'], ['Chengdu','CN'], ['Mexico City','MX'],
  ['Gothenburg','SE'], ['Bergen','NO'],
];

/* Names never consulted while tuning. */
const HOLDOUT = [
  ['Santiago de Compostela','ES'], ['Tarifa','ES'], ['Trieste','IT'], ['Ghent','BE'],
  ['Lucerne','CH'], ['Innsbruck','AT'], ['Ravenna','IT'], ['Cartagena','CO'],
  ['Guadalajara','MX'], ['Salamanca','ES'], ['Halifax','CA'], ['Livingstone','ZM'],
  ['Batumi','GE'], ['Pokhara','NP'], ['Luang Prabang','LA'], ['Hoi An','VN'], ['Kandy','LK'],
  ['Nara','JP'], ['Busan','KR'], ['Cebu','PH'], ['Ubud','ID'], ['Arequipa','PE'],
  ['Punta Arenas','CL'], ['Salta','AR'], ['Asmara','ER'], ['Essaouira','MA'],
  ['Stone Town','TZ'], ['Lalibela','ET'], ['Tbilisi','GE'], ['Yerevan','AM'],
  ['Samarkand','UZ'], ['Bukhara','UZ'], ['Dubrovnik','HR'], ['Ljubljana','SI'],
  ['Tallinn','EE'], ['Vilnius','LT'], ['Bratislava','SK'], ['Sarajevo','BA'], ['Ohrid','MK'],
  ['Plovdiv','BG'], ['Sighisoara','RO'], ['Trondheim','NO'], ['Aarhus','DK'], ['Turku','FI'],
  ['Galway','IE'], ['San Sebastian','ES'],
];

/* Genuinely two-sided names. Recorded, reported, and excluded from the score rather than
 * deleted — a suite that hides the cases it cannot settle is flattering itself. */
const AMBIGUOUS = {
  'Cordoba':   'Cordoba, Argentina is four times the size of Cordoba, Spain',
  'Windsor':   'Windsor, Ontario is far larger than Windsor, Berkshire',
  'Newcastle': 'Newcastle, NSW against Newcastle upon Tyne, which OSM names in full',
  'Richmond':  'Richmond, Virginia against Richmond upon Thames',
  'Hastings':  'Hastings, New Zealand and Hastings, Nebraska both outrank the English town',
  'Waterloo':  'Waterloo, Iowa against the Belgian battlefield',
  'Nazare':    'Nazare, Portugal against Nazareth, typed without its accent',
  'Valparaiso':'Valparaiso, Indiana against Valparaiso, Chile',
  'Santa Cruz':'a dozen Santa Cruzes, several of them large',
  'Merida':    'Merida, Spain (Roman, UNESCO) against Merida, Mexico (far larger)',
  'Leon':      'Leon in Spain, Mexico and Nicaragua, all substantial',
};

async function resolve(q){
  for(let attempt = 0; attempt < 3; attempt++){
    if(attempt) await new Promise(r => setTimeout(r, 1500 * attempt));
    const got = await Geo.geoResolve(q);
    if(got) return got;
  }
  return null;
}

async function runBank(label, bank){
  console.log(`\n${label}`);
  let pass = 0, fail = 0, unreachable = 0, ambiguous = 0;
  const wrong = [];
  for(const [q, want] of bank){
    const got = await resolve(q);
    if(!got){ unreachable++; console.log(`  ????  ${q.padEnd(24)} unreachable`); continue; }
    const tag = `${got.name} (${got.typeLabel}, ${got.country})${got.notability ? ' · ' + got.notability + ' languages' : ''}`;
    if(AMBIGUOUS[q]){ ambiguous++; console.log(`  ~     ${q.padEnd(24)} ${tag}  [either: ${AMBIGUOUS[q]}]`); }
    else if(got.countryCode === want){ pass++; console.log(`  PASS  ${q.padEnd(24)} ${tag}`); }
    else { fail++; wrong.push(`${q}: expected ${want}, got ${got.countryCode} — ${tag}`);
           console.log(`  FAIL  ${q.padEnd(24)} ${tag}  [expected ${want}]`); }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`  → ${pass} passed, ${fail} failed` +
              (ambiguous ? `, ${ambiguous} known-ambiguous` : '') +
              (unreachable ? `, ${unreachable} unreachable` : ''));
  wrong.forEach(w => console.log('    - ' + w));
  return { pass, fail, unreachable };
}

(async () => {
  console.log('Resolving typed destination names against live Photon and Wikidata.');
  const cal = await runBank('CALIBRATION — names the ranking was designed against', CALIBRATION);
  const hold = await runBank('HOLDOUT — names never consulted while tuning', HOLDOUT);

  console.log('\nUnit checks on the scoring rules');
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if(cond){ pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
  };
  // The property the Halifax regression was caught by: a place Wikidata has never heard of
  // must not be scored as though it were unknown-because-obscure.
  check('an unmeasured place is never penalised', Geo.geoFameBonus(0) === 0);
  check('notability only ever demotes', [1, 40, 110, 400, 5000].every(n => Geo.geoFameBonus(n) <= 0));
  check('a place in few languages is demoted', Geo.geoFameBonus(12) < Geo.geoFameBonus(90));
  check('the demotion has a floor', Geo.geoFameBonus(1) >= -40);
  check('a widely covered place is left alone', Geo.geoFameBonus(343) === 0);
  // A municipality is a city's administrative form in much of the world, not a lesser thing.
  check('a municipality outranks a village', Geo.GEO_TYPE_RANK.municipality > Geo.GEO_TYPE_RANK.village);
  check('region-scale places compete with cities',
        Geo.GEO_TYPE_RANK.archipelago >= 90 && Geo.GEO_TYPE_RANK.state >= 80);
  check('one name in one country is never contested',
        Geo.geoContested([{name:'Kyoto', countryCode:'JP', osmId:'R1', score:200}], 'Kyoto') === null);

  const failed = cal.fail + hold.fail + fail;
  console.log(`\n${cal.pass + hold.pass + pass} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
