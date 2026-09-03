/* Storage is where this app can lose somebody's work.
 *
 * Everything a traveller plans lives in localStorage — no account, no server — so a failure
 * there is not a degraded experience, it is the whole trip gone. Both halves used to swallow
 * every error: a full or blocked quota meant edits vanished while the screen kept showing
 * them, and a corrupted record was replaced with demo trips and then overwritten, destroying
 * the one copy that might have been recoverable.
 *
 *   node tools/test-storage.js        (needs a static server on :8099)
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
const check = (n, c, d) => { if(c){ pass++; console.log('  PASS  ' + n); }
                             else { fail++; console.log('  FAIL  ' + n + (d ? '  — ' + d : '')); } };

async function freshPage(browser, before){
  const page = await browser.newPage();
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
  if(before) await page.addInitScript(before);
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  return page;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.TF_CHROME ||
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  console.log('\nA save that cannot happen is reported, not swallowed');
  {
    const page = await freshPage(browser);
    const out = await page.evaluate(() => {
      const real = localStorage.setItem.bind(localStorage);
      // Exactly what a full quota looks like to the app.
      localStorage.setItem = (k, v) => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; };
      saveState();
      const banner = document.getElementById('storageBanner');
      const shown = banner && !banner.classList.contains('hidden');
      const text = banner ? banner.textContent : '';
      localStorage.setItem = real;
      return { shown, text, hasBackupButton: !!document.getElementById('storageBackupBtn') };
    });
    check('a failed save raises a visible banner', out.shown);
    check('the banner says saving has stopped', /not being saved|Not saving/i.test(out.text), out.text.slice(0, 90));
    check('it names the cause as a full quota', /full/i.test(out.text));
    check('it offers a backup as the way out', out.hasBackupButton);
    await page.close();
  }

  console.log('\nA save that works clears the warning');
  {
    const page = await freshPage(browser);
    const cleared = await page.evaluate(() => {
      const real = localStorage.setItem.bind(localStorage);
      localStorage.setItem = () => { const e = new Error('q'); e.name = 'QuotaExceededError'; throw e; };
      saveState();
      localStorage.setItem = real;
      saveState();
      const b = document.getElementById('storageBanner');
      return b && b.classList.contains('hidden');
    });
    check('the banner goes away once saving works again', cleared);
    await page.close();
  }

  console.log('\nAn unreadable record is preserved, never replaced with demo data');
  {
    const page = await freshPage(browser, () => {
      try { localStorage.setItem('tripflow_state_v1', '{"trips":[{"id":"t1", BROKEN'); } catch(e){}
    });
    const out = await page.evaluate(() => {
      const keys = Object.keys(localStorage);
      const banner = document.getElementById('storageBanner');
      return {
        kept: keys.some(k => k.indexOf(':unreadable:') > 0),
        keptValue: keys.filter(k => k.indexOf(':unreadable:') > 0).map(k => localStorage.getItem(k))[0] || '',
        bannerShown: banner && !banner.classList.contains('hidden'),
        bannerText: banner ? banner.textContent : '',
        trips: STATE.trips.length,
      };
    });
    check('the damaged record is kept under its own key', out.kept);
    check('and kept verbatim, so a human could still read names out of it',
          /BROKEN/.test(out.keptValue), out.keptValue.slice(0, 40));
    check('the traveller is told their data could not be read', out.bannerShown && /could not be read/i.test(out.bannerText));
    check('demo trips are NOT invented over their data', out.trips === 0, `${out.trips} trips`);
    await page.close();
  }

  console.log('\nBackup and restore');
  {
    const page = await freshPage(browser);
    const out = await page.evaluate(() => {
      const dest = DESTINATIONS.find(d => d.id === 'paris');
      const t = buildPlannedTrip(dest, loadTripPreferences(), '2026-10-01', '2026-10-03', 2);
      STATE.trips = [t]; saveState();
      const backup = JSON.stringify({ format:'tripflow-backup', version:1, state: JSON.parse(JSON.stringify(STATE)) });
      STATE.trips = []; saveState();
      const restored = restoreStateBackup(backup);
      const afterGood = STATE.trips.length;
      // A file that is not a backup must not empty the trips it was meant to protect.
      const bad = restoreStateBackup('{"hello":"world"}');
      const notJson = restoreStateBackup('this is not json at all');
      return { restored, afterGood, badOk: bad.ok, badReason: bad.reason,
               notJsonOk: notJson.ok, survived: STATE.trips.length };
    });
    check('a backup restores the trips it contains', out.restored.ok && out.afterGood === 1,
          `${out.afterGood} trips`);
    check('a file that is not a backup is refused', out.badOk === false, out.badReason);
    check('unreadable JSON is refused', out.notJsonOk === false);
    check('a refused restore leaves existing trips untouched', out.survived === 1,
          `${out.survived} trips`);
    await page.close();
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0;
})();
