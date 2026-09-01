/* ============================================================
   TripFlow — application logic
============================================================ */
'use strict';

/* ---------------- utilities ---------------- */
const $ = id => document.getElementById(id);
const $$ = sel => Array.from(document.querySelectorAll(sel));
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'), 2600); }
let __uidN = 1;
function uid(prefix){ return `${prefix}_${Date.now().toString(36)}_${(__uidN++).toString(36)}`; }
function fmt$(n){ return '$'+Math.round(n||0).toLocaleString(); }
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

/* ---------------- persistence ---------------- */
const LS_KEY = 'tripflow_state_v1';
const LS_GEMINI = 'tripflow_gemini_key';

function defaultState(){
  return {
    theme:'system',
    settings:{ name:'Jie Wei', email:'jiewei190@gmail.com', currency:'USD ($)' },
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
    id: uid('trip'), destId, title, start, end, travelers, cover: dest.hero,
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
function tripsForDest(destId){ return STATE.trips.filter(t=>t.destId===destId); }
function getOrCreateDraftTrip(destId){
  let trip = tripsForDest(destId)[0];
  if(trip) return trip;
  const dest = DESTINATIONS.find(d=>d.id===destId);
  const start = toDateInput(new Date(Date.now()+30*86400000));
  const end = addDays(start,3);
  trip = {
    id: uid('trip'), destId, title:`${dest.name} Trip`, start, end, travelers:2, cover: dest.hero,
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
}

/* ---------------- router ---------------- */
function navigate(hash){
  if(location.hash === hash) route(); else location.hash = hash;
}
function showView(name){
  $$('.view').forEach(v=>v.classList.remove('active'));
  $('view-'+name).classList.add('active');
  const map = {home:'#/', discover:'#/discover', trips:'#/trips', saved:'#/saved', ideas:'#/ideas'};
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
  else if(parts[0]==='trip'){ showView('planner'); renderPlannerView(parts[1], parts[2]||'itinerary'); }
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

  $('searchToggle').onclick = (e)=>{ e.stopPropagation(); const p=$('gsearchPanel'); p.classList.toggle('show'); $('notifDropdown').classList.remove('show'); $('profileDropdown').classList.remove('show'); if(p.classList.contains('show')) $('globalSearchInput').focus(); };
  $('gsearchClose').onclick = ()=>$('gsearchPanel').classList.remove('show');
  $('globalSearchInput').addEventListener('input', debounce(e=>runGlobalSearch(e.target.value), 150));

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

function runGlobalSearch(q){
  const results = $('gsearchResults');
  q = (q||'').trim();
  if(!q){ results.innerHTML = '<div class="empty" style="padding:26px">Search for a city, attraction, restaurant or hotel.</div>'; return; }
  const ql = q.toLowerCase();
  const destMatches = DESTINATIONS.filter(d=> !d.id.startsWith('gen-') && (d.name.toLowerCase().includes(ql) || d.country.toLowerCase().includes(ql))).slice(0,4);
  const placeMatches = PLACES.filter(p=>p.name.toLowerCase().includes(ql)).slice(0,6);
  let html = '';
  if(destMatches.length){
    html += `<div class="gsearch-group">Destinations</div>`;
    destMatches.forEach(d=>{
      html += `<button class="gsearch-row" data-go="#/destination/${encodeURIComponent(d.id)}"><img src="${d.hero}" alt=""><div><div>${d.flag} ${esc(d.name)}, ${esc(d.country)}</div><div class="small">Explore destination</div></div></button>`;
    });
    const d0 = destMatches[0];
    html += `<button class="gsearch-row" data-go="#/destination/${encodeURIComponent(d0.id)}/hotels"><div class="ic">🏨</div><div>Hotels in ${esc(d0.name)}</div></button>`;
    html += `<button class="gsearch-row" data-go="#/destination/${encodeURIComponent(d0.id)}/restaurants"><div class="ic">🍜</div><div>Restaurants in ${esc(d0.name)}</div></button>`;
    html += `<button class="gsearch-row" data-go="#/destination/${encodeURIComponent(d0.id)}/things"><div class="ic">🎟️</div><div>Things to do in ${esc(d0.name)}</div></button>`;
  }
  if(placeMatches.length){
    html += `<div class="gsearch-group">Places</div>`;
    placeMatches.forEach(p=>{
      const tab = p.type==='attraction'?'things':(p.type==='restaurant'?'restaurants':'hotels');
      html += `<button class="gsearch-row" data-place="${p.id}"><img src="${p.image}" alt=""><div><div>${esc(p.name)}</div><div class="small">${esc(DESTINATIONS.find(d=>d.id===p.destId).name)} · ${tab==='things'?'Attraction':(tab==='restaurants'?'Restaurant':'Hotel')}</div></div></button>`;
    });
  }
  if(!destMatches.length && !placeMatches.length){
    html = `<div class="empty" style="padding:26px">No matches. Press Enter to explore "${esc(q)}" as a destination.</div>`;
  }
  results.innerHTML = html;
  results.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{ closeDropdowns(); navigate(b.dataset.go); });
  results.querySelectorAll('[data-place]').forEach(b=>b.onclick=()=>{ closeDropdowns(); openPlaceDetail(b.dataset.place); });
  $('globalSearchInput').onkeydown = (e)=>{ if(e.key==='Enter'){ const d=findDestination(q); closeDropdowns(); navigate(`#/destination/${encodeURIComponent(d.id)}`); } };
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
  $('settingsCurrency').value = STATE.settings.currency;
  $('themeToggle').checked = STATE.theme==='dark';
  openModal('modal-settings');
}
function initSettingsModal(){
  $('themeToggle').onchange = (e)=>{ STATE.theme = e.target.checked?'dark':'light'; applyTheme(); saveState(); };
  $('saveSettingsBtn').onclick = ()=>{
    STATE.settings.name = $('settingsName').value.trim() || STATE.settings.name;
    STATE.settings.currency = $('settingsCurrency').value;
    saveState();
    $('profileName').textContent = STATE.settings.name;
    const inits = initialsOf(STATE.settings.name);
    $$('.avatar#profileToggle, .profileHead .avatar').forEach(a=>a.textContent=inits);
    toast('Settings saved.');
    closeModal('modal-settings');
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
      <img src="${p.image}" alt="${esc(p.name)}" loading="lazy">
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
}
function viewPlaceOnMap(placeId){
  const p = placeById(placeId);
  if(!p) return;
  navigate(`#/destination/${encodeURIComponent(p.destId)}/map`);
  setTimeout(()=>{ if(window.__destMap){ window.__destMap.flyTo([p.lat,p.lng],15); const m=window.__destMarkerById[p.id]; if(m) m.openPopup(); } }, 260);
}

/* ---------------- place detail modal ---------------- */
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
    <div class="pdHero"><img src="${p.image}" alt=""></div>
    <div class="pdGrid">
      <div>
        <p>${esc(p.desc)}</p>
        <h3 style="margin-top:18px">Reviews</h3>
        ${reviews.map(r=>`<div class="pdReview"><div class="pdReviewHead"><span>${esc(r.name)}</span><span class="stars">${stars(r.rating)}</span></div><div class="small">${r.daysAgo} days ago</div><p style="margin:6px 0 0">${esc(r.text)}</p></div>`).join('')}
      </div>
      <div>
        <div class="destOverviewGrid" style="grid-template-columns:1fr;margin-top:0">${infoRows}</div>
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
    function renderDays(){
      const t = getTrip(select.value);
      $('atDayRow').innerHTML = t.days.map((d,i)=>`<button class="pill" data-day="${i}">Day ${i+1} · ${fmtDateShort(d.date)}</button>`).join('') +
        `<button class="pill" data-newday="1">＋ New day</button>`;
      $('atDayRow').querySelectorAll('[data-day]').forEach(btn=>btn.onclick=()=>{
        const t2 = getTrip(select.value);
        const dayIdx = Number(btn.dataset.day);
        addPlaceToTrip(t2, dayIdx, p);
        closeModal('modal-addToTrip');
        toast(`${p.name} added to Day ${dayIdx+1} of ${t2.title}.`);
      });
      $('atDayRow').querySelector('[data-newday]').onclick = ()=>{
        const t2 = getTrip(select.value);
        addDayToTrip(t2);
        renderDays();
      };
    }
    select.onchange = renderDays;
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
    <img src="${d.hero}" alt="${esc(d.name)}" loading="lazy">
    <div class="destCardBody"><h4>${d.flag} ${esc(d.name)}</h4><span>${esc(d.country)}</span></div>
  </button>`;
}
function wireDestCards(container){
  container.querySelectorAll('[data-dest]').forEach(b=>b.onclick=()=>navigate(`#/destination/${encodeURIComponent(b.dataset.dest)}`));
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
  let dest = DESTINATIONS.find(d=>d.id===idOrName);
  if(!dest) dest = findDestination(idOrName);
  if(destState.id !== dest.id){ destState = { id:dest.id, tab:tab, thingsFilters:{cat:'all',price:'any',rating:'any',sort:'rec'}, restFilters:{cuisine:'all',price:'any',rating:'any',open:false,dietary:new Set(),sort:'rec'}, hotelFilters:{price:'any',stars:'any',guest:'any',amenity:'all',sort:'rec'}, mapCats:new Set(['attraction','restaurant','hotel']) }; }
  destState.tab = tab || destState.tab || 'overview';

  $('destHero').innerHTML = `
    <img src="${dest.hero}" alt="${esc(dest.name)}">
    <div class="destHeroActions">
      <button class="btn" id="destSaveBtn"><i class="fa-solid fa-heart"></i> Save destination</button>
    </div>
    <div class="destHeroBody">
      <div class="flag">${dest.flag} ${esc(dest.country||'')}</div>
      <h1>${esc(dest.name)}</h1>
      <p>${esc(dest.tagline)}</p>
    </div>`;
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
  body.innerHTML = `
    <p style="max-width:760px;color:var(--muted);font-size:15px;line-height:1.6">${esc(dest.description)}</p>
    <div class="destOverviewGrid">
      <div class="ovCard"><div class="k">🌤 Weather</div><div class="v">${esc(dest.weather)}</div></div>
      <div class="ovCard"><div class="k">📅 Best time to visit</div><div class="v">${esc(dest.bestTime)}</div></div>
      <div class="ovCard"><div class="k">💱 Currency</div><div class="v">${esc(dest.currency)}</div></div>
      <div class="ovCard"><div class="k">🗣 Language</div><div class="v">${esc(dest.language)}</div></div>
    </div>
    <div class="card" style="margin-top:8px">
      <h3>Average daily budget</h3>
      <div class="sectionGrid" style="grid-template-columns:repeat(3,1fr)">
        <div class="ovCard"><div class="k">Budget</div><div class="v" style="font-size:20px">${fmt$(dest.avgDailyBudget.budget)}<span class="small">/day</span></div></div>
        <div class="ovCard"><div class="k">Moderate</div><div class="v" style="font-size:20px">${fmt$(dest.avgDailyBudget.moderate)}<span class="small">/day</span></div></div>
        <div class="ovCard"><div class="k">Luxury</div><div class="v" style="font-size:20px">${fmt$(dest.avgDailyBudget.luxury)}<span class="small">/day</span></div></div>
      </div>
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
  const ideas = generateAllIdeas(dest.id).slice(0,2);
  $('ovIdeaPreview').innerHTML = ideas.map(idea=>ideaCardHTML(idea)).join('');
  wireIdeaCards($('ovIdeaPreview'));
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
    <div class="placeGrid" id="thingsGrid"></div>`;
  $('tCat').value=f.cat; $('tPrice').value=f.price; $('tRating').value=f.rating; $('tSort').value=f.sort;
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
    <div class="placeGrid" id="restGrid"></div>`;
  $('rCuisine').value=f.cuisine; $('rPrice').value=f.price; $('rRating').value=f.rating; $('rSort').value=f.sort;
  $('rOpen').classList.toggle('active', f.open);
  $('rDietary').querySelectorAll('[data-diet]').forEach(b=>b.classList.toggle('active', f.dietary.has(b.dataset.diet)));
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
function renderDestHotels(dest, body){
  const all = placesFor(dest.id,'hotel');
  const amenitiesAll = [...new Set(all.flatMap(p=>p.amenities||[]))];
  const f = destState.hotelFilters;
  body.innerHTML = `
    <div class="filterBar">
      <div class="filterGroup"><label>Price / night</label><select id="hPrice"><option value="any">Any price</option><option value="0-100">Under $100</option><option value="100-250">$100–250</option><option value="250-500">$250–500</option><option value="500-99999">$500+</option></select></div>
      <div class="filterGroup"><label>Star rating</label><select id="hStars"><option value="any">Any stars</option><option value="5">5 star</option><option value="4">4 star</option><option value="3">3 star</option><option value="2">2 star &amp; under</option></select></div>
      <div class="filterGroup"><label>Guest rating</label><select id="hGuest"><option value="any">Any rating</option><option value="9">9.0+ Exceptional</option><option value="8">8.0+ Very good</option></select></div>
      <div class="filterGroup"><label>Amenity</label><select id="hAmenity"><option value="all">Any amenity</option>${amenitiesAll.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join('')}</select></div>
      <div class="filterGroup"><label>Sort</label><select id="hSort"><option value="rec">Recommended</option><option value="price_low">Lowest price</option><option value="rating">Highest rated</option><option value="distance">Distance from center</option></select></div>
    </div>
    <div class="placeGrid" id="hotelGrid"></div>`;
  $('hPrice').value=f.price; $('hStars').value=f.stars; $('hGuest').value=f.guest; $('hAmenity').value=f.amenity; $('hSort').value=f.sort;
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

/* ---------------- Map tab (destination discovery map) ---------------- */
window.__destMarkerById = {};
function renderDestMap(dest, body){
  body.innerHTML = `
    <div class="panel mapPanel" style="min-height:600px">
      <div class="panelHead"><h3>Explore ${esc(dest.name)} on the map</h3><div class="rowgap"><button class="btn sm" id="destMapCenter"><i class="fa-solid fa-crosshairs"></i> Center</button></div></div>
      <div class="mapLegend" id="destMapLegend"></div>
      <div class="map" id="destMap" style="min-height:520px"></div>
    </div>`;
  const legends = [['attraction','Attractions','var(--cat-attraction)'],['restaurant','Restaurants','var(--cat-restaurant)'],['hotel','Hotels','var(--cat-hotel)']];
  $('destMapLegend').innerHTML = legends.map(([k,l,c])=>`<button class="legend ${destState.mapCats.has(k)?'active':''}" data-cat="${k}"><span class="legendDot" style="background:${c}"></span>${l}</button>`).join('');
  if(typeof L === 'undefined'){ $('destMap').innerHTML = mapUnavailableHTML(); return; }
  let map;
  try{ map = L.map('destMap',{zoomControl:true}).setView([dest.lat,dest.lng],13); }
  catch(e){ $('destMap').innerHTML = mapUnavailableHTML(); return; }
  window.__destMap = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
  window.__destMarkerById = {};
  function draw(){
    Object.values(window.__destMarkerById).forEach(m=>map.removeLayer(m));
    window.__destMarkerById = {};
    const list = PLACES.filter(p=>p.destId===dest.id && destState.mapCats.has(p.type));
    list.forEach(p=>{
      const icon = L.divIcon({className:'custom-map-pin', html:`<span>${catEmoji(p.type)}</span>`, iconSize:[28,28], iconAnchor:[14,28]});
      const marker = L.marker([p.lat,p.lng],{icon}).addTo(map);
      marker.getElement && setTimeout(()=>{ const el = marker.getElement(); if(el) el.querySelector('.custom-map-pin').style.background = catColor(p.type); },0);
      const popupEl = document.createElement('div');
      popupEl.className='mapPopup';
      popupEl.innerHTML = `<img src="${p.image}"><h4>${esc(p.name)}</h4><p>${p.rating?('★ '+p.rating+' · '):''}${esc(p.area)}</p><button class="btn primary sm" data-popadd="${p.id}">＋ Add to Trip</button>`;
      marker.bindPopup(popupEl);
      marker.on('popupopen', ()=>{ popupEl.querySelector('[data-popadd]').onclick=()=>openAddToTrip(p.id); });
      window.__destMarkerById[p.id] = marker;
    });
  }
  draw();
  $('destMapLegend').querySelectorAll('[data-cat]').forEach(b=>b.onclick=()=>{
    const k=b.dataset.cat;
    destState.mapCats.has(k)? destState.mapCats.delete(k) : destState.mapCats.add(k);
    b.classList.toggle('active');
    draw();
  });
  $('destMapCenter').onclick = ()=>map.setView([dest.lat,dest.lng],13);
  setTimeout(()=>map.invalidateSize(),150);
}

/* ---------------- Trip Ideas tab ---------------- */
function renderDestIdeas(dest, body){
  body.innerHTML = `<div id="destIdeasGrid" class="ideaCardGrid"></div>`;
  const ideas = generateAllIdeas(dest.id);
  $('destIdeasGrid').innerHTML = ideas.map(idea=>ideaCardHTML(idea)).join('');
  wireIdeaCards($('destIdeasGrid'));
}

/* ============================================================
   AI TRIP IDEA GENERATOR
============================================================ */
const IDEA_STORE = {};
const IDEA_DEFAULT_DAYS = {food:3, culture:4, nightlife:2, shopping:2, relax:3};
function generateIdea(destId, archetype, overrides){
  const id = `${destId}-idea-${archetype.key}`;
  if(IDEA_STORE[id] && !overrides) return IDEA_STORE[id];
  const dest = DESTINATIONS.find(d=>d.id===destId);
  const days = (overrides && overrides.days) || (IDEA_STORE[id]?.days) || IDEA_DEFAULT_DAYS[archetype.key] || 3;
  const budgetStyle = (overrides && overrides.budgetStyle) || (IDEA_STORE[id]?.budgetStyle) || 'moderate';
  const pace = (overrides && overrides.pace) || (IDEA_STORE[id]?.pace) || 'Balanced';
  const interests = (overrides && overrides.interests) || archetype.tags.slice();
  let pool = PLACES.filter(p=>p.destId===destId && (p.type==='attraction'||p.type==='restaurant') && (p.tags||[]).some(t=>interests.includes(t)));
  if(pool.length<4) pool = placesFor(destId,'attraction').concat(placesFor(destId,'restaurant').slice(0,2));
  const priceOk = p=>{
    const lvl = p.priceLevel||0;
    if(budgetStyle==='budget') return lvl<=2;
    return true;
  };
  let list = pool.filter(priceOk).sort((a,b)=>b.rating-a.rating);
  if(list.length<4) list = pool.slice().sort((a,b)=>b.rating-a.rating);
  list = list.slice(0, Math.max(5, days*2));
  const idea = { id, destId, key:archetype.key, emoji:archetype.emoji,
    title: archetype.titleTpl.replace('{city}', dest.name),
    desc: archetype.descTpl.replace(/{city}/g, dest.name),
    days, budgetStyle, pace, interests, places:list };
  IDEA_STORE[id] = idea;
  return idea;
}
function generateAllIdeas(destId){ return TRIP_ARCHETYPES.map(a=>generateIdea(destId,a)); }

function ideaCardHTML(idea){
  const dest = DESTINATIONS.find(d=>d.id===idea.destId);
  const imgs = idea.places.slice(0,3).map(p=>p.image);
  while(imgs.length<3) imgs.push(dest.hero);
  const budgetLabel = idea.budgetStyle.charAt(0).toUpperCase()+idea.budgetStyle.slice(1);
  return `<div class="ideaCard" data-idea="${idea.id}">
    <div class="ideaCoverRow">${imgs.map(i=>`<img src="${i}" alt="" loading="lazy">`).join('')}</div>
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
}

function distributeIntoDays(places, nDays){
  const attractions = places.filter(p=>p.type==='attraction');
  const restaurants = places.filter(p=>p.type==='restaurant');
  const buckets = Array.from({length:nDays},()=>({attrs:[],rests:[]}));
  attractions.forEach((p,i)=>buckets[i%nDays].attrs.push(p));
  restaurants.forEach((p,i)=>buckets[i%nDays].rests.push(p));
  return buckets.map(b=>{
    const half = Math.ceil(b.attrs.length/2);
    const ordered = [...b.attrs.slice(0,half), ...b.rests, ...b.attrs.slice(half)];
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
              <div class="num ${place.type}">${catEmoji(place.type)}</div>
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
    id: uid('trip'), destId: dest.id, title: idea.title, start, end: addDays(start, idea.days-1), travelers,
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
    generateIdea(idea.destId, archetype, overrides);
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
    const dest = DESTINATIONS.find(d=>d.id===destIdParam) || findDestination(destIdParam);
    $('ideasDestInput').value = `${dest.name}, ${dest.country}`.replace(/, $/, '');
    const ideas = generateAllIdeas(dest.id);
    $('ideasGrid').innerHTML = ideas.map(idea=>ideaCardHTML(idea)).join('');
    wireIdeaCards($('ideasGrid'));
  } else {
    $('ideasGrid').innerHTML = '<div class="empty" style="grid-column:1/-1">Search a destination above to generate 5 themed trip ideas — food, culture, nightlife, shopping and relaxation.</div>';
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
  const dest = DESTINATIONS.find(d=>d.id===t.destId);
  const planned = tripPlannedTotal(t);
  const pct = clamp(Math.round(planned/(t.budget.total||1)*100),0,140);
  const over = planned>t.budget.total;
  return `<div class="tripCard2" data-trip="${t.id}">
    <div class="tripCoverWrap"><img src="${t.cover||dest.hero}" alt=""><span class="badge2">${dest.flag} ${esc(dest.name)}</span></div>
    <div class="tripCardBody">
      <h3>${esc(t.title)}</h3>
      <div class="tripMetaRow"><span>📅 ${fmtDateShort(t.start)} – ${fmtDateShort(t.end)}</span><span>${t.days.length} days</span></div>
      <div class="small">${tripStopCount(t)} activities · ${t.travelers} travelers</div>
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
    confirmDialog('Delete this trip?', `"${t.title}" and its itinerary will be permanently deleted.`, ()=>{
      STATE.trips = STATE.trips.filter(x=>x.id!==t.id);
      saveState();
      toast('Trip deleted.');
      renderTripsView();
    });
  });
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
      return `<div class="placeCard"><div class="placeImgWrap"><img src="${p.hero}" alt=""><span class="placeCatBadge">Destination</span></div><div class="placeBody"><h4>${p.flag} ${esc(p.name)}</h4><p class="placeDesc">${esc(p.tagline)}</p><div class="placeFoot"><button class="btn primary block" data-godest="${p.id}">Explore</button><button class="btn" data-unsavedest="${p.id}">Remove</button></div></div></div>`;
    }
    return placeCardHTML(p,{showDest:true});
  }).join('');
  grid.querySelectorAll('[data-godest]').forEach(b=>b.onclick=()=>navigate(`#/destination/${encodeURIComponent(b.dataset.godest)}`));
  grid.querySelectorAll('[data-unsavedest]').forEach(b=>b.onclick=()=>{ active.placeIds = active.placeIds.filter(id=>id!=='dest:'+b.dataset.unsavedest); saveState(); renderSavedView(active.id); });
  wirePlaceCards(grid);
}

/* ============================================================
   TRIP PLANNER
============================================================ */
let plannerState = { tripId:null, day:0 };
let __plannerMap=null, __plannerMarkers=[], __plannerRoute=null;

function renderPlannerView(tripId, ptab){
  const trip = getTrip(tripId);
  if(!trip){ navigate('#/trips'); return; }
  if(plannerState.tripId !== tripId) plannerState = { tripId, day:0 };
  const dest = DESTINATIONS.find(d=>d.id===trip.destId);

  $('plannerEyebrow').textContent = `${dest.flag} ${dest.name} trip workspace`;
  $('plannerTitle').textContent = trip.title;
  $('plannerSub').textContent = `${fmtDateFull(trip.start)} – ${fmtDateFull(trip.end)} · ${trip.days.length} days · ${trip.travelers} travelers`;
  renderCollabStack(trip);

  $$('.ptab').forEach(b=>{ b.classList.toggle('active', b.dataset.ptab===(ptab||'itinerary')); b.onclick=()=>navigate(`#/trip/${trip.id}/${b.dataset.ptab}`); });
  $$('.ptabBody').forEach(b=>b.classList.remove('active'));
  $('ptab-'+(ptab||'itinerary')).classList.add('active');

  $('shareTripBtn').onclick = ()=>openShareModal(trip.id);
  $('optimizeBtn').onclick = ()=>openOptimizeModal(trip, plannerState.day);
  $('aiRegenBtn').onclick = ()=>{ openAI(); $('aiContextLabel').textContent = `Working on: ${trip.title}`; };
  $('addDayBtn').onclick = ()=>{ addDayToTrip(trip); plannerState.day = trip.days.length-1; renderPlannerItinerary(trip); };
  $('addStopBtn2').onclick = ()=>openAddPlaceSearch(trip);
  $('centerBtn2').onclick = ()=>{ if(__plannerMap) __plannerMap.setView([dest.lat,dest.lng],13); };
  $('mapSearchToggle').onclick = ()=>$('mapSearchBar').classList.toggle('hidden');
  $('mapSearchGo').onclick = ()=>plannerMapSearch(trip);
  $('mapSearchInput').onkeydown = e=>{ if(e.key==='Enter') plannerMapSearch(trip); };

  if(ptab==='budget') renderBudgetTab(trip);
  else if(ptab==='collab') renderCollabTab(trip);
  else renderPlannerItinerary(trip);
}
function renderCollabStack(trip){ $('collabStack').innerHTML = trip.collaborators.map(c=>`<div class="avatar sm" title="${esc(c.name)}">${c.initials}</div>`).join(''); }
function plannerMapSearch(trip){
  const q = $('mapSearchInput').value.trim().toLowerCase();
  if(!q || !__plannerMap) return;
  const match = PLACES.find(p=>p.destId===trip.destId && p.name.toLowerCase().includes(q));
  if(match){ __plannerMap.flyTo([match.lat,match.lng],15); toast(`Found "${match.name}" — use "Add place" to add it to this day.`); }
  else toast('No matching place found in this destination.');
}

function renderPlannerItinerary(trip){
  plannerState.day = clamp(plannerState.day, 0, trip.days.length-1);
  $('dayTabs2').innerHTML = trip.days.map((d,i)=>`<button class="dayTab ${i===plannerState.day?'active':''}" data-day="${i}">Day ${i+1}${trip.days.length>1?` <span class="rmDay" data-rmday="${i}">✕</span>`:''}</button>`).join('');
  $('dayTabs2').querySelectorAll('.dayTab').forEach(b=>b.onclick=(e)=>{ if(e.target.closest('[data-rmday]')) return; plannerState.day=Number(b.dataset.day); renderPlannerItinerary(trip); });
  $('dayTabs2').querySelectorAll('[data-rmday]').forEach(b=>b.onclick=(e)=>{
    e.stopPropagation();
    const idx = Number(b.dataset.rmday);
    confirmDialog('Remove this day?', `Day ${idx+1} and its stops will be removed from the trip.`, ()=>{
      trip.days.splice(idx,1);
      trip.days.forEach((d,i)=>d.date=addDays(trip.start,i));
      trip.end = trip.days[trip.days.length-1].date;
      plannerState.day = clamp(plannerState.day,0,trip.days.length-1);
      saveState();
      renderPlannerView(trip.id,'itinerary');
    });
  });

  const day = trip.days[plannerState.day];
  $('dayToolbar').innerHTML = `<label class="small" style="font-weight:700">Date</label><input type="date" id="dayDateInput" value="${day.date}"><span class="small">${day.stops.length} stop${day.stops.length===1?'':'s'} · drag cards to reorder</span>`;
  $('dayDateInput').onchange = (e)=>{ day.date = e.target.value; saveState(); toast('Day date updated.'); };

  renderTimeline(trip, day);
  renderPlannerMap(trip, day);
  renderPlannerStats(trip, day);
}

function stopHTML(s, i, total){
  const showTransit = i < total-1;
  return `
  <div class="stop" draggable="true" data-idx="${i}" data-stopid="${s.id}">
    <div class="stopTop">
      <div class="num ${s.type}">${catEmoji(s.type)}</div>
      <div class="stopBody">
        <h4>${i+1}. ${esc(s.name)}</h4>
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
  el.innerHTML = day.stops.map((s,i)=>stopHTML(s,i,day.stops.length)).join('');
  wireStopEvents(trip, day);
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
    const removed = day.stops[idx];
    day.stops.splice(idx,1);
    logActivity(trip, `removed ${removed.name} from Day ${plannerState.day+1}.`);
    saveState();
    renderPlannerItinerary(trip);
    toast(`Removed ${removed.name}.`);
  });
  el.querySelectorAll('[data-transitmode]').forEach(sel=>sel.onchange=()=>{
    const s = day.stops.find(x=>x.id===sel.dataset.transitmode);
    s.transitToNext.mode = sel.value;
    s.transitToNext.mins = {Walk:15,Taxi:8,Transit:12,Drive:6}[sel.value];
    saveState(); renderTimeline(trip, day);
  });
}
function openAddPlaceSearch(trip){
  const dest = DESTINATIONS.find(d=>d.id===trip.destId);
  $('addToTripSub').textContent = `Search places in ${dest.name} to add to Day ${plannerState.day+1}`;
  const usedIds = new Set(trip.days.flatMap(d=>d.stops.map(s=>s.placeId)));
  function render(q){
    let arr = PLACES.filter(p=>p.destId===dest.id && !usedIds.has(p.id));
    if(q) arr = arr.filter(p=>p.name.toLowerCase().includes(q.toLowerCase()));
    arr = arr.slice().sort((a,b)=>(b.rating||b.guestRating||0)-(a.rating||a.guestRating||0)).slice(0,25);
    $('addToTripBody').innerHTML = `
      <input id="addPlaceSearchInput" placeholder="Search attractions, restaurants, hotels…" style="width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:12px;font-weight:600;background:var(--surface2);color:var(--ink)" value="${esc(q||'')}">
      <div class="list" style="max-height:360px;overflow:auto">
        ${arr.length? arr.map(p=>`<div class="listRow"><div class="left"><img src="${p.image}" style="width:38px;height:38px;border-radius:8px;object-fit:cover;flex-shrink:0"><div><div>${esc(p.name)}</div><div class="small">${catEmoji(p.type)} ${esc(p.category||p.cuisine||'Hotel')} · ★ ${p.rating||p.guestRating}</div></div></div><button class="btn primary sm" data-quickadd="${p.id}">＋ Add</button></div>`).join('') : '<div class="empty">No matching places.</div>'}
      </div>`;
    $('addPlaceSearchInput').oninput = debounce(e=>render(e.target.value),150);
    $('addToTripBody').querySelectorAll('[data-quickadd]').forEach(b=>b.onclick=()=>{
      const p = placeById(b.dataset.quickadd);
      addPlaceToTrip(trip, plannerState.day, p);
      closeModal('modal-addToTrip');
    });
  }
  render('');
  openModal('modal-addToTrip');
  setTimeout(()=>$('addPlaceSearchInput') && $('addPlaceSearchInput').focus(), 50);
}

function mapUnavailableHTML(){
  return `<div class="empty" style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:0">
    <div style="font-size:26px;margin-bottom:8px">🗺️</div>
    <div>Map couldn't load (offline or blocked resource).</div>
    <div class="small" style="margin-top:4px">Everything else in TripFlow still works normally.</div>
  </div>`;
}
function renderPlannerMap(trip, day){
  if(typeof L === 'undefined'){ $('map2').innerHTML = mapUnavailableHTML(); renderPlannerStatsMapFallback(); return; }
  try{ renderPlannerMapInner(trip, day); }
  catch(e){ $('map2').innerHTML = mapUnavailableHTML(); }
}
function renderPlannerStatsMapFallback(){ $('mapLegend2').innerHTML=''; }
function renderPlannerMapInner(trip, day){
  const dest = DESTINATIONS.find(d=>d.id===trip.destId);
  if(!__plannerMap){
    __plannerMap = L.map('map2',{zoomControl:true}).setView([dest.lat,dest.lng],13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(__plannerMap);
  } else {
    __plannerMap.setView([dest.lat,dest.lng], __plannerMap.getZoom());
  }
  __plannerMarkers.forEach(m=>__plannerMap.removeLayer(m));
  __plannerMarkers = [];
  if(__plannerRoute){ __plannerMap.removeLayer(__plannerRoute); __plannerRoute=null; }
  day.stops.forEach((s,i)=>{
    const icon = L.divIcon({className:'custom-map-pin', html:`<span>${i+1}</span>`, iconSize:[28,28], iconAnchor:[14,28]});
    const marker = L.marker([s.lat,s.lng],{icon}).addTo(__plannerMap);
    setTimeout(()=>{ const elm=marker.getElement(); if(elm){ const pin=elm.querySelector('.custom-map-pin'); if(pin) pin.style.background=catColor(s.type); } },0);
    const popupEl = document.createElement('div');
    popupEl.className='mapPopup';
    popupEl.innerHTML = `<img src="${s.image}"><h4>${i+1}. ${esc(s.name)}</h4><p>${fmtTime12(s.time)} · ${esc(s.area||'')}${s.rating?` · ★ ${s.rating}`:''}</p>`;
    marker.bindPopup(popupEl);
    __plannerMarkers.push(marker);
  });
  if(day.stops.length>1){
    __plannerRoute = L.polyline(day.stops.map(s=>[s.lat,s.lng]), {color:'#11795c', weight:4, opacity:.85, dashArray:'6,8'}).addTo(__plannerMap);
    __plannerMap.fitBounds(__plannerRoute.getBounds().pad(0.25));
  } else if(day.stops.length===1){
    __plannerMap.setView([day.stops[0].lat, day.stops[0].lng], 14);
  } else {
    __plannerMap.setView([dest.lat,dest.lng],13);
  }
  setTimeout(()=>__plannerMap.invalidateSize(),150);
  const legends = [['attraction','Attractions','var(--cat-attraction)'],['restaurant','Restaurants','var(--cat-restaurant)'],['hotel','Hotels','var(--cat-hotel)']];
  $('mapLegend2').innerHTML = legends.map(([k,l,c])=>`<span class="legend"><span class="legendDot" style="background:${c}"></span>${l}</span>`).join('');
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
    const dest = DESTINATIONS.find(d=>d.id===trip.destId);
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

  $('addExpenseBtn').onclick = ()=>{
    $('expenseModalTitle').textContent = 'Add expense';
    $('expenseDesc').value=''; $('expenseAmount').value='';
    $('expenseCat').innerHTML = EXPENSE_CATS.map(c=>`<option>${c}</option>`).join('');
    $('saveExpenseBtn').onclick = ()=>{
      const desc = $('expenseDesc').value.trim();
      const amount = Number($('expenseAmount').value);
      if(!desc || !amount){ toast('Enter a description and an amount.'); return; }
      trip.budget.expenses.push({id:uid('exp'), desc, cat:$('expenseCat').value, amount});
      saveState();
      closeModal('modal-expense');
      toast('Expense added.');
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

/* ---------------- Collab tab ---------------- */
function renderCollabTab(trip){
  $('collabList').innerHTML = trip.collaborators.map(c=>`<div class="listRow"><div class="left"><div class="avatar sm">${c.initials}</div><div><div>${esc(c.name)}</div><div class="small">${esc(c.email)}</div></div></div><span class="small">${esc(c.role)}</span></div>`).join('');
  $('inviteBtn').onclick = ()=>openShareModal(trip.id);
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
function renderAISuggestions(){
  const trip = getTrip(plannerState.tripId);
  const list = trip ? [
    'Rearrange my itinerary to reduce travel time',
    'Make Day 2 more relaxed',
    `Add more nightlife to Day ${Math.min(2,trip.days.length)}`,
    'Find cheaper alternatives',
  ] : [
    'What should I do in Tokyo for 3 days?',
    'Build me a cheap itinerary',
    'Find romantic restaurants in Paris',
    'What can I do on a rainy day in Bangkok?',
  ];
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
    try{
      const dest = trip ? DESTINATIONS.find(d=>d.id===trip.destId) : null;
      const context = trip ? `The user is planning "${trip.title}" to ${dest.name}, ${trip.days.length} days, ${trip.budget.style} budget style, total budget ${fmt$(trip.budget.total)}.` : `The user hasn't opened a specific trip yet.`;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${STATE.geminiKey}`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ contents:[{ parts:[{ text:`You are TripFlow's travel planning assistant. ${context} Answer concisely with short, practical bullet points, using real place names when relevant. User: ${text}` }]}] })
      });
      const data = await res.json();
      if(data.candidates && data.candidates[0] && data.candidates[0].content){
        typing.innerHTML = esc(data.candidates[0].content.parts[0].text).replace(/\n/g,'<br>');
      } else {
        typing.innerHTML = esc("I couldn't reach Gemini right now — check your API key. Meanwhile: " + result.reply);
      }
    }catch(e){ typing.innerHTML = esc('Connection error reaching Gemini. ' + result.reply); }
  } else {
    typing.innerHTML = esc(result.reply).replace(/\n/g,'<br>');
  }
  renderAISuggestions();
}

function guessDestFromText(t){
  return DESTINATIONS.find(d=>!d.id.startsWith('gen-') && t.includes(d.name.toLowerCase()));
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
  const dest = trip ? DESTINATIONS.find(d=>d.id===trip.destId) : null;

  let m = t.match(/what should i do in ([a-z\s,]+?)(?: for (\d+)\s*days?)?[.?!]?$/);
  if(m && m[1].trim().length>1){
    const name = m[1].trim();
    const days = m[2] ? parseInt(m[2],10) : null;
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

  if(/\bcheap\b|budget[- ]friendly|build me a cheap/.test(t)){
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
  initEditBudgetModal();
  initCustomizeModal();
  initAI();
  renderNotifications();
  route();
}
window.addEventListener('hashchange', route);
document.addEventListener('DOMContentLoaded', init);
