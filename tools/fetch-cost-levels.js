/* Regenerates costlevels.js from the World Bank.
 *
 *   node tools/fetch-cost-levels.js > ../costlevels.js     (or --write)
 *
 * Two indicators, same source, same year per country, so the ratio between them is meaningful:
 *   PA.NUS.PRVT.PP  PPP conversion factor, private consumption (local currency per int'l $)
 *   PA.NUS.FCRF     official exchange rate, period average     (local currency per US$)
 * Their quotient is the country's price level against the United States at 1.00.
 *
 * Keyless. World Bank data is CC BY 4.0. Re-run once a year; the app states the vintage.
 */
const fs = require('fs'), path = require('path');
const API = 'https://api.worldbank.org/v2/country/all/indicator/';
const BAND = [0.15, 1.60];   // outside this the official rate is not what anyone pays — see costlevels.js

async function series(indicator){
  const res = await fetch(`${API}${indicator}?format=json&per_page=20000&mrnev=1`);
  if(!res.ok) throw new Error(`${indicator}: HTTP ${res.status}`);
  const body = await res.json();
  const out = new Map();
  for(const r of (body[1] || [])){
    const id = r.country && r.country.id;
    if(r.value == null || !id || id.length !== 2) continue;
    out.set(id, {value: r.value, year: r.date, name: r.country.value});
  }
  return out;
}

(async () => {
  const [ppp, fx] = await Promise.all([series('PA.NUS.PRVT.PP'), series('PA.NUS.FCRF')]);
  const levels = {}, skipped = [], years = [];
  for(const [iso, p] of ppp){
    const f = fx.get(iso);
    if(!f || !f.value){ skipped.push(iso); continue; }
    const v = p.value / f.value;
    if(v < BAND[0] || v > BAND[1]){ skipped.push(iso); continue; }
    levels[iso] = Math.round(v * 100) / 100;
    years.push(p.year);
  }
  years.sort();
  console.error(`${Object.keys(levels).length} countries in band, ${skipped.length} excluded: ${skipped.join(' ')}`);
  console.error(`vintage ${years[0]}–${years[years.length-1]}`);
  const target = path.join(path.dirname(__dirname), 'costlevels.js');
  const current = fs.readFileSync(target, 'utf8');
  const next = current
    .replace(/const COUNTRY_PRICE_LEVEL = \{[^}]*\};/,
      'const COUNTRY_PRICE_LEVEL = {' +
        Object.keys(levels).sort().map(k => `${k}:${levels[k]}`).join(', ') + '};')
    .replace(/const COUNTRY_PRICE_LEVEL_VINTAGE = '[^']*';/,
      `const COUNTRY_PRICE_LEVEL_VINTAGE = '${years[0]}–${years[years.length-1]}';`);
  if(process.argv.includes('--write')){
    fs.writeFileSync(target, next);
    console.error('costlevels.js updated');
  } else {
    console.error('(dry run — pass --write to update costlevels.js)');
  }
})().catch(e => { console.error(String(e)); process.exitCode = 1; });
