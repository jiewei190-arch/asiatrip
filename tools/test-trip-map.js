/* The whole trip on one map.
 *
 * The itinerary map shows one day as a Google directions embed: right for "how do I walk
 * today", wrong for "what does this trip look like" — it plots a single route and stops at ten
 * waypoints. This view answers the other question, and these are the things that would make it
 * lie: plotting a stop whose location was never confirmed, colouring two days the same, or
 * showing a grey box when the map library did not load.
 *
 *   node tools/test-trip-map.js        (needs a static server on :8099)
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

let pass = 0, fail = 0;
function check(name, cond, detail){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.TF_CHROME ||
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
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
  await page.waitForTimeout(3000);

  console.log('\nColours and point selection');
  const pure = await page.evaluate(() => {
    const out = {};
    // Every day must be visually distinct, at any trip length — a fixed palette of eight would
    // silently repeat on day nine.
    for(const n of [3, 8, 14]){
      const cols = Array.from({length: n}, (_, i) => tripDayColour(i, n));
      out['unique' + n] = new Set(cols).size === n;
      out['adjacent' + n] = cols.every((c, i) => i === 0 || c !== cols[i-1]);
    }
    // A stop with no confirmed location must be counted, not quietly dropped.
    const dest = DESTINATIONS.find(d => d.id === 'paris');
    const trip = { days: [
      { date:'2026-10-01', stops:[
        { name:'Good', lat:dest.lat, lng:dest.lng, time:'10:00' },
        { name:'Nowhere', lat:null, lng:null, time:'12:00' },
        { name:'Wrong continent', lat:-33.86, lng:151.20, time:'14:00' },
      ]},
    ]};
    const r = tripMapPoints(trip, dest);
    out.plotted = r.points.length;
    out.droppedNames = r.dropped.map(d => d.name);
    out.numbering = r.points.map(p => p.order);
    return out;
  });
  check('every day gets its own colour, at 3, 8 and 14 days',
        pure.unique3 && pure.unique8 && pure.unique14);
  check('no two consecutive days share a colour',
        pure.adjacent3 && pure.adjacent8 && pure.adjacent14);
  check('a stop with no coordinates is not plotted', pure.droppedNames.includes('Nowhere'));
  check('a stop outside the destination is not plotted',
        pure.droppedNames.includes('Wrong continent'), pure.droppedNames.join(', '));
  check('only the verified stop is plotted', pure.plotted === 1, `${pure.plotted} plotted`);
  check('dropped stops are reported rather than silently discarded', pure.droppedNames.length === 2);

  console.log('\nThe rendered map');
  const tripId = await page.evaluate(async () => {
    const dest = DESTINATIONS.find(d => d.id === 'paris');
    const t = await buildPlannedTrip(dest, loadTripPreferences(), '2026-10-01', '2026-10-04', 2);
    STATE.trips.unshift(t); saveState(); return t.id;
  });
  await page.evaluate(id => { location.hash = `#/trip/${id}/tripmap`; }, tripId);
  await page.waitForTimeout(6000);

  const live = await page.evaluate(() => ({
    tiles: document.querySelectorAll('#tripMapCanvas img.leaflet-tile').length,
    pins: document.querySelectorAll('.tripPin').length,
    legend: document.querySelectorAll('#tripMapLegend .legend').length,
    attribution: (document.querySelector('.leaflet-control-attribution') || {}).textContent || '',
    filter: !!document.getElementById('tripMapDayFilter'),
  }));
  check('real map tiles are drawn', live.tiles > 0, `${live.tiles} tiles`);
  check('stops are pinned on the map', live.pins > 0, `${live.pins} pins`);
  check('the legend names every day', live.legend === 4, `${live.legend} entries`);
  check('OpenStreetMap is credited, as its terms require',
        /OpenStreetMap/.test(live.attribution), live.attribution.slice(0, 60));
  check('a day filter is offered', live.filter);

  const before = live.pins;
  await page.selectOption('#tripMapDayFilter', '0');
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => document.querySelectorAll('.tripPin').length);
  check('filtering to one day shows fewer stops', after > 0 && after < before, `${before} → ${after}`);

  check('the page threw nothing', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0;
})();
