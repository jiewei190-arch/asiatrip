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

/* places.js owns the canonical mirror list and loads first. Declaring `const OVERPASS_ENDPOINTS`
 * a second time in the same global scope is a fatal SyntaxError that takes the whole page down,
 * which is exactly what happened. Reuse it when it is there, and keep a local copy so imagery.js
 * still works when a test loads it on its own. */
const IMAGERY_OVERPASS_ENDPOINTS = (typeof OVERPASS_ENDPOINTS !== 'undefined' && OVERPASS_ENDPOINTS.length)
  ? OVERPASS_ENDPOINTS
  : [
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
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
  commons_named: 92,     // a Commons photo whose own title names the entity
  commons_text: 60,      // found by searching Commons for the name AND the place; scored further
  commons_nearby: 55,    // geotagged at the entity but not titled for it
  osm_image: 100,        // the entity's own photo, tagged on the entity itself
  osm_commons: 95,
  wikidata_p18: 90,
  wikivoyage_banner: 88,   // an image editors chose to represent the place to travellers
  osm_wikipedia: 85,
  wikipedia_verified: 70,  // article matched by name AND coordinates
  landmark_inside: 45,     // a real photo of somewhere inside the destination
  category: 20,            // an honest stand-in: a cuisine or accommodation photograph
};
const IMAGE_MIN_CONFIDENCE_ENTITY = 60;   // a NAMED entity needs a photo of itself
const IMAGE_HIGH_CONFIDENCE = 90;         // good enough that looking further cannot improve it

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

/** A representative photograph for a Wikidata entity, best property first.
 *
 *  P948 is the Wikivoyage banner — an image editors chose to represent this place TO
 *  TRAVELLERS — and it is far better suited here than P18, which for most countries is a
 *  satellite photograph or a relief map: Japan's P18 is "Satellite image of Japan", Brazil's
 *  is "Brazil topo.jpg", Australia's is "Australia satellite plane.jpg". Those are correctly
 *  rejected as non-photographs, which left countries with nothing until P948 was tried.
 *  P18 still comes first for a named entity, where it is a photograph of the thing itself. */
async function wikidataImage(qid, width, opts){
  if(!/^Q\d+$/i.test(String(qid || ''))) return null;
  const o = opts || {};
  const props = o.preferBanner ? ['P948', 'P18'] : ['P18', 'P948'];
  const url = `${WIKIDATA_API}?action=wbgetclaims&entity=${encodeURIComponent(qid)}` +
    `&format=json&origin=*`;
  const data = await fetchWikiJSON(url);
  const claims = (data && data.claims) || {};
  for(const prop of props){
    const c = claims[prop];
    if(!c || !c.length) continue;
    const file = ((c[0].mainsnak || {}).datavalue || {}).value;
    if(!file) continue;
    const thumb = await commonsFileThumb(file, width);
    if(thumb && looksLikePhoto(thumb) && isTravelAppropriate(thumb)){
      return o.withProp ? { url: thumb, prop } : thumb;
    }
  }
  return null;
}

/* ---------------- Commons geosearch: photographs AT the entity ----------------
   Wikimedia Commons geotags its media, so asking "what photographs were taken here?" returns
   pictures of the thing standing at those coordinates. This turned out to be the strongest
   entity-specific source available without a key — Marina Bay Sands returns
   "Marina Bay Sands infinity pool.JPG", Sensō-ji returns "浅草寺2 Senso-ji" — and unlike
   Overpass it runs on Wikimedia infrastructure that answers reliably.

   A photograph merely taken nearby is not proof it is OF the entity, so a file whose own
   title names the entity scores far higher than one that just shares its coordinates. */
/** How strongly does a Commons file title claim to DEPICT this entity?
 *
 *  Containing the name is not enough, and the two ways that fails are both common:
 *    "Rainbow Bridge from Tokyo Tower"        — taken FROM the entity, of something else
 *    "Infant and Skull, Medieval, Louvre"     — an object INSIDE it, not the place
 *  Both would pass a naive substring test and put the wrong picture on the card. Position
 *  carries the signal: a photograph OF something names it first. */
/** Typographic punctuation differs between an OSM name and a Commons filename for the same
 *  place — "La Tour d’Argent" against "La Tour d'Argent" — and a plain indexOf then misses,
 *  dropping a correct photo from 92 to 60. Fold the variants before comparing. */
function foldPunct(s){
  return String(s)
    .replace(/[\u2018\u2019\u02BC\u201B`\u00B4]/g, "'")     // curly and modifier apostrophes
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')                 // dashes and minus
    .replace(/\u00A0/g, ' ');
}

function commonsTitleScore(title, want){
  if(!want) return 40;                                   // no name to test against
  const t = foldPunct(String(title).replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim());
  const lt = t.toLowerCase(), lw = foldPunct(String(want)).toLowerCase();
  const at = lt.indexOf(lw);
  if(at < 0) return titleNamesPlace(t, want) ? 60 : 40;   // geotagged here, not named

  // "<something> from <entity>" and "view from <entity>" are pictures of the view, not of it.
  if(new RegExp(`\\b(from|seen from|view from|taken from)\\s+(the\\s+)?${lw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`).test(lt)) return 0;

  // Leading position means the file is about the entity. Anything before it is another
  // subject, and the more that comes first the less likely the entity is what is pictured.
  const before = t.slice(0, at).replace(/^(the|a|an)\s+/i, '').trim();
  if(!before) return 92;
  const commas = (before.match(/,/g) || []).length;
  if(commas >= 1) return 0;                              // "Infant and Skull, Medieval, Louvre"
  return before.split(/\s+/).length <= 2 ? 80 : 55;      // "Interior of Louvre" is still fine
}

async function commonsGeoPhoto(entity, opts){
  const o = opts || {};
  if(entity.lat == null || entity.lng == null) return null;
  const radius = o.radius || 300;
  const url = `${COMMONS_API}?action=query&format=json&origin=*` +
    `&generator=geosearch&ggsnamespace=6&ggsradius=${radius}` +
    `&ggscoord=${entity.lat}%7C${entity.lng}&ggslimit=30` +
    `&prop=imageinfo&iiprop=url&iiurlwidth=${o.width || 720}`;
  const data = await fetchWikiJSON(url);
  if(!data) return null;

  const want = String(entity.name || '');
  let best = null;
  for(const p of Object.values((data.query && data.query.pages) || {})){
    const info = (p.imageinfo || [])[0];
    const thumb = info && info.thumburl;
    if(!thumb || !looksLikePhoto(thumb)) continue;
    const title = String(p.title || '').replace(/^File:/i, '');
    if(!isTravelAppropriate(title) || !isTravelAppropriate(thumb)) continue;
    const score = commonsTitleScore(title, want);
    if(score <= 0) continue;               // names the entity but does not depict it
    if(!best || score > best.score) best = { url: thumb, score, named: score >= 85, title };
    if(score >= 90) break;                 // as good as this rung gets
  }
  return best;
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
  for(const ep of IMAGERY_OVERPASS_ENDPOINTS){
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

/** A destination's Wikidata "image" (P18) — a curated, representative photograph chosen by
 *  editors to stand for the place as a whole. That is exactly what a country or region needs
 *  and exactly what proximity search cannot give: France's article leads with a flag, and
 *  geosearch at the centroid of a country is meaningless, but P18 is a picture of France.
 *  Resolved via the Wikipedia article we already matched, so it inherits that verification. */
async function destinationWikidataImage(entity, width){
  const url = `https://en.wikipedia.org/w/api.php?action=query&generator=search` +
    `&gsrsearch=${encodeURIComponent(entity.name)}&gsrlimit=3` +
    `&prop=pageprops|coordinates&ppprop=wikibase_item&colimit=10&format=json&origin=*`;
  const data = await fetchWikiJSON(url);
  if(!data) return null;
  const pages = Object.values((data.query && data.query.pages) || {})
    .sort((a,b) => (a.index || 9) - (b.index || 9));
  for(const p of pages){
    const qid = (p.pageprops || {}).wikibase_item;
    if(!qid) continue;
    // The article must BE the place, not merely mention it. titleNamesPlace is deliberately
    // generous elsewhere ("Queenstown, New Zealand" for Queenstown), and that generosity
    // matched "Adult video in Japan" for Japan. For a representative image the title has to
    // be the name itself, optionally with a parenthetical or a ", <region>" qualifier.
    const bare = String(p.title).replace(/\s*\(.*?\)\s*$/, '').split(',')[0].trim();
    if(bare.toLowerCase() !== String(entity.name).trim().toLowerCase()) continue;
    // Same coordinate discipline as everywhere else: the article must be the right place.
    const c = (p.coordinates || [])[0];
    if(c && entity.lat != null &&
       kmBetween(entity.lat, entity.lng, c.lat, c.lon) > destPhotoRadiusKm(entity.placeType)) continue;
    const img = await wikidataImage(qid, width, { preferBanner: true, withProp: true });
    if(img) return img;
  }
  return null;
}

/* ---------------- The resolver ----------------
   `entity` is the canonical object: { placeId, name, type, kind, country, countryCode,
   lat, lng }. `kind` is what the card is showing — 'destination', 'attraction',
   'restaurant', 'hotel' — which decides how much is allowed to stand in for it. */
/* ============================================================================
 * EXACT-PLACE VERIFICATION
 *
 * The question every candidate has to answer is "does this photograph show THIS place", not
 * "is this vaguely about the destination". Those are different standards and only the first is
 * useful to somebody trying to recognise a doorway on a street.
 *
 * So candidates are gathered from several sources, scored against the entity's full identity —
 * name, address, city, country, category — and the best one wins only if it clears a bar. When
 * nothing clears it the card gets an honest empty state. A wrong photograph is worse than none:
 * it actively misleads, and the traveller has no way to know.
 * ========================================================================== */

/** Everything known about the entity, folded for comparison. */
function entityIdentity(entity){
  // Separators are folded on BOTH sides of every comparison. Normalising only the title meant
  // "Saint-Germain" in an address never matched "Saint_Germain" in a filename.
  const fold = s => foldPunct(String(s || '')).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  const addr = String(entity.address || '');
  return {
    name: fold(entity.name),
    localName: fold(entity.localName),
    city: fold(entity.city || entity.destName || ''),
    country: fold(entity.country),
    street: fold(addr.replace(/^\d+\s*/, '')),
    houseNumber: (addr.match(/^\d+/) || [''])[0],
    category: String(entity.subtype || entity.kind || '').toLowerCase(),
    fold,
  };
}

/* Words that mean the picture is of the BUILDING or the VENUE, which is what a traveller needs
 * to recognise the place when they arrive. */
const SHOWS_THE_PLACE = ['exterior','facade','façade','storefront','shopfront','shop front',
  'entrance','frontage','building','interior','dining room','terrace','lobby','courtyard',
  'street view','from the street','outside','vue','aussenansicht','fassade'];

/* Words that mean the picture is of something else that merely happens to be associated. */
const SHOWS_SOMETHING_ELSE = {
  restaurant: ['dish','plate','menu','recipe','cuisine of','food of','close-up','closeup'],
  cafe:       ['latte art','cup of','coffee bean','close-up','closeup'],
  hotel:      ['bed','bathroom','towel','minibar','swimming pool'],
};

/* A photograph from long before the place looked as it does now does not help anyone recognise
 * it. Engravings, postcards and pre-war photographs are the common shapes on Commons. */
const HISTORICAL_MARKERS = ['engraving','gravure','lithograph','postcard','carte postale',
  'ansichtskarte','woodcut','etching','illustration','drawing','painting','plan of','map of',
  'archive','historical','historique','vintage','collection des'];

/** The year a Commons title claims, when it claims one. */
function titleYear(title){
  const m = String(title).match(/\b(1[6-9]\d{2}|20[0-4]\d)\b/);
  return m ? parseInt(m[1], 10) : null;
}

/** Scores one candidate against the entity. Returns a number and the reasons behind it, so a
 *  rejection can be explained rather than guessed at. */
function scoreImageCandidate(title, entity, source){
  const id = entityIdentity(entity);
  // Underscores, hyphens and dots are separators in a Commons filename and spaces in its title.
  // Without folding them the very same photograph scores as a match by title and a miss by
  // filename, which is how a correct image could be resolved and then rejected on re-check.
  const t = id.fold(String(title)
    .replace(/^File:/i, '')
    .replace(/^\d+px-/, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_\-.]+/g, ' '));
  const reasons = [];
  let score = IMAGE_CONFIDENCE[source] != null ? IMAGE_CONFIDENCE[source] : 40;

  // Does the title name this exact place?
  const named = id.name && hasWholeWordFolded(t, id.name);
  const namedLocal = id.localName && hasWholeWordFolded(t, id.localName);
  if(named || namedLocal){ score += 30; reasons.push('names the place'); }
  else if(source === 'commons_text' || source === 'commons_named'){
    // These sources exist to find the place by name; without the name they prove nothing.
    score -= 35; reasons.push('does not name the place');
  }

  // Address and city corroborate that it is the right one of several same-named places.
  if(id.street && hasWholeWordFolded(t, id.street)){ score += 15; reasons.push('matches the street'); }
  if(id.houseNumber && t.includes(id.houseNumber)){ score += 6; reasons.push('matches the number'); }
  if(id.city && hasWholeWordFolded(t, id.city)){ score += 8; reasons.push('matches the city'); }
  else if(id.city && (named || namedLocal) && /,\s*[a-z]/i.test(String(title))){
    // The title names the place AND carries a place qualifier that is not this city: "Cafe de
    // Flore, Buenos Aires" is a different cafe with the same name, which is exactly the failure
    // the brief calls out. Coordinates settle it where the file has them; where it does not,
    // this is the evidence available.
    score -= 40; reasons.push('names a different city');
  }

  // Is it a picture of the place, or of something merely associated with it?
  if(SHOWS_THE_PLACE.some(w => t.includes(w))){ score += 12; reasons.push('shows the building'); }
  const wrongFor = SHOWS_SOMETHING_ELSE[id.category] || SHOWS_SOMETHING_ELSE[entity.kind] || [];
  if(wrongFor.some(w => t.includes(w)) && !named && !namedLocal){
    score -= 30; reasons.push('shows a dish or a room rather than the place');
  }

  // Recency. A place a traveller has to recognise today is not well served by an engraving.
  if(HISTORICAL_MARKERS.some(w => t.includes(w))){ score -= 45; reasons.push('historical depiction'); }
  const year = titleYear(t);
  if(year != null){
    if(year >= 2015){ score += 10; reasons.push('recent'); }
    else if(year >= 2005){ score += 4; }
    else if(year < 1990){ score -= 50; reasons.push('long out of date'); }
    else { score -= 12; reasons.push('dated'); }
  }

  return {score, reasons};
}

/** Whole-word containment on already-folded strings. */
function hasWholeWordFolded(haystack, needle){
  const n = String(needle || '').trim();
  if(!n || n.length < 3) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try{ return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u').test(haystack); }
  catch(e){ return haystack.indexOf(n) >= 0; }
}

/** Commons full-text search for the entity by name AND place. This is the source that finds a
 *  named business at all: geosearch only knows what was photographed near a coordinate, and a
 *  small cafe is rarely the subject of anything geotagged at its doorway. */
async function commonsTextCandidates(entity, opts){
  const o = opts || {};
  const name = String(entity.name || '').trim();
  if(!name) return [];
  const place = [entity.city || entity.destName, entity.country].filter(Boolean).join(' ');
  const query = `"${name}" ${place}`.trim() + ' filetype:bitmap';
  const url = `${COMMONS_API}?action=query&format=json&origin=*&list=search&srnamespace=6` +
    `&srlimit=10&srsearch=${encodeURIComponent(query)}`;
  const data = await fetchWikiJSON(url);
  const hits = (data && data.query && data.query.search) || [];
  if(!hits.length) return [];

  // Resolve the ones worth resolving: score on the title first, fetch thumbnails after, so a
  // search that returns ten irrelevant files costs one request rather than eleven.
  const scored = hits
    .map(h => ({title: h.title, ...scoreImageCandidate(h.title, entity, 'commons_text')}))
    .filter(c => c.score >= 55)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if(!scored.length) return [];

  const titles = scored.map(c => c.title).join('|');
  const infoUrl = `${COMMONS_API}?action=query&format=json&origin=*&titles=${encodeURIComponent(titles)}` +
    `&prop=imageinfo&iiprop=url&iiurlwidth=${o.width || 720}`;
  const info = await fetchWikiJSON(infoUrl);
  const out = [];
  for(const page of Object.values((info && info.query && info.query.pages) || {})){
    const ii = (page.imageinfo || [])[0];
    const thumb = ii && ii.thumburl;
    if(!thumb || !looksLikePhoto(thumb)) continue;
    const title = String(page.title || '').replace(/^File:/i, '');
    if(!isTravelAppropriate(title) || !isTravelAppropriate(thumb)) continue;
    const s = scoreImageCandidate(title, entity, 'commons_text');
    out.push({url: thumb, title, source: 'commons_text', confidence: s.score, reasons: s.reasons});
  }
  return out;
}

async function resolveEntityImage(entity, opts){
  const o = opts || {};
  if(!entity || !entity.name) return null;

  const cached = imageryCacheGet(entity);
  if(cached) return cached.url ? cached : null;

  let result = null;

  // Rung 1: photographs geotagged AT the entity — but only for a NAMED entity.
  //
  // A destination and an entity need opposite things. "Marina Bay Sands" wants the photo
  // taken at those coordinates; "Tokyo" wants the image that REPRESENTS Tokyo, and geosearch
  // at a city centroid returns whatever happens to be photographed within a few hundred
  // metres — it offered the Tokyo International Forum's roof for Tokyo, a church for Reine
  // and a waterfall for Hallstatt, displacing the skyline, the fjord and the village square
  // that the destination path had already resolved. Destinations therefore skip this rung
  // entirely and keep the representative-image ladder in data.js.
  const isDestination = entity.kind === 'destination';

  /* CANDIDATES, then a choice — not the first thing that passes.
   *
   * Each source is asked for what it has, every answer is scored against the entity's full
   * identity, and the best scoring candidate wins. Sources are consulted in order of how
   * expensive they are, and the search stops early only when something already clears the high
   * bar, because there is nothing better to find above it. */
  if(!isDestination){
    const candidates = [];
    const best = () => candidates.sort((a, b) => b.confidence - a.confidence)[0] || null;

    /* Order is by yield per second, not by authority.
     *
     * Commons text search answers in a second or two and, measured against real venues, returns
     * confidence 98-119 for a cafe, a landmark, a museum and a hotel. Overpass is the more
     * authoritative source — a photo tagged on the place itself cannot be beaten — but it takes
     * 15 to 30 seconds and only a small minority of places carry an image tag at all. Asking it
     * first made every card wait half a minute for an answer that usually was not there.
     *
     * So the cheap high-yield source goes first, and when it already clears the high bar the
     * expensive ones are never called: there is nothing above "a photograph that names this
     * place, its street and its city" worth waiting for. */

    // 1. Commons, searched by name AND place. This is what finds a named business at all.
    try {
      const found = await commonsTextCandidates(entity, {width: o.width, signal: o.signal});
      candidates.push(...found);
    } catch(err){ if(err.name === 'AbortError') throw err; }

    // 2. The entity's own OSM tags: the mapper's statement that this photograph IS this place.
    if(!best() || best().confidence < IMAGE_HIGH_CONFIDENCE){
      try {
        const tags = await overpassEntityTags(entity, { signal: o.signal, radius: o.radius });
        const found = await imageFromOsmTags(tags, o.width || 720);
        if(found && isTravelAppropriate(found.url)){
          candidates.push({ url: found.url, source: found.source, title: found.url,
                            confidence: IMAGE_CONFIDENCE[found.source] || 80,
                            reasons: ['tagged on the place itself'] });
        }
      } catch(err){ if(err.name === 'AbortError') throw err; }
    }

    // 3. Photographs geotagged at the entity, re-scored against its identity rather than
    //    trusted for being nearby. A picture taken at these coordinates is evidence, not proof.
    if(!best() || best().confidence < IMAGE_HIGH_CONFIDENCE){
      try {
        const geo = await commonsGeoPhoto(entity, { width: o.width, signal: o.signal, radius: 300 });
        if(geo){
          const src = geo.named ? 'commons_named' : 'commons_nearby';
          const rescored = scoreImageCandidate(geo.title || geo.url, entity, src);
          candidates.push({ url: geo.url, source: src, title: geo.title,
                            confidence: Math.min(geo.score, rescored.score),
                            reasons: rescored.reasons });
        }
      } catch(err){ if(err.name === 'AbortError') throw err; }
    }

    result = best();
  }

  // Rung 3: the destination's own representative image, verified by name and coordinates.
  if(!result && isDestination){
    const url = await resolveDestinationPhoto(entity);
    if(url){
      const tier = destPhotoTierFor(entity.placeId || entity.id);
      const source = tier === 'article' ? 'wikipedia_verified' : 'landmark_inside';
      result = { url, source, confidence: IMAGE_CONFIDENCE[source] };
    }
  }

  // Rung 4: a curated representative image, for the destinations whose own article leads with
  // a flag or a map — which is most countries.
  if(!result && isDestination){
    try {
      const img = await destinationWikidataImage(entity, o.width || 720);
      if(img){
        const source = img.prop === 'P948' ? 'wikivoyage_banner' : 'wikidata_p18';
        result = { url: img.url, source, confidence: IMAGE_CONFIDENCE[source] };
      }
    } catch(err){ if(err.name === 'AbortError') throw err; }
  }

  /* The bar. A named entity must be DEPICTED, not approximated.
   *
   *   high      display it
   *   medium    only when nothing better was found anywhere, and it still cleared the floor
   *   below     rejected — the card shows an honest empty state instead
   *
   * Showing nothing is the correct outcome when nothing qualifies. A wrong photograph misleads
   * with total confidence and the traveller has no way to catch it; a blank frame at least
   * tells the truth. */
  if(result && !isDestination && result.confidence < IMAGE_MIN_CONFIDENCE_ENTITY){
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
    // Two different places can resolve to the same photograph — a shared building, a square that
    // several venues sit on, a Commons file that names a whole street. Whichever card claims it
    // first keeps it; the other keeps looking rather than showing a picture of its neighbour.
    const claimant = entity.placeId || entity.id || entity.name;
    if(typeof claimImage === 'function' && !claimImage(res.url, claimant)) return;

    imgEl.src = res.url;
    imgEl.hidden = false;
    imgEl.dataset.imageSource = res.source;
    imgEl.dataset.imageConfidence = String(res.confidence);
    // The empty state was telling the truth until now; a verified photograph replaces it.
    try{
      const wrap = imgEl.closest && imgEl.closest('.placeImgWrap');
      const empty = wrap && wrap.querySelector('.noPhoto');
      if(empty) empty.remove();
    }catch(e){ /* non-critical */ }
    // A real photograph of this exact entity has arrived, so the "Illustrative" mark on the
    // stand-in is no longer true and must come off with it.
    try{
      const wrap = imgEl.closest && imgEl.closest('.placeImgWrap');
      const badge = wrap && wrap.querySelector('.illusBadge');
      if(badge) badge.remove();
    }catch(e){ /* non-critical */ }
  }).catch(()=>{});
}

/* Exported for the test suites; the browser uses these as globals and ignores this block. */
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    IMAGE_CONFIDENCE, IMAGE_MIN_CONFIDENCE_ENTITY, IMAGE_HIGH_CONFIDENCE,
    scoreImageCandidate, entityIdentity, commonsTextCandidates, commonsGeoPhoto,
    commonsTitleScore, resolveEntityImage, foldPunct, hasWholeWordFolded, titleYear,
    SHOWS_THE_PLACE, SHOWS_SOMETHING_ELSE, HISTORICAL_MARKERS,
  };
}
