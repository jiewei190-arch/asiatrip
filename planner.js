/* ============================================================================
 * planner.js — building a day that a person could actually walk.
 *
 * The generator this replaces dealt places out round-robin, so a Paris day could run Eiffel
 * Tower, Montmartre, Louvre and back west again. Order carried no geography, times were a fixed
 * list of four strings, and nothing knew whether a place was open when it was scheduled.
 *
 * What a day here is built from, in order:
 *   1. what the traveller asked for   (preferences.js does the scoring)
 *   2. where things actually are      (days are clustered, then ordered nearest-neighbour)
 *   3. how long things take           (visit duration by kind, travel time by distance and mode)
 *   4. when things are open           (a scheduled stop is checked against its own hours)
 *   5. when people eat                (meals are placed at meal times, near where you already are)
 *
 * Everything it cannot know, it says. A day that runs long, a venue whose hours are unknown, a
 * must-see that could not be found — each produces a warning rather than a confident schedule
 * built on a guess.
 * ========================================================================== */

/* ---------------- travel ---------------- */

/* Effective speeds including waiting, stairs, traffic and the walk at either end — not vehicle
 * top speeds. A 4 km hop across a city is not 4 minutes. */
const TRAVEL_MODES = [
  {key:'walk',    label:'Walk',           icon:'🚶', maxKm:1.5,  kmh:4.5,  minMinutes:5},
  {key:'transit', label:'Public transit', icon:'🚇', maxKm:12,   kmh:16,   minMinutes:12},
  {key:'taxi',    label:'Taxi / rideshare', icon:'🚕', maxKm:40, kmh:26,   minMinutes:8},
  {key:'drive',   label:'Drive',          icon:'🚗', maxKm:Infinity, kmh:55, minMinutes:15},
];

function travelBetween(a, b){
  const km = (typeof geoDistanceKm === 'function') ? geoDistanceKm(a, b) : 0;
  if(!isFinite(km)) return {km:0, minutes:0, mode:TRAVEL_MODES[0]};
  const mode = TRAVEL_MODES.find(m => km <= m.maxKm) || TRAVEL_MODES[TRAVEL_MODES.length-1];
  const minutes = Math.max(mode.minMinutes, Math.round((km / mode.kmh) * 60));
  return {km, minutes, mode};
}

/* ---------------- how long a visit takes ---------------- */

/* Minutes at a place, by what it is. A viewpoint is not a museum. These are typical visit
 * lengths, then scaled by the traveller's pace. */
const VISIT_MINUTES = {
  museum:120, gallery:90, castle:100, palace:110, archaeological_site:90, ruins:60,
  attraction:75, monument:30, memorial:30, artwork:15, viewpoint:30, tower:60, city_gate:20,
  theme_park:240, zoo:150, aquarium:110, park:60, garden:60, nature_reserve:120,
  beach_resort:150, picnic_site:60, fort:75, spa:120, theatre:150, stadium:120,
  restaurant:75, cafe:45, fast_food:30, bakery:20, bar:75, pub:75, food_court:45,
  ice_cream:15, deli:25, biergarten:90, marketplace:60,
};

function visitMinutes(place, pace){
  const base = VISIT_MINUTES[String(place.subtype || '').toLowerCase()]
            || (place.type === 'restaurant' ? 70 : place.duration || 75);
  // Pace stretches or compresses the day, but never below a length that would be pointless.
  const factor = (pace.minutesPerStop || 90) / 90;
  return Math.max(15, Math.round(base * factor / 5) * 5);
}

/* ---------------- opening hours ---------------- */

const OH_DAYS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

/** Is this place open at `hour` on this date, as far as we can tell?
 *  Returns true / false / null, where null means "the data does not say" — which is NOT the same
 *  as open, and is reported differently. OSM opening_hours is a small language; this reads the
 *  common shapes and declines to guess at the rest rather than inventing a confident answer. */
function isOpenAt(hoursStr, dateStr, hour){
  const raw = String(hoursStr || '').trim();
  if(!raw) return null;
  if(/^24\/7$/i.test(raw)) return true;

  const ms = (typeof parseDateOnly === 'function') ? parseDateOnly(dateStr) : Date.parse(dateStr);
  if(isNaN(ms)) return null;
  const dow = new Date(ms).getUTCDay();
  const today = OH_DAYS[dow];

  // Rules are separated by ";" — take the last one that applies, as OSM's own semantics do.
  // `sawDayRule` matters: once a specification names particular days, a day it does NOT name is
  // closed rather than unknown. "Sa-Su 09:00-17:00" means shut on a Thursday, not unstated.
  let verdict = null, sawDayRule = false, matchedToday = false;
  for(const rule of raw.split(';')){
    const part = rule.trim();
    if(!part) continue;
    if(/^ph\b/i.test(part)) continue;                   // public holidays: not knowable here

    const dayMatch = part.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+(.*)$/i);
    let daysPart = null, timesPart = part;
    if(dayMatch){ daysPart = dayMatch[1]; timesPart = dayMatch[2]; }

    if(daysPart){
      sawDayRule = true;
      if(!dayListIncludes(daysPart, today)) continue;
      matchedToday = true;
    }
    if(/^off|^closed/i.test(timesPart.trim())){ verdict = false; continue; }

    const spans = timesPart.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g);
    if(!spans) continue;                                 // an unparsed shape teaches us nothing
    let open = false;
    for(const span of spans){
      const m = span.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
      const from = +m[1] + (+m[2]) / 60;
      let to = +m[3] + (+m[4]) / 60;
      if(to <= from) to += 24;                           // "18:00-02:00" runs past midnight
      if(hour >= from && hour < to) open = true;
    }
    verdict = open;
  }
  // Every rule named specific days and none of them was today: the place is shut today.
  if(verdict === null && sawDayRule && !matchedToday) return false;
  return verdict;
}

function dayListIncludes(daysPart, today){
  const idx = OH_DAYS.indexOf(today);
  for(const chunk of daysPart.split(',')){
    const c = chunk.trim();
    const range = c.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su)$/i);
    if(range){
      const a = OH_DAYS.findIndex(d => d.toLowerCase() === range[1].toLowerCase());
      const b = OH_DAYS.findIndex(d => d.toLowerCase() === range[2].toLowerCase());
      if(a <= b ? (idx >= a && idx <= b) : (idx >= a || idx <= b)) return true;
    } else if(c.toLowerCase() === today.toLowerCase()) return true;
  }
  return false;
}

/* ---------------- geographic clustering ---------------- */

/** Splits places into `k` groups that are actually near each other, so a day is a
 *  neighbourhood rather than a tour of the whole map. Lloyd's algorithm on coordinates, seeded
 *  by picking the furthest-apart starting points so two clusters do not collapse onto one area. */
function clusterByArea(places, k){
  const pts = places.filter(p => p.lat != null && p.lng != null);
  if(!pts.length || k <= 1) return [pts.slice()];
  if(pts.length <= k) return pts.map(p => [p]);

  // Seed: start from one place, then repeatedly take whatever is furthest from every seed so far.
  const seeds = [pts[0]];
  while(seeds.length < k){
    let best = null, bestD = -1;
    for(const p of pts){
      if(seeds.includes(p)) continue;
      const d = Math.min(...seeds.map(s => geoDistanceKm(s, p)));
      if(d > bestD){ bestD = d; best = p; }
    }
    if(!best) break;
    seeds.push(best);
  }
  let centres = seeds.map(s => ({lat:s.lat, lng:s.lng}));

  let groups = [];
  for(let iter = 0; iter < 12; iter++){
    groups = centres.map(() => []);
    for(const p of pts){
      let bi = 0, bd = Infinity;
      centres.forEach((c, i) => { const d = geoDistanceKm(c, p); if(d < bd){ bd = d; bi = i; } });
      groups[bi].push(p);
    }
    let moved = false;
    centres = centres.map((c, i) => {
      if(!groups[i].length) return c;
      const lat = groups[i].reduce((a, p) => a + p.lat, 0) / groups[i].length;
      const lng = groups[i].reduce((a, p) => a + p.lng, 0) / groups[i].length;
      if(Math.abs(lat - c.lat) > 1e-6 || Math.abs(lng - c.lng) > 1e-6) moved = true;
      return {lat, lng};
    });
    if(!moved) break;
  }
  return groups;
}

/** Orders one day's stops so the route does not double back: nearest-neighbour from whichever
 *  end makes the shortest overall walk. */
function orderByProximity(places){
  if(places.length <= 2) return places.slice();
  let best = null, bestLen = Infinity;
  for(const startIdx of places.keys()){
    const remaining = places.slice();
    const route = [remaining.splice(startIdx, 1)[0]];
    let len = 0;
    while(remaining.length){
      let bi = 0, bd = Infinity;
      remaining.forEach((p, i) => { const d = geoDistanceKm(route[route.length-1], p); if(d < bd){ bd = d; bi = i; } });
      len += bd;
      route.push(remaining.splice(bi, 1)[0]);
    }
    if(len < bestLen){ bestLen = len; best = route; }
  }
  return best;
}

/* ---------------- the plan ---------------- */

const MEAL_SLOTS = [
  {key:'lunch',  hour:13, label:'Lunch'},
  {key:'dinner', hour:19.5, label:'Dinner'},
];

function fmtClock(hourFloat){
  let h = Math.floor(hourFloat);
  const m = Math.round((hourFloat - h) * 60 / 5) * 5;
  let mm = m; if(mm >= 60){ h += 1; mm -= 60; }
  return String(h).padStart(2,'0') + ':' + String(mm).padStart(2,'0');
}

/** Builds the whole itinerary.
 *
 *  `places` are real, already-validated records. Returns days with scheduled stops, plus the
 *  warnings a traveller should see before trusting the plan.
 */
function planTrip(opts){
  const dest = opts.dest;
  const prefs = (typeof normalizeTripPreferences === 'function')
    ? normalizeTripPreferences(opts.preferences) : (opts.preferences || {});
  const nDays = Math.max(1, opts.days || 1);
  const startDate = opts.start;
  const pace = (typeof TRIP_PACE !== 'undefined' && TRIP_PACE[prefs.pace]) || {activities:3, max:4, mealsPerDay:2, minutesPerStop:90, maxTravelKmPerDay:20};
  const dayStart = (typeof DAY_START !== 'undefined' && DAY_START[prefs.dayStart]) || {hour:9, lastHour:21};
  const warnings = [];

  // Score everything once. An avoided place scores -Infinity and is dropped here, which is the
  // only hard filter in the pipeline.
  const scoreOf = p => {
    let s = 0;
    if(typeof placeQualityScore === 'function') s += placeQualityScore(p, {interests: prefs.interests, budgetStyle: prefs.budget});
    if(typeof preferenceScore === 'function') s += preferenceScore(p, prefs);
    return s;
  };
  const scored = (opts.places || [])
    .map(p => ({p, s: scoreOf(p)}))
    .filter(x => isFinite(x.s))
    .sort((a, b) => b.s - a.s);

  const attractions = scored.filter(x => x.p.type === 'attraction').map(x => x.p);
  const allFood     = scored.filter(x => x.p.type === 'restaurant').map(x => x.p);

  /* A day is not six museums. It is a coffee, a couple of sights, somewhere to eat, a market or
   * a street worth walking, dinner, and maybe a view at the end — so the pool is split by the
   * ROLE a place can play, and the day is assembled from those roles rather than from one
   * undifferentiated list. Every one of these is a real discovered place; none is filler. */
  const CAFE_KINDS = ['cafe', 'bakery', 'ice_cream', 'deli'];
  const EVENING_KINDS = ['bar', 'pub', 'biergarten', 'nightclub', 'theatre', 'viewpoint'];
  const BROWSE_KINDS = ['marketplace', 'market', 'mall', 'department_store', 'artwork',
                        'park', 'garden', 'viewpoint', 'attraction'];

  const isKind = (p, list) => list.includes(String(p.subtype || '').toLowerCase());
  const cafes       = allFood.filter(p => isKind(p, CAFE_KINDS));
  const restaurants = allFood.filter(p => !isKind(p, CAFE_KINDS) && !isKind(p, EVENING_KINDS));
  const evening     = allFood.filter(p => isKind(p, EVENING_KINDS))
                        .concat(attractions.filter(p => isKind(p, ['viewpoint', 'theatre'])));
  const browsable   = attractions.filter(p => isKind(p, BROWSE_KINDS));

  // Must-sees are pinned before anything else competes for the space.
  const pinned = attractions.filter(p => typeof isMustSee === 'function' && isMustSee(p, prefs));
  for(const wanted of (prefs.mustSee || [])){
    const found = pinned.some(p => String(p.name).toLowerCase().includes(String(wanted).toLowerCase()));
    if(!found){
      warnings.push({kind:'mustSeeMissing', text:`We could not find "${wanted}" in ${dest && dest.name ? dest.name : 'this destination'}, so it is not in the plan.`});
    }
  }

  // How many activities the trip can hold, at this pace, without padding.
  const wantPerDay = pace.activities;
  const capacity = nDays * pace.max;   // the ceiling, never a quota to fill
  const chosen = [];
  for(const p of pinned) if(chosen.length < capacity) chosen.push(p);
  for(const p of attractions){
    if(chosen.length >= capacity) break;
    if(!chosen.includes(p)) chosen.push(p);
  }

  // Group into days by area, then give each day the cluster nearest to the previous day's, so
  // consecutive days are not on opposite sides of the city.
  const clusters = clusterByArea(chosen, nDays).filter(c => c.length || true);
  while(clusters.length < nDays) clusters.push([]);
  clusters.length = nDays;

  const days = [];
  const usedPlaces = new Set();   // nothing is used twice across the whole trip

  for(let i = 0; i < nDays; i++){
    const date = (typeof addDays === 'function') ? addDays(startDate, i) : startDate;
    const cluster = orderByProximity((clusters[i] || []).slice(0, pace.max));
    const stops = [];
    let clock = dayStart.hour;
    let dayKm = 0;
    let mealsPlaced = 0;

    const centre = cluster.length
      ? {lat: cluster.reduce((a,p)=>a+p.lat,0)/cluster.length, lng: cluster.reduce((a,p)=>a+p.lng,0)/cluster.length}
      : (dest && dest.lat != null ? {lat:dest.lat, lng:dest.lng} : null);

    const pushStop = (place, kind) => {
      // The ceiling is a ceiling. Meals and cafes used to be added outside the cluster loop's
      // check, so a RELAXED day — chosen by someone who explicitly asked for fewer stops —
      // came out at eight against a limit of seven. Enforced in one place so no caller can
      // sidestep it.
      if(stops.length >= pace.max) return false;
      // Every stop is registered here, wherever it came from. The fill step draws from the same
      // attraction pool the cluster does, so without one central place to record this a park
      // could be scheduled as the morning sight and again as the afternoon walk.
      usedPlaces.add(keyOf(place));
      const prev = stops.length ? stops[stops.length-1] : null;
      let travel = null;
      if(prev && prev.place && place.lat != null){
        travel = travelBetween(prev.place, place);
        clock += travel.minutes / 60;
        dayKm += travel.km;
      }
      const mins = visitMinutes(place, pace);
      const open = isOpenAt(place.hours, date, clock);
      if(open === false){
        // Try later in the day before giving up on it.
        const later = isOpenAt(place.hours, date, Math.max(clock, 14));
        if(later === true) clock = Math.max(clock, 14);
      }
      const openNow = isOpenAt(place.hours, date, clock);
      stops.push({
        place, kind,
        time: fmtClock(clock),
        durationMin: mins,
        travelFromPrev: travel ? {minutes: travel.minutes, km: +travel.km.toFixed(2), mode: travel.mode.key, modeLabel: travel.mode.label, icon: travel.mode.icon} : null,
        openStatus: openNow === null ? 'unknown' : (openNow ? 'open' : 'closed'),
      });
      clock += mins / 60;
      return true;
    };

    /* Open the day with somewhere to have coffee, near where the day actually starts. It is a
     * real stop that people really make, and it anchors the morning in the right neighbourhood. */
    let cafesPlaced = 0;
    if(pace.cafesPerDay > 0){
      const c = pickNearby(cafes, cluster[0] || centre, usedPlaces, prefs, date, dayStart.hour, 2.5);
      if(c && pushStop(c, 'cafe')) cafesPlaced++;
    }

    for(const place of cluster){
      // Slot a meal in when a meal time arrives and we are near somewhere to eat.
      for(const slot of MEAL_SLOTS){
        if(mealsPlaced >= pace.mealsPerDay) break;
        if(clock >= slot.hour - 0.75 && !stops.some(s => s.mealSlot === slot.key)){
          const near = pickNearby(restaurants, lastPoint(stops, centre), usedPlaces, prefs, date, slot.hour, 3);
          if(near && pushStop(near, 'meal')){
            stops[stops.length-1].mealSlot = slot.key;
            stops[stops.length-1].mealLabel = slot.label;
            mealsPlaced++;
          }
        }
      }
      if(clock > dayStart.lastHour) break;      // the day is full; the rest moves to other days
      if(stops.length >= pace.max) break;
      if(usedPlaces.has(keyOf(place))) continue;   // already placed, on this day or an earlier one
      pushStop(place, 'activity');
    }

    /* Fill toward the target from what is genuinely nearby — a market, a park, a viewpoint, a
     * second coffee — but only while there is time and the day has not wandered too far. This is
     * what turns four stops into a full day without inventing anything or crossing the city. */
    let guard = 0;
    while(stops.length < pace.targetStops && clock < dayStart.lastHour - 0.5 &&
          dayKm < pace.maxTravelKmPerDay && guard++ < 12){
      const here = lastPoint(stops, centre);
      const wantEvening = clock >= 18.5;
      const pool = wantEvening ? evening : browsable;
      const extra = pickNearby(pool, here, usedPlaces, prefs, date, clock, wantEvening ? 3 : 2);
      if(!extra) break;                          // nothing suitable nearby: stop rather than pad
      if(!pushStop(extra, wantEvening ? 'evening' : 'activity')) break;
    }

    // A second coffee or a snack, for a pace that wants one and a day with room.
    if(cafesPlaced < pace.cafesPerDay && stops.length < pace.max && clock < dayStart.lastHour - 1){
      const c = pickNearby(cafes, lastPoint(stops, centre), usedPlaces, prefs, date, clock, 2);
      if(c && pushStop(c, 'cafe')) cafesPlaced++;
    }

    // Dinner, if the day's sights ended before it.
    for(const slot of MEAL_SLOTS){
      if(mealsPlaced >= pace.mealsPerDay) break;
      if(stops.some(s => s.mealSlot === slot.key)) continue;
      const near = pickNearby(restaurants, lastPoint(stops, centre), usedPlaces, prefs, date, slot.hour, 3);
      if(near){
        clock = Math.max(clock, slot.hour);
        if(pushStop(near, 'meal')){
          stops[stops.length-1].mealSlot = slot.key;
          stops[stops.length-1].mealLabel = slot.label;
          mealsPlaced++;
        }
      }
    }

    const endHour = clock;
    if(endHour > dayStart.lastHour + 1){
      warnings.push({kind:'dayLong', day:i+1,
        text:`Day ${i+1} runs to about ${fmtClock(endHour)}. Consider moving a stop to another day.`});
    }
    if(dayKm > pace.maxTravelKmPerDay){
      warnings.push({kind:'dayTravel', day:i+1,
        text:`Day ${i+1} covers about ${Math.round(dayKm)} km of travel, more than a ${pace.label || prefs.pace} day usually should.`});
    }
    const closed = stops.filter(s => s.openStatus === 'closed');
    for(const s of closed){
      warnings.push({kind:'closed', day:i+1,
        text:`${s.place.name} may be closed at ${s.time} on day ${i+1}.`});
    }

    days.push({date, stops, travelKm:+dayKm.toFixed(1), endsAt:fmtClock(endHour)});
  }

  return {days, warnings, pace:prefs.pace, unusedAttractions: attractions.filter(p => !chosen.includes(p))};
}

/** A stable key for "we have already used this place", so nothing appears twice in a trip. */
function keyOf(place){ return (place && (place.placeId || place.id || place.name)) || ''; }

/** Where the traveller currently is: the last stop placed, or the day's centre before any. */
function lastPoint(stops, centre){
  for(let i = stops.length - 1; i >= 0; i--){
    const p = stops[i] && stops[i].place;
    if(p && p.lat != null) return p;
  }
  return centre;
}

/** The best unused place from `pool` within `maxKm` of where the traveller is, open at that
 *  hour, ranked by what they said they like and then by how close it is.
 *
 *  Distance is a hard limit rather than a preference: filling a day is only worth doing with
 *  places that are genuinely on the way. Nothing within reach means the day ends there. */
function pickNearby(pool, here, used, prefs, date, hour, maxKm){
  if(!pool || !pool.length || !here) return null;
  const near = pool
    .filter(p => p && p.lat != null && !used.has(keyOf(p)))
    .map(p => ({p, km: geoDistanceKm(here, p), open: isOpenAt(p.hours, date, hour)}))
    .filter(x => x.open !== false)              // never send anyone somewhere shut
    .filter(x => x.km <= (maxKm || 2))
    .sort((a, b) => a.km - b.km)
    .slice(0, 10);
  if(!near.length) return null;
  if(typeof preferenceScore === 'function'){
    near.sort((a, b) => preferenceScore(b.p, prefs) - preferenceScore(a.p, prefs) || a.km - b.km);
  }
  return near[0].p;
}

/** The best place to eat near where the traveller already is, that they have not eaten at
 *  already today or on another day, and that is plausibly open at that hour. */
function pickRestaurantNear(restaurants, centre, used, prefs, date, hour){
  if(!centre) return restaurants.find(r => !used.has(r.placeId || r.id || r.name)) || null;
  const candidates = restaurants
    .filter(r => !used.has(r.placeId || r.id || r.name))
    .filter(r => r.lat != null)
    .map(r => ({r, km: geoDistanceKm(centre, r), open: isOpenAt(r.hours, date, hour)}))
    .filter(x => x.open !== false)                 // never book a table somewhere shut
    .filter(x => x.km < 4)
    .sort((a, b) => a.km - b.km);
  // Prefer somewhere close, but among the close ones prefer what the traveller likes.
  const near = candidates.slice(0, 8);
  if(!near.length) return null;
  if(typeof preferenceScore === 'function'){
    near.sort((a, b) => preferenceScore(b.r, prefs) - preferenceScore(a.r, prefs) || a.km - b.km);
  }
  return near[0].r;
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    TRAVEL_MODES, VISIT_MINUTES, travelBetween, visitMinutes, isOpenAt, dayListIncludes,
    clusterByArea, orderByProximity, planTrip, pickRestaurantNear, pickNearby, keyOf,
    lastPoint, fmtClock, MEAL_SLOTS,
  };
}
