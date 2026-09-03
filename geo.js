/* ============================================================
   TripFlow — global destination search

   The autocomplete used to filter the twelve curated destinations and nothing else, so
   typing "Beijing" produced "No matches" even though the app could already build a Beijing
   trip once you pressed Enter. This module makes discovery as global as the rest of the app:
   every city, town, island, region, country, park and landmark on Earth, looked up live,
   with nothing about them stored in the repo.

   Providers, in order, both keyless and CORS-enabled:

     1. Photon (photon.komoot.io) — an OSM geocoder built specifically for type-ahead.
        Returns structured place data and, with lang=en, English names ("Beijing", not
        "北京市"). This answers almost everything.
     2. Wikipedia search — for the cases Photon cannot. Loose tourist regions are often
        absent from OSM as searchable places ("Amalfi Coast" returns a footpath in
        Australia), and abbreviations are not geocoder input ("NYC"). Wikipedia's relevance
        ranking resolves both, and its answer is fed BACK through Photon so the result still
        carries full structured data.

   Nominatim is deliberately not used: its usage policy forbids autocomplete, and it refused
   these queries outright when tested.

   Everything is cached, debounced and cancellable — see the notes on each.
============================================================ */

const GEO_PHOTON = 'https://photon.komoot.io/api/';
const GEO_WIKI = 'https://en.wikipedia.org/w/api.php';
const GEO_CACHE_KEY = 'tripflow_geo_search_v1';
const GEO_CACHE_TTL_MS = 30 * 24 * 3600 * 1000;   // place names and coordinates barely change
const GEO_CACHE_MAX = 400;

/* ---------------- Travel relevance ----------------
   OSM describes every object on the map; a traveller wants a small slice of it. Only these
   place kinds may appear, which is what keeps a railway station out of the results for
   "Beijing", hospitals out of "NYC", and a Sydney footpath out of "Amalfi Coast".
   The number is the ranking weight: what a holiday planner should see first. */
const GEO_TYPE_RANK = {
  city:100, town:82, island:88, archipelago:84, country:78, state:70, region:74, province:70,
  county:60, municipality:62, village:58, borough:56, suburb:44, locality:46, peninsula:66,
  national_park:86, nature_reserve:64, protected_area:62, attraction:72, monument:58,
  castle:58, ruins:56, archaeological_site:58, museum:50, theme_park:52, zoo:46,
  viewpoint:50, peak:64, volcano:64, glacier:58, bay:60, beach:68, fjord:62, lake:56,
  hamlet:34, isolated_dwelling:0,
};
/** Human wording for the badge on each result row. */
const GEO_TYPE_LABEL = {
  city:'City', town:'Town', village:'Village', hamlet:'Village', borough:'Borough',
  suburb:'Neighbourhood', locality:'Locality', municipality:'Municipality', county:'County',
  island:'Island', archipelago:'Islands', peninsula:'Peninsula', country:'Country',
  state:'State', province:'Province', region:'Region', national_park:'National park',
  nature_reserve:'Nature reserve', protected_area:'Protected area', attraction:'Landmark',
  monument:'Monument', castle:'Castle', ruins:'Ruins', archaeological_site:'Historic site',
  museum:'Museum', theme_park:'Theme park', zoo:'Zoo', viewpoint:'Viewpoint', peak:'Mountain',
  volcano:'Volcano', glacier:'Glacier', bay:'Bay', beach:'Beach', fjord:'Fjord', lake:'Lake',
};

/** A flag from an ISO 3166-1 alpha-2 code, computed rather than tabulated: the two regional
 *  indicator symbols sit at a fixed offset from A–Z, so every country on Earth works without
 *  a lookup table to maintain. */
function countryFlagEmoji(cc){
  if(!cc || cc.length !== 2 || !/^[a-z]{2}$/i.test(cc)) return '🌍';
  const base = 0x1F1E6 - 'A'.charCodeAt(0);
  return String.fromCodePoint(...cc.toUpperCase().split('').map(c => base + c.charCodeAt(0)));
}

/* ---------------- Cache ---------------- */
let __geoMem = null;
function geoCache(){
  if(!__geoMem){
    try { __geoMem = JSON.parse(localStorage.getItem(GEO_CACHE_KEY)) || {}; }
    catch(e){ __geoMem = {}; }
  }
  return __geoMem;
}
function geoCacheGet(key){
  const hit = geoCache()[key];
  if(!hit || (Date.now() - hit.ts) > GEO_CACHE_TTL_MS) return null;
  return hit.results;
}
function geoCacheSet(key, results){
  const cache = geoCache();
  cache[key] = { ts: Date.now(), results };
  const keys = Object.keys(cache);
  if(keys.length > GEO_CACHE_MAX){
    keys.sort((a,b) => cache[a].ts - cache[b].ts).slice(0, keys.length - GEO_CACHE_MAX)
        .forEach(k => delete cache[k]);
  }
  try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache)); } catch(e){}
}

/* ---------------- Normalising ----------------
   Every provider is reduced to one shape, so the rest of the app never has to know which
   one answered — this is the object that flows into trips, maps, weather and imagery. */
function geoNormalize(props, lat, lng){
  const name = props.name || '';
  const cc = (props.countrycode || '').toUpperCase();
  const type = props.osm_value || props.type || 'place';
  // The line under the name: the most useful geographic context available, never repeating
  // the name itself ("Beijing, Beijing, China" reads like a bug).
  const parts = [props.state, props.county, props.country]
    .filter(Boolean)
    .filter(v => v.toLowerCase() !== name.toLowerCase());
  const seen = new Set();
  const context = parts.filter(v => { const k = v.toLowerCase(); if(seen.has(k)) return false; seen.add(k); return true; });
  return {
    name,
    country: props.country || '',
    countryCode: cc,
    region: props.state || props.county || '',
    lat, lng,
    type,
    typeLabel: GEO_TYPE_LABEL[type] || 'Place',
    flag: countryFlagEmoji(cc),
    displayName: [name, ...context].join(', '),
    context: context.join(', '),
    osmId: props.osm_id ? `${props.osm_type || ''}${props.osm_id}` : null,
    // The canonical identifier for this place. OSM's type+id pair is stable and globally
    // unique — the keyless equivalent of a Google Place ID — and everything downstream keys
    // off it rather than off the name, because names are ambiguous and collide.
    // Photon returns extent as [minLon, maxLat, maxLon, minLat] — a real boundary box, which is
    // a far better containment test for a large area than a circle around its centroid.
    bbox: (Array.isArray(props.extent) && props.extent.length === 4)
      ? { minLng: Math.min(props.extent[0], props.extent[2]), maxLng: Math.max(props.extent[0], props.extent[2]),
          minLat: Math.min(props.extent[1], props.extent[3]), maxLat: Math.max(props.extent[1], props.extent[3]) }
      : null,
    placeId: props.osm_id ? `osm:${props.osm_type || 'x'}${props.osm_id}`
                          : `geo:${(props.name||'').toLowerCase().replace(/\s+/g,'-')}:${cc||'--'}:${(lat||0).toFixed(3)},${(lng||0).toFixed(3)}`,
    source: 'photon',
    verified: true,
  };
}

/* ---------------- Provider 1: Photon ---------------- */
async function geoPhoton(query, signal, limit){
  const url = `${GEO_PHOTON}?q=${encodeURIComponent(query)}&limit=${limit || 20}&lang=en`;
  const res = await fetch(url, { signal });
  if(!res.ok) throw new Error('photon ' + res.status);
  const data = await res.json();
  const out = [];
  const seen = new Set();
  for(const f of (data.features || [])){
    const p = f.properties || {};
    const rank = GEO_TYPE_RANK[p.osm_value];
    if(!rank) continue;                                  // not a place a traveller plans around
    if(!p.name) continue;
    const key = `${p.name.toLowerCase()}|${(p.countrycode||'').toLowerCase()}|${p.osm_value}`;
    if(seen.has(key)) continue;
    seen.add(key);
    const coords = (f.geometry || {}).coordinates || [];
    const item = geoNormalize(p, coords[1], coords[0]);
    item.typeRank = rank;
    item.providerIndex = out.length;     // position among travel-relevant hits, best first
    out.push(item);
  }
  return out;
}

/* ---------------- Provider 2: Wikipedia ----------------
   Only consulted when Photon returns nothing usable. Handles the two things a geocoder is
   bad at: tourist regions with no crisp OSM boundary, and abbreviations. */
async function geoWikipedia(query, signal){
  const url = `${GEO_WIKI}?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}` +
              `&gsrlimit=4&prop=coordinates&colimit=10&format=json&origin=*`;
  const res = await fetch(url, { signal });
  if(!res.ok) throw new Error('wiki ' + res.status);
  const data = await res.json();
  const pages = Object.values(((data.query || {}).pages) || {});
  return pages
    .filter(p => (p.coordinates || [])[0])
    .sort((a,b) => (a.index || 9) - (b.index || 9))
    .map(p => ({ title: p.title, lat: p.coordinates[0].lat, lng: p.coordinates[0].lon }));
}

/** Fills in country/region for a bare coordinate, so a Wikipedia-sourced result still
 *  arrives with the same structured fields as a Photon one. */
async function geoReverse(lat, lng, signal){
  try {
    const res = await fetch(`${GEO_PHOTON.replace('/api/','/reverse')}?lat=${lat}&lon=${lng}&lang=en`, { signal });
    if(!res.ok) return {};
    const data = await res.json();
    return ((data.features || [])[0] || {}).properties || {};
  } catch(e){ return {}; }
}

/* ---------------- Ranking ----------------
   Photon already orders by prominence, which is most of what "travel relevance" means, so
   its position is the dominant term. Re-ranking purely on the typed string got this wrong:
   an exact-name bonus put Roma, Texas (population 11,000) above Rome, because "Roma" matches
   one letter-for-letter and "Rome" does not. Type weight and a modest string bonus adjust
   the provider's order rather than replacing it. */
/** Folds accents so a name typed on an English keyboard matches the place as it is spelled.
 *  Without this "Medellin" never exactly matches "Medellín", "Malaga" never matches "Málaga"
 *  and "Zurich" never matches "Zürich" — and the exact-match bonus goes to whichever unaccented
 *  namesake happens to exist somewhere else in the world. */
function geoFold(s){
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function geoRank(results, query){
  const q = geoFold(query.trim());
  return results.map(r => {
    const name = geoFold(r.name);
    /* What decides the winner, in order of how much it should matter:
     *
     * Provider order used to dominate at x20 against a x0.5 weight on the kind of place, which
     * meant Photon's string-similarity ranking decided everything. Typing "Medellin" returned a
     * town of 50,000 in the Philippines above the Colombian city of two and a half million,
     * because the Philippine spelling carries no accent and therefore matched the typed string
     * more literally. Photon does not know which place a traveller means; what kind of place it
     * is, and whether it is a mapped administrative area at all, are much better evidence. */
    let s = 120 - (r.providerIndex || 0) * 3;   // still counts, no longer decides
    s += (r.typeRank || 0);                     // a city genuinely outranks a hamlet

    /* No bonus for carrying a boundary box, tempting though it looks. Whether OSM happens to
     * hold an extent for a place says more about mapping effort than importance: Gothenburg in
     * Sweden has none while Gothenburg, Nebraska does, and an 18-point bonus for it put a
     * village of 3,500 above a city of 600,000. What KIND of place it is already carries that
     * meaning, honestly. */

    if(name === q) s += 25;                     // the strongest signal there is
    else if(name.startsWith(q)) s += 12;
    // "Tokyo" should not return "Tokyo International Airport". A result whose name is much
    // longer than what was typed is a different, more specific thing that merely contains it.
    if(name !== q && name.length > q.length * 1.6) s -= 10;
    if(r.country && geoFold(r.country) === q) s += 30;
    return Object.assign({}, r, { score: s });
  }).sort((a,b) => b.score - a.score);
}

/** Does this result plausibly answer what was typed?
 *  "NYC" matched "Nychyporivka" — a Ukrainian village that happens to start with those three
 *  letters — which looked like a hit and suppressed the fallback that would have found New
 *  York City. A prefix only counts when the result is not wildly longer than the query. */
function geoStrongMatch(name, q){
  const n = geoFold(name);
  q = geoFold(q);
  if(!n || !q) return false;
  if(n === q) return true;
  if(n.startsWith(q) && n.length <= q.length + 4) return true;
  if(q.startsWith(n) && q.length <= n.length + 4) return true;
  return new RegExp(`(^|\\s)${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(n);
}

/** Collapses suggestions a user could not tell apart.
 *  "Victoria" returned two rows both reading "Victoria — Texas, United States": OSM carries
 *  the county and the city as separate places, and to a traveller they are one destination.
 *  Identical name + country + region keeps only the most travel-relevant type, so every row
 *  in the list is distinguishable from every other by what it actually shows. */
function geoDedupe(results){
  const best = new Map();
  for(const r of results){
    const key = [r.name, r.countryCode, r.region].join('|').toLowerCase();
    const prev = best.get(key);
    if(!prev || (r.typeRank || 0) > (prev.typeRank || 0)) best.set(key, r);
  }
  // Map preserves insertion order, and the input is already ranked, so ordering survives.
  return results.filter(r => best.get([r.name, r.countryCode, r.region].join('|').toLowerCase()) === r);
}

/* ---------------- Public search ----------------
   `signal` cancels a request whose answer is already stale because the user kept typing. */
async function geoSearch(query, options){
  const opts = options || {};
  const q = String(query || '').trim();
  if(q.length < 2) return [];
  const key = q.toLowerCase();

  const cached = geoCacheGet(key);
  if(cached) return cached;

  let results = [];
  try {
    results = await geoPhoton(q, opts.signal, 20);
  } catch(e){
    if(e.name === 'AbortError') throw e;
    results = [];
  }

  const weak = !results.slice(0, 3).some(r => geoStrongMatch(r.name, key));
  if(!results.length || weak){
    // Photon had nothing travel-relevant. Ask Wikipedia what this name means, then look the
    // ANSWER up in Photon — that turns "NYC" into a fully structured New York City rather
    // than a bare coordinate, and only falls back to raw coordinates for places Photon
    // genuinely does not carry (loose regions like the Amalfi Coast).
    try {
      const hits = await geoWikipedia(q, opts.signal);
      for(const hit of hits.slice(0, 2)){
        let viaPhoton = [];
        try { viaPhoton = await geoPhoton(hit.title, opts.signal, 8); } catch(e){ if(e.name === 'AbortError') throw e; }
        if(viaPhoton.length){
          // Prepend rather than replace: Photon's own hits may still be right for another
          // reading of the query, but the resolved name is the more likely intent.
          const names = new Set(viaPhoton.map(r => r.name.toLowerCase()));
          results = viaPhoton.concat(results.filter(r => !names.has(r.name.toLowerCase())));
          break;
        }
      }
      if(!results.length && hits.length){
        const hit = hits[0];
        const rev = await geoReverse(hit.lat, hit.lng, opts.signal);
        const item = geoNormalize(
          { name: hit.title, country: rev.country, countrycode: rev.countrycode,
            state: rev.state, county: rev.county, osm_value: 'region' },
          hit.lat, hit.lng);
        item.source = 'wikipedia';
        item.score = GEO_TYPE_RANK.region;
        results = [item];
      }
    } catch(e){
      if(e.name === 'AbortError') throw e;
    }
  }

  const ranked = geoDedupe(geoRank(results, q)).slice(0, opts.limit || 8);
  if(ranked.length) geoCacheSet(key, ranked);
  return ranked;
}

/** One best match for a typed string — used when the user commits (presses Enter) rather
 *  than picking a suggestion, so a typed destination still resolves to real coordinates. */
async function geoResolve(query){
  try {
    const results = await geoSearch(query, { limit: 1 });
    return results[0] || null;
  } catch(e){ return null; }
}

/* ---------------- Consistency validation ----------------
   One destination, one identity. This is the guard that makes "Seoul, Korea" under the
   heading "Malaysia" impossible: every field must have come from the same resolved place,
   and a destination that cannot prove it is rejected rather than rendered. */
function geoValidateDestination(dest){
  const problems = [];
  if(!dest) return { ok:false, problems:['no destination'] };
  if(!dest.name) problems.push('missing name');
  if(dest.__geo){
    if(!dest.placeId) problems.push('verified destination without a canonical place id');
    if(dest.lat == null || dest.lng == null) problems.push('missing coordinates');
    if(Math.abs(dest.lat) > 90 || Math.abs(dest.lng) > 180) problems.push('coordinates out of range');
    // A country label that did not come from the same resolution is exactly the bug this
    // guards against, so the pair is checked rather than trusted.
    if(dest.country && dest.countryCode){
      const flagFromCode = countryFlagEmoji(dest.countryCode);
      if(dest.flag && dest.flag !== flagFromCode) problems.push('flag does not match country code');
    }
    if(dest.country && !dest.countryCode) problems.push('country without a country code');
  }
  return { ok: problems.length === 0, problems };
}
