/* Syncing is where a trip gets lost.
 *
 * Everything else in this app can fail visibly — a photo does not load, a map does not draw.
 * Sync fails by quietly keeping the wrong copy, and the traveller finds out in a foreign city
 * with no signal. So the merge is a pure function and it is tested against the awkward cases
 * rather than the happy one.
 *
 * The rule it implements: localStorage is the source of truth on this device, the cloud is a
 * peer. Nothing here may delete a local trip that the cloud has never heard of.
 *
 *   node tools/test-cloud.js
 */
const path = require('path');
const C = require(path.join(path.dirname(__dirname), 'cloud.js'));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
};
const trip = (id, title, updatedAt) => ({ id, title, updatedAt, days: [], budget: { total: 0 } });
const row = (id, title, updated_at, extra) => Object.assign(
  { id, updated_at, deleted: false, data: { id, title, updatedAt: updated_at, days: [] } }, extra || {});

console.log('\nNothing is lost that only exists here');
{
  const r = C.mergeTrips([trip('a', 'Only local', '2026-05-01T10:00:00Z')], []);
  check('a trip the cloud has never seen is kept', r.keep.length === 1 && r.keep[0].id === 'a');
  check('and is queued to upload', r.push.length === 1 && r.push[0].id === 'a');
  check('with nothing reported as a conflict', r.conflicts.length === 0);

  const empty = C.mergeTrips([], []);
  check('two empty sides merge to nothing, without throwing', empty.keep.length === 0);
  check('null inputs do not throw', C.mergeTrips(null, null).keep.length === 0);
}

console.log('\nNothing is lost that only exists in the cloud');
{
  const r = C.mergeTrips([], [row('b', 'Only remote', '2026-05-01T10:00:00Z')]);
  check('a trip from another device is pulled down', r.keep.length === 1 && r.keep[0].id === 'b');
  check('and is not immediately pushed back', r.push.length === 0);
}

console.log('\nWhen both changed, the most recent whole trip wins — and says so');
{
  const newerRemote = C.mergeTrips(
    [trip('c', 'Local edit', '2026-05-01T10:00:00Z')],
    [row('c', 'Cloud edit', '2026-05-02T10:00:00Z')]);
  check('a newer cloud copy replaces the local one',
        newerRemote.keep[0].title === 'Cloud edit', newerRemote.keep[0].title);
  check('and the traveller is told which copy was kept',
        newerRemote.conflicts.length === 1 && newerRemote.conflicts[0].kept === 'cloud');

  const newerLocal = C.mergeTrips(
    [trip('d', 'Local edit', '2026-05-03T10:00:00Z')],
    [row('d', 'Cloud edit', '2026-05-02T10:00:00Z')]);
  check('a newer local copy is kept', newerLocal.keep[0].title === 'Local edit');
  check('and is queued to overwrite the cloud', newerLocal.push.length === 1);
  check('an identical timestamp keeps the local copy rather than churning',
        C.mergeTrips([trip('e','L','2026-05-01T10:00:00Z')],
                     [row('e','R','2026-05-01T10:00:00Z')]).keep[0].title === 'L');
}

console.log('\nA deletion on another device is honoured, not undone');
{
  const r = C.mergeTrips([trip('f', 'Deleted elsewhere', '2026-05-01T10:00:00Z')],
                         [row('f', 'Deleted elsewhere', '2026-05-02T10:00:00Z', { deleted: true })]);
  check('a trip deleted in the cloud does not come back', r.keep.length === 0, `${r.keep.length} kept`);
  check('and is not re-uploaded', r.push.length === 0);
  // The reason soft deletes exist at all: a missing row and an unsynced row look identical.
  const neverSynced = C.mergeTrips([trip('g', 'New here', '2026-05-01T10:00:00Z')], []);
  check('a trip merely absent from the cloud is NOT treated as deleted', neverSynced.keep.length === 1);
}

console.log('\nClocks');
{
  check('a trip with no timestamps sorts oldest rather than throwing',
        C.tripUpdatedAt({ id: 'x' }) === 0);
  check('createdAt is used when updatedAt is missing',
        C.tripUpdatedAt({ createdAt: '2026-05-01T00:00:00Z' }) > 0);
  check('an unparseable date is treated as no date',
        C.tripUpdatedAt({ updatedAt: 'not a date' }) === 0);
}

console.log('\nConfiguration is refused before it becomes a confusing 401');
{
  check('an empty form is refused', !!C.cloudConfigProblem('', ''));
  check('a URL that is not a Supabase project is refused',
        !!C.cloudConfigProblem('https://example.com', 'a.b.c'));
  check('a project ref pasted instead of a key is refused',
        !!C.cloudConfigProblem('https://abcdefghijklm.supabase.co', 'abcdefghijklm'),
        'a key is a JWT with three segments');
  check('a well-formed pair is accepted',
        C.cloudConfigProblem('https://abcdefghijklm.supabase.co', 'aaa.bbb.ccc') === null);
  check('a trailing slash on the URL is tolerated',
        C.cloudConfigProblem('https://abcdefghijklm.supabase.co/', 'aaa.bbb.ccc') === null);
}

console.log('\nUnconfigured is a supported state, not a broken one');
{
  // No localStorage and no window in Node: exactly the shape of a browser that was never set up.
  check('an unconfigured app reports no project', C.cloudConfig() === null);
  check('and says so plainly', C.cloudConfigured() === false);
}

/* ---------------------------------------------------------------------------
   Auth and sync, against a stand-in for Supabase.

   There is no project to talk to here, and there will not be one in CI, so the client is
   mocked. That tests the half this code is actually responsible for: what it sends, what it
   does with each kind of answer, and — the part that matters — that every failure is survivable
   and reported in words rather than swallowed. It does NOT prove a real round trip works; only
   credentials can do that, and that limitation is stated rather than papered over.
   --------------------------------------------------------------------------- */
function mockClient(opts){
  const o = opts || {};
  const calls = { upserts: [], selects: 0, signIn: 0, signOut: 0, reset: 0 };
  return {
    calls,
    auth: {
      signUp: async () => o.signUpError ? { data: null, error: { message: o.signUpError } }
              : { data: { user: { id: 'u1', email: 'a@b.c' }, session: o.noSession ? null : {} }, error: null },
      signInWithPassword: async () => { calls.signIn++;
        return o.signInError ? { data: null, error: { message: o.signInError } }
                             : { data: { user: { id: 'u1', email: 'a@b.c' } }, error: null }; },
      signOut: async () => { calls.signOut++; return {}; },
      resetPasswordForEmail: async () => { calls.reset++;
        return o.resetError ? { error: { message: o.resetError } } : { error: null }; },
      getUser: async () => ({ data: { user: o.noUser ? null : { id: 'u1', email: 'a@b.c' } } }),
    },
    from: () => ({
      select: () => ({ eq: async () => { calls.selects++;
        if(o.throwOnSelect) throw new Error('Failed to fetch');
        return o.selectError ? { data: null, error: { message: o.selectError } }
                             : { data: o.rows || [], error: null }; } }),
      upsert: async (rows) => { calls.upserts.push(rows);
        if(o.throwOnUpsert) throw new Error('Failed to fetch');
        return o.upsertError ? { error: { message: o.upsertError } } : { error: null }; },
    }),
  };
}

(async () => {
  console.log('\nSigning in');
  {
    C.__setCloudClientForTests(mockClient());
    const ok = await C.cloudSignIn('a@b.c', 'pw');
    check('a good sign-in reports success', ok.ok === true);

    C.__setCloudClientForTests(mockClient({ signInError: 'Invalid login credentials' }));
    const wrong = await C.cloudSignIn('a@b.c', 'nope');
    check('the reason comes from the service', wrong.ok === false && /Invalid login/.test(wrong.reason), wrong.reason);

    // Confirmation-required projects have no session yet. Saying "signed in" would be a lie the
    // traveller discovers on the next reload.
    C.__setCloudClientForTests(mockClient({ noSession: true }));
    const su = await C.cloudSignUp('a@b.c', 'pw');
    check('a sign-up needing email confirmation says so', su.ok === true && su.needsConfirmation === true);
    C.__setCloudClientForTests(mockClient());
    const su2 = await C.cloudSignUp('a@b.c', 'pw');
    check('one that does not, does not', su2.ok === true && su2.needsConfirmation === false);
  }

  console.log('\nSync carries what it should, and survives what it cannot');
  {
    const m = mockClient({ rows: [{ id: 'r1', data: { id:'r1', title:'From cloud' }, updated_at: '2026-05-02T00:00:00Z', deleted: false }] });
    C.__setCloudClientForTests(m);
    await C.cloudCurrentUser();
    const pulled = await C.cloudPullTrips();
    check('a pull returns the account rows', pulled.ok && pulled.rows.length === 1);

    const pushed = await C.cloudPushTrips([{ id: 't1', title: 'Mine' }]);
    check('a push sends one row per trip', pushed.ok && pushed.pushed === 1);
    check('and stamps the owner on it, which the policy requires',
          m.calls.upserts[0][0].owner === 'u1');
    check('and marks it not-deleted explicitly', m.calls.upserts[0][0].deleted === false);

    await C.cloudDeleteTrip('t1');
    const tomb = m.calls.upserts[1][0];
    check('a delete writes a tombstone rather than removing the row',
          tomb.deleted === true && tomb.id === 't1');

    check('pushing nothing does not call the network at all',
          (await C.cloudPushTrips([])).pushed === 0 && m.calls.upserts.length === 2);
  }

  console.log('\nEvery failure is survivable and explained');
  {
    C.__setCloudClientForTests(mockClient({ throwOnSelect: true }));
    await C.cloudCurrentUser();
    const offline = await C.cloudPullTrips();
    check('an offline pull fails without throwing', offline.ok === false);
    check('and says the trips are still on this device',
          /still saved on this device/i.test(offline.reason), offline.reason);

    C.__setCloudClientForTests(mockClient({ throwOnUpsert: true }));
    await C.cloudCurrentUser();
    const p = await C.cloudPushTrips([{ id: 'x' }]);
    check('an offline push fails without throwing', p.ok === false && p.pushed === 0);

    C.__setCloudClientForTests(mockClient({ selectError: 'permission denied for table trips' }));
    await C.cloudCurrentUser();
    const denied = await C.cloudPullTrips();
    check('a policy rejection is passed through verbatim, not hidden',
          denied.ok === false && /permission denied/.test(denied.reason), denied.reason);

    // The case that matters most: signed out, or never configured.
    C.__setCloudClientForTests(null);
    C.__cloud.user = null;
    const noAccount = await C.cloudPushTrips([{ id: 'y' }]);
    check('with no account, a push is a refusal rather than a crash', noAccount.ok === false);
    check('and the message tells the traveller nothing is lost',
          /this device/i.test(noAccount.reason), noAccount.reason);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('NOTE: the account and sync sections run against a mock. A real round trip needs');
  console.log('      project credentials and has NOT been verified.\n');
  process.exitCode = fail ? 1 : 0;
})();

