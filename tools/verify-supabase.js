/* Does the real thing actually work?
 *
 * Everything in tools/test-cloud.js and tools/test-account-ui.js runs against a mock. Mocks
 * prove what this code SENDS and what it does with each answer. They cannot prove that Postgres
 * accepts the write, that the trigger stamps updated_at, or — the one that matters most — that
 * the row-level security policies actually stop one account reading another's trips. A policy
 * that is subtly wrong looks identical to a policy that is right until somebody tries.
 *
 * This script is that try. It signs up two throwaway accounts against a real project, has one
 * write a trip, and then checks the other cannot see it.
 *
 *   node tools/verify-supabase.js <project-url> <anon-key>
 *
 * or with the values in the environment:
 *
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... node tools/verify-supabase.js
 *
 * It creates two accounts named tripflow-verify-<timestamp>-a/b@example.com and deletes the
 * rows it wrote. It cannot delete the accounts — the anon key is not allowed to, by design —
 * so expect two throwaway users in Authentication → Users afterwards.
 *
 * NOTHING here touches your real trips: it writes rows with ids prefixed verify- and removes
 * them at the end, and it never reads or modifies anything else.
 */
const URL_ARG = process.argv[2] || process.env.SUPABASE_URL || '';
const KEY_ARG = process.argv[3] || process.env.SUPABASE_ANON_KEY || '';

if(!URL_ARG || !KEY_ARG){
  console.error('Usage: node tools/verify-supabase.js <project-url> <anon-key>');
  console.error('   or: SUPABASE_URL=... SUPABASE_ANON_KEY=... node tools/verify-supabase.js');
  process.exitCode = 2;
  return;
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if(cond){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
};

const base = URL_ARG.replace(/\/$/, '');
const rest = base + '/rest/v1';
const auth = base + '/auth/v1';

/* Deliberately plain fetch rather than the SDK. If the SDK is doing something helpful that the
 * raw API does not, this script would hide it — and what has to be verified is the DATABASE'S
 * behaviour, not the library's. */
async function api(url, opts){
  const o = opts || {};
  try {
    const res = await fetch(url, {
      method: o.method || 'GET',
      headers: Object.assign({ apikey: KEY_ARG, 'Content-Type': 'application/json' },
                             o.token ? { Authorization: 'Bearer ' + o.token } : {},
                             o.headers || {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch(e){ json = { raw: text }; }
    return { status: res.status, ok: res.ok, json };
  } catch(e){
    // A typo in the URL is the likeliest first failure, and a diagnosis script that dies on a
    // stack trace is no diagnosis. Status 0 means "never reached it".
    return { status: 0, ok: false, json: null, netError: (e && e.message) || String(e) };
  }
}

async function signUp(email, password){
  const r = await api(auth + '/signup', { method: 'POST', body: { email, password } });
  const token = r.json && (r.json.access_token || (r.json.session && r.json.session.access_token));
  const user = r.json && (r.json.user || r.json);
  return { ok: !!token, token, userId: user && user.id, status: r.status, json: r.json };
}

(async () => {
  const stamp = Date.now();
  const emailA = `tripflow-verify-${stamp}-a@example.com`;
  const emailB = `tripflow-verify-${stamp}-b@example.com`;
  const password = 'verify-' + stamp + '-Aa1!';
  const tripId = 'verify-' + stamp;

  console.log('\nReaching the project');
  const ping = await api(rest + '/trips?select=id&limit=1');
  if(ping.status === 0){
    console.log(`  FAIL  the project could not be reached — ${ping.netError}`);
    console.log('        Check the Project URL. It looks like https://<ref>.supabase.co and is');
    console.log('        shown in Project Settings → API.');
    console.log('\n0 passed, 1 failed, verification could not start\n');
    process.exitCode = 1;
    return;
  }
  check('the project answers', true, `HTTP ${ping.status}`);
  check('the trips table exists (schema.sql has been run)',
        ping.status !== 404, ping.status === 404 ? 'run supabase/schema.sql first' : `HTTP ${ping.status}`);
  // An anonymous read must return nothing rather than everything. 401 or an empty list are both
  // correct; a list of somebody's trips is not.
  check('an anonymous request cannot read trips',
        ping.status === 401 || (Array.isArray(ping.json) && ping.json.length === 0),
        `HTTP ${ping.status} ${JSON.stringify(ping.json).slice(0, 120)}`);

  console.log('\nTwo accounts');
  const a = await signUp(emailA, password);
  const b = await signUp(emailB, password);
  if(!a.ok || !b.ok){
    console.log(`  SKIP  sign-up did not return a session (HTTP ${a.status}/${b.status}).`);
    console.log('        If the project requires email confirmation, turn it off for this test:');
    console.log('        Authentication → Providers → Email → "Confirm email" off, then re-run.');
    console.log(`        Response: ${JSON.stringify(a.json).slice(0, 200)}`);
    console.log(`\n${pass} passed, ${fail} failed, verification incomplete\n`);
    process.exitCode = 1;
    return;
  }
  check('account A signed up and got a session', a.ok);
  check('account B signed up and got a session', b.ok);

  console.log('\nA writes a trip');
  const write = await api(rest + '/trips', {
    method: 'POST', token: a.token,
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: [{ id: tripId, owner: a.userId, data: { id: tripId, title: 'Verification trip' }, deleted: false }],
  });
  check('the write is accepted', write.ok, `HTTP ${write.status} ${JSON.stringify(write.json).slice(0,160)}`);
  const row = Array.isArray(write.json) ? write.json[0] : null;
  check('the database stamped updated_at itself', !!(row && row.updated_at),
        'the client must not be trusted to timestamp its own rows');

  console.log('\nA reads it back');
  const readA = await api(rest + `/trips?select=id,data,updated_at,deleted&id=eq.${tripId}`, { token: a.token });
  check('A can read their own trip',
        readA.ok && Array.isArray(readA.json) && readA.json.length === 1,
        `HTTP ${readA.status} ${JSON.stringify(readA.json).slice(0,120)}`);

  console.log('\nB must not be able to — this is the check a mock cannot make');
  const readB = await api(rest + `/trips?select=id&id=eq.${tripId}`, { token: b.token });
  check('B cannot read A\'s trip',
        readB.ok && Array.isArray(readB.json) && readB.json.length === 0,
        `HTTP ${readB.status} ${JSON.stringify(readB.json).slice(0,160)}`);

  const stealAttempt = await api(rest + `/trips?id=eq.${tripId}`, {
    method: 'PATCH', token: b.token, body: { data: { title: 'Taken over by B' } },
  });
  const afterSteal = await api(rest + `/trips?select=data&id=eq.${tripId}`, { token: a.token });
  const stillMine = afterSteal.json && afterSteal.json[0] && afterSteal.json[0].data
                    && afterSteal.json[0].data.title === 'Verification trip';
  check('B cannot overwrite A\'s trip', !!stillMine,
        `title is now ${JSON.stringify(afterSteal.json && afterSteal.json[0] && afterSteal.json[0].data)}`);

  const grabAttempt = await api(rest + '/trips', {
    method: 'POST', token: b.token,
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: [{ id: 'verify-forged-' + stamp, owner: a.userId, data: { title: 'Forged onto A' }, deleted: false }],
  });
  check('B cannot write a row owned by A',
        !grabAttempt.ok, `HTTP ${grabAttempt.status} — the with-check clause on insert is what stops this`);

  console.log('\nTombstones');
  const tomb = await api(rest + '/trips', {
    method: 'POST', token: a.token,
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: [{ id: tripId, owner: a.userId, data: {}, deleted: true }],
  });
  check('a delete can be recorded as a tombstone', tomb.ok, `HTTP ${tomb.status}`);
  const readTomb = await api(rest + `/trips?select=deleted&id=eq.${tripId}`, { token: a.token });
  check('and reads back as deleted',
        readTomb.json && readTomb.json[0] && readTomb.json[0].deleted === true);

  console.log('\nCleaning up');
  const del = await api(rest + `/trips?id=eq.${tripId}`, { method: 'DELETE', token: a.token });
  check('the verification row is removed', del.ok, `HTTP ${del.status}`);
  await api(rest + `/trips?id=eq.verify-forged-${stamp}`, { method: 'DELETE', token: a.token });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if(!fail){
    console.log('The schema, the trigger and the security policies all behave as intended.');
    console.log(`Two throwaway accounts remain in Authentication → Users (${emailA}, ${emailB});`);
    console.log('the anon key is not allowed to delete users, which is itself correct.\n');
  }
  process.exitCode = fail ? 1 : 0;
})();
