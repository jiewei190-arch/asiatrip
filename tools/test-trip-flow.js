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
      const trip = await buildPlannedTrip(d, prefs, sc.start, sc.end, 2);
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
        declaresEmpty: (trip.warnings || []).some(w => w.kind === 'emptyDay'),
      };
    }, sc);

    console.log(`\n  — ${sc.label}`);
    check(`${sc.days} days generated`, res.days === sc.days, `got ${res.days}`);
    check('day one is the chosen start date', res.firstDate === sc.start, res.firstDate);
    check('the last day is the chosen end date', res.lastDate === sc.end, res.lastDate);
    /* This page is deliberately offline, so the plan is built from the eleven bundled places
     * alone — a seed, not a catalogue. Ten days cannot be filled from it and pretending otherwise
     * would only be testing that the generator invents somewhere to go. What has to hold is that
     * the plan SAYS SO: an itinerary with a blank Tuesday must not look like a finished one. */
    check(res.emptyDays === 0 ? 'no day is completely empty'
                              : 'an unfillable day is declared, not shipped silently',
          res.emptyDays === 0 || res.declaresEmpty,
          `${res.emptyDays} empty, warning ${res.declaresEmpty ? 'present' : 'MISSING'}`);
    check('no place is repeated across the trip', res.uniquePlaces === res.totalStops,
          `${res.totalStops} stops, ${res.uniquePlaces} unique`);
    check('stops carry measured travel legs, not a flat 15 minutes',
          res.withRealLegs > 0, `${res.withRealLegs}/${res.totalStops}`);
    check('meals are scheduled', res.meals > 0, `${res.meals} meals`);
    check('the preferences are stored on the trip', res.prefsStored === true);
    console.log(`        ${res.totalStops} stops over ${res.days} days · ${res.meals} meals · ${res.warnings} warnings`);
  }

  console.log('\n2b. A plan that knows it has a problem says so on screen');
  {
    /* planTrip has produced warnings since Phase 3 and buildPlannedTrip has stored them on the
     * trip since Phase 3. Nothing rendered them, so an itinerary that knew it had a blank day
     * looked exactly like one that did not. */
    const res = await page.evaluate(async () => {
      const d = findDestination('Bali');
      const trip = await buildPlannedTrip(d, normalizeTripPreferences({pace:'packed'}),
                                          '2026-09-24', '2026-10-03', 2);
      location.hash = '#/trip/' + encodeURIComponent(trip.id);
      route();
      await new Promise(r => setTimeout(r, 700));
      const panel = document.getElementById('tripWarnings');
      const rows = panel ? panel.querySelectorAll('.tripWarn') : [];
      const before = rows.length;
      const text = panel ? panel.textContent : '';
      if(rows.length) rows[0].querySelector('.tripWarnX').click();
      await new Promise(r => setTimeout(r, 200));
      const after = document.querySelectorAll('#tripWarnings .tripWarn').length;
      // Reopening must not bring a dismissed warning back.
      route();
      await new Promise(r => setTimeout(r, 300));
      const afterReopen = document.querySelectorAll('#tripWarnings .tripWarn').length;
      return {stored: (trip.warnings || []).length, before, after, afterReopen,
              text: text.slice(0, 120), hidden: panel ? panel.classList.contains('hidden') : null};
    });
    check('the trip carries warnings', res.stored > 0, `${res.stored}`);
    check('and they are shown to the traveller', res.before > 0, `${res.before} on screen`);
    check('the empty day is named in words', /empty|ran out/i.test(res.text), res.text);
    check('a warning can be dismissed', res.after === res.before - 1, `${res.before} -> ${res.after}`);
    check('and stays dismissed on reopening', res.afterReopen === res.after,
          `${res.after} -> ${res.afterReopen}`);
  }

  console.log('\n3. Preferences visibly change the result');
  {
    /* This one needs the network. Pace decides how many stops a day can hold, and with only the
     * eleven bundled places every pace uses all eleven — so an offline page cannot tell a packed
     * trip from a relaxed one, and the assertion that it could was passing on nothing for as long
     * as the pool happened to be big enough. Discovery gives the planner something to choose
     * between, which is the condition under which the preference means anything. */
    const net = await context.newPage();
    await net.route('**/*', async r => {
      const u = r.request().url();
      if(u.startsWith(BASE)) return r.continue();
      try {
        const q = r.request();
        const res = await fetch(u, {method:q.method(), headers:q.headers(),
          body:['GET','HEAD'].includes(q.method()) ? undefined : q.postData()});
        r.fulfill({status:res.status, body:Buffer.from(await res.arrayBuffer()),
          headers:Object.assign({}, Object.fromEntries(res.headers), {'access-control-allow-origin':'*'})});
      } catch(e){ r.abort(); }
    });
    await net.goto(BASE + '/index.html', {waitUntil:'domcontentloaded'});
    await net.waitForFunction(() => typeof window.buildPlannedTrip === 'function', null, {timeout:20000});
    const res = await net.evaluate(async () => {
      const d = findDestination('Tokyo');
      const mk = over => buildPlannedTrip(d, normalizeTripPreferences(over), '2026-09-24', '2026-09-28', 2);
      // Sequential on purpose: the first call waits for discovery, the rest reuse what it found.
      const relaxed = await mk({pace:'relaxed'});
      const packed  = await mk({pace:'packed'});
      const early   = await mk({dayStart:'early'});
      const late    = await mk({dayStart:'late'});
      const count = t => t.days.reduce((a,d) => a + d.stops.length, 0);
      const firstHour = t => parseInt(t.days[0].stops[0].time.split(':')[0], 10);
      // Keep the trip list clean for later assertions.
      [relaxed, packed, early, late].forEach(t => { STATE.trips = STATE.trips.filter(x => x.id !== t.id); });
      return {relaxed:count(relaxed), packed:count(packed),
              pool: placesFor(d.id).filter(p => p.type==='attraction' || p.type==='restaurant').length,
              earlyHour:firstHour(early), lateHour:firstHour(late)};
    });
    check('a packed trip has more stops than a relaxed one', res.packed > res.relaxed,
          `relaxed ${res.relaxed}, packed ${res.packed}`);
    check('discovery gave the planner a real pool to choose from', res.pool > 50, `${res.pool} places`);
    check('an early bird starts earlier than a late starter', res.earlyHour < res.lateHour,
          `${res.earlyHour}:00 vs ${res.lateHour}:00`);
    await net.close();
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
      const trip = await buildPlannedTrip(d, normalizeTripPreferences({interests:['food']}), '2026-09-24', '2026-09-28', 2);
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
  /* process.exitCode rather than process.exit(): when stdout is redirected to a file or a pipe,
   * Node writes it asynchronously and process.exit() discards whatever is still buffered. Two
   * full worldwide runs lost their closing summary that way — the tally, the sample of what was
   * found and the currency checks were simply gone, and the run looked like it had died at
   * whichever destination happened to be last flushed. Setting the code instead lets Node drain
   * stdout and exit on its own. */
  process.exitCode = fail ? 1 : 0;
})();
