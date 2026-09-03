/* Trip duration must equal the dates the traveller chose. Every time.
 *
 * The bug this exists to prevent: a trip built from a trip idea took its length from the IDEA
 * (`idea.days`) and ignored the end date the user had picked, so choosing 24-29 September and
 * then tapping a two-day idea produced a two-day itinerary for a six-day trip. The dates were
 * captured correctly — `__heroParams` had `end` all along — they were simply never read.
 *
 *   node tools/test-trip-duration.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const dataSrc = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');

/* Load the calendar module out of data.js without executing the whole catalogue. The functions
 * depend on each other, so they are evaluated together in one scope rather than individually. */
function grab(src, name){
  const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n}', 'm'));
  return m ? m[0] : '';
}
const CALENDAR = ['parseDateOnly', 'toDateInput', 'addDays', 'tripDurationDays',
                  'tripDayDates', 'normalizeTripDays'];
const capMatch = dataSrc.match(/const TRIP_MAX_DAYS = (\d+);/);

/* Built in its own function scope: evaluating the declarations at module scope collides with
 * the names this file then binds them to. */
const loaded = (function loadCalendar(){
  const body = (capMatch ? `const TRIP_MAX_DAYS = ${capMatch[1]};\n` : '') +
               CALENDAR.map(n => grab(dataSrc, n)).join('\n') +
               '\nreturn {' + CALENDAR.join(', ') + '};';
  try { return new Function(body)(); }
  catch(e){ console.error('calendar module would not load:', e.message); return {}; }
})();

const { tripDurationDays, addDays, toDateInput, normalizeTripDays, tripDayDates } = loaded;

let pass = 0, fail = 0;
function check(name, cond, detail){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

console.log('\n1. One centralized duration calculation exists');
{
  check('data.js exports tripDurationDays', typeof tripDurationDays === 'function',
        'no single source of truth for trip length');
}

if(typeof tripDurationDays === 'function'){
  console.log('\n2. It counts the days a traveller would count');
  {
    // Inclusive: leaving on the 24th and returning on the 29th is six days of trip.
    const cases = [
      ['2026-09-24', '2026-09-29', 6, 'the reported case'],
      ['2026-09-24', '2026-09-25', 2, 'a two-day trip'],
      ['2026-09-24', '2026-09-26', 3, 'a three-day trip'],
      ['2026-09-24', '2026-09-28', 5, 'a five-day trip'],
      ['2026-09-24', '2026-09-30', 7, 'a week'],
      ['2026-09-24', '2026-10-03', 10, 'ten days, crossing a month boundary'],
      ['2026-09-24', '2026-10-07', 14, 'a fortnight'],
      ['2026-09-24', '2026-09-24', 1, 'a single day'],
      ['2026-12-28', '2027-01-03', 7, 'crossing a year boundary'],
      ['2026-02-26', '2026-03-02', 5, 'crossing the end of February'],
    ];
    for(const [start, end, want, label] of cases){
      const got = tripDurationDays(start, end);
      check(`${label}: ${start} to ${end} is ${want} days`, got === want, `got ${got}`);
    }
  }

  console.log('\n3. It survives bad input instead of producing a broken trip');
  {
    check('an end before the start is at least one day', tripDurationDays('2026-09-29', '2026-09-24') >= 1);
    check('a missing end date is at least one day', tripDurationDays('2026-09-24', '') >= 1);
    check('no dates at all is at least one day', tripDurationDays('', '') >= 1);
    check('a nonsense date is at least one day', tripDurationDays('not-a-date', 'nor-this') >= 1);
    // A single mistyped year should not try to build 400,000 day tabs.
    const absurd = tripDurationDays('2026-09-24', '3026-09-24');
    check('an absurd range is capped rather than hanging the browser', absurd <= 400, `got ${absurd}`);
  }

  console.log('\n4. Daylight saving does not lose or gain a day');
  {
    // Northern-hemisphere clocks change inside both of these ranges. Counting with raw
    // millisecond arithmetic silently returns 6.958 days here, which rounds wrong at some
    // offsets and produces a trip one day short.
    check('across the March clock change', tripDurationDays('2026-03-26', '2026-04-01') === 7,
          `got ${tripDurationDays('2026-03-26', '2026-04-01')}`);
    check('across the October clock change', tripDurationDays('2026-10-22', '2026-10-28') === 7,
          `got ${tripDurationDays('2026-10-22', '2026-10-28')}`);
    check('across the southern-hemisphere change', tripDurationDays('2026-04-02', '2026-04-08') === 7,
          `got ${tripDurationDays('2026-04-02', '2026-04-08')}`);
  }
}

console.log('\n5. Nothing builds a trip from anything but the chosen dates');
{
  // The specific regression: the idea's own length overriding the traveller's dates.
  check('createTripFromIdea no longer sizes the trip from idea.days',
        !/const days = precomputedDays \|\| distributeIntoDays\(idea\.places, idea\.days\)/.test(appSrc),
        'still distributing into idea.days rather than the selected duration');
  check('createTripFromIdea no longer derives the end date from idea.days',
        !/end: addDays\(start, idea\.days-1\)/.test(appSrc),
        'still overwriting the end date the user picked');
  check('the four hardcoded day objects are gone',
        !/days:\[\{date:start,stops:\[\]\},\{date:addDays\(start,1\)/.test(appSrc),
        'a draft trip is still hardcoded to four days');
  check('every day array is built from the centralized duration',
        /tripDurationDays\(/.test(appSrc), 'app.js never calls tripDurationDays');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
