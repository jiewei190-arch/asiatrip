const { chromium } = require('playwright');
const CASES = [
  '', '   ', '?', '!!!', 'a',
  'DAY 2 IS TOO PACKED',
  'day two is too packed',
  'im hungry in tokyo',
  'wheres good to eat',
  'what should i do in tokyo for 3 days',
  'plan me a cheap 5 day trip to lisbon',
  'i want somewhere romantic',
  'add <script>alert(1)</script> to day 1',
  '<img src=x onerror=alert(1)>',
  'add '.repeat(200) + 'tokyo',
  'optimise', 'optimize my route please',
  'make day 99 relaxed',
  'move the louvre to day 7',
  'remove something that does not exist',
  'what about day 3',
  'ok', 'thanks', 'yes',
];
(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0,120)));
  await p.goto('http://127.0.0.1:8099/index.html#/', {waitUntil:'load'});
  await p.waitForTimeout(2200);
  await p.evaluate(()=>{ const d=DESTINATIONS[0];
    const s=toDateInput(new Date(Date.now()+21*864e5));
    const t=buildAutoTrip(d.id,'Test Trip',s,addDays(s,3),2,'moderate');
    STATE.trips.unshift(t); saveState(); plannerState.tripId=t.id; });
  let threw = 0;
  for(const q of CASES){
    const r = await p.evaluate(m => {
      try { const out = assistantRespond(m, getTrip(plannerState.tripId));
            return (out && typeof out.reply === 'string' && out.reply.length) ? out.reply : 'EMPTY_REPLY'; }
      catch(e){ return 'THREW: ' + e.message; }
    }, q);
    if(/^THREW|EMPTY_REPLY/.test(r)){ threw++; console.log(`✗ ${JSON.stringify(q.slice(0,40))} -> ${r.slice(0,110)}`); }
    else console.log(`✓ ${JSON.stringify(q.slice(0,40))} -> ${r.replace(/\n/g,' ').slice(0,95)}`);
  }
  console.log(`\nfailures: ${threw}/${CASES.length} · page errors: ${errs.length}`);
  errs.forEach(e=>console.log('  '+e));
  await b.close();
})();
