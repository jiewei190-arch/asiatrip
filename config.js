/* TripFlow — optional Supabase project details.
 *
 * Leave this exactly as it is and the app works as it always has: everything in this browser,
 * no account, nothing uploaded. Fill it in and the same app also keeps a copy of your trips
 * against an account, so a cleared browser or a second device is no longer a lost trip.
 *
 * Both values below are safe to commit. The anon key identifies the project; it does not grant
 * access to anything. What you can read and write is decided by the row-level security policies
 * in supabase/schema.sql, which is the file that actually protects the data.
 *
 * To fill it in:
 *   1. Create a project at supabase.com (the free tier is enough).
 *   2. SQL Editor → New query → paste supabase/schema.sql → Run.
 *   3. Project Settings → API → copy "Project URL" and the "anon public" key below.
 *
 * You can also do this from inside the app — Profile menu → Connect an account — which stores
 * the details in your browser instead of in this file. That is the better route if you would
 * rather not commit them.
 */
window.TRIPFLOW_SUPABASE = {
  url: '',        // e.g. 'https://abcdefghijklm.supabase.co'
  anonKey: '',    // the long "anon public" key, not the service_role key
};
