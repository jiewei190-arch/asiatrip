/* Search inside one trip.
 *
 * A planned trip accumulates sixty stops, saved places, bookings with confirmation numbers, a
 * packing list, expenses and notes in three different places. Before this there was no way to
 * ask it a question — "which day is the Louvre on?" meant clicking through tabs.
 *
 * The failures worth guarding: a search that misses the confirmation number somebody is
 * standing at a hotel desk trying to find; one that cannot match "cafe" to "Café"; and one that
 * answers a single keystroke with the entire trip.
 *
 *   node tools/test-trip-search.js      (needs a static server on :8099)
 */
const path = require('path');
function loadPlaywright(){
  const tries = [process.env.PLAYWRIGHT_PATH, 'playwright', 'playwright-core'].filter(Boolean);
  for(const t of tries){ try{ return require(t); }catch(e){} }
  for(const dir of (process.env.NODE_PATH || '').split(':').filter(Boolean)){
    for(const n of ['playwright','playwright-core']){ try{ return require(path.join(dir,n)); }catch(e){} }
  }
  return null;
}
const pw = loadPlaywright();
if(!pw){ console.error('playwright not found'); process.exitCode = 2; return; }
const { chromium } = pw;
const BASE = process.env.TF_BASE || 'http://127.0.0.1:8099';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.TF_CHROME ||
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
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
      route.fulfill({ status: res.status, body: Buffer.from(await res.arrayBuffer()),
        headers: Object.assign({}, Object.fromEntries(res.headers), {'access-control-allow-origin':'*'}) });
    } catch(e){ route.abort(); }
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  // First run shows an onboarding modal, which sits over everything and eats clicks.
  await page.evaluate(() => { const b = document.getElementById('onboardSkip'); if(b) b.click(); });
  await page.waitForTimeout(400);

  const r = await page.evaluate(() => {
    const dest = DESTINATIONS.find(d => d.id === 'paris');
    const trip = buildPlannedTrip(dest, loadTripPreferences(), '2026-10-01', '2026-10-03', 2);
    // Fill in the things a real trip carries, so search is tested against all of them.
    trip.days[0].stops[0].name = 'Café de Flore';
    trip.days[0].stops[0].note = 'window table if possible';
    trip.days[1].note = 'slow morning, late start';
    trip.notes = 'Passport expires 2029';
    trip.bookings = [{ id:'b1', type:'hotel', title:'Hotel Lumiere', provider:'Booking',
                       confirmation:'XR-99204-TT', date:'2026-10-01', notes:'late check-in' }];
    trip.packing = [{ label:'Rain jacket', category:'Clothing', packed:false }];
    trip.budget.expenses = [{ label:'Museum pass', category:'Activities', amount:78 }];
    STATE.trips.unshift(trip); saveState();

    const kinds = q => searchTrip(trip, q).map(x => x.kind);
    const titles = q => searchTrip(trip, q).map(x => x.title);
    return {
      tripId: trip.id,
      short: searchTrip(trip, 'a').length,
      empty: searchTrip(trip, '').length,
      confirmation: titles('XR-99204'),
      confirmationKind: kinds('XR-99204'),
      accentFolded: titles('cafe de flore'),
      stopNote: titles('window table'),
      dayNote: kinds('slow morning'),
      tripNote: kinds('passport'),
      packing: kinds('rain jacket'),
      expense: kinds('museum pass'),
      nonsense: searchTrip(trip, 'zzzzqqq').length,
      whereForStop: (searchTrip(trip, 'cafe de flore')[0] || {}).where,
      gotoForBooking: (searchTrip(trip, 'XR-99204')[0] || {}).goto,
      malformed: (() => { try { return searchTrip({days:null}, 'anything').length; } catch(e){ return 'threw'; } })(),
    };
  });

  console.log('\nWhat a trip can be asked');
  check('a confirmation number is findable', r.confirmation.includes('Hotel Lumiere'), r.confirmation.join(', '));
  check('it is reported as a booking', r.confirmationKind.includes('booking'));
  check('and it says which tab to open', r.gotoForBooking && r.gotoForBooking.tab === 'bookings');
  check('"cafe" finds "Café"', r.accentFolded.includes('Café de Flore'), r.accentFolded.join(', '));
  check('a stop hit says which day and time', /^Day \d+ · /.test(r.whereForStop || ''), r.whereForStop);
  check('a note on a stop is searched', r.stopNote.includes('Café de Flore'));
  check('a note on a day is searched', r.dayNote.includes('note'));
  check('a note on the trip is searched', r.tripNote.includes('note'));
  check('the packing list is searched', r.packing.includes('packing'));
  check('expenses are searched', r.expense.includes('expense'));

  console.log('\nWhat it refuses to do');
  check('a single letter returns nothing, not the whole trip', r.short === 0, `${r.short} results`);
  check('an empty query returns nothing', r.empty === 0);
  check('a query matching nothing returns nothing', r.nonsense === 0);
  check('a malformed trip does not throw', r.malformed === 0, String(r.malformed));

  console.log('\nIn the page');
  await page.evaluate(id => { location.hash = `#/trip/${id}/dashboard`; }, r.tripId);
  await page.waitForTimeout(2500);
  await page.fill('#tripSearchInput', 'XR-99204');
  await page.waitForTimeout(600);
  const ui = await page.evaluate(() => {
    const panel = document.getElementById('tripSearchResults');
    return { visible: panel && !panel.classList.contains('hidden'),
             rows: panel ? panel.querySelectorAll('[data-tripsearch]').length : 0 };
  });
  check('typing shows a results panel', ui.visible);
  check('the booking appears in it', ui.rows > 0, `${ui.rows} rows`);
  await page.click('[data-tripsearch="0"]');
  await page.waitForTimeout(1200);
  const landed = await page.evaluate(() => location.hash);
  check('choosing a result opens the right tab', /\/bookings$/.test(landed), landed);
  check('the page threw nothing', errors.length === 0, errors.slice(0,2).join(' | '));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0;
})();
