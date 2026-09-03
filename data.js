/* ============================================================
   TripFlow — mock data layer
   All destinations, attractions, restaurants and hotels below
   are illustrative demo content (realistic, not lorem ipsum).
   Prices are approximate USD for consistent budget math.
============================================================ */

function slugify(s){ return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
const TITLE_CASE_MINOR_WORDS = new Set(['a','an','and','as','at','but','by','en','for','if','in','nor','of','on','or','the','to','v','via','vs']);
function titleCaseDestName(s){
  const words = s.trim().split(/\s+/);
  return words.map((w,i)=>{
    const lower = w.toLowerCase();
    if(i>0 && i<words.length-1 && TITLE_CASE_MINOR_WORDS.has(lower)) return lower;
    return lower.charAt(0).toUpperCase()+lower.slice(1);
  }).join(' ');
}

/* Self-contained SVG placeholder "photos" — zero network requests, so they
   always render (no dependency on an external image CDN that can be
   blocked, rate-limited, or offline). Deterministic per seed so the same
   place always gets the same look across reloads. */
function hashStr(s){ let h=0; s=String(s); for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; } return Math.abs(h); }
function escapeXML(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
/** Base64-encodes a UTF-8 SVG string for a data URI. Percent-encoded (`;utf8,`) data URIs are
    inconsistently supported on some mobile/WebKit builds — base64 is the most broadly compatible
    format for `<img src>` across browsers, so every generated placeholder uses it. */
function svgToDataUri(svg){
  const bytes = encodeURIComponent(svg).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const b64 = (typeof btoa === 'function') ? btoa(bytes) : Buffer.from(svg, 'utf8').toString('base64');
  return 'data:image/svg+xml;base64,' + b64;
}
/** The frame shown only when NO photograph exists for something — offline, or a place
 * genuinely unphotographed anywhere. Everything else now resolves to a real photo: bundled
 * for the curated destinations, a dish or category photograph for demo entries, the live
 * lookup for typed-in cities.
 *
 * It used to draw a grey panel with a large camera glyph, which read to people as a broken
 * image — the single most common complaint about the site's look. It is now a quiet dark
 * editorial panel carrying the place's own name: unmistakably a typographic card rather than
 * a photograph, so it still never passes itself off as "what this place looks like", but it
 * sits in a grid of photography without looking like a failure. Deterministic per seed, so a
 * given place keeps the same shade across reloads. */
function img(seed,w,h,label){
  w=w||640; h=h||480;
  const maxChars = Math.max(10, Math.floor(w/14));
  let text = String(label||'').trim();
  if(text.length > maxChars) text = text.slice(0, maxChars-1) + '…';
  const hue = 194 + (hashStr(String(seed)) % 26);          // narrow teal-slate band, on-brand
  const fontSize = Math.round(Math.min(w/11, h/5.5));
  const rule = Math.round(w*0.07);
  const cy = Math.round(h*0.52);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">
<stop offset="0" stop-color="hsl(${hue},22%,26%)"/><stop offset="1" stop-color="hsl(${hue},26%,14%)"/>
</linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<rect x="${w/2-rule/2}" y="${cy-fontSize*1.15}" width="${rule}" height="2" fill="hsl(${hue},30%,62%)" opacity="0.85"/>
<text x="50%" y="${cy}" font-family="'Plus Jakarta Sans',Arial,Helvetica,sans-serif" font-size="${fontSize}"
 font-weight="700" fill="#eef4f2" text-anchor="middle" dominant-baseline="middle"
 letter-spacing="${(fontSize*0.02).toFixed(2)}">${escapeXML(text)}</text>
</svg>`;
  return svgToDataUri(svg);
}

/* ---- Per-destination scene pool ----
   Several curated places have no photograph of their own (a small restaurant, most hotels).
   They used to all fall back to the same single destination-level shot, so Marrakech rendered
   one identical photo on seven cards. Each destination now carries a pool of genuinely
   different nearby landmarks, handed out one per card, so every place still gets a real photo
   OF THAT CITY and no two cards on a page repeat. */
function scenePool(destId){
  const counts = (typeof window !== 'undefined' && window.SCENE_PHOTOS) || {};
  return counts[destId] || 0;
}
/** Hands out the next unused scene photo for a destination, or null once the pool runs dry. */
function makeSceneDealer(destId){
  const total = scenePool(destId);
  let n = 0;
  // Skips gaps rather than stopping at one: a missing number in the middle of the pool used
  // to end the deal early and leave later cards without a distinct photo.
  return () => {
    while(n < total){ const src = bundledPhoto(`scene/${destId}-${++n}`); if(src) return src; }
    return null;
  };
}

/* ---- Generic category photography ----
   The last rung before the generated placeholder. A typed-in destination's starter
   restaurants and stays are openly illustrative demo entries, so a real photograph of a
   bakery or a hotel room represents them honestly, where a grey frame just looks broken.
   These are never presented as the specific property — and because their path lives under
   images/category/, hydratePhotos still treats them as upgradeable and swaps in a real
   photo of the actual place the moment the live lookup finds one. */
const CATEGORY_PHOTOS = {
  attraction:{ Culture:'old-town', Museum:'museum', History:'cathedral', Nature:'promenade',
               Viewpoint:'viewpoint', Market:'market' },
  restaurant:{ 'Local Cuisine':'restaurant', Fusion:'fine-dining', 'Café':'bakery',
               Seafood:'restaurant', International:'restaurant', 'Bakery & Café':'bakery' },
};
function categoryPhoto(group, key){
  const slug = (CATEGORY_PHOTOS[group] || {})[key];
  return slug ? bundledPhoto('category/' + slug) : null;
}
/** Stays are graded by star rating so a hostel and a five-star suite don't share one photo. */
function hotelCategoryPhoto(stars){
  const slug = stars >= 5 ? 'hotel-luxury' : (stars <= 2 ? 'hostel' : 'hotel-room');
  return bundledPhoto('category/' + slug);
}

/* ---- Bundled photography (images/, indexed by photos.js) ----
   The 12 curated destinations and their places ship with real, licence-cleared photographs
   committed to the repo, so they paint immediately on first load and keep working with the
   network blocked, throttled or offline — the live Wikipedia lookup below is what handles
   the *worldwide* destinations a visitor types in, not the curated ones.

   A key that isn't in the index has no confidently-matching photograph; that place keeps the
   placeholder and the live lookup rather than borrowing a loosely-related image. photos.js is
   optional at runtime (imagecheck.html loads data.js on its own to exercise the live path),
   so its absence degrades to exactly the old behaviour instead of throwing. */
function photoIndex(){ return (typeof window !== 'undefined' && window.LOCAL_PHOTOS) || {}; }
/** Any bundled photo for this key — an exact match (1) or an honest area stand-in (2). */
function bundledPhoto(key){ return photoIndex()[key] ? 'images/' + key + '.jpg' : null; }
/** Only a photo that actually depicts the thing itself, never a neighbourhood stand-in. */
function bundledPhotoExact(key){ return photoIndex()[key] === 1 ? 'images/' + key + '.jpg' : null; }
/** A photo of the food a restaurant serves. Most small restaurants have no photograph
 * anywhere, and a street scene of their neighbourhood is a poor advert for a dinner — a real
 * plate of the cuisine they actually cook says far more, and claims nothing untrue about the
 * premises. Ranked above the area stand-in for that reason, and below a photo of the real place. */
function bundledCuisinePhoto(cuisine, claimed){
  const keys = (typeof window !== 'undefined' && window.CUISINE_PHOTO_KEYS) || {};
  const key = cuisine && keys[cuisine];
  if(!key) return null;
  // Two ramen bars in the same city sharing one identical bowl reads as a bug, not a menu.
  // The first restaurant of a cuisine gets the dish; later ones fall through to their own
  // neighbourhood photo, which at least differs from card to card.
  if(claimed){ if(claimed.has(key)) return null; claimed.add(key); }
  return bundledPhoto(key);
}

/* ============================================================
   LIVE DATA — keyless, worldwide, best-effort with graceful fallback.
   Every call is cached (memory + localStorage) and wrapped so a slow,
   blocked, or offline network never breaks the app — callers always
   get the gradient placeholder / procedurally-generated data until
   (and unless) real data arrives, then the UI is upgraded in place.
============================================================ */
function readJSONCache(key){ try{ return JSON.parse(localStorage.getItem(key)) || {}; }catch(e){ return {}; } }
function writeJSONCache(key, obj){ try{ localStorage.setItem(key, JSON.stringify(obj)); }catch(e){} }
async function fetchWithTimeout(url, ms, opts){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), ms||8000);
  try{ return await fetch(url, Object.assign({signal:ctrl.signal}, opts||{})); }
  finally{ clearTimeout(timer); }
}
/** Wikipedia's thumbnailer refuses to upscale past an image's original dimensions, and the API
 * already caps the thumbnail it hands back at the source image's real width. Rewriting that URL
 * to force a larger size therefore manufactures a 404 for every image whose original is narrower
 * than the size we asked for — which silently cost those destinations their photo. Trust the
 * width the API actually returned; only shrink an oversized one, never grow it. */
function capWikiThumb(url /*, maxWidth */){
  // Deliberately a pass-through now. Wikimedia's thumbnailer serves only a DISCRETE set of
  // widths — probed against a real 5184px file, 960 and 1280 return 200 while 320, 480, 640,
  // 720, 800 and 1024 all return 400 Bad Request. This function used to rewrite the API's URL
  // down to 720px whenever the API had picked something larger, which turned a working 960px
  // thumbnail into a guaranteed 400. Twenty-one images on a single Seoul page load were
  // failing this way, each one falling back to a category stand-in even though a real
  // photograph of the place had been found.
  //
  // The API already picks a valid width for the iiurlwidth we ask for, so the correct handling
  // is to use exactly what it returned and never rewrite the size.
  return url;
}

/* ---- Real photos via Wikipedia's public REST API (no key, CORS-enabled) ---- */
const PHOTO_CACHE_KEY = 'tripflow_photo_cache_v1';
// A miss is remembered, but only briefly. Never remembering one means a query that genuinely
// has no photo (plenty of small restaurants and hotels don't) is re-fetched on every single
// page load — real devices accumulate hundreds of these, so that's hundreds of pointless
// requests per load. Remembering one forever is the bug that froze placeholders in place.
// A short expiry gets both: no repeat hammering, and anything that failed for a transient
// reason retries on its own soon after.
const PHOTO_MISS_TTL_MS = 24 * 3600 * 1000;
const PHOTO_CACHE_MAX = 600;
let __photoCache = null;
function photoCache(){ if(!__photoCache) __photoCache = readJSONCache(PHOTO_CACHE_KEY); return __photoCache; }
/** Keeps the cache from growing without bound in localStorage. Remembered misses are evicted
 * first (oldest first) — they're the cheapest to re-derive — before any real photo URL. */
function prunePhotoCache(cache){
  const keys = Object.keys(cache);
  let over = keys.length - PHOTO_CACHE_MAX;
  if(over <= 0) return;
  const misses = keys.filter(k=>{ const v = cache[k]; return v && typeof v === 'object' && v.miss; })
                     .sort((a,b)=> cache[a].miss - cache[b].miss);
  for(const k of misses){ if(over<=0) break; delete cache[k]; over--; }
  for(const k of Object.keys(cache)){ if(over<=0) break; delete cache[k]; over--; }
}
/* A page can ask for dozens of photos at once, and a browser will happily fire every one of
 * them in parallel. That stampede is self-defeating: requests time out under their own weight,
 * and each timeout used to be recorded as a miss, so a busy page could lock in a whole screen
 * of placeholders. Lookups now queue through a small number of slots — slightly slower to fill
 * in, dramatically more likely to actually succeed. */
const PHOTO_CONCURRENCY = 5;
let __photoActive = 0;
const __photoQueue = [];
function withPhotoSlot(task){
  return new Promise(resolve=>{
    const run = async ()=>{
      __photoActive++;
      let out = null;
      try{ out = await task(); }catch(e){}
      __photoActive--;
      const next = __photoQueue.shift();
      if(next) next();
      resolve(out);
    };
    if(__photoActive < PHOTO_CONCURRENCY) run();
    else __photoQueue.push(run);
  });
}
async function fetchWikiThumbnail(query){
  const cache = photoCache();
  const key = query.trim().toLowerCase();
  const hit = cache[key];
  if(typeof hit === 'string' && hit) return hit;
  // A remembered miss suppresses the retry only while it's still fresh. A legacy entry (a bare
  // null, written before misses carried a timestamp) is treated as "not resolved yet" and
  // always retries, so caches poisoned by the old behavior heal themselves.
  if(hit && typeof hit === 'object' && hit.miss && (Date.now() - hit.miss) < PHOTO_MISS_TTL_MS) return null;
  return withPhotoSlot(()=>lookupWikiThumbnail(key, query));
}
async function lookupWikiThumbnail(key, query){
  const cache = photoCache();
  // Another queued lookup for the same query may have resolved while this one waited its turn.
  const queued = cache[key];
  if(typeof queued === 'string' && queued) return queued;

  let result = null;
  // Did Wikipedia actually ANSWER? "It replied, and that page has no image" is a real answer
  // worth remembering. "The request timed out / was refused / never completed" is not an answer
  // at all, and must never be cached — that's what froze whole pages on placeholders.
  let answered = false;
  try{
    // A fuzzy, relevance-ranked SEARCH (not an exact-title lookup) so descriptive names like
    // "Nusa Penida Day Trip" still resolve to the real "Nusa Penida" article instead of 404ing —
    // Wikipedia's REST summary endpoint requires the exact page title and misses these often.
    const url = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=1&prop=pageimages&piprop=thumbnail&pithumbsize=720&format=json&origin=*`;
    const res = await fetchWithTimeout(url, 7000, {headers:{'Accept':'application/json'}});
    if(res && res.ok){
      const data = await res.json();
      answered = true;
      const pages = (data.query && data.query.pages) || {};
      const page = Object.values(pages)[0];
      if(page && page.thumbnail && page.thumbnail.source
         && isTravelAppropriate(page.title) && isTravelAppropriate(page.thumbnail.source)){
        result = capWikiThumb(page.thumbnail.source, 720);
      }
    }
  }catch(e){ /* offline, blocked, timed out — deliberately left uncached so it retries */ }

  if(result) cache[key] = result;
  else if(answered) cache[key] = { miss: Date.now() };
  else return null;                       // transient: leave no trace, try again next time
  prunePhotoCache(cache);
  writeJSONCache(PHOTO_CACHE_KEY, cache);
  return result;
}
/** Clears every remembered photo lookup so the next render re-fetches from scratch. The escape
 * hatch for a browser whose cache filled up with misses during a bad network moment. */
function clearPhotoCache(){
  __photoCache = {};
  try{ localStorage.removeItem(PHOTO_CACHE_KEY); }catch(e){}
}
/** Destination image priority chain, so ANY destination — a city, a coastline, a mountain
 * range, an island, a small town, a region — gets a real, relevant photo without ever being
 * hardcoded per name: 1) the destination's own name (its Wikipedia article's real lead photo —
 * for "Amalfi Coast" or "Swiss Alps" that's already coastline/mountain imagery, not a skyline),
 * 2) destination name qualified with its country (disambiguates a common/short place name),
 * 3) the country alone. Only once every real tier fails does the caller fall back to the
 * generated placeholder — never straight to it on the first miss. */
/** Synchronous "do we already know this photo?" lookup. Lets a render swap the real photo in
 * before the browser paints, so revisiting a page shows photography immediately instead of
 * flashing the placeholder again while an already-answered lookup round-trips. */
function cachedWikiThumbnail(queries){
  const cache = photoCache();
  for(const q of queries){
    if(!q) continue;
    const hit = cache[String(q).trim().toLowerCase()];
    if(typeof hit === 'string' && hit) return hit;
  }
  return null;
}
async function fetchWikiThumbnailChain(queries){
  for(const q of queries){
    if(!q) continue;
    const url = await fetchWikiThumbnail(q);
    if(url) return url;
  }
  return null;
}

/* ---- Destination photography, worldwide ----
   A destination's own article is usually the best photo of it, but searching by name alone
   gets two things wrong often enough to matter, and both were measured across 51 places on
   six continents rather than guessed at:

     · It can match something that is not a place. "Vinales" returned Maverick Viñales, a
       MotoGP rider — a photograph of a motorcyclist standing in for a Cuban valley. Articles
       about people carry no coordinates, so requiring coordinates near the destination
       rejects the whole class of error.
     · It can find the right article with no photograph on it. "Swiss Alps" and "Reine"
       resolved to the correct page and came back empty.

   So: take several candidates rather than only the first, keep the best one that is provably
   the right PLACE, and when the place itself has no picture, fall back to a real photograph
   of a real landmark beside it (Reine borrows Moskenes Municipality, the Swiss Alps borrow
   the Jungfrau). That lifts coverage from 96% to essentially everywhere a traveller can go,
   and every image is still a genuine photograph of that location. */

/** Wikipedia throttles bursts with 429. Without a retry a throttled moment reads as "this
 *  place has no photo": a run of destinations went from resolving to blank purely because the
 *  requests were refused, which measured as 67% coverage instead of the real 96%. One retry
 *  after a short pause recovers nearly all of it, and a refusal is still never cached as a
 *  miss — only a real answer is. */
/* Wikimedia request gate.
 *
 * Every place card resolves its own photograph, and each resolution makes several Commons and
 * Wikipedia calls. A page of 24 cards therefore fired around a hundred requests at once, and
 * Wikimedia answered with 36 Commons 429s and 21 Wikipedia 429s in a single live page load —
 * so cards that had a perfectly good photograph available kept their stand-in instead. Retrying
 * harder makes it worse, because the retries collide too.
 *
 * Three or four in flight is enough to keep a page filling steadily without tripping the limit.
 * Everything else waits its turn, which costs a little latency on a dense page and gains the
 * photographs that were previously being thrown away. */
const WIKI_MAX_CONCURRENT = 3;
let wikiInFlight = 0;
const wikiWaiting = [];

function wikiAcquire(){
  if(wikiInFlight < WIKI_MAX_CONCURRENT){ wikiInFlight++; return Promise.resolve(); }
  return new Promise(resolve => wikiWaiting.push(resolve));
}
function wikiRelease(){
  const next = wikiWaiting.shift();
  if(next) next();            // hand the slot straight over
  else wikiInFlight = Math.max(0, wikiInFlight - 1);
}

async function fetchWikiJSON(url){
  await wikiAcquire();
  try{
    for(let attempt = 0; attempt < 3; attempt++){
      try {
        const res = await fetchWithTimeout(url, 8000, {headers:{'Accept':'application/json'}});
        if(res && res.ok) return await res.json();
        if(res && (res.status === 429 || res.status === 503)){
          // Honour Retry-After when the server sends one; otherwise back off with jitter so a
          // batch of throttled requests does not all come back at the same instant.
          const after = res.headers && res.headers.get && Number(res.headers.get('retry-after'));
          const wait = (after > 0 && after < 30) ? after * 1000
                     : (800 * Math.pow(2, attempt)) + Math.random() * 400;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        return null;                        // a real error, not worth retrying
      } catch(e){
        if(attempt >= 1) return null;
        await new Promise(r => setTimeout(r, 500));
      }
    }
    return null;
  } finally {
    wikiRelease();
  }
}

/** Filenames that are graphics rather than photographs of a place. The bundled-image importer
 *  rejects these too — without it here, "Faroe Islands" resolved to the national flag and
 *  "Socotra" to a satellite view. */
const NON_PHOTO_FILE = new RegExp([
  'flag', 'coat[_ ]of[_ ]arms', '\\bseal\\b', '\\blogo\\b', 'emblem', 'blason',
  // "map" in the languages Wikipedia files actually use — Nosy Be resolved to
  // "Carte_de_Nosy_Be", a French map, because only the English word was blocked.
  '\\bmap\\b', '\\bcarte\\b', '\\bmapa\\b', '\\bkarte\\b', '\\bkaart\\b', '\\bmappa\\b',
  'locator', 'location_map', 'topograph', 'orthophoto',
  // Satellite frames: "Alps_2007-03-13_10.10UTC_1px-250m.jpg" is imagery of a place, not a
  // photograph of it.
  'satview', 'satellite', '\\baster\\b', 'landsat', 'sentinel', '\\bnasa\\b', 'utc_',
  // A rendered vector graphic. Wikipedia serves these as "<name>.svg.png", and a diagram is
  // essentially never what a traveller should see — this alone caught two locator maps.
  'svg png', '\\bsvg\\b',
].join('|'), 'i');
/** Photographs on Wikimedia Commons are overwhelmingly JPEG; maps, diagrams, flags and
 *  charts are PNG, GIF or SVG. Names alone cannot separate them — "2011_Dimos_Thiras.png" is
 *  a municipality map of Santorini and says nothing about being one, and a 10th-century map
 *  arrived for Tuscany the same way. The import pipeline catches these by inspecting pixels,
 *  which is too expensive at runtime; the file format is the cheap signal that agrees with it
 *  almost always, and anything wrongly excluded simply falls to the next candidate. */
function isPhotographicFormat(url){
  const base = String(url).split('?')[0].toLowerCase();
  return /\.jpe?g$/.test(base);
}
function looksLikePhoto(url){
  if(!url) return false;
  if(!isPhotographicFormat(url)) return false;
  let name = String(url).split('/').pop() || '';
  try { name = decodeURIComponent(name); } catch(e){}
  // Underscores are word characters, so /\bmap\b/ does NOT match inside "Pat_map.PNG" — which
  // is exactly how a map of Patagonia got through. Separators become spaces first so the word
  // boundaries mean what they look like they mean.
  name = name.replace(/[_\-.]+/g, ' ');
  return !NON_PHOTO_FILE.test(name);
}

function kmBetween(aLat, aLng, bLat, bLng){
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Candidate articles for a query, each with its photo and coordinates so it can be vetted. */
async function fetchWikiCandidates(query, limit){
  const url = `https://en.wikipedia.org/w/api.php?action=query&generator=search` +
    `&gsrsearch=${encodeURIComponent(query)}&gsrlimit=${limit || 4}` +
    `&prop=pageimages|coordinates&piprop=thumbnail&pithumbsize=720&colimit=20&format=json&origin=*`;
  const data = await fetchWikiJSON(url);
  if(!data) return null;                                 // null = no answer, distinct from []
  const pages = (data.query && data.query.pages) || {};
  return Object.values(pages)
    .sort((a,b) => (a.index || 9) - (b.index || 9))
    .map(p => ({
      title: p.title,
      thumb: (p.thumbnail && p.thumbnail.source && looksLikePhoto(p.thumbnail.source))
        ? capWikiThumb(p.thumbnail.source, 720) : null,
      lat: (p.coordinates && p.coordinates[0]) ? p.coordinates[0].lat : null,
      lng: (p.coordinates && p.coordinates[0]) ? p.coordinates[0].lon : null,
    }));
}

/** A photograph of a real landmark near a coordinate. Wikipedia caps gsradius at 10km. */
async function fetchNearbyPhoto(lat, lng){
  if(lat == null || lng == null) return null;
  const url = `https://en.wikipedia.org/w/api.php?action=query&generator=geosearch` +
    `&ggscoord=${lat}|${lng}&ggsradius=10000&ggslimit=30` +
    `&prop=pageimages&piprop=thumbnail&pithumbsize=720&format=json&origin=*`;
  const data = await fetchWikiJSON(url);
  if(!data) return null;
  const pages = Object.values((data.query && data.query.pages) || {});
  for(const p of pages){
    if(p.thumbnail && p.thumbnail.source && looksLikePhoto(p.thumbnail.source)){
      return capWikiThumb(p.thumbnail.source, 720);
    }
  }
  return null;
}

/** How far a candidate article may sit from the destination and still be about it.
 *  A single fixed radius cannot work: 75km is right for a town (a "Springfield" 600km away is
 *  the wrong Springfield) and absurd for Patagonia, whose Wikipedia article sits 606km from
 *  the geocoder's centroid — both points being legitimately inside a region of a million
 *  square kilometres. So the tolerance scales with the kind of place. */
/** Subjects that must never represent a place on a holiday-planning site, however
 *  geographically correct they are. A photograph of a soldier is not what South Korea is for
 *  a traveller, and reducing a country to its conflicts is both useless and disrespectful.
 *  Word boundaries matter here: "Kawarau Gorge" and "Yaowarat Road" contain the letters of
 *  "war" and are perfectly good travel imagery.
 *
 *  This filters DEFAULT imagery only. A user who deliberately searches a war memorial or a
 *  historic fortress still finds it — those are named attractions they asked for. */
const INAPPROPRIATE_SUBJECT = new RegExp([
  '\\bsoldiers?\\b','\\bmilitary\\b','\\barmy\\b','\\bnavy\\b','\\bair force\\b','\\btroops?\\b',
  '\\bweapons?\\b','\\bgun\\b','\\brifles?\\b','\\btanks?\\b','\\bmissiles?\\b','\\bwarfare\\b',
  '\\bwar\\b','\\bbattles?\\b','\\bconflict\\b','\\binvasion\\b','\\boccupation\\b','\\bmartyrs?\\b',
  '\\bprotests?\\b','\\briots?\\b','\\bdemonstrations?\\b','\\buprising\\b','\\brevolution\\b','\\bcoup\\b',
  '\\bmassacres?\\b','\\bgenocide\\b','\\batrocity\\b','\\bexecutions?\\b','\\bconcentration camp\\b',
  '\\bdisasters?\\b','\\bearthquakes?\\b','\\btsunami\\b','\\bfamine\\b','\\bepidemic\\b','\\bpandemic\\b',
  '\\bfloods?\\b','\\bwreck(age)?\\b','\\bcrash(es)?\\b','\\bbombings?\\b','\\bshootings?\\b','\\bterror',
  '\\bslums?\\b','\\bpoverty\\b','\\brefugees?\\b','\\bprisons?\\b','\\bpenitentiary\\b',
  '\\bcemeter(y|ies)\\b','\\bgraves?\\b','\\bgraveyard\\b','\\bmorgue\\b','\\bfuneral\\b',
  '\\bpolice\\b','\\bpolitician\\b','\\bpresident\\b','\\bdictator\\b','\\bparade\\b','\\bDMZ\\b',
  // Sexual content. A search for "Japan" returned "Kikakumono adult video in Japan" as the
  // country's representative image; nothing of the sort belongs on a holiday planner.
  '\\badult video\\b','\\bporn','\\bsex\\b','\\bsexual\\b','\\bnude\\b','\\bnudity\\b','\\berotic',
  '\\bbrothel\\b','\\bprostitut','\\bstrip club\\b','\\bfetish\\b','\\bhentai\\b','\\bgore\\b',
].join('|'), 'i');

/** True when a title or filename is safe to use as default travel imagery. */
function isTravelAppropriate(text){
  let v = String(text || '');
  try { v = decodeURIComponent(v); } catch(e){}
  v = v.replace(/^\d+px-/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ');
  return !INAPPROPRIATE_SUBJECT.test(v);
}

/** Infrastructure that is genuinely IN a destination but is not what anyone travels to see.
 *  The bundled-image importer has rejected these for hero images since it was written; without
 *  the same rule at runtime, Santorini resolved to a photograph of its airport terminal. */
/** For a large place — a region, state or country — a single small building cannot represent
 *  it. "Sedgwick hall" is genuinely inside Victoria and genuinely photographed, and tells a
 *  traveller nothing about the state. Compact places are exempt: any landmark inside a town
 *  or an island reads as that place. */
const SMALL_BUILDING_TITLE = /\b(hall|post office|church|chapel|school|college|court|courthouse|library|hotel|inn|pub|shop|store|house|cottage|villa|mill|farm|bridge|monument|memorial|statue|clock tower|water tower|silo|barn)\b/i;
const LARGE_PLACE_TYPES = new Set(['region','state','province','county','country']);

const NON_HERO_TITLE = /(airport|airfield|air base|bus station|railway station|\bstation\b|terminal|hospital|prison|barracks|power (plant|station)|sewage|landfill|industrial estate|business park|car park|parking)/i;

/** Does this article title actually name the destination? Coordinates prove a candidate is
 *  in the right area; this proves it is the right PLACE. Without it a neighbouring town's
 *  article passes the distance check and its photo is served as your destination. */
function titleNamesPlace(title, name){
  const norm = v => String(v||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
                     .replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
  const t = norm(title), n = norm(name);
  if(!t || !n) return false;
  if(t === n) return true;
  // "Queenstown, New Zealand" for Queenstown; "Oia, Greece" for Oia.
  if(t.startsWith(n + ' ') || t.endsWith(' ' + n) || t.includes(' ' + n + ' ')) return true;
  // Transliteration: Marrakech/Marrakesh, Reykjavik/Reykjavík.
  if(Math.abs(t.length - n.length) <= 2 && t.length >= 5){
    let same = 0;
    for(let i = 0; i < Math.min(t.length, n.length); i++) if(t[i] === n[i]) same++;
    if(same / Math.max(t.length, n.length) >= 0.8) return true;
  }
  return false;
}

const __destPhotoTier = {};   // which rung answered, for auditing
/** Which rung of the chain produced a destination's photo: 'article' (the place itself),
 *  'landmark' (something inside it), or null (name card). Exposed so the accuracy audit can
 *  tell a photo OF the destination from a photo merely NEAR it. */
function destPhotoTierFor(destKey){ return __destPhotoTier['dest:' + String(destKey||'').toLowerCase()] || null; }
/** A landmark photo, but only from within `maxKm` of the point. fetchNearbyPhoto searches a
 *  fixed 10km circle (the API's cap); this filters that result set down to what is actually
 *  inside the destination, and returns nothing rather than something from further out. */
async function fetchNearbyPhotoWithin(lat, lng, maxKm, placeName, placeType, requireNamed){
  if(lat == null || lng == null || !maxKm) return null;
  const large = LARGE_PLACE_TYPES.has(placeType);
  const url = `https://en.wikipedia.org/w/api.php?action=query&generator=geosearch` +
    `&ggscoord=${lat}|${lng}&ggsradius=10000&ggslimit=40` +
    `&prop=pageimages|coordinates&piprop=thumbnail&pithumbsize=720&colimit=40&format=json&origin=*`;
  const data = await fetchWikiJSON(url);
  if(!data) return null;
  const pages = Object.values((data.query && data.query.pages) || {})
    .filter(p => p.thumbnail && p.thumbnail.source && looksLikePhoto(p.thumbnail.source))
    .filter(p => (p.coordinates || [])[0])
    .filter(p => !NON_ATTRACTION_TITLE_PATTERNS.some(re => re.test(p.title || '')))
    .filter(p => !NON_HERO_TITLE.test(p.title || ''))
    .filter(p => isTravelAppropriate(p.title) && isTravelAppropriate((p.thumbnail||{}).source))
    // Judge the FILE as well as the article: the article "Sedgwick, Victoria" is a place, but
    // its photograph is Sedgwick_hall.jpg — a village hall offered as the state of Victoria.
    .filter(p => {
      if(!large) return true;
      let file = String((p.thumbnail || {}).source || '').split('/').pop();
      try { file = decodeURIComponent(file); } catch(e){}
      file = file.replace(/^\d+px-/, '')
                 .replace(/([a-z])([A-Z])/g, '$1 $2')   // SpringGullyHotel -> Spring Gully Hotel
                 .replace(/[_\-.]+/g, ' ');
      return !SMALL_BUILDING_TITLE.test(p.title || '') && !SMALL_BUILDING_TITLE.test(file);
    })
    .map(p => ({ p, km: kmBetween(lat, lng, p.coordinates[0].lat, p.coordinates[0].lon),
                 // A landmark that carries the destination's name is recognisable AS the
                 // destination; nearest-first alone offered a rural post office for the whole
                 // state of Victoria, which no traveller would recognise.
                 named: placeName && titleNamesPlace(p.title, placeName) ? 0 : 1 }))
    .filter(x => x.km <= maxKm)
    .filter(x => !requireNamed || x.named === 0)
    .sort((a, b) => a.named - b.named || a.km - b.km);
  return pages.length ? capWikiThumb(pages[0].p.thumbnail.source, 720) : null;
}

const DEST_PHOTO_MAX_KM = {
  city:75, town:60, village:40, hamlet:40, suburb:30, borough:40, locality:50, municipality:75,
  island:150, archipelago:400, peninsula:300, county:150, national_park:200, nature_reserve:150,
  protected_area:200, attraction:40, monument:40, castle:40, museum:40, peak:60, volcano:60,
  bay:150, beach:60, fjord:150, lake:150, glacier:120,
  region:800, state:600, province:600, country:2000,
};
function destPhotoRadiusKm(type){ return DEST_PHOTO_MAX_KM[type] || 100; }
/** A landmark may stand in for a destination only if it is genuinely within it. A temple 6km
 *  from the centre of Beijing is Beijing; a church 8km from a hamlet is the next village. */
const DEST_NEARBY_KM = { city:15, town:6, village:3, hamlet:3, suburb:3, borough:5, locality:4,
  municipality:8, island:25, archipelago:40, country:0, region:50, state:40, province:40,
  county:25, national_park:30, nature_reserve:20, protected_area:25, peninsula:30, bay:20,
  beach:5, lake:20, fjord:25, peak:10, volcano:10, glacier:15, attraction:3, monument:3 };
function destNearbyRadiusKm(type){ const v = DEST_NEARBY_KM[type]; return v === undefined ? 8 : v; }

/** The full destination-photo chain. Cached under the destination id like any other lookup. */
async function resolveDestinationPhoto(dest){
  if(!dest) return null;
  const cache = photoCache();
  // Keyed by the canonical place id where there is one: "dest:paris" would otherwise be
  // shared by Paris, France and Paris, Texas.
  const key = 'dest:' + (dest.placeId || dest.id || dest.name || '').toLowerCase();
  const hit = cache[key];
  if(typeof hit === 'string' && hit) return hit;
  if(hit && typeof hit === 'object' && hit.miss && (Date.now() - hit.miss) < PHOTO_MISS_TTL_MS) return null;

  return withPhotoSlot(async () => {
    const queries = [dest.name];
    if(dest.country && dest.country !== dest.name){
      queries.push(`${dest.name}, ${dest.country}`, `${dest.name} ${dest.country}`);
    }
    if(dest.region && dest.region !== dest.name) queries.push(`${dest.name} ${dest.region}`);
    const hasCoords = dest.lat != null && dest.lng != null && dest.__geo;
    let answered = false, found = null, anchorLat = null, anchorLng = null, tier = null;

    for(const q of queries){
      const candidates = await fetchWikiCandidates(q, 4);
      if(candidates === null) continue;                  // request failed: not an answer
      answered = true;
      for(const c of candidates){
        // A candidate with no coordinates is not a place — that is what "Maverick Viñales" is.
        if(c.lat == null) continue;
        if(hasCoords && kmBetween(dest.lat, dest.lng, c.lat, c.lng) > destPhotoRadiusKm(dest.placeType)) continue;
        // Coordinates alone are not enough: the article must also name the destination, and
        // must not be its airport or bus station.
        if(NON_HERO_TITLE.test(c.title || '')) continue;
        // Correct location is not enough: it must also be imagery that represents the place
        // as somewhere to travel to.
        if(!isTravelAppropriate(c.title) || !isTravelAppropriate(c.thumb)) continue;
        if(!titleNamesPlace(c.title, dest.name)) continue;
        if(!anchorLat){ anchorLat = c.lat; anchorLng = c.lng; }   // a vetted point inside the place
        if(!c.thumb) continue;                                    // right place, no usable photo
        found = c.thumb; tier = 'article'; break;
      }
      if(found) break;
    }

    // The place is real but unphotographed: borrow a landmark that is genuinely INSIDE it.
    // fetchNearbyPhoto searches a 10km circle, so anything tighter than that is enforced here
    // against the landmark's own coordinates.
    // For a state, province or country the geocoded centroid is an arbitrary point in a huge
    // area, and no landmark near it reliably represents the whole: Victoria offered in turn a
    // village hall, then a rural pub. Chasing that with more filename patterns is endless, so
    // for those types a landmark must NAME the destination or it is not used at all. Compact
    // places keep the nearest-landmark behaviour, where anything inside genuinely reads as
    // the place — Santorini's caldera cableway, the Gotthard pass for the Swiss Alps.
    if(!found && (hasCoords || anchorLat)){
      // Requiring the landmark to name the destination does not work for these: Wikipedia
      // titles every settlement in a state as "Town, State", so the name test always passes
      // and a reservoir in "Kennington, Victoria" is served as the state of Victoria. There is
      // no reliable signal here, so no landmark is used — the name card is the honest answer.
      const noLandmark = new Set(['state','province','country']).has(dest.placeType);
      for(const [la, ln] of (noLandmark ? [] : [[anchorLat, anchorLng], [dest.lat, dest.lng]])){
        if(la == null) continue;
        const near = await fetchNearbyPhotoWithin(la, ln, destNearbyRadiusKm(dest.placeType),
                                                  dest.name, dest.placeType);
        if(near){ found = near; tier = 'landmark'; answered = true; break; }
      }
    }
    // No country fallback. A photograph of Madagascar is not a photograph of Nosy Be, and a
    // beautiful image of the wrong place is worse than none: a destination with nothing
    // verifiably its own gets the name card instead.

    if(found) cache[key] = found;
    else if(answered) cache[key] = { miss: Date.now() };
    __destPhotoTier[key] = tier;
    if(found || answered) writeJSONCache(PHOTO_CACHE_KEY, cache);
    return found;
  });
}

/* ---- Geocoding via OpenStreetMap Nominatim (no key) — real coordinates for ANY place typed, worldwide ---- */
const GEOCODE_CACHE_KEY = 'tripflow_geocode_cache_v1';
let __geocodeCache = null;
function geocodeCache(){ if(!__geocodeCache) __geocodeCache = readJSONCache(GEOCODE_CACHE_KEY); return __geocodeCache; }
/** Place kinds Nominatim may return when resolving a destination. Its free-text search
 *  otherwise happily returns businesses: "Paris Texas" resolves to a PUB IN BUDAPEST named
 *  "Paris, Texas" (country: Hungary), and "Seoul Korea" to a Korean restaurant in Malaysia.
 *  That is how a destination ended up captioned "Malaysia" under the name "Seoul Korea" —
 *  the name came from what was typed, the country from an unrelated shop. */
const GEOCODE_PLACE_TYPES = new Set(['administrative','city','town','village','hamlet',
  'suburb','borough','municipality','county','state','province','region','country','island',
  'archipelago','islet','peninsula','locality','national_park','nature_reserve','protected_area',
  'attraction','monument','castle','ruins','archaeological_site','peak','volcano','bay','beach',
  'fjord','lake','glacier','neighbourhood','quarter','city_district','district']);

async function geocodeCity(query){
  const cache = geocodeCache();
  const key = query.trim().toLowerCase();
  if(cache[key]) return cache[key];
  let result = null;
  try{
    const res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&q=${encodeURIComponent(query)}`, 8000, {headers:{'Accept':'application/json'}});
    if(res && res.ok){
      const arr = await res.json();
      // Take the first result that is actually a PLACE. Without this the first result can be
      // a restaurant or a pub that merely shares the name, and its country becomes the
      // destination's country.
      const a = (arr || []).find(x => GEOCODE_PLACE_TYPES.has(x.type) ||
                                      GEOCODE_PLACE_TYPES.has(x.class) ||
                                      x.class === 'place' || x.class === 'boundary');
      if(a){
        const addr = a.address || {};
        result = {
          lat: parseFloat(a.lat), lng: parseFloat(a.lon),
          city: addr.city || addr.town || addr.village || addr.municipality || addr.county || a.name || query,
          country: addr.country || '',
        };
      }
    }
  }catch(e){}
  // Same rule as the photo cache: only persist a confirmed real result, so a transient failure
  // retries next time instead of permanently sticking.
  if(result){ cache[key] = result; writeJSONCache(GEOCODE_CACHE_KEY, cache); }
  return result;
}

/* ---- Live currency conversion via the Frankfurter API (ECB rates, no key) ---- */
// Kept in sync with the currencies the live rate source (Frankfurter / ECB reference rates)
// actually publishes, so every currency offered here always gets a real conversion — never a
// raw USD number mislabeled with the wrong symbol.
const CURRENCY_META = {
  USD:{symbol:'$',name:'US Dollar'}, EUR:{symbol:'€',name:'Euro'}, GBP:{symbol:'£',name:'British Pound'},
  JPY:{symbol:'¥',name:'Japanese Yen'}, CAD:{symbol:'CA$',name:'Canadian Dollar'}, AUD:{symbol:'A$',name:'Australian Dollar'},
  CNY:{symbol:'¥',name:'Chinese Yuan'}, INR:{symbol:'₹',name:'Indian Rupee'}, THB:{symbol:'฿',name:'Thai Baht'},
  MXN:{symbol:'MX$',name:'Mexican Peso'}, BRL:{symbol:'R$',name:'Brazilian Real'}, CHF:{symbol:'CHF',name:'Swiss Franc'},
  KRW:{symbol:'₩',name:'South Korean Won'}, IDR:{symbol:'Rp',name:'Indonesian Rupiah'}, ZAR:{symbol:'R',name:'South African Rand'},
  NZD:{symbol:'NZ$',name:'New Zealand Dollar'}, SGD:{symbol:'S$',name:'Singapore Dollar'}, HKD:{symbol:'HK$',name:'Hong Kong Dollar'},
  ISK:{symbol:'kr',name:'Icelandic Króna'}, ILS:{symbol:'₪',name:'Israeli Shekel'}, MYR:{symbol:'RM',name:'Malaysian Ringgit'},
  PHP:{symbol:'₱',name:'Philippine Peso'}, TRY:{symbol:'₺',name:'Turkish Lira'}, PLN:{symbol:'zł',name:'Polish Złoty'},
  CZK:{symbol:'Kč',name:'Czech Koruna'}, HUF:{symbol:'Ft',name:'Hungarian Forint'}, NOK:{symbol:'kr',name:'Norwegian Krone'},
  SEK:{symbol:'kr',name:'Swedish Krona'}, DKK:{symbol:'kr',name:'Danish Krone'}, RON:{symbol:'lei',name:'Romanian Leu'},
  BGN:{symbol:'лв',name:'Bulgarian Lev'},
};
const FX_CACHE_KEY = 'tripflow_fx_cache_v1';
/* Exchange rates live in currency.js now.
 *
 * What used to be here: a table of ~30 rates hardcoded into the source, used whenever the live
 * fetch failed. They were wrong the day after they were written and got worse every day after
 * that, and a stale rate shown to someone budgeting a trip is a wrong number presented as a
 * fact. The spec's rule — no guessing, no outdated static rates — is right, so the table is
 * gone. currency.js caches real rates for 12 hours, falls back to an older cached rate clearly
 * marked stale, and otherwise says plainly that no rate is available. */
let EXCHANGE_RATES = {USD:1};
let EXCHANGE_RATES_ARE_LIVE = false;
async function loadExchangeRates(){
  try{
    const box = await getRates('USD');
    if(box && box.rates){
      EXCHANGE_RATES = Object.assign({USD:1}, box.rates);
      EXCHANGE_RATES_ARE_LIVE = !box.stale;
      return !box.stale;
    }
  }catch(e){ /* reported by the caller as "rates unavailable" */ }
  return false;
}
function convertUSD(amountUSD, toCurrency){
  const rate = EXCHANGE_RATES[toCurrency];
  return typeof rate === 'number' ? amountUSD * rate : amountUSD;
}

/* ---- Time zone intelligence — computed offline from each destination's real travelInfo ---- */
/** Pulls the numeric UTC offset out of strings like "JST (UTC+9)" or "IST (UTC+5:30)".
 * Returns null when a destination has no usable timezone string, so callers can hide the
 * feature rather than display a wrong time. */
function parseUtcOffset(tz){
  const m = String(tz||'').match(/UTC([+-])(\d{1,2})(?::(\d{2}))?/i);
  if(!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2],10) + (m[3] ? parseInt(m[3],10)/60 : 0));
}
/** Current wall-clock time at the destination, plus how far ahead/behind the traveler's own
 * device is. Uses the device's real UTC offset, so it's correct wherever the user actually is. */
function destinationClock(dest){
  const offset = dest && dest.travelInfo ? parseUtcOffset(dest.travelInfo.timezone) : null;
  if(offset === null) return null;
  const now = new Date();
  const localOffsetHours = -now.getTimezoneOffset() / 60;
  const destDate = new Date(now.getTime() + (offset - localOffsetHours) * 3600 * 1000);
  const diff = +(offset - localOffsetHours).toFixed(2);
  const hh = String(destDate.getHours()).padStart(2,'0');
  const mm = String(destDate.getMinutes()).padStart(2,'0');
  const hours12 = destDate.getHours() % 12 === 0 ? 12 : destDate.getHours() % 12;
  return {
    offset, diff,
    time24: `${hh}:${mm}`,
    time12: `${hours12}:${mm} ${destDate.getHours() >= 12 ? 'PM' : 'AM'}`,
    isNextDay: destDate.toDateString() !== now.toDateString(),
    label: dest.travelInfo.timezone,
    hour: destDate.getHours(),
  };
}

/* ---- Weather via Open-Meteo (no key, CORS-enabled) ---- */
const WEATHER_CACHE_KEY = 'tripflow_weather_cache_v1';
const WEATHER_TTL_MS = 3 * 3600 * 1000;
// Open-Meteo only forecasts about 16 days out; past that there is genuinely nothing to show,
// and saying so beats inventing a guess.
const FORECAST_HORIZON_DAYS = 16;
const WMO_CODES = {
  0:['Clear','☀️'], 1:['Mainly clear','🌤'], 2:['Partly cloudy','⛅'], 3:['Overcast','☁️'],
  45:['Fog','🌫'], 48:['Rime fog','🌫'],
  51:['Light drizzle','🌦'], 53:['Drizzle','🌦'], 55:['Heavy drizzle','🌦'],
  61:['Light rain','🌧'], 63:['Rain','🌧'], 65:['Heavy rain','🌧'],
  66:['Freezing rain','🌧'], 67:['Freezing rain','🌧'],
  71:['Light snow','🌨'], 73:['Snow','🌨'], 75:['Heavy snow','🌨'], 77:['Snow grains','🌨'],
  80:['Rain showers','🌦'], 81:['Rain showers','🌦'], 82:['Heavy showers','⛈'],
  85:['Snow showers','🌨'], 86:['Snow showers','🌨'],
  95:['Thunderstorm','⛈'], 96:['Thunderstorm','⛈'], 99:['Thunderstorm','⛈'],
};
function weatherMeta(code){ return WMO_CODES[code] || ['—','🌡']; }
function daysFromToday(dateStr){
  const today = new Date(toDateInput(new Date())+'T00:00:00');
  const target = new Date(dateStr+'T00:00:00');
  return Math.round((target - today)/86400000);
}
/** Fetches a daily forecast for a destination's date range. Follows the same caching discipline
 * as every other live lookup here: successes cached with a short TTL, failures never persisted,
 * and a miss degrades to "no forecast" rather than blocking anything. */
async function fetchForecast(lat, lng, startDate, endDate){
  if(typeof lat !== 'number' || typeof lng !== 'number') return null;
  const from = daysFromToday(startDate);
  const to = daysFromToday(endDate);
  if(to < 0 || from > FORECAST_HORIZON_DAYS) return null; // entirely in the past or too far out
  const clampedStart = from < 0 ? toDateInput(new Date()) : startDate;
  const clampedEnd = to > FORECAST_HORIZON_DAYS ? addDays(toDateInput(new Date()), FORECAST_HORIZON_DAYS) : endDate;
  const key = `${lat.toFixed(2)},${lng.toFixed(2)},${clampedStart},${clampedEnd}`;
  const cache = readJSONCache(WEATHER_CACHE_KEY);
  const hit = cache[key];
  if(hit && hit.ts && (Date.now()-hit.ts) < WEATHER_TTL_MS && hit.days) return hit.days;
  try{
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
      + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`
      + `&timezone=auto&start_date=${clampedStart}&end_date=${clampedEnd}`;
    const res = await fetchWithTimeout(url, 8000, {headers:{'Accept':'application/json'}});
    if(res && res.ok){
      const data = await res.json();
      const d = data && data.daily;
      if(d && Array.isArray(d.time) && d.time.length){
        const days = d.time.map((date,i)=>({
          date,
          code: d.weather_code ? d.weather_code[i] : null,
          max: d.temperature_2m_max ? d.temperature_2m_max[i] : null,
          min: d.temperature_2m_min ? d.temperature_2m_min[i] : null,
          rain: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
        }));
        cache[key] = { ts: Date.now(), days };
        writeJSONCache(WEATHER_CACHE_KEY, cache);
        return days;
      }
    }
  }catch(e){ /* offline or blocked — the UI simply shows no forecast */ }
  return null;
}

/* ---- Real nearby landmarks via Wikipedia GeoSearch (no key) — worldwide points of interest, each with a real name, description and photo, in a single request ---- */
async function fetchNearbyWikiPOIs(lat, lng, limit){
  try{
    const url = `https://en.wikipedia.org/w/api.php?action=query&generator=geosearch&ggscoord=${lat}%7C${lng}&ggsradius=10000&ggslimit=${limit||24}&prop=pageimages%7Cextracts%7Ccoordinates&piprop=thumbnail&pithumbsize=720&exintro=1&explaintext=1&exchars=220&format=json&origin=*`;
    const res = await fetchWithTimeout(url, 9000);
    if(!res || !res.ok) return [];
    const data = await res.json();
    const pages = (data.query && data.query.pages) || {};
    return Object.values(pages)
      .filter(p=>p.title && p.coordinates && p.coordinates[0])
      .map(p=>({
        title: p.title,
        lat: p.coordinates[0].lat, lng: p.coordinates[0].lon,
        image: (p.thumbnail && p.thumbnail.source) ? capWikiThumb(p.thumbnail.source,720) : null,
        extract: p.extract || '',
      }))
      .filter(p=>isVisitableAttraction(p.title, p.extract, p.image));
  }catch(e){ return []; }
}
/* GeoSearch returns EVERY Wikipedia article with coordinates near a point. Near Paris that
 * includes Métro stations, arrondissements, office blocks — and even "Second French Empire",
 * a form of government, which is not somewhere you can go. None of these belong in a travel
 * itinerary, and most have no photograph either, which is why they surfaced as placeholders.
 *
 * Two filters, both grounded in the article's own content rather than a hand-maintained
 * blocklist of names:
 *   1. It must have a lead photograph. An article with no image is almost never a place people
 *      visit, and it is exactly what renders as an empty grey card.
 *   2. It must not describe itself as something you can't visit. Wikipedia's opening sentence
 *      reliably states what a subject IS ("...is a rapid transit station on lines 1 and 11",
 *      "...was the government of France"), so matching against that catches the whole class
 *      rather than the specific examples we happened to notice. */
const NON_ATTRACTION_EXTRACT_PATTERNS = [
  /\b(is|was)\b[^.]{0,60}\b(railway|rail|metro|subway|underground|tram|bus|transit)\b[^.]{0,20}\b(station|stop|line|halt|terminus)\b/i,
  /\b(is|was)\b[^.]{0,40}\b(district|ward|neighbourhood|neighborhood|quarter|commune|arrondissement|suburb|prefecture|province|municipality|borough)\s+(of|in)\b/i,
  /\b(is|was)\s+the\s+(government|regime|ruling|administration|monarchy|dynasty|empire|republic|state)\b/i,
  /\b(is|was)\b[^.]{0,60}\b(school|university|college|hospital|clinic|prison|embassy|consulate|headquarters|law firm|newspaper|political party|football club|research institute)\b/i,
  /\b(is|was)\b[^.]{0,60}\b(war|battle|siege|treaty|revolution|uprising|massacre|election|referendum)\b/i,
  /\b(is|was)\b[^.]{0,40}\b(road|street|avenue|boulevard|highway|motorway|junction|roundabout)\s+(in|of)\b/i,
];
// Only patterns specific enough not to catch a genuine landmark. "Empire" is deliberately
// absent — the Empire State Building is exactly the sort of place that must survive.
const NON_ATTRACTION_TITLE_PATTERNS = [
  /\b(station|métro|metro line|railway line|tram stop)\b/i,
  /\b\d+(st|nd|rd|th)\s+arrondissement\b/i,
  // Events, not places. GeoSearch returns any article with coordinates, which near Tiananmen
  // meant "1989 Tiananmen Square protests and massacre" was offered as somewhere to visit.
  // An atrocity is not a stop on a holiday itinerary; the square itself still is, and still
  // appears, because that is a separate article about a place.
  /\b(massacre|protests?|riots?|uprising|revolution|bombing|attacks?|shootings?|siege|battle|invasion|coup|genocide|earthquake|tsunami|disaster|famine|epidemic|pandemic|outbreak|assassination|murder|scandal|referendum|treaty|olympics|championship|world cup)\b/i,
  // A leading year is almost always an event ("2008 Summer Olympics"), never a place.
  /^\s*\d{3,4}\s/,
];
function isVisitableAttraction(title, extract, image){
  if(!image) return false;                                    // no photo -> not a visitor attraction
  const t = String(title||''), x = String(extract||'');
  if(NON_ATTRACTION_TITLE_PATTERNS.some(re=>re.test(t))) return false;
  return !NON_ATTRACTION_EXTRACT_PATTERNS.some(re=>re.test(x));
}
function inferCategoryFromExtract(text){
  const t=(text||'').toLowerCase();
  if(/temple|shrine|church|cathedral|mosque|synagogue/.test(t)) return 'Culture';
  if(/museum|gallery/.test(t)) return 'Museum';
  if(/park|garden|nature reserve|forest|botanical/.test(t)) return 'Nature';
  if(/palace|castle|fort(ress)?|monument|memorial|historic|ruins/.test(t)) return 'History';
  if(/market|bazaar|mall/.test(t)) return 'Market';
  if(/bridge|tower|skyscraper|building|square|plaza/.test(t)) return 'Landmark';
  return 'Attraction';   // neutral: an unrecognised place must not inherit a top-tier category
}
function inferTagsFromExtract(text){
  const t=(text||'').toLowerCase(); const tags=[];
  if(/temple|shrine|church|cathedral|mosque|palace|castle|fort|museum|monument|historic|heritage|ruins/.test(t)) tags.push('culture','history');
  if(/park|garden|forest|lake|mountain|beach|nature reserve|national park|island/.test(t)) tags.push('nature');
  if(/market|mall|shopping|bazaar|boutique/.test(t)) tags.push('shopping');
  if(/bar|nightclub|club|nightlife|live music/.test(t)) tags.push('nightlife');
  if(/gallery|art|theatre|theater|opera|studio/.test(t)) tags.push('art');
  if(!tags.length) tags.push('culture','hidden');
  return [...new Set(tags)];
}

/* ---- Progressive enrichment: upgrade a fallback destination with real, worldwide data in the background ---- */
const ENRICH_CACHE_KEY = 'tripflow_enrich_cache_v2';
function enrichCache(){ return readJSONCache(ENRICH_CACHE_KEY); }
function applyEnrichment(dest, payload){
  // Enrichment ADDS attractions. It must never restate who the destination is: a destination
  // resolved from search already carries a verified name, country and coordinates, and letting
  // a later background lookup overwrite them is precisely how a page came to show one place's
  // name above another place's country. Identity is written once, at creation.
  if(!dest.__geo){
    if(payload.lat != null) dest.lat = payload.lat;
    if(payload.lng != null) dest.lng = payload.lng;
    if(payload.country){ dest.country = payload.country; dest.currencyCode = currencyCodeForCountry(payload.country); }
  }
  if(payload.attractions && payload.attractions.length){
    for(let i=PLACES.length-1;i>=0;i--){ if(PLACES[i].destId===dest.id && PLACES[i].type==='attraction') PLACES.splice(i,1); }
    payload.attractions.forEach((p,i)=>{
      PLACES.push(Object.assign({ id:`${dest.id}-a${i+1}`, destId:dest.id, type:'attraction', source:'live' }, p,
        { image: p.image || img(dest.id+'-attr-'+i, 640,480, p.name) }));
    });
  }
  dest.__enriched = true;
}
async function enrichGenericDestination(dest){
  if(dest.__enriched || dest.__enriching) return false;
  dest.__enriching = true;
  try{
    const cache = enrichCache();
    if(cache[dest.id] && cache[dest.id].attractions && cache[dest.id].attractions.length){ applyEnrichment(dest, cache[dest.id]); return true; }
    // A destination picked from search already carries real coordinates from geo.js, so
    // geocoding it again is a redundant Nominatim round-trip on the critical path — and
    // Nominatim is the slowest and least reliable call in the app. Skipping it is why the
    // real local attractions now appear promptly instead of after a long spell of
    // placeholders; only a destination that arrived without coordinates still needs it.
    const geo = dest.__geo ? null : await geocodeCity(dest.name + (dest.country ? ', '+dest.country : ''));
    const lat = geo ? geo.lat : dest.lat, lng = geo ? geo.lng : dest.lng;
    const pois = await fetchNearbyWikiPOIs(lat, lng, 40);
    if(!geo && !pois.length){ dest.__enriched = true; return false; }
    const seen = new Set();
    const attractions = pois.filter(p=>{
      const k = p.title.toLowerCase(); if(seen.has(k)) return false; seen.add(k); return true;
    }).slice(0,30).map(p=>{
      const firstSentence = (p.extract||'').split(/(?<=[.!?])\s/)[0];
      return {
        name: p.title,
        category: inferCategoryFromExtract(p.extract),
        rating: null, reviews: null, priceLevel: null, price: null,   // see note above: never fabricated
        area: (geo && geo.city) || dest.name,
        lat: p.lat, lng: p.lng,
        desc: (firstSentence || `A notable landmark near ${dest.name}.`).slice(0,160),
        tags: inferTagsFromExtract(p.extract),
        duration: 75,
        image: p.image,
      };
    });
    const payload = { lat, lng, country: geo && geo.country, attractions };
    // Only persist once there's real attraction data to show for it — an empty list here is
    // just as likely a transient POI-fetch failure as a genuinely quiet destination, so leave
    // it to retry on the next visit rather than caching a permanent dead end.
    if(attractions.length){ cache[dest.id] = payload; writeJSONCache(ENRICH_CACHE_KEY, cache); }
    applyEnrichment(dest, payload);
    return true;
  } finally { dest.__enriching = false; }
}

// A larger pool than what's shown per generation (see IDEAS_SHOWN_PER_GENERATE) — each
// "Generate" click samples a fresh random subset, so the card THEMES vary between
// generations too, not just the places inside each one.
const TRIP_ARCHETYPES = [
  { key:'food',      emoji:'🍜', titleTpl:"Food Lover's {city}",   tags:['food'],             descTpl:"Street food stalls, izakayas, local markets and the tables locals actually eat at in {city}." },
  { key:'culture',    emoji:'🏯', titleTpl:"Culture & History",     tags:['culture','history'],descTpl:"Temples, museums, monuments and old neighborhoods that tell {city}'s story." },
  { key:'nightlife',  emoji:'🌃', titleTpl:"{city} Nightlife",      tags:['nightlife'],        descTpl:"Rooftop bars, live music, night markets and the best views after dark in {city}." },
  { key:'shopping',   emoji:'🛍️', titleTpl:"Shopping Adventure",    tags:['shopping'],         descTpl:"From flagship boutiques to flea-market finds — a shopper's route through {city}." },
  { key:'relax',      emoji:'🌿', titleTpl:"Relaxing {city} Escape",tags:['relax','nature'],   descTpl:"Gardens, cafés, spas and slow mornings — the unhurried side of {city}." },
  { key:'art',        emoji:'🎨', titleTpl:"{city} Art & Design",    tags:['art'],              descTpl:"Galleries, studios and design spaces that show off {city}'s creative side." },
  { key:'adventure',  emoji:'⛰️', titleTpl:"{city} Adventure",       tags:['adventure','nature'],descTpl:"Outdoor thrills and nature escapes in and around {city}." },
  { key:'romantic',   emoji:'💑', titleTpl:"Romantic {city}",        tags:['romantic'],         descTpl:"Sunset views, candlelit dinners and quiet corners made for two in {city}." },
  { key:'hidden',     emoji:'📸', titleTpl:"Hidden {city}",          tags:['hidden'],           descTpl:"Skip the crowds — the lesser-known spots locals actually love in {city}." },
  { key:'family',     emoji:'👨‍👩‍👧', titleTpl:"Family-Friendly {city}", tags:['nature','culture'], descTpl:"Easygoing, kid-friendly stops and low-hassle days out in {city}." },
  { key:'luxury',     emoji:'✨', titleTpl:"Luxury {city}",          tags:['romantic','food'], descTpl:"Fine dining, five-star stays and the best of {city} without compromise." },
  { key:'solo',       emoji:'🎒', titleTpl:"Solo Explorer's {city}", tags:['hidden','culture'], descTpl:"Flexible, low-key days made for exploring {city} at your own pace." },
  { key:'photo',      emoji:'📷', titleTpl:"Instagram-Worthy {city}",tags:['photography','art'],descTpl:"The most photogenic corners, views and light in {city}." },
  { key:'wellness',   emoji:'🧘', titleTpl:"{city} Wellness Retreat",tags:['relax','nature'],   descTpl:"Slow mornings, spas and green space for a reset in {city}." },
  { key:'budget',     emoji:'💸', titleTpl:"Budget {city}",          tags:['food','hidden'],    descTpl:"Great days in {city} without spending a fortune — free sights, cheap eats, local transit." },
  { key:'classic',    emoji:'🗺️', titleTpl:"Classic {city} Highlights", tags:['culture','food'], descTpl:"The essential, can't-miss sights and experiences every first-time visitor to {city} should hit." },
];
const IDEAS_SHOWN_PER_GENERATE = 9;

const INTERESTS = [
  ['food','🍜','Foodie','markets, tastings, local spots'],
  ['culture','🏯','Culture','temples, history, neighborhoods'],
  ['nature','🌿','Nature','parks, gardens, views'],
  ['hidden','📸','Hidden gems','less touristy, unique finds'],
  ['shopping','🛍️','Shopping','boutiques, markets, souvenirs'],
  ['nightlife','🌙','Nightlife','bars, live music, late nights'],
  ['art','🎨','Art','galleries, immersive spaces'],
  ['adventure','⛰️','Adventure','hikes, thrills, outdoors'],
  ['relax','🫶','Relaxed','slow mornings, low pressure'],
  ['romantic','💑','Romantic','sunsets, fine dining, views'],
];

const REVIEW_NAMES = ['Alex M.','Priya K.','Jordan T.','Sofia R.','Liam C.','Mei L.','Noah B.','Ava S.','Diego F.','Hana Y.','Emma W.','Lucas P.','Zara Q.','Ethan G.','Nina V.'];
const REVIEW_TEMPLATES = {
  attraction: [
    "Absolutely worth the visit — go early to beat the crowds.",
    "Beautiful spot, better than the photos honestly. Budget 1.5–2 hours.",
    "A must-see. We almost skipped it and would have regretted that.",
    "Loved the atmosphere here. A little touristy but still special.",
    "Great for photos and just soaking in the local culture.",
    "Worth the trip — bring cash for the small stalls nearby."
  ],
  restaurant: [
    "The food here was incredible — we came back a second night.",
    "Small menu but everything was executed perfectly. No reservation needed at lunch.",
    "Best meal of the trip. A bit of a wait but moved fast.",
    "Great value for the quality. Loved the local ingredients.",
    "Cozy spot, friendly staff, and the flavors were spot on.",
    "Portions were generous and the vibe was exactly what we wanted."
  ],
  hotel: [
    "Room was spotless and the location made everything walkable.",
    "Staff went above and beyond — upgraded us on arrival.",
    "Great breakfast, comfy beds, and the view was unreal.",
    "Quiet, clean, and close to everything we wanted to see.",
    "A little pricey but worth it for the service and location.",
    "Perfect base for exploring — would book again in a heartbeat."
  ]
};

function generateReviews(place, seedKey){
  const pool = REVIEW_TEMPLATES[place.type] || REVIEW_TEMPLATES.attraction;
  const n = 3;
  const out = [];
  let h = 0; for(const c of (seedKey||place.name)) h = (h*31 + c.charCodeAt(0)) % 997;
  for(let i=0;i<n;i++){
    const ni = (h + i*7) % REVIEW_NAMES.length;
    const ti = (h + i*13) % pool.length;
    const rating = Math.max(3, Math.min(5, Math.round((place.rating||4.5) + (i===2?-0.5:0))));
    out.push({ name: REVIEW_NAMES[ni], rating, text: pool[ti], daysAgo: 3 + ((h+i*17)%160) });
  }
  return out;
}

/* ---------------- DESTINATIONS (raw, nested) ---------------- */
const DESTINATIONS_RAW = [

{ id:'tokyo', name:'Tokyo', country:'Japan', flag:'🇯🇵',
  tagline:"Neon nights, ancient temples, and the best food on Earth.",
  description:"Tokyo layers ultramodern skyscrapers over centuries-old shrines, with world-class food at every price point. Bullet trains, quiet gardens, and electric nightlife all sit minutes apart.",
  tags:['trending','food','culture','nightlife','shopping'],
  lat:35.6762, lng:139.6503,
  weather:"Autumn (Sep–Nov): 15–23°C, crisp and dry — ideal for walking.",
  bestTime:"March–May & September–November",
  currency:"Japanese Yen (¥)", language:"Japanese",
  avgDailyBudget:{budget:70,moderate:150,luxury:350},
  travelInfo:{ recommendedDays:'5–7 days', timezone:'JST (UTC+9)',
    visa:"Most Western passport holders get visa-free entry for up to 90 days as tourists — check your country's specific requirements.",
    safety:'One of the safest major cities in the world; standard travel precautions apply.',
    localTransport:'Tokyo Metro and JR Lines — get a Suica or Pasmo IC card for easy tap-to-ride.',
    etiquette:"Don't eat while walking, keep phone calls off trains, remove shoes when entering homes and some restaurants, tipping is not customary." },
  attractions:[
    {name:'Senso-ji Temple', category:'Culture', rating:4.7, reviews:48210, priceLevel:0, price:0, area:'Asakusa', lat:35.7148,lng:139.7967, desc:"Tokyo's oldest temple, approached through a lantern-lit market street.", tags:['culture','history','photography'], duration:90},
    {name:'Shibuya Sky', category:'Viewpoint', rating:4.6, reviews:21870, priceLevel:2, price:25, area:'Shibuya', lat:35.6580,lng:139.7016, desc:"Open-air rooftop deck with 360° views over Shibuya Crossing.", tags:['photography','nightlife'], duration:75},
    {name:'Meiji Jingu Shrine', category:'Nature', rating:4.7, reviews:31450, priceLevel:0, price:0, area:'Harajuku', lat:35.6764,lng:139.6993, desc:"A forested shrine sanctuary in the middle of the city.", tags:['nature','relax','culture'], duration:80},
    {name:'teamLab Planets', category:'Art', rating:4.6, reviews:18320, priceLevel:3, price:32, area:'Toyosu', lat:35.6462,lng:139.7930, desc:"Immersive, barefoot digital art installations that react to you.", tags:['art','photography'], duration:120},
    {name:'Tsukiji Outer Market', category:'Market', rating:4.6, reviews:26900, priceLevel:1, price:15, area:'Tsukiji', lat:35.6655,lng:139.7708, desc:"Narrow lanes of sushi counters, tamagoyaki and seafood snacks.", tags:['food','shopping'], duration:90},
    {name:'Kappabashi Kitchen Town', category:'Shopping', rating:4.5, reviews:5210, priceLevel:1, price:10, area:'Asakusa', lat:35.7143,lng:139.7906, desc:"Chef knives, ceramics and famously realistic plastic food models.", tags:['shopping','hidden'], duration:60},
  ],
  restaurants:[
    {name:'Ichiran Ramen Shibuya', cuisine:'Ramen', rating:4.5, reviews:12040, priceLevel:2, price:13, area:'Shibuya', lat:35.6595,lng:139.7005, desc:"Solo tonkotsu ramen booths with a build-your-own flavor form.", tags:['food'], dietary:[], hours:'11:00 AM – 11:00 PM'},
    {name:'Omoide Yokocho', cuisine:'Yakitori', rating:4.4, reviews:9800, priceLevel:2, price:22, area:'Shinjuku', lat:35.6935,lng:139.6982, desc:"Tiny smoke-filled yakitori lanes tucked beside Shinjuku Station.", tags:['food','nightlife'], dietary:[], hours:'5:00 PM – 12:00 AM'},
    {name:'Sushi Dai', cuisine:'Sushi', rating:4.7, reviews:6400, priceLevel:3, price:45, area:'Toyosu', lat:35.6455,lng:139.7715, desc:"Legendary omakase counter — arrive early, the line is worth it.", tags:['food'], dietary:[], hours:'6:00 AM – 1:30 PM'},
    {name:'Afuri Ramen', cuisine:'Ramen', rating:4.5, reviews:7100, priceLevel:2, price:15, area:'Ebisu', lat:35.6467,lng:139.7100, desc:"Citrusy yuzu-shio ramen in a sleek, modern noodle bar.", tags:['food'], dietary:['vegetarian'], hours:'11:00 AM – 11:00 PM'},
    {name:'Gonpachi Nishi-Azabu', cuisine:'Izakaya', rating:4.4, reviews:5300, priceLevel:3, price:38, area:'Nishi-Azabu', lat:35.6590,lng:139.7256, desc:"Dramatic wooden izakaya hall said to have inspired Kill Bill.", tags:['food','nightlife','romantic'], dietary:[], hours:'11:30 AM – 3:30 AM'},
  ],
  hotels:[
    {name:'Park Hyatt Tokyo', stars:5, guestRating:9.3, price:520, area:'Shinjuku', lat:35.6852,lng:139.6900, desc:"Iconic skyline views made famous on the big screen.", amenities:['Pool','Spa','Gym','Bar','Free WiFi']},
    {name:'Shibuya Stream Excel Hotel', stars:4, guestRating:8.9, price:210, area:'Shibuya', lat:35.6570,lng:139.7010, desc:"Sleek rooms steps from Shibuya Crossing and the station.", amenities:['Gym','Bar','Free WiFi','Restaurant']},
    {name:'Asakusa View Hotel', stars:4, guestRating:8.6, price:165, area:'Asakusa', lat:35.7139,lng:139.7980, desc:"Old-town charm with Skytree views from upper floors.", amenities:['Pool','Bar','Free WiFi']},
    {name:'UNPLAN Kagurazaka Hostel', stars:2, guestRating:8.7, price:48, area:'Kagurazaka', lat:35.7013,lng:139.7405, desc:"Design-forward hostel in a quiet, café-lined neighborhood.", amenities:['Free WiFi','Shared kitchen','Lounge']},
  ]
},

{ id:'paris', name:'Paris', country:'France', flag:'🇫🇷',
  tagline:"Cobblestones, café culture, and world-class art around every corner.",
  description:"Paris pairs iconic landmarks with slow café mornings, candlelit bistros and some of the world's finest museums, all connected by an easy-to-love Métro.",
  tags:['trending','romantic','food','culture'],
  lat:48.8566, lng:2.3522,
  weather:"Spring (Apr–Jun): 12–20°C, blooming gardens and long daylight.",
  bestTime:"April–June & September–October",
  currency:"Euro (€)", language:"French",
  avgDailyBudget:{budget:80,moderate:180,luxury:400},
  travelInfo:{ recommendedDays:'4–6 days', timezone:'CET (UTC+1)',
    visa:'Schengen Area — many nationalities get visa-free entry for up to 90 days within a 180-day period.',
    safety:'Generally safe; watch for pickpockets near major tourist sites and on the Métro.',
    localTransport:'Paris Métro and RER trains — a Navigo Easy card covers most rides.',
    etiquette:"Always greet with \"Bonjour\" before starting a conversation, dress a bit more formally than casual tourist wear, tipping isn't required (service is included) but rounding up is appreciated." },
  attractions:[
    {name:'Eiffel Tower', category:'Landmark', rating:4.7, reviews:302000, priceLevel:2, price:28, area:'Champ de Mars', lat:48.8584,lng:2.2945, desc:"Paris's icon — best viewed from Trocadéro at sunset.", tags:['photography','romantic'], duration:120},
    {name:'The Louvre', category:'Museum', rating:4.7, reviews:265000, priceLevel:2, price:22, area:'1st Arrondissement', lat:48.8606,lng:2.3376, desc:"The world's largest art museum, home to the Mona Lisa.", tags:['culture','art','history'], duration:180},
    {name:'Montmartre & Sacré-Cœur', category:'Neighborhood', rating:4.7, reviews:118000, priceLevel:0, price:0, area:'Montmartre', lat:48.8867,lng:2.3431, desc:"Cobblestone lanes, artists' squares and a basilica with a view.", tags:['culture','photography','hidden'], duration:150},
    {name:"Musée d'Orsay", category:'Museum', rating:4.7, reviews:76000, priceLevel:2, price:18, area:'7th Arrondissement', lat:48.8600,lng:2.3266, desc:"Impressionist masterpieces inside a former Beaux-Arts train station.", tags:['culture','art'], duration:120},
    {name:'Seine River Cruise', category:'Tour', rating:4.6, reviews:54000, priceLevel:2, price:18, area:'Pont Neuf', lat:48.8566,lng:2.3376, desc:"An hour gliding past Notre-Dame, the Louvre and the Eiffel Tower.", tags:['romantic','photography'], duration:70},
    {name:'Le Marais', category:'Neighborhood', rating:4.6, reviews:39000, priceLevel:1, price:0, area:'Le Marais', lat:48.8575,lng:2.3622, desc:"Historic Jewish quarter turned boutique-and-falafel wonderland.", tags:['shopping','food','hidden'], duration:120},
  ],
  restaurants:[
    {name:"L'As du Fallafel", cuisine:'Middle Eastern', rating:4.5, reviews:14200, priceLevel:1, price:10, area:'Le Marais', lat:48.8572,lng:2.3600, desc:"The falafel line everyone tells you about — worth the wait.", tags:['food'], dietary:['vegetarian'], hours:'11:00 AM – 12:00 AM'},
    {name:'Café de Flore', cuisine:'French Café', rating:4.3, reviews:19800, priceLevel:3, price:32, area:'Saint-Germain', lat:48.8540,lng:2.3328, desc:"Historic literary café — perfect for people-watching over coffee.", tags:['food','romantic'], dietary:['vegetarian'], hours:'7:30 AM – 1:30 AM'},
    {name:'Bistrot Paul Bert', cuisine:'French Bistro', rating:4.6, reviews:6300, priceLevel:3, price:48, area:'11th Arrondissement', lat:48.8532,lng:2.3838, desc:"Classic steak-frites bistro locals actually eat at.", tags:['food','romantic'], dietary:[], hours:'12:00 PM – 11:00 PM'},
    {name:'Marché des Enfants Rouges', cuisine:'Market', rating:4.5, reviews:8100, priceLevel:1, price:14, area:'Le Marais', lat:48.8631,lng:2.3629, desc:"Paris's oldest covered market with global street-food stalls.", tags:['food','shopping'], dietary:['vegetarian','vegan'], hours:'8:30 AM – 8:00 PM'},
    {name:'Septime', cuisine:'Modern French', rating:4.7, reviews:3200, priceLevel:4, price:95, area:'11th Arrondissement', lat:48.8534,lng:2.3789, desc:"Tasting-menu darling of Paris's new-wave dining scene.", tags:['food','romantic'], dietary:[], hours:'7:00 PM – 10:30 PM'},
  ],
  hotels:[
    {name:'Hôtel Plaza Athénée', stars:5, guestRating:9.4, price:850, area:'8th Arrondissement', lat:48.8659,lng:2.3033, desc:"Legendary luxury with red awnings on Avenue Montaigne.", amenities:['Spa','Restaurant','Bar','Free WiFi']},
    {name:'Hôtel Malte Opera', stars:4, guestRating:8.7, price:190, area:'2nd Arrondissement', lat:48.8698,lng:2.3350, desc:"Boutique charm minutes from the Opéra and grand boulevards.", amenities:['Free WiFi','Breakfast']},
    {name:'Le Citizen Hotel', stars:4, guestRating:8.8, price:175, area:'Canal Saint-Martin', lat:48.8712,lng:2.3654, desc:"Minimalist design hotel beside the trendy canal.", amenities:['Free WiFi','Bar']},
    {name:'Generator Paris', stars:2, guestRating:8.3, price:55, area:'10th Arrondissement', lat:48.8809,lng:2.3600, desc:"Stylish hostel with a rooftop bar and skyline views.", amenities:['Bar','Free WiFi','Rooftop']},
  ]
},

{ id:'bali', name:'Bali', country:'Indonesia', flag:'🇮🇩',
  tagline:"Rice terraces, temple sunrises, and beach days that never rush.",
  description:"Bali blends jungle waterfalls and terraced rice paddies with surf towns and cliffside temples — an island built for slowing down, on almost any budget.",
  tags:['beach','affordable','relax','hidden'],
  lat:-8.4095, lng:115.1889,
  weather:"Dry season (Apr–Oct): 26–31°C, sunny with low humidity.",
  bestTime:"April–October",
  currency:"Indonesian Rupiah (Rp)", language:"Indonesian & Balinese",
  avgDailyBudget:{budget:35,moderate:80,luxury:220},
  travelInfo:{ recommendedDays:'7–10 days', timezone:'WITA (UTC+8)',
    visa:'Visa-on-arrival is available for many nationalities for stays up to 30 days (extendable).',
    safety:'Generally safe; watch for scooter traffic, strong ocean currents at some beaches, and petty theft.',
    localTransport:'Scooter rental is common, or hire a private driver for the day; Gojek/Grab ride-hailing apps work well.',
    etiquette:'Dress modestly when visiting temples (a sarong is often required), use your right hand for giving/receiving, remove shoes before entering homes.' },
  attractions:[
    {name:'Tegallalang Rice Terraces', category:'Nature', rating:4.5, reviews:41200, priceLevel:1, price:3, area:'Ubud', lat:-8.4312,lng:115.2777, desc:"Emerald stepped rice paddies with jungle swings overlooking the valley.", tags:['nature','photography'], duration:90},
    {name:'Uluwatu Temple', category:'Culture', rating:4.6, reviews:38700, priceLevel:1, price:4, area:'Uluwatu', lat:-8.8291,lng:115.0849, desc:"Clifftop sea temple famous for sunset Kecak fire dances.", tags:['culture','photography','romantic'], duration:100},
    {name:'Sacred Monkey Forest', category:'Nature', rating:4.4, reviews:36400, priceLevel:1, price:4, area:'Ubud', lat:-8.5188,lng:115.2588, desc:"Jungle sanctuary of moss-covered temples and free-roaming macaques.", tags:['nature'], duration:70},
    {name:'Tirta Empul Water Temple', category:'Culture', rating:4.6, reviews:19800, priceLevel:1, price:3, area:'Tampaksiring', lat:-8.4155,lng:115.3153, desc:"Sacred spring where locals and visitors take ritual purification baths.", tags:['culture','hidden'], duration:80},
    {name:'Nusa Penida Day Trip', category:'Nature', rating:4.7, reviews:22100, priceLevel:3, price:45, area:'Nusa Penida', lat:-8.7276,lng:115.5444, desc:"Dramatic cliffs, turquoise coves and the iconic Kelingking viewpoint.", tags:['nature','adventure','photography'], duration:480},
    {name:'Canggu Surf Lesson', category:'Adventure', rating:4.6, reviews:8900, priceLevel:2, price:25, area:'Canggu', lat:-8.6478,lng:115.1385, desc:"Beginner-friendly waves with laid-back beach clubs steps away.", tags:['adventure','relax'], duration:120},
  ],
  restaurants:[
    {name:'Locavore', cuisine:'Modern Indonesian', rating:4.8, reviews:4100, priceLevel:4, price:65, area:'Ubud', lat:-8.5060,lng:115.2620, desc:"Tasting-menu darling built entirely on Indonesian ingredients.", tags:['food'], dietary:['vegetarian-options'], hours:'6:00 PM – 10:00 PM'},
    {name:'Warung Babi Guling Ibu Oka', cuisine:'Balinese', rating:4.4, reviews:9200, priceLevel:1, price:6, area:'Ubud', lat:-8.5069,lng:115.2624, desc:"Legendary roast suckling pig warung, a Ubud institution.", tags:['food'], dietary:[], hours:'11:00 AM – 5:00 PM'},
    {name:'La Brisa Beach Club', cuisine:'Seafood', rating:4.5, reviews:12300, priceLevel:3, price:28, area:'Canggu', lat:-8.6555,lng:115.1319, desc:"Driftwood-boat beach club with sunset seafood and cocktails.", tags:['food','nightlife','romantic'], dietary:['vegan'], hours:'8:00 AM – 12:00 AM'},
    {name:'Sisterfields Café', cuisine:'Brunch', rating:4.5, reviews:7600, priceLevel:2, price:12, area:'Seminyak', lat:-8.6890,lng:115.1660, desc:"Bright Australian-style brunch spot loved by digital nomads.", tags:['food','relax'], dietary:['vegetarian','vegan'], hours:'7:00 AM – 10:00 PM'},
    {name:'Metis Restaurant', cuisine:'French-Balinese', rating:4.5, reviews:3900, priceLevel:3, price:32, area:'Seminyak', lat:-8.6805,lng:115.1615, desc:"Rice-paddy views with elegant French-Indonesian plates.", tags:['food','romantic'], dietary:[], hours:'11:00 AM – 11:00 PM'},
  ],
  hotels:[
    {name:'Four Seasons Sayan', stars:5, guestRating:9.6, price:780, area:'Ubud', lat:-8.4890,lng:115.2660, desc:"Jungle-canopy resort built around a lotus pond and river gorge.", amenities:['Pool','Spa','Restaurant','Free WiFi']},
    {name:'COMO Uma Ubud', stars:5, guestRating:9.2, price:420, area:'Ubud', lat:-8.5130,lng:115.2530, desc:"Wellness-focused resort with rice-field yoga pavilions.", amenities:['Pool','Spa','Gym','Free WiFi']},
    {name:'The Slow Canggu', stars:4, guestRating:8.9, price:150, area:'Canggu', lat:-8.6570,lng:115.1370, desc:"Design-forward boutique hotel near Canggu's beach clubs.", amenities:['Pool','Bar','Free WiFi']},
    {name:'Puri Garden Hostel', stars:2, guestRating:8.5, price:18, area:'Ubud', lat:-8.5050,lng:115.2600, desc:"Budget-friendly courtyard hostel walkable to Ubud center.", amenities:['Pool','Free WiFi','Breakfast']},
  ]
},

{ id:'santorini', name:'Santorini', country:'Greece', flag:'🇬🇷',
  tagline:"Whitewashed cliffs, blue domes, and the world's best sunset.",
  description:"Santorini's caldera-view villages, volcanic beaches and family-run wineries make it one of the most photographed islands on Earth — and one of the most romantic.",
  tags:['beach','romantic','trending'],
  lat:36.3932, lng:25.4615,
  weather:"Summer (Jun–Aug): 24–29°C, dry with strong afternoon winds.",
  bestTime:"May–June & September–October",
  currency:"Euro (€)", language:"Greek",
  avgDailyBudget:{budget:90,moderate:200,luxury:450},
  travelInfo:{ recommendedDays:'3–4 days', timezone:'EET (UTC+2)',
    visa:'Schengen Area — many nationalities get visa-free entry for up to 90 days within a 180-day period.',
    safety:'Very safe; main hazards are steep cliffside paths and crowded viewpoints at sunset.',
    localTransport:'Local buses connect the main towns; renting an ATV or car gives the most flexibility.',
    etiquette:'Modest dress is appreciated at churches, tipping 5–10% is customary but not mandatory.' },
  attractions:[
    {name:'Oia Sunset Point', category:'Viewpoint', rating:4.8, reviews:61000, priceLevel:0, price:0, area:'Oia', lat:36.4610,lng:25.3753, desc:"The postcard sunset over blue-domed churches and the caldera.", tags:['romantic','photography'], duration:90},
    {name:'Fira to Oia Caldera Hike', category:'Nature', rating:4.7, reviews:15400, priceLevel:0, price:0, area:'Fira', lat:36.4167,lng:25.4320, desc:"A 3-hour clifftop trail with the island's best views the whole way.", tags:['nature','adventure','photography'], duration:180},
    {name:'Red Beach', category:'Beach', rating:4.4, reviews:18700, priceLevel:0, price:0, area:'Akrotiri', lat:36.3500,lng:25.3958, desc:"Volcanic red cliffs framing a striking crescent of dark sand.", tags:['relax','photography'], duration:120},
    {name:'Akrotiri Archaeological Site', category:'History', rating:4.5, reviews:8100, priceLevel:1, price:12, area:'Akrotiri', lat:36.3512,lng:25.4030, desc:"A Bronze Age city preserved in volcanic ash — the 'Greek Pompeii'.", tags:['history','culture'], duration:90},
    {name:'Santo Wines Sunset Tasting', category:'Wine', rating:4.6, reviews:9200, priceLevel:2, price:35, area:'Pyrgos', lat:36.3800,lng:25.4460, desc:"Volcanic-soil wines paired with caldera views at golden hour.", tags:['romantic','relax'], duration:90},
    {name:'Ammoudi Bay', category:'Hidden gem', rating:4.6, reviews:6800, priceLevel:1, price:0, area:'Oia', lat:36.4650,lng:25.3690, desc:"A quiet fishing cove below Oia with cliffside seafood tavernas.", tags:['hidden','relax','food'], duration:100},
  ],
  restaurants:[
    {name:'Ammoudi Fish Tavern', cuisine:'Seafood', rating:4.6, reviews:5100, priceLevel:3, price:38, area:'Ammoudi Bay', lat:36.4652,lng:25.3688, desc:"Just-caught seafood steps from the water below Oia.", tags:['food','romantic'], dietary:[], hours:'12:00 PM – 10:00 PM'},
    {name:'Metaxi Mas', cuisine:'Greek', rating:4.7, reviews:7300, priceLevel:2, price:28, area:'Exo Gonia', lat:36.3800,lng:25.4550, desc:"Family taverna locals drive across the island to eat at.", tags:['food'], dietary:['vegetarian'], hours:'1:00 PM – 11:00 PM'},
    {name:'To Psaraki', cuisine:'Seafood', rating:4.5, reviews:3200, priceLevel:2, price:26, area:'Vlychada', lat:36.3480,lng:25.4110, desc:"Unpretentious harbor-side spot for grilled octopus and ouzo.", tags:['food','hidden'], dietary:[], hours:'12:00 PM – 11:00 PM'},
    {name:'Selene', cuisine:'Fine Dining Greek', rating:4.7, reviews:1900, priceLevel:4, price:85, area:'Pyrgos', lat:36.3806,lng:25.4552, desc:"Tasting menus built on heirloom Cycladic ingredients.", tags:['food','romantic'], dietary:[], hours:'7:00 PM – 11:00 PM'},
    {name:'Melitini', cuisine:'Cretan-Greek', rating:4.6, reviews:2600, priceLevel:2, price:24, area:'Pyrgos', lat:36.3790,lng:25.4545, desc:"Cozy courtyard taverna with slow-cooked lamb and local cheeses.", tags:['food'], dietary:['vegetarian'], hours:'6:00 PM – 11:00 PM'},
  ],
  hotels:[
    {name:'Canaves Oia Suites', stars:5, guestRating:9.5, price:650, area:'Oia', lat:36.4605,lng:25.3760, desc:"Cave-style suites carved into the caldera cliffside.", amenities:['Pool','Spa','Bar','Free WiFi']},
    {name:'Grace Hotel Santorini', stars:5, guestRating:9.4, price:590, area:'Imerovigli', lat:36.4310,lng:25.4290, desc:"Infinity pools cascading down the caldera edge.", amenities:['Pool','Spa','Restaurant','Free WiFi']},
    {name:'Aria Suites', stars:4, guestRating:9.0, price:240, area:'Fira', lat:36.4172,lng:25.4310, desc:"Bright caldera-view suites in the heart of Fira.", amenities:['Pool','Free WiFi','Breakfast']},
    {name:'Santorini Camping', stars:2, guestRating:8.1, price:35, area:'Fira', lat:36.4090,lng:25.4400, desc:"Budget-friendly bungalows a short walk from town.", amenities:['Pool','Free WiFi']},
  ]
},

{ id:'new-york', name:'New York City', country:'United States', flag:'🇺🇸',
  tagline:"The city that never sleeps — culture, skyline and food from everywhere.",
  description:"From Broadway to Brooklyn rooftops, world museums to late-night bodegas, New York packs the entire world's food and culture into five relentless boroughs.",
  tags:['trending','food','nightlife','shopping'],
  lat:40.7128, lng:-74.0060,
  weather:"Fall (Sep–Nov): 10–20°C, crisp air and changing leaves in Central Park.",
  bestTime:"April–June & September–November",
  currency:"US Dollar ($)", language:"English",
  avgDailyBudget:{budget:120,moderate:250,luxury:550},
  travelInfo:{ recommendedDays:'4–6 days', timezone:'EST (UTC-5)',
    visa:'ESTA (Visa Waiver Program) covers many nationalities for stays up to 90 days; others need a B-2 visa.',
    safety:'Generally safe in tourist areas; stay alert on the subway late at night, as in any major city.',
    localTransport:'Subway and buses (get a MetroCard or tap-to-pay OMNY) — walking is often fastest in Manhattan.',
    etiquette:'Tipping 18–20% at restaurants is expected, walk on the right on sidewalks, stand right/walk left on escalators.' },
  attractions:[
    {name:'Top of the Rock', category:'Viewpoint', rating:4.7, reviews:88000, priceLevel:3, price:40, area:'Midtown', lat:40.7590,lng:-73.9787, desc:"An open-air deck with the Empire State Building in your skyline.", tags:['photography'], duration:75},
    {name:'The Met', category:'Museum', rating:4.8, reviews:112000, priceLevel:2, price:30, area:'Upper East Side', lat:40.7794,lng:-73.9632, desc:"Two million works spanning 5,000 years of art history.", tags:['culture','art','history'], duration:180},
    {name:'Central Park', category:'Nature', rating:4.8, reviews:190000, priceLevel:0, price:0, area:'Manhattan', lat:40.7829,lng:-73.9654, desc:"843 acres of lakes, bridges and skyline views in the middle of it all.", tags:['nature','relax'], duration:120},
    {name:'High Line', category:'Park', rating:4.7, reviews:68000, priceLevel:0, price:0, area:'Chelsea', lat:40.7480,lng:-74.0048, desc:"An elevated rail line reborn as a mile-long garden walkway.", tags:['nature','photography','hidden'], duration:60},
    {name:'Brooklyn Bridge Walk', category:'Landmark', rating:4.8, reviews:75000, priceLevel:0, price:0, area:'DUMBO', lat:40.7061,lng:-73.9969, desc:"Walk into Brooklyn for the classic Manhattan skyline shot.", tags:['photography','romantic'], duration:60},
    {name:'Chelsea Market', category:'Market', rating:4.6, reviews:52000, priceLevel:1, price:18, area:'Chelsea', lat:40.7424,lng:-74.0061, desc:"A converted factory packed with global food stalls and shops.", tags:['food','shopping'], duration:75},
  ],
  restaurants:[
    {name:"Katz's Delicatessen", cuisine:'Deli', rating:4.5, reviews:29000, priceLevel:2, price:24, area:'Lower East Side', lat:40.7223,lng:-73.9874, desc:"The pastrami sandwich that launched a thousand imitators.", tags:['food'], dietary:[], hours:'8:00 AM – 10:45 PM'},
    {name:"Joe's Pizza", cuisine:'Pizza', rating:4.5, reviews:15200, priceLevel:1, price:5, area:'Greenwich Village', lat:40.7308,lng:-74.0021, desc:"A no-frills New York slice institution since 1975.", tags:['food'], dietary:['vegetarian'], hours:'10:00 AM – 4:00 AM'},
    {name:'Peter Luger Steak House', cuisine:'Steakhouse', rating:4.5, reviews:8700, priceLevel:4, price:95, area:'Williamsburg', lat:40.7099,lng:-73.9624, desc:"Century-old dry-aged porterhouse in an old-school dining room.", tags:['food','romantic'], dietary:[], hours:'11:45 AM – 9:45 PM'},
    {name:"Xi'an Famous Foods", cuisine:'Chinese', rating:4.4, reviews:6300, priceLevel:1, price:12, area:'East Village', lat:40.7280,lng:-73.9860, desc:"Hand-pulled biang biang noodles with fiery Xi'an spice.", tags:['food'], dietary:['vegetarian-options'], hours:'11:00 AM – 10:00 PM'},
    {name:'Rooftop at 230 Fifth', cuisine:'Bar & Lounge', rating:4.3, reviews:19800, priceLevel:3, price:22, area:'NoMad', lat:40.7440,lng:-73.9880, desc:"Skyline cocktails with an Empire State Building backdrop.", tags:['nightlife','romantic'], dietary:[], hours:'4:00 PM – 4:00 AM'},
  ],
  hotels:[
    {name:'The Plaza', stars:5, guestRating:9.2, price:780, area:'Midtown', lat:40.7644,lng:-73.9744, desc:"Legendary Fifth Avenue landmark facing Central Park.", amenities:['Spa','Restaurant','Bar','Free WiFi']},
    {name:'The Ludlow Hotel', stars:4, guestRating:8.9, price:340, area:'Lower East Side', lat:40.7203,lng:-73.9877, desc:"Moody, design-driven rooms in the heart of downtown nightlife.", amenities:['Bar','Free WiFi','Restaurant']},
    {name:'Pod 51 Hotel', stars:3, guestRating:8.4, price:145, area:'Midtown East', lat:40.7530,lng:-73.9730, desc:"Compact, budget-savvy rooms with a rooftop lounge.", amenities:['Free WiFi','Rooftop']},
    {name:'HI NYC Hostel', stars:2, guestRating:8.0, price:55, area:'Upper West Side', lat:40.8010,lng:-73.9700, desc:"Historic building turned social, budget-friendly hostel.", amenities:['Free WiFi','Shared kitchen']},
  ]
},

{ id:'rome', name:'Rome', country:'Italy', flag:'🇮🇹',
  tagline:"Three thousand years of history, one plate of pasta at a time.",
  description:"Rome layers empire ruins beneath Renaissance piazzas and unbeatable trattorias — every corner turns into another postcard, and every meal is an event.",
  tags:['culture','food','romantic','trending'],
  lat:41.9028, lng:12.4964,
  weather:"Spring (Apr–Jun): 14–24°C, sunny with blooming piazzas.",
  bestTime:"April–May & September–October",
  currency:"Euro (€)", language:"Italian",
  avgDailyBudget:{budget:70,moderate:160,luxury:380},
  travelInfo:{ recommendedDays:'3–5 days', timezone:'CET (UTC+1)',
    visa:'Schengen Area — many nationalities get visa-free entry for up to 90 days within a 180-day period.',
    safety:'Generally safe; watch for pickpockets near major sites and on crowded public transit.',
    localTransport:'Metro (2 lines), buses and trams — validate paper tickets before boarding.',
    etiquette:'Dress modestly (shoulders/knees covered) to enter churches, cappuccino is considered a morning-only drink locally, tipping is not required.' },
  attractions:[
    {name:'The Colosseum', category:'History', rating:4.8, reviews:210000, priceLevel:2, price:24, area:'Centro Storico', lat:41.8902,lng:12.4922, desc:"The ancient arena that once held 50,000 roaring spectators.", tags:['history','culture','photography'], duration:120},
    {name:'Vatican Museums & Sistine Chapel', category:'Museum', rating:4.7, reviews:158000, priceLevel:3, price:32, area:'Vatican City', lat:41.9065,lng:12.4536, desc:"Michelangelo's ceiling and miles of Renaissance masterpieces.", tags:['culture','art','history'], duration:180},
    {name:'Trevi Fountain', category:'Landmark', rating:4.7, reviews:196000, priceLevel:0, price:0, area:'Centro Storico', lat:41.9009,lng:12.4833, desc:"Toss a coin over your shoulder to guarantee your return.", tags:['photography','romantic'], duration:30},
    {name:'Pantheon', category:'History', rating:4.8, reviews:110000, priceLevel:0, price:0, area:'Centro Storico', lat:41.8986,lng:12.4769, desc:"A 2,000-year-old dome still standing exactly as built.", tags:['history','culture'], duration:45},
    {name:'Trastevere Evening Walk', category:'Neighborhood', rating:4.7, reviews:41200, priceLevel:0, price:0, area:'Trastevere', lat:41.8896,lng:12.4696, desc:"Ivy-covered lanes, trattorias and Rome's liveliest evenings.", tags:['nightlife','food','hidden'], duration:120},
    {name:'Borghese Gallery & Gardens', category:'Museum', rating:4.7, reviews:38700, priceLevel:2, price:22, area:'Villa Borghese', lat:41.9142,lng:12.4922, desc:"Bernini sculptures inside a garden villa above the city.", tags:['art','culture','relax'], duration:120},
  ],
  restaurants:[
    {name:'Roscioli', cuisine:'Roman', rating:4.6, reviews:9800, priceLevel:3, price:42, area:'Centro Storico', lat:41.8945,lng:12.4736, desc:"Deli-restaurant famous for cacio e pepe and a legendary wine list.", tags:['food'], dietary:[], hours:'12:30 PM – 4:00 PM, 6:30 PM – 12:00 AM'},
    {name:'Da Enzo al 29', cuisine:'Roman Trattoria', rating:4.6, reviews:7200, priceLevel:2, price:28, area:'Trastevere', lat:41.8873,lng:12.4712, desc:"Tiny trattoria locals queue for — go early or wait happily.", tags:['food'], dietary:['vegetarian'], hours:'1:00 PM – 3:00 PM, 7:30 PM – 11:00 PM'},
    {name:'Pizzarium Bonci', cuisine:'Pizza al Taglio', rating:4.6, reviews:8900, priceLevel:1, price:9, area:'Prati', lat:41.9083,lng:12.4535, desc:"Rome's best sliced pizza, sold by weight from a tiny counter.", tags:['food'], dietary:['vegetarian'], hours:'11:00 AM – 10:00 PM'},
    {name:'Gelateria dei Gracchi', cuisine:'Gelato', rating:4.7, reviews:5100, priceLevel:1, price:5, area:'Prati', lat:41.9070,lng:12.4590, desc:"Small-batch, all-natural gelato without the tourist markup.", tags:['food'], dietary:['vegetarian'], hours:'11:00 AM – 11:00 PM'},
    {name:'Aroma at Palazzo Manfredi', cuisine:'Fine Dining Italian', rating:4.7, reviews:2400, priceLevel:4, price:110, area:'Celio', lat:41.8901,lng:12.4960, desc:"Michelin-starred plates with the Colosseum floodlit outside.", tags:['food','romantic'], dietary:[], hours:'12:30 PM – 3:00 PM, 7:00 PM – 11:00 PM'},
  ],
  hotels:[
    {name:'Hotel de Russie', stars:5, guestRating:9.3, price:620, area:'Piazza del Popolo', lat:41.9106,lng:12.4780, desc:"Secret garden courtyard steps from the Spanish Steps.", amenities:['Pool','Spa','Restaurant','Free WiFi']},
    {name:'The Fifteen Keys Hotel', stars:4, guestRating:9.0, price:230, area:'Centro Storico', lat:41.8940,lng:12.4720, desc:"Boutique rooms a short walk from the Pantheon.", amenities:['Free WiFi','Breakfast']},
    {name:'Hotel Trastevere', stars:3, guestRating:8.5, price:130, area:'Trastevere', lat:41.8880,lng:12.4700, desc:"Simple, comfortable rooms in Rome's liveliest quarter.", amenities:['Free WiFi']},
    {name:'The Yellow Hostel', stars:2, guestRating:8.2, price:38, area:'Termini', lat:41.9010,lng:12.5030, desc:"Social hostel with a lively bar, near Termini station.", amenities:['Bar','Free WiFi']},
  ]
},

{ id:'bangkok', name:'Bangkok', country:'Thailand', flag:'🇹🇭',
  tagline:"Golden temples, floating markets, and street food you'll dream about.",
  description:"Bangkok runs on contrast — gilded temples beside glass skyscrapers, tuk-tuks weaving past rooftop bars, and some of the best street food anywhere, at prices that go far.",
  tags:['affordable','food','nightlife'],
  lat:13.7563, lng:100.5018,
  weather:"Cool season (Nov–Feb): 24–32°C, the most comfortable months.",
  bestTime:"November–February",
  currency:"Thai Baht (฿)", language:"Thai",
  avgDailyBudget:{budget:30,moderate:70,luxury:180},
  travelInfo:{ recommendedDays:'3–5 days', timezone:'ICT (UTC+7)',
    visa:'Visa exemption or visa-on-arrival is available for many nationalities for short stays — check current length limits.',
    safety:'Generally safe; use metered taxis or ride-hailing apps and be cautious of common tourist scams near major temples.',
    localTransport:'BTS Skytrain and MRT subway avoid traffic; tuk-tuks and taxis for shorter hops.',
    etiquette:"Dress modestly at temples (covered shoulders/knees), never touch someone's head, remove shoes when entering homes and temples, the King is revered — avoid disrespectful comments." },
  attractions:[
    {name:'Grand Palace & Wat Phra Kaew', category:'Culture', rating:4.6, reviews:98000, priceLevel:2, price:15, area:'Rattanakosin', lat:13.7500,lng:100.4913, desc:"Glittering former royal residence and the Emerald Buddha temple.", tags:['culture','history','photography'], duration:150},
    {name:'Wat Arun', category:'Culture', rating:4.6, reviews:52000, priceLevel:1, price:3, area:'Bangkok Yai', lat:13.7437,lng:100.4888, desc:"The Temple of Dawn, best photographed from across the river.", tags:['culture','photography'], duration:75},
    {name:'Chatuchak Weekend Market', category:'Market', rating:4.5, reviews:61000, priceLevel:1, price:0, area:'Chatuchak', lat:13.7999,lng:100.5500, desc:"15,000 stalls of everything from antiques to street snacks.", tags:['shopping','food'], duration:150},
    {name:'Damnoen Saduak Floating Market', category:'Market', rating:4.4, reviews:33200, priceLevel:2, price:20, area:'Ratchaburi', lat:13.5170,lng:99.9550, desc:"Boat-vendors selling fruit and noodles along narrow canals.", tags:['culture','food','hidden'], duration:180},
    {name:'Lumphini Park', category:'Nature', rating:4.5, reviews:24100, priceLevel:0, price:0, area:'Pathum Wan', lat:13.7307,lng:100.5418, desc:"A green escape with monitor lizards and skyline backdrops.", tags:['nature','relax'], duration:60},
    {name:'Mahanakhon SkyWalk', category:'Viewpoint', rating:4.5, reviews:20900, priceLevel:2, price:28, area:'Silom', lat:13.7229,lng:100.5288, desc:"Glass-floor observation deck atop Bangkok's tallest building.", tags:['photography'], duration:60},
  ],
  restaurants:[
    {name:'Jay Fai', cuisine:'Street Food', rating:4.6, reviews:8100, priceLevel:3, price:25, area:'Old Town', lat:13.7530,lng:100.5040, desc:"Michelin-starred crab omelet cooked over roaring charcoal woks.", tags:['food'], dietary:[], hours:'2:00 PM – 12:00 AM'},
    {name:'Thipsamai Pad Thai', cuisine:'Thai', rating:4.5, reviews:12300, priceLevel:1, price:5, area:'Old Town', lat:13.7548,lng:100.5027, desc:"Bangkok's most famous pad thai since 1966.", tags:['food'], dietary:['vegetarian-options'], hours:'5:00 PM – 2:00 AM'},
    {name:'Chinatown Street Food Crawl', cuisine:'Street Food', rating:4.6, reviews:9700, priceLevel:1, price:12, area:'Yaowarat', lat:13.7404,lng:100.5090, desc:"Neon-lit Yaowarat Road, wall-to-wall with grills and noodle carts.", tags:['food','nightlife'], dietary:[], hours:'6:00 PM – 1:00 AM'},
    {name:'Sky Bar at Lebua', cuisine:'Rooftop Bar', rating:4.4, reviews:15200, priceLevel:4, price:35, area:'Silom', lat:13.7220,lng:100.5150, desc:"The Hangover Part II rooftop, 63 floors above the city.", tags:['nightlife','romantic'], dietary:[], hours:'6:00 PM – 1:00 AM'},
    {name:'Err Urban Rustic Thai', cuisine:'Thai', rating:4.5, reviews:4200, priceLevel:2, price:18, area:'Rattanakosin', lat:13.7460,lng:100.4930, desc:"Punchy regional Thai plates and cold beer near the Grand Palace.", tags:['food'], dietary:['vegetarian'], hours:'11:00 AM – 11:00 PM'},
  ],
  hotels:[
    {name:'Mandarin Oriental Bangkok', stars:5, guestRating:9.4, price:480, area:'Riverside', lat:13.7239,lng:100.5140, desc:"Historic riverside icon hosting royalty since 1876.", amenities:['Pool','Spa','Restaurant','Free WiFi']},
    {name:'137 Pillars Suites', stars:5, guestRating:9.2, price:260, area:'Sukhumvit', lat:13.7390,lng:100.5560, desc:"All-suite colonial-style hotel with a rooftop pool.", amenities:['Pool','Spa','Free WiFi']},
    {name:'Chatrium Riverside', stars:4, guestRating:8.7, price:110, area:'Riverside', lat:13.7080,lng:100.5060, desc:"River-view rooms with an infinity pool over the Chao Phraya.", amenities:['Pool','Gym','Free WiFi']},
    {name:'NapPark Hostel', stars:2, guestRating:8.4, price:15, area:'Khao San Road', lat:13.7590,lng:100.4970, desc:"Pod-style hostel steps from Khao San's nightlife.", amenities:['Free WiFi','Lounge']},
  ]
},

{ id:'barcelona', name:'Barcelona', country:'Spain', flag:'🇪🇸',
  tagline:"Gaudí's fantasies, tapas bars, and Mediterranean beach afternoons.",
  description:"Barcelona pairs surreal Gaudí architecture with beach clubs, late-night tapas crawls and a nightlife that barely starts before midnight.",
  tags:['beach','culture','nightlife','trending'],
  lat:41.3874, lng:2.1686,
  weather:"Summer (Jun–Aug): 22–29°C, warm with sea breezes.",
  bestTime:"May–June & September",
  currency:"Euro (€)", language:"Spanish & Catalan",
  avgDailyBudget:{budget:65,moderate:140,luxury:320},
  travelInfo:{ recommendedDays:'3–5 days', timezone:'CET (UTC+1)',
    visa:'Schengen Area — many nationalities get visa-free entry for up to 90 days within a 180-day period.',
    safety:'Generally safe; pickpocketing is common on La Rambla and public transit — stay alert.',
    localTransport:'The metro and bus network is extensive; a T-Casual multi-ride card saves money.',
    etiquette:'Lunch is typically 2–4pm and dinner rarely starts before 9pm; some shops close mid-afternoon for siesta.' },
  attractions:[
    {name:'Sagrada Família', category:'Landmark', rating:4.8, reviews:245000, priceLevel:3, price:33, area:'Eixample', lat:41.4036,lng:2.1744, desc:"Gaudí's unfinished basilica — still under construction since 1882.", tags:['culture','art','photography'], duration:120},
    {name:'Park Güell', category:'Park', rating:4.6, reviews:151000, priceLevel:2, price:10, area:'Gràcia', lat:41.4145,lng:2.1527, desc:"Mosaic-covered terraces and gingerbread pavilions above the city.", tags:['art','photography','nature'], duration:90},
    {name:'Gothic Quarter Walk', category:'Neighborhood', rating:4.7, reviews:63000, priceLevel:0, price:0, area:'Barri Gòtic', lat:41.3833,lng:2.1765, desc:"Medieval alleys, hidden plazas and the old Roman city walls.", tags:['culture','history','hidden'], duration:120},
    {name:'La Boqueria Market', category:'Market', rating:4.5, reviews:58000, priceLevel:1, price:12, area:'La Rambla', lat:41.3818,lng:2.1716, desc:"A dazzling covered market of jamón, seafood and fresh juice.", tags:['food','shopping'], duration:60},
    {name:'Barceloneta Beach', category:'Beach', rating:4.4, reviews:71000, priceLevel:0, price:0, area:'Barceloneta', lat:41.3785,lng:2.1925, desc:"The city's main beach, backed by seafood chiringuitos.", tags:['relax','nightlife'], duration:150},
    {name:'Bunkers del Carmel', category:'Viewpoint', rating:4.7, reviews:22400, priceLevel:0, price:0, area:'El Carmel', lat:41.4198,lng:2.1590, desc:"Old anti-aircraft bunkers turned the city's best free sunset spot.", tags:['hidden','photography','romantic'], duration:75},
  ],
  restaurants:[
    {name:'Cal Pep', cuisine:'Tapas', rating:4.6, reviews:6700, priceLevel:3, price:32, area:'El Born', lat:41.3838,lng:2.1830, desc:"Standing-room tapas bar with the freshest seafood in town.", tags:['food'], dietary:[], hours:'1:15 PM – 3:45 PM, 7:30 PM – 11:15 PM'},
    {name:'Bar Cañete', cuisine:'Tapas', rating:4.6, reviews:4300, priceLevel:3, price:35, area:'Raval', lat:41.3800,lng:2.1730, desc:"Chef-counter tapas bar loved by locals and critics alike.", tags:['food'], dietary:[], hours:'1:00 PM – 4:00 PM, 8:00 PM – 12:00 AM'},
    {name:'Quimet & Quimet', cuisine:'Tapas', rating:4.6, reviews:5100, priceLevel:2, price:20, area:'Poble Sec', lat:41.3735,lng:2.1650, desc:"Tiny, bottle-lined family bar famous for gourmet montaditos.", tags:['food','hidden'], dietary:[], hours:'12:00 PM – 4:00 PM, 7:00 PM – 10:30 PM'},
    {name:'Can Solé', cuisine:'Seafood Paella', rating:4.5, reviews:3200, priceLevel:3, price:38, area:'Barceloneta', lat:41.3800,lng:2.1900, desc:"Century-old fisherman's restaurant famous for rice dishes.", tags:['food','romantic'], dietary:[], hours:'1:00 PM – 4:00 PM, 8:00 PM – 11:00 PM'},
    {name:'Pacha Barcelona', cuisine:'Nightclub', rating:4.3, reviews:9800, priceLevel:3, price:25, area:'Port Olímpic', lat:41.3880,lng:2.1960, desc:"Beachfront club with international DJs into the early hours.", tags:['nightlife'], dietary:[], hours:'12:00 AM – 6:00 AM'},
  ],
  hotels:[
    {name:'Hotel Arts Barcelona', stars:5, guestRating:9.3, price:520, area:'Port Olímpic', lat:41.3870,lng:2.1960, desc:"Beachfront tower with sweeping Mediterranean views.", amenities:['Pool','Spa','Restaurant','Free WiFi']},
    {name:'Casa Bonay', stars:4, guestRating:9.0, price:220, area:'Eixample', lat:41.3930,lng:2.1690, desc:"Design hotel with a buzzy courtyard café and rooftop.", amenities:['Free WiFi','Bar','Breakfast']},
    {name:'H10 Casa Mimosa', stars:4, guestRating:8.8, price:175, area:'Eixample', lat:41.3960,lng:2.1620, desc:"Modernist-district boutique hotel near Casa Batlló.", amenities:['Free WiFi','Breakfast']},
    {name:'Kabul Party Hostel', stars:2, guestRating:8.1, price:28, area:'Gothic Quarter', lat:41.3800,lng:2.1770, desc:"Social hostel right on Plaça Reial, famous for its rooftop.", amenities:['Bar','Free WiFi']},
  ]
},

{ id:'queenstown', name:'Queenstown', country:'New Zealand', flag:'🇳🇿',
  tagline:"Bungee jumps, alpine lakes, and the world's adventure capital.",
  description:"Ringed by the Remarkables mountains on Lake Wakatipu, Queenstown is New Zealand's adrenaline capital — but just as good for wine, hikes and impossibly scenic drives.",
  tags:['adventure','trending'],
  lat:-45.0312, lng:168.6626,
  weather:"Summer (Dec–Feb): 10–22°C, long daylight for hiking.",
  bestTime:"December–February & June–August (ski season)",
  currency:"NZ Dollar (NZ$)", language:"English",
  avgDailyBudget:{budget:90,moderate:190,luxury:420},
  travelInfo:{ recommendedDays:'4–6 days', timezone:'NZST (UTC+12)',
    visa:'An NZeTA is required in advance for many visa-waiver nationalities, even for short visits.',
    safety:'Very safe; the main risks are adventure-sport related and changeable mountain weather.',
    localTransport:'A rental car is the most flexible option; local buses connect the town center to activities.',
    etiquette:"Casual dress is the norm everywhere, tipping isn't customary, a friendly \"Kia ora\" goes a long way." },
  attractions:[
    {name:'Kawarau Gorge Bungy', category:'Adventure', rating:4.8, reviews:14200, priceLevel:4, price:150, area:'Kawarau Gorge', lat:-45.0605,lng:168.7530, desc:"The world's first commercial bungy jump, 43 meters over the river.", tags:['adventure'], duration:90},
    {name:'Skyline Gondola & Luge', category:'Adventure', rating:4.6, reviews:21800, priceLevel:2, price:45, area:'Ben Lomond', lat:-45.0300,lng:168.6650, desc:"Cable car to panoramic lake views, then a hillside luge track down.", tags:['adventure','photography'], duration:120},
    {name:'Milford Sound Day Cruise', category:'Nature', rating:4.8, reviews:33200, priceLevel:4, price:120, area:'Fiordland', lat:-44.6720,lng:167.9250, desc:"Waterfalls, seals and fiord walls on a full-day scenic cruise.", tags:['nature','photography'], duration:660},
    {name:'Lake Wakatipu Waterfront', category:'Nature', rating:4.6, reviews:18900, priceLevel:0, price:0, area:'Queenstown Bay', lat:-45.0320,lng:168.6600, desc:"Alpine lake promenade framed by the jagged Remarkables range.", tags:['nature','relax'], duration:60},
    {name:'Gibbston Valley Wine Tasting', category:'Wine', rating:4.6, reviews:5100, priceLevel:2, price:25, area:'Gibbston', lat:-45.0430,lng:168.9040, desc:"Cellar-door tastings of the region's famous Pinot Noir.", tags:['relax','hidden'], duration:120},
    {name:'Ben Lomond Track', category:'Hiking', rating:4.7, reviews:6300, priceLevel:0, price:0, area:'Ben Lomond', lat:-45.0180,lng:168.6480, desc:"A challenging summit hike with 360° views over the Southern Alps.", tags:['adventure','nature'], duration:360},
  ],
  restaurants:[
    {name:'Fergburger', cuisine:'Burgers', rating:4.5, reviews:31200, priceLevel:2, price:16, area:'Queenstown Central', lat:-45.0315,lng:168.6600, desc:"Legendary late-night burger joint with a line down the block.", tags:['food'], dietary:['vegetarian'], hours:'8:00 AM – 5:00 AM'},
    {name:'Rata', cuisine:'Modern NZ', rating:4.7, reviews:3200, priceLevel:3, price:48, area:'Queenstown Central', lat:-45.0313,lng:168.6612, desc:"Chef Josh Emett's seasonal, locally-sourced fine dining.", tags:['food','romantic'], dietary:[], hours:'5:00 PM – 10:00 PM'},
    {name:'Botswana Butchery', cuisine:'Steakhouse', rating:4.5, reviews:4100, priceLevel:4, price:55, area:'Lakefront', lat:-45.0320,lng:168.6595, desc:"Lakefront steaks with Remarkables views from every table.", tags:['food','romantic'], dietary:[], hours:'12:00 PM – 10:00 PM'},
    {name:'Vudu Cafe & Larder', cuisine:'Café', rating:4.5, reviews:2900, priceLevel:2, price:14, area:'Queenstown Central', lat:-45.0308,lng:168.6605, desc:"Local favorite for brunch before a big day outdoors.", tags:['food','relax'], dietary:['vegetarian'], hours:'7:00 AM – 4:00 PM'},
    {name:'Pub on Wharf', cuisine:'Pub', rating:4.3, reviews:5600, priceLevel:2, price:20, area:'Steamer Wharf', lat:-45.0330,lng:168.6580, desc:"Waterfront pub with craft beer and Southern Alps sunsets.", tags:['nightlife'], dietary:[], hours:'11:00 AM – 1:00 AM'},
  ],
  hotels:[
    {name:"Eichardt's Private Hotel", stars:5, guestRating:9.4, price:590, area:'Lakefront', lat:-45.0322,lng:168.6598, desc:"Historic five-suite hotel right on the Queenstown waterfront.", amenities:['Spa','Restaurant','Bar','Free WiFi']},
    {name:'The Rees Hotel', stars:5, guestRating:9.2, price:340, area:'Queenstown Bay', lat:-45.0270,lng:168.6540, desc:"Lakeside apartments with full mountain and water views.", amenities:['Pool','Spa','Restaurant','Free WiFi']},
    {name:'Novotel Queenstown Lakeside', stars:4, guestRating:8.7, price:190, area:'Queenstown Central', lat:-45.0300,lng:168.6620, desc:"Central lakeside base for gondola, bars and adventure tours.", amenities:['Gym','Free WiFi','Restaurant']},
    {name:'YHA Queenstown Lakefront', stars:2, guestRating:8.5, price:35, area:'Queenstown Central', lat:-45.0290,lng:168.6610, desc:"Budget lakefront hostel with a communal fireplace lounge.", amenities:['Free WiFi','Shared kitchen']},
  ]
},

{ id:'reykjavik', name:'Reykjavik', country:'Iceland', flag:'🇮🇸',
  tagline:"Northern lights, glacier hikes, and geothermal hot springs.",
  description:"Reykjavik is the launchpad for Iceland's otherworldly landscapes — waterfalls, volcanoes and glaciers all within a day's drive of colorful streets and steamy lagoons.",
  tags:['adventure','hidden','nature'],
  lat:64.1466, lng:-21.9426,
  weather:"Summer (Jun–Aug): 10–15°C, near-endless daylight.",
  bestTime:"June–August (midnight sun) & Sep–Mar (northern lights)",
  currency:"Icelandic Króna (kr)", language:"Icelandic",
  avgDailyBudget:{budget:110,moderate:230,luxury:480},
  travelInfo:{ recommendedDays:'5–7 days', timezone:'GMT (UTC+0, no daylight saving)',
    visa:'Schengen Area — many nationalities get visa-free entry for up to 90 days within a 180-day period.',
    safety:'Very safe; the main hazards are weather and road conditions when driving the Ring Road.',
    localTransport:'Renting a car is by far the best way to see beyond the city; local buses cover central Reykjavik.',
    etiquette:"Tipping isn't expected (service is included), tap water is excellent and safe to drink everywhere." },
  attractions:[
    {name:'Blue Lagoon', category:'Hot Spring', rating:4.5, reviews:61200, priceLevel:3, price:75, area:'Grindavík', lat:63.8804,lng:-22.4495, desc:"Milky-blue geothermal spa set in a black lava field.", tags:['relax','photography'], duration:150},
    {name:'Golden Circle Tour', category:'Nature', rating:4.7, reviews:38400, priceLevel:3, price:95, area:'South Iceland', lat:64.3100,lng:-20.1200, desc:"Geysers, waterfalls and the rift between two continents in a day.", tags:['nature','adventure','photography'], duration:480},
    {name:'Hallgrímskirkja Church', category:'Landmark', rating:4.6, reviews:41200, priceLevel:1, price:8, area:'Skólavörðuholt', lat:64.1417,lng:-21.9268, desc:"Basalt-column-inspired church tower with the city's best skyline view.", tags:['photography','culture'], duration:45},
    {name:'Sky Lagoon', category:'Hot Spring', rating:4.7, reviews:9800, priceLevel:3, price:65, area:'Kópavogur', lat:64.1150,lng:-21.9400, desc:"An infinity-edge geothermal pool facing the open Atlantic.", tags:['relax','hidden'], duration:150},
    {name:'Jökulsárlón Glacier Lagoon', category:'Nature', rating:4.8, reviews:22100, priceLevel:0, price:0, area:'South Coast', lat:64.0784,lng:-16.2306, desc:"Icebergs calve from a glacier and drift out to a black-sand beach.", tags:['nature','adventure','photography'], duration:120},
    {name:'Northern Lights Hunt', category:'Adventure', rating:4.6, reviews:15300, priceLevel:2, price:60, area:'Reykjavik outskirts', lat:64.2000,lng:-21.9000, desc:"A guided night drive chasing the aurora away from city lights.", tags:['adventure','photography','hidden'], duration:240},
  ],
  restaurants:[
    {name:'Bæjarins Beztu Pylsur', cuisine:'Hot Dog Stand', rating:4.5, reviews:9800, priceLevel:1, price:4, area:'Downtown', lat:64.1477,lng:-21.9400, desc:"A legendary hot dog cart even presidents have stopped at.", tags:['food'], dietary:[], hours:'10:00 AM – 1:00 AM'},
    {name:'Matur og Drykkur', cuisine:'New Icelandic', rating:4.7, reviews:2100, priceLevel:3, price:52, area:'Grandi', lat:64.1520,lng:-21.9450, desc:"Old Icelandic recipes reinvented in a former fish factory.", tags:['food'], dietary:[], hours:'6:00 PM – 10:00 PM'},
    {name:'Icelandic Fish & Chips', cuisine:'Seafood', rating:4.5, reviews:3600, priceLevel:2, price:22, area:'Downtown', lat:64.1490,lng:-21.9390, desc:"Sustainably-caught fish with organic-flour batter and skyr dips.", tags:['food'], dietary:['gluten-free-options'], hours:'11:30 AM – 9:00 PM'},
    {name:'Café Loki', cuisine:'Icelandic', rating:4.4, reviews:4100, priceLevel:2, price:18, area:'Skólavörðuholt', lat:64.1420,lng:-21.9270, desc:"Traditional rye bread and lamb soup beside Hallgrímskirkja.", tags:['food','hidden'], dietary:['vegetarian'], hours:'9:00 AM – 9:00 PM'},
    {name:'Kaffibarinn', cuisine:'Bar', rating:4.3, reviews:5200, priceLevel:2, price:14, area:'Downtown', lat:64.1465,lng:-21.9410, desc:"Reykjavik's iconic hole-in-the-wall bar, buzzing until dawn.", tags:['nightlife'], dietary:[], hours:'3:00 PM – 4:30 AM'},
  ],
  hotels:[
    {name:'Hotel Borg', stars:5, guestRating:9.1, price:340, area:'Downtown', lat:64.1468,lng:-21.9400, desc:"Art Deco landmark on Reykjavik's main square since 1930.", amenities:['Spa','Restaurant','Bar','Free WiFi']},
    {name:'Canopy by Hilton Reykjavik', stars:4, guestRating:8.9, price:210, area:'Downtown', lat:64.1500,lng:-21.9350, desc:"Modern rooms and a rooftop bar in the city center.", amenities:['Bar','Free WiFi','Restaurant']},
    {name:'Kex Hostel', stars:2, guestRating:8.6, price:60, area:'Laugavegur', lat:64.1480,lng:-21.9200, desc:"Former biscuit factory turned design-forward social hostel.", amenities:['Bar','Free WiFi','Restaurant']},
    {name:'Reykjavik Domestic Airport Hotel', stars:3, guestRating:8.2, price:130, area:'Skerjafjörður', lat:64.1300,lng:-21.9350, desc:"Simple, convenient rooms near the domestic airport.", amenities:['Free WiFi','Breakfast']},
  ]
},

{ id:'ljubljana', name:'Ljubljana', country:'Slovenia', flag:'🇸🇮',
  tagline:"A fairy-tale river town most travelers still haven't discovered.",
  description:"Ljubljana's dragon-guarded bridges, riverside cafés and hilltop castle make it one of Europe's most underrated capitals — walkable, green, and refreshingly affordable.",
  tags:['hidden','affordable'],
  lat:46.0569, lng:14.5058,
  weather:"Summer (Jun–Aug): 18–27°C, warm with occasional storms.",
  bestTime:"May–June & September",
  currency:"Euro (€)", language:"Slovenian",
  avgDailyBudget:{budget:45,moderate:100,luxury:240},
  travelInfo:{ recommendedDays:'2–3 days', timezone:'CET (UTC+1)',
    visa:'Schengen Area — many nationalities get visa-free entry for up to 90 days within a 180-day period.',
    safety:'Very safe — one of the calmest capital cities in Europe.',
    localTransport:'The compact old town is entirely walkable; buses cover the rest of the city.',
    etiquette:'Tipping around 10% is appreciated but not required; the city center is largely car-free.' },
  attractions:[
    {name:'Ljubljana Castle', category:'History', rating:4.6, reviews:19800, priceLevel:1, price:12, area:'Castle Hill', lat:46.0489,lng:14.5086, desc:"A funicular ride up to a medieval castle with rooftop city views.", tags:['history','photography'], duration:90},
    {name:'Triple Bridge & Dragon Bridge', category:'Landmark', rating:4.7, reviews:12300, priceLevel:0, price:0, area:'Old Town', lat:46.0511,lng:14.5060, desc:"The photogenic bridges that frame the old town's river walk.", tags:['photography','culture'], duration:45},
    {name:'Tivoli Park', category:'Nature', rating:4.6, reviews:8900, priceLevel:0, price:0, area:'Tivoli', lat:46.0580,lng:14.4930, desc:"The city's green lung — paths, ponds and a hilltop mansion.", tags:['nature','relax'], duration:75},
    {name:'Ljubljanica Riverside Cafés', category:'Neighborhood', rating:4.7, reviews:9100, priceLevel:0, price:0, area:'Old Town', lat:46.0500,lng:14.5070, desc:"Riverside terraces perfect for a slow afternoon coffee.", tags:['relax','hidden'], duration:60},
    {name:'Central Market', category:'Market', rating:4.5, reviews:4600, priceLevel:1, price:8, area:'Old Town', lat:46.0524,lng:14.5075, desc:"Plečnik-designed colonnade market for produce and local bites.", tags:['food','shopping'], duration:50},
    {name:'Metelkova Mesto', category:'Nightlife', rating:4.4, reviews:3900, priceLevel:1, price:10, area:'Metelkova', lat:46.0577,lng:14.5155, desc:"A graffiti-covered squat-turned-cultural district with clubs and bars.", tags:['nightlife','hidden'], duration:120},
  ],
  restaurants:[
    {name:'Odprta Kuhna (Open Kitchen)', cuisine:'Street Food Market', rating:4.6, reviews:5100, priceLevel:1, price:12, area:'Pogačarjev Trg', lat:46.0515,lng:14.5065, desc:"Friday street-food market from the city's best chefs.", tags:['food'], dietary:['vegetarian','vegan'], hours:'Fri 10:00 AM – 9:00 PM'},
    {name:'Gostilna As', cuisine:'Slovenian', rating:4.6, reviews:2900, priceLevel:3, price:38, area:'Old Town', lat:46.0512,lng:14.5052, desc:"Elegant courtyard restaurant reinventing classic Slovenian dishes.", tags:['food','romantic'], dietary:[], hours:'12:00 PM – 11:00 PM'},
    {name:'Ljubljanski Dvor Pizzeria', cuisine:'Pizza', rating:4.4, reviews:3300, priceLevel:1, price:9, area:'Riverside', lat:46.0505,lng:14.5075, desc:"Riverside pizza-by-the-slice window, always packed at lunch.", tags:['food'], dietary:['vegetarian'], hours:'10:00 AM – 10:00 PM'},
    {name:'Cacao', cuisine:'Café & Dessert', rating:4.5, reviews:2100, priceLevel:1, price:7, area:'Old Town', lat:46.0498,lng:14.5069, desc:"Riverside café famous for its Slovenian-chocolate desserts.", tags:['food','relax'], dietary:['vegetarian'], hours:'8:00 AM – 10:00 PM'},
    {name:'Julija', cuisine:'Slovenian-Italian', rating:4.5, reviews:1800, priceLevel:2, price:22, area:'Old Town', lat:46.0508,lng:14.5058, desc:"Cozy old-town spot for handmade pasta and local wine.", tags:['food'], dietary:['vegetarian'], hours:'11:00 AM – 11:00 PM'},
  ],
  hotels:[
    {name:'Grand Hotel Union', stars:5, guestRating:9.0, price:220, area:'City Center', lat:46.0530,lng:14.5045, desc:"Art Nouveau grand dame on the main square since 1905.", amenities:['Pool','Spa','Restaurant','Free WiFi']},
    {name:'Vander Urbani Resort', stars:4, guestRating:9.1, price:190, area:'Riverside', lat:46.0500,lng:14.5040, desc:"Boutique riverside hotel with a rooftop pool deck.", amenities:['Pool','Free WiFi','Bar']},
    {name:'Hotel Park', stars:3, guestRating:8.3, price:95, area:'City Center', lat:46.0560,lng:14.5130, desc:"Simple, central rooms walkable to Tivoli Park and Old Town.", amenities:['Free WiFi','Breakfast']},
    {name:'Hostel Celica', stars:2, guestRating:8.5, price:30, area:'Metelkova', lat:46.0575,lng:14.5150, desc:"Former prison cells turned artist-designed hostel rooms.", amenities:['Free WiFi','Bar']},
  ]
},

{ id:'marrakech', name:'Marrakech', country:'Morocco', flag:'🇲🇦',
  tagline:"Maze-like souks, riad courtyards, and the Atlas Mountains on the horizon.",
  description:"Marrakech overwhelms the senses — spice-scented souks, snake charmers in Jemaa el-Fna, and hidden riads behind unmarked doors, all beneath the Atlas Mountains.",
  tags:['adventure','affordable','hidden'],
  lat:31.6295, lng:-7.9811,
  weather:"Spring (Mar–May): 18–28°C, warm days and cool evenings.",
  bestTime:"March–May & September–November",
  currency:"Moroccan Dirham (MAD)", language:"Arabic & French",
  avgDailyBudget:{budget:35,moderate:85,luxury:220},
  travelInfo:{ recommendedDays:'3–5 days', timezone:'WET (UTC+0/+1 with daylight saving)',
    visa:"Visa-free entry for many nationalities for stays up to 90 days — check your country's specifics.",
    safety:"Generally safe; the medina's narrow lanes can be disorienting, and persistent vendors are common — polite firmness works well.",
    localTransport:'The medina is walkable (no cars); petit taxis are cheap for longer trips — agree on a price before riding.',
    etiquette:'Dress modestly, especially outside tourist zones; haggling in souks is expected and part of the culture; Friday is the holy day with different business hours.' },
  attractions:[
    {name:'Jemaa el-Fna', category:'Landmark', rating:4.6, reviews:71200, priceLevel:0, price:0, area:'Medina', lat:31.6258,lng:-7.9891, desc:"A chaotic square of storytellers, musicians and food carts by night.", tags:['culture','food','photography'], duration:120},
    {name:'Majorelle Garden', category:'Garden', rating:4.6, reviews:48900, priceLevel:2, price:12, area:'Gueliz', lat:31.6412,lng:-8.0033, desc:"Cobalt-blue villa gardens once owned by Yves Saint Laurent.", tags:['nature','photography','relax'], duration:75},
    {name:'Bahia Palace', category:'History', rating:4.6, reviews:34500, priceLevel:1, price:8, area:'Medina', lat:31.6217,lng:-7.9836, desc:"A 19th-century palace of carved cedar and zellige-tiled courtyards.", tags:['history','culture','photography'], duration:75},
    {name:'Souks of Marrakech', category:'Market', rating:4.5, reviews:39800, priceLevel:1, price:0, area:'Medina', lat:31.6300,lng:-7.9870, desc:"A labyrinth of leather, lanterns, spices and rugs — haggling expected.", tags:['shopping','culture'], duration:120},
    {name:'Atlas Mountains Day Trip', category:'Adventure', rating:4.7, reviews:22100, priceLevel:3, price:55, area:'Imlil', lat:31.1360,lng:-7.9160, desc:"Berber villages and valley hikes an hour outside the city.", tags:['adventure','nature','hidden'], duration:480},
    {name:'Agafay Desert Sunset', category:'Adventure', rating:4.6, reviews:9800, priceLevel:3, price:60, area:'Agafay', lat:31.4900,lng:-8.2200, desc:"Rocky desert camp with camel rides and dinner under the stars.", tags:['adventure','romantic','photography'], duration:300},
  ],
  restaurants:[
    {name:'Nomad', cuisine:'Modern Moroccan', rating:4.6, reviews:6100, priceLevel:2, price:22, area:'Medina', lat:31.6295,lng:-7.9865, desc:"Rooftop terrace reinventing Moroccan classics with a view of the souks.", tags:['food','romantic'], dietary:['vegetarian'], hours:'12:00 PM – 11:00 PM'},
    {name:'Le Jardin', cuisine:'Moroccan', rating:4.5, reviews:4200, priceLevel:2, price:20, area:'Medina', lat:31.6280,lng:-7.9880, desc:"Leafy courtyard restaurant tucked behind an unmarked riad door.", tags:['food','hidden','relax'], dietary:['vegetarian'], hours:'9:00 AM – 11:00 PM'},
    {name:'Cafe Clock', cuisine:'Moroccan Fusion', rating:4.5, reviews:3600, priceLevel:2, price:16, area:'Medina', lat:31.6270,lng:-7.9845, desc:"Camel burgers and storytelling nights near the Kasbah.", tags:['food','culture'], dietary:['vegetarian'], hours:'9:00 AM – 10:00 PM'},
    {name:'Street Food Stalls of Jemaa el-Fna', cuisine:'Street Food', rating:4.4, reviews:15200, priceLevel:1, price:6, area:'Medina', lat:31.6258,lng:-7.9891, desc:"Grilled skewers, snail soup and fresh orange juice by lantern light.", tags:['food','nightlife'], dietary:[], hours:'6:00 PM – 12:00 AM'},
    {name:'La Mamounia Restaurant', cuisine:'Fine Dining Moroccan', rating:4.7, reviews:1800, priceLevel:4, price:90, area:'Hivernage', lat:31.6220,lng:-7.9940, desc:"Palatial garden dining inside Marrakech's most legendary hotel.", tags:['food','romantic'], dietary:[], hours:'7:00 PM – 11:00 PM'},
  ],
  hotels:[
    {name:'La Mamounia', stars:5, guestRating:9.5, price:650, area:'Hivernage', lat:31.6220,lng:-7.9940, desc:"A century-old palace hotel set in 20 acres of gardens.", amenities:['Pool','Spa','Restaurant','Free WiFi']},
    {name:'Riad Yasmine', stars:4, guestRating:9.3, price:140, area:'Medina', lat:31.6290,lng:-7.9875, desc:"Rooftop-pool riad hidden behind an unmarked medina door.", amenities:['Pool','Free WiFi','Breakfast']},
    {name:'Riad El Zohar', stars:3, guestRating:8.9, price:75, area:'Medina', lat:31.6265,lng:-7.9900, desc:"Family-run riad with home-cooked breakfast on the terrace.", amenities:['Free WiFi','Breakfast']},
    {name:'Hostel Ronda', stars:2, guestRating:8.3, price:16, area:'Gueliz', lat:31.6380,lng:-8.0090, desc:"Budget-friendly courtyard hostel in the modern district.", amenities:['Free WiFi','Shared kitchen']},
  ]
},

];

/* ---------------- Flatten into DESTINATIONS + PLACES ---------------- */
const DESTINATIONS = [];
const PLACES = [];

/* Country name -> ISO currency code, for the live currency converter. Covers every country used
   in the curated destinations plus common ones a typed-in search is likely to resolve to. */
const COUNTRY_TO_CURRENCY = {
  'japan':'JPY','france':'EUR','indonesia':'IDR','greece':'EUR','united states':'USD','united states of america':'USD',
  'italy':'EUR','thailand':'THB','spain':'EUR','new zealand':'NZD','iceland':'ISK','slovenia':'EUR','morocco':'MAD',
  'united kingdom':'GBP','germany':'EUR','portugal':'EUR','netherlands':'EUR','ireland':'EUR','austria':'EUR',
  'switzerland':'CHF','belgium':'EUR','china':'CNY','india':'INR','south korea':'KRW','korea':'KRW','canada':'CAD',
  'australia':'AUD','mexico':'MXN','brazil':'BRL','south africa':'ZAR','singapore':'SGD','vietnam':'VND',
  'philippines':'PHP','malaysia':'MYR','turkey':'TRY','egypt':'EGP','argentina':'ARS','chile':'CLP','peru':'PEN',
  'colombia':'COP','poland':'PLN','czechia':'CZK','czech republic':'CZK','hungary':'HUF','norway':'NOK','sweden':'SEK',
  'denmark':'DKK','finland':'EUR','croatia':'EUR','russia':'RUB','israel':'ILS','united arab emirates':'AED',
  'saudi arabia':'SAR','qatar':'QAR','hong kong':'HKD','romania':'RON','bulgaria':'BGN','luxembourg':'EUR',
};
/** The currency a country uses. currency-data.js carries the full ISO 3166 -> ISO 4217 map
 *  (245 countries), so this no longer answers "USD" for every country missing from a
 *  hand-written table of 58. The old table is still consulted first for the handful of
 *  historical spellings the curated destinations use. */
function currencyCodeForCountry(country, countryCode){
  const cc = String(countryCode || '').toUpperCase();
  if(cc && typeof COUNTRY_CURRENCY !== 'undefined' && COUNTRY_CURRENCY[cc]) return COUNTRY_CURRENCY[cc];
  if(!country) return 'USD';
  const key = country.trim().toLowerCase();
  const legacy = COUNTRY_TO_CURRENCY[key];
  if(legacy) return legacy;
  if(typeof COUNTRY_NAMES !== 'undefined' && typeof COUNTRY_CURRENCY !== 'undefined'){
    for(const code2 in COUNTRY_NAMES){
      if(String(COUNTRY_NAMES[code2]).toLowerCase() === key && COUNTRY_CURRENCY[code2]) return COUNTRY_CURRENCY[code2];
    }
  }
  return 'USD';
}

DESTINATIONS_RAW.forEach(d=>{
  DESTINATIONS.push({
    id:d.id, name:d.name, country:d.country, flag:d.flag, tagline:d.tagline, description:d.description,
    tags:d.tags, lat:d.lat, lng:d.lng, weather:d.weather, bestTime:d.bestTime, currency:d.currency,
    currencyCode: currencyCodeForCountry(d.country),
    language:d.language, avgDailyBudget:d.avgDailyBudget, travelInfo:d.travelInfo,
    hero: bundledPhoto('dest/'+d.id) || img(d.id+'-hero',1600,900,'')
  });

  /* Photo assignment, resolved for the whole destination at once so no two cards can show
     the same image. Marrakech used to render one identical photo on seven cards, because
     every place lacking a photo of its own fell back to the same destination-level shot.

     Claiming is what guarantees uniqueness: each image can be taken once, and a place whose
     preferred image is already spoken for simply moves to its next option. It is resolved in
     passes rather than per-place so that priority beats array order — "La Mamounia Restaurant"
     sits inside the La Mamounia hotel and both legitimately match the same building, but the
     photo of the building belongs to the hotel, and the restaurant is better served by a plate
     of what it cooks anyway. */
  const attrs = d.attractions || [], rests = d.restaurants || [], hotels = d.hotels || [];
  const used = new Set();
  const claim = src => (src && !used.has(src)) ? (used.add(src), src) : null;
  const claimedCuisines = new Set();
  const dealScene = makeSceneDealer(d.id);
  const nextScene = () => { let src; while((src = dealScene())) { const c = claim(src); if(c) return c; } return null; };

  const attrImg = new Array(attrs.length).fill(null);
  const restImg = new Array(rests.length).fill(null);
  const hotelImg = new Array(hotels.length).fill(null);

  // Pass 1 — a photo of the actual place, for the places that own it.
  attrs.forEach((p,i)=>{ attrImg[i] = claim(bundledPhotoExact(`place/${d.id}-a${i+1}`)); });
  hotels.forEach((p,i)=>{ hotelImg[i] = claim(bundledPhotoExact(`place/${d.id}-h${i+1}`)); });
  // Pass 2 — restaurants: their own photo if still free, otherwise the food they serve.
  rests.forEach((p,i)=>{
    restImg[i] = claim(bundledPhotoExact(`place/${d.id}-r${i+1}`))
              || claim(bundledCuisinePhoto(p.cuisine, claimedCuisines));
  });
  // Pass 3 — everything still unresolved gets a distinct real photo of somewhere in this
  // destination, then its own neighbourhood, then a category photo, then the name card.
  attrs.forEach((p,i)=>{ attrImg[i] = attrImg[i] || nextScene() || claim(bundledPhoto(`place/${d.id}-a${i+1}`))
                                   || claim(categoryPhoto('attraction', p.category)) || img(d.id+'-attr-'+i,640,480,p.name); });
  rests.forEach((p,i)=>{ restImg[i] = restImg[i] || nextScene() || claim(bundledPhoto(`place/${d.id}-r${i+1}`))
                                   || claim(bundledPhoto('category/restaurant')) || img(d.id+'-food-'+i,640,480,p.name); });
  hotels.forEach((p,i)=>{ hotelImg[i] = hotelImg[i] || nextScene() || claim(bundledPhoto(`place/${d.id}-h${i+1}`))
                                     || claim(hotelCategoryPhoto(p.stars)) || img(d.id+'-hotel-'+i,640,480,p.name); });

  attrs.forEach((p,i)=>PLACES.push(Object.assign({id:`${d.id}-a${i+1}`, destId:d.id, type:'attraction', source:'curated', image:attrImg[i]}, p)));
  rests.forEach((p,i)=>PLACES.push(Object.assign({id:`${d.id}-r${i+1}`, destId:d.id, type:'restaurant', source:'curated', image:restImg[i]}, p)));
  hotels.forEach((p,i)=>PLACES.push(Object.assign({id:`${d.id}-h${i+1}`, destId:d.id, type:'hotel', source:'curated', image:hotelImg[i]}, p)));
});

/* ---------------- Real-data attraction padding for long trip ideas ----------------
   A multi-day trip idea wants several attractions per day, and curated destinations only
   ship a handful of hand-written ones. Rather than inventing fake "filler" places, top up
   the pool with REAL nearby landmarks fetched live from Wikipedia's GeoSearch (the same
   source used for worldwide destination enrichment) — cached so repeat visits don't
   refetch, and always additive: curated data is never removed or replaced. If live data
   genuinely isn't available (offline, or a very obscure destination), a trip idea simply
   uses however many real places actually exist rather than padding with anything made up. */
const REAL_SUPPLEMENT_CACHE_KEY = 'tripflow_real_supplement_cache_v2';
async function ensureRealAttractionSupply(dest){
  if(!dest || dest.__supplemented || dest.__supplementing) return false;
  dest.__supplementing = true;
  try{
    const cache = readJSONCache(REAL_SUPPLEMENT_CACHE_KEY);
    let extras = cache[dest.id];
    // An empty cached result means the very first attempt found nothing — which can just as
    // easily mean "the request failed" as "there really are no more real places nearby". Only
    // treat a NON-empty cached result as settled; otherwise retry, the same rule as the photo
    // and geocode caches, so one bad network moment doesn't suppress real data forever.
    if(!extras || !extras.length){
      const pois = await fetchNearbyWikiPOIs(dest.lat, dest.lng, 40);
      const seen = new Set();
      extras = pois.filter(p=>{
        const k = p.title.toLowerCase(); if(seen.has(k)) return false; seen.add(k); return true;
      }).slice(0,30).map(p=>{
        const firstSentence = (p.extract||'').split(/(?<=[.!?])\s/)[0];
        return {
          name: p.title, category: inferCategoryFromExtract(p.extract),
          // No invented rating, review count or price: these are places pulled from a live
          // geo search, and the app has no real figures for them. A null reads as "unknown"
          // in the UI; a hash-derived 4.3 reads as a fact the traveler can rely on.
          rating: null, reviews: null, priceLevel: null, price: null,
          area: dest.name, lat: p.lat, lng: p.lng,
          desc: (firstSentence || `A notable landmark near ${dest.name}.`).slice(0,160),
          tags: inferTagsFromExtract(p.extract), duration:75, photo: p.image || null,
        };
      });
      if(extras.length){ cache[dest.id] = extras; writeJSONCache(REAL_SUPPLEMENT_CACHE_KEY, cache); }
    }
    dest.__supplemented = true;
    if(!extras.length) return false;
    const existingNames = new Set(PLACES.filter(p=>p.destId===dest.id).map(p=>p.name.toLowerCase()));
    const toAdd = extras.filter(p=>!existingNames.has(p.name.toLowerCase()));
    toAdd.forEach((p,i)=>PLACES.push({
      id:`${dest.id}-s${i+1}`, destId:dest.id, type:'attraction', source:'live',
      name:p.name, category:p.category, rating:p.rating, reviews:p.reviews,
      priceLevel:p.priceLevel, price:p.price, area:p.area, lat:p.lat, lng:p.lng,
      desc:p.desc, tags:p.tags, duration:p.duration,
      image: p.photo || img(dest.id+'-suppl-'+i,640,480,p.name),
    }));
    return toAdd.length>0;
  }catch(e){ return false; }
  finally{ dest.__supplementing = false; }
}

/* ---------------- Generic fallback destination generator ---------------- */
function seededRandom(seedStr){
  let h = 1779033703 ^ seedStr.length;
  for(let i=0;i<seedStr.length;i++){ h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return function(){
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
const GENERIC_DEST_NAME_CACHE_KEY = 'tripflow_generic_dest_names_v1';
/** Generic destinations only live in memory — a page reload starts DESTINATIONS fresh from the
 * curated list. Without this, resolving a URL like #/destination/gen-beijing after a reload (very
 * common on mobile Safari, which reloads backgrounded tabs) would have nothing to recover the
 * original typed name from, and would wrongly treat the raw id/slug itself as the destination name. */
function rememberGenericDestName(id, name, geo){
  const cache = readJSONCache(GENERIC_DEST_NAME_CACHE_KEY);
  // Stored as an object so a reload recovers the real coordinates and country too; the old
  // format was a bare string, which is still read below for anything cached before this.
  cache[id] = geo ? { name, geo } : { name };
  writeJSONCache(GENERIC_DEST_NAME_CACHE_KEY, cache);
}
function recallGenericDestName(id){
  const hit = readJSONCache(GENERIC_DEST_NAME_CACHE_KEY)[id];
  if(!hit) return null;
  return typeof hit === 'string' ? hit : hit.name;      // tolerate the pre-v2 bare-string form
}
function recallGenericDestGeo(id){
  const hit = readJSONCache(GENERIC_DEST_NAME_CACHE_KEY)[id];
  return (hit && typeof hit === 'object' && hit.geo) ? hit.geo : null;
}
/** Upgrades a destination that was created before its real geography was known. */
/* ---------------- Calendar arithmetic: one source of truth ----------------
 *
 * Two bugs lived here, and both were invisible in a UTC test environment.
 *
 * 1. Trip length came from whichever code path happened to build the days. A trip created from
 *    a trip idea took its length from the IDEA rather than the dates the traveller picked, so
 *    choosing 24-29 September and tapping a two-day idea produced a two-day itinerary. The end
 *    date was captured correctly all along; nothing read it.
 *
 * 2. `addDays` built LOCAL midnight and then formatted through toISOString(), which is UTC. At
 *    or east of UTC that lands on the previous day: addDays('2026-09-24', 0) returned
 *    2026-09-23 in Seoul, Kuala Lumpur, Auckland — and in London on summer time. Every day tab
 *    was labelled a day early for a large share of the world.
 *
 * All calendar arithmetic below is done in UTC, where a day is always exactly 86400000 ms and
 * no daylight-saving transition can add or remove one. A date-only string is a calendar date,
 * not an instant, so it should never have been passed through a local-time constructor. */

/** 'YYYY-MM-DD' (or a Date) -> UTC midnight in ms. NaN when it cannot be read as a date. */
function parseDateOnly(value){
  if(value instanceof Date){
    return isNaN(value.getTime()) ? NaN
      : Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value == null ? '' : value).trim());
  if(m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(value);
  return isNaN(d.getTime()) ? NaN
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** A calendar date as 'YYYY-MM-DD'. */
function toDateInput(value){
  const ms = parseDateOnly(value);
  if(isNaN(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/** n days after a calendar date. n may be negative. */
function addDays(dateStr, n){
  const ms = parseDateOnly(dateStr);
  if(isNaN(ms)) return '';
  return new Date(ms + (Number(n) || 0) * 86400000).toISOString().slice(0, 10);
}

/* A trip longer than this is a data-entry slip, not a holiday. Without a cap, one mistyped year
 * asks the browser to build 365,000 day tabs and the tab stops responding. */
const TRIP_MAX_DAYS = 365;

/** THE trip length, in days, counted the way a traveller counts: leaving on the 24th and
 *  returning on the 29th is six days. Every day tab, itinerary, route, schedule and budget in
 *  the app derives from this one function, so they can never disagree with each other. */
function tripDurationDays(start, end){
  const a = parseDateOnly(start), b = parseDateOnly(end);
  if(isNaN(a) && isNaN(b)) return 1;
  if(isNaN(a) || isNaN(b)) return 1;
  const days = Math.round((b - a) / 86400000) + 1;
  if(!isFinite(days) || days < 1) return 1;      // an end before the start is not a negative trip
  return Math.min(days, TRIP_MAX_DAYS);
}

/** The calendar date of every day in the trip, in order. */
function tripDayDates(start, count){
  const n = Math.max(1, Math.min(Number(count) || 1, TRIP_MAX_DAYS));
  const out = [];
  for(let i = 0; i < n; i++) out.push(addDays(start, i));
  return out;
}

/** Forces a trip's `days` array to match its own dates: adds missing days, drops extra ones and
 *  re-dates them all in order. Existing stops are preserved. Anything that changes a trip's
 *  dates calls this, so a trip cannot drift out of agreement with itself. */
function normalizeTripDays(trip){
  if(!trip) return trip;
  const wanted = tripDurationDays(trip.start, trip.end);
  if(!Array.isArray(trip.days)) trip.days = [];
  while(trip.days.length < wanted) trip.days.push({ date: '', stops: [] });
  if(trip.days.length > wanted) trip.days.length = wanted;
  const dates = tripDayDates(trip.start, wanted);
  trip.days.forEach((d, i) => {
    d.date = dates[i];
    if(!Array.isArray(d.stops)) d.stops = [];
  });
  // Keep the end date consistent with the number of days actually held.
  trip.end = dates[dates.length - 1];
  return trip;
}

/* ---------------- Geographic integrity ----------------
 * Rule 1 of the spec: never use a destination name alone; always use canonical ID +
 * coordinates. These are the guards every map, route and place list has to pass through. */

/** Kilometres between two {lat,lng} points. */
function geoDistanceKm(a, b){
  if(!a || !b || a.lat==null || a.lng==null || b.lat==null || b.lng==null) return Infinity;
  const R = 6371, toRad = d => d*Math.PI/180;
  const dLat = toRad(b.lat-a.lat), dLng = toRad(b.lng-a.lng);
  const h = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True only when this destination's position came from a verified geocode. Everything that
 *  draws a map, plots a route or validates a place MUST check this first. */
function hasVerifiedGeo(dest){
  return !!(dest && dest.lat != null && dest.lng != null &&
            isFinite(dest.lat) && isFinite(dest.lng) &&
            Math.abs(dest.lat) <= 90 && Math.abs(dest.lng) <= 180 &&
            (dest.geoVerified !== false));
}

/** How far from the centre a place can plausibly still be "in" this destination. A village and
 *  a country are both destinations but they are not the same size, so a single radius would
 *  either exile half of London or accept a restaurant 300 km from a hamlet. */
const DEST_RADIUS_KM = {
  continent: 3000, country: 900, state: 350, region: 350, province: 350, county: 90,
  island: 120, city: 30, municipality: 30, town: 14, village: 8, hamlet: 6,
  suburb: 6, neighbourhood: 4, district: 10, locality: 8,
  attraction: 3, landmark: 3, museum: 2, building: 2, station: 3,
};
function destinationRadiusKm(dest){
  const t = String((dest && (dest.placeType || dest.type)) || '').toLowerCase();
  return DEST_RADIUS_KM[t] || 30;
}

/** Rule 3: every place must belong to the destination context. Rule 4: if a place is thousands
 *  of kilometres away, reject it. This is what stops a Seoul itinerary listing Spanish stops.
 *
 *  Three tests, strongest first, because no single one is right for every scale of destination:
 *    1. Country code. Decisive when both sides know theirs — Seoul is not in Japan no matter
 *       what the geometry says.
 *    2. Boundary box from the geocoder. Real data and much tighter than a circle for anywhere
 *       long and thin (Chile, Norway, Japan). Note that country boxes genuinely overlap —
 *       Seoul sits inside Japan's — which is why the code above it is checked first.
 *    3. Radius. The fallback when we know nothing but a centre point. */
function placeWithinDestination(place, dest){
  if(!hasVerifiedGeo(dest)) return false;
  if(!place || place.lat == null || place.lng == null) return false;

  const placeCC = String(place.countryCode || '').toUpperCase();
  const destCC  = String(dest.countryCode || '').toUpperCase();
  if(placeCC && destCC && placeCC !== destCC) return false;

  const box = dest.bbox;
  if(box && box.minLat != null){
    // A small tolerance so a place right on the boundary is not exiled by rounding.
    const padLat = 0.02, padLng = 0.02;
    const inBox = place.lat >= box.minLat - padLat && place.lat <= box.maxLat + padLat &&
                  place.lng >= box.minLng - padLng && place.lng <= box.maxLng + padLng;
    if(!inBox) return false;
    // Inside the box AND within a sane distance: for a country the box is the real test, but a
    // city's box should not let in somewhere 200 km away just because the box is generous.
    return geoDistanceKm(place, dest) <= destinationRadiusKm(dest) * 3;
  }

  return geoDistanceKm(place, dest) <= destinationRadiusKm(dest) * 1.25;
}

function applyGeoToDestination(dest, geo){
  if(!dest || !geo) return dest;
  if(geo.lat != null && geo.lng != null){ dest.lat = geo.lat; dest.lng = geo.lng; dest.geoVerified = true; }
  if(geo.country){
    dest.country = geo.country;
    dest.currencyCode = currencyCodeForCountry(geo.country, geo.countryCode);
    dest.currency = `Local currency (${dest.currencyCode})`;
  }
  if(geo.countryCode) dest.countryCode = geo.countryCode;
  if(geo.bbox) dest.bbox = geo.bbox;
  if(geo.flag) dest.flag = geo.flag;
  if(geo.region) dest.region = geo.region;
  if(geo.type) dest.placeType = geo.type;
  if(geo.displayName) dest.displayName = geo.displayName;
  if(geo.placeId) dest.placeId = geo.placeId;
  dest.__geo = true;
  // Now that the position is verified, real places can be discovered around it. Before this
  // point there was nowhere to search, which is exactly why nothing was invented.
  if(hasVerifiedGeo(dest) && typeof discoverPlacesFor === 'function') discoverPlacesFor(dest);
  return dest;
}
/** Builds a destination for anywhere on Earth.
 *
 * `geo` is the structured result from geo.js (name, country, countryCode, coordinates, type).
 * When it is present the destination starts life with its REAL position, country and flag.
 * Without it the coordinates were seeded from a hash of the name — a deterministic point
 * somewhere random on the globe — so the map pointed at open ocean until the background
 * enrichment happened to fix it. That fallback still exists for a bare typed string, but a
 * destination chosen from search no longer goes through it. */
function makeGenericDestination(name, geo){
  const clean = titleCaseDestName((geo && geo.name) || name.split(',')[0].trim() || name.trim());
  const id = 'gen-'+slugify(clean); // derive the id from the cleaned name (not the raw ", Country" text) so recovering a
  const existing = DESTINATIONS.find(d=>d.id===id);            // remembered name after a reload always reproduces the same id
  if(existing){
    if(geo && !existing.__geo) applyGeoToDestination(existing, geo);
    return existing;
  }
  rememberGenericDestName(id, clean, geo);
  const rnd = seededRandom(id);
  // GEOGRAPHIC INTEGRITY (non-negotiable): a destination's position comes from a verified
  // geocode, or it does not exist. The old fallback seeded lat/lng from a hash of the name,
  // which put "Seoul Korea" at 36.859,-5.346 — a hillside in Andalusia — and the map, the
  // route and every generated place then faithfully rendered Spain. An invented coordinate is
  // worse than an absent one: a missing map says "unverified", a wrong map lies. null means
  // unverified, and everything downstream is required to check before it draws.
  const base = (geo && geo.lat != null && geo.lng != null)
    ? { lat: geo.lat, lng: geo.lng }
    : null;
  const dest = {
    id, name:clean,
    placeId: (geo && geo.placeId) || null,   // canonical identity; everything else derives from it
    country: (geo && geo.country) || '',
    countryCode: (geo && geo.countryCode) || '',
    region: (geo && geo.region) || '',
    placeType: (geo && geo.type) || '',
    displayName: (geo && geo.displayName) || clean,
    bbox: (geo && geo.bbox) || null,
    __geo: !!geo,
    flag: (geo && geo.flag) || '🌍',
    tagline: (geo && geo.context)
      ? `${geo.typeLabel || 'Destination'} in ${geo.context} — attractions, food and stays for your trip.`
      : `Discover ${clean} — attractions, food and stays curated for your trip.`,
    description:`${clean} is ready to explore. We've put together a starter set of top-rated attractions, restaurants and places to stay while you fine-tune your plan.`,
    tags:['trending'], lat: base ? base.lat : null, lng: base ? base.lng : null,
    geoVerified: !!base,
    weather:"Check seasonal averages closer to your travel dates.",
    bestTime:"Year-round — varies by season",
    currency: (geo && geo.country) ? `Local currency (${currencyCodeForCountry(geo.country, geo.countryCode)})` : "Local currency",
    currencyCode: (geo && geo.country) ? currencyCodeForCountry(geo.country, geo.countryCode) : 'USD',
    language:"Local language",
    avgDailyBudget:{budget:50,moderate:120,luxury:280},
    travelInfo:{ recommendedDays:'3–5 days', timezone:"Check your device's clock once you arrive",
      visa:"Entry requirements vary by nationality — check your country's foreign ministry site before you go.",
      safety:'Follow standard travel precautions: keep valuables secure, stay aware in crowds, and check current advisories.',
      localTransport:'Local transit options vary — ride-hailing apps and local buses/taxis are usually available.',
      etiquette:'Research local customs and dress norms before you go — they vary widely by region.' },
    __enriched:false, __enriching:false,
    hero: img(id+'-hero',1600,900,'')
  };
  DESTINATIONS.push(dest);
  // Every generated card gets a DIFFERENT stock photograph. Six restaurants previously shared
  // three images and four hotels shared two, so a typed-in destination looked like a page of
  // repeats — the same claim-once rule the curated destinations use.
  // Places are DISCOVERED, not invented. This block used to push six restaurants with made-up
  // names ("Market Street Kitchen"), made-up ratings (4.2+rnd()*0.6), made-up review counts and
  // made-up coordinates (base +/- 0.03). None of it was real, and the star ratings in
  // particular read as genuine review data. Real entities now come from OpenStreetMap through
  // places.js, keyed to this destination's verified coordinates; until they arrive the
  // destination simply has no places, which is the honest state.
  if(typeof discoverPlacesFor === 'function') discoverPlacesFor(dest);
  return dest;
}

/** Resolves a typed string to a destination. `geo` is the structured search result when the
 *  user picked a suggestion, which is what lets a brand-new destination arrive complete. */
function findDestination(query, geo){
  if(!query) return null;
  const q = query.trim().toLowerCase();
  if(!q) return null;
  let d = DESTINATIONS.find(x=> x.name.toLowerCase()===q || `${x.name}, ${x.country}`.toLowerCase()===q);
  if(d) return d;
  d = DESTINATIONS.find(x=> x.name.toLowerCase().includes(q) || q.includes(x.name.toLowerCase()) || x.country.toLowerCase().includes(q));
  if(d) return d;
  return makeGenericDestination(query, geo);
}

/** Resolve a destination strictly by its stable id (from a URL hash, a saved trip, etc.) —
 * never by treating the id/slug itself as a human search query. A generic destination only
 * lives in memory, so after a reload (very common on mobile Safari backgrounding a tab) it
 * won't be in DESTINATIONS yet; recover its real typed name from the persisted cache before
 * recreating it, rather than falling through to findDestination(id) which would corrupt the
 * name into the raw id string (e.g. "gen-beijing") and send that literal text to geocoding. */
function resolveDestFromId(id){
  if(!id) return null;
  let d = DESTINATIONS.find(x=>x.id===id);
  if(d) return d;
  if(id.indexOf('gen-')===0){
    const remembered = recallGenericDestName(id);
    // Restore the remembered geography too, so a reloaded destination keeps its real
    // coordinates and flag instead of falling back to the hash-seeded placeholder position.
    if(remembered) return makeGenericDestination(remembered, recallGenericDestGeo(id));
    // last resort: de-slugify so we at least show a readable name instead of the raw id
    return makeGenericDestination(id.slice(4).replace(/-/g,' '));
  }
  return findDestination(id);
}

function placesFor(destId, type){ return PLACES.filter(p=>p.destId===destId && (!type || p.type===type)); }
function placeById(id){ return PLACES.find(p=>p.id===id); }
