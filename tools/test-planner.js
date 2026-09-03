/* The generated day has to be one a person could actually walk.
 *
 * The generator this replaces dealt places out round-robin, so a Paris day could run Eiffel
 * Tower, Montmartre, Louvre and back west. These assertions are about the things that made that
 * itinerary unusable: order that ignores geography, times that ignore how long anything takes,
 * and schedules that ignore whether a place is open.
 *
 *   node tools/test-planner.js
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.dirname(__dirname);

/* planner.js leans on helpers that live in data.js and preferences.js. */
const dataSrc = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
function grab(name){
  const m = dataSrc.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n}', 'm'));
  if(!m) throw new Error('missing ' + name);
  return m[0];
}
const geoHelpers = new Function(grab('geoDistanceKm') + '\n' + grab('parseDateOnly') + '\n' + grab('addDays') +
  '\nreturn {geoDistanceKm, parseDateOnly, addDays};')();
Object.assign(global, geoHelpers);
Object.assign(global, require(path.join(ROOT, 'preferences.js')));
const PL = require(path.join(ROOT, 'planner.js'));
Object.assign(global, PL);

let pass = 0, fail = 0;
function check(name, cond, detail){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

/* A small city laid out in two clear districts, plus one outlier. Coordinates are real Paris
 * ones so the distances are realistic. */
const WEST = [
  {placeId:'osm:N1', name:'Eiffel Tower',   type:'attraction', subtype:'attraction', lat:48.8584, lng:2.2945, tags:['culture']},
  {placeId:'osm:N2', name:'Trocadero',      type:'attraction', subtype:'viewpoint',  lat:48.8629, lng:2.2874, tags:['photography']},
  {placeId:'osm:N3', name:'Musee Rodin',    type:'attraction', subtype:'museum',     lat:48.8553, lng:2.3158, tags:['art']},
];
const EAST = [
  {placeId:'osm:N4', name:'Pere Lachaise',  type:'attraction', subtype:'attraction', lat:48.8614, lng:2.3934, tags:['history']},
  {placeId:'osm:N5', name:'Place des Vosges',type:'attraction',subtype:'park',       lat:48.8555, lng:2.3653, tags:['nature']},
  {placeId:'osm:N6', name:'Musee Picasso',  type:'attraction', subtype:'museum',     lat:48.8598, lng:2.3626, tags:['art']},
];
const FOOD = [
  {placeId:'osm:R1', name:'Cafe Ouest',  type:'restaurant', subtype:'restaurant', lat:48.8570, lng:2.2990, cuisine:'French', hours:'Mo-Su 11:00-23:00'},
  {placeId:'osm:R2', name:'Bistro Ouest',type:'restaurant', subtype:'restaurant', lat:48.8600, lng:2.2960, cuisine:'French', hours:'Mo-Su 11:00-23:00'},
  {placeId:'osm:R3', name:'Cafe Est',    type:'restaurant', subtype:'restaurant', lat:48.8590, lng:2.3650, cuisine:'French', hours:'Mo-Su 11:00-23:00'},
  {placeId:'osm:R4', name:'Bistro Est',  type:'restaurant', subtype:'restaurant', lat:48.8570, lng:2.3680, cuisine:'French', hours:'Mo-Su 11:00-23:00'},
];
const DEST = {name:'Paris', lat:48.8566, lng:2.3522, countryCode:'FR', placeType:'city'};
const ALL = WEST.concat(EAST, FOOD);

function plan(over){
  return PL.planTrip(Object.assign({
    dest: DEST, places: ALL, days: 2, start: '2026-09-24',
    preferences: defaultTripPreferences(),
  }, over));
}

console.log('\n1. Travel time is estimated, not ignored');
{
  const near = PL.travelBetween({lat:48.8584,lng:2.2945}, {lat:48.8629,lng:2.2874});
  const far  = PL.travelBetween({lat:48.8584,lng:2.2945}, {lat:48.8614,lng:2.3934});
  check('a short hop is a walk', near.mode.key === 'walk', near.mode.key);
  check('a walk across town is not', far.mode.key !== 'walk', far.mode.key);
  check('crossing Paris takes longer than crossing a block', far.minutes > near.minutes,
        `${near.minutes} vs ${far.minutes} min`);
  check('even a tiny hop costs some minutes', near.minutes >= 5, `${near.minutes} min`);
  check('travel time is a plausible number', far.minutes < 90, `${far.minutes} min`);
}

console.log('\n2. Visit length depends on what the place is');
{
  const pace = TRIP_PACE.balanced;
  const museum = PL.visitMinutes({subtype:'museum'}, pace);
  const artwork = PL.visitMinutes({subtype:'artwork'}, pace);
  const themepark = PL.visitMinutes({subtype:'theme_park'}, pace);
  check('a museum takes longer than a statue', museum > artwork, `${museum} vs ${artwork}`);
  check('a theme park takes longer than a museum', themepark > museum, `${themepark} vs ${museum}`);
  check('a relaxed pace lingers longer than a packed one',
        PL.visitMinutes({subtype:'museum'}, TRIP_PACE.relaxed) >
        PL.visitMinutes({subtype:'museum'}, TRIP_PACE.packed));
}

console.log('\n3. Opening hours are read, and "unknown" is not "open"');
{
  // 2026-09-24 is a Thursday.
  check('open during listed hours', PL.isOpenAt('Mo-Fr 09:00-17:00', '2026-09-24', 12) === true);
  check('closed outside them', PL.isOpenAt('Mo-Fr 09:00-17:00', '2026-09-24', 20) === false);
  check('closed on a day not listed', PL.isOpenAt('Sa-Su 09:00-17:00', '2026-09-24', 12) === false);
  check('24/7 is always open', PL.isOpenAt('24/7', '2026-09-24', 3) === true);
  check('an explicit closure is respected', PL.isOpenAt('Mo-Fr 09:00-17:00; Th off', '2026-09-24', 12) === false);
  check('hours past midnight are handled', PL.isOpenAt('Mo-Su 18:00-02:00', '2026-09-24', 23) === true);
  check('no hours at all means unknown, not open', PL.isOpenAt('', '2026-09-24', 12) === null);
  check('an unparseable shape means unknown', PL.isOpenAt('by appointment', '2026-09-24', 12) === null);
}

console.log('\n4. A day is a neighbourhood, not a tour of the whole map');
{
  const groups = PL.clusterByArea(WEST.concat(EAST), 2).filter(g => g.length);
  check('two districts become two groups', groups.length === 2, `${groups.length} groups`);
  const mixed = groups.filter(g =>
    g.some(p => WEST.includes(p)) && g.some(p => EAST.includes(p)));
  check('no group mixes the two sides of the city', mixed.length === 0);

  // Ordering: a route that doubles back is longer than one that does not.
  const ordered = PL.orderByProximity(WEST.concat(EAST));
  let len = 0;
  for(let i = 1; i < ordered.length; i++) len += geoDistanceKm(ordered[i-1], ordered[i]);
  let naive = 0;
  const asGiven = WEST.concat(EAST);
  for(let i = 1; i < asGiven.length; i++) naive += geoDistanceKm(asGiven[i-1], asGiven[i]);
  check('ordering shortens the route rather than lengthening it', len <= naive + 0.01,
        `${len.toFixed(1)} km vs ${naive.toFixed(1)} km unordered`);
}

console.log('\n5. Pace decides how full a day is');
{
  // Enough places that the pace is what limits the day, not the supply. With only six
  // attractions both paces simply take everything and the difference cannot show.
  const MANY = [];
  for(let i = 0; i < 30; i++){
    MANY.push({placeId:'osm:M'+i, name:'Sight '+i, type:'attraction', subtype:'attraction',
               lat: 48.855 + (i % 6) * 0.004, lng: 2.29 + Math.floor(i / 6) * 0.004, tags:['culture']});
  }
  const withSupply = over => PL.planTrip(Object.assign({
    dest: DEST, places: MANY.concat(FOOD), days: 2, start: '2026-09-24',
    preferences: defaultTripPreferences(),
  }, over));
  const relaxed = withSupply({preferences: normalizeTripPreferences({pace:'relaxed'})});
  const packed  = withSupply({preferences: normalizeTripPreferences({pace:'packed'})});
  const acts = t => t.days.reduce((a,d) => a + d.stops.filter(s => s.kind === 'activity').length, 0);
  check('a packed trip holds more activities than a relaxed one', acts(packed) > acts(relaxed),
        `relaxed ${acts(relaxed)}, packed ${acts(packed)}`);
  check('a relaxed day is never overfilled',
        relaxed.days.every(d => d.stops.filter(s => s.kind==='activity').length <= TRIP_PACE.relaxed.max));
  check('a day is not padded beyond what exists',
        packed.days.every(d => d.stops.length <= 12));
}

console.log('\n6. The day starts when the traveller gets up');
{
  const early = plan({preferences: normalizeTripPreferences({dayStart:'early'})});
  const late  = plan({preferences: normalizeTripPreferences({dayStart:'late'})});
  const firstHour = t => parseInt(t.days[0].stops[0].time.split(':')[0], 10);
  check('an early bird starts early', firstHour(early) <= 8, early.days[0].stops[0].time);
  check('a late starter is never given a 7am stop', firstHour(late) >= 10, late.days[0].stops[0].time);
}

console.log('\n7. Meals appear at meal times, near where you already are');
{
  const t = plan({});
  const meals = t.days.flatMap(d => d.stops.filter(s => s.kind === 'meal'));
  check('meals are scheduled', meals.length > 0, `${meals.length} meals`);
  const badTime = meals.filter(m => {
    const h = parseInt(m.time.split(':')[0], 10);
    return h < 11 || h > 22;
  });
  check('no meal is scheduled at a strange hour', badTime.length === 0,
        badTime.map(m => `${m.place.name} @ ${m.time}`).join(', '));
  const names = meals.map(m => m.place.name);
  check('the same restaurant is not used twice', new Set(names).size === names.length, names.join(', '));
  // A west-side day should eat on the west side.
  const day = t.days.find(d => d.stops.some(s => s.kind==='activity' && WEST.includes(s.place)));
  if(day){
    const meal = day.stops.find(s => s.kind === 'meal');
    if(meal){
      const dist = geoDistanceKm(meal.place, day.stops.find(s=>s.kind==='activity').place);
      check('lunch is not across town from the morning', dist < 4, `${dist.toFixed(1)} km away`);
    } else { check('lunch is not across town from the morning', true, 'no meal placed on this day'); }
  }
}

console.log('\n8. Interests and must-see/avoid reach the finished plan');
{
  const art = plan({preferences: normalizeTripPreferences({interests:['art']})});
  const artNames = art.days.flatMap(d => d.stops.map(s => s.place.name));
  check('choosing Art puts a museum in the plan',
        artNames.some(n => /Musee/.test(n)), artNames.join(', '));

  const avoided = plan({preferences: normalizeTripPreferences({mustAvoid:['museum']})});
  const avoidedNames = avoided.days.flatMap(d => d.stops.map(s => s.place.name));
  check('"no museums" keeps museums out of the plan entirely',
        !avoidedNames.some(n => /Musee/.test(n)), avoidedNames.join(', '));

  const pinnedPlan = plan({preferences: normalizeTripPreferences({mustSee:['Eiffel Tower']})});
  const pinnedNames = pinnedPlan.days.flatMap(d => d.stops.map(s => s.place.name));
  check('a must-see is in the plan', pinnedNames.includes('Eiffel Tower'), pinnedNames.join(', '));

  const missing = plan({preferences: normalizeTripPreferences({mustSee:['Somewhere Imaginary']})});
  check('a must-see that does not exist is reported, not silently dropped',
        missing.warnings.some(w => w.kind === 'mustSeeMissing'),
        JSON.stringify(missing.warnings));
}

console.log('\n9. The plan tells you when it is unrealistic');
{
  const closedPlace = Object.assign({}, WEST[0], {placeId:'osm:N99', name:'Always Shut', hours:'Mo-Su 03:00-04:00'});
  const t = plan({places: ALL.concat([closedPlace]),
                  preferences: normalizeTripPreferences({mustSee:['Always Shut']})});
  check('a stop scheduled while closed produces a warning',
        t.warnings.some(w => w.kind === 'closed'), JSON.stringify(t.warnings.map(w=>w.kind)));
  check('warnings name the day they concern',
        t.warnings.filter(w => w.day != null).every(w => w.day >= 1 && w.day <= t.days.length));
}

console.log('\n10. Structure holds for any trip length');
{
  for(const n of [1, 2, 3, 5, 7, 10, 14]){
    const t = plan({days: n});
    const okDays = t.days.length === n;
    const dated = t.days.every((d, i) => d.date === addDays('2026-09-24', i));
    const noDupes = (() => {
      const ids = t.days.flatMap(d => d.stops.map(s => s.place.placeId));
      return new Set(ids).size === ids.length;
    })();
    check(`${n}-day trip: ${n} days, correctly dated, no place repeated`,
          okDays && dated && noDupes,
          `days=${t.days.length} dated=${dated} unique=${noDupes}`);
  }
  const empty = plan({places: []});
  check('a destination with no places yields empty days rather than throwing',
        empty.days.length === 2 && empty.days.every(d => d.stops.length === 0));
}


/* ---------------- density: a day should feel like a day out ---------------- */
console.log('\n11. Days are full enough to be useful');
{
  // A realistic city pool: sights, cafes, restaurants, markets and evening places, all within
  // walking distance of each other, as a real neighbourhood is.
  const POOL = [];
  let n = 0;
  const mk = (type, subtype) => {
    const i = n++;
    return {placeId:'osm:D'+i, name:`${subtype} ${i}`, type, subtype,
            lat: 48.856 + (i % 7) * 0.003, lng: 2.35 + Math.floor(i / 7) * 0.003,
            hours:'Mo-Su 08:00-23:00', tags:['culture']};
  };
  for(let i = 0; i < 40; i++) POOL.push(mk('attraction', 'attraction'));
  for(let i = 0; i < 12; i++) POOL.push(mk('attraction', 'park'));
  for(let i = 0; i < 10; i++) POOL.push(mk('attraction', 'marketplace'));
  for(let i = 0; i < 10; i++) POOL.push(mk('attraction', 'viewpoint'));
  for(let i = 0; i < 30; i++) POOL.push(mk('restaurant', 'restaurant'));
  for(let i = 0; i < 20; i++) POOL.push(mk('restaurant', 'cafe'));
  for(let i = 0; i < 12; i++) POOL.push(mk('restaurant', 'bar'));

  const run = (paceKey, days) => PL.planTrip({
    dest: DEST, places: POOL, days, start: '2026-09-24',
    preferences: normalizeTripPreferences({pace: paceKey}),
  });

  for(const [paceKey, floor] of [['relaxed', 5], ['balanced', 6], ['packed', 7]]){
    const t = run(paceKey, 5);
    const counts = t.days.map(d => d.stops.length);
    const min = Math.min(...counts), avg = counts.reduce((a,b)=>a+b,0) / counts.length;
    check(`${paceKey}: every day reaches at least ${floor} stops`, min >= floor,
          `days: ${counts.join(', ')}`);
    console.log(`        ${paceKey}: ${counts.join(', ')} (avg ${avg.toFixed(1)})`);
  }

  const long = run('balanced', 10);
  const counts = long.days.map(d => d.stops.length);
  check('a 10-day trip stays dense to the last day', Math.min(...counts) >= 5,
        `days: ${counts.join(', ')}`);
  check('no day is a single stop', counts.every(c => c > 1), counts.join(', '));
  console.log(`        10-day: ${counts.join(', ')}`);

  const day = run('balanced', 3).days[0];
  const kinds = new Set(day.stops.map(s => s.kind));
  check('a day mixes activities, meals and cafes', kinds.size >= 3, [...kinds].join(', '));

  const walk = run('packed', 3);
  const worst = Math.max(...walk.days.map(d => d.travelKm));
  check('a packed day stays within its travel budget', worst <= TRIP_PACE.packed.maxTravelKmPerDay,
        `worst day ${worst} km`);
  console.log(`        worst packed day: ${worst} km`);
}

console.log('\nMore ideas, and where they would go');
{
  const trip = { days: [
    { date:'2026-05-01', stops:[
      {placeId:'a', name:'Museum', type:'attraction', lat:48.8606, lng:2.3376, time:'10:00', duration:120},
      {placeId:'b', name:'Lunch',  type:'restaurant', lat:48.8620, lng:2.3400, time:'13:00', duration:75},
      {placeId:'c', name:'Garden', type:'attraction', lat:48.8630, lng:2.3270, time:'16:00', duration:90},
    ]},
    { date:'2026-05-02', stops:[
      {placeId:'d', name:'Tower', type:'attraction', lat:48.8584, lng:2.2945, time:'10:00', duration:120},
    ]},
    { date:'2026-05-03', stops:[] },
  ]};

  const nearDay1 = {id:'x', name:'Gallery', type:'attraction', subtype:'gallery', lat:48.8610, lng:2.3380, duration:60};
  const nearDay2 = {id:'y', name:'Bridge', type:'attraction', subtype:'attraction', lat:48.8590, lng:2.2950, duration:45};
  const p1 = PL.suggestPlacement(trip, nearDay1, {prefs:{pace:'balanced'}});
  const p2 = PL.suggestPlacement(trip, nearDay2, {prefs:{pace:'balanced'}});
  check('a place is put on the day it is nearest to', p1 && p1.dayIndex === 0, p1 && `day ${p1.dayIndex+1}`);
  check('a place across town goes to the day that is across town', p2 && p2.dayIndex === 1, p2 && `day ${p2.dayIndex+1}`);

  // The behaviour this replaces appended at "last stop + 20 minutes", whatever the place was.
  const dinner = {id:'r', name:'Bistro', type:'restaurant', subtype:'restaurant', lat:48.8612, lng:2.3382, duration:90};
  const pd = PL.suggestPlacement(trip, dinner, {prefs:{pace:'balanced'}});
  check('a restaurant is scheduled at a mealtime, not tacked onto the end',
        !!(pd && /^(12|13|19|20)/.test(pd.time)), pd && pd.time);
  const bar = {id:'v', name:'Wine Bar', type:'restaurant', subtype:'bar', lat:48.8612, lng:2.3382, duration:60};
  const pb = PL.suggestPlacement(trip, bar, {prefs:{pace:'balanced'}});
  check('a bar is scheduled in the evening', !!(pb && Number(pb.time.slice(0,2)) >= 18), pb && pb.time);
  const museum = {id:'m', name:'Small Museum', type:'attraction', subtype:'museum', lat:48.8611, lng:2.3378, duration:60};
  const pm = PL.suggestPlacement(trip, museum, {prefs:{pace:'balanced'}});
  check('a daytime place is never scheduled into the night', !!(pm && Number(pm.time.slice(0,2)) < 22), pm && pm.time);
  check('nothing is scheduled before 8am', !!(pm && Number(pm.time.slice(0,2)) >= 8), pm && pm.time);

  const emptyOnly = { days:[{date:'2026-05-01', stops:[]}] };
  const pe = PL.suggestPlacement(emptyOnly, museum, {prefs:{pace:'balanced'}});
  check('an empty day starts in the morning', !!(pe && pe.time === '09:30'), pe && pe.time);

  const cap = PL.TRIP_PACE ? PL.TRIP_PACE.balanced.max : 9;
  const stuffed = { days:[{date:'2026-05-01', stops: Array.from({length:cap}, (_,i)=>(
    {placeId:'s'+i, name:'Stop'+i, type:'attraction', lat:48.86, lng:2.33, time:'10:00', duration:60}))}] };
  check('a day already at its ceiling is not offered',
        PL.suggestPlacement(stuffed, museum, {prefs:{pace:'balanced'}}) === null, 'ceiling is ' + cap);

  const pool = [
    {id:'a', name:'Museum', type:'attraction', subtype:'museum', lat:48.8606, lng:2.3376},
    {id:'n1', name:'Print Gallery', type:'attraction', subtype:'gallery', lat:48.8608, lng:2.3379, tags:['art']},
    {id:'n2', name:'Old Fort', type:'attraction', subtype:'castle', lat:48.8609, lng:2.3381, tags:['history']},
    {id:'h1', name:'Grand Hotel', type:'hotel', subtype:'hotel', lat:48.8607, lng:2.3377, stars:5},
  ];
  const ideas = PL.suggestIdeasForTrip({places: pool, plannedKeys: ['a'], prefs: null,
                                       anchors: [{lat:48.8606, lng:2.3376}], limit: 6});
  const names = ideas.map(i => i.place.name);
  check('a place already on the itinerary is not suggested again', !names.includes('Museum'), names.join(', '));
  check('a hotel is not suggested as an idea', !names.includes('Grand Hotel'), names.join(', '));
  check('real alternatives are suggested',
        names.includes('Print Gallery') && names.includes('Old Fort'), names.join(', '));
  check('every suggestion carries the place record it came from', ideas.every(i => i.place && i.place.id));

  const manyMuseums = Array.from({length:8}, (_,i)=>(
    {id:'m'+i, name:'Museum '+i, type:'attraction', subtype:'museum', lat:48.86+i*0.001, lng:2.33, tags:['culture']}));
  const varied = PL.suggestIdeasForTrip({places: manyMuseums.concat(pool.slice(1,3)), plannedKeys: [],
                                        prefs: null, anchors: [{lat:48.86, lng:2.33}], limit: 6});
  const museums = varied.filter(v => v.place.subtype === 'museum').length;
  check('one category cannot fill the whole list', museums <= 2, `${museums} museums of ${varied.length}`);
}

console.log('\nA day a person could actually do');
{
  const mk = (n, opts) => Array.from({length:n}, (_,i)=>Object.assign(
    {name:'Stop'+i, type:'attraction', lat:48.86, lng:2.33, time:'09:00', duration:60}, opts && opts(i)));

  // A sensible balanced day raises nothing.
  const fine = { stops: mk(6, i => ({lat:48.86+i*0.002, lng:2.33+i*0.002, time:['09:00','11:00','13:00','15:00','17:00','19:00'][i]})) };
  const okDay = PL.assessDayLoad(fine, {pace:'balanced'});
  check('a reasonable day raises nothing', okDay.level === 'ok',
        okDay.issues.map(x=>x.kind).join(', '));

  // Too many stops for the chosen pace.
  const many = { stops: mk(11, i => ({lat:48.86+i*0.001, lng:2.33, time:'09:00'})) };
  const rel = PL.assessDayLoad(many, {pace:'relaxed'});
  check('too many stops is flagged against the chosen pace',
        rel.issues.some(x=>x.kind==='stops'), rel.issues.map(x=>x.kind).join(', '));
  // The same day at "packed" is a different judgement — that is the point of a pace.
  const packed = PL.assessDayLoad(many, {pace:'packed'});
  check('the same day is judged differently at a different pace',
        !packed.issues.some(x=>x.kind==='stops'), `packed flagged: ${packed.issues.map(x=>x.kind).join(', ')}`);

  // Too much ground covered.
  const spread = { stops: mk(5, i => ({lat:48.86+i*0.09, lng:2.33+i*0.09, time:'09:00'})) };
  const far = PL.assessDayLoad(spread, {pace:'relaxed'});
  check('a day that criss-crosses the city is flagged',
        far.issues.some(x=>x.kind==='distance'), `${far.km.toFixed(1)} km`);

  // Ending in the small hours.
  const late = { stops: [{name:'Late', type:'attraction', lat:48.86, lng:2.33, time:'22:30', duration:120}] };
  check('a day that runs past midnight is flagged',
        PL.assessDayLoad(late, {pace:'balanced'}).issues.some(x=>x.kind==='late'));

  // Every message must carry the number it is complaining about, or it cannot be checked.
  check('each warning states the measured figure',
        rel.issues.concat(far.issues).every(x => /\d/.test(x.text)),
        rel.issues.concat(far.issues).map(x=>x.text).join(' | '));

  check('two problems read as overloaded, one as busy',
        PL.assessDayLoad(many, {pace:'relaxed'}).level !== 'ok' &&
        PL.assessDayLoad(fine, {pace:'balanced'}).level === 'ok');
  check('an empty day is never a warning', PL.assessDayLoad({stops:[]}, {pace:'balanced'}).level === 'ok');
  check('a malformed day never throws', typeof PL.assessDayLoad(null, null).level === 'string');
}

console.log('\nDays get a fair share of the city');
{
  /* k-means gives tight clusters, not equal ones, and a real city is a dense core with
   * scattered outskirts. Unbalanced, k=7 produced clusters of 124, 3, 2, 2, 2, 1, 1 — so six
   * of seven days had nothing to build from, and a "packed" week in Paris returned days of two
   * stops. This shape is the one that broke it. */
  const city = [];
  for(let i = 0; i < 120; i++) city.push({id:'c'+i, name:'Core'+i, type:'attraction', subtype:'attraction',
    lat: 48.86 + ((i % 11) - 5) * 0.002, lng: 2.34 + ((i % 7) - 3) * 0.003});
  for(let i = 0; i < 15; i++) city.push({id:'o'+i, name:'Out'+i, type:'attraction', subtype:'attraction',
    lat: 48.86 + ((i % 5) - 2) * 0.05, lng: 2.34 + ((i % 3) - 1) * 0.06});

  for(const k of [5, 7, 10]){
    const raw = PL.clusterByArea(city, k);
    const bal = PL.balanceClusters(raw, k);
    const sizes = bal.map(c => c.length);
    const total = sizes.reduce((a, b) => a + b, 0);
    check(`k=${k}: nothing is lost in balancing`, total === city.length, `${total} of ${city.length}`);
    check(`k=${k}: no day is left almost empty`,
          Math.min(...sizes) >= Math.floor(city.length / k / 2),
          `sizes ${sizes.join(', ')}`);
    check(`k=${k}: no day hoards the city`,
          Math.max(...sizes) <= Math.ceil(city.length / k),
          `sizes ${sizes.join(', ')}`);
    const dupes = bal.flat().map(p => p.id);
    check(`k=${k}: no place lands on two days`, new Set(dupes).size === dupes.length);
  }

  check('balancing an empty set does not throw', PL.balanceClusters([[], [], []], 3).length === 3);
  check('a single day keeps everything', PL.balanceClusters([city], 1)[0].length === city.length);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
/* process.exitCode rather than process.exit(): when stdout is redirected to a file or a pipe,
 * Node writes it asynchronously and process.exit() discards whatever is still buffered. Two
 * full worldwide runs lost their closing summary that way — the tally, the sample of what was
 * found and the currency checks were simply gone, and the run looked like it had died at
 * whichever destination happened to be last flushed. Setting the code instead lets Node drain
 * stdout and exit on its own. */
process.exitCode = fail ? 1 : 0;
