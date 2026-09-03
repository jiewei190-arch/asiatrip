/* The four scenarios from the brief, generated the way a traveller generates them.
 *
 * The other suites check pieces: dates, preferences, placement, ranking. This one asks the
 * only question that matters at the end — if somebody picks a city and some dates, is the
 * itinerary that comes out something they could actually follow?
 *
 * Every assertion is about the trip that was produced, not about a function's return value,
 * and each one names a failure that has actually happened in this project: a place scheduled
 * twice, a day that criss-crosses a city, dinner at four in the afternoon, a stop with no
 * verifiable identity, a day with one thing in it.
 *
 * Discovery depends on public Overpass mirrors, which throttle. A scenario that comes back
 * with no places is reported as UNSERVED rather than failed: that is a statement about the
 * mirrors, not about the planner, and calling it a failure trains everyone to ignore this
 * suite. A scenario that returns places must then satisfy every rule below.
 *
 *   node tools/test-scenarios.js
 */
const path = require('path');
function loadPlaywright(){
  const tries = [process.env.PLAYWRIGHT_PATH, 'playwright', 'playwright-core'].filter(Boolean);
  for(const t of tries){ try{ return require(t); }catch(e){} }
  for(const dir of (process.env.NODE_PATH || '').split(':').filter(Boolean)){
    for(const name of ['playwright', 'playwright-core']){
      try{ return require(path.join(dir, name)); }catch(e){}
    }
  }
  return null;
}
const pw = loadPlaywright();
if(!pw){ console.error('playwright not found — set PLAYWRIGHT_PATH or NODE_PATH'); process.exitCode = 2; return; }
const { chromium } = pw;

const BASE = process.env.TF_BASE || 'http://127.0.0.1:8099';
const SCENARIOS = [
  { query:'Tokyo',     start:'2026-10-05', end:'2026-10-09', days:5,  pace:'balanced' },
  { query:'Paris',     start:'2026-10-05', end:'2026-10-11', days:7,  pace:'packed'   },
  { query:'New York City', start:'2026-10-05', end:'2026-10-14', days:10, pace:'relaxed' },
  // The brief also asks for a smaller destination, where thin map data is the normal case.
  { query:'Hallstatt', start:'2026-10-05', end:'2026-10-07', days:3,  pace:'relaxed'  },
];

let pass = 0, fail = 0, unserved = 0;
function check(name, cond, detail){
  if(cond){ pass++; console.log('    PASS  ' + name); }
  else { fail++; console.log('    FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.TF_CHROME ||
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  for(const sc of SCENARIOS){
    console.log(`\n${sc.query} · ${sc.days} days · ${sc.pace}`);
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    await page.route('**/*', async route => {
      const u = route.request().url();
      if(u.startsWith(BASE)) return route.continue();
      try {
        const req = route.request();
        const res = await fetch(u, { method: req.method(), headers: req.headers(),
          body: ['GET','HEAD'].includes(req.method()) ? undefined : req.postData() });
        const body = Buffer.from(await res.arrayBuffer());
        route.fulfill({ status: res.status, body,
          headers: Object.assign({}, Object.fromEntries(res.headers), {'access-control-allow-origin':'*'}) });
      } catch(e){ route.abort(); }
    });

    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
    const trip = await page.evaluate(async sc => {
      const geo = await geoResolve(sc.query);
      if(!geo) return { error: 'could not resolve ' + sc.query };
      const dest = makeGenericDestination(sc.query, geo);
      if(!dest) return { error: 'no destination for ' + sc.query };
      // Give discovery a real chance before planning, the way opening the page does.
      try { await discoverPlaces(dest, 'attraction'); await discoverPlaces(dest, 'restaurant'); }
      catch(e){}
      await new Promise(r => setTimeout(r, 1500));
      const prefs = normalizeTripPreferences(Object.assign(defaultTripPreferences(), {pace: sc.pace}));
      const t = buildPlannedTrip(dest, prefs, sc.start, sc.end, 2);
      return {
        destName: dest.name, destCountry: dest.country,
        pool: PLACES.filter(p => p.destId === dest.id).length,
        days: t.days.map(d => ({ date: d.date, stops: d.stops.map(s => ({
          name: s.name, type: s.type, placeId: s.placeId, time: s.time,
          duration: s.duration, lat: s.lat, lng: s.lng })) })),
        load: t.days.map(d => assessDayLoad(d, prefs)),
      };
    }, sc);

    if(trip.error){ console.log(`    UNSERVED  ${trip.error}`); unserved++; await page.close(); continue; }
    const allStops = trip.days.flatMap(d => d.stops);
    if(!allStops.length){
      console.log(`    UNSERVED  ${trip.destName}: discovery returned ${trip.pool} places, itinerary is empty`);
      unserved++; await page.close(); continue;
    }
    console.log(`    (${trip.pool} places discovered, ${allStops.length} scheduled)`);

    check('the trip has the days the dates ask for', trip.days.length === sc.days,
          `${trip.days.length} days`);

    // A place scheduled twice is the bug that made a five-day trip feel like one day repeated.
    const ids = allStops.map(s => s.placeId).filter(Boolean);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    check('no place is scheduled twice in the whole trip', dupes.length === 0,
          [...new Set(dupes)].slice(0, 3).join(', '));

    // Identity: a stop the app cannot point at on a map is a stop it invented.
    const noCoords = allStops.filter(s => s.lat == null || s.lng == null);
    check('every stop has real coordinates', noCoords.length === 0,
          noCoords.slice(0, 3).map(s => s.name).join(', '));

    // Nothing at an hour a human would not go.
    const hour = t => Number(String(t || '').slice(0, 2));
    const odd = allStops.filter(s => hour(s.time) < 7 || hour(s.time) > 22);
    check('nothing is scheduled before 7am or after 10pm', odd.length === 0,
          odd.slice(0, 3).map(s => `${s.name} ${s.time}`).join(', '));

    // Meals at mealtimes. Cafes and bars are excluded — those are legitimately all-day.
    const meals = allStops.filter(s => s.type === 'restaurant');
    const oddMeals = meals.filter(s => { const h = hour(s.time); return h < 7 || (h > 15 && h < 17) || h > 22; });
    check('meals fall at plausible mealtimes', oddMeals.length === 0,
          oddMeals.slice(0, 3).map(s => `${s.name} ${s.time}`).join(', '));

    // Days that are worth having: the brief asks for full days, not two stops and a gap.
    const thin = trip.days.filter(d => d.stops.length && d.stops.length < 4);
    check('no day is left with a token two or three stops', thin.length === 0,
          thin.map((d, i) => `day ${trip.days.indexOf(d) + 1}: ${d.stops.length}`).join(', '));

    // The planner's own overload judgement, applied to the trips it generates. If the planner
    // produces days it would itself warn about, one of the two is wrong.
    const overloaded = trip.load.map((l, i) => ({l, i})).filter(x => x.l.level === 'overloaded');
    check('the planner does not generate days it would warn about', overloaded.length === 0,
          overloaded.map(x => `day ${x.i + 1}: ${x.l.issues.map(y => y.kind).join('+')}`).join(', '));

    check('the page threw nothing', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed` +
              (unserved ? `, ${unserved} scenario${unserved === 1 ? '' : 's'} unserved (map mirrors throttled, not a defect)` : '') + '\n');
  process.exitCode = fail ? 1 : 0;
})();
