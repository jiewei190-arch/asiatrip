/* ============================================================================
 * cloud.js — the account, and the copy of your trips that outlives this browser.
 *
 * Everything TripFlow knows has lived in localStorage until now. That is a real feature — no
 * account, nothing to trust, works offline — and it is also the reason a cleared browser has
 * always meant a lost trip. Supabase adds the second copy without taking the first away.
 *
 * THE RULE THIS FILE IS BUILT AROUND
 * localStorage stays the source of truth on this device. The cloud is a peer, not a master. So:
 *
 *   - Not configured? Every function here is a no-op and the app behaves exactly as before.
 *   - Configured but signed out? Same. Nothing is uploaded without an account.
 *   - Signed in but offline, or Supabase down? Edits keep working locally and sync later.
 *
 * A traveller standing in a foreign city with no signal must not find their itinerary gone
 * because a server could not be reached. That is the whole design constraint.
 *
 * CREDENTIALS
 * The anon key is meant to be public — it identifies the project, it does not grant access.
 * Access is decided by row-level security in supabase/schema.sql, which is why that file
 * matters more than this one. Configure by either:
 *
 *   1. editing config.js, or
 *   2. Profile menu -> Connect an account, which stores it in this browser.
 * ========================================================================== */

const CLOUD_CONFIG_KEY = 'tf:supabase:config';
const CLOUD_SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

/** Where the project details come from, in order of precedence: what this browser was told,
 *  then whatever config.js shipped with. */
function cloudConfig(){
  try {
    const stored = JSON.parse(localStorage.getItem(CLOUD_CONFIG_KEY) || 'null');
    if(stored && stored.url && stored.anonKey) return stored;
  } catch(e){ /* unreadable config is no config */ }
  const shipped = (typeof window !== 'undefined' && window.TRIPFLOW_SUPABASE) || null;
  if(shipped && shipped.url && shipped.anonKey) return shipped;
  return null;
}

/** Rejects a half-filled form before it becomes a confusing runtime failure. */
function cloudConfigProblem(url, anonKey){
  if(!url || !anonKey) return 'Both the project URL and the anon key are needed.';
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(String(url).trim().replace(/\/$/, ''))){
    return 'That does not look like a Supabase project URL — it should be https://something.supabase.co';
  }
  // Supabase keys are JWTs: three dot-separated segments. A pasted password or project ref is
  // the common mistake and produces an opaque 401 much later if it is not caught here.
  if(String(anonKey).split('.').length !== 3){
    return 'That does not look like an anon key — copy the long "anon public" key from Project Settings → API.';
  }
  return null;
}

function saveCloudConfig(url, anonKey){
  const problem = cloudConfigProblem(url, anonKey);
  if(problem) return { ok: false, reason: problem };
  try {
    localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify({
      url: String(url).trim().replace(/\/$/, ''), anonKey: String(anonKey).trim(),
    }));
    __cloud.client = null;              // force a rebuild against the new project
    return { ok: true };
  } catch(e){ return { ok: false, reason: 'This browser would not store the settings.' }; }
}
function forgetCloudConfig(){
  try { localStorage.removeItem(CLOUD_CONFIG_KEY); } catch(e){}
  __cloud.client = null; __cloud.user = null;
}

/** True when there is a project to talk to at all. Everything else in this file checks it. */
function cloudConfigured(){ return !!cloudConfig(); }

const __cloud = { client: null, user: null, loading: null, lastError: null };

/** Loads the Supabase SDK on demand.
 *  Deliberately not a <script> tag in index.html: an app that is not configured should not pay
 *  for a library it will never call, and the offline path must not depend on a CDN answering. */
async function cloudClient(){
  // An already-built client wins over re-reading config: it is the live connection, and
  // rebuilding it on every call would drop the session. saveCloudConfig() clears it so a
  // changed project still takes effect.
  if(__cloud.client) return __cloud.client;
  const cfg = cloudConfig();
  if(!cfg) return null;
  if(__cloud.loading) return __cloud.loading;
  __cloud.loading = (async () => {
    try {
      const mod = await import(/* webpackIgnore: true */ CLOUD_SDK_URL);
      __cloud.client = mod.createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true },
      });
      __cloud.lastError = null;
      return __cloud.client;
    } catch(e){
      // A blocked CDN, an offline device, a corporate proxy. None of these may break the app.
      __cloud.lastError = 'sdk';
      return null;
    } finally { __cloud.loading = null; }
  })();
  return __cloud.loading;
}

/* ---------------- merging, which is the only genuinely hard part ----------------
   Two copies of the same trip can both have changed: edited on a laptop, edited on a phone
   while that laptop was shut. Something has to decide, and every option loses information in
   some case. This picks the most recently edited whole trip, per trip, and says so plainly in
   the UI rather than pretending a merge happened.

   Field-level merging was considered and rejected: two people editing different days of the
   same trip is the case it would help, and that is the collaboration feature, which needs
   presence and conflict UI rather than a cleverer diff. Guessing silently is worse than
   choosing openly. */

/** The server's clock decides, and only the server's clock. A device with a wrong date would
 *  otherwise win every merge forever, which is exactly the bug that makes sync untrustworthy. */
function tripUpdatedAt(trip){
  const t = trip && (trip.updatedAt || trip.createdAt);
  const n = t ? new Date(t).getTime() : 0;
  return isFinite(n) ? n : 0;
}

/** Reconciles local trips with remote rows. Pure, so the awkward cases are testable without a
 *  network: returns what to keep locally and what to push. */
function mergeTrips(localTrips, remoteRows){
  const local = new Map((localTrips || []).map(t => [t.id, t]));
  const remote = new Map();
  for(const row of (remoteRows || [])){
    if(!row || !row.id) continue;
    remote.set(row.id, row);
  }

  const keep = [], push = [], conflicts = [];

  for(const [id, trip] of local){
    const row = remote.get(id);
    if(!row){ keep.push(trip); push.push(trip); continue; }      // only here: it is new to the cloud
    if(row.deleted){
      // Removed on another device. Honour it rather than resurrecting it on every sync.
      continue;
    }
    const localAt = tripUpdatedAt(trip);
    const remoteAt = new Date(row.updated_at || 0).getTime() || 0;
    if(remoteAt > localAt){
      keep.push(row.data);
      if(localAt) conflicts.push({ id, title: trip.title, kept: 'cloud' });
    } else {
      keep.push(trip);
      if(remoteAt && remoteAt < localAt) push.push(trip);
    }
  }

  for(const [id, row] of remote){
    if(local.has(id) || row.deleted || !row.data) continue;
    keep.push(row.data);                                          // only in the cloud: pull it down
  }

  return { keep, push, conflicts };
}

/* ---------------- accounts ----------------
   Supabase handles the parts that are dangerous to write yourself: password hashing, session
   tokens, refresh, and the reset-by-email flow. Nothing below stores or compares a password.

   Every function answers {ok, reason} rather than throwing. A sign-in that fails because the
   device is offline and one that fails because the password is wrong are different messages,
   and a traveller deserves to be told which. */

/** Injected by the test suites so the whole flow can be exercised without a project. Nothing in
 *  the app calls this; it exists because the alternative is testing sync against nothing. */
function __setCloudClientForTests(client){ __cloud.client = client; }

async function cloudSignUp(email, password){
  const c = await cloudClient();
  if(!c) return { ok: false, reason: cloudUnavailableReason() };
  try {
    const { data, error } = await c.auth.signUp({ email, password });
    if(error) return { ok: false, reason: error.message };
    __cloud.user = (data && data.user) || null;
    // Supabase can be configured to require email confirmation. When it is, there is no session
    // yet and saying "signed in" would be a lie the traveller discovers on the next reload.
    const needsConfirmation = !(data && data.session);
    return { ok: true, needsConfirmation };
  } catch(e){ return { ok: false, reason: cloudNetworkReason(e) }; }
}

async function cloudSignIn(email, password){
  const c = await cloudClient();
  if(!c) return { ok: false, reason: cloudUnavailableReason() };
  try {
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    if(error) return { ok: false, reason: error.message };
    __cloud.user = (data && data.user) || null;
    return { ok: true };
  } catch(e){ return { ok: false, reason: cloudNetworkReason(e) }; }
}

async function cloudSignOut(){
  const c = await cloudClient();
  __cloud.user = null;
  if(!c) return { ok: true };
  try { await c.auth.signOut(); } catch(e){ /* the local session is cleared either way */ }
  return { ok: true };
}

/** Supabase emails the link and hosts the form. Writing our own reset flow would mean handling
 *  tokens and expiry in a static page, which is exactly the kind of thing to leave alone. */
async function cloudResetPassword(email){
  const c = await cloudClient();
  if(!c) return { ok: false, reason: cloudUnavailableReason() };
  try {
    const redirectTo = (typeof location !== 'undefined') ? location.origin + location.pathname : undefined;
    const { error } = await c.auth.resetPasswordForEmail(email, { redirectTo });
    if(error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch(e){ return { ok: false, reason: cloudNetworkReason(e) }; }
}

/** Who is signed in, if anyone. Reads the persisted session, so it survives a reload. */
async function cloudCurrentUser(){
  const c = await cloudClient();
  if(!c) return null;
  try {
    const { data } = await c.auth.getUser();
    __cloud.user = (data && data.user) || null;
    return __cloud.user;
  } catch(e){ return null; }
}

function cloudUnavailableReason(){
  if(!cloudConfigured()) return 'No account is connected on this device yet.';
  if(__cloud.lastError === 'sdk') return 'Could not reach the account service. Your trips are still saved on this device.';
  return 'The account service is not available right now. Your trips are still saved on this device.';
}
function cloudNetworkReason(e){
  const msg = (e && e.message) || '';
  if(/fetch|network|Failed to fetch/i.test(msg)) return 'No connection. Your trips are still saved on this device.';
  return msg || 'Something went wrong reaching the account service.';
}

/* ---------------- sync ----------------
   Local first, always. Every one of these runs AFTER the trip is already safe in localStorage,
   and every one of them is allowed to fail without the traveller losing anything. */

/** Everything this account has, including tombstones — the merge needs to see a deletion. */
async function cloudPullTrips(){
  const c = await cloudClient();
  if(!c || !__cloud.user) return { ok: false, reason: cloudUnavailableReason(), rows: [] };
  try {
    const { data, error } = await c.from('trips').select('id, data, updated_at, deleted')
      .eq('owner', __cloud.user.id);
    if(error) return { ok: false, reason: error.message, rows: [] };
    return { ok: true, rows: data || [] };
  } catch(e){ return { ok: false, reason: cloudNetworkReason(e), rows: [] }; }
}

/** Upsert, because the app already owns the id and a trip may exist on either side first. */
async function cloudPushTrips(trips){
  const c = await cloudClient();
  if(!c || !__cloud.user) return { ok: false, reason: cloudUnavailableReason(), pushed: 0 };
  const rows = (trips || []).map(t => ({ id: t.id, owner: __cloud.user.id, data: t, deleted: false }));
  if(!rows.length) return { ok: true, pushed: 0 };
  try {
    const { error } = await c.from('trips').upsert(rows, { onConflict: 'id' });
    if(error) return { ok: false, reason: error.message, pushed: 0 };
    return { ok: true, pushed: rows.length };
  } catch(e){ return { ok: false, reason: cloudNetworkReason(e), pushed: 0 }; }
}

/** A tombstone rather than a delete. Another device has to be able to learn this happened, and
 *  a row that is simply gone is indistinguishable from one that was never synced. */
async function cloudDeleteTrip(tripId){
  const c = await cloudClient();
  if(!c || !__cloud.user) return { ok: false, reason: cloudUnavailableReason() };
  try {
    const { error } = await c.from('trips')
      .upsert([{ id: tripId, owner: __cloud.user.id, data: {}, deleted: true }], { onConflict: 'id' });
    if(error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch(e){ return { ok: false, reason: cloudNetworkReason(e) }; }
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { cloudConfig, cloudConfigProblem, saveCloudConfig, forgetCloudConfig,
                     cloudConfigured, mergeTrips, tripUpdatedAt, CLOUD_CONFIG_KEY,
                     cloudSignUp, cloudSignIn, cloudSignOut, cloudResetPassword, cloudCurrentUser,
                     cloudPullTrips, cloudPushTrips, cloudDeleteTrip, __setCloudClientForTests,
                     __cloud };
}
