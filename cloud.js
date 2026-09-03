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
  const cfg = cloudConfig();
  if(!cfg) return null;
  if(__cloud.client) return __cloud.client;
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

if(typeof module !== 'undefined' && module.exports){
  module.exports = { cloudConfig, cloudConfigProblem, saveCloudConfig, forgetCloudConfig,
                     cloudConfigured, mergeTrips, tripUpdatedAt, CLOUD_CONFIG_KEY };
}
