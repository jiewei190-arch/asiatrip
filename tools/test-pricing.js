/* Prices must be real, or absent — never invented in either direction.
 *
 * What this exists to prevent, all of which shipped:
 *   priceLevelStr(null) returned 'Free', so every discovered place — none of which carries a
 *     price, deliberately, because OpenStreetMap publishes none — was labelled free. Ticketed
 *     museums included.
 *   fmtIn did `Number(x) || 0`, so a null price formatted as $0.00. The hotel panel read
 *     "$0.00 / night" for 124 of Tokyo's 128 hotels.
 *   Every stop's cost defaulted to 0, so a 45-stop itinerary totalled $0 against a $1,500 budget.
 *   Every destination the traveller typed got the same $50/$120/$280 a day, Oslo and Hanoi alike.
 *
 * The rule being tested is one rule: a number on screen has to have come from somewhere.
 *
 *   node tools/test-pricing.js        (needs a static server on :8099)
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
const BASE = process.env.TF_BASE || 'http://127.0.0.1:8099';
const CHROME = process.env.TF_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const check = (n, c, d) => { if(c){ pass++; console.log('  PASS  ' + n); }
                             else { fail++; console.log('  FAIL  ' + n + (d ? '  — ' + d : '')); } };

/* ---- pure checks, no browser ---- */
console.log('\n1. The formatters cannot turn absence into a number');
{
  const cl = require(path.join(path.dirname(__dirname), 'costlevels.js'));
  check('a country with no usable price level gets no estimate',
        cl.estimatedDailyBudget('VE') === null && cl.estimatedDailyBudget('ZW') === null);
  check('an unknown country code gets no estimate',
        cl.estimatedDailyBudget('') === null && cl.estimatedDailyBudget('ZZ') === null);
  const ch = cl.estimatedDailyBudget('CH'), eg = cl.estimatedDailyBudget('EG');
  check('Switzerland costs several times what Egypt does, as it does',
        ch.moderate > eg.moderate * 3, `CH ${ch.moderate} vs EG ${eg.moderate}`);
  check('the United States is the 1.00 baseline', cl.countryPriceLevel('US') === 1);
  // Reproducing a hand-checked value is the strongest evidence the model is not arbitrary.
  const jp = cl.estimatedDailyBudget('JP');
  check('the model reproduces Tokyo\'s hand-set moderate figure (150) within a rounding step',
        Math.abs(jp.moderate - 150) <= 10, `model says ${jp.moderate}`);
  check('every level in the table is inside the plausible band',
        Object.values(cl.COUNTRY_PRICE_LEVEL).every(v => v >= 0.15 && v <= 1.6));
}

(async () => {
  const browser = await pw.chromium.launch({executablePath: CHROME, args:['--no-sandbox']});
  const page = await browser.newPage({viewport:{width:1280, height:1100}});
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0,140)));
  await page.route('**/*', async route => {
    const req = route.request();
    if(req.url().startsWith(BASE)) return route.continue();
    try{
      const res = await fetch(req.url(), {method: req.method(), headers: req.headers(),
        body: ['GET','HEAD'].includes(req.method()) ? undefined : req.postData()});
      route.fulfill({status: res.status, body: Buffer.from(await res.arrayBuffer()),
        headers: Object.assign({}, Object.fromEntries(res.headers), {'access-control-allow-origin':'*'})});
    }catch(e){ route.abort(); }
  });
  await page.goto(BASE + '/index.html', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => typeof window.buildPlannedTrip === 'function', null, {timeout:25000});
  await page.evaluate(() => { const s = document.getElementById('onboardSkip'); if(s) s.click(); });

  console.log('\n2. Nothing unpriced is described as free or as costing nothing');
  {
    const res = await page.evaluate(async () => {
      const d = findDestination('Tokyo');
      await awaitPlacesFor(d, ['attraction','restaurant','hotel'], 40000);
      const out = {};
      for(const tab of ['things','restaurants','hotels']){
        location.hash = '#/destination/' + d.id + '/' + tab; route();
        await new Promise(r => setTimeout(r, 3000));
        const text = document.getElementById('mainRoot').innerText;
        out[tab] = {
          zeros: (text.match(/\$0\.00|\$0(?!\d)/g) || []).length,
          // A discovered place must not be called Free unless OSM said fee=no.
          frees: (text.match(/\bFree\b/g) || []).length,
        };
      }
      // and the same in the detail panel, which is where "$0.00 / night" lived
      const hotel = placesFor(d.id, 'hotel').find(h => h.price == null);
      openPlaceDetail(hotel.id);
      await new Promise(r => setTimeout(r, 700));
      const modal = document.getElementById('placeDetailContent');
      out.hotelDetail = modal ? modal.innerText.replace(/\n+/g, ' | ') : '(not found)';
      const attrs = placesFor(d.id, 'attraction');
      out.attrTotal = attrs.length;
      out.bySource = {};
      attrs.forEach(a => { out.bySource[a.source || '?'] = (out.bySource[a.source || '?'] || 0) + 1; });

      /* Rendering is asserted against places we control rather than against whatever discovery
       * happened to return. Discovery races Overpass and Photon, and only Overpass carries OSM
       * tags — so on a run Photon wins there is no fee data anywhere, through no fault of the
       * code under test. What must always hold is the rule: a published fee is shown, and an
       * absent one produces nothing at all rather than the word "Free". */
      const base = attrs[0];
      const mk = (id, extra) => Object.assign({}, base, {id, placeId: id, name: 'Test ' + id,
                                                         price: null, priceLevel: null}, extra);
      PLACES.push(mk('t-free',   {fee: 'Free',      charge: ''}));
      PLACES.push(mk('t-paid',   {fee: 'Entry fee', charge: ''}));
      PLACES.push(mk('t-amount', {fee: 'Entry fee', charge: '2700 JPY'}));
      PLACES.push(mk('t-silent', {fee: '',          charge: ''}));
      /* Rendered through the app's own card function rather than by hunting the grid, which
       * paginates and filters — a synthetic place appended to PLACES may never be on the page,
       * and a missing card would pass the "says nothing" assertion for the wrong reason. */
      const cardText = id => {
        const holder = document.createElement('div');
        holder.innerHTML = placeCardHTML(PLACES.find(x => x.id === id));
        return holder.innerText || holder.textContent || '';
      };
      out.cards = { free: cardText('t-free'), paid: cardText('t-paid'),
                    amount: cardText('t-amount'), silent: cardText('t-silent') };
      out.detail = {};
      for(const id of ['t-free','t-paid','t-amount','t-silent']){
        openPlaceDetail(id); await new Promise(r => setTimeout(r, 350));
        const m = document.getElementById('placeDetailContent');
        out.detail[id] = m ? m.innerText.replace(/\n+/g, ' | ') : '';
        closeModal('modal-placeDetail');
      }
      return out;
    });
    for(const tab of ['things','restaurants','hotels']){
      check(`no $0 anywhere on ${tab}`, res[tab].zeros === 0, `${res[tab].zeros} found`);
    }
    check('the hotel panel does not quote a rate it does not have',
          !/\$0/.test(res.hotelDetail) && /[Nn]ot published/.test(res.hotelDetail),
          res.hotelDetail.slice(0, 150));
    console.log(`        ${res.attrTotal} attractions by source: ${JSON.stringify(res.bySource)}`);
    check('a place OSM says is free is shown as free',
          /Free entry/.test(res.cards.free), res.cards.free.replace(/\n/g, ' / '));
    check('a place OSM says charges is shown as charging',
          /Entry fee/.test(res.cards.paid), res.cards.paid.replace(/\n/g, ' / '));
    check('a published amount is shown verbatim, not converted',
          /2700 JPY/.test(res.cards.amount), res.cards.amount.replace(/\n/g, ' / '));
    check('a place with nothing published says nothing — not "Free"',
          res.cards.silent.length > 0 && !/\bFree\b/.test(res.cards.silent) && !/\$0/.test(res.cards.silent),
          res.cards.silent ? res.cards.silent.replace(/\n/g, ' / ') : 'card rendered empty');
    check('and its detail panel says not published rather than a price',
          /Not published/i.test(res.detail['t-silent']) && !/\$0/.test(res.detail['t-silent']),
          res.detail['t-silent'].slice(0, 140));
    check('the detail panel repeats the real amount when there is one',
          /2700 JPY/.test(res.detail['t-amount']), res.detail['t-amount'].slice(0, 140));
  }

  console.log('\n3. A day costs what the country costs, not a flat number');
  {
    const res = await page.evaluate(async () => {
      const out = {};
      for(const q of ['Oslo, Norway', 'Hanoi, Vietnam', 'Zurich, Switzerland', 'Cairo, Egypt']){
        const d = findDestination(q);
        await enrichGenericDestination(d);
        out[d.name] = destDailyBudget(d, 'moderate');
      }
      return out;
    });
    const vals = Object.values(res);
    check('every typed destination gets a figure', vals.every(v => v != null), JSON.stringify(res));
    check('and they are not all the same flat number', new Set(vals).size === vals.length,
          JSON.stringify(res));
    check('an expensive city costs more than a cheap one', res.Zurich > res.Hanoi * 3,
          `Zurich ${res.Zurich} vs Hanoi ${res.Hanoi}`);
    check('and the ordering matches the real world',
          res.Zurich > res.Oslo && res.Oslo > res.Hanoi && res.Hanoi > res.Cairo,
          JSON.stringify(res));
  }

  console.log('\n4. The itinerary says how much of its cost is actually known');
  {
    const res = await page.evaluate(async () => {
      const d = findDestination('Tokyo');
      const trip = await buildPlannedTrip(d, normalizeTripPreferences({pace:'balanced'}),
                                          '2026-11-02', '2026-11-06', 2);
      location.hash = '#/trip/' + trip.id + '/budget'; route();
      await new Promise(r => setTimeout(r, 1800));
      const stops = trip.days.flatMap(x => x.stops);
      const out = {
        unpricedAreNull: stops.filter(s => s.cost === 0).length,
        nullCosts: stops.filter(s => s.cost == null).length,
        basis: (document.getElementById('budgetBasis') || {}).innerText || '',
        recorded: document.getElementById('budgetPlanned2').textContent,
      };
      STATE.trips = STATE.trips.filter(t => t.id !== trip.id);
      return out;
    });
    check('a stop with no published price costs null, not zero', res.nullCosts > 0,
          `${res.nullCosts} null, ${res.unpricedAreNull} zero`);
    check('the screen says how many stops actually publish a price',
          /of \d+ stops publish a price/.test(res.basis), res.basis.slice(0, 120));
    check('and it says where the target figure came from',
          /a day ×/.test(res.basis), res.basis.slice(0, 120));
    check('the recorded total is not a bare $0', res.recorded !== '$0', res.recorded);
  }

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0;
})();
