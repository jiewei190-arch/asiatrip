/* ============================================================================
 * currency.js — global currency detection, conversion and formatting.
 *
 * Replaces a 58-country / 31-currency hand-written table that silently answered "USD" for
 * everywhere it had not heard of, so a trip to Vietnam or Morocco was priced in dollars.
 * currency-data.js now carries the full ISO 3166 -> ISO 4217 mapping (245 countries, 152
 * currencies) and this file turns it into detection, live rates, conversion and formatting.
 *
 * Three rules:
 *   1. The currency for a destination comes from its VERIFIED country code, never from a guess
 *      at the name. "Georgia" the country uses GEL; Georgia the US state uses USD.
 *   2. Rates are fetched, cached with a timestamp, and never invented. If no rate is available
 *      the app says so and shows the local price alone — a made-up rate is a wrong price, and a
 *      wrong price is something a traveller might actually budget against.
 *   3. Formatting comes from Intl, so JPY shows no decimals, KWD shows three, and the symbol
 *      lands where that locale puts it instead of always in front.
 * ========================================================================== */

/* ---------------- catalogue ---------------- */

/** Every ISO 4217 code the browser knows, which is the whole active list on modern engines.
 *  Falls back to the codes present in the bundled country map, so the selector is still global
 *  on an engine without Intl.supportedValuesOf. */
function allCurrencyCodes(){
  try{
    if(typeof Intl !== 'undefined' && Intl.supportedValuesOf){
      const codes = Intl.supportedValuesOf('currency');
      if(codes && codes.length) return codes;
    }
  }catch(e){ /* fall through */ }
  return Array.from(new Set(Object.values(COUNTRY_CURRENCY))).sort();
}

let _currencyNames = null;
function currencyDisplayName(code){
  try{
    if(!_currencyNames && typeof Intl !== 'undefined' && Intl.DisplayNames){
      _currencyNames = new Intl.DisplayNames(['en'], {type:'currency'});
    }
    if(_currencyNames){
      const n = _currencyNames.of(code);
      if(n && n !== code) return n;
    }
  }catch(e){ /* fall through */ }
  return code;
}

/** The symbol this currency renders with, derived from Intl rather than a hand-kept table. */
function currencySymbol(code){
  try{
    const parts = new Intl.NumberFormat('en', {style:'currency', currency:code, currencyDisplay:'narrowSymbol'})
      .formatToParts(0);
    const sym = parts.find(p=>p.type==='currency');
    if(sym && sym.value) return sym.value;
  }catch(e){ /* unknown code */ }
  return code;
}

/** ISO 4217 minor units: 0 for JPY/KRW/VND, 3 for BHD/KWD/OMR/TND, 2 for most. */
function currencyDecimals(code){
  if(CURRENCY_MINOR_UNITS && CURRENCY_MINOR_UNITS[code] != null) return CURRENCY_MINOR_UNITS[code];
  try{
    return new Intl.NumberFormat('en', {style:'currency', currency:code})
      .resolvedOptions().maximumFractionDigits;
  }catch(e){ return 2; }
}

function isKnownCurrency(code){
  if(!code || !/^[A-Za-z]{3}$/.test(code)) return false;
  try{ new Intl.NumberFormat('en', {style:'currency', currency:code.toUpperCase()}).format(1); return true; }
  catch(e){ return false; }
}

/* ---------------- detection ---------------- */

/** The local currency for a destination, from its verified ISO country code.
 *  Returns null rather than defaulting to USD: not knowing is a real answer, and pricing
 *  Marrakech in dollars because the table was short is exactly the bug being fixed. */
function currencyForDestination(dest){
  if(!dest) return null;
  const cc = String(dest.countryCode || '').toUpperCase();
  if(cc && COUNTRY_CURRENCY[cc]) return COUNTRY_CURRENCY[cc];
  // A country name is a weaker signal than a code, so it is only consulted as a fallback.
  const name = String(dest.country || '').trim().toLowerCase();
  if(name){
    for(const [code2, n] of Object.entries(COUNTRY_NAMES)){
      if(String(n).toLowerCase() === name && COUNTRY_CURRENCY[code2]) return COUNTRY_CURRENCY[code2];
    }
  }
  return null;
}

/** Searchable across code, currency name and every country that uses it, so "won", "KRW",
 *  "South Korea" and "korea" all find the same entry. */
function searchCurrencies(query, limit){
  const q = String(query || '').trim().toLowerCase();
  const codes = allCurrencyCodes();
  const scored = [];
  for(const code of codes){
    const name = currencyDisplayName(code);
    const countries = (CURRENCY_COUNTRIES && CURRENCY_COUNTRIES[code]) || [];
    if(!q){ scored.push({code, name, countries, score:0}); continue; }
    const lc = code.toLowerCase(), ln = name.toLowerCase();
    let score = -1;
    if(lc === q) score = 100;
    else if(lc.indexOf(q) === 0) score = 90;
    else if(ln.indexOf(q) === 0) score = 80;
    else if(ln.indexOf(q) >= 0) score = 60;
    else if(countries.some(c=>String(c).toLowerCase().indexOf(q) === 0)) score = 50;
    else if(countries.some(c=>String(c).toLowerCase().indexOf(q) >= 0)) score = 30;
    if(score >= 0) scored.push({code, name, countries, score});
  }
  scored.sort((a,b)=> b.score - a.score || a.code.localeCompare(b.code));
  return limit ? scored.slice(0, limit) : scored;
}

/* ---------------- live rates ---------------- */

/* Two keyless providers, both CORS-open, checked from this project:
 *   - open.er-api.com          166 currencies, daily, returns its own update timestamp
 *   - @fawazahmed0/currency-api  340 currencies, served from jsdelivr's CDN
 * Frankfurter is deliberately NOT the primary: it is ECB data, so it covers 29 currencies and
 * has no VND, MAD or EGP — fine for Europe, useless for a global travel app. */
const RATE_PROVIDERS = [
  {
    name: 'open.er-api.com',
    url: base => `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`,
    parse: json => (json && json.result === 'success' && json.rates)
      ? {rates: json.rates, asOf: json.time_last_update_utc || null}
      : null,
  },
  {
    name: 'currency-api',
    url: base => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${encodeURIComponent(base.toLowerCase())}.min.json`,
    parse: (json, base) => {
      const table = json && json[base.toLowerCase()];
      if(!table) return null;
      const rates = {};
      for(const [k, v] of Object.entries(table)) rates[k.toUpperCase()] = v;
      return {rates, asOf: json.date || null};
    },
  },
];

const RATE_CACHE_PREFIX = 'tf:fx:';
const RATE_TTL_MS = 12 * 3600 * 1000;   // rates move slowly; refetching twice a day is plenty

function rateCacheKey(base){ return RATE_CACHE_PREFIX + base.toUpperCase(); }

function readRateCache(base){
  try{
    const raw = localStorage.getItem(rateCacheKey(base));
    if(!raw) return null;
    const box = JSON.parse(raw);
    if(!box || !box.fetchedAt) return null;
    box.stale = (Date.now() - box.fetchedAt) > RATE_TTL_MS;
    return box;
  }catch(e){ return null; }
}
function writeRateCache(base, box){
  try{ localStorage.setItem(rateCacheKey(base), JSON.stringify(box)); }catch(e){ /* optional */ }
}

const ratesInFlight = new Map();

/** Fetches a rate table for `base`, cached with the timestamp it was fetched at.
 *  On total failure returns a stale cache if there is one — clearly marked stale — and null
 *  otherwise. It never fabricates a rate. */
async function getRates(base, opts){
  base = String(base || 'USD').toUpperCase();
  opts = opts || {};
  const cached = readRateCache(base);
  if(cached && !cached.stale && !opts.fresh) return cached;
  if(ratesInFlight.has(base)) return ratesInFlight.get(base);

  const run = (async () => {
    for(const provider of RATE_PROVIDERS){
      try{
        const res = await fetch(provider.url(base), {headers:{'Accept':'application/json'}, signal: opts.signal});
        if(!res.ok) continue;
        const json = await res.json();
        const parsed = provider.parse(json, base);
        if(!parsed || !parsed.rates || !Object.keys(parsed.rates).length) continue;
        const box = {base, rates: parsed.rates, asOf: parsed.asOf, provider: provider.name,
                     fetchedAt: Date.now(), stale: false};
        writeRateCache(base, box);
        return box;
      }catch(e){ /* try the next provider */ }
    }
    // Every provider failed. A stale rate, labelled stale, beats no prices at all — but an
    // invented one would be worse than either.
    return cached || null;
  })();

  ratesInFlight.set(base, run);
  try{ return await run; }
  finally{ ratesInFlight.delete(base); }
}

/* ---------------- conversion ---------------- */

/** Converts an amount between currencies.
 *  Resolves to null when no rate is available, which callers must render as "no rate" rather
 *  than as a number. */
async function convertCurrency(amount, from, to, opts){
  from = String(from || '').toUpperCase();
  to = String(to || '').toUpperCase();
  if(!isFinite(amount)) return null;
  if(!from || !to) return null;
  if(from === to) return {amount, rate: 1, from, to, asOf: null, stale: false, provider: 'identity'};

  const box = await getRates(from, opts);
  if(box && box.rates && box.rates[to] != null){
    const rate = Number(box.rates[to]);
    if(isFinite(rate) && rate > 0){
      return {amount: amount * rate, rate, from, to, asOf: box.asOf, stale: !!box.stale, provider: box.provider};
    }
  }
  // Reverse lookup: providers publish a table per base, and the inverse of to->from is exact.
  const rev = await getRates(to, opts);
  if(rev && rev.rates && rev.rates[from] != null){
    const back = Number(rev.rates[from]);
    if(isFinite(back) && back > 0){
      const rate = 1 / back;
      return {amount: amount * rate, rate, from, to, asOf: rev.asOf, stale: !!rev.stale,
              provider: rev.provider + ' (inverted)'};
    }
  }
  return null;   // genuinely unsupported pair — say so, do not guess
}

/* ---------------- formatting ---------------- */

/** Formats money the way the currency itself is written: decimals per ISO 4217, symbol placed
 *  by Intl. Falls back to "1,200 XYZ" for a code Intl does not recognise rather than throwing. */
function formatMoney(amount, code, opts){
  opts = opts || {};
  if(amount == null || !isFinite(amount)) return '—';
  const cur = String(code || 'USD').toUpperCase();
  const decimals = currencyDecimals(cur);
  // Round trip fares to whole units; keep decimals on small amounts where they carry meaning.
  const maxFrac = opts.round && decimals > 0 ? 0 : decimals;
  try{
    return new Intl.NumberFormat(opts.locale || undefined, {
      style: 'currency', currency: cur,
      minimumFractionDigits: maxFrac, maximumFractionDigits: maxFrac,
      currencyDisplay: opts.code ? 'code' : 'narrowSymbol',
    }).format(amount);
  }catch(e){
    const n = new Intl.NumberFormat(opts.locale || undefined,
      {minimumFractionDigits: maxFrac, maximumFractionDigits: maxFrac}).format(amount);
    return `${n} ${cur}`;
  }
}

/** "₩12,000 (about $8.75)" — the local price is the real one and always leads; the conversion
 *  is an aid. When no rate exists the local price stands alone with an honest note. */
async function formatDualPrice(amount, localCode, displayCode, opts){
  opts = opts || {};
  const local = formatMoney(amount, localCode, opts);
  if(!displayCode || String(displayCode).toUpperCase() === String(localCode).toUpperCase()){
    return {text: local, local, converted: null, rate: null, stale: false};
  }
  const conv = await convertCurrency(amount, localCode, displayCode, opts);
  if(!conv){
    return {text: `${local} (no ${String(displayCode).toUpperCase()} rate available)`,
            local, converted: null, rate: null, stale: false, unsupported: true};
  }
  const converted = formatMoney(conv.amount, displayCode, opts);
  return {
    text: `${local} (about ${converted}${conv.stale ? ', rate may be out of date' : ''})`,
    local, converted, rate: conv.rate, stale: conv.stale, asOf: conv.asOf, provider: conv.provider,
  };
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    allCurrencyCodes, currencyDisplayName, currencySymbol, currencyDecimals, isKnownCurrency,
    currencyForDestination, searchCurrencies, getRates, convertCurrency, formatMoney,
    formatDualPrice, RATE_PROVIDERS,
  };
}
