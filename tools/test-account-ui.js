/* The account screen, driven the way somebody actually uses it.
 *
 * Three states, three different questions: where should trips be kept, who are you, and what is
 * happening with it. The failures worth guarding are the ones that lose trust rather than data:
 * a key rejected only after a confusing 401 much later, a menu that still says "Connect an
 * account" once you have, and — the one that matters most — an account screen that manages to
 * lose the trips already on the device.
 *
 * The signed-in state runs against a mocked client. That proves the wiring, not a real round
 * trip; a real one needs project credentials.
 *
 *   node tools/test-account-ui.js      (needs a static server on :8099)
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
      const res = await fetch(u, { method: req.method(), headers: req.headers() });
      route.fulfill({ status: res.status, body: Buffer.from(await res.arrayBuffer()),
        headers: Object.assign({}, Object.fromEntries(res.headers), {'access-control-allow-origin':'*'}) });
    } catch(e){ route.abort(); }
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const s = document.getElementById('onboardSkip'); if(s) s.click(); });

  console.log('\nWith no project connected');
  {
    const r = await page.evaluate(() => { openAccountModal();
      return { menu: document.getElementById('accountMenuLabel').textContent }; });
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => ({
      setupShown: !!document.getElementById('acctUrl'),
      mentionsSchema: document.getElementById('accountBody').textContent.includes('schema.sql'),
      warnsAboutServiceRole: document.getElementById('accountBody').textContent.includes('service_role'),
      optional: document.getElementById('accountSub').textContent.toLowerCase().includes('optional'),
    }));
    check('the setup form is shown', s.setupShown);
    check('the menu invites connecting one', r.menu === 'Connect an account', r.menu);
    check('it says which file to run in Supabase', s.mentionsSchema);
    check('it warns off the service_role key', s.warnsAboutServiceRole,
          'pasting that one would hand out a master key');
    check('it says an account is optional', s.optional,
          'the app worked without one and still does');
  }

  console.log('\nBad details are refused now, not with a 401 later');
  {
    const r = await page.evaluate(() => {
      document.getElementById('acctUrl').value = 'https://abcdefghijklm.supabase.co';
      document.getElementById('acctKey').value = 'abcdefghijklm';     // a project ref, not a key
      document.getElementById('acctSaveCfg').click();
      return { msg: document.getElementById('acctCfgMsg').textContent, configured: cloudConfigured() };
    });
    check('a project ref pasted as the key is refused', r.configured === false);
    check('and the message says where the real key is', /anon public/i.test(r.msg), r.msg);

    const bad = await page.evaluate(() => {
      document.getElementById('acctUrl').value = 'https://example.com';
      document.getElementById('acctKey').value = 'aaa.bbb.ccc';
      document.getElementById('acctSaveCfg').click();
      return { configured: cloudConfigured(), msg: document.getElementById('acctCfgMsg').textContent };
    });
    check('a URL that is not a Supabase project is refused', bad.configured === false, bad.msg);
  }

  console.log('\nOnce connected');
  {
    await page.evaluate(() => {
      document.getElementById('acctUrl').value = 'https://abcdefghijklm.supabase.co';
      document.getElementById('acctKey').value = 'aaa.bbb.ccc';
      document.getElementById('acctSaveCfg').click();
    });
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => ({
      signInShown: !!document.getElementById('acctEmail'),
      hasReset: !!document.getElementById('acctReset'),
      menu: document.getElementById('accountMenuLabel').textContent,
      reassures: document.getElementById('accountSub').textContent.toLowerCase().includes('this device'),
    }));
    check('the sign-in form replaces the setup form', s.signInShown);
    check('a password reset is offered', s.hasReset);
    check('the menu updates immediately', s.menu === 'Sign in', s.menu);
    check('it still says the trips stay on this device', s.reassures);
  }

  console.log('\nSigning in and syncing, against a mocked project');
  {
    const out = await page.evaluate(async () => {
      const before = STATE.trips.length;
      const calls = { upserts: [] };
      __setCloudClientForTests({
        auth: {
          signInWithPassword: async () => ({ data: { user: { id:'u1', email:'you@example.com' } }, error: null }),
          getUser: async () => ({ data: { user: { id:'u1', email:'you@example.com' } } }),
          signOut: async () => ({}),
        },
        from: () => ({
          select: () => ({ eq: async () => ({ data: [
            { id:'cloud-only', data:{ id:'cloud-only', title:'From another device', days:[], budget:{total:0} },
              updated_at:'2026-05-02T00:00:00Z', deleted:false }], error: null }) }),
          upsert: async (rows) => { calls.upserts.push(rows); return { error: null }; },
        }),
      });
      document.getElementById('acctEmail').value = 'you@example.com';
      document.getElementById('acctPass').value = 'hunter2hunter2';
      document.getElementById('acctSignIn').click();
      await new Promise(r => setTimeout(r, 1500));
      return { before, after: STATE.trips.length,
               pulledTitle: (STATE.trips.find(t => t.id === 'cloud-only') || {}).title,
               pushedCount: calls.upserts.reduce((a, r) => a + r.length, 0),
               title: document.getElementById('accountTitle').textContent,
               sub: document.getElementById('accountSub').textContent };
    });
    check('signing in shows the signed-in state', out.title === 'Signed in', out.title);
    check('and names the account', out.sub === 'you@example.com', out.sub);
    check('a trip from another device is pulled in', out.pulledTitle === 'From another device');
    check('local trips are NOT lost in the process', out.after >= out.before,
          `${out.before} before, ${out.after} after`);
    check('and the local ones are sent up', out.pushedCount >= out.before, `${out.pushedCount} pushed`);
  }

  check('the page threw nothing', errors.length === 0, errors.slice(0,2).join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('NOTE: the signed-in section uses a mocked client. A real round trip is unverified.\n');
  process.exitCode = fail ? 1 : 0;
})();
