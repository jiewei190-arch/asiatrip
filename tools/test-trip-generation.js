/* Generates trips the way a traveller does, in a real browser, and counts the days that come out.
 *
 * Two bugs are guarded here:
 *   - a trip built from a trip idea took its length from the idea rather than the chosen dates,
 *     so a six-day selection could produce a two-day itinerary;
 *   - addDays built local midnight and formatted as UTC, so at or east of UTC every day tab was
 *     labelled one day early. That one is invisible unless the test sets a timezone, which is
 *     why this runs in Asia/Seoul as well as UTC.
 *
 *   node tools/test-trip-generation.js
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

/* The durations the spec calls out by name, plus the reported case. */
const DURATIONS = [
  {start:'2026-09-24', end:'2026-09-25', days:2},
  {start:'2026-09-24', end:'2026-09-26', days:3},
  {start:'2026-09-24', end:'2026-09-28', days:5},
  {start:'2026-09-24', end:'2026-09-29', days:6},    // the case in the report
  {start:'2026-09-24', end:'2026-09-30', days:7},
  {start:'2026-09-24', end:'2026-10-03', days:10},
  {start:'2026-09-24', end:'2026-10-07', days:14},
];

(async () => {
  const browser = await chromium.launch({executablePath: CHROME, args:['--no-sandbox']});

  for(const tz of ['UTC', 'Asia/Seoul', 'Pacific/Auckland']){
    console.log(`\n=== timezone: ${tz} ===`);
    const context = await browser.newContext({viewport:{width:1280, height:1000}, timezoneId: tz});
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e).slice(0,140)));
    // No outbound network in this browser; the app must still build trips from curated data.
    await page.route('**/*', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
    await page.goto(BASE + '/index.html', {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => typeof window.tripDurationDays === 'function', null, {timeout:20000});

    // 1. The calendar module agrees with itself inside a real browser in this timezone.
    const cal = await page.evaluate(() => ({
      dayZero: addDays('2026-09-24', 0),
      dayOne: addDays('2026-09-24', 1),
      backOne: addDays('2026-09-24', -1),
      monthEnd: addDays('2026-09-30', 1),
      yearEnd: addDays('2026-12-31', 1),
      leap: addDays('2028-02-28', 1),
      roundTrip: toDateInput('2026-09-24'),
    }));
    check(`${tz}: addDays(d, 0) returns the same day`, cal.dayZero === '2026-09-24', cal.dayZero);
    check(`${tz}: addDays(d, 1) returns the next day`, cal.dayOne === '2026-09-25', cal.dayOne);
    check(`${tz}: addDays(d, -1) returns the day before`, cal.backOne === '2026-09-23', cal.backOne);
    check(`${tz}: a month boundary is crossed correctly`, cal.monthEnd === '2026-10-01', cal.monthEnd);
    check(`${tz}: a year boundary is crossed correctly`, cal.yearEnd === '2027-01-01', cal.yearEnd);
    check(`${tz}: a leap day is not skipped`, cal.leap === '2028-02-29', cal.leap);
    check(`${tz}: a date survives a round trip`, cal.roundTrip === '2026-09-24', cal.roundTrip);

    // 2. Every generator produces exactly the days the dates ask for.
    for(const d of DURATIONS){
      const res = await page.evaluate(({start, end}) => {
        const dest = DESTINATIONS[0];
        const out = {};

        // (a) the auto-trip builder
        const auto = buildAutoTrip(dest.id, 'Auto', start, end, 2, 'moderate');
        out.auto = {n: auto.days.length, first: auto.days[0].date,
                    last: auto.days[auto.days.length-1].date, end: auto.end};

        // (b) a trip built from a trip idea — the path that carried the bug. Deliberately give
        // the idea a length that disagrees with the chosen dates.
        window.__heroParams = {start, end, travelers: 2};
        const places = PLACES.filter(p => p.destId === dest.id).slice(0, 12);
        const idea = {destId: dest.id, title: 'Test idea', days: 2, budgetStyle: 'moderate',
                      pace: 'balanced', interests: [], places};
        const fromIdea = createTripFromIdea(idea);
        out.idea = {n: fromIdea.days.length, first: fromIdea.days[0].date,
                    last: fromIdea.days[fromIdea.days.length-1].date, end: fromIdea.end,
                    dates: fromIdea.days.map(x => x.date)};
        STATE.trips = STATE.trips.filter(t => t.id !== fromIdea.id);
        return out;
      }, d);

      check(`${tz}: a ${d.days}-day trip auto-generates ${d.days} days`,
            res.auto.n === d.days, `got ${res.auto.n}`);
      check(`${tz}: a ${d.days}-day trip from a 2-day IDEA still gets ${d.days} days`,
            res.idea.n === d.days, `got ${res.idea.n}`);
      check(`${tz}: day 1 is the date the traveller picked (${d.start})`,
            res.idea.first === d.start, `got ${res.idea.first}`);
      check(`${tz}: the last day is the end date (${d.end})`,
            res.idea.last === d.end && res.idea.end === d.end,
            `last=${res.idea.last} end=${res.idea.end}`);
      // Consecutive, no gaps, no repeats — a day tab per calendar day.
      const gaps = res.idea.dates.filter((date, i, arr) =>
        i > 0 && new Date(date) - new Date(arr[i-1]) !== 86400000);
      check(`${tz}: the ${d.days} days run consecutively with no gaps`, gaps.length === 0,
            gaps.join(', '));
    }

    // 3. Editing the dates re-shapes the trip rather than leaving it stale.
    const edited = await page.evaluate(() => {
      const dest = DESTINATIONS[0];
      const t = buildAutoTrip(dest.id, 'Edit me', '2026-09-24', '2026-09-26', 2, 'moderate');
      const before = t.days.length;
      t.end = '2026-10-03'; normalizeTripDays(t);         // extended to 10 days
      const grown = t.days.length, grownLast = t.days[t.days.length-1].date;
      t.days[0].stops.push({id:'keepme', name:'Keep me'}); // a stop on day 1
      t.end = '2026-09-25'; normalizeTripDays(t);          // shortened to 2 days
      const shrunk = t.days.length;
      const keptStop = t.days[0].stops.some(s => s.id === 'keepme');
      return {before, grown, grownLast, shrunk, keptStop};
    });
    check(`${tz}: extending the dates adds days`, edited.grown === 10, `got ${edited.grown}`);
    check(`${tz}: the added days are dated correctly`, edited.grownLast === '2026-10-03', edited.grownLast);
    check(`${tz}: shortening the dates removes days`, edited.shrunk === 2, `got ${edited.shrunk}`);
    check(`${tz}: shortening keeps the stops on remaining days`, edited.keptStop === true);

    check(`${tz}: no page errors`, pageErrors.length === 0, pageErrors.slice(0,2).join(' | '));
    await context.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
