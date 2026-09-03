/* Preferences must change the itinerary, not decorate it.
 *
 * The failure this guards against is a preferences screen that looks thorough and does nothing:
 * asking someone whether they like hiking and then handing them the same list either way is
 * worse than never asking, because it invites them to trust an answer that was not used.
 *
 * Every assertion below compares real place records the app actually produces — OSM subtypes,
 * cuisines, diet tags, price levels — rather than checking that a flag was stored.
 *
 *   node tools/test-preferences.js
 */
const path = require('path');
const P = require(path.join(path.dirname(__dirname), 'preferences.js'));

let pass = 0, fail = 0;
function check(name, cond, detail){
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

/* Records shaped exactly as places.js emits them. */
const museum      = {name:'City Museum', type:'attraction', subtype:'museum', category:'Museum', tags:['culture','art']};
const trailhead   = {name:'Ridge Trail Start', type:'attraction', subtype:'viewpoint', category:'Viewpoint', tags:['adventure','nature']};
const nightclub   = {name:'Club Neon', type:'restaurant', subtype:'bar', category:'Bar', tags:[]};
const cafe        = {name:'Roasters Coffee', type:'restaurant', subtype:'cafe', category:'Café', cuisine:'Coffee Shop', tags:['food']};
const fineDining  = {name:'Le Grand', type:'restaurant', subtype:'restaurant', category:'Restaurant', cuisine:'French', priceLevel:4, tags:['food']};
const streetFood  = {name:'Corner Tacos', type:'restaurant', subtype:'fast_food', category:'Casual & street food', cuisine:'Mexican', priceLevel:0, tags:['food']};
const veganPlace  = {name:'Green Kitchen', type:'restaurant', subtype:'restaurant', cuisine:'Vegan', dietary:['vegan','vegetarian'], priceLevel:2, tags:['food']};
const playground  = {name:'Riverside Playground', type:'attraction', subtype:'playground', category:'Playground', tags:[]};
const gallery     = {name:'Modern Art Gallery', type:'attraction', subtype:'gallery', category:'Gallery', tags:['art']};
const castle      = {name:'Old Castle', type:'attraction', subtype:'castle', category:'Castle', tags:['history']};
const spa         = {name:'Thermal Baths', type:'attraction', subtype:'spa', category:'Spa', tags:['relax']};
const luxHotel    = {name:'Grand Palace Hotel', type:'hotel', subtype:'hotel', stars:5};
const hostel      = {name:'Backpackers', type:'hotel', subtype:'hostel', stars:2};

function prefs(over){ return P.normalizeTripPreferences(Object.assign(P.defaultTripPreferences(), over)); }
function score(place, over){ return P.preferenceScore(place, prefs(over)); }

console.log('\n1. Interests actually reorder the list');
{
  const hiking = prefs({interests:['hiking']});
  check('hiking ranks a trailhead above a museum',
        P.preferenceScore(trailhead, hiking) > P.preferenceScore(museum, hiking));
  const art = prefs({interests:['art']});
  check('art ranks a gallery above a trailhead',
        P.preferenceScore(gallery, art) > P.preferenceScore(trailhead, art));
  const history = prefs({interests:['history']});
  check('history ranks a castle above a café',
        P.preferenceScore(castle, history) > P.preferenceScore(cafe, history));
  const cafes = prefs({interests:['cafes']});
  check('cafés ranks a coffee house above a castle',
        P.preferenceScore(cafe, cafes) > P.preferenceScore(castle, cafes));
  const wellness = prefs({interests:['wellness']});
  check('wellness ranks a spa above a nightclub',
        P.preferenceScore(spa, wellness) > P.preferenceScore(nightclub, wellness));

  check('a place serving two chosen interests outranks one serving a single interest',
        score(gallery, {interests:['art','history']}) > score(trailhead, {interests:['art','history']}));
  // Not "identical scores": the travel party still leans the list, and a viewpoint genuinely is
  // a romantic sort of place. The real claim is that no INTEREST is credited when none is chosen.
  check('choosing no interests credits no interest bonus',
        P.interestHits(museum, prefs({})).length === 0 &&
        P.interestHits(trailhead, prefs({})).length === 0);
  check('a trailhead is not mistaken for an art destination',
        !P.interestHits(trailhead, prefs({interests:['art']})).includes('art'),
        '"art" was matching inside "Ridge Trail Start"');
}

console.log('\n2. Every one of the twenty interests recognises something');
{
  // A vocabulary entry that matches nothing is a checkbox that does nothing.
  const samples = [museum, trailhead, nightclub, cafe, fineDining, streetFood, veganPlace,
                   playground, gallery, castle, spa,
                   {name:'Sunny Beach', subtype:'beach_resort', tags:['relax']},
                   {name:'Central Park', subtype:'park', tags:['nature']},
                   {name:'Adventure World', subtype:'theme_park', tags:[]},
                   {name:'Grand Bazaar', subtype:'marketplace', tags:['shopping']},
                   {name:'Skyline Lookout', subtype:'viewpoint', tags:['photography']},
                   {name:'Opera House', subtype:'theatre', tags:['culture']},
                   {name:'Olympic Stadium', subtype:'stadium', tags:[]},
                   {name:'Hidden local bar', subtype:'bar', tags:['hidden']},
                   {name:'Spring Festival Grounds', subtype:'events_venue', tags:['culture']},
                   {name:'Old Town Square', subtype:'attraction', tags:['culture','photography']},
                   {name:'City Zoo', subtype:'zoo', tags:[]}];
  const dead = P.TRIP_INTERESTS.filter(i => !samples.some(s => P.placeServesInterest(s, i)));
  check('no interest is a dead option', dead.length === 0, dead.map(i => i.key).join(', '));
}

console.log('\n3. Must-avoid is obeyed as a rule, not a hint');
{
  check('"no museums" removes museums entirely',
        score(museum, {mustAvoid:['no museums']}) === -Infinity);
  check('"no nightlife" removes a bar',
        score(nightclub, {mustAvoid:['no nightlife']}) === -Infinity);
  check('"no hiking" removes a trailhead',
        score(trailhead, {mustAvoid:['no hiking']}) === -Infinity);
  check('avoiding one thing does not remove another',
        score(cafe, {mustAvoid:['no museums']}) > -Infinity);
  check('a plain word is matched too',
        score(castle, {mustAvoid:['castle']}) === -Infinity);
}

console.log('\n4. Must-see is pinned, however it is typed');
{
  check('an exact name is pinned', score(castle, {mustSee:['Old Castle']}) >= 1000);
  check('a partial name is pinned', score(castle, {mustSee:['castle']}) >= 1000);
  check('different capitalisation still matches', score(castle, {mustSee:['OLD CASTLE']}) >= 1000);
  const local = {name:'Eiffel Tower', localName:'Tour Eiffel', subtype:'attraction'};
  check('the local-language name matches too', P.preferenceScore(local, prefs({mustSee:['Tour Eiffel']})) >= 1000);
  check('a must-see outranks everything else', score(castle, {mustSee:['Old Castle'], interests:['food']})
        > score(cafe, {mustSee:['Old Castle'], interests:['food']}));
}

console.log('\n5. Budget changes what is recommended');
{
  check('a budget traveller is steered away from a 4-price restaurant',
        score(fineDining, {budget:'budget'}) < score(streetFood, {budget:'budget'}));
  check('a luxury traveller is steered towards it',
        score(fineDining, {budget:'luxury'}) > score(streetFood, {budget:'luxury'}));
  check('a budget traveller is steered away from a five-star hotel',
        score(luxHotel, {budget:'budget'}) < score(hostel, {budget:'budget'}));
  check('a mismatch is discouraged, not banned',
        score(fineDining, {budget:'budget'}) > -Infinity,
        'budget should lean the list, not empty it');
  check('an unpriced place is not penalised',
        score(museum, {budget:'budget'}) === score(museum, {budget:'luxury'}),
        'most OSM places carry no price at all');
}

console.log('\n6. Food preferences reach the restaurant list');
{
  check('vegan preference lifts a vegan kitchen',
        score(veganPlace, {food:['vegan']}) > score(fineDining, {food:['vegan']}));
  check('street food preference lifts street food',
        score(streetFood, {food:['street']}) > score(fineDining, {food:['street']}));
  check('fine dining preference lifts fine dining',
        score(fineDining, {food:['fine']}) > score(streetFood, {food:['fine']}));
  check('cafés preference lifts a café', score(cafe, {food:['cafes']}) > score(fineDining, {food:['cafes']}));
  check('food preferences do not affect attractions',
        score(museum, {food:['vegan']}) === score(museum, {food:[]}));
}

console.log('\n7. Who is travelling changes the shape of the trip');
{
  check('a family with children is not sent to a nightclub',
        score(nightclub, {party:'children'}) === -Infinity);
  check('unless they asked for nightlife themselves',
        score(nightclub, {party:'children', interests:['nightlife']}) > -Infinity);
  check('children lift a playground', score(playground, {party:'children'}) > score(playground, {party:'business'}));
  check('seniors are not sent hiking', score(trailhead, {party:'seniors'}) === -Infinity);
  check('a couple leans romantic/wellness', score(spa, {party:'couple'}) > score(spa, {party:'business'}));
}

console.log('\n8. Pace and day start carry real numbers');
{
  const r = P.TRIP_PACE.relaxed, b = P.TRIP_PACE.balanced, k = P.TRIP_PACE.packed;
  check('relaxed schedules fewer activities than balanced', r.activities < b.activities);
  check('balanced schedules fewer than packed', b.activities < k.activities);
  check('relaxed allows longer at each stop', r.minutesPerStop > k.minutesPerStop);
  check('a packed day still has a ceiling', k.max <= 6, `max ${k.max}`);
  check('an early bird starts before a late starter', P.DAY_START.early.hour < P.DAY_START.late.hour);
  check('a late starter is never given a 7am stop', P.DAY_START.late.hour >= 10,
        `starts at ${P.DAY_START.late.hour}`);
}

console.log('\n9. A stored preference record survives round trips and bad data');
{
  const round = P.normalizeTripPreferences({interests:['art','nonsense'], pace:'wrong',
                                            budget:null, food:['vegan','fake'], party:'zzz'});
  check('unknown interests are dropped', !round.interests.includes('nonsense') && round.interests.includes('art'));
  check('an unknown pace falls back to balanced', round.pace === 'balanced');
  check('an unknown budget falls back to moderate', round.budget === 'moderate');
  check('unknown food keys are dropped', round.food.length === 1 && round.food[0] === 'vegan');
  check('an unknown party falls back', !!P.TRAVEL_PARTY[round.party]);
  check('empty preferences never throw', typeof P.preferenceScore(museum, null) === 'number');
  check('a malformed place never throws', typeof P.preferenceScore({}, prefs({interests:['art']})) === 'number');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
