/* End-to-end test of the real UI against LIVE data.
 *
 * Why this exists: every other browser test in this repo stubs the network with recorded
 * payloads, so none of them could tell you whether the app works against the real services. This
 * one runs the real app in a real browser and answers that.
 *
 * The transport bridge, and what it does and does not prove:
 *   Chromium in this environment cannot reach the internet. The egress proxy accepts its CONNECT
 *   and then closes the tunnel mid-handshake (39 bytes back, close code 1006) for every host —
 *   with HTTP/2 and QUIC disabled too, so it is environment policy rather than something to work
 *   around. Node, however, has working network. So every cross-origin request the page makes is
 *   intercepted and performed by Node, and the real response is handed back to the page.
 *
 *   PROVES: the app's own logic, live data accuracy, rendering, pagination, fallbacks, layout at
 *   both sizes, console health and timing — all against responses the real services sent today.
 *   DOES NOT PROVE: browser-enforced CORS, since the bridge is not subject to it. That is checked
 *   separately in checkCorsHeaders() below, by reading the headers the services actually return.
 *
 *   node tools/test-live-ui.js
 */
const fs = require('fs');
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
const UA = 'TripFlow/1.0 (+https://jiewei190-arch.github.io/asiatrip/)';

let pass = 0, fail = 0;
function check(name, cond, detail){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

/* ---------------- CORS, checked directly ---------------- */

/** The one thing the bridge cannot prove. Reads the headers each service actually returns for a
 *  cross-origin request from the deployed site's origin. */
async function checkCorsHeaders(){
  const origin = 'https://jiewei190-arch.github.io';
  const targets = [
    ['Photon (geocode)',   'https://photon.komoot.io/api?q=Seoul&limit=1&lang=en', 'GET'],
    ['Overpass (places)',  'https://overpass.private.coffee/api/interpreter?data=' +
                            encodeURIComponent('[out:json];out count;'), 'GET'],
    ['open.er-api (rates)','https://open.er-api.com/v6/latest/USD', 'GET'],
    ['Commons (imagery)',  'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&list=search&srsearch=x&srlimit=1', 'GET'],
  ];
  console.log('\n0. Cross-origin access, from the response headers themselves');
  for(const [label, url, method] of targets){
    try{
      const res = await fetch(url, {method, headers:{'Origin': origin, 'User-Agent': UA}});
      const acao = res.headers.get('access-control-allow-origin');
      check(`${label} allows the browser origin`, acao === '*' || acao === origin,
            `access-control-allow-origin: ${acao === null ? '(absent)' : acao}`);
    }catch(e){
      check(`${label} allows the browser origin`, false, e.message);
    }
  }
}

/* ---------------- the bridge ---------------- */

function installBridge(page, stats){
  return page.route('**/*', async route => {
    const req = route.request();
    const url = req.url();
    if(url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')){
      return route.continue();
    }
    stats.requests.push(url);
    // Forced-failure hook, used to exercise the fallback chain.
    if(stats.failHosts.some(h => url.includes(h))){
      stats.forcedFailures++;
      return route.fulfill({status:503, contentType:'text/plain', body:'forced failure (test)'});
    }
    try{
      const headers = Object.assign({}, req.headers());
      delete headers['host']; delete headers['origin']; delete headers['referer'];
      headers['user-agent'] = UA;   // Node sends none, and Overpass 429s a request without one
      const init = {method: req.method(), headers};
      const body = req.postData();
      if(body && req.method() !== 'GET' && req.method() !== 'HEAD') init.body = body;

      const res = await fetch(url, init);
      const buf = Buffer.from(await res.arrayBuffer());
      stats.bytes += buf.length;
      if(!res.ok) stats.nonOk.push(`${res.status} ${url.slice(0, 70)}`);
      return route.fulfill({
        status: res.status,
        contentType: res.headers.get('content-type') || 'application/octet-stream',
        body: buf,
      });
    }catch(e){
      stats.errors.push(`${e.message} ${url.slice(0, 70)}`);
      return route.abort();
    }
  });
}

/* ---------------- run ---------------- */

(async () => {
  await checkCorsHeaders();

  const browser = await chromium.launch({executablePath: CHROME, args:['--no-sandbox']});

  async function newPage(viewport){
    const page = await browser.newPage({viewport});
    const stats = {requests:[], nonOk:[], errors:[], bytes:0, failHosts:[], forcedFailures:0,
                   consoleErrors:[], pageErrors:[]};
    page.on('pageerror', e => stats.pageErrors.push(String(e).slice(0,160)));
    page.on('console', m => { if(m.type() === 'error') stats.consoleErrors.push(m.text().slice(0,160)); });
    await installBridge(page, stats);
    return {page, stats};
  }

  /* --- desktop --- */
  console.log('\n1. Desktop: a real destination, discovered live');
  const {page, stats} = await newPage({width:1280, height:1000});
  const t0 = Date.now();
  await page.goto(BASE + '/index.html', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => typeof window.discoverPlaces === 'function', null, {timeout:30000});
  const loadMs = Date.now() - t0;

  const seoul = await page.evaluate(async () => {
    const geo = await geoSearch('Seoul');
    if(!geo || !geo.length) return {err:'geocode returned nothing'};
    const dest = makeGenericDestination('Seoul', geo[0]);
    const t = Date.now();
    const eat = await discoverPlaces(dest, 'restaurant', {fresh:true});
    return {
      ms: Date.now() - t,
      lat: dest.lat, lng: dest.lng, country: dest.country, cc: dest.countryCode,
      currency: dest.currencyCode, verified: hasVerifiedGeo(dest),
      count: eat.length,
      names: eat.slice(0, 5).map(p => p.name),
      withCuisine: eat.filter(p => p.cuisine && p.cuisine !== p.category).length,
      withHours: eat.filter(p => p.hours).length,
      allOsm: eat.every(p => /^osm:[NWR]\d+/.test(p.placeId || '')),
      allInBounds: eat.every(p => placeWithinDestination(p, dest)),
      anyInvented: eat.some(p => p.rating != null || p.reviews != null || p.price != null),
      source: eat.length ? eat[0].source : null,
    };
  });

  check('the destination geocoded live', !seoul.err && seoul.verified === true, seoul.err || '');
  check('coordinates are Seoul, not Andalusia',
        Math.abs(seoul.lat - 37.5665) < 0.6 && Math.abs(seoul.lng - 126.978) < 0.6,
        `${seoul.lat}, ${seoul.lng}`);
  check('country and currency are right', seoul.country === 'South Korea' && seoul.currency === 'KRW',
        `${seoul.country} / ${seoul.currency}`);
  check('real places came back from the live service', seoul.count > 20, `${seoul.count} places`);
  check('every one carries an OSM id', seoul.allOsm);
  check('every one is inside Seoul', seoul.allInBounds);
  check('nothing carries an invented rating, review count or price', seoul.anyInvented === false);
  console.log(`        ${seoul.count} places in ${(seoul.ms/1000).toFixed(1)}s via ${seoul.source}; ` +
              `${seoul.withCuisine} with cuisine, ${seoul.withHours} with hours`);
  console.log('        ' + (seoul.names || []).join(', '));

  /* --- rendering --- */
  console.log('\n2. Those places actually render on the page');
  const rendered = await page.evaluate(async () => {
    const geo = await geoSearch('Seoul');
    const dest = makeGenericDestination('Seoul', geo[0]);
    const eat = await discoverPlaces(dest, 'restaurant', {fresh:true});
    mergeDiscoveredPlaces(dest, 'restaurant', eat);
    // The tab lives in the hash (#/destination/<id>/<tab>). Navigating without it renders the
    // default tab, which is what tore the grid down in the first version of this test.
    location.hash = '#/destination/' + encodeURIComponent(dest.id) + '/restaurants';
    await new Promise(r => setTimeout(r, 1200));
    const cards = Array.from(document.querySelectorAll('#restGrid .placeCard'));
    const titles = cards.map(c => (c.querySelector('h4') || {}).textContent || '');
    return {
      cardCount: cards.length,
      titles: titles.slice(0, 4),
      hasShowMore: !!document.querySelector('[data-showmore]'),
      imgsWithSrc: cards.filter(c => { const i = c.querySelector('img'); return i && i.getAttribute('src'); }).length,
      bannedShown: titles.filter(t => /Market Street Kitchen|The Local Table|Harborview Grill/.test(t)).length,
      skeletons: document.querySelectorAll('.skelCard').length,
    };
  });
  check('cards rendered', rendered.cardCount > 0, `${rendered.cardCount} cards`);
  check('a page is shown, not all several hundred', rendered.cardCount <= 30, `${rendered.cardCount} cards`);
  check('there is a way to see more', rendered.hasShowMore === true);
  check('every card has an image source', rendered.imgsWithSrc === rendered.cardCount,
        `${rendered.imgsWithSrc}/${rendered.cardCount}`);
  check('no placeholder names on screen', rendered.bannedShown === 0);
  check('skeletons cleared once results arrived', rendered.skeletons === 0);
  console.log('        on screen: ' + rendered.titles.join(', '));

  /* --- images actually load --- */
  console.log('\n3. Images resolve and load');
  const imgs = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 2500));   // let imagery.js upgrade what it can
    const list = Array.from(document.querySelectorAll('#restGrid .placeCard img'));
    return {
      total: list.length,
      loaded: list.filter(i => i.complete && i.naturalWidth > 1).length,
      broken: list.filter(i => i.complete && i.naturalWidth === 0).length,
      upgraded: list.filter(i => i.dataset && i.dataset.imageSource).length,
      illustrative: document.querySelectorAll('.illusBadge').length,
    };
  });
  check('no broken images', imgs.broken === 0, `${imgs.broken} broken`);
  check('images are loading', imgs.loaded > 0, `${imgs.loaded}/${imgs.total} loaded`);
  console.log(`        ${imgs.loaded}/${imgs.total} loaded, ${imgs.upgraded} upgraded to a verified entity photo, ` +
              `${imgs.illustrative} marked Illustrative`);

  /* --- live currency --- */
  console.log('\n4. Live exchange rates');
  const fx = await page.evaluate(async () => {
    const box = await getRates('USD', {fresh:true});
    const conv = await convertCurrency(12000, 'KRW', 'USD');
    return {
      provider: box && box.provider, n: box && box.rates ? Object.keys(box.rates).length : 0,
      stale: box && box.stale, asOf: box && box.asOf,
      krwToUsd: conv && conv.amount, rate: conv && conv.rate,
      formatted: typeof formatMoney === 'function' ? formatMoney(12000, 'KRW') : '',
    };
  });
  check('rates came from a live provider', !!fx.provider && fx.n > 100, `${fx.provider}, ${fx.n} currencies`);
  check('rates are fresh, not stale', fx.stale === false);
  check('a conversion produced a sane number', fx.krwToUsd > 1 && fx.krwToUsd < 100, String(fx.krwToUsd));
  check('won renders with no decimal places', /^₩12,000$/.test(fx.formatted), fx.formatted);
  console.log(`        ${fx.n} currencies via ${fx.provider}, as of ${fx.asOf}`);

  /* --- fallback chain --- */
  console.log('\n5. No single point of failure');
  stats.failHosts = ['overpass'];   // must be set BEFORE the call, or nothing is actually failed
  const fb = await page.evaluate(async () => {
    const out = {};
    const eat = await discoverPlaces(
      {id:'fb-test', name:'Hallstatt', placeId:'osm:Rfb', lat:47.5622, lng:13.6493,
       placeType:'village', geoVerified:true, countryCode:'AT'},
      'restaurant', {fresh:true});
    out.count = eat.length;
    out.source = eat.length ? eat[0].source : null;
    return out;
  });
  const forced = stats.forcedFailures;
  stats.failHosts = [];
  check('Overpass really was made to fail', forced > 0, `${forced} forced failures`);
  check('with every Overpass mirror down, Photon still returns places',
        fb.count > 0 && fb.source === 'photon', `${fb.count} places via ${fb.source}`);
  console.log(`        ${forced} Overpass calls failed; ${fb.count} places still returned via ${fb.source}`);

  /* --- edge case: nowhere --- */
  console.log('\n6. Edge case: somewhere with nothing mapped');
  const empty = await page.evaluate(async () => {
    // Middle of the South Atlantic. Verified coordinates, genuinely nothing there.
    const dest = {id:'ocean', name:'Point Nemo', placeId:'osm:Rocean', lat:-48.87, lng:-123.39,
                  placeType:'locality', geoVerified:true};
    const eat = await discoverPlaces(dest, 'restaurant', {fresh:true});
    return {count: eat.length, notice: discoveryNoticeHTML(dest, 'restaurant', eat.length)};
  });
  check('an empty result stays empty rather than inventing filler', empty.count === 0,
        `${empty.count} places`);

  /* --- mobile --- */
  console.log('\n7. Mobile layout');
  const {page: mob, stats: mstats} = await newPage({width:390, height:844, isMobile:true, hasTouch:true});
  await mob.goto(BASE + '/index.html', {waitUntil:'domcontentloaded'});
  await mob.waitForFunction(() => typeof window.discoverPlaces === 'function', null, {timeout:30000});
  const mobile = await mob.evaluate(async () => {
    const geo = await geoSearch('Seoul');
    const dest = makeGenericDestination('Seoul', geo[0]);
    const eat = await discoverPlaces(dest, 'restaurant', {fresh:true});
    mergeDiscoveredPlaces(dest, 'restaurant', eat);
    location.hash = '#/destination/' + encodeURIComponent(dest.id) + '/restaurants';
    await new Promise(r => setTimeout(r, 1200));
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    // Name the widest offender, so an overflow failure points at an element instead of a number.
    let culprit = null, worst = 0;
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      const over = Math.round(r.right - document.documentElement.clientWidth);
      if(over > worst && r.width > 0){
        worst = over;
        culprit = (el.tagName.toLowerCase() + (el.id ? '#'+el.id : '') +
                   (el.className && typeof el.className === 'string' ? '.'+el.className.trim().split(/\s+/).slice(0,2).join('.') : '')) +
                  ` (right ${Math.round(r.right)}px)`;
      }
    });
    const cards = document.querySelectorAll('#restGrid .placeCard');
    let widest = 0;
    cards.forEach(c => { widest = Math.max(widest, c.getBoundingClientRect().width); });
    return {overflow, cards: cards.length, widest: Math.round(widest),
            viewport: document.documentElement.clientWidth, culprit, worst};
  });
  check('no horizontal overflow on a phone', mobile.overflow <= 1,
        `${mobile.overflow}px of overflow — widest: ${mobile.culprit || 'unknown'}`);
  check('cards fit the viewport', mobile.widest <= mobile.viewport,
        `card ${mobile.widest}px in ${mobile.viewport}px`);
  // "Fits" is not enough: nesting .placeGrid inside .placeGrid made each card a third of a third
  // of the width, which fit perfectly and looked broken.
  check('cards are a usable width, not shrunk by a nested grid',
        mobile.widest >= mobile.viewport * 0.8,
        `card ${mobile.widest}px in ${mobile.viewport}px`);
  check('cards rendered on mobile too', mobile.cards > 0, `${mobile.cards} cards`);

  /* --- health --- */
  console.log('\n8. Console health and performance');
  // Exclude the 503s this test itself forced in section 5, and browser-chrome noise the app does
  // not control. Counting our own injected failures as app defects would be measuring the test.
  const realConsoleErrors = stats.consoleErrors.concat(mstats.consoleErrors)
    .filter(e => !/favicon|content-autofill|accounts\.google/.test(e))
    .filter(e => !/503 \(Service Unavailable\)/.test(e));
  check('no uncaught page errors', stats.pageErrors.length === 0 && mstats.pageErrors.length === 0,
        stats.pageErrors.concat(mstats.pageErrors).slice(0,2).join(' | '));
  check('no console errors', realConsoleErrors.length === 0, realConsoleErrors.slice(0,3).join(' | '));
  check('the app becomes interactive quickly', loadMs < 8000, `${loadMs}ms`);
  console.log(`        page ready in ${loadMs}ms · ${stats.requests.length + mstats.requests.length} ` +
              `outbound requests · ${((stats.bytes + mstats.bytes)/1024).toFixed(0)} KB`);
  if(stats.nonOk.length) console.log('        non-2xx seen: ' + stats.nonOk.slice(0,4).join(' | '));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
