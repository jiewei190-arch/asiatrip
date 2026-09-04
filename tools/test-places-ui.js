/* Drives the real destination UI in a headless browser, with the network stubbed by live
 * captures in places-fixtures.json (the browser here has no outbound access).
 *
 * What it proves:
 *   - a destination chosen from search gets its real coordinates, and the map draws them
 *   - a destination with no verified geocode draws NO map, and says why
 *   - discovered restaurants render with their real names
 *   - none of the old invented names or invented ratings can appear
 *   - pagination shows a page at a time rather than several hundred cards
 *
 *   node tools/test-places-ui.js
 */
const fs = require('fs');
const path = require('path');
/* Playwright is not a dependency of this repo (there is no build step and no package.json), so
 * resolve it from wherever it is installed rather than assuming a local node_modules. */
function loadPlaywright(){
  const tries = [process.env.PLAYWRIGHT_PATH, 'playwright', 'playwright-core'].filter(Boolean);
  for(const t of tries){ try{ return require(t); }catch(e){} }
  const extra = (process.env.NODE_PATH || '').split(':').filter(Boolean);
  for(const dir of extra){
    for(const name of ['playwright', 'playwright-core']){
      try{ return require(require('path').join(dir, name)); }catch(e){}
    }
  }
  console.error('playwright not found — set PLAYWRIGHT_PATH or NODE_PATH to its install directory');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const ROOT = path.dirname(__dirname);
const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'places-fixtures.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({viewport:{width:1280, height:1000}});
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  // Serve the recorded payloads to whichever service the app asks for, and fail everything else
  // the way a blocked network would, so the honest-failure paths get exercised too.
  await page.route('**/*', route => {
    const url = route.request().url();
    if(url.startsWith(BASE)) return route.continue();
    if(/overpass/.test(url)){
      return route.fulfill({status:200, contentType:'application/json', body: JSON.stringify(FIX.restaurant)});
    }
    if(/photon\.komoot\.io\/api/.test(url)){
      return route.fulfill({status:200, contentType:'application/json', body: JSON.stringify(FIX.geocode)});
    }
    if(/photon\.komoot\.io\/reverse/.test(url)){
      return route.fulfill({status:200, contentType:'application/json', body: JSON.stringify({features:[]})});
    }
    return route.abort();
  });

  await page.goto(BASE + '/index.html', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => typeof window.discoverPlaces === 'function', null, {timeout:20000});

  console.log('\n1. A verified destination gets real coordinates');
  {
    const res = await page.evaluate(async () => {
      const geo = await geoSearch('Seoul');
      const top = geo && geo[0];
      if(!top) return {err:'no geo result'};
      const dest = makeGenericDestination('Seoul', top);
      return {name:dest.name, lat:dest.lat, lng:dest.lng, cc:dest.countryCode,
              verified:hasVerifiedGeo(dest), cur:dest.currencyCode, bbox:!!dest.bbox};
    });
    check('the destination is marked verified', res.verified === true, JSON.stringify(res));
    check('its coordinates are Seoul, not Spain',
          Math.abs(res.lat - 37.5665) < 0.6 && Math.abs(res.lng - 126.978) < 0.6,
          `got ${res.lat}, ${res.lng}`);
    check('the country code came through', res.cc === 'KR', String(res.cc));
    check('the local currency is the Korean won', res.cur === 'KRW', String(res.cur));
    check('a boundary box was captured', res.bbox === true);
  }

  console.log('\n2. An unverified destination draws no map at all');
  {
    const res = await page.evaluate(() => {
      const dest = makeGenericDestination('Somewhere Nobody Can Geocode');
      return {lat:dest.lat, lng:dest.lng, verified:hasVerifiedGeo(dest),
              panel:mapUnverifiedHTML(dest.name)};
    });
    check('coordinates are null rather than invented', res.lat === null && res.lng === null,
          `got ${res.lat}, ${res.lng}`);
    check('it is not treated as verified', res.verified === false);
    check('the fail-safe panel names the destination and says why',
          /Unable to verify map location/.test(res.panel) && /Somewhere Nobody/.test(res.panel));
  }

  console.log('\n3. Discovered restaurants are real and render');
  {
    const res = await page.evaluate(async () => {
      const geo = await geoSearch('Seoul');
      const dest = makeGenericDestination('Seoul', geo[0]);
      const list = await discoverPlaces(dest, 'restaurant', {fresh:true});
      return {
        count: list.length,
        names: list.slice(0, 6).map(p => p.name),
        allHaveOsmId: list.every(p => /^osm:[NWR]\d+/.test(p.placeId || '')),
        anyRating: list.some(p => p.rating != null),
        anyReviews: list.some(p => p.reviews != null),
        anyPrice: list.some(p => p.price != null),
        allInBounds: list.every(p => placeWithinDestination(p, dest)),
        dupes: list.length - new Set(list.map(p => p.placeId)).size,
        withCuisine: list.filter(p => p.cuisine && p.cuisine !== p.category).length,
      };
    });
    check('places were discovered', res.count > 0, `count=${res.count}`);
    check('every one carries an OSM canonical id', res.allHaveOsmId);
    check('every one is inside the destination', res.allInBounds);
    check('there are no duplicates', res.dupes === 0, `${res.dupes} duplicates`);
    check('no invented star ratings', res.anyRating === false);

  /* The same rule, applied to EVERY place rather than only the discovered ones. The curated
   * twelve carried 132 hardcoded ratings and 132 review counts for a long time after the
   * discovered path was cleaned — every rating between 4.3 and 4.8, which is not a distribution
   * any real dataset produces — plus generateReviews(), which attached made-up people and
   * templated review text to real, named businesses. */
  const wide = await page.evaluate(() => ({
    total: PLACES.length,
    withRating: PLACES.filter(p => p.rating != null).length,
    withReviews: PLACES.filter(p => p.reviews != null).length,
    withGuestRating: PLACES.filter(p => p.guestRating != null).length,
    reviewGenerator: typeof generateReviews,
    reviewNames: typeof REVIEW_NAMES,
    starsOnScreen: document.querySelectorAll('.stars').length,
    reviewBlocks: document.querySelectorAll('.pdReview').length,
  }));
  check('not one place anywhere carries a rating', wide.withRating === 0,
        `${wide.withRating} of ${wide.total}`);
  check('not one carries a review count', wide.withReviews === 0, `${wide.withReviews}`);
  check('not one carries a guest score', wide.withGuestRating === 0, `${wide.withGuestRating}`);
  check('the review fabricator is gone from the code', wide.reviewGenerator === 'undefined');
  check('so is its cast of invented reviewers', wide.reviewNames === 'undefined');
  check('no star row is rendered anywhere', wide.starsOnScreen === 0, `${wide.starsOnScreen} on screen`);
  check('no review block is rendered anywhere', wide.reviewBlocks === 0);
    check('no invented review counts', res.anyReviews === false);
    check('no invented prices', res.anyPrice === false);
    console.log('        found: ' + res.names.join(', '));
    console.log(`        ${res.withCuisine} of ${res.count} carry a cuisine from the map data`);
  }

  console.log('\n4. The old invented data cannot come back');
  {
    const banned = ['Market Street Kitchen', 'The Local Table', "Grandma's Corner Café",
                    'The Harborview Grill', 'Spice & Sea', 'The Old Bakery', 'Central Museum'];
    const res = await page.evaluate(async (banned) => {
      const geo = await geoSearch('Seoul');
      const dest = makeGenericDestination('Seoul', geo[0]);
      const list = await discoverPlaces(dest, 'restaurant', {fresh:true});
      const mine = PLACES.filter(p => p.destId === dest.id);
      const names = list.concat(mine).map(p => p.name);
      return banned.filter(b => names.some(n => String(n).includes(b)));
    }, banned);
    check('none of the placeholder names appear anywhere', res.length === 0, res.join(', '));
  }

  console.log('\n5. Pagination renders a page, not everything');
  {
    /* Against the pagination the app SHIPS. This used to call pagePlaces(), a second
     * implementation in places.js that renderPagedPlaceGrid() does not use — so it verified
     * behaviour nobody could reach. A dense city returns several hundred entities and putting
     * them all in the DOM at once is a visible freeze on a phone, which is the thing worth
     * checking, so the check now drives the real grid. */
    const res = await page.evaluate(async () => {
      const dest = DESTINATIONS.find(d => d.id === 'paris');
      const fake = Array.from({length: 300}, (_, i) => ({
        id:'fake'+i, placeId:'osm:N'+i, destId:dest.id, name:'Fake place '+i,
        type:'attraction', category:'Museum', lat:dest.lat, lng:dest.lng, source:'test' }));
      const holder = document.createElement('div');
      holder.id = 'pagingProbe';
      document.body.appendChild(holder);
      renderPagedPlaceGrid('pagingProbe', fake, dest, 'attraction', placeCardHTML);
      const first = holder.querySelectorAll('.placeCard').length;
      const more = holder.querySelector('[data-showmore]');
      const label = more ? more.textContent : '';
      if(more) more.click();
      await new Promise(r => setTimeout(r, 300));
      const second = holder.querySelectorAll('.placeCard').length;
      const nested = holder.querySelectorAll('.placeGrid .placeGrid').length;
      holder.remove();
      return { first, second, label, nested };
    });
    check('the first render is bounded, not all 300', res.first > 0 && res.first <= 60, `${res.first} cards`);
    check('a "Show more" is offered while there is more', /Show more/.test(res.label), res.label);
    check('and it says how many are left', /\d+ more/.test(res.label), res.label);
    check('showing more appends rather than replaces', res.second > res.first,
          `${res.first} then ${res.second}`);
    // The bug that made every card a third of a third of the width on a phone.
    check('no grid is nested inside another grid', res.nested === 0);
  }

  console.log('\n6. Currency: complete catalogue, searchable, dual prices, honest gaps');
  {
    const res = await page.evaluate(() => {
      // Rates are needed for the synchronous formatters; seed the table the way startup does.
      EXCHANGE_RATES = {USD:1, KRW:1370, VND:26000, EUR:0.92, JPY:160, KWD:0.307};
      const dest = {name:'Seoul', currencyCode:'KRW'};
      STATE.settings.currencyCode = 'USD';
      return {
        catalogue: allCurrencyCodes().length,
        zeroDecimalKRW: currencyDecimals('KRW'),
        zeroDecimalVND: currencyDecimals('VND'),
        threeDecimalKWD: currencyDecimals('KWD'),
        krw: formatMoney(12000, 'KRW'),
        kwd: formatMoney(3.5, 'KWD'),
        dual: fmtMoneyDual(100, dest),
        same: fmtMoneyDual(100, {currencyCode:'USD'}),
        noRate: fmtMoneyDual(100, {currencyCode:'ZZZ'}),
        searchWon: searchCurrencies('won', 3).map(r=>r.code),
        searchCountry: searchCurrencies('south korea', 2).map(r=>r.code),
        searchDirham: searchCurrencies('dirham', 3).map(r=>r.code),
      };
    });
    check('the catalogue is global, not a short list', res.catalogue > 140, `${res.catalogue} currencies`);
    check('KRW and VND are zero-decimal', res.zeroDecimalKRW === 0 && res.zeroDecimalVND === 0);
    check('KWD is three-decimal', res.threeDecimalKWD === 3);
    check('won formats without phantom decimals', /12,000/.test(res.krw) && !/12,000\./.test(res.krw), res.krw);
    check('dinar formats with three', /3\.500/.test(res.kwd), res.kwd);
    check('a price shows local first, then the user currency',
          /priceLocal/.test(res.dual) && /priceConverted/.test(res.dual) && /12?[0-9,]*/.test(res.dual), res.dual);
    check('no redundant conversion when they match', !/priceConverted/.test(res.same), res.same);
    check('a missing rate says so instead of guessing', /no ZZZ rate|priceLocal/.test(res.noRate), res.noRate);
    check('search finds a currency by its name', res.searchWon.includes('KRW'), res.searchWon.join(','));
    check('search finds a currency by country', res.searchCountry.includes('KRW'), res.searchCountry.join(','));
    check('search finds both dirhams', res.searchDirham.includes('MAD') && res.searchDirham.includes('AED'),
          res.searchDirham.join(','));
  }

  console.log('\n7. Stale discovery is cancelled');
  {
    const res = await page.evaluate(async () => {
      const geo = await geoSearch('Seoul');
      const a = makeGenericDestination('Seoul', geo[0]);
      discoverPlacesFor(a, ['restaurant']);
      const b = {id:'other-dest', name:'Elsewhere', lat:10, lng:10, geoVerified:true, placeType:'city', placeId:'osm:R99'};
      discoverPlacesFor(b, ['restaurant']);
      return {cancelled: typeof cancelDiscoveryExcept === 'function'};
    });
    check('opening a new destination cancels the previous one', res.cancelled === true);
  }

  console.log('\n8. No page errors');
  check('the page threw nothing', pageErrors.length === 0, pageErrors.slice(0,2).join(' | '));

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
