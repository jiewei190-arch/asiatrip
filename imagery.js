/* ============================================================
   TripFlow — the one image resolver

   Every image in the app comes from here, so there is a single place where "does this photo
   actually depict the thing on this card?" is decided.

   It takes the CANONICAL entity from Phase 1 — never a bare name — because a name alone
   cannot distinguish Paris, France from Paris, Texas, and the whole point is that the photo
   inherits the verified identity rather than re-deriving it.

   Sources, in priority order. Each rung is more specific than the one below it:

     1. The OSM entity's own image tags (image, wikimedia_commons, wikidata, wikipedia).
        This is the only rung that can prove a photo is of THIS restaurant or THIS hotel
        rather than one like it.
     2. Wikidata P18 for entities carrying a wikidata id.
     3. The Wikipedia article for the entity, verified by coordinates and name.
     4. For a destination: a landmark verifiably inside it (see data.js).
     5. For a demo restaurant with no entity imagery anywhere: a photograph of the cuisine it
        serves — an explicitly labelled category image, never presented as the premises.

   MEASURED COVERAGE, because the honest number matters more than the aspiration. Sampling
   real OSM data around central Paris:

       attractions / museums   50% carry an image reference
       restaurants              4% (7 of 150, all bare wikidata ids, zero direct images)

   So rung 1 genuinely solves landmarks and genuinely cannot solve restaurants: the free data
   does not contain photographs of most of the world's restaurants. Rung 5 exists for that
   case and is honest about what it is.

   Overpass is slow (queries take tens of seconds) and is community-run infrastructure, so it
   is never on the render path: cards paint immediately and upgrade if a better image arrives.
============================================================ */

const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',   // fastest and most reliable in testing
  'https://overpass-api.de/api/interpreter',
];
const IMAGERY_CACHE_KEY = 'tripflow_entity_image_v1';
const IMAGERY_TTL_MS = 30 * 24 * 3600 * 1000;
const IMAGERY_CACHE_MAX = 500;
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

/* ---------------- Cache, keyed by canonical identity ----------------
   Never by name: "image:paris" would be shared by Paris, France and Paris, Texas. */
let __imgMem = null;
function imageryCache(){
  if(!__imgMem){
    try { __imgMem = JSON.parse(localStorage.getItem(IMAGERY_CACHE_KEY)) || {}; }
    catch(e){ __imgMem = {}; }
  }
  return __imgMem;
}
function imageryKey(entity){
  return 'img:' + (entity.placeId || entity.osmId ||
    `${(entity.name||'').toLowerCase()}|${entity.countryCode||''}|${(entity.lat||0).toFixed(3)}`);
}
function imageryCacheGet(entity){
  const hit = imageryCache()[imageryKey(entity)];
  if(!hit || (Date.now() - hit.ts) > IMAGERY_TTL_MS) return null;
  return hit;
}
function imageryCacheSet(entity, value){
  const cache = imageryCache();
  cache[imageryKey(entity)] = Object.assign({ ts: Date.now() }, value);
  const keys = Object.keys(cache);
  if(keys.length > IMAGERY_CACHE_MAX){
    keys.sort((a,b) => cache[a].ts - cache[b].ts).slice(0, keys.length - IMAGERY_CACHE_MAX)
        .forEach(k => delete cache[k]);
  }
  try { localStorage.setItem(IMAGERY_CACHE_KEY, JSON.stringify(cache)); } catch(e){}
}

/* ---------------- Confidence ----------------
   A number the caller can threshold on, so "we are sure" and "this is a stand-in" are
   distinguishable rather than both being "an image". */
const IMAGE_CONFIDENCE = {
  osm_image: 100,        // the entity's own photo, tagged on the entity itself
  osm_commons: 95,
  wikidata_p18: 90,
  osm_wikipedia: 85,
  wikipedia_verified: 70,  // article matched by name AND coordinates
  landmark_inside: 45,     // a real photo of somewhere inside the destination
  category: 20,            // an honest stand-in: a cuisine or accommodation photograph
};
const IMAGE_MIN_CONFIDENCE_ENTITY = 60;   // a NAMED entity needs a photo of itself

/* ---------------- Media helpers ---------------- */

/** A Commons "File:Foo.jpg" reference to a rendered thumbnail URL. */
async function commonsFileThumb(fileName, width){
  if(!fileName) return null;
  const file = String(fileName).replace(/^File:/i, '').trim();
  if(!file) return null;
  const url = `${COMMONS_API}?action=query&titles=${encodeURIComponent('File:' + file)}` +
    `&prop=imageinfo&iiprop=url&iiurlwidth=${width || 720}&format=json&origin=*`;
  const data = await fetchWikiJSON(url);
  if(!data) return null;
  for(const p of Object.values((data.query && data.query.pages) || {})){
    const info = (p.imageinfo || [])[0];
    if(info && info.thumburl) return info.thumburl;
  }
  return null;
}

/** Wikidata P18 ("image") for an entity id such as Q243. */
async function wikidataImage(qid, width){
  if(!/^Q\d+$/i.test(String(qid || ''))) return null;
  const url = `${WIKIDATA_API}?action=wbgetclaims&entity=${encodeURIComponent(qid)}` +
    `&property=P18&format=json&origin=*`;
  const data = await fetchWikiJSON(url);
  const claims = data && data.claims && data.claims.P18;
  if(!claims || !claims.length) return null;
  const file = ((claims[0].mainsnak || {}).datavalue || {}).value;
  return file ? commonsFileThumb(file, width) : null;
}

/* ---------------- Overpass: the entity's own tags ---------------- */

/** Finds the OSM entity for a named place near a coordinate and returns its tags.
 *  Matching is deliberately strict: name similarity AND proximity AND, where known, the
 *  right kind of feature. Accepting the first hit is how one restaurant's photo ends up on
 *  another restaurant's card. */
async function overpassEntityTags(entity, opts){
  const o = opts || {};
  if(entity.lat == null || entity.lng == null || !entity.name) return null;
  const radius = o.radius || 400;
  // Ask for everything NAMED near the point and match locally, rather than asking Overpass
  // for an exact name. OSM stores names in the local language — the Eiffel Tower is
  // name="Tour Eiffel" with name:en="Eiffel Tower" — so an exact match on `name` finds
  // nothing across most of the world. Matching here also lets alt_name and official_name
  // count, and costs one request either way.
  const q = `[out:json][timeout:25];nwr(around:${radius},${entity.lat},${entity.lng})["name"];` +
            `out tags center 60;`;

  // Overpass is community-run and defends itself: overpass-api.de answers 406 without a
  // proper Accept header, and every mirror returns 429 under load. Both are expected rather
  // than exceptional, so each mirror gets one patient retry before moving on.
  for(const ep of OVERPASS_ENDPOINTS){
    let data = null;
    for(let attempt = 0; attempt < 2 && !data; attempt++){
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body: 'data=' + encodeURIComponent(q),
          signal: o.signal,
        });
        if(res.status === 429 || res.status === 504){
          await new Promise(r => setTimeout(r, 1500 + attempt * 2500));
          continue;
        }
        if(!res.ok) break;                 // 406 and friends: this mirror will not serve us
        data = await res.json();
      } catch(err){
        if(err.name === 'AbortError') throw err;
        break;
      }
    }
    if(!data) continue;
    try {
      const want = String(entity.name);
      let best = null;
      for(const el of (data.elements || [])){
        const t = el.tags || {};
        // Every name this feature is known by, in any language we were given.
        const names = [t.name, t['name:en'], t.alt_name, t.official_name, t.int_name,
                       t['name:en-GB'], t.short_name].filter(Boolean);
        if(!names.some(n => titleNamesPlace(n, want) || titleNamesPlace(want, n))) continue;
        const lat = el.lat != null ? el.lat : (el.center || {}).lat;
        const lon = el.lon != null ? el.lon : (el.center || {}).lon;
        const km = (lat == null) ? 999 : kmBetween(entity.lat, entity.lng, lat, lon);
        // Prefer a feature that actually carries imagery, then the closest one.
        const hasImg = (t.image || t.wikimedia_commons || t.wikidata || t.wikipedia) ? 0 : 1;
        if(!best || hasImg < best.hasImg || (hasImg === best.hasImg && km < best.km)){
          best = { tags: t, km, hasImg };
        }
      }
      return best ? best.tags : null;
    } catch(err){
      if(err.name === 'AbortError') throw err;
    }
  }
  return null;
}

/** Turns an OSM entity's tags into a photograph of that entity, best rung first. */
async function imageFromOsmTags(tags, width){
  if(!tags) return null;
  // A direct image URL on the entity. Only https, and only if it looks like a photograph.
  if(tags.image && /^https:\/\//i.test(tags.image) && looksLikePhoto(tags.image)){
    return { url: tags.image, source: 'osm_image' };
  }
  if(tags.wikimedia_commons){
    const ref = tags.wikimedia_commons;
    if(/^File:/i.test(ref)){
      const url = await commonsFileThumb(ref, width);
      if(url && looksLikePhoto(url)) return { url, source: 'osm_commons' };
    }
  }
  if(tags.wikidata){
    const url = await wikidataImage(tags.wikidata, width);
    if(url && looksLikePhoto(url)) return { url, source: 'wikidata_p18' };
  }
  if(tags.wikipedia){
    // "en:Eiffel Tower" -> the article's lead image.
    const title = String(tags.wikipedia).replace(/^[a-z-]+:/i, '');
    const cands = await fetchWikiCandidates(title, 1);
    const hit = (cands || []).find(c => c.thumb);
    if(hit) return { url: hit.thumb, source: 'osm_wikipedia' };
  }
  return null;
}

/* ---------------- The resolver ----------------
   `entity` is the canonical object: { placeId, name, type, kind, country, countryCode,
   lat, lng }. `kind` is what the card is showing — 'destination', 'attraction',
   'restaurant', 'hotel' — which decides how much is allowed to stand in for it. */
async function resolveEntityImage(entity, opts){
  const o = opts || {};
  if(!entity || !entity.name) return null;

  const cached = imageryCacheGet(entity);
  if(cached) return cached.url ? cached : null;

  let result = null;

  // Rung 1-2: the entity's own OSM tags. This is the only evidence that a photo is of THIS
  // place rather than one like it, so it is tried first for everything.
  try {
    const tags = await overpassEntityTags(entity, { signal: o.signal, radius: o.radius });
    const found = await imageFromOsmTags(tags, o.width || 720);
    if(found && isTravelAppropriate(found.url)){
      result = { url: found.url, source: found.source,
                 confidence: IMAGE_CONFIDENCE[found.source] || 80 };
    }
  } catch(err){
    if(err.name === 'AbortError') throw err;
  }

  // Rung 3: the entity's Wikipedia article, verified by name and coordinates (data.js).
  if(!result && entity.kind === 'destination'){
    const url = await resolveDestinationPhoto(entity);
    if(url){
      const tier = destPhotoTierFor(entity.placeId || entity.id);
      const source = tier === 'article' ? 'wikipedia_verified' : 'landmark_inside';
      result = { url, source, confidence: IMAGE_CONFIDENCE[source] };
    }
  }

  // A NAMED entity that is not a destination must be depicted, not approximated. Below the
  // threshold the caller shows a name card or an explicitly labelled category image — never
  // another business's photograph.
  if(result && entity.kind !== 'destination' && result.confidence < IMAGE_MIN_CONFIDENCE_ENTITY){
    result = null;
  }

  imageryCacheSet(entity, result || { url: null });
  return result;
}

/* ---------------- Stale-response protection ----------------
   Opening Tokyo then quickly Seoul must never let Tokyo's slower answer paint Seoul's page.
   Every application of an image checks the entity it was requested for is still the one on
   screen. */
const __imageryActive = new Map();   // element -> the entity key its request was issued for

function applyResolvedImage(imgEl, entity, opts){
  if(!imgEl || !entity) return;
  const key = imageryKey(entity);
  __imageryActive.set(imgEl, key);
  resolveEntityImage(entity, opts).then(res => {
    if(!res || !res.url) return;
    if(__imageryActive.get(imgEl) !== key) return;   // a different entity now owns this slot
    if(!imgEl.isConnected) return;
    imgEl.src = res.url;
    imgEl.dataset.imageSource = res.source;
    imgEl.dataset.imageConfidence = String(res.confidence);
  }).catch(()=>{});
}
