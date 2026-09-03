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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
