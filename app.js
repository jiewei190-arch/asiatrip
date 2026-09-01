/* ============================================================
   TripFlow — application logic
============================================================ */
'use strict';

/* ---------------- utilities ---------------- */
const $ = id => document.getElementById(id);
const $$ = sel => Array.from(document.querySelectorAll(sel));
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
/** A toast can carry one action. Used for Undo, which needs longer on screen than a plain
 * confirmation — a destructive action the user can't take back is the one thing worth
 * interrupting for. */
function toast(msg, action){
  const t = $('toast');
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  let life = 2600;
  if(action && action.label && typeof action.onClick === 'function'){
    const btn = document.createElement('button');
    btn.className = 'toastAction';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.onclick = ()=>{ t.classList.remove('show'); action.onClick(); };
    t.appendChild(btn);
    t.classList.add('hasAction');
    life = 7000; // long enough to actually notice and reach for it
  } else {
    t.classList.remove('hasAction');
  }
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>{ t.classList.remove('show'); t.classList.remove('hasAction'); }, life);
}
/** Deep copy for undo snapshots. Trip data is plain JSON — no functions, dates or DOM refs —
 * so this is a faithful copy rather than a shallow one that would share mutated sub-objects. */
function snapshot(value){ return JSON.parse(JSON.stringify(value)); }
/** Announces a destructive action and offers to put it back. The restore runs against live
 * state, then re-renders whatever view the user is on. */
function toastUndo(message, restoreFn){
  toast(message, { label:'Undo', onClick: ()=>{
    restoreFn();
    saveState();
    refreshCurrentView();
    toast('Restored.');
  }});
}
let __uidN = 1;
function uid(prefix){ return `${prefix}_${Date.now().toString(36)}_${(__uidN++).toString(36)}`; }
/** All prices are stored in USD; fmt$ converts+formats to the user's chosen display currency (Settings). */
function currentCurrencyCode(){
  return (STATE.settings && STATE.settings.currencyCode) || 'USD';
}
function fmt$(n){
  const code = currentCurrencyCode();
  const meta = CURRENCY_META[code] || CURRENCY_META.USD;
  const converted = convertUSD(n||0, code);
  const rounded = Math.abs(converted) >= 100 || code==='JPY' || code==='KRW' || code==='IDR' ? Math.round(converted) : Math.round(converted*100)/100;
  return meta.symbol + rounded.toLocaleString(undefined, code==='JPY'||code==='KRW'||code==='IDR'||Math.abs(converted)>=100 ? {maximumFractionDigits:0} : {minimumFractionDigits:2,maximumFractionDigits:2});
}
function clamp(n,a,b){ return Math.max(a,Math.min(b,n)); }
function haversine(a,b){
  const R=6371, toRad=d=>d*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng);
  const s=Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return R*2*Math.asin(Math.sqrt(s));
}
function stars(rating){
  const full = Math.round(rating);
  return '★'.repeat(clamp(full,0,5)) + '☆'.repeat(5-clamp(full,0,5));
}
function priceLevelStr(lvl){ return lvl>0 ? '$'.repeat(clamp(lvl,1,4)) : 'Free'; }
function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
function toDateInput(d){ if(!(d instanceof Date)) d=new Date(d); return d.toISOString().slice(0,10); }
function addDays(dateStr, n){ const d=new Date(dateStr+'T00:00:00'); d.setDate(d.getDate()+n); return toDateInput(d); }
function fmtDateShort(dateStr){ if(!dateStr) return ''; const d=new Date(dateStr+'T00:00:00'); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); }
function fmtDateFull(dateStr){ if(!dateStr) return ''; const d=new Date(dateStr+'T00:00:00'); return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
function daysBetween(a,b){ return Math.max(1, Math.round((new Date(b)-new Date(a))/86400000)+1); }
function initialsOf(name){ return (name||'?').split(' ').filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join(''); }
function isOpenNow(hours){
  if(!hours) return true;
  const dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let str = hours, dayRestrict=null;
  const dm = str.match(/^([A-Z][a-z]{2})\s+(.*)$/);
  if(dm && dayNames.includes(dm[1])){ dayRestrict=dm[1]; str=dm[2]; }
  const now = new Date();
  if(dayRestrict && dayNames[now.getDay()]!==dayRestrict) return false;
  const parts = str.split('–').map(s=>s.trim());
  if(parts.length<2) return true;
  const toMin = t=>{ const m=t.match(/(\d+):(\d+)\s*(AM|PM)/i); if(!m) return null; let h=parseInt(m[1],10)%12; if(/PM/i.test(m[3])) h+=12; return h*60+parseInt(m[2],10); };
  const openM=toMin(parts[0]), closeM=toMin(parts[1]);
  if(openM==null||closeM==null) return true;
  const nowM = now.getHours()*60+now.getMinutes();
  return closeM<openM ? (nowM>=openM || nowM<closeM) : (nowM>=openM && nowM<closeM);
}
function catColor(type){ return {attraction:'var(--cat-attraction)',restaurant:'var(--cat-restaurant)',hotel:'var(--cat-hotel)',custom:'var(--cat-explore)'}[type] || 'var(--cat-attraction)'; }
function catEmoji(type){ return {attraction:'📍',restaurant:'🍜',hotel:'🏨',custom:'✦'}[type] || '📍'; }

/* ---------------- live photo hydration ---------------- */
/** Destination image priority chain (never a hardcoded per-destination URL — every tier is
 * derived from the real destination name/country, so it works identically for any destination
 * in the world): 1) the destination's own name — this alone already surfaces Wikipedia's real
 * lead photo for that exact place, whether it's a city, coastline, mountain range, island, or
 * small town, not a one-size-fits-all "skyline" shot; 2) the country, only if the destination's
 * own name comes up empty. */
function destPhotoQuery(dest){ return [dest.name, dest.country].filter(Boolean).join('||'); }
/** Place image priority chain: the specific place first (most relevant — a named landmark,
 * restaurant, hotel), falling back to the destination's own photo if that specific place has no
 * usable Wikipedia photo (common for real supplemented places pulled from GeoSearch, like an
 * obscure train station) rather than dropping straight to the generic placeholder. */
function photoQuery(name, destName){
  const specific = destName ? `${name} ${destName}` : name;
  return destName ? `${specific}||${destName}` : specific;
}
function hydratePhotos(container){
  if(!container) return;
  container.querySelectorAll('img[data-photo-q]').forEach(imgEl=>{
    const qRaw = imgEl.dataset.photoQ || '';
    const queries = qRaw.split('||').filter(Boolean);
    const src = imgEl.getAttribute('src')||'';
    const isPlaceholder = src.indexOf('data:image/svg')===0;
    // Every image gets an onerror safety net, not just ones we're about to upgrade below.
    // Places supplemented/enriched from live Wikipedia data (ensureRealAttractionSupply,
    // enrichGenericDestination) already start with a resolved real photo URL baked in — never
    // a placeholder — so without this they had NO fallback at all: a dead link, an expired
    // thumbnail path, or a hotlink block left the browser's native broken-image icon on screen
    // permanently. Placeholders keep reverting to themselves (unchanged); real URLs fall back
    // to a freshly generated placeholder since they never had one to begin with.
    if(!imgEl.dataset.photoFallbackWired){
      imgEl.dataset.photoFallbackWired = '1';
      const label = imgEl.alt || queries[0] || '';
      const fallback = isPlaceholder ? src : img('fallback-'+(queries[0]||src), 640,480, label);
      imgEl.onerror = () => { imgEl.onerror = null; imgEl.src = fallback; };
    }
    if(imgEl.dataset.photoResolved) return;
    if(!isPlaceholder){ imgEl.dataset.photoResolved='1'; return; } // already a real photo, just needed the safety net above
    if(!queries.length) return;
    imgEl.dataset.photoResolved = '1';
    // hydratePhotos runs synchronously right after each render, so swapping a known photo in
    // here happens before the browser paints — the placeholder never actually appears on a
    // page whose photos have been resolved once already.
    const known = cachedWikiThumbnail(queries);
    if(known){ imgEl.src = known; return; }
    fetchWikiThumbnailChain(queries).then(url=>{
      if(!url) return;
      imgEl.src = url;
    }).catch(()=>{});
  });
}
function enrichDestinationInBackground(dest, onDone){
  if(!dest || !dest.id.startsWith('gen-') || dest.__enriched || dest.__enriching) return;
  enrichGenericDestination(dest).then(changed=>{ if(changed && onDone) onDone(); }).catch(()=>{});
}
/** Tops up ANY destination's (curated or generic) attraction pool with real nearby landmarks
 * fetched live from Wikipedia — never fabricated filler — so long, multi-day trip ideas have
 * enough real places to draw from without inventing places that don't exist. */
function supplementDestinationInBackground(dest, onDone){
  if(!dest) return;
  ensureRealAttractionSupply(dest).then(changed=>{ if(changed && onDone) onDone(); }).catch(()=>{});
}

/* ---------------- persistence ---------------- */
const LS_KEY = 'tripflow_state_v1';
const LS_GEMINI = 'tripflow_gemini_key';

function defaultState(){
  return {
    theme:'system',
    settings:{ name:'Jie Wei', email:'jiewei190@gmail.com', currencyCode:'USD' },
    trips:[],
    collections:[
      {id:'coll_want', name:'Want to Visit', icon:'❤️', placeIds:[]},
      {id:'coll_food', name:'Restaurants', icon:'🍜', placeIds:[]},
      {id:'coll_attr', name:'Attractions', icon:'🏯', placeIds:[]},
      {id:'coll_night', name:'Nightlife', icon:'🌃', placeIds:[]},
      {id:'coll_shop', name:'Shopping', icon:'🛍️', placeIds:[]},
    ],
    notifications:[],
    savedIdeas:[],
    recentSearches:[],
  };
}

let STATE = loadState();
saveState(); // ensure a freshly-seeded state (first-ever visit) is persisted immediately

function loadState(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      return Object.assign(defaultState(), parsed);
    }
  }catch(e){}
  return seedState(defaultState());
}
function saveState(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(STATE)); }catch(e){} }

function seedState(state){
  const tokyo = findDestination('Tokyo, Japan');
  const paris = findDestination('Paris, France');
  const t1 = buildAutoTrip(tokyo.id, 'Tokyo Adventure', '2026-09-10', '2026-09-18', 2, 'moderate');
  const t2 = buildAutoTrip(paris.id, 'Paris Getaway', '2026-12-20', '2026-12-27', 2, 'moderate');
  t1.collaborators.push(mkCollaborator('Alex Rivera','alex.rivera@example.com','Editor'));
  t1.activity.push({id:uid('act'), author:'Alex Rivera', text:`joined the trip and can't wait for the ramen 🍜`, ts:Date.now()-86400000*2});
  state.trips = [t1, t2];
  state.notifications = [
    {id:uid('notif'), text:`Your "Tokyo Adventure" trip starts in a few days — double check your itinerary!`, icon:'🇯🇵', read:false, tripId:t1.id, ts:Date.now()-3600000},
    {id:uid('notif'), text:`Alex Rivera joined your Tokyo Adventure trip.`, icon:'🤝', read:false, tripId:t1.id, ts:Date.now()-7200000},
    {id:uid('notif'), text:`Flight prices to Paris dropped 12% for your travel dates.`, icon:'✈️', read:false, tripId:t2.id, ts:Date.now()-86400000},
    {id:uid('notif'), text:`Welcome to TripFlow! Try "✨ Surprise Me" on the home page to generate trip ideas.`, icon:'✨', read:true, tripId:null, ts:Date.now()-172800000},
  ];
  state.collections[0].placeIds = ['tokyo-a5','bali-a5','santorini-a1'];
  return state;
}

function mkCollaborator(name,email,role){ return {id:uid('collab'), name, email, role, initials:initialsOf(name)}; }

function buildAutoTrip(destId, title, start, end, travelers, style){
  const dest = DESTINATIONS.find(d=>d.id===destId);
  const nDays = daysBetween(start,end);
  const attractions = placesFor(destId,'attraction').slice().sort((a,b)=>b.rating-a.rating);
  const restaurants = placesFor(destId,'restaurant').slice().sort((a,b)=>b.rating-a.rating);
  const days = [];
  let ai=0, ri=0;
  for(let d=0; d<nDays; d++){
    const stops = [];
    const times = ['09:00','11:30','14:30','19:00'];
    for(let k=0;k<2 && ai<attractions.length;k++){ stops.push(mkStopFromPlace(attractions[ai++], times[stops.length]||'10:00')); }
    if(ri<restaurants.length){ stops.push(mkStopFromPlace(restaurants[ri++], times[stops.length]||'19:00')); }
    days.push({ date: addDays(start,d), stops });
  }
  const totalBudget = Math.round((dest.avgDailyBudget[style]||dest.avgDailyBudget.moderate) * nDays * travelers);
  return {
    id: uid('trip'), destId, destName: dest.name+(dest.country?', '+dest.country:''), title, start, end, travelers, cover: dest.hero,
    days,
    budget:{ total: totalBudget, style: style||'moderate', expenses:[] },
    collaborators:[ mkCollaborator('Jie Wei (you)', 'jiewei190@gmail.com', 'Owner') ],
    activity:[ {id:uid('act'), author:'You', text:`created the trip "${title}".`, ts:Date.now()} ],
    createdAt: Date.now(),
  };
}

function mkStopFromPlace(place, time){
  return {
    id: uid('stop'), placeId: place.id, name: place.name, type: place.type,
    area: place.area, lat: place.lat, lng: place.lng, image: place.image,
    rating: place.rating, cost: place.type==='hotel' ? place.price : (place.price||0),
    category: place.category || place.cuisine || (place.type==='hotel'?`${place.stars}★ Hotel`:''),
    duration: place.duration || 90,
    time: time || '10:00', note:'',
    transitToNext: {mode:'Walk', mins: 15},
    votes: { interested:1, mustvisit:0, skip:0, userVoted:null },
    comments: [],
  };
}
function nearestNeighborOrder(stops){
  if(stops.length<=2) return stops.slice();
  const remaining = stops.slice(1);
  const order = [stops[0]];
  let current = stops[0];
  while(remaining.length){
    let bestIdx=0, bestD=Infinity;
    remaining.forEach((s,i)=>{ const d=haversine(current,s); if(d<bestD){ bestD=d; bestIdx=i; } });
    current = remaining.splice(bestIdx,1)[0];
    order.push(current);
  }
  return order;
}
function totalDistance(stops){ let d=0; for(let i=0;i<stops.length-1;i++) d+=haversine(stops[i],stops[i+1]); return d; }
function recomputeDayTimes(day){
  if(!day.stops.length) return;
  let t = day.stops[0].time || '09:00';
  day.stops.forEach(s=>{ s.time=t; t=addMinutesToTime(t,(s.duration||90)+(s.transitToNext?.mins||15)); });
}

/* ---------------- trip helpers ---------------- */
function getTrip(id){ return STATE.trips.find(t=>t.id===id); }
/** Generic (worldwide) destinations aren't persisted between sessions — only their
    resolved id/name are. Re-resolve (and re-enrich) on demand so a trip saved to
    localStorage still opens correctly after a reload. */
function destForTrip(trip){
  return resolveDestFromId(trip.destId) || findDestination(trip.destName || trip.destId);
}
function tripsForDest(destId){ return STATE.trips.filter(t=>t.destId===destId); }
function getOrCreateDraftTrip(destId){
  let trip = tripsForDest(destId)[0];
  if(trip) return trip;
  const dest = DESTINATIONS.find(d=>d.id===destId);
  const start = toDateInput(new Date(Date.now()+30*86400000));
  const end = addDays(start,3);
  trip = {
    id: uid('trip'), destId, destName: dest.name+(dest.country?', '+dest.country:''), title:`${dest.name} Trip`, start, end, travelers:2, cover: dest.hero,
    days:[{date:start,stops:[]},{date:addDays(start,1),stops:[]},{date:addDays(start,2),stops:[]},{date:addDays(start,3),stops:[]}],
    budget:{ total: Math.round((dest.avgDailyBudget.moderate)*4*2), style:'moderate', expenses:[] },
    collaborators:[ mkCollaborator('Jie Wei (you)', STATE.settings.email, 'Owner') ],
    activity:[ {id:uid('act'), author:'You', text:`created a draft trip to ${dest.name}.`, ts:Date.now()} ],
    createdAt: Date.now(),
  };
  STATE.trips.unshift(trip);
  saveState();
  return trip;
}
function tripPlannedTotal(trip){
  let sum = 0;
  trip.days.forEach(day=>day.stops.forEach(s=>sum += (s.cost||0)));
  trip.budget.expenses.forEach(e=>sum += (e.amount||0));
  return sum;
}
function tripCategoryTotals(trip){
  const cats = {Flights:0, Hotels:0, Food:0, Activities:0, Transportation:0, Miscellaneous:0};
  trip.days.forEach(day=>day.stops.forEach(s=>{
    if(s.type==='attraction') cats.Activities += s.cost||0;
    else if(s.type==='restaurant') cats.Food += s.cost||0;
    else if(s.type==='hotel') cats.Hotels += s.cost||0;
    else cats.Miscellaneous += s.cost||0;
  }));
  trip.budget.expenses.forEach(e=>{ cats[e.cat] = (cats[e.cat]||0) + (e.amount||0); });
  return cats;
}
function tripStopCount(trip){ return trip.days.reduce((a,d)=>a+d.stops.length,0); }
/** Every place saved (in any collection) for a given destination — the shared source of truth
 * behind the Trip Progress checklist, the hotel-area recommendation, and the Unscheduled
 * Places bucket, so "saved" means the same thing everywhere in the app. */
function savedPlaceIdsForDest(destId){
  const ids = new Set();
  STATE.collections.forEach(c=>c.placeIds.forEach(id=>{ if(id.indexOf(destId+'-')===0) ids.add(id); }));
  return ids;
}
/** Saved attractions/restaurants for this trip's destination that aren't scheduled on any day
 * yet — the connective link between Saved Places and the itinerary. Hotels are excluded: they
 * don't fit the "schedule into a day" model (that's what the Hotel Considered dashboard item
 * and the destination's Hotels tab are for). */
function unscheduledPlacesForTrip(trip){
  const saved = savedPlaceIdsForDest(trip.destId);
  const scheduled = new Set(trip.days.flatMap(d=>d.stops.map(s=>s.placeId)));
  return [...saved].filter(id=>!scheduled.has(id)).map(placeById).filter(p=>p && p.type!=='hotel');
}
function logActivity(trip, text, author){ trip.activity.unshift({id:uid('act'), author:author||'You', text, ts:Date.now()}); }
function addNotification(text, icon, tripId){ STATE.notifications.unshift({id:uid('notif'), text, icon:icon||'🔔', read:false, tripId:tripId||null, ts:Date.now()}); renderNotifBadge(); }

/* ---------------- modal / dialog helpers ---------------- */
function openModal(id){ $(id).classList.add('show'); }
function closeModal(id){ $(id).classList.remove('show'); }
function closeAllModals(){ $$('.modalBack.show').forEach(m=>m.classList.remove('show')); }
document.addEventListener('DOMContentLoaded', ()=>{
  document.addEventListener('click', e=>{ const b=e.target.closest('[data-close]'); if(b) closeModal(b.dataset.close); });
  $$('.modalBack').forEach(m=>m.addEventListener('click', e=>{ if(e.target===m) m.classList.remove('show'); }));
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeAllModals(); });
});
function confirmDialog(title, body, onOk, okLabel){
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  $('confirmOk').textContent = okLabel || 'Delete';
  openModal('modal-confirm');
  $('confirmCancel').onclick = ()=>closeModal('modal-confirm');
  $('confirmOk').onclick = ()=>{ closeModal('modal-confirm'); onOk(); };
}

/* ---------------- theme ---------------- */
function applyTheme(){
  const t = STATE.theme;
  if(t==='dark') document.documentElement.setAttribute('data-theme','dark');
  else if(t==='light') document.documentElement.setAttribute('data-theme','light');
  else document.documentElement.removeAttribute('data-theme');
  const tt = $('themeToggle'); if(tt) tt.checked = (t==='dark');
  refreshMapThemesIfOpen();
}
function refreshMapThemesIfOpen(){
  [window.__destMapState, window.__plannerMapState].forEach(state=>{
    if(state && state.map && state.mode==='map'){
      try{ state.map.removeLayer(state.layer); state.layer = createBaseTileLayer('map').addTo(state.map); state.layer.bringToBack(); }catch(e){}
    }
  });
}

/* ---------------- router ---------------- */
function navigate(hash){
  if(location.hash === hash) route(); else location.hash = hash;
}
function showView(name){
  $$('.view').forEach(v=>v.classList.remove('active'));
  $('view-'+name).classList.add('active');
  const map = {home:'#/', discover:'#/discover', trips:'#/trips', saved:'#/saved', ideas:'#/ideas', travel:'#/travel'};
  $$('.navbtn').forEach(b=>b.classList.toggle('active', b.dataset.route===map[name]));
  window.scrollTo(0,0);
}
function route(){
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\/?/,'').split('/').filter(Boolean);
  closeDropdowns();
  if(parts[0]==='discover'){ showView('discover'); renderDiscoverView(); }
  else if(parts[0]==='trips'){ showView('trips'); renderTripsView(); }
  else if(parts[0]==='saved'){ showView('saved'); renderSavedView(parts[1]); }
  else if(parts[0]==='ideas'){ showView('ideas'); renderIdeasView(decodeURIComponent(parts[1]||'')); }
  else if(parts[0]==='destination'){ showView('destination'); renderDestinationView(decodeURIComponent(parts[1]||''), parts[2]||'overview'); }
  else if(parts[0]==='travel'){ showView('travel'); renderTravelView(); }
  else if(parts[0]==='trip'){ showView('planner'); renderPlannerView(parts[1], parts[2]||'dashboard'); }
  else { showView('home'); renderHomeView(); }
}

/* ---------------- topbar: search / notifications / profile ---------------- */
function closeDropdowns(){
  $('gsearchPanel').classList.remove('show');
  $('notifDropdown').classList.remove('show');
  $('profileDropdown').classList.remove('show');
}
function initTopbar(){
  $$('[data-route]').forEach(b=>b.onclick=()=>navigate(b.dataset.route));
  $('brandBtn').onclick = ()=>navigate('#/');

  $('searchToggle').onclick = (e)=>{ e.stopPropagation(); const p=$('gsearchPanel'); p.classList.toggle('show'); $('notifDropdown').classList.remove('show'); $('profileDropdown').classList.remove('show'); if(p.classList.contains('show')){ $('globalSearchInput').focus(); runGlobalSearch($('globalSearchInput').value); } };
  $('gsearchClose').onclick = ()=>$('gsearchPanel').classList.remove('show');
  $('globalSearchInput').addEventListener('input', debounce(e=>runGlobalSearch(e.target.value), 150));
  $('globalSearchInput').addEventListener('focus', ()=>runGlobalSearch($('globalSearchInput').value));
  $('globalSearchInput').onkeydown = (e)=>{
    if(e.key!=='Enter') return;
    const q = $('globalSearchInput').value.trim();
    if(!q) return;
    recordSearch(q);
    const d = findDestination(q);
    closeDropdowns();
    navigate(`#/destination/${encodeURIComponent(d.id)}`);
  };

  $('notifToggle').onclick = (e)=>{ e.stopPropagation(); const p=$('notifDropdown'); p.classList.toggle('show'); $('gsearchPanel').classList.remove('show'); $('profileDropdown').classList.remove('show'); };
  $('markAllRead').onclick = ()=>{ STATE.notifications.forEach(n=>n.read=true); saveState(); renderNotifications(); };

  $('profileToggle').onclick = (e)=>{ e.stopPropagation(); const p=$('profileDropdown'); p.classList.toggle('show'); $('gsearchPanel').classList.remove('show'); $('notifDropdown').classList.remove('show'); };
  $('settingsBtn').onclick = ()=>{ closeDropdowns(); openSettings(); };
  $('signOutBtn').onclick = ()=>{ closeDropdowns(); toast('Signed out (demo mode — your data stays saved on this device).'); };

  document.addEventListener('click', ()=>closeDropdowns());

  const email = STATE.settings.email || 'jiewei190@gmail.com';
  const name = STATE.settings.name || 'Jie Wei';
  $('profileName').textContent = name;
  $('profileEmail').textContent = email;
  const inits = initialsOf(name);
  $('profileToggle').textContent = inits;
  $$('.avatar#profileToggle, .profileHead .avatar').forEach(a=>a.textContent=inits);
}

const TRENDING_SEARCH_TAGS = 'trending';
function recordSearch(q){
  q = (q||'').trim();
  if(!q) return;
  STATE.recentSearches = [q, ...STATE.recentSearches.filter(s=>s.toLowerCase()!==q.toLowerCase())].slice(0,6);
  saveState();
}
function placeTypeLabel(t){ return t==='attraction'?'Attraction':(t==='restaurant'?'Restaurant':'Hotel'); }
function runGlobalSearch(q){
  const results = $('gsearchResults');
  q = (q||'').trim();
  if(!q){
    let html = '';
    if(STATE.recentSearches.length){
      html += `<div class="gsearch-group">Recent Searches</div>`;
      STATE.recentSearches.forEach(s=>{
        html += `<button class="gsearch-row" data-recent="${esc(s)}"><div class="ic"><i class="fa-solid fa-clock-rotate-left"></i></div><div>${esc(s)}</div></button>`;
      });
    }
    const trending = DESTINATIONS.filter(d=>!d.id.startsWith('gen-') && (d.tags||[]).includes(TRENDING_SEARCH_TAGS)).slice(0,5);
    if(trending.length){
      html += `<div class="gsearch-group">Trending Destinations</div>`;
      trending.forEach(d=>{
        html += `<button class="gsearch-row" data-go="#/destination/${encodeURIComponent(d.id)}"><img src="${d.hero}" alt="" data-photo-q="${esc(destPhotoQuery(d))}"><div><div>${d.flag} ${esc(d.name)}</div><div class="small">${esc(d.tagline)}</div></div></button>`;
      });
    }
    if(!html) html = '<div class="empty" style="padding:26px">Search for a city, attraction, restaurant or hotel.</div>';
    results.innerHTML = html;
    hydratePhotos(results);
    wireGlobalSearchResults(results);
    return;
  }
  const ql = q.toLowerCase();
  const destMatches = DESTINATIONS.filter(d=> !d.id.startsWith('gen-') && (d.name.toLowerCase().includes(ql) || d.country.toLowerCase().includes(ql))).slice(0,4);
  const attrMatches = PLACES.filter(p=>p.type==='attraction' && p.name.toLowerCase().includes(ql)).slice(0,4);
  const restMatches = PLACES.filter(p=>p.type==='restaurant' && p.name.toLowerCase().includes(ql)).slice(0,4);
  const hotelMatches = PLACES.filter(p=>p.type==='hotel' && p.name.toLowerCase().includes(ql)).slice(0,4);
  let html = '';
  const destGroup = (label, matches)=>{
    if(!matches.length) return '';
    let h = `<div class="gsearch-group">${esc(label)}</div>`;
    matches.forEach(d=>{
      h += `<button class="gsearch-row" data-go="#/destination/${encodeURIComponent(d.id)}"><img src="${d.hero}" alt="" data-photo-q="${esc(destPhotoQuery(d))}"><div><div>${d.flag} ${esc(d.name)}, ${esc(d.country)}</div><div class="small">Explore destination</div></div></button>`;
    });
    return h;
  };
  const placeGroup = (label, matches)=>{
    if(!matches.length) return '';
    let h = `<div class="gsearch-group">${esc(label)}</div>`;
    matches.forEach(p=>{
      const pd = DESTINATIONS.find(d=>d.id===p.destId);
      h += `<button class="gsearch-row" data-place="${p.id}"><img src="${p.image}" alt="" data-photo-q="${esc(photoQuery(p.name, pd.name))}"><div><div>${esc(p.name)}</div><div class="small">${esc(pd.name)} · ${placeTypeLabel(p.type)}</div></div></button>`;
    });
    return h;
  };
  html += destGroup('Destinations', destMatches);
  html += placeGroup('Attractions', attrMatches);
  html += placeGroup('Restaurants', restMatches);
  html += placeGroup('Hotels', hotelMatches);
  if(!html){
    html = `<div class="empty" style="padding:26px">No matches. Press Enter to explore "${esc(q)}" as a destination.</div>`;
  }
  results.innerHTML = html;
  hydratePhotos(results);
  wireGlobalSearchResults(results);
}
function wireGlobalSearchResults(results){
  results.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{ recordSearch($('globalSearchInput').value); closeDropdowns(); navigate(b.dataset.go); });
  results.querySelectorAll('[data-place]').forEach(b=>b.onclick=()=>{ recordSearch($('globalSearchInput').value); closeDropdowns(); openPlaceDetail(b.dataset.place); });
  results.querySelectorAll('[data-recent]').forEach(b=>b.onclick=()=>{ $('globalSearchInput').value = b.dataset.recent; runGlobalSearch(b.dataset.recent); });
}

function renderNotifBadge(){
  const n = STATE.notifications.filter(x=>!x.read).length;
  const b = $('notifBadge');
  b.textContent = n; b.classList.toggle('zero', n===0);
}
function renderNotifications(){
  renderNotifBadge();
  const list = $('notifList');
  if(!STATE.notifications.length){ list.innerHTML = '<div class="empty" style="margin:14px">No notifications yet.</div>'; return; }
  list.innerHTML = STATE.notifications.map(n=>`
    <button class="notifItem ${n.read?'':'unread'}" data-id="${n.id}">
      <div class="notifIcon">${n.icon}</div>
      <div><div>${esc(n.text)}</div><div class="small">${timeAgo(n.ts)}</div></div>
    </button>`).join('');
  list.querySelectorAll('.notifItem').forEach(b=>b.onclick=()=>{
    const n = STATE.notifications.find(x=>x.id===b.dataset.id);
    n.read = true; saveState(); renderNotifications();
    closeDropdowns();
    if(n.tripId && getTrip(n.tripId)) navigate(`#/trip/${n.tripId}`);
  });
}
function timeAgo(ts){
  const s = Math.floor((Date.now()-ts)/1000);
  if(s<60) return 'just now';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}

/* ---------------- settings ---------------- */
function openSettings(){
  $('settingsName').value = STATE.settings.name;
  populateCurrencyOptions($('settingsCurrency'));
  $('settingsCurrency').value = currentCurrencyCode();
  $('themeToggle').checked = STATE.theme==='dark';
  openModal('modal-settings');
}
function populateCurrencyOptions(select){
  select.innerHTML = Object.entries(CURRENCY_META).map(([code,m])=>`<option value="${code}">${code} — ${esc(m.name)} (${m.symbol})</option>`).join('');
}
function initSettingsModal(){
  $('themeToggle').onchange = (e)=>{ STATE.theme = e.target.checked?'dark':'light'; applyTheme(); saveState(); };
  $('saveSettingsBtn').onclick = ()=>{
    STATE.settings.name = $('settingsName').value.trim() || STATE.settings.name;
    const newCode = $('settingsCurrency').value;
    const changed = newCode !== STATE.settings.currencyCode;
    STATE.settings.currencyCode = newCode;
    saveState();
    $('profileName').textContent = STATE.settings.name;
    const inits = initialsOf(STATE.settings.name);
    $$('.avatar#profileToggle, .profileHead .avatar').forEach(a=>a.textContent=inits);
    toast('Settings saved.' + (changed ? ` Prices now show in ${newCode}.` : ''));
    closeModal('modal-settings');
    if(changed) refreshCurrentView();
  };
}

/* ---------------- reusable place card ---------------- */
function placeCardHTML(p, opts){
  opts = opts||{};
  const dest = DESTINATIONS.find(d=>d.id===p.destId);
  const isSaved = STATE.collections.some(c=>c.placeIds.includes(p.id));
  let metaHTML = '';
  if(p.type==='attraction'){
    metaHTML = `<span class="stars">${stars(p.rating)}</span><span>${p.rating}</span><span>(${p.reviews.toLocaleString()})</span><span class="priceLevel">${priceLevelStr(p.priceLevel)}</span>`;
  } else if(p.type==='restaurant'){
    const open = isOpenNow(p.hours);
    metaHTML = `<span class="stars">${stars(p.rating)}</span><span>${p.rating}</span><span>(${p.reviews.toLocaleString()})</span><span class="priceLevel">${priceLevelStr(p.priceLevel)}</span><span class="openTag ${open?'open':'closed'}">${open?'Open now':'Closed'}</span>`;
  } else if(p.type==='hotel'){
    metaHTML = `<span class="stars">${'★'.repeat(p.stars)}</span><span>${p.guestRating}/10</span><span class="priceLevel">${fmt$(p.price)}/night</span>`;
  }
  const catLabel = p.type==='attraction'? p.category : (p.type==='restaurant'? p.cuisine : `${p.stars}★ Hotel`);
  return `
  <div class="placeCard" data-place="${p.id}">
    <div class="placeImgWrap">
      <img src="${p.image}" alt="${esc(p.name)}" loading="lazy" data-photo-q="${esc(photoQuery(p.name, dest&&dest.name))}">
      <span class="placeCatBadge">${esc(catLabel)}</span>
      <button class="placeSaveBtn" data-save="${p.id}" title="Save">${isSaved?'♥':'♡'}</button>
    </div>
    <div class="placeBody">
      <h4>${esc(p.name)}</h4>
      <div class="placeMeta">${metaHTML}</div>
      ${!opts.noDesc ? `<p class="placeDesc">${esc(p.desc)}</p>` : ''}
      <div class="small">📍 ${esc(p.area)}${dest && opts.showDest ? ' · '+esc(dest.name) : ''}</div>
      <div class="placeFoot">
        <button class="btn primary" data-add="${p.id}"><i class="fa-solid fa-plus"></i> Add to Trip</button>
        <button class="btn" data-detail="${p.id}"><i class="fa-solid fa-circle-info"></i> Details</button>
        <button class="btn" data-mapview="${p.id}"><i class="fa-solid fa-map-location-dot"></i></button>
      </div>
    </div>
  </div>`;
}
/** Renders removable chips for every currently-active filter plus a "Clear all filters"
 * link, so users can see and undo their filter state at a glance instead of hunting back
 * through each dropdown. `chips` is [{label, onRemove}]; hides itself entirely when empty. */
function renderActiveFilterChips(containerId, chips, onClearAll){
  const el = $(containerId);
  if(!el) return;
  if(!chips.length){ el.innerHTML=''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = chips.map((c,i)=>`<button class="filterChip" data-chip="${i}">${esc(c.label)} <i class="fa-solid fa-xmark"></i></button>`).join('')
    + `<button class="linklike" id="${containerId}ClearAll">Clear all filters</button>`;
  chips.forEach((c,i)=>{ const b = el.querySelector(`[data-chip="${i}"]`); if(b) b.onclick = c.onRemove; });
  const clearBtn = $(containerId+'ClearAll');
  if(clearBtn) clearBtn.onclick = onClearAll;
}
function wirePlaceCards(container){
  container.querySelectorAll('[data-place]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      if(e.target.closest('[data-save],[data-add],[data-detail],[data-mapview]')) return;
      openPlaceDetail(el.dataset.place);
    });
  });
  container.querySelectorAll('[data-save]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openSaveTo(b.dataset.save); });
  container.querySelectorAll('[data-add]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openAddToTrip(b.dataset.add); });
  container.querySelectorAll('[data-detail]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openPlaceDetail(b.dataset.detail); });
  container.querySelectorAll('[data-mapview]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); viewPlaceOnMap(b.dataset.mapview); });
  hydratePhotos(container);
}
function viewPlaceOnMap(placeId){
  const p = placeById(placeId);
  if(!p) return;
  navigate(`#/destination/${encodeURIComponent(p.destId)}/map`);
  setTimeout(()=>{ if(typeof focusDestMapPlace==='function') focusDestMapPlace(p); }, 260);
}

/* ---------------- place detail modal ---------------- */
/** A short, rule-based (not a live model call) planning tip: best time of day for this
 * specific place, plus the closest genuinely nearby highly-rated place to pair it with. */
function generateAIInsight(place, dest){
  const nameCat = (place.name+' '+(place.category||'')).toLowerCase();
  let timeHint;
  if(/sky|view|tower|rooftop|sunset|observation/.test(nameCat)) timeHint = 'around sunset for the best light and views';
  else if(place.type==='restaurant'){
    timeHint = /café|coffee|bakery|breakfast/i.test(place.cuisine||'') ? 'earlier in the day, when it\'s freshest' : 'in the evening for the full atmosphere';
  } else if((place.tags||[]).includes('nightlife')) timeHint = 'after dark, once it comes alive';
  else if((place.tags||[]).includes('relax')) timeHint = 'in the late afternoon, when crowds thin out';
  else timeHint = 'earlier in the day to beat the crowds';
  const nearby = PLACES.filter(o=>o.destId===place.destId && o.id!==place.id && o.type!=='hotel' && haversine(place,o) < 1.2)
    .sort((a,b)=>b.rating-a.rating)[0];
  let pairSentence = '';
  if(nearby){
    pairSentence = ` Consider scheduling it near ${nearby.name} (about ${haversine(place,nearby).toFixed(1)} km away) to minimize travel time.`;
  }
  return `${place.name} is best visited ${timeHint}.${pairSentence}`;
}
function openPlaceDetail(placeId){
  const p = placeById(placeId);
  if(!p) return;
  const dest = DESTINATIONS.find(d=>d.id===p.destId);
  const reviews = generateReviews(p, p.id);
  let infoRows = '';
  if(p.type==='attraction'){
    infoRows = `<div class="ovCard"><div class="k">Category</div><div class="v">${esc(p.category)}</div></div>
      <div class="ovCard"><div class="k">Price</div><div class="v">${priceLevelStr(p.priceLevel)}${p.price?` · ${fmt$(p.price)}`:''}</div></div>
      <div class="ovCard"><div class="k">Suggested time</div><div class="v">${p.duration||90} min</div></div>
      <div class="ovCard"><div class="k">Area</div><div class="v">${esc(p.area)}</div></div>`;
  } else if(p.type==='restaurant'){
    const open = isOpenNow(p.hours);
    infoRows = `<div class="ovCard"><div class="k">Cuisine</div><div class="v">${esc(p.cuisine)}</div></div>
      <div class="ovCard"><div class="k">Price</div><div class="v">${priceLevelStr(p.priceLevel)} · ~${fmt$(p.price)}/person</div></div>
      <div class="ovCard"><div class="k">Hours</div><div class="v">${esc(p.hours)} <span class="openTag ${open?'open':'closed'}" style="margin-left:6px">${open?'Open now':'Closed'}</span></div></div>
      <div class="ovCard"><div class="k">Dietary</div><div class="v">${p.dietary&&p.dietary.length?esc(p.dietary.join(', ')):'Standard menu'}</div></div>`;
  } else if(p.type==='hotel'){
    infoRows = `<div class="ovCard"><div class="k">Rating</div><div class="v">${'★'.repeat(p.stars)} · Guests ${p.guestRating}/10</div></div>
      <div class="ovCard"><div class="k">Price</div><div class="v">${fmt$(p.price)} / night</div></div>
      <div class="ovCard"><div class="k">Area</div><div class="v">${esc(p.area)}</div></div>
      <div class="ovCard"><div class="k">Amenities</div><div class="v">${esc((p.amenities||[]).join(', '))}</div></div>`;
  }
  const isSaved = STATE.collections.some(c=>c.placeIds.includes(p.id));
  $('placeDetailContent').innerHTML = `
    <div class="modalHeader">
      <div><div class="eyebrow">${esc(dest.flag)} ${esc(dest.name)}</div><h2>${esc(p.name)}</h2>
        <div class="placeMeta" style="margin-top:6px">${p.rating?`<span class="stars">${stars(p.rating)}</span><span>${p.rating}</span><span>(${(p.reviews||0).toLocaleString()} reviews)</span>`:''}</div>
      </div>
      <button class="xbtn" data-close="modal-placeDetail">×</button>
    </div>
    <div class="pdHero"><img src="${p.image}" alt="" data-photo-q="${esc(photoQuery(p.name, dest.name))}"></div>
    <div class="pdGrid">
      <div>
        <p>${esc(p.desc)}</p>
        <h3 style="margin-top:18px">Reviews</h3>
        ${reviews.map(r=>`<div class="pdReview"><div class="pdReviewHead"><span>${esc(r.name)}</span><span class="stars">${stars(r.rating)}</span></div><div class="small">${r.daysAgo} days ago</div><p style="margin:6px 0 0">${esc(r.text)}</p></div>`).join('')}
      </div>
      <div>
        <div class="destOverviewGrid" style="grid-template-columns:1fr;margin-top:0">${infoRows}</div>
        ${p.type!=='hotel' ? `<div class="aiInsightCard">
          <div class="k">✨ AI Insight</div>
          <p>${esc(generateAIInsight(p, dest))}</p>
        </div>` : ''}
        <div class="rowgap" style="margin-top:14px">
          <button class="btn primary block" id="pdAddBtn"><i class="fa-solid fa-plus"></i> Add to Trip</button>
          <button class="btn block" id="pdSaveBtn">${isSaved?'♥ Saved':'♡ Save to collection'}</button>
          <button class="btn block" id="pdMapBtn"><i class="fa-solid fa-map-location-dot"></i> View on Map</button>
          <a class="btn block" style="justify-content:center" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name+' '+dest.name)}"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open in Google Maps</a>
        </div>
      </div>
    </div>`;
  $('pdAddBtn').onclick = ()=>{ closeModal('modal-placeDetail'); openAddToTrip(p.id); };
  $('pdSaveBtn').onclick = ()=>{ openSaveTo(p.id); };
  $('pdMapBtn').onclick = ()=>{ closeModal('modal-placeDetail'); viewPlaceOnMap(p.id); };
  hydratePhotos($('placeDetailContent'));
  openModal('modal-placeDetail');
}

/* ---------------- add to trip modal ---------------- */
function openAddToTrip(placeId){
  const p = placeById(placeId);
  if(!p) return;
  const dest = DESTINATIONS.find(d=>d.id===p.destId);
  const existing = tripsForDest(p.destId);
  $('addToTripSub').textContent = `Add ${p.name} to which trip & day?`;
  function renderBody(){
    const trip = existing[0];
    let html = '';
    if(!existing.length){
      html = `<div class="empty">You don't have a trip to ${esc(dest.name)} yet.</div>
        <button class="btn primary block" style="margin-top:12px" id="atCreateBtn">＋ Create a trip to ${esc(dest.name)}</button>`;
    } else {
      html = `<div class="field" style="margin-bottom:12px"><label>Trip</label>
        <select id="atTripSelect">${existing.map(t=>`<option value="${t.id}">${esc(t.title)}</option>`).join('')}</select></div>
        <div class="small" style="font-weight:700;margin-bottom:8px">Choose a day</div>
        <div class="pillRow" id="atDayRow"></div>`;
    }
    $('addToTripBody').innerHTML = html;
    if(!existing.length){
      $('atCreateBtn').onclick = ()=>{ const t=getOrCreateDraftTrip(p.destId); existing.push(t); renderBody(); };
      return;
    }
    const select = $('atTripSelect');
    let chosenDay = 0, chosenTimeOfDay = 'morning';
    const TIME_OF_DAY_DEFAULTS = { morning:'09:00', afternoon:'13:00', evening:'18:00' };
    function renderDays(){
      const t = getTrip(select.value);
      chosenDay = clamp(chosenDay, 0, t.days.length-1);
      $('atDayRow').innerHTML = t.days.map((d,i)=>`<button class="pill ${i===chosenDay?'active':''}" data-day="${i}">Day ${i+1} · ${fmtDateShort(d.date)}</button>`).join('') +
        `<button class="pill" data-newday="1">＋ New day</button>`;
      $('atDayRow').querySelectorAll('[data-day]').forEach(btn=>btn.onclick=()=>{ chosenDay = Number(btn.dataset.day); renderDays(); });
      $('atDayRow').querySelector('[data-newday]').onclick = ()=>{
        const t2 = getTrip(select.value);
        addDayToTrip(t2);
        chosenDay = t2.days.length-1;
        renderDays();
      };
      renderTimeStep();
    }
    function renderTimeStep(){
      let step = $('atTimeStep');
      if(!step){
        $('addToTripBody').insertAdjacentHTML('beforeend', `
          <div id="atTimeStep" style="margin-top:14px">
            <div class="small" style="font-weight:700;margin-bottom:8px">Time of day</div>
            <div class="pillRow" id="atTimeOfDay">
              <button class="pill" data-tod="morning">🌅 Morning</button>
              <button class="pill" data-tod="afternoon">☀️ Afternoon</button>
              <button class="pill" data-tod="evening">🌆 Evening</button>
            </div>
            <div class="field" style="margin-top:10px;max-width:180px"><label>Optional exact start time</label><input type="time" id="atCustomTime"></div>
            <button class="btn primary block" style="margin-top:14px" id="atConfirmBtn">＋ Add to Trip</button>
          </div>`);
        step = $('atTimeStep');
      }
      $('atTimeOfDay').querySelectorAll('[data-tod]').forEach(b=>{
        b.classList.toggle('active', b.dataset.tod===chosenTimeOfDay);
        b.onclick = ()=>{ chosenTimeOfDay = b.dataset.tod; $('atCustomTime').value=''; $('atTimeOfDay').querySelectorAll('[data-tod]').forEach(x=>x.classList.toggle('active', x===b)); };
      });
      $('atConfirmBtn').onclick = ()=>{
        const t2 = getTrip(select.value);
        const customTime = $('atCustomTime').value;
        const time = customTime || TIME_OF_DAY_DEFAULTS[chosenTimeOfDay];
        addPlaceToTrip(t2, chosenDay, p, time);
        closeModal('modal-addToTrip');
        toast(`${p.name} added to Day ${chosenDay+1} of ${t2.title} at ${fmtTime12(time)}.`);
      };
    }
    select.onchange = ()=>{ chosenDay = 0; renderDays(); };
    renderDays();
  }
  renderBody();
  openModal('modal-addToTrip');
}
function addDayToTrip(trip){
  const last = trip.days[trip.days.length-1];
  const date = last ? addDays(last.date,1) : toDateInput(new Date());
  trip.days.push({date, stops:[]});
  trip.end = trip.days[trip.days.length-1].date;
  saveState();
}
function addPlaceToTrip(trip, dayIdx, place, time){
  const day = trip.days[dayIdx];
  if(day.stops.some(s=>s.placeId===place.id)){ toast(`${place.name} is already on that day.`); return; }
  const lastStop = day.stops[day.stops.length-1];
  let nextTime = time;
  if(!nextTime){
    if(lastStop){ nextTime = addMinutesToTime(lastStop.time, (lastStop.duration||90)+20); }
    else nextTime = '09:00';
  }
  const stop = mkStopFromPlace(place, nextTime);
  day.stops.push(stop);
  logActivity(trip, `added ${place.name} to Day ${dayIdx+1}.`);
  saveState();
  refreshCurrentView();
}
function addMinutesToTime(t, mins){
  const [h,m] = (t||'09:00').split(':').map(Number);
  let total = (h*60+m+mins) % (24*60);
  if(total<0) total += 24*60;
  const hh = Math.floor(total/60), mm = total%60;
  return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
}
function fmtTime12(t){
  const [h,m] = (t||'09:00').split(':').map(Number);
  const ap = h>=12?'PM':'AM'; let hh=h%12; if(hh===0) hh=12;
  return `${hh}:${String(m).padStart(2,'0')} ${ap}`;
}

/* ---------------- save to collection modal ---------------- */
let __saveToPlaceId = null;
function openSaveTo(placeId){
  __saveToPlaceId = placeId;
  renderSaveToBody();
  openModal('modal-saveTo');
}
function renderSaveToBody(){
  const p = placeById(__saveToPlaceId);
  const html = STATE.collections.map(c=>{
    const has = c.placeIds.includes(p.id);
    return `<label class="listRow" style="cursor:pointer"><div class="left"><input type="checkbox" class="check" data-coll="${c.id}" ${has?'checked':''}><span>${c.icon} ${esc(c.name)}</span></div><span class="small">${c.placeIds.length} saved</span></label>`;
  }).join('') + `<button class="btn block" style="margin-top:10px" id="stoNewColl">＋ Create new collection</button>`;
  $('saveToBody').innerHTML = html;
  $('saveToBody').querySelectorAll('[data-coll]').forEach(cb=>cb.onchange=()=>{
    const c = STATE.collections.find(x=>x.id===cb.dataset.coll);
    if(cb.checked){ if(!c.placeIds.includes(p.id)) c.placeIds.push(p.id); }
    else { c.placeIds = c.placeIds.filter(id=>id!==p.id); }
    saveState();
    toast(cb.checked? `Saved to ${c.name}.` : `Removed from ${c.name}.`);
    refreshCurrentView();
  });
  $('stoNewColl').onclick = ()=>{ closeModal('modal-saveTo'); openModal('modal-newCollection'); $('collName').focus(); };
}
function initSaveToAndCollectionModals(){
  $('createCollectionBtn').onclick = ()=>{
    const name = $('collName').value.trim();
    if(!name){ toast('Give your collection a name.'); return; }
    const icon = $('collIcon').value.trim() || '📌';
    const c = {id:uid('coll'), name, icon, placeIds:[]};
    STATE.collections.push(c);
    if(__saveToPlaceId){ c.placeIds.push(__saveToPlaceId); }
    saveState();
    closeModal('modal-newCollection');
    $('collName').value=''; $('collIcon').value='📌';
    toast(`Collection "${name}" created.`);
    if(location.hash.startsWith('#/saved')) renderSavedView(c.id);
  };
  $('newCollectionBtn').onclick = ()=>{ __saveToPlaceId=null; openModal('modal-newCollection'); };
}

function refreshCurrentView(){ route(); }

/* ============================================================
   HOME VIEW
============================================================ */
function renderHomeView(){
  const trending = DESTINATIONS.filter(d=>d.tags.includes('trending')).slice(0,8);
  $('trendingStrip').innerHTML = trending.map(d=>destCardHTML(d)).join('');
  wireDestCards($('trendingStrip'));
  if(!$('heroStart').value){
    const s = new Date(Date.now()+21*86400000);
    $('heroStart').value = toDateInput(s);
    $('heroEnd').value = addDays(toDateInput(s), 5);
  }
}
function destCardHTML(d, tagLabel){
  return `<button class="destCard" data-dest="${d.id}">
    ${tagLabel?`<span class="destCardTag">${esc(tagLabel)}</span>`:''}
    <img src="${d.hero}" alt="${esc(d.name)}" loading="lazy" data-photo-q="${esc(destPhotoQuery(d))}">
    <div class="destCardBody"><h4>${d.flag} ${esc(d.name)}</h4><span>${esc(d.country)}</span></div>
  </button>`;
}
function wireDestCards(container){
  container.querySelectorAll('[data-dest]').forEach(b=>b.onclick=()=>navigate(`#/destination/${encodeURIComponent(b.dataset.dest)}`));
  hydratePhotos(container);
}

function initHero(){
  const auto = $('heroDestAuto');
  $('heroDestination').addEventListener('input', debounce(e=>renderDestAuto(e.target.value, auto, (name)=>{ $('heroDestination').value=name; auto.classList.remove('show'); }), 120));
  $('heroDestination').addEventListener('focus', e=>renderDestAuto(e.target.value, auto, (name)=>{ $('heroDestination').value=name; auto.classList.remove('show'); }));
  document.addEventListener('click', e=>{ if(!e.target.closest('.planbox-field')) auto.classList.remove('show'); });

  $('exploreDestBtn').onclick = ()=>{
    const name = $('heroDestination').value.trim() || 'Tokyo, Japan';
    const d = findDestination(name);
    stashHeroParams();
    navigate(`#/destination/${encodeURIComponent(d.id)}`);
  };
  $('surpriseMeBtn').onclick = ()=>{
    let name = $('heroDestination').value.trim();
    if(!name){ const pool = DESTINATIONS.filter(d=>d.tags.includes('trending')); name = pool[Math.floor(Math.random()*pool.length)].name; }
    const d = findDestination(name);
    stashHeroParams();
    navigate(`#/ideas/${encodeURIComponent(d.id)}`);
  };
}
function stashHeroParams(){
  window.__heroParams = {
    start: $('heroStart').value, end: $('heroEnd').value,
    travelers: parseInt($('heroTravelers').value)||2,
  };
}
function renderDestAuto(q, el, onPick){
  q = (q||'').trim().toLowerCase();
  if(!q){ el.classList.remove('show'); return; }
  const matches = DESTINATIONS.filter(d=>!d.id.startsWith('gen-') && (d.name.toLowerCase().includes(q)||d.country.toLowerCase().includes(q))).slice(0,6);
  if(!matches.length){ el.classList.remove('show'); return; }
  el.innerHTML = matches.map(d=>`<button class="autolist-row" data-name="${esc(d.name+', '+d.country)}">${d.flag} ${esc(d.name)}, ${esc(d.country)}</button>`).join('');
  el.classList.add('show');
  el.querySelectorAll('[data-name]').forEach(b=>b.onclick=()=>onPick(b.dataset.name));
}

/* ============================================================
   DISCOVER VIEW
============================================================ */
const DISCOVER_SECTIONS = [
  {key:'trending', title:'🔥 Trending destinations', sub:'Where travelers are heading right now'},
  {key:'beach', title:'🌴 Beach destinations', sub:'Sand, sun and turquoise water'},
  {key:'adventure', title:'🏔 Adventure destinations', sub:'For your next adrenaline fix'},
  {key:'food', title:'🍜 Best cities for food', sub:'Eat your way through these cities'},
  {key:'romantic', title:'💑 Romantic getaways', sub:'For anniversaries, honeymoons & proposals'},
  {key:'affordable', title:'💰 Affordable destinations', sub:'Amazing trips that won\'t break the bank'},
  {key:'hidden', title:'🌎 Hidden gems', sub:'Less crowded, just as unforgettable'},
];
function renderDiscoverView(){
  const html = DISCOVER_SECTIONS.map(sec=>{
    const list = DESTINATIONS.filter(d=>!d.id.startsWith('gen-') && d.tags.includes(sec.key));
    if(!list.length) return '';
    return `<section class="landSection" style="padding-left:0;padding-right:0">
      <div class="landSectionHead"><h2>${sec.title}</h2><p>${sec.sub}</p></div>
      <div class="destStrip">${list.map(d=>destCardHTML(d)).join('')}</div>
    </section>`;
  }).join('');
  $('discoverSections').innerHTML = html;
  wireDestCards($('discoverSections'));
}

/* ============================================================
   DESTINATION VIEW
============================================================ */
let destState = { id:null, tab:'overview', thingsFilters:{cat:'all',price:'any',rating:'any',sort:'rec'}, restFilters:{cuisine:'all',price:'any',rating:'any',open:false,dietary:new Set(),sort:'rec'}, hotelFilters:{price:'any',stars:'any',guest:'any',amenity:'all',sort:'rec'}, mapCats:new Set(['attraction','restaurant','hotel']) };

const DEST_TABS = [
  ['overview','Overview'],['things','Things To Do'],['restaurants','Restaurants'],
  ['hotels','Hotels'],['itinerary','Itinerary'],['map','Map'],['ideas','Trip Ideas'],
];

function renderDestinationView(idOrName, tab){
  let dest = resolveDestFromId(idOrName) || findDestination(idOrName);
  if(destState.id !== dest.id){ destState = { id:dest.id, tab:tab, thingsFilters:{cat:'all',price:'any',rating:'any',sort:'rec'}, restFilters:{cuisine:'all',price:'any',rating:'any',open:false,dietary:new Set(),sort:'rec'}, hotelFilters:{price:'any',stars:'any',guest:'any',amenity:'all',sort:'rec'}, mapCats:new Set(['attraction','restaurant','hotel']) }; }
  destState.tab = tab || destState.tab || 'overview';

  $('destHero').innerHTML = `
    <img src="${dest.hero}" alt="${esc(dest.name)}" data-photo-q="${esc(destPhotoQuery(dest))}">
    <div class="destHeroActions">
      <button class="btn" id="destSaveBtn"><i class="fa-solid fa-heart"></i> Save destination</button>
    </div>
    <div class="destHeroBody">
      <div class="flag">${dest.flag} ${esc(dest.country||'')}</div>
      <h1>${esc(dest.name)}</h1>
      <p>${esc(dest.tagline)}</p>
    </div>`;
  hydratePhotos($('destHero'));
  if(dest.id.startsWith('gen-')){
    enrichDestinationInBackground(dest, ()=>{
      if(location.hash.includes('/destination/'+encodeURIComponent(dest.id))){
        toast(`Found real places near ${dest.name}!`);
        renderDestinationView(dest.id, destState.tab);
      }
    });
  } else {
    supplementDestinationInBackground(dest, ()=>{
      if(location.hash.includes('/destination/'+encodeURIComponent(dest.id)) && destState.tab==='things'){
        renderDestinationView(dest.id, destState.tab);
      }
    });
  }
  $('destSaveBtn').onclick = ()=>{
    const c = STATE.collections[0];
    if(!c.placeIds.includes('dest:'+dest.id)){ c.placeIds.push('dest:'+dest.id); toast(`Saved ${dest.name} to ${c.name}.`); }
    else toast(`${dest.name} is already saved.`);
    saveState();
  };

  $('destTabs').innerHTML = DEST_TABS.map(([key,label])=>`<button class="dtab ${destState.tab===key?'active':''}" data-tab="${key}">${label}</button>`).join('');
  $('destTabs').querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{
    navigate(`#/destination/${encodeURIComponent(dest.id)}/${b.dataset.tab}`);
  });

  const body = $('destTabBody');
  if(destState.tab==='overview') renderDestOverview(dest, body);
  else if(destState.tab==='things') renderDestThings(dest, body);
  else if(destState.tab==='restaurants') renderDestRestaurants(dest, body);
  else if(destState.tab==='hotels') renderDestHotels(dest, body);
  else if(destState.tab==='itinerary') renderDestItinerary(dest, body);
  else if(destState.tab==='map') renderDestMap(dest, body);
  else if(destState.tab==='ideas') renderDestIdeas(dest, body);
}

function renderDestOverview(dest, body){
  const top = placesFor(dest.id,'attraction').slice().sort((a,b)=>b.rating-a.rating).slice(0,3);
  const topRest = placesFor(dest.id,'restaurant').slice().sort((a,b)=>b.rating-a.rating).slice(0,3);
  const info = dest.travelInfo || {};
  body.innerHTML = `
    <p style="max-width:760px;color:var(--muted);font-size:15px;line-height:1.6">${esc(dest.description)}</p>
    ${info.recommendedDays ? `<p class="small" style="font-weight:700;margin:-6px 0 14px">First time visiting? Recommended trip duration: ${esc(info.recommendedDays)}</p>` : ''}
    <div class="destOverviewGrid">
      <div class="ovCard"><div class="k">🌤 Weather</div><div class="v">${esc(dest.weather)}</div></div>
      <div class="ovCard"><div class="k">📅 Best time to visit</div><div class="v">${esc(dest.bestTime)}</div></div>
      <div class="ovCard"><div class="k">💱 Currency</div><div class="v">${esc(dest.currency)}</div></div>
      <div class="ovCard"><div class="k">🗣 Language</div><div class="v">${esc(dest.language)}</div></div>
      ${(()=>{ const c = destinationClock(dest); return c
        ? `<div class="ovCard"><div class="k">🕐 Local time right now</div><div class="v">${c.time12}</div><div class="v small">${esc(c.label)}${c.diff===0?' · same as you':` · ${Math.abs(c.diff)}h ${c.diff>0?'ahead':'behind'}`}</div></div>`
        : (info.timezone ? `<div class="ovCard"><div class="k">🕐 Time zone</div><div class="v">${esc(info.timezone)}</div></div>` : ''); })()}
      ${info.recommendedDays ? `<div class="ovCard"><div class="k">🗓 Recommended duration</div><div class="v">${esc(info.recommendedDays)}</div></div>` : ''}
    </div>
    <div class="card" style="margin-top:8px">
      <h3>Average daily budget</h3>
      <div class="sectionGrid" style="grid-template-columns:repeat(3,1fr)">
        <div class="ovCard"><div class="k">Budget</div><div class="v" style="font-size:20px">${fmt$(dest.avgDailyBudget.budget)}<span class="small">/day</span></div></div>
        <div class="ovCard"><div class="k">Moderate</div><div class="v" style="font-size:20px">${fmt$(dest.avgDailyBudget.moderate)}<span class="small">/day</span></div></div>
        <div class="ovCard"><div class="k">Luxury</div><div class="v" style="font-size:20px">${fmt$(dest.avgDailyBudget.luxury)}<span class="small">/day</span></div></div>
      </div>
    </div>
    ${(info.visa||info.safety||info.localTransport||info.etiquette) ? `
    <div class="card" style="margin-top:16px">
      <h3>🧭 Know before you go</h3>
      <div class="knowBeforeGrid">
        ${info.visa ? `<div class="ovCard"><div class="k">🛂 Visa</div><div class="v small">${esc(info.visa)}</div></div>` : ''}
        ${info.safety ? `<div class="ovCard"><div class="k">🛡 Safety</div><div class="v small">${esc(info.safety)}</div></div>` : ''}
        ${info.localTransport ? `<div class="ovCard"><div class="k">🚇 Getting around</div><div class="v small">${esc(info.localTransport)}</div></div>` : ''}
        ${info.etiquette ? `<div class="ovCard"><div class="k">🙏 Local etiquette</div><div class="v small">${esc(info.etiquette)}</div></div>` : ''}
      </div>
    </div>` : ''}
    <div class="card" style="margin-top:16px">
      <h3>💱 Currency converter</h3>
      <div class="currencyConvRow">
        <div class="field"><label>Amount</label><input type="number" id="convAmount" value="100" min="0"></div>
        <div class="field"><label>From</label><select id="convFrom"></select></div>
        <button class="iconbtn" id="convSwap" title="Swap"><i class="fa-solid fa-right-left"></i></button>
        <div class="field"><label>To</label><select id="convTo"></select></div>
      </div>
      <div class="currencyConvResult" id="convResult">—</div>
      <div class="small" id="convRateNote"></div>
    </div>
    <div class="panelHead" style="padding:22px 0 12px;border:0"><h3 style="font-size:19px">Top attractions</h3><button class="linklike" data-tab="things">See all →</button></div>
    <div class="placeGrid">${top.map(p=>placeCardHTML(p,{noDesc:false})).join('')}</div>
    <div class="panelHead" style="padding:22px 0 12px;border:0"><h3 style="font-size:19px">Top restaurants</h3><button class="linklike" data-tab="restaurants">See all →</button></div>
    <div class="placeGrid">${topRest.map(p=>placeCardHTML(p,{noDesc:false})).join('')}</div>
    <div class="panelHead" style="padding:22px 0 12px;border:0"><h3 style="font-size:19px">✨ Trip ideas for ${esc(dest.name)}</h3><button class="linklike" data-tab="ideas">See all →</button></div>
    <div class="ideaCardGrid" id="ovIdeaPreview"></div>
  `;
  wirePlaceCards(body);
  body.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>navigate(`#/destination/${encodeURIComponent(dest.id)}/${b.dataset.tab}`));
  const ideas = getCurrentIdeas(dest.id).slice(0,2);
  $('ovIdeaPreview').innerHTML = ideas.map(idea=>ideaCardHTML(idea)).join('');
  wireIdeaCards($('ovIdeaPreview'));
  initCurrencyConverter(dest);
}
function initCurrencyConverter(dest){
  populateCurrencyOptions($('convFrom'));
  populateCurrencyOptions($('convTo'));
  $('convFrom').value = currentCurrencyCode();
  $('convTo').value = dest.currencyCode || 'USD';
  function update(){
    // Guards against a deferred rate-load retry (see loadExchangeRates().then(update) below)
    // resolving after the user has already navigated away from this destination's Overview
    // tab, which would otherwise throw trying to write into removed DOM nodes.
    if(!$('convAmount')) return;
    const amount = Number($('convAmount').value) || 0;
    const from = $('convFrom').value, to = $('convTo').value;
    const rateFrom = EXCHANGE_RATES[from], rateTo = EXCHANGE_RATES[to];
    if(typeof rateFrom !== 'number' || typeof rateTo !== 'number'){
      $('convResult').textContent = 'Rates unavailable — check your connection.';
      $('convRateNote').textContent = '';
      return;
    }
    const usd = amount / rateFrom;
    const converted = usd * rateTo;
    const fromMeta = CURRENCY_META[from] || CURRENCY_META.USD, toMeta = CURRENCY_META[to] || CURRENCY_META.USD;
    $('convResult').textContent = `${fromMeta.symbol}${amount.toLocaleString()} = ${toMeta.symbol}${converted.toLocaleString(undefined,{maximumFractionDigits: converted>=100?0:2})}`;
    const rate = rateTo / rateFrom;
    const rateSource = EXCHANGE_RATES_ARE_LIVE ? 'live rates, updated daily' : 'approximate rates — reconnect for live rates';
    $('convRateNote').textContent = `1 ${from} = ${rate.toLocaleString(undefined,{maximumFractionDigits:4})} ${to} · ${rateSource}`;
  }
  $('convAmount').oninput = update;
  $('convFrom').onchange = update;
  $('convTo').onchange = update;
  $('convSwap').onclick = ()=>{ const f=$('convFrom').value; $('convFrom').value=$('convTo').value; $('convTo').value=f; update(); };
  update();
  if(!EXCHANGE_RATES_ARE_LIVE) loadExchangeRates().then(update); // retry once when the converter is actually opened
}

/* ---------------- Things To Do tab ---------------- */
function renderDestThings(dest, body){
  const all = placesFor(dest.id,'attraction');
  const cats = [...new Set(all.map(p=>p.category))];
  const f = destState.thingsFilters;
  body.innerHTML = `
    <div class="filterBar">
      <div class="filterGroup"><label>Category</label><select id="tCat"><option value="all">All categories</option>${cats.map(c=>`<option value="${esc(c)}" ${f.cat===c?'selected':''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="filterGroup"><label>Price</label><select id="tPrice"><option value="any">Any price</option><option value="0">Free</option><option value="1">$</option><option value="2">$$</option><option value="3">$$$</option></select></div>
      <div class="filterGroup"><label>Rating</label><select id="tRating"><option value="any">Any rating</option><option value="4.5">4.5+</option><option value="4">4.0+</option><option value="3">3.0+</option></select></div>
      <div class="filterGroup"><label>Sort</label><select id="tSort"><option value="rec">Recommended</option><option value="rating">Highest rated</option><option value="price_low">Price: low to high</option><option value="price_high">Price: high to low</option></select></div>
    </div>
    <div class="activeFilters hidden" id="thingsActiveFilters"></div>
    <div class="placeGrid" id="thingsGrid"></div>`;
  $('tCat').value=f.cat; $('tPrice').value=f.price; $('tRating').value=f.rating; $('tSort').value=f.sort;
  const PRICE_LABELS = {0:'Free',1:'$',2:'$$',3:'$$$'};
  function clearAllThings(){ f.cat='all'; f.price='any'; f.rating='any'; $('tCat').value='all'; $('tPrice').value='any'; $('tRating').value='any'; apply(); }
  function apply(){
    f.cat=$('tCat').value; f.price=$('tPrice').value; f.rating=$('tRating').value; f.sort=$('tSort').value;
    let arr = all.filter(p=>{
      if(f.cat!=='all' && p.category!==f.cat) return false;
      if(f.price!=='any' && String(p.priceLevel)!==f.price) return false;
      if(f.rating!=='any' && p.rating < parseFloat(f.rating)) return false;
      return true;
    });
    if(f.sort==='rating') arr.sort((a,b)=>b.rating-a.rating);
    else if(f.sort==='price_low') arr.sort((a,b)=>a.price-b.price);
    else if(f.sort==='price_high') arr.sort((a,b)=>b.price-a.price);
    else arr.sort((a,b)=>b.reviews-a.reviews);
    const chips = [];
    if(f.cat!=='all') chips.push({label:`Category: ${f.cat}`, onRemove:()=>{ f.cat='all'; $('tCat').value='all'; apply(); }});
    if(f.price!=='any') chips.push({label:`Price: ${PRICE_LABELS[f.price]||f.price}`, onRemove:()=>{ f.price='any'; $('tPrice').value='any'; apply(); }});
    if(f.rating!=='any') chips.push({label:`Rating: ${f.rating}+`, onRemove:()=>{ f.rating='any'; $('tRating').value='any'; apply(); }});
    renderActiveFilterChips('thingsActiveFilters', chips, clearAllThings);
    $('thingsGrid').innerHTML = arr.length? arr.map(p=>placeCardHTML(p)).join('') : '<div class="empty">No attractions match those filters.</div>';
    wirePlaceCards($('thingsGrid'));
  }
  ['tCat','tPrice','tRating','tSort'].forEach(id=>$(id).onchange=apply);
  apply();
}

/* ---------------- Restaurants tab ---------------- */
const DIETARY_OPTIONS = ['vegetarian','vegan','gluten-free-options','vegetarian-options'];
function renderDestRestaurants(dest, body){
  const all = placesFor(dest.id,'restaurant');
  const cuisines = [...new Set(all.map(p=>p.cuisine))];
  const f = destState.restFilters;
  body.innerHTML = `
    <div class="filterBar">
      <div class="filterGroup"><label>Cuisine</label><select id="rCuisine"><option value="all">All cuisines</option>${cuisines.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select></div>
      <div class="filterGroup"><label>Price</label><select id="rPrice"><option value="any">Any price</option><option value="1">$</option><option value="2">$$</option><option value="3">$$$</option><option value="4">$$$$</option></select></div>
      <div class="filterGroup"><label>Rating</label><select id="rRating"><option value="any">Any rating</option><option value="4.5">4.5+</option><option value="4">4.0+</option></select></div>
      <div class="filterGroup"><label>Sort</label><select id="rSort"><option value="rec">Recommended</option><option value="rating">Highest rated</option><option value="distance">Distance</option></select></div>
      <button class="toggleChip" id="rOpen">🕒 Open Now</button>
      <div class="pillRow" id="rDietary">${DIETARY_OPTIONS.map(d=>`<button class="pill" data-diet="${d}">${d.replace(/-/g,' ')}</button>`).join('')}</div>
    </div>
    <div class="activeFilters hidden" id="restActiveFilters"></div>
    <div class="placeGrid" id="restGrid"></div>`;
  $('rCuisine').value=f.cuisine; $('rPrice').value=f.price; $('rRating').value=f.rating; $('rSort').value=f.sort;
  $('rOpen').classList.toggle('active', f.open);
  $('rDietary').querySelectorAll('[data-diet]').forEach(b=>b.classList.toggle('active', f.dietary.has(b.dataset.diet)));
  const REST_PRICE_LABELS = {1:'$',2:'$$',3:'$$$',4:'$$$$'};
  function clearAllRest(){
    f.cuisine='all'; f.price='any'; f.rating='any'; f.open=false; f.dietary.clear();
    $('rCuisine').value='all'; $('rPrice').value='any'; $('rRating').value='any';
    $('rOpen').classList.remove('active'); $('rDietary').querySelectorAll('[data-diet]').forEach(b=>b.classList.remove('active'));
    apply();
  }
  function apply(){
    f.cuisine=$('rCuisine').value; f.price=$('rPrice').value; f.rating=$('rRating').value; f.sort=$('rSort').value;
    let arr = all.filter(p=>{
      if(f.cuisine!=='all' && p.cuisine!==f.cuisine) return false;
      if(f.price!=='any' && String(p.priceLevel)!==f.price) return false;
      if(f.rating!=='any' && p.rating < parseFloat(f.rating)) return false;
      if(f.open && !isOpenNow(p.hours)) return false;
      if(f.dietary.size && ![...f.dietary].every(d=>(p.dietary||[]).includes(d))) return false;
      return true;
    });
    if(f.sort==='rating') arr.sort((a,b)=>b.rating-a.rating);
    else if(f.sort==='distance') arr.sort((a,b)=>haversine(dest,a)-haversine(dest,b));
    else arr.sort((a,b)=>b.reviews-a.reviews);
    const chips = [];
    if(f.cuisine!=='all') chips.push({label:`Cuisine: ${f.cuisine}`, onRemove:()=>{ f.cuisine='all'; $('rCuisine').value='all'; apply(); }});
    if(f.price!=='any') chips.push({label:`Price: ${REST_PRICE_LABELS[f.price]||f.price}`, onRemove:()=>{ f.price='any'; $('rPrice').value='any'; apply(); }});
    if(f.rating!=='any') chips.push({label:`Rating: ${f.rating}+`, onRemove:()=>{ f.rating='any'; $('rRating').value='any'; apply(); }});
    if(f.open) chips.push({label:'Open now', onRemove:()=>{ f.open=false; $('rOpen').classList.remove('active'); apply(); }});
    f.dietary.forEach(d=>chips.push({label:d.replace(/-/g,' '), onRemove:()=>{ f.dietary.delete(d); $('rDietary').querySelectorAll('[data-diet]').forEach(b=>b.classList.toggle('active', f.dietary.has(b.dataset.diet))); apply(); }}));
    renderActiveFilterChips('restActiveFilters', chips, clearAllRest);
    $('restGrid').innerHTML = arr.length? arr.map(p=>{
      const distKm = haversine(dest,p).toFixed(1);
      const card = placeCardHTML(p);
      return card.replace('</div>\n      <div class="placeFoot">', `</div><div class="small">🚶 ${distKm} km from center</div>\n      <div class="placeFoot">`);
    }).join('') : '<div class="empty">No restaurants match those filters. Try clearing a filter.</div>';
    wirePlaceCards($('restGrid'));
  }
  ['rCuisine','rPrice','rRating','rSort'].forEach(id=>$(id).onchange=apply);
  $('rOpen').onclick=()=>{ f.open=!f.open; $('rOpen').classList.toggle('active',f.open); apply(); };
  $('rDietary').querySelectorAll('[data-diet]').forEach(b=>b.onclick=()=>{
    f.dietary.has(b.dataset.diet)? f.dietary.delete(b.dataset.diet) : f.dietary.add(b.dataset.diet);
    b.classList.toggle('active'); apply();
  });
  apply();
}

/* ---------------- Hotels tab ---------------- */
const AREA_TAG_LABELS = { food:'Food', culture:'Culture', history:'History', nature:'Nature', relax:'Relaxation', nightlife:'Nightlife', shopping:'Shopping', art:'Art', adventure:'Adventure', romantic:'Romantic', hidden:'Hidden gems', photography:'Photography' };
/** Groups a destination's places by neighborhood/area and characterizes each one by what's
 * actually concentrated there (from real tag data), for a "best areas to stay" overview. */
function bestAreasToStay(dest){
  const all = PLACES.filter(p=>p.destId===dest.id);
  const areaNames = [...new Set(all.map(p=>p.area).filter(Boolean))];
  return areaNames.map(area=>{
    const inArea = all.filter(p=>p.area===area);
    const hotels = inArea.filter(p=>p.type==='hotel');
    if(!hotels.length) return null; // only surface areas a visitor could actually book a hotel in
    const tagCounts = {};
    inArea.forEach(p=>(p.tags||[]).forEach(t=>{ tagCounts[t]=(tagCounts[t]||0)+1; }));
    const topTags = Object.entries(tagCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([t])=>AREA_TAG_LABELS[t]||t);
    const centroid = { lat: hotels.reduce((s,p)=>s+p.lat,0)/hotels.length, lng: hotels.reduce((s,p)=>s+p.lng,0)/hotels.length };
    return { area, tags: topTags.length?topTags:['Central location'], hotelCount: hotels.length, centroid };
  }).filter(Boolean);
}
/** Recommends the neighborhood closest, on average, to everywhere the user has actually
 * shown interest in (saved places + itinerary stops for this destination) — real geometry
 * on real data, not a fabricated suggestion. Returns null when there's nothing to base a
 * recommendation on, or when no area is meaningfully better than the rest. */
function recommendBestArea(dest, areas){
  if(areas.length<2) return null;
  const trip = STATE.trips.find(t=>t.destId===dest.id);
  const itineraryPoints = trip ? trip.days.flatMap(d=>d.stops.map(s=>({lat:s.lat,lng:s.lng}))) : [];
  const savedIds = savedPlaceIdsForDest(dest.id);
  const savedPoints = [...savedIds].map(id=>placeById(id)).filter(Boolean).map(p=>({lat:p.lat,lng:p.lng}));
  const points = [...itineraryPoints, ...savedPoints];
  if(!points.length) return null;
  const scored = areas.map(a=>({ ...a, avgDist: points.reduce((s,pt)=>s+haversine(a.centroid,pt),0)/points.length })).sort((x,y)=>x.avgDist-y.avgDist);
  const best = scored[0], others = scored.slice(1);
  const avgOthers = others.reduce((s,a)=>s+a.avgDist,0)/others.length;
  const minutesSaved = Math.round((avgOthers-best.avgDist)*12); // ~12 min/km, consistent with the route-efficiency warning
  return minutesSaved>0 ? { area:best.area, minutesSaved } : null;
}
function renderDestHotels(dest, body){
  const all = placesFor(dest.id,'hotel');
  const amenitiesAll = [...new Set(all.flatMap(p=>p.amenities||[]))];
  const f = destState.hotelFilters;
  const areas = bestAreasToStay(dest);
  const recommendation = recommendBestArea(dest, areas);
  body.innerHTML = `
    ${areas.length>=2 ? `
    <div class="card" style="margin-bottom:16px">
      <h3>🏘️ Best areas to stay</h3>
      <div class="neighborhoodGrid">
        ${areas.map(a=>`<div class="ovCard"><div class="k">${esc(a.area)}</div><div class="v small">Best for: ${a.tags.map(esc).join(', ')}</div></div>`).join('')}
      </div>
      ${recommendation ? `<div class="aiInsightCard" style="margin-top:14px">
        <div class="k">✨ TripFlow Recommendation</div>
        <p>Based on your saved attractions and itinerary, <b>${esc(recommendation.area)}</b> is the best neighborhood for your stay — it could reduce your average daily travel time by approximately ${recommendation.minutesSaved} minutes.</p>
      </div>` : ''}
    </div>` : ''}
    <div class="filterBar">
      <div class="filterGroup"><label>Price / night</label><select id="hPrice"><option value="any">Any price</option><option value="0-100">Under $100</option><option value="100-250">$100–250</option><option value="250-500">$250–500</option><option value="500-99999">$500+</option></select></div>
      <div class="filterGroup"><label>Star rating</label><select id="hStars"><option value="any">Any stars</option><option value="5">5 star</option><option value="4">4 star</option><option value="3">3 star</option><option value="2">2 star &amp; under</option></select></div>
      <div class="filterGroup"><label>Guest rating</label><select id="hGuest"><option value="any">Any rating</option><option value="9">9.0+ Exceptional</option><option value="8">8.0+ Very good</option></select></div>
      <div class="filterGroup"><label>Amenity</label><select id="hAmenity"><option value="all">Any amenity</option>${amenitiesAll.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join('')}</select></div>
      <div class="filterGroup"><label>Sort</label><select id="hSort"><option value="rec">Recommended</option><option value="price_low">Lowest price</option><option value="rating">Highest rated</option><option value="distance">Distance from center</option></select></div>
    </div>
    <div class="activeFilters hidden" id="hotelActiveFilters"></div>
    <div class="placeGrid" id="hotelGrid"></div>`;
  $('hPrice').value=f.price; $('hStars').value=f.stars; $('hGuest').value=f.guest; $('hAmenity').value=f.amenity; $('hSort').value=f.sort;
  const HOTEL_PRICE_LABELS = {'0-100':'Under $100','100-250':'$100–250','250-500':'$250–500','500-99999':'$500+'};
  function clearAllHotels(){
    f.price='any'; f.stars='any'; f.guest='any'; f.amenity='all';
    $('hPrice').value='any'; $('hStars').value='any'; $('hGuest').value='any'; $('hAmenity').value='all';
    apply();
  }
  function apply(){
    f.price=$('hPrice').value; f.stars=$('hStars').value; f.guest=$('hGuest').value; f.amenity=$('hAmenity').value; f.sort=$('hSort').value;
    let arr = all.filter(p=>{
      if(f.price!=='any'){ const [lo,hi]=f.price.split('-').map(Number); if(p.price<lo||p.price>hi) return false; }
      if(f.stars!=='any'){ if(f.stars==='2'){ if(p.stars>2) return false; } else if(p.stars!==Number(f.stars)) return false; }
      if(f.guest!=='any' && p.guestRating < Number(f.guest)) return false;
      if(f.amenity!=='all' && !(p.amenities||[]).includes(f.amenity)) return false;
      return true;
    });
    if(f.sort==='price_low') arr.sort((a,b)=>a.price-b.price);
    else if(f.sort==='rating') arr.sort((a,b)=>b.guestRating-a.guestRating);
    else if(f.sort==='distance') arr.sort((a,b)=>haversine(dest,a)-haversine(dest,b));
    else arr.sort((a,b)=>b.guestRating-a.guestRating);
    const chips = [];
    if(f.price!=='any') chips.push({label:`Price: ${HOTEL_PRICE_LABELS[f.price]||f.price}`, onRemove:()=>{ f.price='any'; $('hPrice').value='any'; apply(); }});
    if(f.stars!=='any') chips.push({label:`Stars: ${f.stars==='2'?'2 & under':f.stars+' star'}`, onRemove:()=>{ f.stars='any'; $('hStars').value='any'; apply(); }});
    if(f.guest!=='any') chips.push({label:`Guest rating: ${f.guest}.0+`, onRemove:()=>{ f.guest='any'; $('hGuest').value='any'; apply(); }});
    if(f.amenity!=='all') chips.push({label:`Amenity: ${f.amenity}`, onRemove:()=>{ f.amenity='all'; $('hAmenity').value='all'; apply(); }});
    renderActiveFilterChips('hotelActiveFilters', chips, clearAllHotels);
    $('hotelGrid').innerHTML = arr.length? arr.map(p=>{
      const distKm = haversine(dest,p).toFixed(1);
      const card = placeCardHTML(p);
      return card.replace('</div>\n      <div class="placeFoot">', `</div><div class="small">🚶 ${distKm} km from center</div>\n      <div class="placeFoot">`);
    }).join('') : '<div class="empty">No hotels match those filters.</div>';
    wirePlaceCards($('hotelGrid'));
  }
  ['hPrice','hStars','hGuest','hAmenity','hSort'].forEach(id=>$(id).onchange=apply);
  apply();
}

/* ---------------- Itinerary tab (destination-scoped CTA) ---------------- */
function renderDestItinerary(dest, body){
  const trips = tripsForDest(dest.id);
  if(!trips.length){
    body.innerHTML = `
      <div class="empty" style="padding:60px 20px">
        <div style="font-size:32px;margin-bottom:10px">🗺️</div>
        <div style="font-size:16px;margin-bottom:14px">You don't have a trip to ${esc(dest.name)} yet.</div>
        <button class="btn primary" id="destQuickStart">✨ Quick-start a ${esc(dest.name)} trip</button>
      </div>`;
    $('destQuickStart').onclick = ()=>{
      const trip = getOrCreateDraftTrip(dest.id);
      const top = placesFor(dest.id,'attraction').slice().sort((a,b)=>b.rating-a.rating).slice(0,3);
      top.forEach((p,i)=>addPlaceToTripSilent(trip, 0, p));
      saveState();
      toast(`Created a draft trip and added top picks to Day 1.`);
      navigate(`#/trip/${trip.id}`);
    };
    return;
  }
  body.innerHTML = trips.map(t=>{
    const planned = tripPlannedTotal(t);
    return `<div class="card" style="margin-bottom:14px">
      <div class="panelHead" style="padding:0 0 12px;border:0">
        <div><h3 style="margin:0">${esc(t.title)}</h3><div class="small">${fmtDateFull(t.start)} – ${fmtDateFull(t.end)} · ${t.days.length} days · ${tripStopCount(t)} stops</div></div>
        <button class="btn primary" data-open="${t.id}">Open Trip Planner →</button>
      </div>
      <div class="dayTabs" style="border:0;padding:0">${t.days.map((d,i)=>`<span class="dayTab" style="cursor:default">Day ${i+1} · ${d.stops.length} stops</span>`).join('')}</div>
      <div class="small" style="margin-top:8px">Planned spend: <strong>${fmt$(planned)}</strong> of ${fmt$(t.budget.total)} budget</div>
    </div>`;
  }).join('') + `<button class="btn" id="destAddAnotherTrip">＋ Plan another trip to ${esc(dest.name)}</button>`;
  body.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>navigate(`#/trip/${b.dataset.open}`));
  $('destAddAnotherTrip').onclick = ()=>{ $('newTripDest').value = `${dest.name}, ${dest.country}`; openModal('modal-newTrip'); };
}
function addPlaceToTripSilent(trip, dayIdx, place){
  const day = trip.days[dayIdx];
  if(day.stops.some(s=>s.placeId===place.id)) return;
  const lastStop = day.stops[day.stops.length-1];
  const nextTime = lastStop ? addMinutesToTime(lastStop.time,(lastStop.duration||90)+20) : '09:00';
  day.stops.push(mkStopFromPlace(place, nextTime));
}

/* ---------------- Map tab (destination discovery map, real embedded Google Maps) ---------------- */
window.__destMapPlaceId = null;
function renderDestMap(dest, body){
  body.innerHTML = `
    <div class="panel mapPanel" style="min-height:600px">
      <div class="panelHead"><h3>Explore ${esc(dest.name)} on the map</h3>
        <div class="rowgap">
          <a class="btn sm" id="destMapOpen" href="${gmapsExternalLink(dest.name+(dest.country?', '+dest.country:''))}" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i> Open in Google Maps</a>
          <button class="btn sm" id="destMapCenter"><i class="fa-solid fa-crosshairs"></i> Center</button>
        </div>
      </div>
      <div class="mapLegend" id="destMapLegend"></div>
      <div class="mapSplit">
        <div class="map" id="destMap" style="min-height:420px">
          ${navigator.onLine===false ? mapUnavailableHTML() : `<iframe id="destMapFrame" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen src="${gmapsSearchEmbedUrl(dest.name+(dest.country?', '+dest.country:''),13)}"></iframe>`}
        </div>
        <div class="mapPlaceList" id="destMapList"></div>
      </div>
    </div>`;
  const legends = [['attraction','Attractions','var(--cat-attraction)'],['restaurant','Restaurants','var(--cat-restaurant)'],['hotel','Hotels','var(--cat-hotel)']];
  $('destMapLegend').innerHTML = legends.map(([k,l,c])=>`<button class="legend ${destState.mapCats.has(k)?'active':''}" data-cat="${k}"><span class="legendDot" style="background:${c}"></span>${l}</button>`).join('');
  window.__destMapDest = dest;
  window.__destMapPlaceId = null;
  function draw(){
    const list = PLACES.filter(p=>p.destId===dest.id && destState.mapCats.has(p.type));
    $('destMapList').innerHTML = list.map(p=>`
      <div class="mapPlaceRow ${p.id===window.__destMapPlaceId?'active':''}" data-mapplace="${p.id}">
        <div class="stopThumb"><span class="num" style="background:${catColor(p.type)}">${catEmoji(p.type)}</span><img src="${p.image}" data-photo-q="${esc(photoQuery(p.name, dest.name))}"></div>
        <div class="mapPlaceInfo">
          <h4>${esc(p.name)}</h4>
          <p>${p.rating?('★ '+p.rating+' · '):''}${esc(p.area||'')}</p>
        </div>
        <button class="btn sm primary" data-popadd="${p.id}">＋</button>
      </div>`).join('') || `<div class="empty small">No places in this category.</div>`;
    $('destMapList').querySelectorAll('[data-mapplace]').forEach(row=>row.addEventListener('click',(e)=>{
      if(e.target.closest('[data-popadd]')) return;
      const p = placeById(row.dataset.mapplace);
      if(p) focusDestMapPlace(p);
    }));
    $('destMapList').querySelectorAll('[data-popadd]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openAddToTrip(b.dataset.popadd); });
    hydratePhotos($('destMapList'));
  }
  draw();
  $('destMapLegend').querySelectorAll('[data-cat]').forEach(b=>b.onclick=()=>{
    const k=b.dataset.cat;
    destState.mapCats.has(k)? destState.mapCats.delete(k) : destState.mapCats.add(k);
    b.classList.toggle('active');
    draw();
  });
  $('destMapCenter').onclick = ()=>{
    window.__destMapPlaceId = null;
    const frame = $('destMapFrame');
    if(frame) frame.src = gmapsSearchEmbedUrl(dest.name+(dest.country?', '+dest.country:''),13);
    draw();
  };
}
function focusDestMapPlace(p){
  const dest = window.__destMapDest || DESTINATIONS.find(d=>d.id===p.destId);
  window.__destMapPlaceId = p.id;
  const frame = $('destMapFrame');
  if(frame) frame.src = gmapsSearchEmbedUrl(p.name+(dest?', '+dest.name:''),16);
  const open = $('destMapOpen');
  if(open) open.href = gmapsExternalLink(p.name+(dest?', '+dest.name:''));
  $$('#destMapList .mapPlaceRow').forEach(row=>row.classList.toggle('active', row.dataset.mapplace===p.id));
}

/* ---------------- Trip Ideas tab ---------------- */
function renderDestIdeas(dest, body){
  body.innerHTML = `
    <div class="panelHead" style="padding:0 0 14px;border:0">
      <p class="small" style="margin:0">${IDEAS_SHOWN_PER_GENERATE} themed trip concepts for ${esc(dest.name)}.</p>
      <button class="btn primary" id="destIdeasRegen">🔄 Generate New Ideas</button>
    </div>
    <div id="destIdeasGrid" class="ideaCardGrid"></div>`;
  function render(ideas){
    $('destIdeasGrid').innerHTML = ideas.map(idea=>ideaCardHTML(idea)).join('');
    wireIdeaCards($('destIdeasGrid'));
    hydratePhotos($('destIdeasGrid'));
  }
  render(getCurrentIdeas(dest.id));
  $('destIdeasRegen').onclick = ()=>{ render(regenerateIdeas(dest.id)); toast('Generated a fresh set of trip ideas!'); };
}

/* ============================================================
   AI TRIP IDEA GENERATOR
============================================================ */
const IDEA_STORE = {};
const DEST_CURRENT_IDEA_IDS = {}; // destId -> [ideaId,...] — the "current" stable batch shown until the user explicitly regenerates
const IDEA_DEFAULT_DAYS = {food:3, culture:4, nightlife:2, shopping:2, relax:3, art:2, adventure:3, romantic:2, hidden:3, family:4, luxury:3, solo:3, photo:2, wellness:3, budget:3, classic:4};

function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
const MIN_ATTRACTIONS_PER_DAY = 5;
function pickFromPool(pool, wantCount, filters){
  let filtered = pool.filter(p=>filters.every(f=>f(p)));
  if(filtered.length < wantCount) filtered = pool; // relax filters rather than come up short
  const byRating = filtered.slice().sort((a,b)=>b.rating-a.rating);
  const candidatePool = byRating.slice(0, Math.min(byRating.length, wantCount + 8));
  return shuffle(candidatePool).slice(0, Math.min(wantCount, candidatePool.length));
}
function pickPlacesForIdea(destId, interests, budgetStyle, days){
  // Real curated + live-enriched/supplemented places only — never fabricated filler. If the
  // real pool is smaller than days*MIN_ATTRACTIONS_PER_DAY, the idea simply uses what's really
  // there (a background fetch may still be topping up the pool; see supplementDestinationInBackground).
  const priceOk = p=> budgetStyle==='budget' ? (p.priceLevel||0)<=2 : true;
  const interestOk = p=> (p.tags||[]).some(t=>interests.includes(t));

  const attrPool = placesFor(destId,'attraction');
  const restPool = placesFor(destId,'restaurant');
  const neededAttr = Math.min(days*MIN_ATTRACTIONS_PER_DAY, attrPool.length);
  const neededRest = Math.min(restPool.length, days*2);

  const attractions = pickFromPool(attrPool, neededAttr, [interestOk, priceOk]);
  const restaurants = pickFromPool(restPool, neededRest, [priceOk]);
  return attractions.concat(restaurants);
}
function buildIdea(destId, archetype, overrides){
  const dest = DESTINATIONS.find(d=>d.id===destId);
  const days = (overrides && overrides.days) || IDEA_DEFAULT_DAYS[archetype.key] || 3;
  const budgetStyle = (overrides && overrides.budgetStyle) || 'moderate';
  const pace = (overrides && overrides.pace) || 'Balanced';
  const interests = (overrides && overrides.interests) || archetype.tags.slice();
  const id = (overrides && overrides.__keepId) || uid('idea');
  const idea = { id, destId, key:archetype.key, emoji:archetype.emoji,
    title: archetype.titleTpl.replace('{city}', dest.name),
    desc: archetype.descTpl.replace(/{city}/g, dest.name),
    days, budgetStyle, pace, interests,
    places: pickPlacesForIdea(destId, interests, budgetStyle, days) };
  IDEA_STORE[id] = idea;
  return idea;
}
/** Explicit "Generate" action — always produces a brand-new, randomized batch of ideas: a
 * fresh random subset of archetypes (so the themes themselves vary between generations, not
 * just the places inside each one), each rebuilt with a freshly shuffled real-place selection. */
function regenerateIdeas(destId){
  const chosen = shuffle(TRIP_ARCHETYPES).slice(0, Math.min(IDEAS_SHOWN_PER_GENERATE, TRIP_ARCHETYPES.length));
  const ideas = chosen.map(a=>buildIdea(destId, a));
  DEST_CURRENT_IDEA_IDS[destId] = ideas.map(i=>i.id);
  return ideas;
}
/** Passive view (tab switch, overview preview) — stable until the user asks to regenerate. */
function getCurrentIdeas(destId){
  const ids = DEST_CURRENT_IDEA_IDS[destId];
  if(ids && ids.length && ids.every(id=>IDEA_STORE[id])) return ids.map(id=>IDEA_STORE[id]);
  return regenerateIdeas(destId);
}

function ideaCardHTML(idea){
  const dest = DESTINATIONS.find(d=>d.id===idea.destId);
  const imgs = idea.places.slice(0,3).map(p=>({src:p.image, q:photoQuery(p.name, dest.name)}));
  while(imgs.length<3) imgs.push({src:dest.hero, q:destPhotoQuery(dest)});
  const budgetLabel = idea.budgetStyle.charAt(0).toUpperCase()+idea.budgetStyle.slice(1);
  return `<div class="ideaCard" data-idea="${idea.id}">
    <div class="ideaCoverRow">${imgs.map(i=>`<img src="${i.src}" alt="" loading="lazy" data-photo-q="${esc(i.q)}">`).join('')}</div>
    <div class="ideaBody">
      <h3>${idea.emoji} ${esc(idea.title)}</h3>
      <p>${esc(idea.desc)}</p>
      <div class="ideaMeta"><span>📅 ${idea.days} days</span><span>💰 ${budgetLabel}</span><span>🚶 ${esc(idea.pace)} pace</span></div>
      <div class="ideaActivities">${idea.places.slice(0,5).map(p=>`<span class="actChip">${esc(p.name)}</span>`).join('')}</div>
      <div class="ideaFoot">
        <button class="btn primary" data-viewit="${idea.id}">View Itinerary</button>
        <button class="btn" data-customize="${idea.id}">Customize</button>
        <button class="btn" data-savetrip="${idea.id}">Save Trip</button>
      </div>
    </div>
  </div>`;
}
function wireIdeaCards(container){
  container.querySelectorAll('[data-viewit]').forEach(b=>b.onclick=()=>openItineraryPreview(b.dataset.viewit));
  container.querySelectorAll('[data-customize]').forEach(b=>b.onclick=()=>openCustomizeModal(b.dataset.customize));
  container.querySelectorAll('[data-savetrip]').forEach(b=>b.onclick=()=>{
    const idea = IDEA_STORE[b.dataset.savetrip];
    const trip = createTripFromIdea(idea);
    toast(`Saved "${trip.title}" to My Trips.`);
    navigate('#/trips');
  });
  hydratePhotos(container);
}

function distributeIntoDays(places, nDays){
  const attractions = places.filter(p=>p.type==='attraction');
  const restaurants = places.filter(p=>p.type==='restaurant');
  // Round-robin attractions and restaurants into day buckets SEPARATELY (not as one combined
  // list) so every day is guaranteed its fair share of attractions specifically — mixing both
  // into a single interleaved queue before dealing can let a day end up attraction-light just
  // because more restaurants happened to land in its slice.
  const attrBuckets = Array.from({length:nDays},()=>[]);
  attractions.forEach((p,i)=> attrBuckets[i % nDays].push(p));
  // Stagger where the restaurant round-robin starts so its leftover "extra" item doesn't land
  // on the same day as the attractions' leftover — otherwise both remainders stack onto day 1,
  // leaving day 1 overloaded and the last day thin (e.g. 3/2/1 instead of an even 2/2/2).
  const restOffset = attractions.length % nDays;
  const restBuckets = Array.from({length:nDays},()=>[]);
  restaurants.forEach((p,i)=> restBuckets[(i+restOffset) % nDays].push(p));
  return attrBuckets.map((attrs, d)=>{
    const rests = restBuckets[d];
    const half = Math.ceil(attrs.length/2);
    const ordered = [...attrs.slice(0,half), ...rests, ...attrs.slice(half)];
    let t = '09:00';
    return ordered.map(place=>{ const time=t; t=addMinutesToTime(t,(place.duration||90)+20); return {place,time}; });
  });
}

function openItineraryPreview(ideaId){
  const idea = IDEA_STORE[ideaId];
  const dest = DESTINATIONS.find(d=>d.id===idea.destId);
  const days = distributeIntoDays(idea.places, idea.days);
  let current = 0;
  function render(){
    const content = $('itineraryPreviewContent');
    content.innerHTML = `
      <div class="modalHeader"><div><h2>${idea.emoji} ${esc(idea.title)}</h2><p class="small">${esc(dest.name)} · ${idea.days} days · ${idea.budgetStyle} budget · ${esc(idea.pace)} pace</p></div><button class="xbtn" data-x="1">×</button></div>
      <div class="ipDayTabs">${days.map((_,i)=>`<button class="pill ${i===current?'active':''}" data-day="${i}">Day ${i+1}</button>`).join('')}</div>
      <div class="timeline" style="max-height:380px;padding:2px">
        ${days[current].length ? days[current].map(({place,time})=>`
          <div class="stop" style="cursor:default">
            <div class="stopTop">
              <div class="stopThumb"><img src="${place.image}" alt="" data-photo-q="${esc(photoQuery(place.name, dest.name))}"></div>
              <div class="stopBody"><h4>${esc(place.name)}</h4><p>${esc(place.desc||'')}</p>
                <div class="stopMeta"><span>🕒 ${fmtTime12(time)}</span><span>📍 ${esc(place.area)}</span>${place.rating?`<span>★ ${place.rating}</span>`:''}${place.price?`<span>${fmt$(place.price)}</span>`:''}</div>
              </div>
            </div>
          </div>`).join('') : '<div class="empty">No stops this day.</div>'}
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button class="btn" data-x="1">Close</button>
        <button class="btn primary" id="useItineraryBtn">✓ Use This Itinerary — Create Trip</button>
      </div>`;
    content.querySelectorAll('[data-x]').forEach(b=>b.onclick=()=>closeModal('modal-itineraryPreview'));
    content.querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>{ current=Number(b.dataset.day); render(); });
    hydratePhotos(content);
    $('useItineraryBtn').onclick = ()=>{
      const trip = createTripFromIdea(idea, days);
      closeModal('modal-itineraryPreview');
      toast(`Created "${trip.title}"!`);
      navigate(`#/trip/${trip.id}`);
    };
  }
  render();
  openModal('modal-itineraryPreview');
}

function createTripFromIdea(idea, precomputedDays){
  const dest = DESTINATIONS.find(d=>d.id===idea.destId);
  const days = precomputedDays || distributeIntoDays(idea.places, idea.days);
  const hp = window.__heroParams;
  const start = (hp && hp.start) || toDateInput(new Date(Date.now()+21*86400000));
  const travelers = (hp && hp.travelers) || 2;
  const total = Math.round((dest.avgDailyBudget[idea.budgetStyle]||dest.avgDailyBudget.moderate) * idea.days * travelers);
  const trip = {
    id: uid('trip'), destId: dest.id, destName: dest.name+(dest.country?', '+dest.country:''), title: idea.title, start, end: addDays(start, idea.days-1), travelers,
    cover: (idea.places[0] && idea.places[0].image) || dest.hero,
    days: days.map((dayPlaces,i)=>({ date: addDays(start,i), stops: dayPlaces.map(({place,time})=>mkStopFromPlace(place,time)) })),
    budget:{ total, style: idea.budgetStyle, expenses:[] },
    collaborators:[ mkCollaborator('Jie Wei (you)', STATE.settings.email, 'Owner') ],
    activity:[ {id:uid('act'), author:'You', text:`created this trip from the "${idea.title}" trip idea.`, ts:Date.now()} ],
    createdAt: Date.now(),
  };
  STATE.trips.unshift(trip);
  window.__heroParams = null;
  saveState();
  return trip;
}

let __customizeIdeaId = null;
function openCustomizeModal(ideaId){
  __customizeIdeaId = ideaId;
  const idea = IDEA_STORE[ideaId];
  $('custDuration').value = idea.days;
  $('custBudget').value = idea.budgetStyle.charAt(0).toUpperCase()+idea.budgetStyle.slice(1);
  $('custPace').value = idea.pace;
  $('custInterests').innerHTML = INTERESTS.map(([key,icon,label,sub])=>`<button class="pref ${idea.interests.includes(key)?'active':''}" data-pref="${key}"><b>${icon} ${label}</b><span>${esc(sub)}</span></button>`).join('');
  $('custInterests').querySelectorAll('.pref').forEach(b=>b.onclick=()=>b.classList.toggle('active'));
  openModal('modal-customize');
}
function initCustomizeModal(){
  $('regenIdeaBtn').onclick = ()=>{
    const idea = IDEA_STORE[__customizeIdeaId];
    const archetype = TRIP_ARCHETYPES.find(a=>a.key===idea.key);
    const interests = $$('#custInterests .pref.active').map(b=>b.dataset.pref);
    const overrides = {
      days: Number($('custDuration').value),
      budgetStyle: $('custBudget').value.toLowerCase(),
      pace: $('custPace').value,
      interests: interests.length? interests : archetype.tags.slice(),
    };
    overrides.__keepId = __customizeIdeaId;
    buildIdea(idea.destId, archetype, overrides);
    closeModal('modal-customize');
    toast('Trip idea updated with your preferences!');
    refreshCurrentView();
  };
}

/* ============================================================
   STANDALONE TRIP IDEAS PAGE
============================================================ */
function renderIdeasView(destIdParam){
  const auto = $('ideasDestAuto');
  $('ideasDestInput').oninput = debounce(e=>renderDestAuto(e.target.value, auto, name=>{ $('ideasDestInput').value=name; auto.classList.remove('show'); }),120);
  $('ideasGenBtn').onclick = ()=>{
    const name = $('ideasDestInput').value.trim();
    if(!name){ toast('Type a destination first.'); return; }
    const d = findDestination(name);
    navigate(`#/ideas/${encodeURIComponent(d.id)}`);
  };
  if(destIdParam){
    const dest = resolveDestFromId(destIdParam) || findDestination(destIdParam);
    $('ideasDestInput').value = `${dest.name}, ${dest.country}`.replace(/, $/, '');
    // navigating here represents an explicit "generate" action — always give a fresh, varied batch
    const ideas = regenerateIdeas(dest.id);
    $('ideasGrid').innerHTML = ideas.map(idea=>ideaCardHTML(idea)).join('');
    wireIdeaCards($('ideasGrid'));
    hydratePhotos($('ideasGrid'));
    const refreshIdeas = ()=>{ if(location.hash.includes('/ideas/'+encodeURIComponent(dest.id))){ const fresh = regenerateIdeas(dest.id); $('ideasGrid').innerHTML = fresh.map(idea=>ideaCardHTML(idea)).join(''); wireIdeaCards($('ideasGrid')); hydratePhotos($('ideasGrid')); } };
    if(dest.id.startsWith('gen-')) enrichDestinationInBackground(dest, refreshIdeas);
    else supplementDestinationInBackground(dest, refreshIdeas);
  } else {
    $('ideasGrid').innerHTML = `<div class="empty" style="grid-column:1/-1">Search a destination above to generate ${IDEAS_SHOWN_PER_GENERATE} themed trip ideas from a wide mix of styles — food, culture, nightlife, shopping, relaxation, art, adventure, romance, hidden gems and more.</div>`;
  }
}

/* ============================================================
   MY TRIPS
============================================================ */
function renderTripsView(){
  const grid = $('tripsGrid');
  if(!STATE.trips.length){
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">No trips yet. Generate trip ideas or search a destination to start planning your first trip.</div>';
  } else {
    grid.innerHTML = STATE.trips.map(t=>tripCardHTML(t)).join('');
    wireTripCards(grid);
  }
  $('newTripBtn2').onclick = openNewTripModal;
}
function tripCardHTML(t){
  const dest = destForTrip(t);
  const planned = tripPlannedTotal(t);
  const pct = clamp(Math.round(planned/(t.budget.total||1)*100),0,140);
  const over = planned>t.budget.total;
  const progress = computeTripProgress(t);
  return `<div class="tripCard2" data-trip="${t.id}">
    <div class="tripCoverWrap"><img src="${t.cover||dest.hero}" alt="" data-photo-q="${esc(destPhotoQuery(dest))}"><span class="badge2">${dest.flag} ${esc(dest.name)}</span></div>
    <div class="tripCardBody">
      <h3>${esc(t.title)}</h3>
      <div class="tripMetaRow"><span>📅 ${fmtDateShort(t.start)} – ${fmtDateShort(t.end)}</span><span>${t.days.length} days</span></div>
      <div class="small">${tripStopCount(t)} activities · ${t.travelers} travelers</div>
      <div class="small" style="display:flex;align-items:center;gap:6px;margin-top:6px"><span>${progress.ready?'🎉 Ready to travel':`Planning ${progress.percent}% complete`}</span></div>
      <div class="progress" style="margin-top:3px"><div style="width:${progress.percent}%"></div></div>
      <div class="tripBudgetBar">
        <div class="small" style="display:flex;justify-content:space-between;margin-bottom:4px"><span>${fmt$(planned)} planned</span><span>${over?'⚠ over budget':fmt$(t.budget.total)+' budget'}</span></div>
        <div class="progress ${over?'over':''}"><div style="width:${Math.min(pct,100)}%"></div></div>
      </div>
      <div class="avatarStack" style="margin-top:10px">${t.collaborators.map(c=>`<div class="avatar sm" title="${esc(c.name)}">${c.initials}</div>`).join('')}</div>
      <div class="tripFoot">
        <button class="btn primary" data-open="${t.id}">Open</button>
        <button class="btn" data-edit="${t.id}">Edit</button>
        <button class="btn" data-dup="${t.id}">Duplicate</button>
        <button class="btn" data-share="${t.id}">Share</button>
        <button class="btn danger" data-del="${t.id}">Delete</button>
      </div>
    </div>
  </div>`;
}
function wireTripCards(container){
  container.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>navigate(`#/trip/${b.dataset.open}`));
  container.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEditTripModal(b.dataset.edit));
  container.querySelectorAll('[data-dup]').forEach(b=>b.onclick=()=>duplicateTrip(b.dataset.dup));
  container.querySelectorAll('[data-share]').forEach(b=>b.onclick=()=>openShareModal(b.dataset.share));
  container.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
    const t = getTrip(b.dataset.del);
    confirmDialog('Delete this trip?', `"${t.title}" and its itinerary will be deleted. You'll get a moment to undo.`, ()=>{
      const index = STATE.trips.findIndex(x=>x.id===t.id);
      const removed = snapshot(t);
      STATE.trips = STATE.trips.filter(x=>x.id!==t.id);
      saveState();
      renderTripsView();
      toastUndo(`Deleted "${removed.title}".`, ()=>{ STATE.trips.splice(Math.max(0,index), 0, removed); });
    });
  });
  hydratePhotos(container);
}
function duplicateTrip(id){
  const t = getTrip(id);
  const copy = JSON.parse(JSON.stringify(t));
  copy.id = uid('trip');
  copy.title = t.title + ' (copy)';
  copy.createdAt = Date.now();
  copy.activity = [{id:uid('act'), author:'You', text:'duplicated this trip.', ts:Date.now()}];
  STATE.trips.unshift(copy);
  saveState();
  toast(`Duplicated as "${copy.title}".`);
  renderTripsView();
}
function openNewTripModal(){
  $('newTripDest').value='';
  const start = toDateInput(new Date(Date.now()+21*86400000));
  $('newTripStart').value = start; $('newTripEnd').value = addDays(start,4);
  $('newTripTravelers').value = '2';
  openModal('modal-newTrip');
}
function initNewTripModal(){
  const auto = $('newTripDestAuto');
  $('newTripDest').addEventListener('input', debounce(e=>renderDestAuto(e.target.value, auto, name=>{ $('newTripDest').value=name; auto.classList.remove('show'); }),120));
  $('createTripBtn').onclick = ()=>{
    const name = $('newTripDest').value.trim();
    if(!name){ toast('Enter a destination.'); return; }
    const dest = findDestination(name);
    const start = $('newTripStart').value || toDateInput(new Date(Date.now()+21*86400000));
    const end = $('newTripEnd').value && $('newTripEnd').value > start ? $('newTripEnd').value : addDays(start,4);
    const travelers = parseInt($('newTripTravelers').value)||2;
    const trip = buildAutoTrip(dest.id, `${dest.name} Trip`, start, end, travelers, 'moderate');
    STATE.trips.unshift(trip);
    saveState();
    closeModal('modal-newTrip');
    toast(`Created "${trip.title}"!`);
    navigate(`#/trip/${trip.id}`);
  };
}
let __editTripId = null;
function openEditTripModal(id){
  __editTripId = id;
  const t = getTrip(id);
  $('editTripName').value = t.title;
  $('editTripStart').value = t.start;
  $('editTripEnd').value = t.end;
  $('editTripTravelers').value = String(t.travelers);
  openModal('modal-editTrip');
}
function initEditTripModal(){
  $('saveEditTripBtn').onclick = ()=>{
    const t = getTrip(__editTripId);
    if(!t) return;
    t.title = $('editTripName').value.trim() || t.title;
    t.travelers = parseInt($('editTripTravelers').value)||t.travelers;
    const newStart = $('editTripStart').value, newEnd = $('editTripEnd').value;
    if(newStart) t.start = newStart;
    if(newEnd && newEnd >= t.start) t.end = newEnd;
    const wanted = Math.max(1, daysBetween(t.start, t.end));
    while(t.days.length < wanted) t.days.push({date: addDays(t.start, t.days.length), stops:[]});
    while(t.days.length > wanted) t.days.pop();
    t.days.forEach((d,i)=> d.date = addDays(t.start,i));
    saveState();
    closeModal('modal-editTrip');
    toast('Trip updated.');
    refreshCurrentView();
  };
}
function openShareModal(id){
  const t = getTrip(id);
  $('shareLink').value = `${location.origin}${location.pathname}#/trip/${t.id}`;
  $('copyShareLink').onclick = ()=>{
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText($('shareLink').value).then(()=>toast('Link copied!')).catch(()=>fallbackCopy());
    } else fallbackCopy();
    function fallbackCopy(){ const inp=$('shareLink'); inp.select(); document.execCommand && document.execCommand('copy'); toast('Link copied!'); }
  };
  $('sendInvite').onclick = ()=>{
    const email = $('shareEmail').value.trim();
    if(!email || !email.includes('@')){ toast('Enter a valid email address.'); return; }
    const role = $('shareRole').value;
    const name = email.split('@')[0].replace(/[._]/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    const collab = mkCollaborator(name, email, role);
    t.collaborators.push(collab);
    logActivity(t, `invited ${name} (${role}) to collaborate.`);
    const allStops = t.days.flatMap(d=>d.stops);
    if(allStops.length){
      const s = allStops[Math.floor(Math.random()*allStops.length)];
      s.comments.push({author:name, text:`Excited about ${s.name}! Count me in 🙌`, ts:Date.now()});
      s.votes.interested += 1;
    }
    saveState();
    $('shareEmail').value='';
    toast(`Invite sent to ${email} (demo — no real email is sent).`);
    renderShareCollabList(t);
    addNotification(`${name} joined "${t.title}".`, '🤝', t.id);
    if(plannerState.tripId===t.id){ renderCollabTab(t); renderCollabStack(t); renderTimeline(t, t.days[plannerState.day]); }
  };
  renderShareCollabList(t);
  openModal('modal-share');
}
function renderShareCollabList(t){
  $('shareCollabList').innerHTML = t.collaborators.map(c=>`<div class="listRow"><div class="left"><div class="avatar sm">${c.initials}</div><div><div>${esc(c.name)}</div><div class="small">${esc(c.email)}</div></div></div><span class="small">${esc(c.role)}</span></div>`).join('');
}

/* ============================================================
   SAVED
============================================================ */
function renderSavedView(collId){
  const tabsEl = $('collectionTabs');
  const activeId = collId || STATE.collections[0].id;
  tabsEl.innerHTML = STATE.collections.map(c=>`<button class="collTab ${c.id===activeId?'active':''}" data-coll="${c.id}">${c.icon} ${esc(c.name)} <span class="small">(${c.placeIds.length})</span></button>`).join('');
  tabsEl.querySelectorAll('[data-coll]').forEach(b=>b.onclick=()=>navigate(`#/saved/${b.dataset.coll}`));
  const active = STATE.collections.find(c=>c.id===activeId) || STATE.collections[0];
  const grid = $('savedGrid');
  if(!active.placeIds.length){ grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Nothing saved here yet. Tap ♡ on any place to save it to a collection.</div>'; return; }
  const items = active.placeIds.map(id=>{
    if(id.startsWith('dest:')){ const d=DESTINATIONS.find(x=>x.id===id.slice(5)); return d ? Object.assign({__isDest:true}, d) : null; }
    return placeById(id);
  }).filter(Boolean);
  grid.innerHTML = items.map(p=>{
    if(p.__isDest){
      return `<div class="placeCard"><div class="placeImgWrap"><img src="${p.hero}" alt="" data-photo-q="${esc(destPhotoQuery(p))}"><span class="placeCatBadge">Destination</span></div><div class="placeBody"><h4>${p.flag} ${esc(p.name)}</h4><p class="placeDesc">${esc(p.tagline)}</p><div class="placeFoot"><button class="btn primary block" data-godest="${p.id}">Explore</button><button class="btn" data-unsavedest="${p.id}">Remove</button></div></div></div>`;
    }
    return placeCardHTML(p,{showDest:true});
  }).join('');
  grid.querySelectorAll('[data-godest]').forEach(b=>b.onclick=()=>navigate(`#/destination/${encodeURIComponent(b.dataset.godest)}`));
  grid.querySelectorAll('[data-unsavedest]').forEach(b=>b.onclick=()=>{ active.placeIds = active.placeIds.filter(id=>id!=='dest:'+b.dataset.unsavedest); saveState(); renderSavedView(active.id); });
  wirePlaceCards(grid);
  wireSavedViewToggle(active, items);
}
/** List/Map toggle for a collection. Only items with real coordinates can appear on the map —
 * a saved destination (rather than a place) has no single pin, so the map covers the places and
 * says plainly how many items it couldn't plot instead of quietly dropping them. */
let savedViewMode = 'list';
function wireSavedViewToggle(collection, items){
  const listBtn = $('savedListBtn'), mapBtn = $('savedMapBtn');
  if(!listBtn || !mapBtn) return;
  const mappable = items.filter(p=>!p.__isDest && typeof p.lat === 'number' && typeof p.lng === 'number');
  const apply = ()=>{
    const isMap = savedViewMode === 'map';
    listBtn.classList.toggle('active', !isMap);
    mapBtn.classList.toggle('active', isMap);
    $('savedGrid').classList.toggle('hidden', isMap);
    $('savedMapWrap').classList.toggle('hidden', !isMap);
    if(isMap) renderSavedMap(collection, mappable, items.length - mappable.length);
  };
  listBtn.onclick = ()=>{ savedViewMode='list'; apply(); };
  mapBtn.onclick = ()=>{ savedViewMode='map'; apply(); };
  apply();
}
function renderSavedMap(collection, places, unmappable){
  const frame = $('savedMapFrame'), list = $('savedMapList');
  if(!frame || !list) return;
  if(!places.length){
    list.innerHTML = `<div class="empty">Nothing in this collection has a location to plot yet.</div>`;
    frame.src = gmapsSearchEmbedUrl('world', 1);
    return;
  }
  // Centre on the average of the saved pins so the initial view actually frames them.
  const avgLat = places.reduce((a,p)=>a+p.lat,0)/places.length;
  const avgLng = places.reduce((a,p)=>a+p.lng,0)/places.length;
  const spread = Math.max(
    ...places.map(p=>Math.max(Math.abs(p.lat-avgLat), Math.abs(p.lng-avgLng))), 0.01);
  const zoom = spread > 5 ? 4 : spread > 1 ? 7 : spread > 0.2 ? 10 : spread > 0.05 ? 12 : 13;
  frame.src = gmapsCoordEmbedUrl(avgLat.toFixed(5), avgLng.toFixed(5), zoom);
  list.innerHTML = `
    ${unmappable ? `<p class="small" style="margin:0 0 10px">${unmappable} saved ${unmappable===1?'item has':'items have'} no single location to plot (saved destinations), so ${unmappable===1?"it isn't":"they aren't"} shown here.</p>` : ''}
    ${places.map(p=>`<button class="mapPlaceRow" data-savedfocus="${p.id}">
      <div class="stopThumb"><img src="${p.image}" alt="" data-photo-q="${esc(photoQuery(p.name, (findDestination(p.destId)||{}).name))}"></div>
      <div><div>${esc(p.name)}</div><div class="small">${esc(p.area||'')}${p.rating?` · ★ ${p.rating}`:''}</div></div>
    </button>`).join('')}`;
  list.querySelectorAll('[data-savedfocus]').forEach(b=>b.onclick=()=>{
    const p = places.find(x=>x.id===b.dataset.savedfocus);
    if(!p) return;
    frame.src = gmapsCoordEmbedUrl(p.lat, p.lng, 16);
    list.querySelectorAll('.mapPlaceRow').forEach(r=>r.classList.remove('active'));
    b.classList.add('active');
  });
  hydratePhotos(list);
}

/* ---------------- first-run onboarding ---------------- */
/** Shown once, and only to someone genuinely new — dismissing it (either button, or the close
 * control) records that, so it never reappears and never blocks a returning user. */
function initOnboarding(){
  const dismiss = ()=>{
    STATE.settings.onboarded = true;
    saveState();
    closeModal('modal-onboard');
  };
  $('onboardSkip').onclick = dismiss;
  $('onboardStart').onclick = ()=>{
    dismiss();
    const input = $('heroDestination');
    if(input){ navigate('#/'); setTimeout(()=>{ input.focus(); }, 120); }
  };
  $('modal-onboard').querySelectorAll('[data-close="modal-onboard"]').forEach(b=>b.onclick = dismiss);
  // Opened synchronously during init rather than on a timer: a modal that appears half a second
  // late can land just as the user is reaching for something else, stealing the click.
  if(!STATE.settings.onboarded) openModal('modal-onboard');
}

/* ============================================================
   EXPORT & SHARE
============================================================ */
/** Plain-text itinerary — the format that survives being pasted anywhere: a message, an email,
 * a notes app, a printout. Built from the trip's real data, including bookings and notes. */
function buildItineraryText(trip){
  const dest = destForTrip(trip);
  const L = [];
  L.push(trip.title);
  L.push('='.repeat(trip.title.length));
  L.push(`${dest.name}${dest.country?', '+dest.country:''}`);
  L.push(`${fmtDateFull(trip.start)} – ${fmtDateFull(trip.end)} · ${trip.days.length} day${trip.days.length===1?'':'s'} · ${trip.travelers} traveler${trip.travelers===1?'':'s'}`);
  if(trip.notes) L.push(`\nTrip notes: ${trip.notes}`);

  const bookings = sortedBookings(trip);
  if(bookings.length){
    L.push('\nBOOKINGS');
    L.push('-'.repeat(8));
    bookings.forEach(b=>{
      const [,emoji,label] = bookingTypeMeta(b.type);
      const bits = [label, b.date?fmtDateFull(b.date):null, b.time?fmtTime12(b.time):null].filter(Boolean).join(' · ');
      L.push(`${emoji} ${b.title}`);
      L.push(`   ${bits}`);
      if(b.confirmation) L.push(`   Confirmation: ${b.confirmation}`);
      if(b.notes) L.push(`   ${b.notes}`);
    });
  }

  trip.days.forEach((d,i)=>{
    L.push(`\nDAY ${i+1} — ${fmtDateFull(d.date)}`);
    L.push('-'.repeat(20));
    if(d.note) L.push(`Note: ${d.note}`);
    if(!d.stops.length){ L.push('  (nothing planned)'); return; }
    d.stops.forEach(s=>{
      L.push(`  ${fmtTime12(s.time)}  ${s.name}`);
      const meta = [s.category, s.area, s.cost?fmt$(s.cost):null].filter(Boolean).join(' · ');
      if(meta) L.push(`           ${meta}`);
      if(s.note) L.push(`           Note: ${s.note}`);
    });
  });

  const planned = tripPlannedTotal(trip);
  L.push(`\nBUDGET`);
  L.push('-'.repeat(6));
  L.push(`Planned: ${fmt$(planned)} of ${fmt$(trip.budget.total)}`);
  L.push('\nMade with TripFlow');
  return L.join('\n');
}
function buildPrintableHTML(trip){
  const dest = destForTrip(trip);
  const bookings = sortedBookings(trip);
  return `
    <div class="printDoc">
      <h1>${esc(trip.title)}</h1>
      <p class="printSub">${dest.flag} ${esc(dest.name)}${dest.country?', '+esc(dest.country):''} · ${fmtDateFull(trip.start)} – ${fmtDateFull(trip.end)} · ${trip.days.length} day${trip.days.length===1?'':'s'} · ${trip.travelers} traveler${trip.travelers===1?'':'s'}</p>
      ${trip.notes?`<p class="printNote"><b>Trip notes:</b> ${esc(trip.notes)}</p>`:''}
      ${bookings.length?`<h2>Bookings</h2>${bookings.map(b=>{
        const [,emoji,label] = bookingTypeMeta(b.type);
        return `<div class="printRow"><b>${emoji} ${esc(b.title)}</b><div>${esc(label)}${b.date?' · '+fmtDateFull(b.date):''}${b.time?' · '+fmtTime12(b.time):''}${b.confirmation?' · Confirmation '+esc(b.confirmation):''}</div>${b.notes?`<div>${esc(b.notes)}</div>`:''}</div>`;
      }).join('')}`:''}
      ${trip.days.map((d,i)=>`
        <h2>Day ${i+1} — ${fmtDateFull(d.date)}</h2>
        ${d.note?`<p class="printNote"><b>Note:</b> ${esc(d.note)}</p>`:''}
        ${d.stops.length ? d.stops.map(s=>`
          <div class="printRow"><b>${fmtTime12(s.time)} · ${esc(s.name)}</b>
          <div>${[s.category,s.area,s.cost?fmt$(s.cost):null].filter(Boolean).map(esc).join(' · ')}</div>
          ${s.note?`<div>Note: ${esc(s.note)}</div>`:''}</div>`).join('')
          : '<p class="printNote">Nothing planned.</p>'}
      `).join('')}
      <h2>Budget</h2>
      <div class="printRow">Planned ${fmt$(tripPlannedTotal(trip))} of ${fmt$(trip.budget.total)}</div>
      <p class="printFoot">Made with TripFlow</p>
    </div>`;
}
function downloadTextFile(filename, text){
  const blob = new Blob([text], {type:'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
function safeFileName(s){ return String(s).replace(/[^a-z0-9]+/gi,'-').replace(/^-+|-+$/g,'').toLowerCase() || 'trip'; }
function openExportModal(trip){
  $('exportPrintBtn').onclick = ()=>{
    // Rendered into a print-only container in the page rather than a popup window, which
    // browsers routinely block.
    $('printArea').innerHTML = buildPrintableHTML(trip);
    closeModal('modal-export');
    setTimeout(()=>window.print(), 60);
  };
  $('exportTextBtn').onclick = ()=>{
    downloadTextFile(`${safeFileName(trip.title)}-itinerary.txt`, buildItineraryText(trip));
    closeModal('modal-export');
    toast('Itinerary downloaded.');
  };
  $('exportCopyBtn').onclick = ()=>{
    const text = buildItineraryText(trip);
    const done = ()=>{ closeModal('modal-export'); toast('Itinerary copied to clipboard.'); };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done).catch(()=>{ fallbackCopyText(text); done(); });
    } else { fallbackCopyText(text); done(); }
  };
  openModal('modal-export');
}
function fallbackCopyText(text){
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand && document.execCommand('copy'); }catch(e){}
  document.body.removeChild(ta);
}

/* ============================================================
   POST-TRIP RECAP
============================================================ */
function tripIsOver(trip){ return trip.end < todayISO(); }
/** Real numbers from what was actually planned — never invented "you walked N steps" style
 * stats the app has no way to know. */
function computeTripRecap(trip){
  const stops = trip.days.flatMap(d=>d.stops);
  const distance = trip.days.reduce((sum,d)=>sum+totalDistance(d.stops), 0);
  const byType = {};
  stops.forEach(s=>{ byType[s.type] = (byType[s.type]||0)+1; });
  const rated = stops.filter(s=>s.rating).sort((a,b)=>b.rating-a.rating);
  const areas = {};
  stops.forEach(s=>{ if(s.area) areas[s.area] = (areas[s.area]||0)+1; });
  const topArea = Object.entries(areas).sort((a,b)=>b[1]-a[1])[0];
  return {
    days: trip.days.length,
    stops: stops.length,
    distance,
    spend: tripPlannedTotal(trip),
    byType,
    topRated: rated.slice(0,3),
    topArea: topArea ? {name:topArea[0], count:topArea[1]} : null,
    bookings: tripBookings(trip).length,
  };
}
function buildRecapText(trip){
  const r = computeTripRecap(trip);
  const dest = destForTrip(trip);
  const lines = [
    `${trip.title} — trip recap`,
    `${dest.flag} ${dest.name} · ${fmtDateFull(trip.start)} – ${fmtDateFull(trip.end)}`,
    '',
    `${r.days} days · ${r.stops} places · about ${r.distance.toFixed(1)} km covered`,
    `${fmt$(r.spend)} planned spend`,
  ];
  if(r.topArea) lines.push(`Most time in: ${r.topArea.name} (${r.topArea.count} stops)`);
  if(r.topRated.length) lines.push(`Highest rated: ${r.topRated.map(s=>`${s.name} (★${s.rating})`).join(', ')}`);
  lines.push('', 'Made with TripFlow');
  return lines.join('\n');
}
function renderRecapCard(trip){
  const r = computeTripRecap(trip);
  const dest = destForTrip(trip);
  return `
    <div class="card recapCard">
      <div class="recapHead">
        <div>
          <div class="small" style="font-weight:800">✈️ Trip complete</div>
          <h3 style="margin:2px 0 0">${esc(trip.title)}</h3>
          <p class="small" style="margin:2px 0 0">${dest.flag} ${esc(dest.name)} · ${fmtDateFull(trip.start)} – ${fmtDateFull(trip.end)}</p>
        </div>
        <button class="btn primary sm" id="shareRecapBtn"><i class="fa-solid fa-share-nodes"></i> Share recap</button>
      </div>
      <div class="recapStats">
        <div class="recapStat"><div class="v">${r.days}</div><div class="k">days</div></div>
        <div class="recapStat"><div class="v">${r.stops}</div><div class="k">places</div></div>
        <div class="recapStat"><div class="v">${r.distance.toFixed(1)}</div><div class="k">km covered</div></div>
        <div class="recapStat"><div class="v">${fmt$(r.spend)}</div><div class="k">spend</div></div>
      </div>
      ${r.topArea?`<p class="small" style="margin:12px 0 0">You spent most of your time around <b>${esc(r.topArea.name)}</b> — ${r.topArea.count} of your ${r.stops} stops.</p>`:''}
      ${r.topRated.length?`<div style="margin-top:12px">
        <div class="small" style="font-weight:800;margin-bottom:8px">Highest rated places you visited</div>
        ${r.topRated.map(s=>`<div class="recapPlace"><span>${esc(s.name)}</span><span class="small">★ ${s.rating}</span></div>`).join('')}
      </div>`:''}
    </div>`;
}

/* ============================================================
   TRAVEL MODE — the in-trip view
============================================================ */
function todayISO(){ return toDateInput(new Date()); }
/** The trip you're actually on right now, if any: today falls between its start and end. */
function activeTripToday(){
  const today = todayISO();
  return STATE.trips.find(t=>t.start <= today && today <= t.end) || null;
}
function nextUpcomingTrip(){
  const today = todayISO();
  return STATE.trips.filter(t=>t.start > today).sort((a,b)=>a.start.localeCompare(b.start))[0] || null;
}
/** Splits a day's stops around the current clock time, so the view can lead with what's on now
 * rather than making the user find their place in a list. A stop counts as "now" while its
 * duration is still running. */
function splitDayByNow(day, nowMinutes){
  const done = [], now = [], upcoming = [];
  day.stops.forEach(s=>{
    const start = timeToMin(s.time);
    const end = start + (s.duration || 90);
    if(nowMinutes >= end) done.push(s);
    else if(nowMinutes >= start) now.push(s);
    else upcoming.push(s);
  });
  return { done, now, upcoming };
}
function travelStopRowHTML(s, destName, state){
  return `<div class="travelStop ${state}">
    <div class="travelTime">${fmtTime12(s.time)}</div>
    <div class="stopThumb"><img src="${s.image}" alt="" data-photo-q="${esc(photoQuery(s.name, destName))}"></div>
    <div class="travelInfo">
      <h4>${esc(s.name)}</h4>
      <div class="small">${esc(s.category||'')}${s.area?` · ${esc(s.area)}`:''}${s.duration?` · ${s.duration} min`:''}</div>
      ${s.note?`<div class="small travelNote">📝 ${esc(s.note)}</div>`:''}
    </div>
    <a class="btn sm" target="_blank" rel="noopener" href="${gmapsExternalLink(s.name)}"><i class="fa-solid fa-diamond-turn-right"></i></a>
  </div>`;
}
function renderTravelView(){
  const body = $('travelBody');
  const trip = activeTripToday();

  if(!trip){
    const next = nextUpcomingTrip();
    if(!next){
      body.innerHTML = `<div class="empty" style="padding:50px 20px">
        <div style="font-size:30px;margin-bottom:8px">🧭</div>
        <div>You're not on a trip right now.</div>
        <div class="small" style="margin-top:4px">When today falls inside one of your trips, this page turns into your live day-by-day guide.</div>
        <button class="btn primary" style="margin-top:14px" data-gotrips="1">See my trips</button>
      </div>`;
      body.querySelectorAll('[data-gotrips]').forEach(b=>b.onclick=()=>navigate('#/trips'));
      return;
    }
    const days = Math.max(0, Math.round((new Date(next.start) - new Date(todayISO()))/86400000));
    const dest = destForTrip(next);
    const firstDay = next.days[0];
    body.innerHTML = `
      <div class="card travelCountdown">
        <div class="countNum">${days}</div>
        <div>
          <h3 style="margin:0">${days===1?'day':'days'} until ${esc(next.title)}</h3>
          <p class="small" style="margin:2px 0 0">${dest.flag} ${esc(dest.name)} · starts ${fmtDateFull(next.start)}</p>
        </div>
        <button class="btn primary" data-opentrip="${next.id}">Open trip</button>
      </div>
      ${firstDay && firstDay.stops.length ? `<div class="card" style="margin-top:16px">
        <h3>First day, once you land</h3>
        ${firstDay.stops.map(s=>travelStopRowHTML(s, dest.name, 'upcoming')).join('')}
      </div>` : ''}`;
    body.querySelectorAll('[data-opentrip]').forEach(b=>b.onclick=()=>navigate(`#/trip/${b.dataset.opentrip}`));
    hydratePhotos(body);
    return;
  }

  const dest = destForTrip(trip);
  const today = todayISO();
  const dayIdx = trip.days.findIndex(d=>d.date === today);
  const day = dayIdx >= 0 ? trip.days[dayIdx] : null;
  const nowD = new Date();
  const nowMinutes = nowD.getHours()*60 + nowD.getMinutes();

  if(!day){
    body.innerHTML = `<div class="card"><h3>${esc(trip.title)}</h3>
      <p class="small">You're on this trip, but today (${fmtDateFull(today)}) doesn't have a day planned in the itinerary yet.</p>
      <button class="btn primary" style="margin-top:10px" data-opentrip="${trip.id}">Open itinerary</button></div>`;
    body.querySelectorAll('[data-opentrip]').forEach(b=>b.onclick=()=>navigate(`#/trip/${b.dataset.opentrip}/itinerary`));
    return;
  }

  const { done, now, upcoming } = splitDayByNow(day, nowMinutes);
  const spend = day.stops.reduce((a,s)=>a+(s.cost||0),0);
  const clock = destinationClock(dest);
  // Total time actually spent moving between today's stops, from the per-stop transit estimates.
  const transitMins = day.stops.slice(0,-1).reduce((a,s)=>a+((s.transitToNext&&s.transitToNext.mins)||0), 0);
  const modes = {};
  day.stops.slice(0,-1).forEach(s=>{ const m=(s.transitToNext&&s.transitToNext.mode)||'Walk'; modes[m]=(modes[m]||0)+1; });
  const modeSummary = Object.entries(modes).sort((a,b)=>b[1]-a[1]).map(([m,n])=>`${m} ×${n}`).join(' · ');

  body.innerHTML = `
    <div class="card travelHead">
      <div>
        <div class="small" style="font-weight:800">${dest.flag} ${esc(dest.name)} · Day ${dayIdx+1} of ${trip.days.length}</div>
        <h3 style="margin:2px 0 0">${esc(trip.title)}</h3>
        <p class="small" style="margin:2px 0 0">${fmtDateFull(today)} · ${day.stops.length} stop${day.stops.length===1?'':'s'} · ${fmt$(spend)} planned today${transitMins?` · ~${transitMins} min moving${modeSummary?` (${esc(modeSummary)})`:''}`:''}</p>
      </div>
      <button class="btn" data-opentrip="${trip.id}">Full itinerary</button>
    </div>
    ${clock ? `<div class="card clockCard" style="margin-top:14px">
      <div class="clockTime">${clock.time12}</div>
      <div>
        <b>Local time in ${esc(dest.name)}</b>
        <p class="small" style="margin:2px 0 0">${esc(clock.label)}${clock.diff===0?' · same as your device' : ` · ${Math.abs(clock.diff)}h ${clock.diff>0?'ahead of':'behind'} your device${clock.isNextDay?' (different calendar day)':''}`}</p>
        ${dest.travelInfo && dest.travelInfo.localTransport ? `<p class="small" style="margin:6px 0 0">🚇 ${esc(dest.travelInfo.localTransport)}</p>` : ''}
      </div>
    </div>` : ''}
    ${day.note ? `<div class="card travelDayNote" style="margin-top:14px"><b>📝 Note for today</b><p class="small" style="margin:4px 0 0">${esc(day.note)}</p></div>` : ''}
    ${now.length ? `<div class="card" style="margin-top:14px">
      <div class="travelSectionTitle">Happening now</div>
      ${now.map(s=>travelStopRowHTML(s, dest.name, 'now')).join('')}
    </div>` : ''}
    ${upcoming.length ? `<div class="card" style="margin-top:14px">
      <div class="travelSectionTitle">${now.length?'Up next':'Coming up today'}</div>
      ${upcoming.map(s=>travelStopRowHTML(s, dest.name, 'upcoming')).join('')}
    </div>` : ''}
    ${!now.length && !upcoming.length ? `<div class="card" style="margin-top:14px"><div class="empty">That's everything planned for today — ${done.length?'all done':'nothing scheduled'}. Enjoy the evening.</div></div>` : ''}
    ${done.length ? `<div class="card" style="margin-top:14px">
      <div class="travelSectionTitle">Earlier today</div>
      ${done.map(s=>travelStopRowHTML(s, dest.name, 'done')).join('')}
    </div>` : ''}`;
  body.querySelectorAll('[data-opentrip]').forEach(b=>b.onclick=()=>navigate(`#/trip/${b.dataset.opentrip}/itinerary`));
  hydratePhotos(body);
}

/* ============================================================
   TRIP PLANNER
============================================================ */
let plannerState = { tripId:null, day:0 };

function renderPlannerView(tripId, ptab){
  const trip = getTrip(tripId);
  if(!trip){ navigate('#/trips'); return; }
  if(plannerState.tripId !== tripId) plannerState = { tripId, day:0 };
  const dest = destForTrip(trip);
  const refreshPlanner = ()=>{ if(plannerState.tripId===trip.id) renderPlannerView(trip.id, location.hash.split('/')[3]||'dashboard'); };
  if(dest.id.startsWith('gen-')) enrichDestinationInBackground(dest, refreshPlanner);
  else supplementDestinationInBackground(dest, refreshPlanner);

  $('plannerEyebrow').textContent = `${dest.flag} ${dest.name} trip workspace`;
  $('plannerTitle').textContent = trip.title;
  $('plannerSub').textContent = `${fmtDateFull(trip.start)} – ${fmtDateFull(trip.end)} · ${trip.days.length} days · ${trip.travelers} travelers`;
  renderCollabStack(trip);
  renderTripProgress(trip);

  $$('.ptab').forEach(b=>{ b.classList.toggle('active', b.dataset.ptab===(ptab||'dashboard')); b.onclick=()=>navigate(`#/trip/${trip.id}/${b.dataset.ptab}`); });
  $$('.ptabBody').forEach(b=>b.classList.remove('active'));
  $('ptab-'+(ptab||'dashboard')).classList.add('active');

  $('shareTripBtn').onclick = ()=>openShareModal(trip.id);
  $('exportTripBtn').onclick = ()=>openExportModal(trip);
  $('optimizeBtn').onclick = ()=>openOptimizeModal(trip, plannerState.day);
  $('aiRegenBtn').onclick = ()=>{ openAI(); $('aiContextLabel').textContent = `Working on: ${trip.title}`; };
  $('addDayBtn').onclick = ()=>{ addDayToTrip(trip); plannerState.day = trip.days.length-1; renderPlannerItinerary(trip); };
  $('addStopBtn2').onclick = ()=>openAddPlaceSearch(trip);
  $('centerBtn2').onclick = ()=>renderPlannerMap(trip, trip.days[plannerState.day]);
  $('mapSearchToggle').onclick = ()=>$('mapSearchBar').classList.toggle('hidden');
  $('mapSearchGo').onclick = ()=>plannerMapSearch(trip);
  $('mapSearchInput').onkeydown = e=>{ if(e.key==='Enter') plannerMapSearch(trip); };

  if(ptab==='budget') renderBudgetTab(trip);
  else if(ptab==='collab') renderCollabTab(trip);
  else if(ptab==='unscheduled') renderUnscheduledTab(trip);
  else if(ptab==='packing') renderPackingTab(trip);
  else if(ptab==='bookings') renderBookingsTab(trip);
  else if(ptab==='itinerary') renderPlannerItinerary(trip);
  else renderDashboardTab(trip);
}
function renderCollabStack(trip){ $('collabStack').innerHTML = trip.collaborators.map(c=>`<div class="avatar sm" title="${esc(c.name)}">${c.initials}</div>`).join(''); }

/* ---------------- Trip Dashboard (the trip's home page) ---------------- */
function renderDashboardTab(trip){
  const dest = destForTrip(trip);
  const body = $('ptab-dashboard');
  const progress = computeTripProgress(trip);
  const unscheduled = unscheduledPlacesForTrip(trip);
  const remaining = trip.budget.total - tripPlannedTotal(trip);

  // One action card per real, unfinished thing — never a card for a feature that doesn't exist.
  const nextSteps = [];
  const hotelItem = progress.items.find(i=>i.key==='hotel');
  if(hotelItem && hotelItem.status!=='done') nextSteps.push({ icon:'🏨', title:'Choose Accommodation',
    desc:'Find the best area to stay based on your itinerary.', cta:'Find Hotels',
    go:()=>navigate(`#/destination/${encodeURIComponent(dest.id)}/hotels`) });
  if(unscheduled.length) nextSteps.push({ icon:'📍', title:`${unscheduled.length} Place${unscheduled.length===1?'':'s'} Not Yet Scheduled`,
    desc:'You have saved places waiting to be added to your itinerary.', cta:'Organize Places',
    go:()=>navigate(`#/trip/${trip.id}/unscheduled`) });
  const itinItem = progress.items.find(i=>i.key==='itin');
  if(itinItem && itinItem.status!=='done'){
    const emptyDays = trip.days.filter(d=>!d.stops.length).length;
    nextSteps.push({ icon:'🗓️', title:'Finish Your Itinerary', desc:`${emptyDays} day${emptyDays===1?'':'s'} still ${emptyDays===1?'has':'have'} nothing planned.`,
      cta:'Open Itinerary', go:()=>navigate(`#/trip/${trip.id}/itinerary`) });
  }
  nextSteps.push({ icon:'💰', title: remaining>=0 ? 'Budget Remaining' : 'Over Budget',
    desc: remaining>=0 ? `${fmt$(remaining)} remaining of ${fmt$(trip.budget.total)}.` : `${fmt$(-remaining)} over your ${fmt$(trip.budget.total)} budget.`,
    cta:'View Budget', go:()=>navigate(`#/trip/${trip.id}/budget`) });
  const bkItem = progress.items.find(i=>i.key==='bookings');
  if(bkItem && bkItem.status!=='done') nextSteps.push({ icon:'🎟️',
    title: bkItem.status==='partial' ? 'Add Missing Confirmations' : 'Log Your Bookings',
    desc: bkItem.status==='partial' ? bkItem.detail : 'Keep flights, hotels and tours (and their confirmation numbers) with the trip.',
    cta:'Open Bookings', go:()=>navigate(`#/trip/${trip.id}/bookings`) });
  const pkItem = progress.items.find(i=>i.key==='packing');
  if(pkItem && pkItem.status!=='done') nextSteps.push({ icon:'🎒', title: pkItem.status==='partial' ? 'Finish Packing' : 'Start Your Packing List',
    desc: pkItem.status==='partial' ? pkItem.detail : 'An AI-suggested checklist for this trip is ready for you.',
    cta:'Open Packing List', go:()=>navigate(`#/trip/${trip.id}/packing`) });

  const upcomingDay = trip.days[0];

  // A finished trip has no "next steps" worth showing — nudging someone to book a hotel for a
  // trip they already took would be nonsense. It gets the recap instead.
  const isOver = tripIsOver(trip);

  body.innerHTML = `
    <div class="dashGrid">
      <div>
        ${isOver ? renderRecapCard(trip) : `
        <h3 style="margin:0 0 12px">Next steps</h3>
        <div class="nextStepsGrid">
          ${nextSteps.map((s,i)=>`<div class="card nextStepCard">
            <div class="nsIcon">${s.icon}</div>
            <h4>${esc(s.title)}</h4>
            <p class="small">${esc(s.desc)}</p>
            <button class="btn primary sm" data-nextstep="${i}">${esc(s.cta)}</button>
          </div>`).join('')}
        </div>`}
        <h3 style="margin:26px 0 12px">Upcoming</h3>
        <div class="card">
          ${upcomingDay && upcomingDay.stops.length ? `
            <div class="small" style="font-weight:700;margin-bottom:10px">Day 1 · ${fmtDateFull(upcomingDay.date)}</div>
            ${upcomingDay.stops.slice(0,5).map(s=>`<div class="upcomingRow">
              <span class="upTime">${fmtTime12(s.time)}</span>
              <div class="stopThumb"><img src="${s.image}" data-photo-q="${esc(photoQuery(s.name, dest.name))}"></div>
              <span>${esc(s.name)}</span>
            </div>`).join('')}
            <button class="linklike" style="margin-top:10px" data-goitin="1">View full itinerary →</button>
          ` : `<div class="empty">No itinerary yet. <button class="linklike" data-goitin="1">Start planning →</button></div>`}
        </div>
      </div>
      <div>
        <h3 style="margin:0 0 12px">Trip snapshot</h3>
        <div class="snapshotGrid">
          <div class="ovCard"><div class="k">Planned activities</div><div class="v" style="font-size:22px">${tripStopCount(trip)}</div></div>
          <div class="ovCard"><div class="k">Unscheduled places</div><div class="v" style="font-size:22px">${unscheduled.length}</div></div>
          <div class="ovCard"><div class="k">Collaborators</div><div class="v" style="font-size:22px">${trip.collaborators.length}</div></div>
          <div class="ovCard"><div class="k">Planned spend</div><div class="v" style="font-size:22px">${fmt$(tripPlannedTotal(trip))}</div></div>
        </div>
        <h3 style="margin:26px 0 12px">Trip notes</h3>
        <div class="card">
          <p class="small" style="margin:0 0 8px">Confirmation numbers, packing reminders, ideas — anything about this trip as a whole.</p>
          <textarea class="notesTextarea" id="tripNotesInput" placeholder="Add a note for this trip…">${esc(trip.notes||'')}</textarea>
          <button class="btn sm primary" id="saveTripNotesBtn" style="margin-top:8px">Save</button>
        </div>
      </div>
    </div>`;
  nextSteps.forEach((s,i)=>{ const b = body.querySelector(`[data-nextstep="${i}"]`); if(b) b.onclick = s.go; });
  body.querySelectorAll('[data-goitin]').forEach(b=>b.onclick=()=>navigate(`#/trip/${trip.id}/itinerary`));
  const recapBtn = body.querySelector('#shareRecapBtn');
  if(recapBtn) recapBtn.onclick = ()=>{
    const text = buildRecapText(trip);
    const done = ()=>toast('Trip recap copied — paste it anywhere.');
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done).catch(()=>{ fallbackCopyText(text); done(); });
    } else { fallbackCopyText(text); done(); }
  };
  body.querySelector('#saveTripNotesBtn').onclick = ()=>{
    trip.notes = body.querySelector('#tripNotesInput').value.trim();
    saveState();
    toast('Trip notes saved.');
  };
  hydratePhotos(body);
}

/* ---------------- Unscheduled Places bucket ---------------- */
let unscheduledState = { search:'', cat:'all', sort:'rec' };
/* ---------------- Trip Inbox ---------------- */
function inboxTitleCase(s){
  return String(s).split(' ').filter(Boolean)
    .map(w=> w.length<=2 && /^(of|in|at|on|the|a|an|to|by)$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase()+w.slice(1))
    .join(' ');
}
/** Pulls a place name out of pasted text or a pasted link.
 * A static site can't fetch an arbitrary page cross-origin, so this reads the link ITSELF
 * rather than pretending to open it — which works, because travel URLs carry the place name in
 * their slug (…/Attraction_Review-g298184-d320447-Reviews-Senso_ji_Temple-Tokyo.html). Strips
 * the site's own scaffolding (ids, "Reviews", "Attraction", file extensions) and keeps the
 * longest human-looking segment. Returns null when there's nothing recognizable. */
function parsePastedPlace(raw){
  const text = String(raw||'').trim();
  if(!text) return null;
  if(!/^https?:\/\//i.test(text)) return text.split('\n')[0].slice(0,80).trim() || null;
  let u;
  try{ u = new URL(text); }catch(e){ return null; }
  const segs = u.pathname.split('/').filter(Boolean).map(s=>{ try{ return decodeURIComponent(s); }catch(e){ return s; } });
  let best = '';
  for(const seg of segs){
    const cleaned = seg
      .replace(/\.(html?|php|aspx)$/i,'')
      .replace(/[-_+]/g,' ')
      .replace(/\b[gd]\d+\b/gi,' ')
      .replace(/\b\d{3,}\b/g,' ')
      .replace(/\b(reviews?|attraction|attractions|things|to|do|hotel|hotels|restaurant|restaurants|tours?|activities|places?|maps?|search|www|com|en|us)\b/gi,' ')
      .replace(/\s+/g,' ').trim();
    const words = w => w.split(' ').filter(x=>x.length>1).length;
    if(words(cleaned) > words(best)) best = cleaned;
  }
  return best ? inboxTitleCase(best) : null;
}
/** Punctuation-insensitive, so a slug-derived "Senso Ji Temple" still matches the real
 * "Senso-ji Temple" — the hyphen only survives in one of the two. */
function normalizePlaceName(s){
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
}
/** Matches an extracted name against the destination's real place pool first, so a pasted link
 * to somewhere TripFlow already knows resolves to that real place (with its real rating,
 * coordinates and photo) rather than creating a thin duplicate. */
function matchPlaceByName(name, destId, destName){
  const pool = PLACES.filter(p=>p.destId===destId);
  let n = normalizePlaceName(name);
  const dn = normalizePlaceName(destName||'');
  // Travel URLs usually tack the city onto the slug ("Senso Ji Temple Tokyo"); drop it so it
  // doesn't stop the place itself from matching.
  if(dn && n.length > dn.length && n.endsWith(' '+dn)) n = n.slice(0, -(dn.length+1)).trim();
  if(!n) return null;
  const exact = pool.find(p=>normalizePlaceName(p.name)===n);
  if(exact) return exact;
  const sub = pool.find(p=>{ const pn = normalizePlaceName(p.name); return pn && (pn.includes(n) || n.includes(pn)); });
  if(sub) return sub;
  // Last resort: significant-word overlap, so small wording differences still land on the right
  // place, while an unrelated name stays unmatched and becomes the user's own item instead.
  const tokens = s => new Set(normalizePlaceName(s).split(' ').filter(w=>w.length>2));
  const nTok = tokens(n);
  if(!nTok.size) return null;
  let best = null, bestScore = 0;
  for(const p of pool){
    const pTok = tokens(p.name);
    if(!pTok.size) continue;
    let hits = 0;
    nTok.forEach(t=>{ if(pTok.has(t)) hits++; });
    const score = hits / Math.min(nTok.size, pTok.size);
    if(score > bestScore){ bestScore = score; best = p; }
  }
  return bestScore >= 0.6 ? best : null;
}
function addToTripInbox(trip, rawText){
  const dest = destForTrip(trip);
  const name = parsePastedPlace(rawText);
  if(!name){ toast("Couldn't find a place name in that — try pasting the name itself."); return false; }
  const collection = STATE.collections[0];
  const matched = matchPlaceByName(name, dest.id, dest.name);
  if(matched){
    if(collection.placeIds.includes(matched.id)){ toast(`${matched.name} is already saved.`); return false; }
    collection.placeIds.push(matched.id);
    logActivity(trip, `added ${matched.name} from the trip inbox.`);
    saveState();
    toast(`Found "${matched.name}" in ${dest.name} — added to unscheduled.`);
    return true;
  }
  // Not in the pool — keep the user's own item rather than inventing details for it. Location
  // is the destination's centre and is labelled approximate, never presented as verified.
  const place = {
    id: `${dest.id}-inbox-${Date.now().toString(36)}`,
    destId: dest.id, type:'attraction', name,
    category:'From your inbox', rating:0, reviews:0, priceLevel:0, price:0,
    area: dest.name, lat: dest.lat, lng: dest.lng,
    desc: 'Saved from a link you pasted. Location is approximate until you set it.',
    tags:['hidden'], duration:75, fromInbox:true,
    image: img('inbox-'+name, 640, 480, name),
  };
  PLACES.push(place);
  collection.placeIds.push(place.id);
  logActivity(trip, `added "${name}" from the trip inbox.`);
  saveState();
  toast(`Added "${name}" to unscheduled places.`);
  return true;
}
function wireTripInbox(trip){
  const input = $('inboxInput'), btn = $('inboxAdd');
  if(!input || !btn) return;
  const submit = ()=>{
    const text = input.value.trim();
    if(!text) return;
    if(addToTripInbox(trip, text)){ input.value=''; renderUnscheduledTab(trip); renderTripProgress(trip); }
  };
  btn.onclick = submit;
  input.onkeydown = e=>{ if(e.key==='Enter') submit(); };
}

function renderUnscheduledTab(trip){
  const dest = destForTrip(trip);
  const body = $('ptab-unscheduled');
  const all = unscheduledPlacesForTrip(trip);
  body.innerHTML = `
    <div class="inboxBar">
      <div class="inboxHead">📥 Trip Inbox</div>
      <p class="small" style="margin:2px 0 9px">Paste a link you found (or just type a place name) and it lands here, ready to schedule.</p>
      <div class="shareRow">
        <input id="inboxInput" placeholder="Paste a link, or type a place name…">
        <button class="btn primary sm" id="inboxAdd">Add</button>
      </div>
    </div>
    <div class="panelHead" style="padding:0 0 14px;border:0">
      <h3>${all.length} Place${all.length===1?'':'s'} Waiting to Be Scheduled</h3>
      <button class="btn magic" id="uOrganizeAI" ${all.length?'':'disabled'}>✨ Organize with AI</button>
    </div>
    ${all.length ? `<div class="filterBar">
      <div class="filterGroup" style="flex:1;min-width:180px"><label>Search</label><input id="uSearch" placeholder="Search unscheduled places…"></div>
      <div class="filterGroup"><label>Category</label><select id="uCat"><option value="all">All</option><option value="attraction">Attractions</option><option value="restaurant">Restaurants</option></select></div>
      <div class="filterGroup"><label>Sort</label><select id="uSort"><option value="rec">Recommended</option><option value="name">Name (A–Z)</option><option value="category">Category</option><option value="distance">Distance from center</option></select></div>
    </div>
    <div class="unschedLayout">
      <div class="unschedList" id="unschedList"></div>
      <div class="unschedDayZones">
        <div class="small" style="font-weight:700;margin-bottom:8px">Drag a place onto a day to schedule it</div>
        <div id="dayDropZones"></div>
      </div>
    </div>` : `<div class="empty" style="padding:50px 20px">
      <div style="font-size:30px;margin-bottom:8px">📍</div>
      <div>Nothing waiting to be scheduled.</div>
      <div class="small" style="margin-top:4px">Save places from ${esc(dest.name)}'s Things To Do, Restaurants, or Hotels tabs and they'll show up here until you add them to a day.</div>
      <button class="btn primary" style="margin-top:14px" data-explore="1">Explore ${esc(dest.name)}</button>
    </div>`}`;
  wireTripInbox(trip);
  if(!all.length){ const b=body.querySelector('[data-explore]'); if(b) b.onclick=()=>navigate(`#/destination/${encodeURIComponent(dest.id)}/things`); return; }

  $('uSearch').value = unscheduledState.search; $('uCat').value = unscheduledState.cat; $('uSort').value = unscheduledState.sort;

  function drawDayZones(){
    $('dayDropZones').innerHTML = trip.days.map((d,i)=>`
      <div class="dayDropZone" data-dropday="${i}">
        <div class="small" style="font-weight:700">Day ${i+1} · ${fmtDateShort(d.date)}</div>
        <div class="small">${d.stops.length} stop${d.stops.length===1?'':'s'}</div>
      </div>`).join('');
    $('dayDropZones').querySelectorAll('[data-dropday]').forEach(zone=>{
      zone.addEventListener('dragover', e=>{ e.preventDefault(); zone.classList.add('dragover'); });
      zone.addEventListener('dragleave', ()=>zone.classList.remove('dragover'));
      zone.addEventListener('drop', e=>{
        e.preventDefault(); zone.classList.remove('dragover');
        const placeId = e.dataTransfer.getData('text/place-id');
        const p = placeId && placeById(placeId);
        if(!p) return;
        addPlaceToTrip(trip, Number(zone.dataset.dropday), p);
        toast(`${p.name} scheduled on Day ${Number(zone.dataset.dropday)+1}.`);
        renderUnscheduledTab(trip); renderTripProgress(trip);
      });
    });
  }
  function apply(){
    unscheduledState = { search:$('uSearch').value, cat:$('uCat').value, sort:$('uSort').value };
    let arr = all.filter(p=>{
      if(unscheduledState.cat!=='all' && p.type!==unscheduledState.cat) return false;
      if(unscheduledState.search && !p.name.toLowerCase().includes(unscheduledState.search.toLowerCase())) return false;
      return true;
    });
    if(unscheduledState.sort==='name') arr.sort((a,b)=>a.name.localeCompare(b.name));
    else if(unscheduledState.sort==='category') arr.sort((a,b)=>(a.category||a.cuisine||a.type).localeCompare(b.category||b.cuisine||b.type));
    else if(unscheduledState.sort==='distance') arr.sort((a,b)=>haversine(dest,a)-haversine(dest,b));
    else arr.sort((a,b)=>(b.rating||0)-(a.rating||0));

    $('unschedList').innerHTML = arr.length ? arr.map(p=>`
      <div class="unschedCard" draggable="true" data-place="${p.id}">
        <div class="stopThumb"><img src="${p.image}" data-photo-q="${esc(photoQuery(p.name, dest.name))}"></div>
        <div class="unschedInfo">
          <h4>${esc(p.name)}</h4>
          <p class="small">${esc(p.category||p.cuisine||p.type)}${p.area?' · '+esc(p.area):''}${p.rating?' · ★ '+p.rating:''}</p>
        </div>
        <div class="unschedActions">
          <select class="uDayPick" data-dayfor="${p.id}" aria-label="Add ${esc(p.name)} to day"><option value="">Add to day…</option>${trip.days.map((d,i)=>`<option value="${i}">Day ${i+1}</option>`).join('')}</select>
          <button class="btn sm" data-viewmap="${p.id}" title="View on map"><i class="fa-solid fa-map-location-dot"></i></button>
          <button class="btn sm danger" data-unsave="${p.id}" title="Remove from saved"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`).join('') : `<div class="empty">No unscheduled places match those filters. <button class="linklike" data-clearfilters="1">Clear filters</button></div>`;

    $('unschedList').querySelectorAll('[data-place]').forEach(card=>{
      card.addEventListener('dragstart', e=>{ e.dataTransfer.setData('text/place-id', card.dataset.place); card.classList.add('dragging'); });
      card.addEventListener('dragend', ()=>card.classList.remove('dragging'));
    });
    $('unschedList').querySelectorAll('[data-dayfor]').forEach(sel=>sel.onchange=()=>{
      if(!sel.value) return;
      const p = placeById(sel.dataset.dayfor);
      addPlaceToTrip(trip, Number(sel.value), p);
      toast(`${p.name} scheduled on Day ${Number(sel.value)+1}.`);
      renderUnscheduledTab(trip); renderTripProgress(trip);
    });
    $('unschedList').querySelectorAll('[data-viewmap]').forEach(b=>b.onclick=()=>viewPlaceOnMap(b.dataset.viewmap));
    $('unschedList').querySelectorAll('[data-unsave]').forEach(b=>b.onclick=()=>{
      const p = placeById(b.dataset.unsave);
      STATE.collections.forEach(c=>{ c.placeIds = c.placeIds.filter(id=>id!==p.id); });
      saveState();
      toast(`${p.name} removed from your saved places.`);
      renderUnscheduledTab(trip); renderTripProgress(trip);
    });
    const clearBtn = $('unschedList').querySelector('[data-clearfilters]');
    if(clearBtn) clearBtn.onclick = ()=>{ unscheduledState = {search:'',cat:'all',sort:'rec'}; renderUnscheduledTab(trip); };
    hydratePhotos($('unschedList'));
  }
  $('uSearch').oninput = debounce(apply, 150);
  $('uCat').onchange = apply;
  $('uSort').onchange = apply;
  $('uOrganizeAI').onclick = ()=>openOrganizeWithAI(trip, all);
  drawDayZones();
  apply();
}
/** Assigns each unscheduled place to whichever day it's geographically closest to (lightly
 * favoring days with fewer stops so one day doesn't get overloaded) — real distance-based
 * logic, not a random or fixed assignment. Never applied without the user confirming. */
function organizeUnscheduledWithAI(trip, places){
  const dest = destForTrip(trip);
  return places.map(p=>{
    let bestDay = 0, bestScore = Infinity;
    trip.days.forEach((day,i)=>{
      const anchor = day.stops.length ? day.stops[Math.floor(day.stops.length/2)] : dest;
      const score = haversine(p, anchor) + day.stops.length*0.15;
      if(score < bestScore){ bestScore = score; bestDay = i; }
    });
    return { place:p, dayIdx:bestDay };
  });
}
function openOrganizeWithAI(trip, places){
  const proposal = organizeUnscheduledWithAI(trip, places);
  const byDay = {};
  proposal.forEach(({place,dayIdx})=>{ (byDay[dayIdx]=byDay[dayIdx]||[]).push(place); });
  $('organizeAIBody').innerHTML = Object.keys(byDay).sort((a,b)=>a-b).map(dayIdx=>`
    <div class="card" style="margin-bottom:10px">
      <h4 style="margin:0 0 8px">Day ${Number(dayIdx)+1}</h4>
      ${byDay[dayIdx].map(p=>`<div class="small" style="margin:4px 0">📍 ${esc(p.name)}</div>`).join('')}
    </div>`).join('');
  window.__organizeProposal = { trip, proposal };
  openModal('modal-organizeAI');
}
function initOrganizeAIModal(){
  $('acceptOrganizeAIBtn').onclick = ()=>{
    const pending = window.__organizeProposal;
    if(!pending) return;
    pending.proposal.forEach(({place,dayIdx})=>addPlaceToTrip(pending.trip, dayIdx, place));
    logActivity(pending.trip, `AI organized ${pending.proposal.length} unscheduled place(s) into the itinerary.`);
    saveState();
    closeModal('modal-organizeAI');
    toast(`Added ${pending.proposal.length} place(s) to your itinerary.`);
    if(plannerState.tripId===pending.trip.id) renderPlannerView(pending.trip.id, 'unscheduled');
  };
}

/* ---------------- AI-suggested packing list ---------------- */
/** Rule-based (not a live model call) starter packing list, tailored to the trip's length and
 * the destination's real tags (beach, adventure, culture, nightlife) plus its actual travel-info
 * — never a generic one-size-fits-all list. Generated once per trip; after that it's the user's
 * own editable checklist (checked items and custom additions are never overwritten). */
function generatePackingList(trip, dest){
  const days = trip.days.length || 1;
  const tags = dest.tags || [];
  const items = [];
  let n = 0;
  const add = (category, text) => items.push({ id:'pk'+(n++), category, text, checked:false });

  add('Documents & Money', 'Passport (valid 6+ months from your travel dates)');
  if(dest.travelInfo && dest.travelInfo.visa) add('Documents & Money', `Entry requirements: ${dest.travelInfo.visa}`);
  add('Documents & Money', 'Travel insurance confirmation');
  add('Documents & Money', 'Hotel & flight confirmations (saved offline, not just email)');
  add('Documents & Money', 'A backup payment card + a little local cash');

  add('Electronics', 'Phone charger + portable battery pack');
  add('Electronics', 'Universal power adapter');
  add('Electronics', 'Headphones');

  add('Clothing', `Outfits for ${days} day${days===1?'':'s'}${days>5?' (plan on doing laundry, don’t pack for all '+days+')':''}`);
  add('Clothing', 'Comfortable walking shoes');
  if(tags.includes('beach')){ add('Clothing','Swimwear'); add('Clothing','Sandals / flip-flops'); add('Health & Toiletries','Reef-safe sunscreen'); }
  if(tags.includes('adventure')){ add('Clothing','Sturdy hiking shoes'); add('Clothing','Light rain jacket'); add('Health & Toiletries','Reusable water bottle'); }
  if(tags.includes('nightlife') || tags.includes('romantic')) add('Clothing','One dressier outfit for a night out');
  if(tags.includes('culture')) add('Clothing','A modest layer for temples & religious sites');

  add('Health & Toiletries', 'Toiletry kit + any prescription medication');
  add('Health & Toiletries', 'Basic first-aid (pain reliever, band-aids)');

  add('Before You Go', `Check the weather forecast for ${dest.name} closer to your trip`);
  return items;
}
function packingProgress(trip){
  const list = trip.packing || [];
  const packed = list.filter(i=>i.checked).length;
  return { packed, total: list.length };
}
function renderPackingTab(trip){
  const dest = destForTrip(trip);
  if(trip.packing == null){ trip.packing = generatePackingList(trip, dest); saveState(); }
  const body = $('ptab-packing');
  const { packed, total } = packingProgress(trip);
  const pct = total ? Math.round(packed/total*100) : 0;
  const categories = [];
  trip.packing.forEach(i=>{ if(!categories.includes(i.category)) categories.push(i.category); });

  body.innerHTML = `
    <div class="panel" style="padding:18px">
      <div class="panelHead">
        <div><h3 style="margin:0">Packing List</h3><p class="small" style="margin:2px 0 0">AI-suggested for ${esc(dest.name)}, ${trip.days.length} day${trip.days.length===1?'':'s'} — edit freely, it's yours.</p></div>
        <div class="progress" style="width:160px;flex-shrink:0"><div style="width:${pct}%"></div></div>
      </div>
      <p class="small" id="pkProgressLine" style="margin:0 0 14px">${packed}/${total} packed${total && packed===total?' — all set! 🎒':''}</p>
      ${categories.map(cat=>`
        <div style="margin-bottom:16px">
          <div class="small" style="font-weight:800;text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px">${esc(cat)}</div>
          <div style="display:flex;flex-direction:column;gap:7px">
            ${trip.packing.filter(i=>i.category===cat).map(i=>`
              <div class="listRow">
                <label class="left" style="cursor:pointer;flex:1">
                  <input type="checkbox" data-pkcheck="${i.id}" ${i.checked?'checked':''}>
                  <span style="${i.checked?'text-decoration:line-through;color:var(--muted)':''}">${esc(i.text)}</span>
                </label>
                <button class="btn sm danger" data-pkremove="${i.id}"><i class="fa-solid fa-trash"></i></button>
              </div>`).join('')}
          </div>
        </div>`).join('')}
      <div class="shareRow" style="margin-top:6px">
        <input id="pkNewItem" placeholder="Add your own item…">
        <select id="pkNewCategory">${categories.map(c=>`<option>${esc(c)}</option>`).join('')}<option>Other</option></select>
        <button class="btn sm primary" id="pkAddBtn">Add</button>
      </div>
    </div>`;

  body.querySelectorAll('[data-pkcheck]').forEach(cb=>cb.onchange=()=>{
    const item = trip.packing.find(i=>i.id===cb.dataset.pkcheck);
    item.checked = cb.checked;
    saveState();
    renderPackingTab(trip);
    renderTripProgress(trip);
  });
  body.querySelectorAll('[data-pkremove]').forEach(b=>b.onclick=()=>{
    trip.packing = trip.packing.filter(i=>i.id!==b.dataset.pkremove);
    saveState();
    renderPackingTab(trip);
    renderTripProgress(trip);
  });
  $('pkAddBtn').onclick = ()=>{
    const text = $('pkNewItem').value.trim();
    if(!text) return;
    const category = $('pkNewCategory').value;
    trip.packing.push({ id:'pk'+Date.now().toString(36), category, text, checked:false });
    saveState();
    renderPackingTab(trip);
    renderTripProgress(trip);
  };
}

/* ---------------- Reservations & Bookings Center ---------------- */
const BOOKING_TYPES = [
  ['flight','✈️','Flight'], ['hotel','🏨','Accommodation'], ['restaurant','🍽️','Restaurant'],
  ['activity','🎟️','Activity / Tour'], ['transport','🚆','Transport'], ['other','📄','Other'],
];
function bookingTypeMeta(key){ return BOOKING_TYPES.find(t=>t[0]===key) || BOOKING_TYPES[BOOKING_TYPES.length-1]; }
function tripBookings(trip){ return trip.bookings || (trip.bookings = []); }
/** Sorted by when they actually happen, so the list reads as a timeline rather than
 * insertion order. Undated bookings sort last — they're the ones still missing details. */
function sortedBookings(trip){
  return tripBookings(trip).slice().sort((a,b)=>{
    if(!a.date && !b.date) return 0;
    if(!a.date) return 1;
    if(!b.date) return -1;
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : (a.time||'').localeCompare(b.time||'');
  });
}
let __bookingEditId = null;
function openBookingModal(trip, bookingId){
  __bookingEditId = bookingId || null;
  const existing = bookingId ? tripBookings(trip).find(b=>b.id===bookingId) : null;
  $('bookingModalTitle').textContent = existing ? 'Edit booking' : 'Add booking';
  $('bookingType').innerHTML = BOOKING_TYPES.map(([k,e,label])=>`<option value="${k}">${e} ${esc(label)}</option>`).join('');
  $('bookingType').value = existing ? existing.type : 'hotel';
  $('bookingTitle').value = existing ? existing.title : '';
  $('bookingConf').value = existing ? (existing.confirmation||'') : '';
  $('bookingDate').value = existing ? (existing.date||'') : trip.start;
  $('bookingTime').value = existing ? (existing.time||'') : '';
  $('bookingCost').value = existing && existing.cost ? existing.cost : '';
  $('bookingNotes').value = existing ? (existing.notes||'') : '';
  openModal('modal-booking');
}
function initBookingModal(){
  $('saveBookingBtn').onclick = ()=>{
    const trip = getTrip(plannerState.tripId);
    if(!trip) return;
    const title = $('bookingTitle').value.trim();
    if(!title){ toast('Give the booking a name first.'); return; }
    const fields = {
      type: $('bookingType').value,
      title,
      confirmation: $('bookingConf').value.trim(),
      date: $('bookingDate').value,
      time: $('bookingTime').value,
      cost: Number($('bookingCost').value) || 0,
      notes: $('bookingNotes').value.trim(),
    };
    const list = tripBookings(trip);
    const existing = __bookingEditId ? list.find(b=>b.id===__bookingEditId) : null;
    if(existing){
      Object.assign(existing, fields);
      logActivity(trip, `updated the ${bookingTypeMeta(fields.type)[2].toLowerCase()} booking "${title}".`);
    } else {
      list.push(Object.assign({ id: uid('bk') }, fields));
      logActivity(trip, `added a ${bookingTypeMeta(fields.type)[2].toLowerCase()} booking: "${title}".`);
    }
    saveState();
    closeModal('modal-booking');
    toast(existing ? 'Booking updated.' : 'Booking saved.');
    renderBookingsTab(trip);
    renderTripProgress(trip);
  };
}
function renderBookingsTab(trip){
  const body = $('ptab-bookings');
  const list = sortedBookings(trip);
  const totalCost = list.reduce((sum,b)=>sum+(b.cost||0), 0);
  const missingConf = list.filter(b=>!b.confirmation).length;

  body.innerHTML = `
    <div class="panel" style="padding:18px">
      <div class="panelHead">
        <div><h3 style="margin:0">Reservations &amp; Bookings</h3>
          <p class="small" style="margin:2px 0 0">${list.length ? `${list.length} booking${list.length===1?'':'s'} · ${fmt$(totalCost)} total${missingConf?` · ${missingConf} missing a confirmation number`:''}` : 'Everything you\'ve actually booked, in one place.'}</p></div>
        <button class="btn primary sm" id="addBookingBtn"><i class="fa-solid fa-plus"></i> Add booking</button>
      </div>
      ${list.length ? `<div class="bookingList">${list.map(b=>{
        const [k,emoji,label] = bookingTypeMeta(b.type);
        return `<div class="bookingCard">
          <div class="bkIcon">${emoji}</div>
          <div class="bkBody">
            <h4>${esc(b.title)}</h4>
            <div class="small">${esc(label)}${b.date?` · ${fmtDateFull(b.date)}`:''}${b.time?` · ${fmtTime12(b.time)}`:''}${b.cost?` · ${fmt$(b.cost)}`:''}</div>
            ${b.confirmation
              ? `<div class="bkConf">Confirmation <b>${esc(b.confirmation)}</b></div>`
              : `<div class="bkConf missing">No confirmation number yet</div>`}
            ${b.notes?`<p class="small" style="margin:6px 0 0">${esc(b.notes)}</p>`:''}
          </div>
          <div class="bkActions">
            <button class="btn sm" data-bkedit="${b.id}">Edit</button>
            <button class="btn sm danger" data-bkdel="${b.id}"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>`;
      }).join('')}</div>`
      : `<div class="empty" style="margin-top:14px">Nothing booked yet. As you book flights, hotels and tours, add them here so every confirmation number lives with the trip instead of buried in your inbox.<br><br><button class="btn primary" id="addBookingEmpty"><i class="fa-solid fa-plus"></i> Add your first booking</button></div>`}
    </div>`;

  const open = ()=>openBookingModal(trip, null);
  if($('addBookingBtn')) $('addBookingBtn').onclick = open;
  if($('addBookingEmpty')) $('addBookingEmpty').onclick = open;
  body.querySelectorAll('[data-bkedit]').forEach(b=>b.onclick=()=>openBookingModal(trip, b.dataset.bkedit));
  body.querySelectorAll('[data-bkdel]').forEach(b=>b.onclick=()=>{
    const bk = tripBookings(trip).find(x=>x.id===b.dataset.bkdel);
    confirmDialog('Delete this booking?', `"${bk?bk.title:''}" will be removed from this trip.`, ()=>{
      const list = tripBookings(trip);
      const index = list.findIndex(x=>x.id===b.dataset.bkdel);
      const removed = snapshot(bk);
      trip.bookings = list.filter(x=>x.id!==b.dataset.bkdel);
      logActivity(trip, `removed the booking "${bk?bk.title:''}".`);
      saveState();
      renderBookingsTab(trip);
      renderTripProgress(trip);
      toastUndo(`Deleted "${removed.title}".`, ()=>{ tripBookings(trip).splice(Math.max(0,index), 0, removed); });
    });
  });
}

/* ---------------- Trip Planning Progress ---------------- */
function computeTripProgress(trip){
  const dest = destForTrip(trip);
  const savedForDest = savedPlaceIdsForDest(dest.id);
  const savedCount = savedForDest.size;
  const savedHotel = [...savedForDest].some(id=>{ const p=placeById(id); return p && p.type==='hotel'; });
  const daysWithStops = trip.days.filter(d=>d.stops.length>0).length;
  const totalDays = trip.days.length;
  const expenses = trip.budget.expenses.length;
  const plannedSpend = tripPlannedTotal(trip);
  const budgetRatio = trip.budget.total ? plannedSpend/trip.budget.total : 0;
  const st = (done, partial)=> done ? 'done' : (partial ? 'partial' : 'todo');

  const items = [
    { key:'dest', label:'Destination Selected', detail:`${dest.flag} ${dest.name}`, status:'done',
      go:()=>navigate(`#/destination/${encodeURIComponent(dest.id)}`) },
    { key:'dates', label:'Dates Selected', detail:`${fmtDateShort(trip.start)} – ${fmtDateShort(trip.end)} · ${totalDays} day${totalDays===1?'':'s'}`, status:'done',
      go:()=>navigate(`#/trip/${trip.id}/itinerary`) },
    { key:'saved', label:'Places Saved', detail:`${savedCount} place${savedCount===1?'':'s'} saved`, status: st(savedCount>=5, savedCount>0),
      go:()=>navigate(`#/destination/${encodeURIComponent(dest.id)}/things`) },
    { key:'hotel', label:'Hotel Considered', detail: savedHotel ? 'A hotel is saved for this trip' : 'No hotel saved yet', status: st(savedHotel, false),
      go:()=>navigate(`#/destination/${encodeURIComponent(dest.id)}/hotels`) },
    { key:'itin', label:'Itinerary Planned', detail: totalDays ? `${daysWithStops}/${totalDays} days planned` : 'No days yet', status: st(totalDays>0 && daysWithStops===totalDays, daysWithStops>0),
      go:()=>navigate(`#/trip/${trip.id}/itinerary`) },
    { key:'budget', label:'Budget Tracked', detail: expenses ? `${expenses} expense${expenses===1?'':'s'} logged` : 'No expenses logged yet', status: st(expenses>0 && budgetRatio>=0.5, expenses>0),
      go:()=>navigate(`#/trip/${trip.id}/budget`) },
  ];
  const pk = packingProgress(trip);
  items.push({ key:'packing', label:'Packing List', detail: pk.total ? `${pk.packed}/${pk.total} items packed` : 'Not started yet',
    status: st(pk.total>0 && pk.packed===pk.total, pk.packed>0), go:()=>navigate(`#/trip/${trip.id}/packing`) });
  const bookings = tripBookings(trip);
  const confirmed = bookings.filter(b=>b.confirmation).length;
  items.push({ key:'bookings', label:'Bookings Confirmed',
    detail: bookings.length ? `${confirmed}/${bookings.length} have a confirmation number` : 'Nothing booked yet',
    status: st(bookings.length>0 && confirmed===bookings.length, bookings.length>0),
    go:()=>navigate(`#/trip/${trip.id}/bookings`) });
  const doneCount = items.filter(i=>i.status==='done').length;
  const partialCount = items.filter(i=>i.status==='partial').length;
  const percent = Math.round(((doneCount + partialCount*0.5) / items.length) * 100);
  const ready = items.every(i=>i.status==='done');
  return { items, percent, ready };
}
function renderTripProgress(trip){
  const el = $('tripProgress');
  if(!el) return;
  const { items, percent, ready } = computeTripProgress(trip);
  const icon = s => s==='done' ? '✅' : (s==='partial' ? '🟡' : '🔴');
  el.innerHTML = `
    <div class="progressHead">
      <div><b>Trip Planning Progress</b> <span class="small">${percent}%${ready?' · Ready to travel! 🎉':''}</span></div>
      <div class="progress" style="width:180px;flex-shrink:0"><div style="width:${percent}%"></div></div>
    </div>
    <div class="progressGrid">
      ${items.map(i=>`<button class="progressItem" data-pkey="${esc(i.key)}" type="button">
        <span class="pIcon">${icon(i.status)}</span>
        <span class="pText"><span class="pLabel">${esc(i.label)}</span><span class="small">${esc(i.detail)}</span></span>
      </button>`).join('')}
    </div>`;
  items.forEach(i=>{
    const btn = el.querySelector(`[data-pkey="${i.key}"]`);
    if(btn) btn.onclick = i.go;
  });
}
function plannerMapSearch(trip){
  const q = $('mapSearchInput').value.trim().toLowerCase();
  if(!q) return;
  const dest = destForTrip(trip);
  const match = PLACES.find(p=>p.destId===trip.destId && p.name.toLowerCase().includes(q));
  const frame = $('map2Frame');
  if(match && frame){
    frame.src = gmapsSearchEmbedUrl(match.name+', '+dest.name, 16);
    toast(`Found "${match.name}" — use "Add place" to add it to this day.`);
  } else if(frame){
    frame.src = gmapsSearchEmbedUrl(q+', '+dest.name, 14);
    toast(`Searching Google Maps for "${q}" — use "Add place" to add a stop.`);
  } else {
    toast('No matching place found in this destination.');
  }
}

function renderPlannerItinerary(trip){
  plannerState.day = clamp(plannerState.day, 0, trip.days.length-1);
  $('dayTabs2').innerHTML = trip.days.map((d,i)=>`<button class="dayTab ${i===plannerState.day?'active':''}" data-day="${i}">Day ${i+1}${trip.days.length>1?` <span class="rmDay" data-rmday="${i}">✕</span>`:''}</button>`).join('');
  $('dayTabs2').querySelectorAll('.dayTab').forEach(b=>b.onclick=(e)=>{ if(e.target.closest('[data-rmday]')) return; plannerState.day=Number(b.dataset.day); renderPlannerItinerary(trip); });
  $('dayTabs2').querySelectorAll('[data-rmday]').forEach(b=>b.onclick=(e)=>{
    e.stopPropagation();
    const idx = Number(b.dataset.rmday);
    confirmDialog('Remove this day?', `Day ${idx+1} and its stops will be removed from the trip.`, ()=>{
      const removedDay = snapshot(trip.days[idx]);
      const removedEnd = trip.end;
      toastUndo(`Removed Day ${idx+1}.`, ()=>{
        trip.days.splice(idx, 0, removedDay);
        trip.days.forEach((d,i)=>d.date=addDays(trip.start,i));
        trip.end = removedEnd;
        plannerState.day = clamp(idx, 0, trip.days.length-1);
      });
      trip.days.splice(idx,1);
      trip.days.forEach((d,i)=>d.date=addDays(trip.start,i));
      trip.end = trip.days[trip.days.length-1].date;
      plannerState.day = clamp(plannerState.day,0,trip.days.length-1);
      saveState();
      renderPlannerView(trip.id,'itinerary');
    });
  });

  const day = trip.days[plannerState.day];
  $('dayToolbar').innerHTML = `<label class="small" style="font-weight:700">Date</label><input type="date" id="dayDateInput" value="${day.date}"><span class="small">${day.stops.length} stop${day.stops.length===1?'':'s'} · drag cards to reorder</span><button class="btn sm" id="dayNoteToggle" style="margin-left:auto"><i class="fa-regular fa-note-sticky"></i> Day note${day.note?' •':''}</button>`;
  $('dayDateInput').onchange = (e)=>{ day.date = e.target.value; saveState(); toast('Day date updated.'); };
  $('dayNoteToggle').onclick = ()=>$('dayNoteBox').classList.toggle('hidden');

  renderWeatherForDay(trip, day);
  renderDayNote(trip, day);
  renderConflictWarning(trip, day);
  renderRouteWarning(trip, day);
  renderTimeline(trip, day);
  renderPlannerMap(trip, day);
  renderPlannerStats(trip, day);
}

/** Proactively detects a zigzagging/inefficient day (e.g. Shibuya → Asakusa → Shibuya) by
 * comparing the current stop order's total distance against the nearest-neighbor optimized
 * order — the same math already used by the on-demand Optimize modal. */
function detectInefficiencyRoute(day){
  if(day.stops.length<4) return null;
  const current = totalDistance(day.stops);
  const optDist = totalDistance(nearestNeighborOrder(day.stops));
  const saved = current - optDist;
  if(saved < 1 || saved < current*0.15) return null; // not meaningfully inefficient
  return { current, optDist, saved };
}
function renderRouteWarning(trip, day){
  const el = $('routeWarning');
  if(!el) return;
  const result = detectInefficiencyRoute(day);
  if(!result){ el.classList.add('hidden'); el.innerHTML=''; return; }
  el.classList.remove('hidden');
  const minSaved = Math.round(result.saved * 12); // ~12 min/km at an easy walking+transit pace
  el.innerHTML = `
    <div class="warnIcon">⚠️</div>
    <div class="warnBody">
      <b>This day's route may be inefficient</b>
      <p class="small">Your stops are ordered in a way that adds about ${result.saved.toFixed(1)} km (~${minSaved} min) of extra travel. Reordering them could save that time.</p>
    </div>
    <button class="btn primary sm" id="routeWarnOptimize">Optimize My Route</button>`;
  $('routeWarnOptimize').onclick = ()=>openOptimizeModal(trip, plannerState.day);
}
function timeToMin(t){ const [h,m] = (t||'09:00').split(':').map(Number); return h*60+m; }
/* ---------------- weather-aware planning ---------------- */
const OUTDOOR_TAGS = ['nature','adventure','photography','relax'];
const OUTDOOR_CATS = ['Nature','Viewpoint','Park','Beach','Garden'];
function isOutdoorStop(s){
  const p = placeById(s.placeId) || s;
  const tags = p.tags || [];
  return OUTDOOR_CATS.includes(s.category) || OUTDOOR_CATS.includes(p.category)
      || tags.some(t=>OUTDOOR_TAGS.includes(t));
}
/** Indoor stand-ins drawn from the destination's REAL place pool — museums, galleries, markets,
 * covered food halls — excluding anything already on that day. Returns [] when the pool has
 * nothing suitable, so the advice never points at places that don't exist. */
function indoorAlternatives(dest, day, limit){
  const onDay = new Set(day.stops.map(s=>s.placeId));
  return PLACES.filter(p=>p.destId===dest.id && !onDay.has(p.id) && p.type!=='hotel')
    .filter(p=>/museum|gallery|market|hall|aquarium|theatre|theater|centre|center/i.test(`${p.category||''} ${p.name}`)
             || (p.tags||[]).some(t=>['art','shopping','food','culture'].includes(t)))
    .filter(p=>!isOutdoorStop(p))
    .sort((a,b)=>(b.rating||0)-(a.rating||0))
    .slice(0, limit||3);
}
function renderWeatherForDay(trip, day){
  const el = $('dayWeather');
  if(!el) return;
  const dest = destForTrip(trip);
  el.classList.add('hidden');
  el.innerHTML = '';
  fetchForecast(dest.lat, dest.lng, day.date, day.date).then(days=>{
    if(!days || !days.length) return;                       // no forecast: show nothing at all
    if(!$('dayWeather')) return;                            // navigated away mid-flight
    const cur = getTrip(plannerState.tripId);
    if(!cur || cur.id !== trip.id) return;
    if(!cur.days[plannerState.day] || cur.days[plannerState.day].date !== day.date) return;
    const w = days.find(d=>d.date === day.date) || days[0];
    const [label, emoji] = weatherMeta(w.code);
    const outdoor = day.stops.filter(isOutdoorStop);
    const wet = typeof w.rain === 'number' && w.rain >= 60;
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="weatherChip">
        <span class="wIcon">${emoji}</span>
        <span><b>${esc(label)}</b>${w.max!=null?` · ${Math.round(w.max)}°/${Math.round(w.min)}°C`:''}${w.rain!=null?` · ${w.rain}% rain`:''}</span>
      </div>
      ${wet && outdoor.length >= 2 ? (()=>{
        const alts = indoorAlternatives(dest, day, 3);
        return `<div class="weatherAdvice">
          <b>⚠️ ${w.rain}% chance of rain, and ${outdoor.length} of today's stops are outdoors.</b>
          ${alts.length ? `<p class="small" style="margin:5px 0 7px">Indoor options in ${esc(dest.name)} you could swap in:</p>
            <div class="altRow">${alts.map(p=>`<button class="btn sm" data-altadd="${p.id}">+ ${esc(p.name)}</button>`).join('')}</div>`
          : `<p class="small" style="margin:5px 0 0">Worth packing a rain layer — there aren't obvious indoor swaps in this destination's places yet.</p>`}
        </div>`;
      })() : ''}`;
    el.querySelectorAll('[data-altadd]').forEach(b=>b.onclick=()=>{
      const p = placeById(b.dataset.altadd);
      if(p) addPlaceToTrip(cur, plannerState.day, p);
    });
  }).catch(()=>{});
}
/** Detects two stops on the same day whose occupied time windows (duration + transit to the
 * next stop) actually overlap — e.g. a stop scheduled to run until 11:30 with the next stop
 * starting at 11:00 — regardless of how they got that way (manual time edit, the time-of-day
 * picker, or an AI-organized day). */
function detectTimeConflicts(day){
  if(day.stops.length<2) return [];
  const sorted = day.stops.slice().sort((a,b)=>timeToMin(a.time)-timeToMin(b.time));
  const conflicts = [];
  for(let i=0;i<sorted.length-1;i++){
    const cur = sorted[i], next = sorted[i+1];
    const endMin = timeToMin(cur.time) + (cur.duration||90) + (cur.transitToNext?.mins||15);
    const nextMin = timeToMin(next.time);
    if(endMin > nextMin) conflicts.push({ a: cur, b: next, overlapMins: endMin - nextMin });
  }
  return conflicts;
}
function renderConflictWarning(trip, day){
  const el = $('conflictWarning');
  if(!el) return;
  const conflicts = detectTimeConflicts(day);
  if(!conflicts.length){ el.classList.add('hidden'); el.innerHTML=''; return; }
  el.classList.remove('hidden');
  const first = conflicts[0];
  const extra = conflicts.length>1 ? ` (+${conflicts.length-1} more conflict${conflicts.length>2?'s':''} this day)` : '';
  el.innerHTML = `
    <div class="warnIcon">⏰</div>
    <div class="warnBody">
      <b>Scheduling conflict on this day</b>
      <p class="small">"${esc(first.a.name)}" runs about ${first.overlapMins} min past when "${esc(first.b.name)}" starts.${extra}</p>
    </div>
    <button class="btn primary sm" id="conflictAutoFix">Auto-fix Times</button>`;
  $('conflictAutoFix').onclick = ()=>{
    recomputeDayTimes(day);
    saveState();
    renderPlannerItinerary(trip);
    toast('Times adjusted to remove the conflict.');
  };
}
function renderDayNote(trip, day){
  const el = $('dayNoteBox');
  if(!el) return;
  el.classList.toggle('hidden', !day.note);
  el.innerHTML = `<div class="stopNote" style="align-items:stretch"><textarea class="notesTextarea" style="border:1px solid var(--line);background:var(--surface2);min-height:44px" id="dayNoteInput" placeholder="Add a note for this day…">${esc(day.note||'')}</textarea><button class="btn sm primary" id="saveDayNoteBtn">Save</button></div>`;
  $('saveDayNoteBtn').onclick = ()=>{
    day.note = $('dayNoteInput').value.trim();
    saveState();
    el.classList.toggle('hidden', !day.note);
    toast('Day note saved.');
  };
}
function stopHTML(s, i, total, destName){
  const showTransit = i < total-1;
  return `
  <div class="stop" draggable="true" data-idx="${i}" data-stopid="${s.id}">
    <div class="stopTop">
      <div class="stopThumb"><img src="${s.image}" alt="" data-photo-q="${esc(photoQuery(s.name, destName))}"><span class="num ${s.type}">${i+1}</span></div>
      <div class="stopBody">
        <h4>${esc(s.name)}</h4>
        <p>${esc(s.category||'')}${s.area?' · '+esc(s.area):''}</p>
        <div class="stopMeta">
          <input class="stopTimeInput" type="time" value="${s.time}" data-time="${s.id}">
          <span>${s.cost?fmt$(s.cost):'Free'}</span>
          ${s.rating?`<span>★ ${s.rating}</span>`:''}
        </div>
        <div class="voteRow">
          <button class="voteBtn ${s.votes.userVoted==='interested'?'active':''}" data-vote="${s.id}::interested">👍 ${s.votes.interested}</button>
          <button class="voteBtn ${s.votes.userVoted==='mustvisit'?'active':''}" data-vote="${s.id}::mustvisit">❤️ ${s.votes.mustvisit}</button>
          <button class="voteBtn ${s.votes.userVoted==='skip'?'active':''}" data-vote="${s.id}::skip">❌ ${s.votes.skip}</button>
        </div>
        <div class="stopActions">
          <button class="btn sm" data-note="${s.id}"><i class="fa-regular fa-note-sticky"></i> Note</button>
          <button class="btn sm" data-comment="${s.id}"><i class="fa-regular fa-comment"></i> Comment${s.comments.length?` (${s.comments.length})`:''}</button>
          <a class="btn sm" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.name)}"><i class="fa-solid fa-diamond-turn-right"></i> Directions</a>
          <button class="btn sm danger" data-rm="${s.id}"><i class="fa-solid fa-trash"></i> Remove</button>
        </div>
        <div class="noteBox ${s.note?'':'hidden'}" data-notebox="${s.id}">
          <div class="stopNote"><textarea placeholder="Add a note for this stop…">${esc(s.note||'')}</textarea><button class="btn sm primary" data-savenote="${s.id}">Save</button></div>
        </div>
        <div class="commentThread hidden" data-thread="${s.id}">
          ${s.comments.map(c=>`<div class="commentRow"><b>${esc(c.author)}:</b> ${esc(c.text)}</div>`).join('')}
          <div class="shareRow" style="margin-top:6px"><input placeholder="Add a comment…" data-commentinput="${s.id}"><button class="btn sm primary" data-postcomment="${s.id}">Post</button></div>
        </div>
      </div>
    </div>
  </div>
  ${showTransit ? transitRowHTML(s) : ''}`;
}
function transitRowHTML(s){
  const modes = ['Walk','Taxi','Transit','Drive'];
  return `<div class="transitRow">
    <i class="fa-solid fa-shoe-prints"></i>
    <select data-transitmode="${s.id}">${modes.map(m=>`<option ${s.transitToNext.mode===m?'selected':''}>${m}</option>`).join('')}</select>
    <span>~${s.transitToNext.mins} min to next stop</span>
  </div>`;
}
function renderTimeline(trip, day){
  const el = $('timeline2');
  if(!day.stops.length){ el.innerHTML = '<div class="empty">No stops yet. Use "Add place" above, or generate a Trip Idea for this destination.</div>'; return; }
  const destName = destForTrip(trip).name;
  el.innerHTML = day.stops.map((s,i)=>stopHTML(s,i,day.stops.length,destName)).join('');
  wireStopEvents(trip, day);
  hydratePhotos(el);
}
function wireStopEvents(trip, day){
  const el = $('timeline2');
  let dragIdx = null;
  el.querySelectorAll('.stop').forEach(stopEl=>{
    stopEl.addEventListener('dragstart', ()=>{ dragIdx = Number(stopEl.dataset.idx); stopEl.classList.add('dragging'); });
    stopEl.addEventListener('dragend', ()=>{ stopEl.classList.remove('dragging'); el.querySelectorAll('.stop').forEach(x=>x.classList.remove('dragover')); });
    stopEl.addEventListener('dragover', (e)=>{ e.preventDefault(); stopEl.classList.add('dragover'); });
    stopEl.addEventListener('dragleave', ()=>stopEl.classList.remove('dragover'));
    stopEl.addEventListener('drop', (e)=>{
      e.preventDefault();
      const targetIdx = Number(stopEl.dataset.idx);
      if(dragIdx===null || dragIdx===targetIdx) return;
      const [moved] = day.stops.splice(dragIdx,1);
      day.stops.splice(targetIdx,0,moved);
      recomputeDayTimes(day);
      saveState();
      renderTimeline(trip, day); renderPlannerMap(trip, day); renderPlannerStats(trip, day);
      toast('Reordered — times updated to match.');
    });
  });
  el.querySelectorAll('[data-time]').forEach(inp=>inp.onchange=()=>{
    const s = day.stops.find(x=>x.id===inp.dataset.time); s.time = inp.value; saveState(); renderPlannerMap(trip,day);
    renderConflictWarning(trip, day); renderRouteWarning(trip, day);
  });
  el.querySelectorAll('[data-vote]').forEach(b=>b.onclick=()=>{
    const [sid,kind] = b.dataset.vote.split('::');
    const s = day.stops.find(x=>x.id===sid);
    if(s.votes.userVoted===kind){ s.votes[kind]--; s.votes.userVoted=null; }
    else{ if(s.votes.userVoted) s.votes[s.votes.userVoted]--; s.votes[kind]++; s.votes.userVoted=kind; }
    saveState(); renderTimeline(trip, day);
  });
  el.querySelectorAll('[data-note]').forEach(b=>b.onclick=()=>el.querySelector(`[data-notebox="${b.dataset.note}"]`).classList.toggle('hidden'));
  el.querySelectorAll('[data-savenote]').forEach(b=>b.onclick=()=>{
    const s = day.stops.find(x=>x.id===b.dataset.savenote);
    s.note = el.querySelector(`[data-notebox="${s.id}"] textarea`).value.trim();
    saveState(); renderTimeline(trip, day); toast('Note saved.');
  });
  el.querySelectorAll('[data-comment]').forEach(b=>b.onclick=()=>el.querySelector(`[data-thread="${b.dataset.comment}"]`).classList.toggle('hidden'));
  el.querySelectorAll('[data-postcomment]').forEach(b=>b.onclick=()=>{
    const s = day.stops.find(x=>x.id===b.dataset.postcomment);
    const inp = el.querySelector(`[data-commentinput="${s.id}"]`);
    const text = inp.value.trim();
    if(!text) return;
    s.comments.push({author:'You', text, ts:Date.now()});
    logActivity(trip, `commented on ${s.name}: "${text}"`);
    saveState(); renderTimeline(trip, day); toast('Comment added.');
  });
  el.querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{
    const idx = day.stops.findIndex(x=>x.id===b.dataset.rm);
    const removed = snapshot(day.stops[idx]);
    day.stops.splice(idx,1);
    logActivity(trip, `removed ${removed.name} from Day ${plannerState.day+1}.`);
    saveState();
    renderPlannerItinerary(trip);
    toastUndo(`Removed ${removed.name}.`, ()=>{ day.stops.splice(Math.max(0,idx), 0, removed); });
  });
  el.querySelectorAll('[data-transitmode]').forEach(sel=>sel.onchange=()=>{
    const s = day.stops.find(x=>x.id===sel.dataset.transitmode);
    s.transitToNext.mode = sel.value;
    s.transitToNext.mins = {Walk:15,Taxi:8,Transit:12,Drive:6}[sel.value];
    saveState(); renderTimeline(trip, day);
  });
}
function openAddPlaceSearch(trip){
  const dest = destForTrip(trip);
  $('addToTripSub').textContent = `Search places in ${dest.name} to add to Day ${plannerState.day+1}`;
  const usedIds = new Set(trip.days.flatMap(d=>d.stops.map(s=>s.placeId)));
  function render(q){
    let arr = PLACES.filter(p=>p.destId===dest.id && !usedIds.has(p.id));
    if(q) arr = arr.filter(p=>p.name.toLowerCase().includes(q.toLowerCase()));
    arr = arr.slice().sort((a,b)=>(b.rating||b.guestRating||0)-(a.rating||a.guestRating||0)).slice(0,25);
    $('addToTripBody').innerHTML = `
      <input id="addPlaceSearchInput" placeholder="Search attractions, restaurants, hotels…" style="width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:12px;font-weight:600;background:var(--surface2);color:var(--ink)" value="${esc(q||'')}">
      <div class="list" style="max-height:360px;overflow:auto">
        ${arr.length? arr.map(p=>`<div class="listRow"><div class="left"><img src="${p.image}" style="width:38px;height:38px;border-radius:8px;object-fit:cover;flex-shrink:0" data-photo-q="${esc(photoQuery(p.name, dest.name))}"><div><div>${esc(p.name)}</div><div class="small">${catEmoji(p.type)} ${esc(p.category||p.cuisine||'Hotel')} · ★ ${p.rating||p.guestRating}</div></div></div><button class="btn primary sm" data-quickadd="${p.id}">＋ Add</button></div>`).join('') : '<div class="empty">No matching places.</div>'}
      </div>`;
    $('addPlaceSearchInput').oninput = debounce(e=>render(e.target.value),150);
    $('addToTripBody').querySelectorAll('[data-quickadd]').forEach(b=>b.onclick=()=>{
      const p = placeById(b.dataset.quickadd);
      addPlaceToTrip(trip, plannerState.day, p);
      closeModal('modal-addToTrip');
    });
    hydratePhotos($('addToTripBody'));
  }
  render('');
  openModal('modal-addToTrip');
  setTimeout(()=>$('addPlaceSearchInput') && $('addPlaceSearchInput').focus(), 50);
}

function mapUnavailableHTML(){
  return `<div class="empty" style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:0">
    <div style="font-size:26px;margin-bottom:8px">🗺️</div>
    <div>Map couldn't load — you appear to be offline.</div>
    <div class="small" style="margin-top:4px">Everything else in TripFlow still works normally.</div>
  </div>`;
}

/* ---------------- Real Google Maps, embedded (no API key required) ---------------- */
// Google's keyless "output=embed" iframe is the same product as maps.google.com: real street
// data, satellite imagery, street view and native pan/zoom/search — no tile CDN, no API key.
function gmapsSearchEmbedUrl(query, zoom){
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}&z=${zoom||14}&output=embed`;
}
function gmapsCoordEmbedUrl(lat, lng, zoom){
  return `https://www.google.com/maps?q=${lat},${lng}&z=${zoom||14}&output=embed`;
}
function gmapsDirectionsEmbedUrl(stops){
  const pts = stops.map(s=>`${s.lat},${s.lng}`);
  const saddr = pts[0];
  const daddr = pts.slice(1).join('+to:');
  return `https://www.google.com/maps?saddr=${saddr}&daddr=${daddr}&output=embed`;
}
function gmapsExternalLink(query){
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
function renderPlannerMap(trip, day){
  try{ renderPlannerMapInner(trip, day); }
  catch(e){ $('map2').innerHTML = mapUnavailableHTML(); }
}
const GMAPS_MAX_WAYPOINTS = 10; // legacy keyless directions embed only plots up to ~10 stops
function renderPlannerMapInner(trip, day){
  const dest = destForTrip(trip);
  const stops = day.stops;
  let src, note = '';
  if(stops.length===0){
    src = gmapsCoordEmbedUrl(dest.lat, dest.lng, 13);
  } else if(stops.length===1){
    src = gmapsSearchEmbedUrl(stops[0].name+', '+dest.name, 15);
  } else {
    const routed = stops.length>GMAPS_MAX_WAYPOINTS ? stops.slice(0,GMAPS_MAX_WAYPOINTS) : stops;
    src = gmapsDirectionsEmbedUrl(routed);
    if(stops.length>GMAPS_MAX_WAYPOINTS) note = `Showing route for the first ${GMAPS_MAX_WAYPOINTS} of ${stops.length} stops.`;
  }
  $('map2').innerHTML = navigator.onLine===false ? mapUnavailableHTML()
    : `<iframe id="map2Frame" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen src="${src}"></iframe>`;
  window.__plannerMapDest = dest;
  const legends = [['attraction','Attractions','var(--cat-attraction)'],['restaurant','Restaurants','var(--cat-restaurant)'],['hotel','Hotels','var(--cat-hotel)']];
  $('mapLegend2').innerHTML = legends.map(([k,l,c])=>`<span class="legend"><span class="legendDot" style="background:${c}"></span>${l}</span>`).join('') + (note?`<span class="small" style="margin-left:auto">${esc(note)}</span>`:'');
}
function renderPlannerStats(trip, day){
  let dist=0; for(let i=0;i<day.stops.length-1;i++) dist += haversine(day.stops[i],day.stops[i+1]);
  $('distance2').textContent = dist.toFixed(1)+' km';
  $('stopsStat').textContent = day.stops.length;
  $('budgetStat2').textContent = fmt$(day.stops.reduce((a,s)=>a+(s.cost||0),0));
}

/* ---------------- Optimize route ---------------- */
function openOptimizeModal(trip, dayIdx){
  const day = trip.days[dayIdx];
  if(day.stops.length<3){ toast('Add at least 3 stops to this day before optimizing.'); return; }
  const before = day.stops.slice();
  const optimized = nearestNeighborOrder(before);
  const distBefore = totalDistance(before), distAfter = totalDistance(optimized);
  window.__optimizePending = {trip, dayIdx, optimized};
  $('optimizeBody').innerHTML = `
    <div class="sectionGrid" style="grid-template-columns:1fr 1fr">
      <div class="card"><h3>Before <span class="small">(${distBefore.toFixed(1)} km)</span></h3>${before.map((s,i)=>`<div class="small" style="margin:4px 0">${i+1}. ${esc(s.name)}</div>`).join('')}</div>
      <div class="card"><h3>After <span class="small">(${distAfter.toFixed(1)} km)</span></h3>${optimized.map((s,i)=>`<div class="small" style="margin:4px 0">${i+1}. ${esc(s.name)}</div>`).join('')}</div>
    </div>
    <p class="small" style="margin-top:12px;font-weight:600">${distAfter<distBefore-0.05 ? `✨ This saves about ${(distBefore-distAfter).toFixed(1)} km of travel today.` : 'Your current order is already close to optimal — small or no change.'}</p>`;
  openModal('modal-optimize');
}
function initOptimizeModal(){
  $('keepOriginalBtn').onclick = ()=>{ closeModal('modal-optimize'); toast('Kept your original order.'); };
  $('applyOptimizeBtn').onclick = ()=>{
    const p = window.__optimizePending;
    if(!p) return;
    p.trip.days[p.dayIdx].stops = p.optimized;
    recomputeDayTimes(p.trip.days[p.dayIdx]);
    logActivity(p.trip, `optimized the route for Day ${p.dayIdx+1}.`);
    saveState();
    closeModal('modal-optimize');
    toast('Route optimized!');
    if(plannerState.tripId===p.trip.id) renderPlannerItinerary(p.trip);
  };
}

/* ---------------- Budget tab ---------------- */
const EXPENSE_CATS = ['Flights','Hotels','Food','Activities','Transportation','Miscellaneous'];
const CAT_ICONS = {Flights:'✈️',Hotels:'🏨',Food:'🍜',Activities:'🎟️',Transportation:'🚇',Miscellaneous:'🛍️'};
function renderBudgetTab(trip){
  $('budgetStyleRow').innerHTML = ['budget','moderate','luxury'].map(s=>`<button class="styleBtn ${trip.budget.style===s?'active':''}" data-style="${s}">${s.charAt(0).toUpperCase()+s.slice(1)}</button>`).join('');
  $('budgetStyleRow').querySelectorAll('[data-style]').forEach(b=>b.onclick=()=>{
    trip.budget.style = b.dataset.style;
    const dest = destForTrip(trip);
    trip.budget.total = Math.round(dest.avgDailyBudget[b.dataset.style]*trip.days.length*trip.travelers);
    saveState();
    toast(`Budget style set to ${b.dataset.style} — suggested total is now ${fmt$(trip.budget.total)}.`);
    renderBudgetTab(trip);
  });

  const planned = tripPlannedTotal(trip);
  $('budgetTotal2').textContent = fmt$(trip.budget.total);
  $('budgetPlanned2').textContent = fmt$(planned);
  $('budgetRemaining2').textContent = fmt$(Math.max(0, trip.budget.total-planned));
  const pct = clamp(Math.round(planned/(trip.budget.total||1)*100),0,140);
  $('budgetBar2').style.width = Math.min(pct,100)+'%';
  $('budgetBar2').parentElement.classList.toggle('over', planned>trip.budget.total);
  $('budgetOverWarn').innerHTML = planned>trip.budget.total ? `<span style="color:var(--danger);font-weight:700">⚠ ${fmt$(planned-trip.budget.total)} over</span>` : `<span style="color:var(--green);font-weight:700">On track</span>`;
  $('editBudgetTotalBtn').onclick = ()=>{ $('budgetInput2').value = trip.budget.total; openModal('modal-editBudget'); };

  const cats = tripCategoryTotals(trip);
  const max = Math.max(1,...Object.values(cats));
  $('budgetCatList').innerHTML = Object.entries(cats).map(([k,v])=>`
    <div class="listRow" style="flex-direction:column;align-items:stretch;gap:6px">
      <div style="display:flex;justify-content:space-between"><span>${CAT_ICONS[k]} ${k}</span><strong>${fmt$(v)}</strong></div>
      <div class="catBar"><div class="bar"><div style="width:${Math.round(v/max*100)}%"></div></div></div>
    </div>`).join('');

  $('expenseList').innerHTML = trip.budget.expenses.length ? trip.budget.expenses.map(e=>`
    <div class="listRow"><div class="left"><span>${CAT_ICONS[e.cat]||'💵'}</span><div><div>${esc(e.desc)}</div><div class="small">${esc(e.cat)}</div></div></div>
    <div style="display:flex;align-items:center;gap:10px"><strong>${fmt$(e.amount)}</strong><button class="btn sm danger" data-rmexp="${e.id}">Remove</button></div></div>`).join('')
    : '<div class="empty">No manual expenses yet — itinerary stops are counted automatically above.</div>';
  $('expenseList').querySelectorAll('[data-rmexp]').forEach(b=>b.onclick=()=>{
    trip.budget.expenses = trip.budget.expenses.filter(e=>e.id!==b.dataset.rmexp);
    saveState(); renderBudgetTab(trip); toast('Expense removed.');
  });

  renderSplitPanel(trip);

  $('addExpenseBtn').onclick = ()=>{
    $('expenseModalTitle').textContent = 'Add expense';
    $('expenseDesc').value=''; $('expenseAmount').value='';
    $('expenseCat').innerHTML = EXPENSE_CATS.map(c=>`<option>${c}</option>`).join('');
    const names = trip.collaborators.map(c=>c.name);
    $('expensePaidBy').innerHTML = names.map(n=>`<option>${esc(n)}</option>`).join('');
    // Everyone is included by default — the common case is a shared cost, and unticking is
    // easier than remembering to tick.
    $('expenseSplit').innerHTML = names.map(n=>`<label class="splitChip"><input type="checkbox" data-split="${esc(n)}" checked> ${esc(n)}</label>`).join('');
    $('saveExpenseBtn').onclick = ()=>{
      const desc = $('expenseDesc').value.trim();
      const amount = Number($('expenseAmount').value);
      if(!desc || !amount){ toast('Enter a description and an amount.'); return; }
      const splitAmong = Array.from($('expenseSplit').querySelectorAll('[data-split]'))
        .filter(cb=>cb.checked).map(cb=>cb.dataset.split);
      trip.budget.expenses.push({
        id:uid('exp'), desc, cat:$('expenseCat').value, amount,
        paidBy: $('expensePaidBy').value,
        splitAmong,
      });
      saveState();
      closeModal('modal-expense');
      toast(splitAmong.length>1 ? `Expense added and split ${splitAmong.length} ways.` : 'Expense added.');
      renderBudgetTab(trip);
    };
    openModal('modal-expense');
  };
}
function initEditBudgetModal(){
  $('saveBudgetBtn2').onclick = ()=>{
    const t = getTrip(plannerState.tripId);
    if(!t) return;
    t.budget.total = Math.max(0, Number($('budgetInput2').value)||0);
    saveState();
    closeModal('modal-editBudget');
    toast('Budget updated.');
    renderBudgetTab(t);
  };
}

/* ---------------- Expense splitting ---------------- */
/** Net position per person: what they actually paid, minus their share of everything they were
 * included in. Only expenses that carry split information count — an expense logged before
 * splitting existed (or deliberately left unsplit) is still counted in the trip budget, it just
 * doesn't create a debt between people. */
function computeBalances(trip){
  const names = trip.collaborators.map(c=>c.name);
  const paid = {}, owed = {};
  names.forEach(n=>{ paid[n]=0; owed[n]=0; });
  let splitTotal = 0;
  trip.budget.expenses.forEach(e=>{
    if(!e.paidBy || !e.splitAmong || !e.splitAmong.length) return;
    const participants = e.splitAmong.filter(n=>names.includes(n));
    if(!participants.length) return;
    splitTotal += e.amount;
    if(paid[e.paidBy] !== undefined) paid[e.paidBy] += e.amount;
    const share = e.amount / participants.length;
    participants.forEach(n=>{ owed[n] += share; });
  });
  const rows = names.map(n=>({ name:n, paid:paid[n], share:owed[n], net: paid[n]-owed[n] }));
  return { rows, splitTotal };
}
/** Reduces the balances to the fewest transfers that clear them: repeatedly settle the largest
 * debtor against the largest creditor. Avoids telling four people to pay each other in a ring
 * when two transfers would do. */
function settlementPlan(rows){
  const EPS = 0.01;
  const debtors = rows.filter(r=>r.net < -EPS).map(r=>({name:r.name, amt:-r.net})).sort((a,b)=>b.amt-a.amt);
  const creditors = rows.filter(r=>r.net > EPS).map(r=>({name:r.name, amt:r.net})).sort((a,b)=>b.amt-a.amt);
  const transfers = [];
  let i=0, j=0;
  while(i<debtors.length && j<creditors.length){
    const amount = Math.min(debtors[i].amt, creditors[j].amt);
    if(amount > EPS) transfers.push({ from:debtors[i].name, to:creditors[j].name, amount });
    debtors[i].amt -= amount;
    creditors[j].amt -= amount;
    if(debtors[i].amt <= EPS) i++;
    if(creditors[j].amt <= EPS) j++;
  }
  return transfers;
}
function renderSplitPanel(trip){
  const el = $('splitPanel');
  if(!el) return;
  const { rows, splitTotal } = computeBalances(trip);
  if(!splitTotal){
    el.innerHTML = `<div class="empty">No shared expenses yet. Add an expense and mark who paid and who it's split between — balances and who-owes-who appear here automatically.</div>`;
    return;
  }
  const transfers = settlementPlan(rows);
  el.innerHTML = `
    <p class="small" style="margin:0 0 10px">${fmt$(splitTotal)} of shared spending across ${rows.length} ${rows.length===1?'person':'people'}.</p>
    <div class="list">
      ${rows.map(r=>{
        const cls = r.net > 0.01 ? 'pos' : (r.net < -0.01 ? 'neg' : '');
        const label = r.net > 0.01 ? `is owed ${fmt$(r.net)}` : (r.net < -0.01 ? `owes ${fmt$(-r.net)}` : 'settled up');
        return `<div class="listRow"><div class="left"><div class="avatar sm">${initialsOf(r.name)}</div>
          <div><div>${esc(r.name)}</div><div class="small">paid ${fmt$(r.paid)} · share ${fmt$(r.share)}</div></div></div>
          <span class="balanceTag ${cls}">${label}</span></div>`;
      }).join('')}
    </div>
    <div style="margin-top:14px">
      <div class="small" style="font-weight:800;margin-bottom:8px">Simplest way to settle up</div>
      ${transfers.length ? transfers.map(t=>`<div class="settleRow"><b>${esc(t.from)}</b> pays <b>${esc(t.to)}</b> <span class="settleAmt">${fmt$(t.amount)}</span></div>`).join('')
        : `<div class="small">Everyone's square — nothing to settle.</div>`}
    </div>`;
}

/* ---------------- Group polls ---------------- */
function tripPolls(trip){ return trip.polls || (trip.polls = []); }
function initPollModal(){
  $('createPollBtn').onclick = ()=>{
    const trip = getTrip(plannerState.tripId);
    if(!trip) return;
    const question = $('pollQuestion').value.trim();
    const opts = ['pollOpt1','pollOpt2','pollOpt3','pollOpt4'].map(id=>$(id).value.trim()).filter(Boolean);
    if(!question){ toast('Give the poll a question.'); return; }
    if(opts.length < 2){ toast('A poll needs at least two options.'); return; }
    tripPolls(trip).push({
      id: uid('poll'), question,
      options: opts.map(text=>({ id: uid('opt'), text, votes: [] })),
      ts: Date.now(),
    });
    logActivity(trip, `started a poll: "${question}".`);
    saveState();
    closeModal('modal-poll');
    toast('Poll created.');
    renderCollabTab(trip);
  };
}
function openPollModal(){
  ['pollQuestion','pollOpt1','pollOpt2','pollOpt3','pollOpt4'].forEach(id=>{ $(id).value=''; });
  openModal('modal-poll');
}
/** Votes are recorded per person by name. With no backend there's no separate login per
 * collaborator, so the "voting as" selector lets a group settle a choice on one screen and
 * still get an honest per-person tally, rather than a single anonymous counter. */
let pollVoterName = null;
function renderPollList(trip){
  const el = $('pollList');
  if(!el) return;
  const polls = tripPolls(trip);
  const names = trip.collaborators.map(c=>c.name);
  if(!pollVoterName || !names.includes(pollVoterName)) pollVoterName = names[0];
  if(!polls.length){
    el.innerHTML = `<div class="empty">No polls yet. Use one to settle a real choice — which day for the day trip, which restaurant to book, whether to add the museum.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="voterRow">
      <label class="small" style="font-weight:700">Voting as</label>
      <select id="pollVoterSelect">${names.map(n=>`<option ${n===pollVoterName?'selected':''}>${esc(n)}</option>`).join('')}</select>
    </div>
    ${polls.map(p=>{
      const total = p.options.reduce((a,o)=>a+o.votes.length,0);
      const maxVotes = Math.max(0, ...p.options.map(o=>o.votes.length));
      return `<div class="pollCard">
        <div class="pollHead">
          <h4>${esc(p.question)}</h4>
          <button class="btn sm danger" data-polldel="${p.id}"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div class="small" style="margin-bottom:9px">${total} vote${total===1?'':'s'}${total?'':' yet'}</div>
        ${p.options.map(o=>{
          const mine = o.votes.includes(pollVoterName);
          const pct = total ? Math.round(o.votes.length/total*100) : 0;
          const leading = total>0 && o.votes.length===maxVotes;
          return `<button class="pollOpt ${mine?'mine':''} ${leading?'leading':''}" data-vote="${p.id}::${o.id}">
            <div class="pollOptTop"><span>${esc(o.text)}${leading?' <span class="leadTag">leading</span>':''}</span><span class="pollCount">${o.votes.length}</span></div>
            <div class="pollBar"><div style="width:${pct}%"></div></div>
            ${o.votes.length?`<div class="small pollVoters">${o.votes.map(v=>esc(v)).join(', ')}</div>`:''}
          </button>`;
        }).join('')}
      </div>`;
    }).join('')}`;

  $('pollVoterSelect').onchange = e=>{ pollVoterName = e.target.value; renderPollList(trip); };
  el.querySelectorAll('[data-vote]').forEach(b=>b.onclick=()=>{
    const [pollId, optId] = b.dataset.vote.split('::');
    const poll = tripPolls(trip).find(p=>p.id===pollId);
    if(!poll) return;
    const already = poll.options.find(o=>o.votes.includes(pollVoterName));
    const target = poll.options.find(o=>o.id===optId);
    if(already === target){
      target.votes = target.votes.filter(v=>v!==pollVoterName); // clicking your own vote clears it
    } else {
      if(already) already.votes = already.votes.filter(v=>v!==pollVoterName); // one vote per person
      target.votes.push(pollVoterName);
    }
    saveState();
    renderPollList(trip);
  });
  el.querySelectorAll('[data-polldel]').forEach(b=>b.onclick=()=>{
    const id = b.dataset.polldel;
    const poll = tripPolls(trip).find(p=>p.id===id);
    confirmDialog('Delete this poll?', poll?`"${poll.question}" and its votes will be removed.`:'', ()=>{
      const list = tripPolls(trip);
      const index = list.findIndex(p=>p.id===id);
      const removed = snapshot(poll);
      trip.polls = list.filter(p=>p.id!==id);
      saveState(); renderPollList(trip);
      toastUndo('Poll deleted.', ()=>{ tripPolls(trip).splice(Math.max(0,index), 0, removed); });
    });
  });
}

/* ---------------- Collab tab ---------------- */
function renderCollabTab(trip){
  $('collabList').innerHTML = trip.collaborators.map(c=>`<div class="listRow"><div class="left"><div class="avatar sm">${c.initials}</div><div><div>${esc(c.name)}</div><div class="small">${esc(c.email)}</div></div></div><span class="small">${esc(c.role)}</span></div>`).join('');
  $('inviteBtn').onclick = ()=>openShareModal(trip.id);
  $('newPollBtn').onclick = openPollModal;
  renderPollList(trip);
  $('activityList').innerHTML = trip.activity.length ? trip.activity.map(a=>`<div class="listRow" style="align-items:flex-start"><div class="left"><div class="avatar sm">${initialsOf(a.author)}</div><div><div><b>${esc(a.author)}</b> ${esc(a.text)}</div><div class="small">${timeAgo(a.ts)}</div></div></div></div>`).join('') : '<div class="empty">No activity yet.</div>';
}

/* ============================================================
   AI ASSISTANT — rule-based intent engine + optional Gemini
============================================================ */
function initAI(){
  STATE.geminiKey = localStorage.getItem(LS_GEMINI) || '';
  $('aiLauncher').onclick = openAI;
  $('minAI').onclick = closeAI;
  $('closeAI').onclick = closeAI;
  $('sendAI').onclick = sendAI;
  $('aiText').addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendAI(); } });
  $('apiSetupBtn').onclick = ()=>{
    const key = prompt('Optional: paste a free Google Gemini API key (aistudio.google.com) for richer conversational answers. The assistant already works without one — this just adds open-ended Q&A. Leave blank to clear.', STATE.geminiKey||'');
    if(key!==null){ STATE.geminiKey = key.trim(); localStorage.setItem(LS_GEMINI, STATE.geminiKey); toast(STATE.geminiKey ? 'Gemini key saved.' : 'Gemini key cleared.'); }
  };
  renderAISuggestions();
  pushAIMessage('ai', `Hi! I'm your TripFlow AI assistant ✨. I can actually edit your itinerary — try "Make Day 2 more relaxed", "Optimize my route", or "What should I do in Tokyo for 3 days?"`);
}
function openAI(){ $('ai').classList.remove('hidden'); $('aiLauncher').style.display='none'; renderAISuggestions(); $('aiText').focus(); }
function closeAI(){ $('ai').classList.add('hidden'); $('aiLauncher').style.display='flex'; }
/** The AI assistant's quick-action chips change based on where the user currently is in the
 * app (destination page, itinerary, budget, or map view) so the suggestions are always
 * relevant to what's on screen, not a fixed generic list. */
function renderAISuggestions(){
  const parts = (location.hash||'#/').replace(/^#\/?/,'').split('/').filter(Boolean);
  const trip = getTrip(plannerState.tripId);
  let list;
  if(parts[0]==='destination'){
    const dest = resolveDestFromId(decodeURIComponent(parts[1]||'')) || findDestination(decodeURIComponent(parts[1]||''));
    const tab = parts[2]||'overview';
    if(tab==='map'){
      list = [`Find nearby attractions in ${dest.name}`, `Find restaurants near me in ${dest.name}`, `Optimize my locations in ${dest.name}`, `Plan my entire trip to ${dest.name}`];
    } else {
      list = [`Plan my entire trip to ${dest.name}`, `Best places for food in ${dest.name}`, `Find hidden gems in ${dest.name}`, `Instagrammable locations in ${dest.name}`];
    }
  } else if(trip && parts[0]==='trip'){
    const tab = parts[2]||'itinerary';
    if(tab==='budget'){
      list = ['Rebalance my budget', 'Find cheaper alternatives', 'Reduce my spending', 'Make this trip cheaper'];
    } else if(tab==='collab'){
      list = ['Add more nightlife to Day 1', 'Find romantic restaurants nearby', 'Find hidden gems for the group', 'Rearrange my itinerary to reduce travel time'];
    } else {
      list = [
        'Rearrange my itinerary to reduce travel time',
        'Make Day 1 more relaxed',
        `Add more nightlife to Day ${Math.min(2,trip.days.length)}`,
        'Find hidden gems',
      ];
    }
  } else {
    list = [
      'What should I do in Tokyo for 3 days?',
      'Build me a cheap itinerary',
      'Find romantic restaurants in Paris',
      'What can I do on a rainy day in Bangkok?',
    ];
  }
  $('aiSuggestions').innerHTML = list.map(s=>`<button class="suggestion">${esc(s)}</button>`).join('');
  $('aiSuggestions').querySelectorAll('.suggestion').forEach(b=>b.onclick=()=>{ $('aiText').value=b.textContent; sendAI(); });
}
function pushAIMessage(who, text){
  const msgs = $('messages');
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.innerHTML = esc(text).replace(/\n/g,'<br>');
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}
// Tries a short list of current/likely-available Gemini model ids in order, so a single
// model being renamed or retired doesn't silently break the whole integration. Returns
// {text} on success or {error} with a specific, user-visible reason on failure.
const GEMINI_MODEL_CANDIDATES = ['gemini-2.5-flash','gemini-2.0-flash','gemini-1.5-flash'];
async function callGemini(prompt, apiKey){
  let lastError = null;
  for(const model of GEMINI_MODEL_CANDIDATES){
    try{
      const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, 12000, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ contents:[{ parts:[{ text:prompt }]}] })
      });
      const data = await res.json().catch(()=>null);
      if(res.ok && data && data.candidates && data.candidates[0] && data.candidates[0].content){
        return { text: data.candidates[0].content.parts.map(p=>p.text||'').join('') };
      }
      if(data && data.error && data.error.message){
        lastError = data.error.message;
        // A "model not found" style error means try the next candidate; anything else
        // (bad key, quota, permission) will fail the same way for every model, so stop.
        if(!/not found|not supported|404/i.test(lastError)) break;
      } else {
        lastError = `HTTP ${res.status}`;
      }
    }catch(e){ lastError = e.name==='AbortError' ? 'request timed out' : (e.message || 'network error'); }
  }
  return { error: lastError };
}
async function sendAI(){
  const text = $('aiText').value.trim();
  if(!text) return;
  pushAIMessage('user', text);
  $('aiText').value = '';
  const typing = pushAIMessage('ai', '💭 Thinking…');
  const trip = getTrip(plannerState.tripId);
  const result = handleIntent(text, trip);
  if(result.handled){
    typing.innerHTML = esc(result.reply).replace(/\n/g,'<br>');
    renderAISuggestions();
    return;
  }
  if(STATE.geminiKey){
    const dest = trip ? destForTrip(trip) : null;
    const context = trip ? `The user is planning "${trip.title}" to ${dest.name}, ${trip.days.length} days, ${trip.budget.style} budget style, total budget ${fmt$(trip.budget.total)}.` : `The user hasn't opened a specific trip yet.`;
    const prompt = `You are TripFlow's travel planning assistant. ${context} Answer concisely with short, practical bullet points, using real place names when relevant. User: ${text}`;
    const gemini = await callGemini(prompt, STATE.geminiKey);
    if(gemini.text){
      typing.innerHTML = esc(gemini.text).replace(/\n/g,'<br>');
    } else {
      typing.innerHTML = esc(`Couldn't reach Gemini (${gemini.error || 'unknown error'}). Meanwhile: ` + result.reply);
    }
  } else {
    typing.innerHTML = esc(result.reply).replace(/\n/g,'<br>');
  }
  renderAISuggestions();
}

function guessDestFromText(t){
  // Matches any destination already known this session (curated or previously-searched
  // generic ones) — not just curated — since AI suggestion chips on a destination page embed
  // that exact destination's name. Prefers the longest/most-specific match to avoid a short
  // name accidentally matching inside an unrelated longer phrase.
  const matches = DESTINATIONS.filter(d=>d.name.length>2 && t.includes(d.name.toLowerCase()));
  matches.sort((a,b)=>b.name.length-a.name.length);
  return matches[0];
}
function adjustDayCount(trip, n){
  n = clamp(n,1,14);
  while(trip.days.length<n){
    addDayToTrip(trip);
    const used = new Set(trip.days.flatMap(d=>d.stops.map(s=>s.placeId)));
    const top = placesFor(trip.destId,'attraction').filter(p=>!used.has(p.id)).sort((a,b)=>b.rating-a.rating).slice(0,2);
    top.forEach(p=>addPlaceToTripSilent(trip, trip.days.length-1, p));
  }
  while(trip.days.length>n) trip.days.pop();
  trip.end = trip.days[trip.days.length-1].date;
  saveState();
}
function swapForCheaperAlternatives(trip, dayIdx, maxSwaps){
  const day = trip.days[dayIdx];
  if(!day) return [];
  const used = new Set(trip.days.flatMap(d=>d.stops.map(s=>s.placeId)));
  const sorted = day.stops.slice().sort((a,b)=>b.cost-a.cost);
  const changed = [];
  for(const s of sorted){
    if(changed.length>=maxSwaps) break;
    if(!s.cost) continue;
    const alt = PLACES.find(p=>p.destId===trip.destId && p.type===s.type && !used.has(p.id) && (p.price||0) < s.cost && (p.category===s.category || p.cuisine===s.category));
    if(alt){
      const idx = day.stops.findIndex(x=>x.id===s.id);
      day.stops[idx] = mkStopFromPlace(alt, s.time);
      used.add(alt.id);
      changed.push({from:s.name, to:alt.name});
    }
  }
  return changed;
}
function makeDayRelaxed(day){
  if(day.stops.length<=3) return [];
  const scored = day.stops.map(s=>{
    const place = placeById(s.placeId);
    return { s, relaxScore: (place && place.tags && place.tags.includes('relax')) ? 1 : 0 };
  });
  scored.sort((a,b)=>a.relaxScore-b.relaxScore);
  const toRemoveIds = scored.slice(0, day.stops.length-3).map(x=>x.s.id);
  const removedNames = day.stops.filter(s=>toRemoveIds.includes(s.id)).map(s=>s.name);
  day.stops = day.stops.filter(s=>!toRemoveIds.includes(s.id));
  return removedNames;
}

function handleIntent(text, trip){
  const t = text.toLowerCase().trim();
  const dest = trip ? destForTrip(trip) : null;

  // Accepts both word orders — "what should I do in Tokyo for 3 days" AND
  // "what should I do for 3 days in Tokyo" — plus a few common rephrasings ("what to do
  // in", "things to do in", "what can I do in") rather than one rigid fixed phrase.
  const dayM = t.match(/for (\d+)\s*days?/);
  const daysFromText = dayM ? parseInt(dayM[1],10) : null;
  const withoutDays = dayM ? t.slice(0,dayM.index).trim()+' '+t.slice(dayM.index+dayM[0].length).trim() : t;
  let m = withoutDays.match(/(?:what should i do|what to do|what can i do|things to do|plan (?:my |an? )?(?:entire )?trip)\s+(?:in|to|for) ([a-z\s,]+?)[.?!]?$/);
  if(m && m[1].trim().length>1){
    const name = m[1].trim();
    const days = daysFromText;
    const d = findDestination(name);
    if(!trip || trip.destId!==d.id){
      const nDays = days||4;
      const start = toDateInput(new Date(Date.now()+21*86400000));
      const newTrip = buildAutoTrip(d.id, `${d.name} Trip`, start, addDays(start,nDays-1), 2, 'moderate');
      STATE.trips.unshift(newTrip); saveState();
      navigate(`#/trip/${newTrip.id}`);
      return {handled:true, reply:`I put together a ${nDays}-day starter itinerary for ${d.name} — take a look! You can drag stops around, swap places, or ask me to adjust the pace.`};
    } else if(days){
      adjustDayCount(trip, days);
      if(plannerState.tripId===trip.id) renderPlannerView(trip.id, 'itinerary');
      return {handled:true, reply:`Updated "${trip.title}" to ${days} days and filled in top-rated picks for ${d.name}.`};
    }
  }

  if(/\bcheap(er)?\b|budget[- ]friendly|build me a cheap|reduce (my )?spending|rebalance( my)? budget|(make|save).*(trip|itinerary).*(cheap|money)/.test(t)){
    if(trip){
      trip.budget.style='budget';
      trip.budget.total = Math.round(dest.avgDailyBudget.budget*trip.days.length*trip.travelers);
      const changed = swapForCheaperAlternatives(trip, plannerState.day, 3);
      saveState();
      if(plannerState.tripId===trip.id) renderPlannerView(trip.id, location.hash.split('/')[3] || 'itinerary');
      return {handled:true, reply:`Switched "${trip.title}" to Budget style (~${fmt$(trip.budget.total)} total)${changed.length?` and swapped in ${changed.length} cheaper pick(s) for Day ${plannerState.day+1}`:''}.`};
    } else {
      const pool = DESTINATIONS.filter(d=>d.tags.includes('affordable'));
      const d = pool[Math.floor(Math.random()*pool.length)] || DESTINATIONS[0];
      const start = toDateInput(new Date(Date.now()+21*86400000));
      const newTrip = buildAutoTrip(d.id, `${d.name} on a Budget`, start, addDays(start,3), 2, 'budget');
      STATE.trips.unshift(newTrip); saveState();
      navigate(`#/trip/${newTrip.id}`);
      return {handled:true, reply:`I built a 4-day budget-friendly trip to ${d.name} (~${fmt$(newTrip.budget.total)} total). Open a specific destination first if you had somewhere else in mind!`};
    }
  }

  if(/romantic (restaurants?|dinner|dining)/.test(t) || /find romantic/.test(t)){
    const d = dest || guessDestFromText(t) || DESTINATIONS[0];
    const picks = placesFor(d.id,'restaurant').filter(p=>(p.tags||[]).includes('romantic')).sort((a,b)=>b.rating-a.rating).slice(0,3);
    const list = picks.length ? picks : placesFor(d.id,'restaurant').sort((a,b)=>b.rating-a.rating).slice(0,3);
    return {handled:true, reply:`Romantic dinner spots in ${d.name}:\n` + list.map(p=>`• ${p.name} (${p.cuisine}, ★${p.rating}) — ${p.desc}`).join('\n') + `\n\nTry "add ${list[0].name} to day 1" and I'll drop it into your itinerary.`};
  }

  if(/rainy day|it'?s raining|raining outside/.test(t)){
    const d = dest || guessDestFromText(t) || DESTINATIONS[0];
    const outdoorCats = ['Beach','Viewpoint','Hiking','Nature','Wine','Adventure'];
    const indoor = placesFor(d.id,'attraction').filter(p=>!outdoorCats.includes(p.category)).sort((a,b)=>b.rating-a.rating).slice(0,4);
    return {handled:true, reply:`Good indoor options in ${d.name} for a rainy day:\n` + indoor.map(p=>`• ${p.name} (${p.category})`).join('\n')};
  }

  if(/hidden gems?|off[- ]the[- ]beaten|lesser[- ]known|local favorites?/.test(t)){
    const d = dest || guessDestFromText(t) || DESTINATIONS[0];
    const picks = placesFor(d.id,'attraction').filter(p=>(p.tags||[]).includes('hidden')).sort((a,b)=>b.rating-a.rating).slice(0,4);
    const list = picks.length ? picks : placesFor(d.id,'attraction').sort((a,b)=>b.rating-a.rating).slice(0,4);
    return {handled:true, reply:`Hidden gems in ${d.name}:\n` + list.map(p=>`• ${p.name} — ${p.desc}`).join('\n') + `\n\nTry "add ${list[0].name} to day 1" and I'll drop it into your itinerary.`};
  }

  if(/instagrammable|photogenic|photo spots?|photography spots?/.test(t)){
    const d = dest || guessDestFromText(t) || DESTINATIONS[0];
    const picks = placesFor(d.id,'attraction').filter(p=>(p.tags||[]).includes('photography')).sort((a,b)=>b.rating-a.rating).slice(0,4);
    const list = picks.length ? picks : placesFor(d.id,'attraction').sort((a,b)=>b.rating-a.rating).slice(0,4);
    return {handled:true, reply:`Most photogenic spots in ${d.name}:\n` + list.map(p=>`• ${p.name} — ${p.desc}`).join('\n') + `\n\nTry "add ${list[0].name} to day 1" and I'll drop it into your itinerary.`};
  }

  if(/find (nearby )?attractions?/.test(t)){
    const d = dest || guessDestFromText(t) || DESTINATIONS[0];
    const list = placesFor(d.id,'attraction').sort((a,b)=>b.rating-a.rating).slice(0,5);
    return {handled:true, reply:`Top attractions in ${d.name}:\n` + list.map(p=>`• ${p.name} (★${p.rating}) — ${p.desc}`).join('\n')};
  }

  if(/find restaurants? (near me|nearby)/.test(t)){
    const d = dest || guessDestFromText(t) || DESTINATIONS[0];
    const list = placesFor(d.id,'restaurant').sort((a,b)=>b.rating-a.rating).slice(0,5);
    return {handled:true, reply:`Top restaurants in ${d.name}:\n` + list.map(p=>`• ${p.name} (${p.cuisine}, ★${p.rating})`).join('\n')};
  }

  if(/(optimize|reduce travel time|rearrange)/.test(t) && /(itinerary|trip|route|day)/.test(t) && trip){
    const day = trip.days[plannerState.day];
    if(day.stops.length<3) return {handled:true, reply:`Day ${plannerState.day+1} only has ${day.stops.length} stop(s) — add a couple more and I can optimize the route.`};
    const before = totalDistance(day.stops);
    day.stops = nearestNeighborOrder(day.stops);
    recomputeDayTimes(day);
    const after = totalDistance(day.stops);
    logActivity(trip, `AI optimized the route for Day ${plannerState.day+1}.`);
    saveState();
    if(plannerState.tripId===trip.id) renderPlannerItinerary(trip);
    return {handled:true, reply:`Reordered Day ${plannerState.day+1} — travel distance dropped from ${before.toFixed(1)} km to ${after.toFixed(1)} km.`};
  }

  m = t.match(/add (?:more )?nightlife to day (\d+)/);
  if(m && trip){
    const idx = parseInt(m[1],10)-1;
    if(idx<0||idx>=trip.days.length) return {handled:true, reply:`This trip only has ${trip.days.length} days.`};
    const used = new Set(trip.days.flatMap(d=>d.stops.map(s=>s.placeId)));
    const picks = PLACES.filter(p=>p.destId===trip.destId && !used.has(p.id) && (p.tags||[]).includes('nightlife')).sort((a,b)=>b.rating-a.rating).slice(0,2);
    if(!picks.length) return {handled:true, reply:`I couldn't find more unused nightlife spots in ${dest.name} for this trip.`};
    picks.forEach(p=>addPlaceToTripSilent(trip, idx, p));
    logActivity(trip, `AI added nightlife picks to Day ${idx+1}.`);
    saveState();
    if(plannerState.tripId===trip.id) renderPlannerItinerary(trip);
    return {handled:true, reply:`Added ${picks.map(p=>p.name).join(' and ')} to Day ${idx+1}.`};
  }

  if(/cheaper alternatives?|find cheaper/.test(t) && trip){
    const changed = swapForCheaperAlternatives(trip, plannerState.day, 2);
    saveState();
    if(plannerState.tripId===trip.id) renderPlannerItinerary(trip);
    return {handled:true, reply: changed.length ? `Swapped ${changed.map(c=>`${c.from} → ${c.to}`).join(', ')} on Day ${plannerState.day+1} for cheaper picks.` : `Day ${plannerState.day+1} is already pretty budget-friendly — nothing worth swapping.`};
  }

  m = t.match(/add (.+) to day (\d+)/);
  if(m && trip){
    const name = m[1].trim().toLowerCase();
    const idx = parseInt(m[2],10)-1;
    const p = PLACES.find(x=>x.destId===trip.destId && x.name.toLowerCase().includes(name));
    if(p && idx>=0 && idx<trip.days.length){
      addPlaceToTripSilent(trip, idx, p);
      logActivity(trip, `AI added ${p.name} to Day ${idx+1}.`);
      saveState();
      if(plannerState.tripId===trip.id) renderPlannerItinerary(trip);
      return {handled:true, reply:`Added ${p.name} to Day ${idx+1}.`};
    }
  }

  m = t.match(/make day (\d+) more relax/);
  if(m && trip){
    const idx = parseInt(m[1],10)-1;
    if(idx<0||idx>=trip.days.length) return {handled:true, reply:`This trip only has ${trip.days.length} days.`};
    const day = trip.days[idx];
    const removedNames = makeDayRelaxed(day);
    recomputeDayTimes(day);
    logActivity(trip, `AI made Day ${idx+1} more relaxed.`);
    saveState();
    if(plannerState.tripId===trip.id) renderPlannerItinerary(trip);
    return {handled:true, reply: removedNames.length ? `Lightened up Day ${idx+1} — removed ${removedNames.join(', ')} so you have more breathing room.` : `Day ${idx+1} is already relaxed with just ${day.stops.length} stops.`};
  }

  return {handled:false, reply: dest
    ? `${dest.name}'s best time to visit is ${dest.bestTime}, and the average daily budget is ${fmt$(dest.avgDailyBudget.moderate)}. Ask me to optimize your route, adjust a day, or find cheaper picks!`
    : `Try opening a destination or a trip first, or ask me things like "Build me a cheap itinerary", "Find romantic restaurants in Paris", or "What can I do on a rainy day in Bangkok?"`};
}

/* ============================================================
   INIT
============================================================ */
function init(){
  applyTheme();
  initTopbar();
  initHero();
  initSettingsModal();
  initSaveToAndCollectionModals();
  initNewTripModal();
  initEditTripModal();
  initOptimizeModal();
  initOrganizeAIModal();
  initBookingModal();
  initPollModal();
  initOnboarding();
  initEditBudgetModal();
  initCustomizeModal();
  initAI();
  renderNotifications();
  route();
  loadExchangeRates().then(()=>{ if(currentCurrencyCode()!=='USD') refreshCurrentView(); });
}
window.addEventListener('hashchange', route);
document.addEventListener('DOMContentLoaded', init);
