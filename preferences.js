/* ============================================================================
 * preferences.js — what the traveller actually wants, and how that changes the itinerary.
 *
 * The rule this file exists to honour: asking a question and then ignoring the answer is worse
 * than not asking. Every option below maps to concrete evidence on a place — OSM subtypes,
 * cuisines, diet tags, category labels, price signals — so choosing "Hiking" really does pull
 * trailheads and viewpoints up the list and push nightclubs down, rather than tinting a badge.
 *
 * Preferences are scored, never used as hard filters, with two exceptions the traveller stated
 * outright: a must-avoid is a hard exclusion, and a must-see is pinned in. Everything else is a
 * lean, because a filter on sparse map data empties a page and a lean just reorders it.
 * ========================================================================== */

/* ---------------- interests ---------------- */

/* key, emoji, label, and the evidence that a place serves this interest.
 *   subtypes  — OSM amenity/tourism/leisure/historic values (discovered places)
 *   tags      — the curated catalogue's own tags
 *   cuisines  — for food-shaped interests
 *   words     — matched against the place name and category as a last resort
 * A place needs only one hit to count; the score rises with the number of interests it serves. */
const TRIP_INTERESTS = [
  {key:'history',    emoji:'🏛️', label:'History & Culture',
   subtypes:['castle','monument','memorial','ruins','archaeological_site','palace','city_gate','fort','tower','museum'],
   tags:['history','culture'], words:['heritage','historic','ancient','old town','temple','shrine','cathedral','church','mosque']},
  {key:'food',       emoji:'🍜', label:'Food & Local Cuisine',
   subtypes:['restaurant','food_court','deli','biergarten'], tags:['food'],
   words:['market','food hall','izakaya','taverna','bistro']},
  {key:'city',       emoji:'🏙️', label:'City Exploration',
   subtypes:['attraction','viewpoint','city_gate','tower'], tags:['culture','photography'],
   words:['square','plaza','district','quarter','promenade','skyline']},
  {key:'beach',      emoji:'🏖️', label:'Beaches',
   subtypes:['beach_resort','beach'], tags:['relax','nature'], words:['beach','bay','shore','cove','lagoon','strand']},
  {key:'nature',     emoji:'🌲', label:'Nature',
   subtypes:['park','garden','nature_reserve','viewpoint','picnic_site'], tags:['nature'],
   words:['park','garden','forest','lake','falls','river','botanical']},
  {key:'hiking',     emoji:'🥾', label:'Hiking',
   subtypes:['viewpoint','nature_reserve','alpine_hut','peak'], tags:['adventure','nature'],
   words:['trail','hike','summit','peak','mount','ridge','gorge','canyon']},
  {key:'themepark',  emoji:'🎢', label:'Theme Parks',
   subtypes:['theme_park','zoo','aquarium'], tags:['adventure'], words:['park','world','land','adventure']},
  {key:'shopping',   emoji:'🛍️', label:'Shopping',
   subtypes:['marketplace','mall','department_store'], tags:['shopping'],
   words:['market','bazaar','souk','mall','arcade','boutique','shopping']},
  {key:'nightlife',  emoji:'🌃', label:'Nightlife',
   subtypes:['bar','pub','nightclub','biergarten'], tags:['nightlife'],
   words:['bar','club','lounge','rooftop','live music','jazz']},
  {key:'photography', emoji:'📸', label:'Photography',
   subtypes:['viewpoint','artwork','attraction'], tags:['photography'],
   words:['viewpoint','lookout','panorama','观景','vista','overlook']},
  {key:'art',        emoji:'🎨', label:'Art & Museums',
   subtypes:['gallery','museum','artwork'], tags:['art','culture'],
   words:['gallery','museum','art','exhibition','atelier']},
  {key:'wellness',   emoji:'🧘', label:'Wellness & Relaxation',
   subtypes:['spa','garden','park','public_bath'], tags:['relax'],
   words:['spa','onsen','hammam','thermal','bath','sauna','yoga','retreat']},
  {key:'adventure',  emoji:'🏔️', label:'Adventure',
   subtypes:['viewpoint','nature_reserve','peak','alpine_hut'], tags:['adventure'],
   words:['adventure','rafting','diving','climb','zip','safari','kayak']},
  {key:'family',     emoji:'👨‍👩‍👧', label:'Family Activities',
   subtypes:['zoo','aquarium','theme_park','park','playground','picnic_site'], tags:['family'],
   words:['zoo','aquarium','playground','family','children','science centre','science center']},
  {key:'romantic',   emoji:'💕', label:'Romantic Experiences',
   subtypes:['viewpoint','garden','restaurant'], tags:['romantic'],
   words:['sunset','viewpoint','garden','rooftop','canal','old town']},
  {key:'entertainment', emoji:'🎭', label:'Entertainment & Shows',
   subtypes:['theatre','cinema','arts_centre','concert_hall'], tags:['culture'],
   words:['theatre','theater','opera','concert','show','cinema','stage']},
  {key:'sports',     emoji:'⚽', label:'Sports',
   subtypes:['stadium','sports_centre','pitch','swimming_pool'], tags:['adventure'],
   words:['stadium','arena','sports','olympic','racecourse','golf']},
  {key:'cafes',      emoji:'☕', label:'Cafés',
   subtypes:['cafe','bakery','ice_cream'], tags:['food'], cuisines:['coffee_shop','cafe','bakery','dessert'],
   words:['coffee','café','cafe','espresso','roaster','tea house','patisserie']},
  {key:'hidden',     emoji:'🏘️', label:'Hidden Gems',
   subtypes:[], tags:['hidden'], words:['hidden','secret','local','tucked','backstreet','lesser']},
  {key:'festivals',  emoji:'🎉', label:'Festivals & Events',
   subtypes:['events_venue','community_centre','marketplace'], tags:['culture'],
   words:['festival','fair','carnival','market','parade','matsuri']},
];

const TRIP_INTEREST_KEYS = TRIP_INTERESTS.map(i => i.key);

/* ---------------- pace, budget, timing, party ---------------- */

/* Activities per day, excluding meals. These are what "Relaxed" and "Packed" actually mean.
 * `max` is a ceiling, never a quota: a day is not padded with weak places to reach it. */
/* `targetStops` counts EVERYTHING on the day — a coffee, a market, a viewpoint and dinner are
 * each a real part of a day out, not filler. A day of six that a person could actually walk is
 * worth more than ten scattered across a city, so `max` and the travel budget are the brakes:
 * the target is aimed for, never forced. */
const TRIP_PACE = {
  relaxed:  {key:'relaxed',  emoji:'🐢', label:'Relaxed',  sub:'Fewer stops, more time at each',
             targetStops:5, activities:3, max:7,  mealsPerDay:2, cafesPerDay:1,
             minutesPerStop:110, maxTravelKmPerDay:14},
  balanced: {key:'balanced', emoji:'🚶', label:'Balanced', sub:'A comfortable mix of sights and rest',
             targetStops:7, activities:4, max:9,  mealsPerDay:2, cafesPerDay:1,
             minutesPerStop:85,  maxTravelKmPerDay:22},
  packed:   {key:'packed',   emoji:'⚡', label:'Packed',   sub:'More to see, still realistic',
             targetStops:9, activities:6, max:11, mealsPerDay:2, cafesPerDay:2,
             minutesPerStop:65,  maxTravelKmPerDay:32},
};

const TRIP_BUDGET = {
  budget:   {key:'budget',   emoji:'💵', label:'Budget',   sub:'Free sights, street food, hostels',
             priceLevels:[0,1], stars:[1,2,3], splurgesPerTrip:1},
  moderate: {key:'moderate', emoji:'💰', label:'Moderate', sub:'A comfortable middle',
             priceLevels:[0,1,2,3], stars:[2,3,4], splurgesPerTrip:2},
  luxury:   {key:'luxury',   emoji:'💎', label:'Luxury',   sub:'Fine dining and standout stays',
             priceLevels:[2,3,4], stars:[4,5], splurgesPerTrip:99},
  custom:   {key:'custom',   emoji:'🎯', label:'Custom',   sub:'Set your own daily budget',
             priceLevels:[0,1,2,3,4], stars:[1,2,3,4,5], splurgesPerTrip:2},
};

const FOOD_PREFERENCES = [
  {key:'local',      label:'Local cuisine',      match:{localCuisine:true}},
  {key:'street',     label:'Street food',        match:{subtypes:['fast_food','food_court'], priceLevels:[0,1]}},
  {key:'fine',       label:'Fine dining',        match:{priceLevels:[3,4], subtypes:['restaurant']}},
  {key:'vegetarian', label:'Vegetarian-friendly',match:{diet:'vegetarian'}},
  {key:'vegan',      label:'Vegan-friendly',     match:{diet:'vegan'}},
  {key:'halal',      label:'Halal',              match:{diet:'halal'}},
  {key:'kosher',     label:'Kosher',             match:{diet:'kosher'}},
  {key:'seafood',    label:'Seafood',            match:{cuisines:['seafood','fish']}},
  {key:'cafes',      label:'Cafés',              match:{subtypes:['cafe','bakery']}},
  {key:'desserts',   label:'Desserts',           match:{subtypes:['ice_cream','bakery'], cuisines:['dessert','ice_cream','cake']}},
];

/* The first activity of the day starts here. A late starter is never given a 07:00 stop. */
const DAY_START = {
  early:  {key:'early',  emoji:'🌅', label:'Early bird',     sub:'Out by 7am',      hour:7,  lastHour:20},
  normal: {key:'normal', emoji:'☀️', label:'Normal morning', sub:'Going by 9am',    hour:9,  lastHour:21},
  late:   {key:'late',   emoji:'😴', label:'Late start',     sub:'Nothing before 11am', hour:11, lastHour:23},
  any:    {key:'any',    emoji:'🕐', label:'No preference',  sub:'Whatever suits the day', hour:9, lastHour:21},
};

const TRAVEL_PARTY = {
  solo:     {key:'solo',     label:'Solo',                favours:['hidden','photography','cafes'], avoids:[]},
  couple:   {key:'couple',   label:'Couple',              favours:['romantic','food','wellness'],   avoids:[]},
  friends:  {key:'friends',  label:'Friends',             favours:['nightlife','food','adventure'], avoids:[]},
  family:   {key:'family',   label:'Family',              favours:['family','nature','city'],       avoids:['nightlife']},
  children: {key:'children', label:'Family with children',favours:['family','themepark','nature'],  avoids:['nightlife'],
             maxStopMinutes:90, gentlerPace:true},
  seniors:  {key:'seniors',  label:'Seniors',             favours:['history','art','wellness'],     avoids:['hiking','adventure'],
             gentlerPace:true},
  business: {key:'business', label:'Business',            favours:['city','food','cafes'],          avoids:['themepark','hiking']},
};

/* ---------------- the preference record ---------------- */

function defaultTripPreferences(){
  return {
    interests: [],           // keys from TRIP_INTERESTS
    pace: 'balanced',
    budget: 'moderate',
    customDailyBudget: null, // only when budget === 'custom'
    food: [],                // keys from FOOD_PREFERENCES
    dayStart: 'any',
    party: 'couple',
    mustSee: [],             // free text, resolved against real places before use
    mustAvoid: [],           // keys and free text
  };
}

/** Fills in anything missing and drops anything unrecognised, so a preference record saved by an
 *  older build can never crash a newer generator. */
function normalizeTripPreferences(prefs){
  const d = defaultTripPreferences();
  const p = Object.assign(d, prefs || {});
  p.interests = (p.interests || []).filter(k => TRIP_INTEREST_KEYS.includes(k));
  p.food = (p.food || []).filter(k => FOOD_PREFERENCES.some(f => f.key === k));
  if(!TRIP_PACE[p.pace]) p.pace = 'balanced';
  if(!TRIP_BUDGET[p.budget]) p.budget = 'moderate';
  if(!DAY_START[p.dayStart]) p.dayStart = 'any';
  if(!TRAVEL_PARTY[p.party]) p.party = 'couple';
  p.mustSee = (p.mustSee || []).map(s => String(s).trim()).filter(Boolean).slice(0, 12);
  p.mustAvoid = (p.mustAvoid || []).map(s => String(s).trim()).filter(Boolean).slice(0, 12);
  return p;
}

const PREFS_STORAGE_KEY = 'tf:prefs:v1';

function saveTripPreferences(prefs){
  try{ localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(normalizeTripPreferences(prefs))); }
  catch(e){ /* a preference that fails to persist is still usable this session */ }
}
function loadTripPreferences(){
  try{
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    return normalizeTripPreferences(raw ? JSON.parse(raw) : null);
  }catch(e){ return defaultTripPreferences(); }
}

/* ---------------- matching a place against preferences ---------------- */

/** Whole-word (or whole-phrase) containment, accent- and script-safe enough for place names.
 *  Word characters are Unicode letters and digits, so this works for non-Latin names too. */
function hasWholeWord(haystack, needle){
  const n = String(needle || '').toLowerCase().trim();
  if(!n) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try{
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'u').test(haystack);
  }catch(e){
    // Older engines without Unicode property escapes.
    return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(haystack);
  }
}

function prefText(place){
  return [place.name, place.category, place.cuisine, place.subtype, (place.tags || []).join(' '),
          place.desc].filter(Boolean).join(' ').toLowerCase();
}

/** Does this place serve this interest? One piece of real evidence is enough. */
function placeServesInterest(place, interest){
  if(!place || !interest) return false;
  const sub = String(place.subtype || '').toLowerCase();
  if(interest.subtypes && interest.subtypes.includes(sub)) return true;
  const tags = (place.tags || []).map(t => String(t).toLowerCase());
  if(interest.tags && interest.tags.some(t => tags.includes(t))) return true;
  if(interest.cuisines){
    const cuisine = String(place.cuisine || '').toLowerCase();
    if(interest.cuisines.some(c => cuisine.includes(c))) return true;
  }
  if(interest.words){
    const hay = prefText(place);
    // Whole words only. A plain substring test matched "art" inside "Ridge Trail Start" and
    // scored a trailhead as an art destination. Multi-word terms ("old town", "live music")
    // still work because only the outer edges are anchored.
    if(interest.words.some(w => hasWholeWord(hay, w))) return true;
  }
  return false;
}

/** How many of the traveller's chosen interests this place serves. */
function interestHits(place, prefs){
  const chosen = TRIP_INTERESTS.filter(i => (prefs.interests || []).includes(i.key));
  return chosen.filter(i => placeServesInterest(place, i)).map(i => i.key);
}

function matchesFoodPreference(place, foodKey){
  const f = FOOD_PREFERENCES.find(x => x.key === foodKey);
  if(!f) return false;
  const m = f.match, sub = String(place.subtype || '').toLowerCase();
  const cuisine = String(place.cuisine || '').toLowerCase();
  if(m.diet && (place.dietary || []).includes(m.diet)) return true;
  if(m.subtypes && m.subtypes.includes(sub)) return true;
  if(m.cuisines && m.cuisines.some(c => cuisine.includes(c))) return true;
  if(m.priceLevels && place.priceLevel != null && m.priceLevels.includes(place.priceLevel)) return true;
  // "Local cuisine" means the country's own food, which we can only claim when the data says so.
  if(m.localCuisine && place.__localCuisine) return true;
  return false;
}

/** A must-avoid is the one preference treated as a hard rule: the traveller said no.
 *  Matches an interest key ("no museums" via the art/history vocabulary) or plain words. */
function isAvoided(place, prefs){
  const avoid = prefs.mustAvoid || [];
  const hay = prefText(place);
  for(const raw of avoid){
    const term = String(raw).toLowerCase().replace(/^(no|avoid|skip)\s+/, '').trim();
    if(!term) continue;
    if(hay.includes(term)) return true;
    // Let an avoid term name a whole interest: "museums" removes the museum subtypes too.
    const interest = TRIP_INTERESTS.find(i =>
      i.key === term || i.label.toLowerCase().includes(term) ||
      (i.words || []).some(w => w === term) || (i.subtypes || []).includes(term.replace(/s$/, '')));
    if(interest && placeServesInterest(place, interest)) return true;
  }
  // A party that avoids a whole category — children and nightlife — is the same kind of rule.
  const party = TRAVEL_PARTY[prefs.party];
  if(party && party.avoids && party.avoids.length){
    for(const key of party.avoids){
      const i = TRIP_INTERESTS.find(x => x.key === key);
      // Only exclude when the traveller did not ask for it themselves.
      if(i && !(prefs.interests || []).includes(key) && placeServesInterest(place, i)) return true;
    }
  }
  return false;
}

/** Did the traveller name this place outright? Compared loosely, because they type "Eiffel
 *  Tower" and the data says "Tour Eiffel". */
function isMustSee(place, prefs){
  const want = prefs.mustSee || [];
  if(!want.length) return false;
  const name = String(place.name || '').toLowerCase();
  const local = String(place.localName || '').toLowerCase();
  return want.some(raw => {
    const t = String(raw).toLowerCase().trim();
    if(!t) return false;
    return name.includes(t) || t.includes(name) || (local && (local.includes(t) || t.includes(local)));
  });
}

function budgetFits(place, prefs){
  const b = TRIP_BUDGET[prefs.budget] || TRIP_BUDGET.moderate;
  if(place.priceLevel != null) return b.priceLevels.includes(place.priceLevel);
  if(place.stars != null) return b.stars.includes(place.stars);
  return true;   // unpriced is not a mismatch; most OSM places have no price at all
}

/** The preference component of a place's score. Added to placeQualityScore, never replacing it —
 *  a place still has to be good, this decides whether it is good FOR THIS TRAVELLER.
 *  Returns -Infinity for an avoided place so it can never appear. */
function preferenceScore(place, prefs){
  if(!place) return 0;
  const p = normalizeTripPreferences(prefs);
  if(isAvoided(place, p)) return -Infinity;
  if(isMustSee(place, p)) return 1000;          // pinned: the traveller asked for it by name

  let score = 0;
  const hits = interestHits(place, p);
  // Diminishing returns: serving three interests is better than one, but not three times better,
  // or a single place that ticks every box would crowd out the variety the trip needs.
  score += hits.length ? 14 + (hits.length - 1) * 5 : 0;

  // The travel party leans the list without overriding what was explicitly chosen.
  const party = TRAVEL_PARTY[p.party];
  if(party && party.favours){
    for(const key of party.favours){
      const i = TRIP_INTERESTS.find(x => x.key === key);
      if(i && placeServesInterest(place, i)){ score += 4; break; }
    }
  }

  let explicitFoodMatch = false;
  if(place.type === 'restaurant' && p.food.length){
    const matched = p.food.filter(k => matchesFoodPreference(place, k)).length;
    if(matched){ score += 20 + (matched - 1) * 5; explicitFoodMatch = true; }
  }

  if(budgetFits(place, p)) score += 6;
  // A budget mismatch is discouraged, never forbidden — and an explicit food request outranks
  // an unchanged budget default: ticking "fine dining" says the traveller will spend on dinner.
  else score -= explicitFoodMatch ? 4 : 10;

  return score;
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    TRIP_INTERESTS, TRIP_INTEREST_KEYS, TRIP_PACE, TRIP_BUDGET, FOOD_PREFERENCES, DAY_START,
    TRAVEL_PARTY, defaultTripPreferences, normalizeTripPreferences, saveTripPreferences,
    loadTripPreferences, placeServesInterest, interestHits, matchesFoodPreference, isAvoided,
    isMustSee, budgetFits, preferenceScore,
  };
}
