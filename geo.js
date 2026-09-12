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
  // Region-scale places are destinations in their own right: people fly to Bali and to
  // Madeira, and ranking `state` at 70 and `archipelago` at 84 against `city` at 100 handed
  // both to same-named settlements — a town in Cameroon and a city of 9,000 in Ohio.
  city:100, town:82, island:92, archipelago:92, country:78, state:86, region:86, province:86,
  // A municipality is not a lesser thing than a town either. In Brazil, Norway, the
  // Philippines and much of Latin America it is the administrative form a city takes:
  // Salvador (2.4m) and Bergen (295k) both carry it, and at 62 both lost to villages abroad.
  county:60, municipality:80, village:58, borough:56, suburb:44, locality:46, peninsula:66,
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

/* ---------------- Disambiguation by notability ----------------
   Everything above ranks on string similarity and what KIND of place something is, and
   neither knows how well known a place is. That is what put Madeira, Ohio — a city of 9,487 —
   above the Portuguese archipelago, and what lets Photon's fuzzy matching hand "Hallstatt" to
   Halmstad in Sweden: a `city` outranks a `village` by 42 points, so a place the user did not
   type beats one they typed exactly.

   Three cheaper signals were tried first and measured over a bank of ambiguous names:

     - admin_level, free from Photon, is not comparable between countries. India numbers
       Hyderabad level 8 and Pakistan numbers its Hyderabad level 7, so the smaller city won.
       It bought Madeira and Bali by breaking Hyderabad, Valencia, Kingston and Bergen.
     - The area of the boundary box rewards American municipal sprawl: Athens, Georgia beat
       Athens, Greece and Birmingham, Alabama beat Birmingham.
     - Population, from the same Wikidata query used below, measures size rather than whether
       anyone travels there. Toledo, Ohio has three times the population of Toledo, Spain.

   What a travel planner means by "the one people mean" is notability, and Wikidata measures it
   directly: the number of Wikipedia language editions that carry an article. Rome has 343
   against Rome, New York's 52; Madeira 151 against Ohio's 36; Bergen, Norway 147 against the
   Dutch town's 50. It answers in about a fifth of a second and sends CORS headers.

   The one hazard is uneven coverage, and it is handled by construction rather than by tuning.
   P402 records OSM *relation* ids, and Photon returns a node for some cities and a relation for
   others — Athens, Greece is node N441183 with no entry at all, while Athens, Georgia is a
   relation with 80. Reading a missing link as "not notable" would hand Athens to Georgia and
   Birmingham to Alabama. So notability never compares a place against one it knows nothing
   about: it reorders the candidates it has measured among themselves and leaves every other
   position exactly as it found it. See geoDisambiguateByFame for why nothing weaker works. */
const GEO_USER_AGENT = 'TripFlow/1.0 (https://jiewei190-arch.github.io/asiatrip/)';
const GEO_FAME_CACHE_KEY = 'tf:geo:fame';
const GEO_FAME_BUDGET_MS = 4000;
const GEO_WDQS = 'https://query.wikidata.org/sparql';
/* Roughly where a place stops being known only to its own country. Anything at or above this
 * is left alone; below it, a candidate is pushed down in proportion to how far below. */
const GEO_FAME_ANCHOR = 110;
const GEO_FAME_WEIGHT = 30;
const GEO_FAME_FLOOR = -28;
/** A name typed exactly is strong evidence, and Photon's fuzzy matching is a guess about a
 *  typo. "Halmstad" is not a spelling of "Hallstatt". */
const GEO_FUZZY_PENALTY = 22;

function geoFameCache(){
  try { return JSON.parse(localStorage.getItem(GEO_FAME_CACHE_KEY)) || {}; }
  catch(e){ return {}; }
}
function geoFameCacheSet(map){
  try { localStorage.setItem(GEO_FAME_CACHE_KEY, JSON.stringify(map)); } catch(e){}
}

/** Demotion only, and never below the floor: a place nobody writes about in more than a
 *  handful of languages is unlikely to be the one that was meant, but a place Wikidata has
 *  nothing on has simply not been measured. */
function geoFameBonus(links){
  if(!links) return 0;                                   // unknown is unknown, never a penalty
  return Math.max(GEO_FAME_FLOOR, Math.min(0,
    Math.round(GEO_FAME_WEIGHT * Math.log10(links / GEO_FAME_ANCHOR))));
}

/** Is this name worth spending a request on? Only when several plausible answers sit close
 *  enough together that notability could change the order. "Reykjavik" and "Kyoto" name one
 *  place each and never reach Wikidata at all. */
function geoContested(ranked, query){
  if(!ranked || ranked.length < 2) return null;
  const top = ranked[0].score;
  const near = ranked.filter(r => r.osmId && (top - r.score) <= 45).slice(0, 8);
  if(near.length < 2) return null;
  const distinct = new Set(near.map(r => (r.countryCode || '?') + '|' + geoFold(r.name)));
  return distinct.size >= 2 ? near : null;
}

/** One SPARQL query for every contested candidate at once, matched on the OSM id Photon
 *  already gave us rather than on the name — the name is the ambiguous part. P402 holds
 *  relation ids, so nodes and ways are not asked about: querying them anyway matched Athens
 *  (node 441183) against a Czech village whose *relation* id is 441183, and reported the
 *  capital of Greece as a place of 1,085 people. */
async function geoFetchFame(cands){
  const ids = cands.map(c => /^R(\d+)$/.exec(c.osmId || '')).filter(Boolean).map(m => m[1]);
  const found = {};
  for(const c of cands) found[c.osmId] = 0;   // "asked, nothing known" — not looked up again
  if(!ids.length) return found;
  const sparql = `SELECT ?osmid ?links WHERE { VALUES ?osmid { ${
    ids.map(i => `"${i}"`).join(' ')} } ?item wdt:P402 ?osmid . ?item wikibase:sitelinks ?links . }`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_FAME_BUDGET_MS);
  try {
    const res = await fetch(`${GEO_WDQS}?format=json&query=${encodeURIComponent(sparql)}`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/sparql-results+json', 'User-Agent': GEO_USER_AGENT },
    });
    if(!res.ok) return {};
    const data = await res.json();
    for(const row of (((data.results || {}).bindings) || [])){
      const id = row.osmid && row.osmid.value;
      const links = Number(row.links && row.links.value);
      if(!id || !isFinite(links)) continue;
      // A city and its administrative twin can both claim the relation — Rome answers as both
      // "Rome" (343) and "Roma Capitale" (6). The better-connected article is the place itself.
      const key = 'R' + id;
      if(found[key] == null || links > found[key]) found[key] = links;
    }
    return found;
  } catch(e){ return {}; }
  finally { clearTimeout(timer); }
}

/** Re-ranks a contested list by notability, and demotes names that were never typed.
 *  Returns it untouched when the name is unambiguous, when Wikidata does not answer inside
 *  the budget, or when fewer than two candidates are known — several genuine ties have no
 *  article on either side, and an invented tiebreak is worse than the honest original order. */
async function geoDisambiguateByFame(ranked, query){
  const contested = geoContested(ranked, query);
  if(!contested) return ranked;

  const cache = geoFameCache();
  const missing = contested.filter(c => cache[c.osmId] === undefined);
  if(missing.length){
    const found = await geoFetchFame(missing);
    if(Object.keys(found).length){ Object.assign(cache, found); geoFameCacheSet(cache); }
  }
  const fameOf = r => (r.osmId && cache[r.osmId]) || 0;

  /* Stage one: names that were never typed.
   *
   * Photon offers near-spellings as well as matches, and the type table can float one above
   * the word actually typed: `city` outranks `village` by 42 points, so "Hallstatt" resolved
   * to Halmstad in Sweden. When some candidate matches the query exactly, a differently
   * spelled one has to earn its place — and it earns it only by being measurably better known
   * than a *known* exact match, as "Rome" is for the query "Roma" with 343 language editions
   * against Roma, Texas's 35. Where the exact match's notability is unknown, an alternative
   * spelling cannot prove itself and is treated as the typo suggestion it probably is; that is
   * what keeps "Nazare" on Nazaré in Portugal rather than moving it to Nazareth. */
  const folded = geoFold(String(query || '').trim());
  const exact = ranked.find(r => geoFold(r.name) === folded);
  const exactFame = exact ? fameOf(exact) : 0;
  let out = ranked.map(r => {
    const beatsExact = exactFame > 0 && fameOf(r) > exactFame;
    const fuzzy = exact && r !== exact && !geoStrongMatch(r.name, query) && !beatsExact;
    return Object.assign({}, r, {
      notability: fameOf(r) || null,
      score: r.score - (fuzzy ? GEO_FUZZY_PENALTY : 0),
    });
  }).sort((a, b) => b.score - a.score);

  /* Stage two: notability, compared only between places it actually knows about.
   *
   * P402 records OSM *relation* ids and Photon returns a node for some cities, so coverage is
   * uneven in a way no weighting can fix: Athens, Greece is node N441183 with no entry, while
   * Athens, Georgia is a relation with 80. An earlier version demoted the obscure and left
   * unknowns alone, which sounded safe and was not — demoting a known place past an unknown
   * one promotes the unknown just the same, and it moved Halifax from Nova Scotia to a town
   * in West Yorkshire. So notability may only reorder known candidates AMONG THEMSELVES: each
   * keeps the position it held, and only their order within those positions changes. A place
   * Wikidata has never heard of cannot win or lose on a measurement nobody took. */
  const known = [];
  out.forEach((r, i) => { if(fameOf(r) > 0) known.push(i); });
  if(known.length >= 2){
    const byFame = known
      .map(i => out[i])
      .sort((a, b) => (b.score + geoFameBonus(fameOf(b))) - (a.score + geoFameBonus(fameOf(a))));
    known.forEach((pos, k) => { out[pos] = byFame[k]; });
  }
  return out;
}

/* ---------------- Anchoring a region on a real place ----------------
   A country or a province has a centroid, and a centroid is not somewhere anybody goes.
   Indonesia's is at -2.483, 117.890 — open water in the Makassar Strait — so a country page
   searched the sea and found nothing.

   The first fix scanned the whole bounding box through Overpass for the largest city by
   population. It works: Indonesia anchors on Jakarta at 10,467,629. It also takes about two
   minutes when the mirrors are healthy and returns nothing at all when they are not, which on
   a public mirror is often; a browser run measured 796 seconds and still came back empty.

   Wikidata already knows the answer. A region's capital is a single direct property, P36, and
   it comes back in about two tenths of a second: Indonesia gives Jakarta, Madeira gives Funchal,
   Bali gives Denpasar, Tuscany gives Florence, Scotland gives Edinburgh. It is not always the
   largest city — Morocco answers Rabat rather than Casablanca, Brazil Brasilia rather than Sao
   Paulo — and that is fine for what the anchor is for: somewhere inside the region with real
   restaurants and hotels mapped around it, rather than a point in the sea. The Overpass scan
   stays as the fallback for regions with no capital recorded. */
async function geoCapitalOf(dest){
  // Either identifier: osmId as geoNormalize writes it, or the canonical placeId (`osm:R123`)
  // that Rule 1 guarantees every verified destination carries.
  const rel = /^R(\d+)$/.exec((dest && dest.osmId) || '') ||
              /^osm:R(\d+)$/.exec((dest && dest.placeId) || '');
  if(!rel) return null;
  const sparql = `SELECT ?capLabel ?pop ?coord WHERE { ?area wdt:P402 "${rel[1]}" ; wdt:P36 ?cap .` +
    ` ?cap wdt:P625 ?coord . OPTIONAL { ?cap wdt:P1082 ?pop . }` +
    ` SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_FAME_BUDGET_MS);
  try {
    const res = await fetch(`${GEO_WDQS}?format=json&query=${encodeURIComponent(sparql)}`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/sparql-results+json', 'User-Agent': GEO_USER_AGENT },
    });
    if(!res.ok) return null;
    const row = ((((await res.json()).results) || {}).bindings || [])[0];
    if(!row || !row.coord) return null;
    // Well-Known Text, and it is Point(LONGITUDE LATITUDE) — the opposite order to everything
    // else in this file. Reading it the other way round puts Jakarta in the Indian Ocean.
    const m = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(row.coord.value || '');
    if(!m) return null;
    const lng = Number(m[1]), lat = Number(m[2]);
    if(!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng, name: (row.capLabel && row.capLabel.value) || '',
             pop: row.pop ? Number(row.pop.value) || null : null };
  } catch(e){ return null; }
  finally { clearTimeout(timer); }
}

/** One best match for a typed string — used when the user commits (presses Enter) rather
 *  than picking a suggestion, so a typed destination still resolves to real coordinates.
 *  This is the path where getting it wrong is silent and expensive: nobody chose from a list,
 *  so a trip is simply built in the wrong country. It therefore looks at several candidates
 *  and pays for the population tiebreak, which typing never does. */
async function geoResolve(query){
  try {
    const results = await geoSearch(query, { limit: 8 });
    if(!results.length) return null;
    const settled = await geoDisambiguateByFame(results, query);
    return settled[0] || null;
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

/* Node sees this file as a module; the browser sees the same globals it always did.
 * The test suites import from here so they exercise the product's own ranking. A harness
 * that reimplements the logic it is checking tests something nobody ships — this suite
 * reported Medellin resolving to the Philippines for days after the app had been fixed,
 * because its private copy of the ranker had not been. */
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    GEO_TYPE_RANK, GEO_TYPE_LABEL, countryFlagEmoji,
    geoNormalize, geoFold, geoRank, geoDedupe, geoStrongMatch,
    geoFameBonus, geoContested, geoDisambiguateByFame,
    geoSearch, geoResolve, geoValidateDestination, geoCapitalOf,
  };
}
