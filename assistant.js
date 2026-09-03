/* ============================================================
   TripFlow — the assistant's language engine

   No API key, no backend, no model download: this runs entirely in the page and answers
   from the app's own data. That is a deliberate trade. A hosted model could hold an
   open-ended conversation about anything; this cannot. What it can do is answer questions
   about YOUR trip and YOUR destinations exactly, and actually change the itinerary — which
   is what a travel assistant is for — instantly, offline, and without anyone needing a key.

   It replaces a ladder of ~14 rigid regexes that only fired on near-exact phrasings:
   "make day 2 more relax" worked, "day 2 is too packed" did not. The pipeline here is

     normalise → extract entities → score every intent → fill slots → act → reply

   so intents are declared as vocabulary rather than as one exact sentence each, and a
   missing detail becomes a follow-up question instead of a shrug. Conversation memory
   resolves "add it to day 2" and "what about day 3?" against what was just discussed.

   Adding an intent means adding one entry to AI_INTENTS — triggers, required slots, and
   what to do. Nothing else in the pipeline needs to change.
============================================================ */

/* ---------------- 1. Normalising the input ---------------- */

const AI_CONTRACTIONS = {
  "what's":'what is', "whats":'what is', "where's":'where is', "wheres":'where is',
  "how's":'how is', "hows":'how is', "it's":'it is', "its":'it is', "i'm":'i am',
  "i've":'i have', "i'd":'i would', "i'll":'i will', "don't":'do not', "doesn't":'does not',
  "can't":'can not', "won't":'will not', "isn't":'is not', "aren't":'are not',
  "let's":'let us', "there's":'there is', "that's":'that is', "we're":'we are',
  "you're":'you are', "wanna":'want to', "gonna":'going to', "gimme":'give me',
};
const AI_NUMBER_WORDS = {
  one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, thirteen:13, fourteen:14, first:1, second:2, third:3, fourth:4,
  fifth:5, sixth:6, seventh:7, eighth:8, ninth:9, tenth:10, a:1, an:1, couple:2, few:3,
};
/** Words that carry no intent signal, so they never contribute to a match score. */
const AI_STOPWORDS = new Set(['the','a','an','of','to','in','on','at','for','and','or','my',
  'me','i','is','are','was','be','do','does','did','can','could','would','should','will',
  'please','some','any','it','this','that','there','here','with','from','get','got','have',
  'has','you','your','we','us','am','as','by','if','so','than','then','too','very','just']);

function aiNormalize(text){
  let s = String(text || '').toLowerCase().trim();
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');       // café -> cafe
  s = s.replace(/[’‘]/g, "'");
  for(const [k, v] of Object.entries(AI_CONTRACTIONS)) s = s.split(k).join(v);
  s = s.replace(/[^a-z0-9$€£¥%\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}
function aiTokens(s){ return aiNormalize(s).split(' ').filter(Boolean); }
function aiContentTokens(s){ return aiTokens(s).filter(t => !AI_STOPWORDS.has(t)); }

/* ---------------- 2. Vocabulary ---------------- */

/** Theme words map to the tags the place data actually uses, so a request phrased any of
 *  several ways still filters on the real field. */
const AI_THEME_WORDS = {
  food:       ['food','eat','eating','restaurant','restaurants','dining','dinner','lunch','breakfast','meal','meals','cuisine','hungry','foodie','culinary','street food'],
  nightlife:  ['nightlife','night','bar','bars','club','clubs','clubbing','drinks','drinking','party','pub','pubs','cocktail','cocktails','after dark'],
  culture:    ['culture','cultural','temple','temples','shrine','shrines','museum','museums','heritage','traditional','history','historic','historical','monument','monuments'],
  relax:      ['relax','relaxing','relaxed','chill','calm','quiet','slow','spa','peaceful','unwind','easy','laid back','restful','lazy'],
  romantic:   ['romantic','romance','couple','couples','honeymoon','date','anniversary','proposal'],
  hidden:     ['hidden','hidden gem','hidden gems','secret','local','locals','off the beaten','lesser known','undiscovered','underrated','authentic'],
  photography:['photo','photos','photography','photogenic','instagram','instagrammable','scenic','views','viewpoint','picture','pictures','shots'],
  adventure:  ['adventure','adventurous','hike','hiking','trek','trekking','outdoor','outdoors','adrenaline','thrill','active','climbing','sport'],
  art:        ['art','arts','gallery','galleries','design','creative','artistic','exhibition'],
  shopping:   ['shopping','shop','shops','market','markets','boutique','boutiques','souvenir','souvenirs','mall'],
  nature:     ['nature','park','parks','garden','gardens','green','forest','beach','beaches','lake','mountain','mountains','outdoors','wildlife'],
  history:    ['history','historic','historical','ancient','ruins','castle','palace','old town'],
};
const AI_STYLE_WORDS = {
  budget:   ['cheap','cheaper','budget','affordable','inexpensive','save','saving','economical','low cost','backpacker','frugal','tight'],
  luxury:   ['luxury','luxurious','splurge','high end','upscale','fancy','premium','five star','5 star','best'],
  moderate: ['moderate','mid range','balanced','normal','standard','average'],
};
const AI_TYPE_WORDS = {
  restaurant: ['restaurant','restaurants','eat','food','dining','dinner','lunch','breakfast','cafe','cafes','bar','bars'],
  hotel:      ['hotel','hotels','stay','stays','accommodation','lodging','sleep','room','rooms','hostel','resort'],
  attraction: ['attraction','attractions','sight','sights','see','do','activity','activities','thing','things','place','places','spot','spots','landmark','landmarks','museum','temple'],
};

function aiMatchLexicon(norm, lexicon){
  const found = [];
  for(const [key, words] of Object.entries(lexicon)){
    if(words.some(w => w.includes(' ') ? norm.includes(w) : new RegExp(`\\b${w}\\b`).test(norm))) found.push(key);
  }
  return found;
}

/* ---------------- 3. Fuzzy entity matching ---------------- */

/** Token-overlap similarity, tolerant of word order and of extra words on either side, so
 *  "the senso ji temple" still finds "Senso-ji Temple". Returns 0..1. */
function aiSimilarity(needle, hay){
  const a = new Set(aiContentTokens(needle)), b = new Set(aiContentTokens(hay));
  if(!a.size || !b.size) return 0;
  let hits = 0;
  for(const t of a){
    if(b.has(t)) { hits++; continue; }
    // A long token that is a prefix of a longer one still counts ("photo" ~ "photography").
    for(const u of b){ if(t.length >= 4 && (u.startsWith(t) || t.startsWith(u))){ hits += 0.8; break; } }
  }
  const prec = hits / a.size, rec = hits / b.size;
  return prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
}
/** Words that appear in place names but identify nothing on their own. Matching on these
 *  would make "add a temple" pick whichever temple sorted first. */
const AI_GENERIC_NAME_WORDS = new Set(['temple','shrine','museum','market','hotel','inn',
  'restaurant','cafe','bar','park','garden','gardens','tower','palace','castle','church',
  'cathedral','bridge','beach','district','quarter','street','square','house','gallery',
  'centre','center','city','old','new','grand','royal','the','walk','tour','village']);

/** Best item the text names. People type "Senso-ji", not "Senso-ji Temple", so this scores
 *  by how many of a name's DISTINCTIVE words appear — dropping the generic type word — rather
 *  than demanding the whole string. A literal full-name hit still outranks everything. */
function aiFindNamed(norm, items, minScore){
  const textTokens = new Set(aiContentTokens(norm));
  let best = null, bestScore = minScore || 0.55;
  for(const it of items){
    const name = aiNormalize(it.name || '');
    if(!name || name.length < 3) continue;
    let score = 0;
    if(norm.includes(name)){
      score = 2 + name.length / 100;                    // longest literal match wins
    } else {
      const distinctive = aiContentTokens(name).filter(t => !AI_GENERIC_NAME_WORDS.has(t));
      if(!distinctive.length) continue;
      let hit = 0, strong = false;
      for(const t of distinctive){
        if(textTokens.has(t)){ hit++; if(t.length >= 4) strong = true; continue; }
        for(const u of textTokens){                     // "sensoji" ~ "senso-ji"
          if(t.length >= 5 && u.length >= 5 && (u.startsWith(t) || t.startsWith(u))){
            hit++; strong = true; break;
          }
        }
      }
      // At least one substantial word must match, so a single short common token cannot
      // drag in an unrelated place.
      if(!strong) continue;
      score = hit / distinctive.length;
    }
    if(score > bestScore){ best = it; bestScore = score; }
  }
  return best;
}

/* ---------------- 4. Conversation memory ---------------- */

/** What "it", "there" and "that day" refer to. Without this the assistant cannot hold a
 *  two-turn exchange: "find hidden gems in Kyoto" / "add the first one to day 2". */
const aiMemory = { destId:null, dayIndex:null, placeId:null, lastList:[], pending:null };

function aiRememberList(places){
  aiMemory.lastList = places.map(p => p.id);
  if(places.length) aiMemory.placeId = places[0].id;
}
function aiResetPending(){ aiMemory.pending = null; }

/* ---------------- 5. Entity extraction ---------------- */

/** Ordinal reference into the last list the assistant offered ("add the second one").
 *  Reports an out-of-range ordinal separately from "no ordinal here", so asking for the
 *  second of a one-item list gets a real answer instead of a shrug. */
function aiOrdinalFromList(norm){
  const m = norm.match(/\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\b/);
  if(!m) return null;
  if(!aiMemory.lastList.length) return null;
  const word = m[1];
  const idx = word === 'last' ? aiMemory.lastList.length - 1
            : ({first:0,'1st':0, second:1,'2nd':1, third:2,'3rd':2, fourth:3,'4th':3, fifth:4,'5th':4})[word];
  const id = aiMemory.lastList[idx];
  if(!id){ aiMemory.ordinalMiss = { asked: word, have: aiMemory.lastList.length }; return null; }
  return placeById(id);
}

function aiExtract(text, trip){
  aiMemory.ordinalMiss = null;
  const norm = aiNormalize(text);
  const ents = { norm, raw:text, tokens:aiContentTokens(text) };

  // --- destination.
  // The phrase after "to"/"in" is captured separately from the lookup, because a destination
  // the app has never seen still needs to win over whatever trip happens to be open:
  // "plan a 5 day trip to Lisbon" was resizing an open Tokyo trip, since Lisbon matched
  // nothing curated and the open trip silently took its place.
  const destPhrase = (norm.match(/\b(?:trip|travel|holiday|vacation|fly|go|going|days?|nights?)\s+(?:to|in)\s+([a-z][a-z\s'-]{2,30}?)(?:\s+(?:for|in|on|next|this|with|and)\b|$)/)
                   || norm.match(/\b(?:visit|explore|see)\s+([a-z][a-z\s'-]{2,30}?)(?:\s+(?:for|in|on|next|this|with|and)\b|$)/))?.[1];
  ents.destPhrase = destPhrase ? destPhrase.trim() : null;

  ents.dest = aiFindNamed(norm, DESTINATIONS.filter(d => !d.id.startsWith('gen-')), 0.75)
           || (trip ? destForTrip(trip) : null)
           || (aiMemory.destId ? DESTINATIONS.find(d => d.id === aiMemory.destId) : null);
  if(ents.dest) aiMemory.destId = ents.dest.id;

  // --- day: "day 2", "the last day", "tomorrow", or the day currently open in the planner
  let dayIdx = null;
  let m = norm.match(/\bday\s*(\d+)\b/) || norm.match(/\b(\d+)(?:st|nd|rd|th)?\s+day\b/);
  if(m) dayIdx = parseInt(m[1], 10) - 1;
  else if(/\b(last|final)\s+day\b/.test(norm) && trip) dayIdx = trip.days.length - 1;
  else if(/\bfirst\s+day\b/.test(norm)) dayIdx = 0;
  else {
    const w = norm.match(/\bday\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
    if(w) dayIdx = AI_NUMBER_WORDS[w[1]] - 1;
  }
  if(dayIdx === null && /\b(it|that|this|there)\b/.test(norm) && aiMemory.dayIndex !== null) dayIdx = aiMemory.dayIndex;
  if(dayIdx === null && trip && typeof plannerState !== 'undefined') dayIdx = plannerState.day;
  ents.dayIndex = dayIdx;
  if(m) aiMemory.dayIndex = dayIdx;

  // --- how many days / how many results
  const dm = norm.match(/\b(\d+)\s*(?:days?|nights?)\b/) ||
             norm.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:days?|nights?)\b/);
  ents.days = dm ? (parseInt(dm[1], 10) || AI_NUMBER_WORDS[dm[1]] || null) : null;

  // --- money ("under $50", "less than 100")
  const mm = norm.match(/(?:under|below|less than|max|maximum|up to|within)\s*\$?\s*(\d+)/);
  ents.maxPrice = mm ? parseInt(mm[1], 10) : null;
  const bm = norm.match(/budget\s*(?:of|is)?\s*\$?\s*(\d{2,})/);
  ents.budgetTotal = bm ? parseInt(bm[1], 10) : null;

  ents.themes = aiMatchLexicon(norm, AI_THEME_WORDS);
  ents.styles = aiMatchLexicon(norm, AI_STYLE_WORDS);
  ents.types  = aiMatchLexicon(norm, AI_TYPE_WORDS);
  ents.free   = /\bfree\b|\bno cost\b|\bcosts? nothing\b|\bwithout spending\b/.test(norm);

  // --- a specific place: only search the relevant destination's own places
  const pool = ents.dest ? PLACES.filter(p => p.destId === ents.dest.id) : PLACES;
  ents.place = aiOrdinalFromList(norm) || aiFindNamed(norm, pool, 0.7);
  if(!ents.place && /\b(it|that one|this one|there)\b/.test(norm) && aiMemory.placeId){
    ents.place = placeById(aiMemory.placeId);
  }
  if(ents.place) aiMemory.placeId = ents.place.id;

  return ents;
}

/* ---------------- 6. Reply helpers ---------------- */

function aiBullet(places, opts){
  const showPrice = !opts || opts.price !== false;
  return places.map(p => {
    const bits = [];
    if(p.cuisine) bits.push(p.cuisine);
    else if(p.category) bits.push(p.category);
    if(p.rating) bits.push('★' + p.rating);
    if(showPrice && p.price != null) bits.push(p.price ? fmt$(p.price) : 'free');
    if(p.stars) bits.push(p.stars + '★');
    if(p.guestRating) bits.push(p.guestRating + '/10');
    return `• ${p.name}${bits.length ? ` (${bits.join(', ')})` : ''}${p.desc ? ` — ${p.desc}` : ''}`;
  }).join('\n');
}
/** Ranks places for a request: theme match first, then rating, honouring price limits. */
function aiPickPlaces(destId, type, ents, limit){
  let pool = placesFor(destId, type);
  if(ents.free) pool = pool.filter(p => !p.price);
  if(ents.maxPrice != null) pool = pool.filter(p => (p.price || 0) <= ents.maxPrice);
  if(ents.styles.includes('budget')) pool = pool.slice().sort((a,b)=>(a.price||0)-(b.price||0));
  if(ents.styles.includes('luxury')) pool = pool.slice().sort((a,b)=>(b.price||0)-(a.price||0));
  // "food" comes from the word "restaurants" as much as from a real preference, so it never
  // counts as the specific theme the user asked for.
  const specific = ents.themes.filter(t => t !== 'food');
  const themed = specific.length
    ? pool.filter(p => (p.tags || []).some(t => specific.includes(t)))
    : [];
  const rank = arr => arr.slice().sort((a,b)=>(b.rating||0)-(a.rating||0));
  // When a specific theme was asked for, return ONLY things that match it. Padding the list
  // with unrelated places to reach a round number puts a falafel counter under the heading
  // "romantic" — better to show two real answers than four with two of them wrong.
  const out = specific.length
    ? rank(themed).slice(0, limit || 4)
    : rank(pool).slice(0, limit || 4);
  aiRememberList(out);
  return out;
}
function aiDayLabel(i){ return `Day ${i + 1}`; }
function aiNeedTrip(){
  return `You don't have a trip open. Open one from **My Trips**, or tell me where you're going — "plan 4 days in Lisbon" and I'll build it.`;
}
function aiApplyToTrip(trip, note){
  if(note) logActivity(trip, note);
  saveState();
  if(typeof plannerState !== 'undefined' && plannerState.tripId === trip.id){
    renderPlannerView(trip.id, (location.hash.split('/')[3]) || 'itinerary');
  }
}

/* ---------------- 7. Intent registry ----------------
   `triggers` are phrases; a match scores its length in words, so a specific multi-word
   phrase outranks a single generic keyword. `needs` names slots that must be present —
   a missing one becomes a question rather than a wrong answer. */

const AI_INTENTS = [
  /* ----- meta ----- */
  { id:'help', weight:1.1,
    triggers:['help','what can you do','what do you do','commands','how do you work','who are you','what can i ask'],
    run(){ return { reply:
`Here's what I can do — all of it offline, no key needed:

**Plan** — "plan 5 days in Rome", "make this trip 3 days"
**Edit** — "add Senso-ji to day 2", "remove the Louvre", "move it to day 3", "clear day 1"
**Tune** — "optimise my route", "make day 2 more relaxed", "day 1 is too packed", "add nightlife to day 3"
**Money** — "make this cheaper", "what will this cost?", "how's my budget?"
**Find** — "hidden gems in Bali", "cheap eats under $15", "romantic restaurants", "free things to do", "what if it rains?"
**Ask** — "when should I visit?", "do I need a visa?", "what's the local time?", "how do I get around?"

I remember what we just talked about, so "add the second one to day 2" works.` }; } },

  { id:'courtesy', weight:3,
    triggers:['thanks','thank you','thankyou','cheers','ok','okay','cool','nice','great','perfect','awesome','sounds good','got it','yes','yep','no','nope'],
    run(){ const lines = ['Happy to help — what next?', 'Anything else you want changed?',
      'Got it. Want me to tweak anything else?', 'Sure thing. Ask me for "help" any time.'];
      return { reply: lines[Math.floor(Math.random() * lines.length)] }; } },

  /* ----- destination facts ----- */
  { id:'best_time', weight:1,
    triggers:['best time to visit','when should i visit','when to go','best season','best month','when is the best time'],
    needs:['dest'],
    run(c){ const d = c.dest;
      return { reply:`**${d.name}** is best from ${d.bestTime}.\n\n${d.weather}\n\nA typical visit runs ${d.travelInfo.recommendedDays}.` }; } },

  { id:'visa', weight:1.2, triggers:['visa','entry requirement','entry requirements','passport','do i need a visa'], needs:['dest'],
    run(c){ return { reply:`**Entry — ${c.dest.name}**\n\n${c.dest.travelInfo.visa}` }; } },

  { id:'safety', weight:1.2, triggers:['safe','safety','dangerous','is it safe','crime'], needs:['dest'],
    run(c){ return { reply:`**Safety — ${c.dest.name}**\n\n${c.dest.travelInfo.safety}` }; } },

  { id:'transport', weight:1.2,
    triggers:['get around','getting around','public transport','transport','metro','subway','taxi','how do i travel around'],
    needs:['dest'],
    run(c){ return { reply:`**Getting around ${c.dest.name}**\n\n${c.dest.travelInfo.localTransport}` }; } },

  { id:'etiquette', weight:1.3, triggers:['etiquette','customs','rude','tipping','tip','manners','local customs','what should i not do'], needs:['dest'],
    run(c){ return { reply:`**Local etiquette — ${c.dest.name}**\n\n${c.dest.travelInfo.etiquette}` }; } },

  { id:'language', weight:1.2, triggers:['language','what language','do they speak'], needs:['dest'],
    run(c){ return { reply:`They speak **${c.dest.language}** in ${c.dest.name}. The currency is ${c.dest.currency}.` }; } },

  { id:'localtime', weight:1.3, triggers:['local time','what time is it','time zone','timezone','time difference','how many hours ahead','how many hours behind'], needs:['dest'],
    run(c){ const clock = destinationClock(c.dest);
      if(!clock) return { reply:`I don't have a reliable time zone for ${c.dest.name}.` };
      const diff = clock.diff === 0 ? 'the same as yours'
        : `${Math.abs(clock.diff)}h ${clock.diff > 0 ? 'ahead of' : 'behind'} you`;
      return { reply:`It's **${clock.time12}** in ${c.dest.name} right now (${clock.label}) — ${diff}.` }; } },

  { id:'weather', weight:1.2, triggers:['weather','temperature','how hot','how cold','rain','climate','what is the weather'], needs:['dest'],
    run(c){ return { reply:`**${c.dest.name}**\n\n${c.dest.weather}\n\nBest window: ${c.dest.bestTime}.` }; } },

  { id:'daily_cost', weight:1.4,
    triggers:['how much does it cost','daily budget','cost per day','per day','how much per day','how expensive','how much money','average cost','how much should i budget','price per day'],
    needs:['dest'],
    run(c){ const b = c.dest.avgDailyBudget;
      return { reply:`**Daily budget in ${c.dest.name}** (per person)\n\n• Budget — ${fmt$(b.budget)}/day\n• Moderate — ${fmt$(b.moderate)}/day\n• Luxury — ${fmt$(b.luxury)}/day\n\nCurrency: ${c.dest.currency}.` }; } },

  { id:'how_long', weight:1.5, triggers:['how many days should','how long should i stay','how many days do i need','how long to spend'], needs:['dest'],
    run(c){ return { reply:`For ${c.dest.name} I'd plan **${c.dest.travelInfo.recommendedDays}**.\n\nSay "plan ${(c.dest.travelInfo.recommendedDays.match(/\d+/) || [4])[0]} days in ${c.dest.name}" and I'll build the itinerary.` }; } },

  /* ----- discovery ----- */
  { id:'find_food', weight:1.2,
    triggers:['where should i eat','restaurants','places to eat','good food','best food','food spots','where to eat','hungry','dinner','lunch','breakfast','cheap eats','fine dining'],
    needs:['dest'],
    run(c){ const picks = aiPickPlaces(c.dest.id, 'restaurant', c.ents, 4);
      if(!picks.length){
        // Nothing under the cap is a real answer, but a dead end is not: show what is closest.
        const cheapest = placesFor(c.dest.id, 'restaurant').slice().sort((a,b)=>(a.price||0)-(b.price||0)).slice(0,3);
        if(!cheapest.length) return { reply:`I don't have restaurants listed for ${c.dest.name} yet.` };
        aiRememberList(cheapest);
        return { reply:`Nothing in ${c.dest.name} comes in under ${fmt$(c.ents.maxPrice)}. The cheapest I have:\n\n${aiBullet(cheapest)}` };
      }
      const specific = c.ents.themes.filter(t => t !== 'food');
      const qual = c.ents.maxPrice ? ` under ${fmt$(c.ents.maxPrice)}` : specific.length ? ` — ${specific[0]}` : '';
      return { reply:`**Where to eat in ${c.dest.name}${qual}**\n\n${aiBullet(picks)}\n\nWant one in your plan? Say "add ${picks[0].name} to day 1".` }; } },

  { id:'find_hotels', weight:1.3, triggers:['where should i stay','hotels','accommodation','places to stay','where to stay','best hotel'], needs:['dest'],
    run(c){ const picks = aiPickPlaces(c.dest.id, 'hotel', c.ents, 4);
      if(!picks.length) return { reply:`No stays listed for ${c.dest.name} yet.` };
      return { reply:`**Where to stay in ${c.dest.name}**\n\n${aiBullet(picks)}` }; } },

  { id:'find_things', weight:0.9,
    triggers:['what should i do','things to do','what to do','what can i do','attractions','sights','must see','top things','recommend','suggestions','ideas','show me','hidden gem','hidden gems','photo spots','photogenic','instagrammable','off the beaten','local favourites','local favorites','viewpoints','best views'],
    needs:['dest'],
    run(c){ const picks = aiPickPlaces(c.dest.id, 'attraction', c.ents, 5);
      const specific = c.ents.themes.filter(t => t !== 'food');
      const label = specific.length ? `${specific[0]} spots`.replace(/^\w/, m=>m.toUpperCase()) : 'Top things to do';
      if(!picks.length){
        const any = placesFor(c.dest.id, 'attraction').sort((a,b)=>(b.rating||0)-(a.rating||0)).slice(0,4);
        aiRememberList(any);
        if(!any.length) return { reply:`I don't have places listed for ${c.dest.name} yet.` };
        return { reply:`Nothing in ${c.dest.name} is tagged ${specific[0] || 'that'}. The top-rated spots instead:\n\n${aiBullet(any)}` };
      }
      return { reply:`**${label} in ${c.dest.name}**\n\n${aiBullet(picks)}\n\nSay "add the first one to day 1" to drop it into your plan.` }; } },

  { id:'rainy_day', weight:1.6, triggers:['rainy day','if it rains','raining','bad weather','indoor','inside','wet day'], needs:['dest'],
    run(c){ const outdoor = ['Beach','Viewpoint','Hiking','Nature','Wine','Adventure','Park'];
      const picks = placesFor(c.dest.id, 'attraction')
        .filter(p => !outdoor.includes(p.category)).sort((a,b)=>(b.rating||0)-(a.rating||0)).slice(0,4);
      aiRememberList(picks);
      return { reply:`**Rainy-day picks in ${c.dest.name}**\n\n${aiBullet(picks)}` }; } },

  { id:'free_things', weight:1.6, triggers:['free things','free stuff','free activities','without spending','costs nothing','no money','free to visit'], needs:['dest'],
    run(c){ const picks = placesFor(c.dest.id, 'attraction')
        .filter(p => !p.price).sort((a,b)=>(b.rating||0)-(a.rating||0)).slice(0,5);
      aiRememberList(picks);
      if(!picks.length) return { reply:`Everything listed in ${c.dest.name} has an entry cost — but wandering the neighbourhoods is always free.` };
      return { reply:`**Free in ${c.dest.name}**\n\n${aiBullet(picks, {price:false})}` }; } },

  /* ----- planning ----- */
  { id:'plan_trip', weight:1.8,
    triggers:['plan a trip','plan my trip','plan me','build me an itinerary','build an itinerary','create a trip','make me a trip','plan','itinerary for','take me to','i want to go'],
    needs:['dest'],
    run(c){
      // A destination named in the message always wins over the trip that happens to be open.
      let d = c.dest;
      if(c.ents.destPhrase){
        const named = findDestination(c.ents.destPhrase);
        if(named) { d = named; aiMemory.destId = d.id; }
      }
      if(!d) return { reply:`Where would you like to go? Name any city and I'll build the itinerary.` };
      const days = c.ents.days || parseInt((d.travelInfo.recommendedDays.match(/\d+/) || [4])[0], 10);
      const style = c.ents.styles[0] || 'moderate';
      if(c.trip && c.trip.destId === d.id && c.ents.days){
        adjustDayCount(c.trip, days);
        aiApplyToTrip(c.trip, `Assistant resized the trip to ${days} days.`);
        return { reply:`Updated **${c.trip.title}** to ${days} days and filled the new days with top-rated picks.` };
      }
      const start = toDateInput(new Date(Date.now() + 21 * 86400000));
      const t = buildAutoTrip(d.id, `${d.name} Trip`, start, addDays(start, days - 1), 2, style);
      STATE.trips.unshift(t); saveState();
      navigate(`#/trip/${t.id}`);
      return { reply:`Built you a **${days}-day ${style} trip to ${d.name}** — about ${fmt$(t.budget.total)} total for 2 travellers.\n\nDrag stops to reorder, or ask me to "optimise the route" or "make day 2 more relaxed".` }; } },

  { id:'trip_summary', weight:1.5,
    triggers:['what is on day','whats on day','what about day','how about day','summarise my trip','summarize my trip','what does my trip look like','show my itinerary','my plan','what am i doing','my itinerary'],
    needs:['trip'],
    run(c){ const trip = c.trip;
      if(/\bday\b/.test(c.ents.norm) && c.ents.dayIndex != null){
        const day = trip.days[c.ents.dayIndex];
        if(!day) return { reply:`This trip only has ${trip.days.length} days.` };
        if(!day.stops.length) return { reply:`${aiDayLabel(c.ents.dayIndex)} is empty. Want me to fill it? Say "add culture to day ${c.ents.dayIndex + 1}".` };
        const cost = day.stops.reduce((s,x)=>s+(x.cost||0),0);
        return { reply:`**${aiDayLabel(c.ents.dayIndex)}** (${day.date})\n\n${day.stops.map(s=>`• ${s.time} — ${s.name}${s.cost?` (${fmt$(s.cost)})`:''}`).join('\n')}\n\n${day.stops.length} stops, about ${fmt$(cost)} per person.` };
      }
      const total = trip.days.reduce((s,d)=>s+d.stops.reduce((a,x)=>a+(x.cost||0),0),0);
      return { reply:`**${trip.title}** — ${trip.days.length} days in ${trip.destName}\n\n${trip.days.map((d,i)=>`• ${aiDayLabel(i)}: ${d.stops.length ? d.stops.map(s=>s.name).join(', ') : 'nothing yet'}`).join('\n')}\n\nPlanned spend so far: ${fmt$(total)} per person.` }; } },

  { id:'budget_status', weight:1.5,
    triggers:['how is my budget','budget breakdown','what will this cost','how much will this cost','am i over budget','total cost','how much is my trip'],
    needs:['trip'],
    run(c){ const trip = c.trip;
      const planned = trip.days.reduce((s,d)=>s+d.stops.reduce((a,x)=>a+(x.cost||0),0),0) * trip.travelers;
      const extra = (trip.budget.expenses || []).reduce((s,e)=>s+(e.amount||0),0);
      const spent = planned + extra;
      const left = trip.budget.total - spent;
      return { reply:`**${trip.title} — budget**\n\n• Budget: ${fmt$(trip.budget.total)} (${trip.budget.style})\n• Planned stops: ${fmt$(planned)} for ${trip.travelers} traveller(s)\n• Added expenses: ${fmt$(extra)}\n• ${left >= 0 ? `Remaining: ${fmt$(left)}` : `**Over by ${fmt$(-left)}**`}\n\n${left < 0 ? 'Say "make this cheaper" and I\'ll swap in lower-cost picks.' : 'Comfortable — say "make it luxury" if you want to spend it.'}` }; } },

  /* ----- itinerary edits ----- */
  { id:'optimize_route', weight:1.8,
    triggers:['optimise my route','optimize my route','optimise route','optimize route','optimise','optimize','reduce travel time','less travelling','rearrange my itinerary','reorder my day','shortest route','too much travelling'],
    needs:['trip'],
    run(c){ const trip = c.trip, i = c.ents.dayIndex ?? 0, day = trip.days[i];
      if(!day) return { reply:`This trip only has ${trip.days.length} days.` };
      if(day.stops.length < 3) return { reply:`${aiDayLabel(i)} has only ${day.stops.length} stop(s) — add a couple more and I can shorten the route.` };
      const before = totalDistance(day.stops);
      day.stops = nearestNeighborOrder(day.stops);
      recomputeDayTimes(day);
      const after = totalDistance(day.stops);
      aiApplyToTrip(trip, `Assistant optimised the route for ${aiDayLabel(i)}.`);
      const saved = before - after;
      return { reply: saved > 0.05
        ? `Reordered **${aiDayLabel(i)}** — travel drops from ${before.toFixed(1)} km to ${after.toFixed(1)} km, saving ${saved.toFixed(1)} km.`
        : `**${aiDayLabel(i)}** was already in a sensible order (${after.toFixed(1)} km of travel).` }; } },

  { id:'relax_day', weight:1.8,
    triggers:['more relaxed','relaxed','relax day','less busy','too packed','too much','slow down','lighten','fewer stops','too rushed','more chill','breathing room','less hectic','easier day'],
    needs:['trip'],
    run(c){ const trip = c.trip, i = c.ents.dayIndex ?? 0, day = trip.days[i];
      if(!day) return { reply:`This trip only has ${trip.days.length} days.` };
      const removed = makeDayRelaxed(day);
      recomputeDayTimes(day);
      aiApplyToTrip(trip, `Assistant lightened ${aiDayLabel(i)}.`);
      return { reply: removed.length
        ? `Lightened **${aiDayLabel(i)}** — dropped ${removed.join(', ')}. ${day.stops.length} stops left.`
        : `**${aiDayLabel(i)}** is already easy-going with ${day.stops.length} stop(s).` }; } },

  { id:'add_theme', weight:1.7,
    triggers:['add more','add some','more nightlife','more culture','more food','add nightlife','add culture','add food','add art','add shopping','fill day','add something'],
    needs:['trip'],
    run(c){ const trip = c.trip, i = c.ents.dayIndex ?? 0;
      if(!trip.days[i]) return { reply:`This trip only has ${trip.days.length} days.` };
      const themes = c.ents.themes.length ? c.ents.themes : ['culture'];
      const used = new Set(trip.days.flatMap(d => d.stops.map(s => s.placeId)));
      const picks = PLACES.filter(p => p.destId === trip.destId && !used.has(p.id) &&
                       (p.tags || []).some(t => themes.includes(t)))
                    .sort((a,b)=>(b.rating||0)-(a.rating||0)).slice(0,2);
      if(!picks.length) return { reply:`I've run out of unused ${themes[0]} spots in ${trip.destName} for this trip.` };
      picks.forEach(p => addPlaceToTripSilent(trip, i, p));
      aiApplyToTrip(trip, `Assistant added ${themes[0]} picks to ${aiDayLabel(i)}.`);
      aiRememberList(picks);
      return { reply:`Added **${picks.map(p=>p.name).join('** and **')}** to ${aiDayLabel(i)}.` }; } },

  { id:'add_place', weight:2.0,
    triggers:['add','put','include','book','schedule','drop in'],
    needs:['trip','place'],
    run(c){ const trip = c.trip, i = c.ents.dayIndex ?? 0, p = c.ents.place;
      if(!trip.days[i]) return { reply:`This trip only has ${trip.days.length} days.` };
      if(p.destId !== trip.destId) return { reply:`${p.name} isn't in ${trip.destName} — it's in ${(DESTINATIONS.find(d=>d.id===p.destId)||{}).name || 'another destination'}.` };
      if(trip.days.some(d => d.stops.some(s => s.placeId === p.id)))
        return { reply:`**${p.name}** is already in this trip.` };
      addPlaceToTripSilent(trip, i, p);
      aiApplyToTrip(trip, `Assistant added ${p.name} to ${aiDayLabel(i)}.`);
      return { reply:`Added **${p.name}** to ${aiDayLabel(i)}${p.price ? ` (${fmt$(p.price)})` : ''}.` }; } },

  { id:'remove_place', weight:2.1,
    triggers:['remove','delete','drop','take out','get rid of','cancel','do not want'],
    needs:['trip','place'],
    run(c){ const trip = c.trip, p = c.ents.place;
      let found = null;
      trip.days.forEach((d, di) => {
        const idx = d.stops.findIndex(s => s.placeId === p.id);
        if(idx >= 0 && !found) found = { di, idx, stop: d.stops[idx] };
      });
      if(!found) return { reply:`**${p.name}** isn't in your itinerary.` };
      const snapshot = JSON.parse(JSON.stringify(trip.days[found.di].stops));
      trip.days[found.di].stops.splice(found.idx, 1);
      recomputeDayTimes(trip.days[found.di]);
      aiApplyToTrip(trip, `Assistant removed ${p.name} from ${aiDayLabel(found.di)}.`);
      toastUndo(`Removed ${p.name}.`, () => { trip.days[found.di].stops = snapshot; });
      return { reply:`Removed **${p.name}** from ${aiDayLabel(found.di)}. (There's an Undo in the toast if that was wrong.)` }; } },

  { id:'move_place', weight:2.2,
    triggers:['move','shift','reschedule','change to day','put it on day','swap to day'],
    needs:['trip','place'],
    run(c){ const trip = c.trip, p = c.ents.place, to = c.ents.dayIndex;
      if(to == null || !trip.days[to]) return { reply:`Which day should I move **${p.name}** to? This trip has ${trip.days.length} days.` };
      let from = -1, stop = null;
      trip.days.forEach((d, di) => { const s = d.stops.find(x => x.placeId === p.id); if(s && from < 0){ from = di; stop = s; } });
      if(from < 0) return { reply:`**${p.name}** isn't in your itinerary yet — say "add ${p.name} to day ${to + 1}".` };
      if(from === to) return { reply:`**${p.name}** is already on ${aiDayLabel(to)}.` };
      trip.days[from].stops = trip.days[from].stops.filter(s => s.placeId !== p.id);
      trip.days[to].stops.push(stop);
      recomputeDayTimes(trip.days[from]); recomputeDayTimes(trip.days[to]);
      aiApplyToTrip(trip, `Assistant moved ${p.name} to ${aiDayLabel(to)}.`);
      return { reply:`Moved **${p.name}** from ${aiDayLabel(from)} to ${aiDayLabel(to)}.` }; } },

  { id:'clear_day', weight:2.0,
    triggers:['clear day','empty day','wipe day','start day over','remove everything from day'],
    needs:['trip'],
    run(c){ const trip = c.trip, i = c.ents.dayIndex ?? 0, day = trip.days[i];
      if(!day) return { reply:`This trip only has ${trip.days.length} days.` };
      if(!day.stops.length) return { reply:`${aiDayLabel(i)} is already empty.` };
      const snapshot = JSON.parse(JSON.stringify(day.stops));
      const n = day.stops.length;
      day.stops = [];
      aiApplyToTrip(trip, `Assistant cleared ${aiDayLabel(i)}.`);
      toastUndo(`Cleared ${aiDayLabel(i)}.`, () => { day.stops = snapshot; });
      return { reply:`Cleared **${aiDayLabel(i)}** — ${n} stop(s) removed. Undo is in the toast.` }; } },

  { id:'make_cheaper', weight:1.9,
    triggers:['make it cheaper','cheaper alternatives','reduce spending','save money','too expensive','lower the cost','make this cheaper','cut costs','budget version'],
    needs:['trip'],
    run(c){ const trip = c.trip, dest = destForTrip(trip);
      trip.budget.style = 'budget';
      trip.budget.total = Math.round(dest.avgDailyBudget.budget * trip.days.length * trip.travelers);
      const changed = swapForCheaperAlternatives(trip, c.ents.dayIndex ?? 0, 3);
      aiApplyToTrip(trip, 'Assistant switched the trip to budget style.');
      return { reply:`Switched **${trip.title}** to budget style (~${fmt$(trip.budget.total)} total)${
        changed.length ? ` and swapped ${changed.map(x=>`${x.from} → ${x.to}`).join(', ')}` : ''}.` }; } },

  { id:'make_luxury', weight:1.9,
    triggers:['make it luxury','splurge','upgrade my trip','more upscale','treat myself','luxury version'],
    needs:['trip'],
    run(c){ const trip = c.trip, dest = destForTrip(trip);
      trip.budget.style = 'luxury';
      trip.budget.total = Math.round(dest.avgDailyBudget.luxury * trip.days.length * trip.travelers);
      aiApplyToTrip(trip, 'Assistant switched the trip to luxury style.');
      const top = placesFor(trip.destId, 'hotel').sort((a,b)=>(b.price||0)-(a.price||0))[0];
      return { reply:`**${trip.title}** is now luxury style — budget raised to ${fmt$(trip.budget.total)}.${
        top ? `\n\nFor a splurge stay, ${top.name} runs ${fmt$(top.price)}/night.` : ''}` }; } },
];

/* ---------------- 8. Scoring ---------------- */

/** Scores every intent against the message and returns them best-first.
 *  A trigger's score is its word count, so "best time to visit" (4) beats a bare "visit" —
 *  specific phrasings win over generic keywords without any manual ordering. */
function aiScoreIntents(norm){
  const scored = [];
  for(const intent of AI_INTENTS){
    let best = 0;
    for(const trig of intent.triggers){
      const words = trig.split(' ').length;
      if(trig.includes(' ')){
        if(norm.includes(trig)) best = Math.max(best, words * 2);
      } else if(new RegExp(`\\b${trig}\\b`).test(norm)){
        best = Math.max(best, 1);
      }
    }
    if(best > 0) scored.push({ intent, score: best * (intent.weight || 1) });
  }
  return scored.sort((a,b) => b.score - a.score);
}

/* ---------------- 9. Entry point ---------------- */

/** Answers one message. Always returns a reply — the engine never "fails to understand"
 *  without offering the user somewhere to go next. */
function assistantRespond(text, trip){
  const ents = aiExtract(text, trip);
  const norm = ents.norm;

  // A pending clarification takes priority: the user is answering our question.
  if(aiMemory.pending){
    const p = aiMemory.pending;
    aiResetPending();
    if(p.kind === 'day'){
      const m = norm.match(/\b(\d+)\b/);
      if(m){
        ents.dayIndex = parseInt(m[1], 10) - 1;
        return aiRun(p.intent, { ents, trip: trip || getTrip(plannerState.tripId), dest: ents.dest });
      }
    }
    if(p.kind === 'dest' && ents.dest){
      return aiRun(p.intent, { ents, trip, dest: ents.dest });
    }
  }

  const ranked = aiScoreIntents(norm);
  let missingPlaceFor = null;
  for(const { intent } of ranked){
    const needs = intent.needs || [];
    const ctx = { ents, trip, dest: ents.dest };
    if(needs.includes('trip') && !trip) return { reply: aiNeedTrip() };
    if(needs.includes('dest') && !ents.dest){
      aiMemory.pending = { kind:'dest', intent };
      return { reply:`Which destination? Name any city — Tokyo, Lisbon, anywhere.` };
    }
    if(needs.includes('place') && !ents.place){
      missingPlaceFor = missingPlaceFor || intent;
      continue;
    }
    return aiRun(intent, ctx);
  }

  // An action that names no recognisable place deserves a specific question.
  if(missingPlaceFor){
    if(aiMemory.ordinalMiss){
      const { asked, have } = aiMemory.ordinalMiss;
      const only = have === 1 ? placeById(aiMemory.lastList[0]) : null;
      return { reply: only
        ? `I only listed one — did you mean **${only.name}**?`
        : `I only listed ${have}, so there's no "${asked}" one. Name the place and I'll ${missingPlaceFor.id.split('_')[0]} it.` };
    }
    const recent = aiMemory.lastList.map(id => placeById(id)).filter(Boolean).slice(0, 4);
    return { reply: recent.length
      ? `Which place did you mean? I last showed you:\n\n${recent.map(p => `• ${p.name}`).join('\n')}`
      : `Which place? Name it — for example "add Senso-ji to day 2".` };
  }

  // Nothing matched a trigger, but a theme plus a destination is still a clear request
  // ("anything romantic in Paris?"). Route it to discovery rather than shrugging.
  if(ents.dest && (ents.themes.length || ents.types.length || ents.free || ents.maxPrice != null)){
    const wantsFood  = ents.types.includes('restaurant') || ents.themes.includes('food');
    const wantsHotel = ents.types.includes('hotel');
    const id = wantsHotel ? 'find_hotels' : wantsFood ? 'find_food' : 'find_things';
    const intent = AI_INTENTS.find(i => i.id === id);
    if(intent) return aiRun(intent, { ents, trip, dest: ents.dest });
  }

  return { reply: aiFallback(ents, trip) };
}

function aiRun(intent, ctx){
  try {
    return intent.run(ctx) || { reply:`Something went wrong running that.` };
  } catch(e){
    return { reply:`I hit an error doing that (${e.message}). Try rephrasing, or ask me for "help".` };
  }
}

/** No intent matched. Say something useful about what IS known rather than a shrug. */
function aiFallback(ents, trip){
  if(ents.place){
    const p = ents.place;
    return `**${p.name}** — ${p.category || p.cuisine || 'place'}${p.rating ? `, ★${p.rating}` : ''}${p.price ? `, ${fmt$(p.price)}` : ''}\n\n${p.desc || ''}\n\nSay "add ${p.name} to day 1" to put it in your plan.`;
  }
  if(trip){
    return `I'm not sure what you meant. For **${trip.title}** I can optimise the route, rebalance the budget, add or remove stops, or summarise any day.\n\nAsk me for "help" to see everything.`;
  }
  if(ents.dest){
    const d = ents.dest;
    return `I'm not sure what you meant about **${d.name}**. I can tell you when to visit, what it costs per day, what to see, where to eat, or build you an itinerary.\n\nTry "plan 4 days in ${d.name}".`;
  }
  return `I didn't catch that. Try "plan 5 days in Rome", "hidden gems in Bali", or ask me for "help" to see what I can do.`;
}
