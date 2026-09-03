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
const OVERPASS_PATIENCE_MS = 12000;

async function fetchWithTimeout(url, opts, ms){
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
async function overpassQuery(ql, signal){
  let lastErr = null;
  for(let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++){
    const endpoint = OVERPASS_ENDPOINTS[(overpassCursor + attempt) % OVERPASS_ENDPOINTS.length];
    try{
      const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        // Overpass answers 406 without an explicit Accept, and form-encoding is what the
        // public mirrors expect for a POSTed query.
        headers: {'Accept':'application/json', 'Content-Type':'application/x-www-form-urlencoded'},
        body: 'data=' + encodeURIComponent(ql),
        signal,
      }, PLACES_TIMEOUT_MS);
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
      const res = await fetchWithTimeout(url, {headers:{'Accept':'application/json'}, signal}, 12000);
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
    const radiusKm = discoveryRadiusKm(dest);
    const radiusM = Math.round(radiusKm * 1000);
    const spec = PLACE_KINDS[kind];
    const ql = `[out:json][timeout:20];(` +
      spec.overpass.map(sel => `${sel}(around:${radiusM},${dest.lat},${dest.lng});`).join('') +
      `);out tags center 400;`;

    /* Overpass carries far richer tags, so it is preferred — but it is also the flakier source,
     * and rotating through three mirrors at 30s each meant a bad day for Overpass cost 66
     * seconds before the page showed anything. Photon answers in about a second.
     *
     * So: ask Overpass, and if it has not answered within OVERPASS_PATIENCE_MS, let Photon serve
     * the page instead of waiting the mirrors out. Overpass still wins whenever it is healthy,
     * which is most of the time; this only bounds the bad case. */
    const delay = ms => new Promise(r => setTimeout(r, ms));
    let elements = [];
    try{
      elements = await Promise.race([
        overpassQuery(ql, opts.signal).catch(() => []),
        delay(OVERPASS_PATIENCE_MS).then(() =>
          photonNearby(dest, kind, radiusKm, opts.signal).catch(() => [])),
      ]);
    }catch(e){ elements = []; }
    if(!elements.length && !(opts.signal && opts.signal.aborted)){
      try{ elements = await photonNearby(dest, kind, radiusKm, opts.signal); }catch(e){ /* nothing available */ }
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
    OVERPASS_PATIENCE_MS,
  };
}
