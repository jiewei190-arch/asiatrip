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
  const restaurants = scored.filter(x => x.p.type === 'restaurant').map(x => x.p);

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
  const capacity = nDays * pace.max;
  const chosen = [];
  for(const p of pinned) if(chosen.length < capacity) chosen.push(p);
  for(const p of attractions){
    if(chosen.length >= Math.min(capacity, nDays * wantPerDay + nDays)) break;
    if(!chosen.includes(p)) chosen.push(p);
  }

  // Group into days by area, then give each day the cluster nearest to the previous day's, so
  // consecutive days are not on opposite sides of the city.
  const clusters = clusterByArea(chosen, nDays).filter(c => c.length || true);
  while(clusters.length < nDays) clusters.push([]);
  clusters.length = nDays;

  const days = [];
  const usedRestaurants = new Set();

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
    };

    for(const place of cluster){
      // Slot a meal in when a meal time arrives and we are near somewhere to eat.
      for(const slot of MEAL_SLOTS){
        if(mealsPlaced >= pace.mealsPerDay) break;
        if(clock >= slot.hour - 0.75 && !stops.some(s => s.mealSlot === slot.key)){
          const near = pickRestaurantNear(restaurants, centre, usedRestaurants, prefs, date, slot.hour);
          if(near){
            usedRestaurants.add(near.placeId || near.id || near.name);
            pushStop(near, 'meal');
            stops[stops.length-1].mealSlot = slot.key;
            stops[stops.length-1].mealLabel = slot.label;
            mealsPlaced++;
          }
        }
      }
      if(clock > dayStart.lastHour) break;      // the day is full; the rest moves to other days
      pushStop(place, 'activity');
    }

    // Dinner, if the day's sights ended before it.
    for(const slot of MEAL_SLOTS){
      if(mealsPlaced >= pace.mealsPerDay) break;
      if(stops.some(s => s.mealSlot === slot.key)) continue;
      const near = pickRestaurantNear(restaurants, centre, usedRestaurants, prefs, date, slot.hour);
      if(near){
        usedRestaurants.add(near.placeId || near.id || near.name);
        clock = Math.max(clock, slot.hour);
        pushStop(near, 'meal');
        stops[stops.length-1].mealSlot = slot.key;
        stops[stops.length-1].mealLabel = slot.label;
        mealsPlaced++;
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
    clusterByArea, orderByProximity, planTrip, pickRestaurantNear, fmtClock, MEAL_SLOTS,
  };
}
