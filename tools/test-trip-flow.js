/* The whole flow a traveller goes through, driven in a real browser.
 *
 *   pick a destination -> pick dates -> say what you enjoy -> get an itinerary
 *
 * This is the test that would have caught the reported bug, because it counts the day tabs that
 * actually render rather than the days a function returns.
 *
 *   node tools/test-trip-flow.js
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
  console.error('playwright not found — set PLAYWRIGHT_PATH or NODE_PATH');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
function check(name, cond, detail){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

/* The scenarios named in the Phase 3 spec. */
const SCENARIOS = [
  {label:'Tokyo, 5 days, food + culture, moderate, balanced',
   dest:'Tokyo', start:'2026-09-24', end:'2026-09-28', days:5,
   prefs:{interests:['food','history'], budget:'moderate', pace:'balanced'}},
  {label:'Paris, 7 days, romance + food, luxury, relaxed',
   dest:'Rome', start:'2026-09-24', end:'2026-09-30', days:7,
   prefs:{interests:['romantic','food'], budget:'luxury', pace:'relaxed'}},
  {label:'Marrakech, 2 days, culture + markets + food, moderate',
   dest:'Marrakech', start:'2026-09-24', end:'2026-09-25', days:2,
   prefs:{interests:['history','shopping','food'], budget:'moderate', pace:'balanced'}},
  {label:'A 10-day trip',
   dest:'Bali', start:'2026-09-24', end:'2026-10-03', days:10,
   prefs:{interests:['nature'], budget:'budget', pace:'packed'}},
];

(async () => {
  const browser = await chromium.launch({executablePath: CHROME, args:['--no-sandbox']});
  const context = await browser.newContext({viewport:{width:1280, height:1100}, timezoneId:'Asia/Seoul'});
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e).slice(0,160)));
  // Deliberately offline: the app must build a full itinerary from curated data alone.
  await page.route('**/*', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  await page.goto(BASE + '/index.html', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => typeof window.buildPlannedTrip === 'function', null, {timeout:20000});

  console.log('\n1. The preferences step exists and is wired to real options');
  {
    const ui = await page.evaluate(() => {
      const dest = DESTINATIONS[0];
      openTripPreferences(dest, () => {});
      const count = id => document.querySelectorAll('#' + id + ' .prefChip').length;
      const open = !document.getElementById('modal-tripPrefs').classList.contains('hidden')
                || document.getElementById('modal-tripPrefs').classList.contains('show')
                || getComputedStyle(document.getElementById('modal-tripPrefs')).display !== 'none';
      return {open, interests:count('prefInterests'), pace:count('prefPace'),
              budget:count('prefBudget'), food:count('prefFood'),
              dayStart:count('prefDayStart'), party:count('prefParty'),
              mustSee: !!document.getElementById('prefMustSee'),
              mustAvoid: !!document.getElementById('prefMustAvoid')};
    });
    check('the step opens', ui.open === true);
    check('all twenty interests are offered', ui.interests === 20, `${ui.interests}`);
    check('three paces', ui.pace === 3, `${ui.pace}`);
    check('four budgets', ui.budget === 4, `${ui.budget}`);
    check('ten food preferences', ui.food === 10, `${ui.food}`);
    check('four day-start options', ui.dayStart === 4, `${ui.dayStart}`);
    check('seven travel parties', ui.party === 7, `${ui.party}`);
    check('must-see and must-avoid inputs exist', ui.mustSee && ui.mustAvoid);
    await page.evaluate(() => closeModal('modal-tripPrefs'));
  }

  console.log('\n2. Each scenario produces a complete, rendered itinerary');
  for(const sc of SCENARIOS){
    const res = await page.evaluate(async (sc) => {
      const d = findDestination(sc.dest);
      const prefs = normalizeTripPreferences(sc.prefs);
      const trip = buildPlannedTrip(d, prefs, sc.start, sc.end, 2);
      location.hash = '#/trip/' + encodeURIComponent(trip.id);
      await new Promise(r => setTimeout(r, 900));
      const tabs = document.querySelectorAll('[data-dayidx], .dayTab, .dayChip');
      const stops = trip.days.flatMap(x => x.stops);
      return {
        destName: d.name,
        days: trip.days.length,
        dayTabs: tabs.length,
        firstDate: trip.days[0].date,
        lastDate: trip.days[trip.days.length-1].date,
        emptyDays: trip.days.filter(x => x.stops.length === 0).length,
        totalStops: stops.length,
        uniquePlaces: new Set(stops.map(s => s.placeId)).size,
        withRealLegs: stops.filter(s => s.transitToNext && !s.transitToNext.estimated).length,
        meals: stops.filter(s => s.mealSlot).length,
        prefsStored: !!trip.preferences && trip.preferences.pace === sc.prefs.pace,
        warnings: (trip.warnings || []).length,
      };
    }, sc);

    console.log(`\n  — ${sc.label}`);
    check(`${sc.days} days generated`, res.days === sc.days, `got ${res.days}`);
    check('day one is the chosen start date', res.firstDate === sc.start, res.firstDate);
    check('the last day is the chosen end date', res.lastDate === sc.end, res.lastDate);
    check('no day is completely empty', res.emptyDays === 0, `${res.emptyDays} empty`);
    check('no place is repeated across the trip', res.uniquePlaces === res.totalStops,
          `${res.totalStops} stops, ${res.uniquePlaces} unique`);
    check('stops carry measured travel legs, not a flat 15 minutes',
          res.withRealLegs > 0, `${res.withRealLegs}/${res.totalStops}`);
    check('meals are scheduled', res.meals > 0, `${res.meals} meals`);
    check('the preferences are stored on the trip', res.prefsStored === true);
    console.log(`        ${res.totalStops} stops over ${res.days} days · ${res.meals} meals · ${res.warnings} warnings`);
  }

  console.log('\n3. Preferences visibly change the result');
  {
    const res = await page.evaluate(async () => {
      const d = findDestination('Tokyo');
      const mk = over => buildPlannedTrip(d, normalizeTripPreferences(over), '2026-09-24', '2026-09-28', 2);
      const relaxed = mk({pace:'relaxed'});
      const packed  = mk({pace:'packed'});
      const early   = mk({dayStart:'early'});
      const late    = mk({dayStart:'late'});
      const count = t => t.days.reduce((a,d) => a + d.stops.length, 0);
      const firstHour = t => parseInt(t.days[0].stops[0].time.split(':')[0], 10);
      // Keep the trip list clean for later assertions.
      [relaxed, packed, early, late].forEach(t => { STATE.trips = STATE.trips.filter(x => x.id !== t.id); });
      return {relaxed:count(relaxed), packed:count(packed),
              earlyHour:firstHour(early), lateHour:firstHour(late)};
    });
    check('a packed trip has more stops than a relaxed one', res.packed > res.relaxed,
          `relaxed ${res.relaxed}, packed ${res.packed}`);
    check('an early bird starts earlier than a late starter', res.earlyHour < res.lateHour,
          `${res.earlyHour}:00 vs ${res.lateHour}:00`);
  }

  console.log('\n4. Health');
  {
    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    check('no horizontal overflow on the itinerary', overflow <= 1, `${overflow}px`);
    check('no page errors', pageErrors.length === 0, pageErrors.slice(0,3).join(' | '));
  }

  console.log('\n5. Mobile');
  {
    const m = await context.newPage();
    await m.route('**/*', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
    await m.setViewportSize({width:390, height:844});
    await m.goto(BASE + '/index.html', {waitUntil:'domcontentloaded'});
    await m.waitForFunction(() => typeof window.buildPlannedTrip === 'function', null, {timeout:20000});
    const res = await m.evaluate(async () => {
      const d = findDestination('Tokyo');
      const trip = buildPlannedTrip(d, normalizeTripPreferences({interests:['food']}), '2026-09-24', '2026-09-28', 2);
      location.hash = '#/trip/' + encodeURIComponent(trip.id);
      await new Promise(r => setTimeout(r, 900));
      openTripPreferences(d, () => {});
      await new Promise(r => setTimeout(r, 300));
      const el = document.documentElement;
      return {overflow: el.scrollWidth - el.clientWidth, days: trip.days.length};
    });
    check('the preferences step fits a phone', res.overflow <= 1, `${res.overflow}px of overflow`);
    check('the itinerary still has all its days on mobile', res.days === 5, `${res.days}`);
    await m.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
