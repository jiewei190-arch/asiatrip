/* ============================================================================
 * places.js — real places, discovered.
 *
 * Everything a destination page lists (restaurants, places to stay, things to do) is a real
 * entity from OpenStreetMap, found by searching around the destination's VERIFIED coordinates.
 *
 * What this replaces: six restaurants per destination with invented names ("Market Street
 * Kitchen"), invented star ratings (4.2 + rnd()*0.6), invented review counts and coordinates
 * scattered around a point that was itself invented. The ratings were the worst part — a
 * random number rendered as "★ 4.8" is indistinguishable from real review data.
 *
 * Two rules follow from that and are enforced below:
 *   1. Every record traces to an OSM element with a canonical id. No entity is ever synthesised.
 *   2. A field is present only if the data actually contains it. We have no ratings, no review
 *      counts and mostly no prices, so those are null — never filled in to look complete.
 *
 * Keyless by design: Overpass carries the full tag set, Photon is the fast fallback. No API key
 * for either, and both send Access-Control-Allow-Origin: * so the browser can call them directly.
 * ========================================================================== */

/* ---------------- endpoints ---------------- */

// Measured from this project: private.coffee ~4.4s, kumi ~15s, overpass-api.de refused the
// connection outright. Ordered by observed reliability, and we rotate on failure rather than
// giving up — a single mirror being down must not empty a destination page.
const PLACES_USER_AGENT = 'TripFlow/1.0 (https://jiewei190-arch.github.io/asiatrip/)';
const OVERPASS_ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
let overpassCursor = 0;

const PHOTON_REVERSE = 'https://photon.komoot.io/reverse';

/* ---------------- what counts as what ---------------- */

/* Broad coverage is a requirement, not a nicety: someone looking for dinner wants the street-
 * food stall and the tasting menu in the same list. These are OSM's own tag values.
 *
 * `nw` (nodes and ways) rather than `nwr`: including relations made the Seoul hotel query time
 * out at 82 seconds and return an empty result, while the same query without them answered in
 * 16. Almost nothing in these categories is mapped as a relation, so the coverage cost is
 * negligible and the reliability gain is the difference between a full page and a blank one. */
const PLACE_KINDS = {
  restaurant: {
    overpass: [
      'nw[amenity~"^(restaurant|cafe|fast_food|bar|pub|bakery|ice_cream|food_court|biergarten|deli)$"][name]',
    ],
    photonTags: ['amenity:restaurant', 'amenity:cafe', 'amenity:fast_food', 'amenity:bakery', 'amenity:bar'],
    label: 'places to eat',
  },
  hotel: {
    overpass: [
      'nw[tourism~"^(hotel|hostel|guest_house|motel|apartment|chalet|alpine_hut|camp_site|caravan_site)$"][name]',
      'nw[leisure=resort][name]',
    ],
    photonTags: ['tourism:hotel', 'tourism:hostel', 'tourism:guest_house', 'tourism:motel', 'tourism:apartment'],
    label: 'places to stay',
  },
  attraction: {
    overpass: [
      'nw[tourism~"^(attraction|museum|viewpoint|gallery|artwork|theme_park|zoo|aquarium|picnic_site)$"][name]',
      'nw[historic~"^(castle|monument|memorial|ruins|archaeological_site|palace|city_gate|fort|tower)$"][name]',
      'nw[leisure~"^(park|garden|nature_reserve|beach_resort)$"][name]',
    ],
    photonTags: ['tourism:attraction', 'tourism:museum', 'tourism:viewpoint', 'leisure:park'],
    label: 'things to do',
  },
};

/* Human labels for the OSM value, so a card can say "Bakery" rather than "fast_food". */
const OSM_SUBTYPE_LABEL = {
  restaurant:'Restaurant', cafe:'Café', fast_food:'Casual & street food', bar:'Bar', pub:'Pub',
  bakery:'Bakery', ice_cream:'Ice cream', food_court:'Food court', biergarten:'Beer garden', deli:'Deli',
  hotel:'Hotel', hostel:'Hostel', guest_house:'Guest house', motel:'Motel', apartment:'Apartment',
  chalet:'Chalet', alpine_hut:'Mountain hut', camp_site:'Campsite', caravan_site:'Caravan park', resort:'Resort',
  attraction:'Attraction', museum:'Museum', viewpoint:'Viewpoint', gallery:'Gallery', artwork:'Public art',
  theme_park:'Theme park', zoo:'Zoo', aquarium:'Aquarium', picnic_site:'Picnic spot',
  castle:'Castle', monument:'Monument', memorial:'Memorial', ruins:'Ruins',
  archaeological_site:'Archaeological site', palace:'Palace', city_gate:'City gate', fort:'Fort', tower:'Tower',
  park:'Park', garden:'Garden', nature_reserve:'Nature reserve', beach_resort:'Beach',
};

/* OSM cuisine values are lowercase, semicolon-separated and occasionally underscored. */
function prettyCuisine(raw){
  if(!raw) return '';
  return String(raw).split(';').slice(0,3)
    .map(c=>c.trim().replace(/_/g,' ').replace(/\b\w/g, m=>m.toUpperCase()))
    .filter(Boolean).join(' · ');
}

/* ---------------- fetch plumbing ---------------- */

const PLACES_TIMEOUT_MS = 25000;
/* How long to let Overpass work before Photon is allowed to answer instead. Measured healthy
 * Overpass responses in this project run 4-16s, so this waits out a normal slow one and gives up
 * on a stuck mirror rather than on the query. */
const OVERPASS_PATIENCE_MS = 20000;
/* After Photon has answered, keep waiting this much longer for Overpass and use its richer
 * result if it lands. Measured: a Tokyo attraction union takes ~15s and returns 400 places, so a
 * 12s patience threw the good answer away, made the result look thin, and sent the fallback
 * ladder climbing for nothing. */
const OVERPASS_GRACE_MS = 15000;

/* Named distinctly on purpose. data.js already had an `async function fetch` helper with the
 * arguments the OTHER way round (url, ms, opts). Both are top-level declarations in one shared
 * global scope, so the later file simply replaced the earlier one — and every Wikimedia call in
 * data.js and imagery.js then passed 8000 as `opts` and a headers object as the timeout, making
 * setTimeout fire on NaN and abort the request instantly. Image resolution was dead app-wide and
 * silent about it, because an aborted fetch looks exactly like "no photo found". */
async function placesFetch(url, opts, ms){
  const ctl = new AbortController();
  const timer = setTimeout(()=>ctl.abort(), ms || PLACES_TIMEOUT_MS);
  // An external signal (the user navigated away) must also cancel this request.
  if(opts && opts.signal){
    if(opts.signal.aborted) ctl.abort();
    else opts.signal.addEventListener('abort', ()=>ctl.abort(), {once:true});
  }
  try{ return await fetch(url, Object.assign({}, opts, {signal: ctl.signal})); }
  finally{ clearTimeout(timer); }
}

/** Runs an Overpass QL query, rotating mirrors until one answers. */
async function overpassQuery(ql, signal, timeoutMs){
  let lastErr = null;
  for(let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++){
    const endpoint = OVERPASS_ENDPOINTS[(overpassCursor + attempt) % OVERPASS_ENDPOINTS.length];
    try{
      const res = await placesFetch(endpoint, {
        method: 'POST',
        // Overpass answers 406 without an explicit Accept, and form-encoding is what the
        // public mirrors expect for a POSTed query.
        // The public mirrors answer an anonymous client with 429 and "please include a
        // meaningful User-Agent". Browsers send their own and drop this header as forbidden,
        // so it changes nothing in the app — but without it the Node test suites are throttled
        // partway through a long run and read the refusals as "this country has no places".
        // Indonesia reported zero restaurants that way while working perfectly in a browser.
        headers: {'Accept':'application/json', 'Content-Type':'application/x-www-form-urlencoded',
                  'User-Agent': PLACES_USER_AGENT},
        body: 'data=' + encodeURIComponent(ql),
        signal,
      }, timeoutMs || PLACES_TIMEOUT_MS);
      if(res.status === 429 || res.status === 504) throw new Error('busy ' + res.status);
      if(!res.ok) throw new Error('http ' + res.status);
      const json = await res.json();
      // Overpass reports a timeout as HTTP 200 with an empty element list and a `remark`. Taken
      // at face value that reads as "this city has no hotels", which is how Seoul ended up with
      // an empty Stays tab. Treat it as the failure it is so we rotate or fall back to Photon.
      if(json && json.remark && /error|timed out|runtime/i.test(json.remark)){
        throw new Error('overpass remark: ' + json.remark);
      }
      // Remember the mirror that worked so the next destination starts there.
      overpassCursor = (overpassCursor + attempt) % OVERPASS_ENDPOINTS.length;
      return json.elements || [];
    }catch(e){
      if(signal && signal.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('all Overpass mirrors unavailable');
}

/** Photon's reverse endpoint filtered by osm_tag — a keyless nearby-POI search. Far fewer tags
 *  than Overpass (no cuisine, no opening hours) but it answers in under a second, so it is what
 *  stands between a slow mirror and an empty page. */
async function photonNearby(dest, kind, radiusKm, signal){
  const spec = PLACE_KINDS[kind];
  const out = [];
  for(const tag of spec.photonTags){
    const url = `${PHOTON_REVERSE}?lat=${dest.lat}&lon=${dest.lng}` +
                `&radius=${Math.min(radiusKm, 50)}&limit=50&lang=en&osm_tag=${encodeURIComponent(tag)}`;
    try{
      const res = await placesFetch(url, {headers:{'Accept':'application/json'}, signal}, 12000);
      if(!res.ok) continue;
      const json = await res.json();
      for(const f of (json.features || [])){
        const p = f.properties || {}, c = (f.geometry || {}).coordinates || [];
        if(!p.name || c.length < 2) continue;
        out.push({
          type: (p.osm_type === 'W' ? 'way' : p.osm_type === 'R' ? 'relation' : 'node'),
          id: p.osm_id,
          lat: c[1], lon: c[0],
          tags: {
            name: p.name,
            [p.osm_key]: p.osm_value,
            'addr:street': p.street, 'addr:housenumber': p.housenumber,
            'addr:city': p.city, 'addr:postcode': p.postcode,
          },
          __source: 'photon',
          __countrycode: p.countrycode || '',
        });
      }
    }catch(e){ if(signal && signal.aborted) throw e; }
  }
  return out;
}

/* ---------------- canonical records ---------------- */

/** Turns one OSM element into the canonical entity record the app stores.
 *  `placeId` is the same `osm:<type><id>` form geo.js uses for destinations, so an entity has
 *  one identity everywhere: cache key, image cache key and dedupe key all agree. */
function osmToPlace(el, kind, dest){
  const t = el.tags || {};
  const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
  const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
  if(lat == null || lon == null) return null;

  const name = t['name:en'] || t.name;
  if(!name) return null;
  // Keep the local-script name when it differs, so a Seoul restaurant can show both rather than
  // forcing an English label that no sign outside the door actually carries.
  const localName = (t.name && t.name !== name) ? t.name : '';

  const subtypeKey = t.amenity || t.tourism || t.historic || t.leisure || '';
  const osmType = el.type === 'way' ? 'W' : el.type === 'relation' ? 'R' : 'N';

  const addr = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const area = t['addr:suburb'] || t['addr:district'] || t['addr:city'] || dest.name;

  const rec = {
    id: `osm-${osmType}${el.id}`,
    placeId: `osm:${osmType}${el.id}`,
    destId: dest.id,
    type: kind,
    name,
    localName,
    subtype: subtypeKey,
    category: OSM_SUBTYPE_LABEL[subtypeKey] || 'Place',
    lat, lng: lon,
    area,
    address: addr,
    // Only when the data actually says so. Left blank otherwise rather than inherited from the
    // destination, which would make the country-code containment check meaningless.
    countryCode: String(t['addr:country'] || el.__countrycode || '').toUpperCase(),
    website: t.website || t['contact:website'] || '',
    phone: t.phone || t['contact:phone'] || '',
    hours: t.opening_hours || '',
    wikidata: t.wikidata || '',
    wikipedia: t.wikipedia || '',
    osmImage: t.image || '',
    osmCommons: t.wikimedia_commons || '',
    verified: true,
    source: el.__source || 'overpass',
    distanceKm: geoDistanceKm({lat, lng: lon}, dest),

    // Deliberately absent. OSM has no ratings, no review counts and almost never a price, and
    // the app must not manufacture them — that is precisely the bug this file exists to undo.
    rating: null,
    reviews: null,
    price: null,
    priceLevel: null,
  };

  if(kind === 'restaurant'){
    rec.cuisine = prettyCuisine(t.cuisine) || rec.category;
    rec.dietary = [];
    if(t['diet:vegetarian'] === 'yes' || t['diet:vegetarian'] === 'only') rec.dietary.push('vegetarian');
    if(t['diet:vegan'] === 'yes' || t['diet:vegan'] === 'only') rec.dietary.push('vegan');
    if(t['diet:halal'] === 'yes' || t['diet:halal'] === 'only') rec.dietary.push('halal');
    if(t['diet:gluten_free'] === 'yes') rec.dietary.push('gluten-free');
    rec.takeaway = t.takeaway === 'yes';
    rec.outdoorSeating = t.outdoor_seating === 'yes';
  }

  if(kind === 'hotel'){
    // OSM stars are an official classification, not a review score, so it is real data.
    const st = parseInt(t.stars, 10);
    rec.stars = (st >= 1 && st <= 5) ? st : null;
    rec.rooms = parseInt(t.rooms, 10) || null;
    rec.amenities = [];
    if(t.internet_access && t.internet_access !== 'no') rec.amenities.push('WiFi');
    if(t.breakfast && t.breakfast !== 'no') rec.amenities.push('Breakfast');
    if(t.swimming_pool && t.swimming_pool !== 'no') rec.amenities.push('Pool');
    if(t.wheelchair === 'yes') rec.amenities.push('Step-free access');
    if(t.air_conditioning === 'yes') rec.amenities.push('Air conditioning');
    if(t.parking && t.parking !== 'no') rec.amenities.push('Parking');
    rec.guestRating = null;
  }

  if(kind === 'attraction'){
    rec.tags = ['culture'];
    if(/park|garden|nature_reserve|viewpoint|beach/.test(subtypeKey)) rec.tags = ['nature'];
    if(/museum|gallery|artwork/.test(subtypeKey)) rec.tags = ['culture','art'];
    if(/castle|monument|ruins|archaeological_site|palace|fort/.test(subtypeKey)) rec.tags = ['history'];
    rec.duration = 75;
    rec.fee = t.fee === 'yes' ? 'Entry fee' : t.fee === 'no' ? 'Free' : '';
  }

  rec.desc = describePlace(rec, t, dest);
  return rec;
}

/** A description built only from tags that are actually present. Says less about a sparse
 *  entry than a generated sentence would, which is the point. */
function describePlace(rec, t, dest){
  const bits = [];
  if(rec.type === 'restaurant'){
    const c = prettyCuisine(t.cuisine);
    bits.push(c ? `${c} ${(OSM_SUBTYPE_LABEL[rec.subtype] || 'restaurant').toLowerCase()}`
                : (OSM_SUBTYPE_LABEL[rec.subtype] || 'Place to eat'));
  } else {
    bits.push(OSM_SUBTYPE_LABEL[rec.subtype] || 'Place');
  }
  if(rec.address) bits.push(`on ${rec.address}`);
  else if(rec.area && rec.area !== dest.name) bits.push(`in ${rec.area}`);
  if(rec.distanceKm != null && isFinite(rec.distanceKm)){
    bits.push(rec.distanceKm < 1 ? `${Math.round(rec.distanceKm*1000)} m from the centre`
                                 : `${rec.distanceKm.toFixed(1)} km from the centre`);
  }
  return bits.join(', ').replace(/^./, m=>m.toUpperCase()) + '.';
}

/* ---------------- dedupe and ranking ---------------- */

function normName(s){
  return String(s||'').toLowerCase()
    .replace(/[’'`]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}

/** Same entity mapped twice — once as a node for the shop, once as a building way — is common
 *  in OSM, and Photon and Overpass will each return their own copy. Identical canonical ids go
 *  first; then same name within 80 m, which is closer than two genuinely different branches. */
function dedupePlaces(list){
  const byId = new Map();
  for(const p of list) if(!byId.has(p.placeId)) byId.set(p.placeId, p);
  const out = [];
  for(const p of byId.values()){
    const n = normName(p.name);
    const twin = out.find(q => normName(q.name) === n && geoDistanceKm(q, p) < 0.08);
    if(!twin){ out.push(p); continue; }
    // Keep whichever record carries more real information.
    if(placeCompleteness(p) > placeCompleteness(twin)) out[out.indexOf(twin)] = p;
  }
  return out;
}

/** How much this record actually tells a traveller. Used for dedupe and ordering — NOT a
 *  quality score, and never shown as one. */
function placeCompleteness(p){
  let n = 0;
  if(p.cuisine && p.cuisine !== p.category) n += 2;
  if(p.hours) n += 2;
  if(p.website) n += 1;
  if(p.phone) n += 1;
  if(p.address) n += 1;
  if(p.wikidata) n += 2;
  if(p.wikipedia) n += 2;
  if(p.osmImage || p.osmCommons) n += 3;
  if(p.stars) n += 2;
  if(p.amenities && p.amenities.length) n += 1;
  if(p.localName) n += 1;
  return n;
}

/** Ordering: well-described and close beats sparse and far. Distance is a real measurement and
 *  completeness is a property of the record, so neither invents anything about the place. */
function rankPlaces(list){
  return list.slice().sort((a, b) => {
    const s = (placeCompleteness(b) - placeCompleteness(a));
    if(s) return s;
    return (a.distanceKm || 0) - (b.distanceKm || 0);
  });
}

/* ---------------- caching ---------------- */

const PLACES_CACHE_PREFIX = 'tf:places:';
const PLACES_CACHE_TTL = 7 * 24 * 3600 * 1000; // OSM moves slowly; a week is generous and safe.

function placesCacheKey(dest, kind){
  // Keyed by canonical place id — never by name, so "Paris" and "Paris, Texas" cannot collide.
  return PLACES_CACHE_PREFIX + (dest.placeId || dest.id) + ':' + kind;
}
function readPlacesCache(dest, kind){
  try{
    const raw = localStorage.getItem(placesCacheKey(dest, kind));
    if(!raw) return null;
    const box = JSON.parse(raw);
    if(!box || !box.t || (Date.now() - box.t) > PLACES_CACHE_TTL) return null;
    return Array.isArray(box.v) ? box.v : null;
  }catch(e){ return null; }
}
function writePlacesCache(dest, kind, list){
  try{
    localStorage.setItem(placesCacheKey(dest, kind), JSON.stringify({t: Date.now(), v: list}));
  }catch(e){
    // Quota exhausted: drop the oldest place caches rather than failing the discovery.
    try{
      const keys = Object.keys(localStorage).filter(k=>k.indexOf(PLACES_CACHE_PREFIX)===0);
      keys.slice(0, Math.ceil(keys.length/2)).forEach(k=>localStorage.removeItem(k));
      localStorage.setItem(placesCacheKey(dest, kind), JSON.stringify({t: Date.now(), v: list}));
    }catch(e2){ /* caching is an optimisation, never a requirement */ }
  }
}

/* ---------------- discovery ---------------- */

/** Search radius in kilometres.
 *
 *  Deliberately smaller than the validation radius. Validation asks "could this plausibly be in
 *  the destination" and can afford to be generous; the search asks "where should we look", and
 *  looking 30 km out from a city centre cost 65 seconds against Overpass while burying the
 *  central restaurants people actually want under suburban ones. Search tight, validate wide. */
const DISCOVERY_RADIUS_KM = {
  continent: 60, country: 50, state: 40, region: 40, province: 40, county: 25,
  island: 20, city: 8, municipality: 8, town: 5, village: 3, hamlet: 3,
  suburb: 2.5, neighbourhood: 2, district: 4, locality: 3,
  attraction: 1.5, landmark: 1.5, museum: 1.5, building: 1.5, station: 2,
};
function discoveryRadiusKm(dest){
  const t = String((dest && (dest.placeType || dest.type)) || '').toLowerCase();
  return DISCOVERY_RADIUS_KM[t] || 8;
}

const placesInFlight = new Map();   // canonical key -> Promise, so two tabs of the same page share one fetch

/* ---------------- anchoring a large area ----------------
 *
 * A country's centroid is a geometric average, not a place. Indonesia's is -2.4834, 117.8903 —
 * open water in the Makassar Strait, hundreds of kilometres from anywhere with a restaurant, so
 * searching around it returns nothing however wide the radius goes. The same is true of Chile,
 * Norway, Greece and any country that is long, hollow or made of islands.
 *
 * So a large destination is anchored on its most prominent settlement instead: one Overpass
 * query for cities inside its own boundary, ordered by the population OSM records. That is real
 * data, it works for any country without naming one, and it is cached like everything else. */

const LARGE_TYPES = ['continent', 'country', 'state', 'region', 'province', 'county'];
const ANCHOR_BUDGET_MS = 120000;      // paid once per destination, then cached
const ANCHOR_QUERY_TIMEOUT_MS = 55000; // a country-sized scan legitimately takes ~40s
const anchorCache = new Map();

function needsSettlementAnchor(dest){
  return LARGE_TYPES.includes(String(dest.placeType || '').toLowerCase());
}

/** The biggest city inside the destination's boundary, or null when we cannot tell. */
const ANCHOR_STORE_PREFIX = 'tf:anchor:';

/** Persisted, because this is the most expensive lookup in the app — a country-sized scan that
 *  measured 106 seconds under load — and its answer never changes. Paid once, ever. */
function readAnchorStore(key){
  try{
    const raw = localStorage.getItem(ANCHOR_STORE_PREFIX + key);
    return raw ? JSON.parse(raw) : undefined;
  }catch(e){ return undefined; }
}
function writeAnchorStore(key, value){
  try{ localStorage.setItem(ANCHOR_STORE_PREFIX + key, JSON.stringify(value)); }catch(e){}
}

async function prominentSettlement(dest, signal){
  const key = dest.placeId || dest.id;
  if(anchorCache.has(key)) return anchorCache.get(key);
  const stored = readAnchorStore(key);
  if(stored !== undefined){ anchorCache.set(key, stored); return stored; }
  const box = dest.bbox;
  if(!box || box.minLat == null) return null;

  const area = `(${box.minLat},${box.minLng},${box.maxLat},${box.maxLng})`;

  /* Ask for the LARGEST cities first, by population magnitude, and widen only if nothing turns
   * up. Scanning a whole country for every city and town is too much work for Overpass —
   * Indonesia's bounding box returned 504 after 37 seconds — but asking only for places of a
   * million or more answers in 11 seconds with 26 results. A small country finds nothing at that
   * size and drops a digit, so this works for Cape Verde as well as for India. */
  const MAGNITUDES = [
    // `place=city` alone, not `city|town`. Including towns is what made this unaffordable:
    // the same Indonesia query took 11 seconds for cities and timed out repeatedly once towns
    // were in it, because a country holds thousands of them. Towns only come into it at the
    // smallest magnitude, where the country is small enough for the scan to be cheap anyway.
    {digits: '7,', places: 'city',        label: '1M+'},
    {digits: '6,', places: 'city',        label: '100k+'},
    {digits: '5,', places: 'city|town',   label: '10k+'},
  ];
  const started = Date.now();
  let best = null;
  for(const mag of MAGNITUDES){
    // A whole-country page must not hang on finding its anchor. Out of budget, the centroid
    // stands — worse, but bounded.
    if(Date.now() - started > ANCHOR_BUDGET_MS) break;
    const ql = `[out:json][timeout:25];(node[place~"^(${mag.places})$"]` +
               // `out tags` alone returns tags and NO geometry, so every candidate was
               // discarded for having no coordinates and the anchor always came back null.
               `["population"~"^[0-9]{${mag.digits}}$"]${area};);out tags center 60;`;
    try{
      // This query is far heavier than a normal one: it scans a whole country's bounding box.
      // Measured at 37 seconds for Indonesia, against a standard 25-second per-mirror cap — so
      // it was timing out on every mirror and giving up on a query that does in fact succeed.
      const els = await overpassQuery(ql, signal, ANCHOR_QUERY_TIMEOUT_MS);
      for(const el of els){
        const pop = parseInt((el.tags && el.tags.population) || '0', 10);
        const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
        const lng = el.lon != null ? el.lon : (el.center && el.center.lon);
        if(!pop || lat == null) continue;
        if(!best || pop > best.pop) best = {lat, lng, pop,
                                            name: (el.tags['name:en'] || el.tags.name || '')};
      }
    }catch(e){ /* try the next magnitude, then fall back to the centroid */ }
    if(best) break;
  }
  anchorCache.set(key, best);
  // Only a success is persisted: a failure here is usually a throttled mirror rather than a
  // country with no cities, and remembering that would make a temporary outage permanent.
  if(best) writeAnchorStore(key, best);
  return best;
}

/** Discovers real places of one kind around a verified destination.
 *  Returns [] rather than throwing, so a page never breaks because a mirror was busy. */
async function discoverPlaces(dest, kind, opts){
  opts = opts || {};
  if(!PLACE_KINDS[kind]) return [];
  // Rule 1: canonical id + verified coordinates, or we do not search at all. Searching around
  // an invented point is how a Seoul trip filled up with Spanish restaurants.
  if(typeof hasVerifiedGeo === 'function' && !hasVerifiedGeo(dest)) return [];

  if(!opts.fresh){
    const cached = readPlacesCache(dest, kind);
    if(cached) return cached;
  }

  const key = placesCacheKey(dest, kind);
  if(placesInFlight.has(key)) return placesInFlight.get(key);

  const run = (async () => {
    const baseRadiusKm = discoveryRadiusKm(dest);
    const spec = PLACE_KINDS[kind];

    // For a country or a region, search around its largest city rather than its centroid.
    let anchor = {lat: dest.lat, lng: dest.lng};
    let anchorNote = null;
    if(needsSettlementAnchor(dest)){
      const settlement = await prominentSettlement(dest, opts.signal);
      if(settlement){
        anchor = {lat: settlement.lat, lng: settlement.lng};
        anchorNote = settlement.name || null;
      }
    }

    // The ladder. Each rung is a genuinely different way of asking, not the same question again:
    // a wider circle finds a village whose centre point sits off to one side; a bounding box uses
    // the geocoder's own boundary instead of a circle; splitting the categories turns one
    // expensive query into several cheap ones that a busy mirror will actually answer. Results
    // from every rung are merged and deduplicated, so a partial answer still contributes.
    const rungs = [];
    rungs.push({label:'radius', km: baseRadiusKm});
    rungs.push({label:'radius x2', km: baseRadiusKm * 2});
    if(dest.bbox && dest.bbox.minLat != null) rungs.push({label:'bbox', bbox: dest.bbox});
    rungs.push({label:'radius x4', km: baseRadiusKm * 4});
    // No per-selector rung. It sounds cheaper and is measurably not: against Tokyo the combined
    // union answered in 15s with 400 results while two of its three selectors on their own
    // returned 504 after 31 and 171 seconds. Overpass optimises the union better than we can.
    rungs.push({label:'radius x8', km: baseRadiusKm * 8});

    const buildQL = (rung, selectors) => {
      const area = rung.bbox
        ? `(${rung.bbox.minLat},${rung.bbox.minLng},${rung.bbox.maxLat},${rung.bbox.maxLng})`
        : `(around:${Math.round(Math.min(rung.km, 80) * 1000)},${anchor.lat},${anchor.lng})`;
      return `[out:json][timeout:20];(` +
        selectors.map(sel => `${sel}${area};`).join('') + `);out tags center 400;`;
    };

    const radiusKm = baseRadiusKm;
    const ql = buildQL(rungs[0], spec.overpass);

    /* Overpass carries far richer tags, so it is preferred — but it is also the flakier source,
     * and rotating through three mirrors at 30s each meant a bad day for Overpass cost 66
     * seconds before the page showed anything. Photon answers in about a second.
     *
     * So: ask Overpass, and if it has not answered within OVERPASS_PATIENCE_MS, let Photon serve
     * the page instead of waiting the mirrors out. Overpass still wins whenever it is healthy,
     * which is most of the time; this only bounds the bad case. */
    const delay = ms => new Promise(r => setTimeout(r, ms));
    let elements = [];
    const attempts = [];
    // Overpass is started once and kept, never abandoned. Photon fills the page if Overpass is
    // slow, and Overpass still replaces it when it lands — the earlier version raced them and
    // discarded whichever lost, which meant a perfectly good 400-place answer was thrown away
    // for arriving three seconds after the deadline.
    let overpassSettled = false;
    const overpassP = overpassQuery(ql, opts.signal)
      .then(r => { overpassSettled = true; return r; })
      .catch(() => { overpassSettled = true; return []; });
    try{
      elements = await Promise.race([
        overpassP,
        delay(OVERPASS_PATIENCE_MS).then(() =>
          photonNearby(Object.assign({}, dest, anchor), kind, radiusKm, opts.signal).catch(() => [])),
      ]);
      attempts.push(`${rungs[0].label}:${elements.length}${overpassSettled ? '' : ' (photon first)'}`);

      if(!overpassSettled){
        // Give the richer source its remaining time; its tags are worth the wait.
        const late = await Promise.race([overpassP, delay(OVERPASS_GRACE_MS).then(() => null)]);
        if(late && late.length > elements.length){
          attempts.push(`overpass-late:${late.length}`);
          elements = late;
        }
      }
    }catch(e){ elements = []; }

    // Thin or empty is not an answer yet — climb the ladder. "Thin" is judged against what this
    // kind of destination should plausibly hold, so a hamlet with four cafes stops early and a
    // capital with four does not.
    const THIN = (dest.placeType === 'city' || dest.placeType === 'municipality') ? 25 : 8;
    if(!(opts.signal && opts.signal.aborted)){
      for(let i = 1; i < rungs.length && elements.length < THIN; i++){
        const rung = rungs[i];
        try{
          let more = [];
          if(rung.split){
            // One selector at a time: cheaper per query, and a mirror that refuses the union
            // will often answer the parts.
            for(const sel of spec.overpass){
              try{ more = more.concat(await overpassQuery(buildQL(rung, [sel]), opts.signal)); }
              catch(e){ if(opts.signal && opts.signal.aborted) throw e; }
            }
          } else {
            more = await overpassQuery(buildQL(rung, spec.overpass), opts.signal);
          }
          const before = elements.length;
          elements = elements.concat(more);
          attempts.push(`${rung.label}:+${elements.length - before}`);
        }catch(e){
          if(opts.signal && opts.signal.aborted) throw e;
          attempts.push(`${rung.label}:failed`);
        }
      }
    }
    // Last resort before giving up: the other provider entirely, at the widest radius tried.
    if(!elements.length && !(opts.signal && opts.signal.aborted)){
      try{
        elements = await photonNearby(dest, kind, Math.min(baseRadiusKm * 4, 50), opts.signal);
        attempts.push(`photon:${elements.length}`);
      }catch(e){ attempts.push('photon:failed'); }
    }

    const mapped = [];
    for(const el of elements){
      const rec = osmToPlace(el, kind, dest);
      // Rules 3 and 4: a place belongs to the destination context or it is not shown. The
      // radius already bounds the query; this re-checks the mapped record, which also catches
      // anything Photon returned outside the radius it was asked for.
      if(rec && typeof placeWithinDestination === 'function' && placeWithinDestination(rec, dest)) mapped.push(rec);
    }
    const finalList = rankPlaces(dedupePlaces(mapped));
    // Kept so a genuinely empty result can be shown as "we tried these and found nothing" rather
    // than an unexplained blank.
    finalList.attempts = attempts;
    // Say so when the search was anchored somewhere other than the destination's own point, so
    // the UI can tell a traveller that a country's results centre on its largest city.
    if(anchorNote) finalList.anchoredOn = anchorNote;
    if(finalList.length) writePlacesCache(dest, kind, finalList);
    return finalList;
  })();

  placesInFlight.set(key, run);
  try{ return await run; }
  finally{ placesInFlight.delete(key); }
}

/* ---------------- integration with the app's PLACES store ---------------- */

/** Merges discovered records into the global PLACES array and tells the UI to re-render.
 *  Curated destinations keep their hand-written entries: those are real places too, checked by
 *  hand, and discovery only adds to them. */
function mergeDiscoveredPlaces(dest, kind, list){
  if(typeof PLACES === 'undefined' || !Array.isArray(PLACES)) return;
  const existing = new Set(PLACES.filter(p=>p.destId===dest.id).map(p=>p.placeId || p.id));
  const existingNames = new Set(PLACES.filter(p=>p.destId===dest.id && p.type===kind).map(p=>normName(p.name)));
  let added = 0;
  for(const rec of list){
    if(existing.has(rec.placeId) || existingNames.has(normName(rec.name))) continue;
    PLACES.push(rec);
    added++;
  }
  if(added) notifyPlacesUpdated(dest, kind, added);
  return added;
}

function notifyPlacesUpdated(dest, kind, added){
  try{
    window.dispatchEvent(new CustomEvent('tripflow:places', {detail:{destId: dest.id, kind, added}}));
  }catch(e){ /* older browsers: the next render picks the places up anyway */ }
}

/** Discovery state per destination, so the UI can show "looking" vs "found nothing" honestly
 *  rather than an ambiguous empty list. */
const placesDiscoveryState = new Map();   // destId -> {restaurant:'loading'|'done'|'error', ...}

function placesStatus(destId, kind){
  const st = placesDiscoveryState.get(destId);
  return (st && st[kind]) || 'idle';
}

/** Kicks off discovery for every kind around a destination. Called when a destination is
 *  created with verified coordinates, and again if its geo is confirmed later. */
/* One controller per destination. Opening a new destination aborts the previous one's in-flight
 * queries: an Overpass round trip can take tens of seconds, and without this a slow response for
 * a destination the user has already left would still arrive and merge its places into the
 * store — the stale-query problem, and a way for one destination's data to reach another. */
const placesControllers = new Map();

function cancelDiscoveryExcept(destId){
  for(const [id, ctl] of placesControllers){
    if(id === destId) continue;
    try{ ctl.abort(); }catch(e){ /* already settled */ }
    placesControllers.delete(id);
  }
}

function discoverPlacesFor(dest, kinds){
  if(!dest || (typeof hasVerifiedGeo === 'function' && !hasVerifiedGeo(dest))) return;
  cancelDiscoveryExcept(dest.id);
  let ctl = placesControllers.get(dest.id);
  if(!ctl){ ctl = new AbortController(); placesControllers.set(dest.id, ctl); }
  const list = kinds || ['restaurant', 'hotel', 'attraction'];
  const st = placesDiscoveryState.get(dest.id) || {};
  placesDiscoveryState.set(dest.id, st);

  for(const kind of list){
    if(st[kind] === 'loading' || st[kind] === 'done') continue;
    st[kind] = 'loading';
    notifyPlacesUpdated(dest, kind, 0);
    discoverPlaces(dest, kind, {signal: ctl.signal})
      .then(found => {
        // A cancelled destination must not write into the store, even if its request finished.
        if(ctl.signal.aborted) return;
        st[kind] = 'done';
        st[kind + ':count'] = found.length;
        mergeDiscoveredPlaces(dest, kind, found);
        notifyPlacesUpdated(dest, kind, found.length);
      })
      .catch(() => {
        if(ctl.signal.aborted) return;
        st[kind] = 'error';
        notifyPlacesUpdated(dest, kind, 0);
      });
  }
}

/* ---------------- pagination ---------------- */

/* The spec asks for pagination rather than dumping everything into the DOM: a dense city can
 * return several hundred entities, and rendering them all costs a visible freeze on a phone. */
const PLACES_PAGE_SIZE = 24;

function pagePlaces(list, page, size){
  const n = size || PLACES_PAGE_SIZE;
  const p = Math.max(0, page || 0);
  return {
    items: list.slice(0, (p + 1) * n),   // cumulative: "Show more" appends rather than replaces
    shown: Math.min((p + 1) * n, list.length),
    total: list.length,
    hasMore: (p + 1) * n < list.length,
  };
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    PLACE_KINDS, OSM_SUBTYPE_LABEL, prettyCuisine, osmToPlace, dedupePlaces, rankPlaces,
    placeCompleteness, discoverPlaces, discoverPlacesFor, pagePlaces, normName,
    discoveryRadiusKm, overpassQuery, photonNearby, DISCOVERY_RADIUS_KM, cancelDiscoveryExcept,
    prominentSettlement, needsSettlementAnchor,
    OVERPASS_PATIENCE_MS,
  };
}
