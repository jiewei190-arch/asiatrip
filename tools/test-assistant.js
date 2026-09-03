/* Drives the REAL assistant in the real page and prints what it answers. */
const { chromium } = require('playwright');
const CASES = [
  // meta
  ['help', null],
  // destination facts, varied phrasing
  ['when should I visit Tokyo?', null],
  ['do I need a visa for Bali?', null],
  ['is Marrakech safe', null],
  ['how do I get around in Bangkok', null],
  ['what time is it in Reykjavik', null],
  ['how much per day in Paris', null],
  ['how many days should I spend in Rome', null],
  ['whats the weather like in Santorini', null],
  ['what language do they speak in Ljubljana', null],
  ['tipping in New York City?', null],
  // discovery
  ['hidden gems in Bali', null],
  ['where should I eat in Tokyo', null],
  ['cheap eats under $15 in Barcelona', null],
  ['romantic restaurants in Paris', null],
  ['free things to do in Rome', null],
  ['what if it rains in Bangkok', null],
  ['best photo spots in Santorini', null],
  ['where should I stay in Queenstown', null],
  // planning + edits (need a trip)
  ['plan 4 days in Tokyo', null],
  ['what does my trip look like', 'after-plan'],
  ['whats on day 2', 'after-plan'],
  ['optimise my route', 'after-plan'],
  ['day 1 is too packed', 'after-plan'],
  ['add more nightlife to day 2', 'after-plan'],
  ['how is my budget', 'after-plan'],
  ['make this cheaper', 'after-plan'],
  ['add Senso-ji to day 3', 'after-plan'],
  ['move it to day 1', 'after-plan'],
  ['remove Senso-ji', 'after-plan'],
  ['clear day 3', 'after-plan'],
  // conversational memory
  ['hidden gems in Tokyo', 'after-plan'],
  ['add the second one to day 2', 'after-plan'],
  // nonsense / fallback
  ['asdfgh qwerty', 'after-plan'],
  ['tell me a joke', 'after-plan'],
];
(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await b.newContext({viewport:{width:1280,height:900}});
  await ctx.addInitScript(()=>{try{const k='tripflow_state_v1';const s=JSON.parse(localStorage.getItem(k)||'{}');
    s.settings=Object.assign({},s.settings,{onboarded:true});localStorage.setItem(k,JSON.stringify(s));}catch(e){}});
  const p = await ctx.newPage();
  const errors = [];
  p.on('console', m => { if(m.type()==='error') errors.push(m.text().slice(0,160)); });
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message.slice(0,160)));
  await p.goto('http://127.0.0.1:8099/index.html#/', {waitUntil:'load'});
  await p.waitForTimeout(2500);

  for(const [msg] of CASES){
    const out = await p.evaluate(m => {
      const trip = (typeof plannerState !== 'undefined') ? getTrip(plannerState.tripId) : null;
      try { return assistantRespond(m, trip).reply; }
      catch(e){ return 'THREW: ' + e.message; }
    }, msg);
    const flat = String(out).replace(/\n/g, ' ⏎ ');
    console.log(`\n▸ ${msg}\n  ${flat.slice(0, 300)}${flat.length>300?'…':''}`);
  }
  console.log('\n--- console errors: ' + errors.length + ' ---');
  errors.slice(0,8).forEach(e=>console.log('  ' + e));
  await b.close();
})();
