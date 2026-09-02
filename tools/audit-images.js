/* Renders the real site in Chromium and reports every image that fails to paint,
   every remaining grey placeholder, and any console/network error. */
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.env.TRIPFLOW_SHOTS || require('path').join(__dirname, '.shots');
const BASE = 'http://127.0.0.1:8099';

const ROUTES = [
  ['home',        '#/'],
  ['discover',    '#/discover'],
  ['dest-tokyo',  '#/destination/tokyo'],
  ['dest-bali',   '#/destination/bali'],
  ['dest-rome',   '#/destination/rome'],
  ['dest-santorini','#/destination/santorini'],
];

async function auditPage(page, name, hash, mobile){
  const errors = [], failedReq = [];
  page.removeAllListeners('console'); page.removeAllListeners('requestfailed');
  page.on('console', m => { if(m.type()==='error') errors.push(m.text().slice(0,200)); });
  page.on('requestfailed', r => failedReq.push(r.url().slice(0,120)));
  await page.goto(BASE + '/index.html' + hash, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  // Scroll the whole page so lazy images below the fold actually decode; otherwise they
  // read as "broken" simply because the browser has not been asked for them yet.
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for(let y = 0; y < document.body.scrollHeight; y += step){
      window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    document.querySelectorAll('img[loading="lazy"]').forEach(i => i.loading = 'eager');
  });
  await page.waitForTimeout(mobile ? 2600 : 3400);
  await page.evaluate(() => Promise.all(
    [...document.querySelectorAll('img')].map(i => i.complete ? null :
      new Promise(r => { i.addEventListener('load', r, {once:true});
                         i.addEventListener('error', r, {once:true});
                         setTimeout(r, 2500); }))));
  const stats = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')].filter(i => i.offsetParent !== null || i.closest('.view.active'));
    const broken = [], placeholder = [], tiny = [];
    for(const i of imgs){
      const src = i.currentSrc || i.src || '';
      if(!i.complete || i.naturalWidth === 0) broken.push(src.slice(0,110));
      else if(src.startsWith('data:image/svg')) placeholder.push((i.alt||'?').slice(0,40));
      else if(i.naturalWidth < 100) tiny.push(src.slice(0,110));
    }
    return { total: imgs.length, broken, placeholder, tiny };
  });
  const tag = name + (mobile ? '-mobile' : '');
  await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: !mobile });
  return { page: tag, ...stats, errors: errors.slice(0,6), failedReq: failedReq.slice(0,6) };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const results = [];
  for(const mobile of [false, true]){
    const ctx = await browser.newContext(mobile
      ? { viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true }
      : { viewport:{width:1440,height:950} });
    const page = await ctx.newPage();
    for(const [name, hash] of ROUTES) results.push(await auditPage(page, name, hash, mobile));
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(OUT + '/audit.json', JSON.stringify(results, null, 1));
  let bad = 0;
  for(const r of results){
    const flag = (r.broken.length || r.placeholder.length) ? 'FAIL' : ' ok ';
    if(r.broken.length || r.placeholder.length) bad++;
    console.log(`${flag} ${r.page.padEnd(22)} imgs=${String(r.total).padStart(3)} broken=${r.broken.length} placeholder=${r.placeholder.length} tiny=${r.tiny.length} consoleErr=${r.errors.length}`);
    r.broken.slice(0,3).forEach(b => console.log('        broken: ' + b));
    r.placeholder.slice(0,5).forEach(b => console.log('        placeholder: ' + b));
    r.errors.slice(0,3).forEach(b => console.log('        err: ' + b));
  }
  console.log(bad ? `\n${bad} page(s) with image problems` : '\nAll pages clean');
})();
