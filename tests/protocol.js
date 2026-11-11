/* One scenario that both inboxes (server/server.js and backend/Code.gs) must pass.
   api = { get(queryObject) -> answer, post(bodyObject) -> answer }, both async. */
'use strict';
const assert = require('assert');

const b64 = (s) => Buffer.from(s).toString('base64');
const claim = (extra) => Object.assign({
  claimant: 'Chin Zhi Liang', month: '2026-10', total: 9999, from: 'edward.wfcsystems@gmail.com', to: 'agnes@yutech.com.my', subject: 'Claim - October 2026',
  lines: [
    { category: 'Petrol', date: '2026-10-05', name: 'Kejayaan Teguh Enterprise', receiptNo: 'a1b2c3', amount: 60 },
    { category: 'Toll', date: '2026-10-31', name: "Touch 'n Go", receiptNo: '1130739887', amount: 27.4 },
    { category: 'Medical', date: '2026-10-12', name: 'Klinik Putra Care', receiptNo: '5521', amount: 75.1 },
  ],
}, extra);

async function runProtocol(api, log) {
  const say = log || (() => {});
  const must = (r, what) => { assert.strictEqual(r.ok, true, `${what}: expected ok, got ${JSON.stringify(r).slice(0, 200)}`); return r; };
  const mustFail = (r, what) => { assert.strictEqual(r.ok, false, `${what}: expected a refusal, got ${JSON.stringify(r).slice(0, 200)}`); assert.ok(r.error, `${what}: refusal needs a plain message`); return r; };

  must(await api.get({ action: 'ping' }), 'ping'); say('ping');
  assert.deepStrictEqual(must(await api.get({ action: 'list' }), 'list empty').claims, []);
  mustFail(await api.get({ action: 'nonsense' }), 'unknown get');
  mustFail(await api.get({ action: 'submit' }), 'a write by GET');
  assert.deepStrictEqual(must(await api.post({ action: 'list' }), 'a read by POST').claims, [], 'a read may also come by POST');
  assert.strictEqual(must(await api.get({ action: 'ping' }), 'ping').auth, false, 'no password set in this scenario');

  mustFail(await api.post({ action: 'submit', claim: claim({ claimant: '  ' }) }), 'no name');
  mustFail(await api.post({ action: 'submit', claim: claim({ month: 'October' }) }), 'bad month');
  mustFail(await api.post({ action: 'submit', claim: claim({ lines: [] }) }), 'no lines');
  const row = { category: 'Other', date: '2026-10-01', name: 'x'.repeat(200), receiptNo: 'y'.repeat(100), amount: 1 };
  mustFail(await api.post({ action: 'submit', claim: claim({ lines: Array(61).fill(row) }) }), 'too many lines');
  const full = must(await api.post({ action: 'submit', claim: claim({ claimant: 'Full Claim', lines: Array(60).fill(row) }) }), '60 long lines still fit');
  must(await api.post({ action: 'finish', id: full.id, token: full.token }), 'finish the full one');
  const stored = (await api.get({ action: 'list' })).claims[0];
  assert.strictEqual(stored.lines[0].name.length, 120, 'long text is cut to a sensible length');
  assert.strictEqual(stored.total, 60);
  must(await api.post({ action: 'delete', id: full.id }), 'remove the full one');
  say('validation');

  const sub = must(await api.post({ action: 'submit', claim: claim() }), 'submit');
  assert.strictEqual(sub.id, '2026-10_chin-zhi-liang');
  assert.ok(sub.token && sub.token.length >= 12);
  assert.deepStrictEqual((await api.get({ action: 'list' })).claims, [], 'a claim being uploaded is not shown yet');

  mustFail(await api.post({ action: 'upload', id: sub.id, token: 'wrong', file: { id: 'f1', name: 'x.pdf', kind: 'form-pdf', data: b64('x') } }), 'wrong token');
  const files = [
    { id: 'f1', name: 'WFC - OCT Claim form.pdf', kind: 'form-pdf', line: 0, mime: 'application/pdf', data: b64('%PDF-form-v1') },
    { id: 'f2', name: 'Receipt 01 - Petrol - 05-10-2026.jpg', kind: 'receipt', line: 1, mime: 'image/jpeg', data: b64('JPEGDATA-1') },
    { id: 'f3', name: 'TNG toll check list.pdf', kind: 'tollcheck', line: 0, data: b64('%PDF-toll') },
  ];
  for (const f of files) must(await api.post({ action: 'upload', id: sub.id, token: sub.token, file: f }), 'upload ' + f.id);
  mustFail(await api.post({ action: 'upload', id: sub.id, token: sub.token, file: { id: 'f9', name: 'empty.pdf', kind: 'other', data: '' } }), 'empty file');
  mustFail(await api.post({ action: 'upload', id: '../../etc', token: sub.token, file: files[0] }), 'odd id');
  const fin = must(await api.post({ action: 'finish', id: sub.id, token: sub.token }), 'finish');
  assert.strictEqual(fin.version, 1); assert.strictEqual(fin.files, 3);
  say('submit + upload + finish');

  const list = must(await api.get({ action: 'list' }), 'list').claims;
  assert.strictEqual(list.length, 1);
  const c = list[0];
  assert.strictEqual(c.claimant, 'Chin Zhi Liang'); assert.strictEqual(c.monthLabel, 'October 2026');
  assert.strictEqual(c.total, 162.5, 'the total is added up by the inbox, not taken from the sender');
  assert.strictEqual(c.status, 'new'); assert.strictEqual(c.version, 1); assert.strictEqual(c.lines.length, 3);
  assert.strictEqual(c.lines[0].no, 1); assert.strictEqual(c.from, 'edward.wfcsystems@gmail.com');
  assert.strictEqual(c.files.length, 3);
  assert.deepStrictEqual(c.files.find((f) => f.id === 'f2'), Object.assign({}, c.files.find((f) => f.id === 'f2'), { kind: 'receipt', line: 1, mime: 'image/jpeg', size: 10, name: 'Receipt 01 - Petrol - 05-10-2026.jpg' }));
  const leak = JSON.stringify(list);
  ['token', 'driveId', 'folderId', 'pending', '"dir"', '"file":'].forEach((k) => assert.ok(!leak.includes(k), 'the list must not show ' + k));
  assert.strictEqual(c.history[0].text, 'Received');
  say('list');

  const got = must(await api.get({ action: 'file', id: sub.id, file: 'f2' }), 'file');
  assert.strictEqual(got.data, b64('JPEGDATA-1')); assert.strictEqual(got.mime, 'image/jpeg'); assert.strictEqual(got.name, 'Receipt 01 - Petrol - 05-10-2026.jpg');
  mustFail(await api.get({ action: 'file', id: sub.id, file: 'nope' }), 'missing file');
  mustFail(await api.get({ action: 'file', id: '../server/server', file: 'f1' }), 'file by odd id');
  say('file');

  const st = must(await api.post({ action: 'status', id: sub.id, status: 'paid', note: 'Paid by bank transfer 12 Nov' }), 'status');
  assert.strictEqual(st.claim.status, 'paid'); assert.strictEqual(st.claim.note, 'Paid by bank transfer 12 Nov');
  assert.deepStrictEqual(st.claim.history.slice(-2).map((h) => h.text), ['Marked as Paid', 'Note updated']);
  mustFail(await api.post({ action: 'status', id: sub.id, status: 'approved' }), 'odd status');
  mustFail(await api.post({ action: 'status', id: '2026-01_nobody', status: 'paid' }), 'status of a missing claim');
  const same = must(await api.post({ action: 'status', id: sub.id, status: 'paid' }), 'status again');
  assert.strictEqual(same.claim.history.length, st.claim.history.length, 'nothing changed, nothing logged');
  say('status');

  // saving the same claim again replaces it; Agnes keeps seeing the old one until the new one is complete
  const sub2 = must(await api.post({ action: 'submit', claim: claim({ lines: claim().lines.concat({ category: 'Parking', date: '2026-10-20', name: 'MBSJ Flexi Parking', receiptNo: '', amount: 84.8 }) }) }), 'resubmit');
  assert.strictEqual(sub2.id, sub.id); assert.notStrictEqual(sub2.token, sub.token);
  assert.strictEqual((await api.get({ action: 'list' })).claims[0].lines.length, 3, 'still the old version while uploading');
  mustFail(await api.post({ action: 'upload', id: sub.id, token: sub.token, file: files[0] }), 'the old token after a new save');
  must(await api.post({ action: 'upload', id: sub2.id, token: sub2.token, file: { id: 'g1', name: 'WFC - OCT Claim form.pdf', kind: 'form-pdf', data: b64('%PDF-form-v2') } }), 'upload v2');
  const fin2 = must(await api.post({ action: 'finish', id: sub2.id, token: sub2.token }), 'finish v2');
  assert.strictEqual(fin2.version, 2);
  const c2 = (await api.get({ action: 'list' })).claims;
  assert.strictEqual(c2.length, 1, 'one claim per person per month');
  assert.strictEqual(c2[0].lines.length, 4); assert.strictEqual(c2[0].total, 247.3); assert.strictEqual(c2[0].status, 'new');
  assert.strictEqual(c2[0].files.length, 1); assert.strictEqual(c2[0].note, '');
  assert.ok(c2[0].history.some((h) => /Updated by the claimant/.test(h.text)) && c2[0].history.some((h) => h.text === 'Marked as Paid'), 'the history is kept');
  mustFail(await api.get({ action: 'file', id: sub.id, file: 'f2' }), 'a file of the old version');
  assert.strictEqual(must(await api.get({ action: 'file', id: sub.id, file: 'g1' }), 'new file').data, b64('%PDF-form-v2'));
  mustFail(await api.post({ action: 'finish', id: sub.id, token: sub2.token }), 'finish twice');
  say('save again');

  // a second person, another month
  const other = must(await api.post({ action: 'submit', claim: claim({ claimant: 'Siti Aminah', month: '2026-09' }) }), 'second person');
  must(await api.post({ action: 'upload', id: other.id, token: other.token, file: files[0] }), 'upload other');
  must(await api.post({ action: 'finish', id: other.id, token: other.token }), 'finish other');
  assert.strictEqual((await api.get({ action: 'list' })).claims.length, 2);

  must(await api.post({ action: 'delete', id: sub.id }), 'delete');
  must(await api.post({ action: 'delete', id: other.id }), 'delete other');
  assert.deepStrictEqual((await api.get({ action: 'list' })).claims, []);
  mustFail(await api.post({ action: 'delete', id: sub.id }), 'delete twice');
  say('delete');
}

/* The same inbox with a password set. The Claim Builder's calls (ping, submit, upload, finish) stay open; reading, files, status and delete need it. */
async function runAuth(api, password, log) {
  const say = log || (() => {});
  const must = (r, what) => { assert.strictEqual(r.ok, true, `${what}: expected ok, got ${JSON.stringify(r).slice(0, 200)}`); return r; };
  const refused = (r, what) => { assert.strictEqual(r.ok, false, `${what}: expected a refusal, got ${JSON.stringify(r).slice(0, 200)}`); assert.strictEqual(r.code, 401, `${what}: expected code 401, got ${JSON.stringify(r).slice(0, 200)}`); assert.ok(!JSON.stringify(r).includes(password), 'the password must never be echoed'); };

  assert.strictEqual(must(await api.get({ action: 'ping' }), 'ping').auth, true, 'ping says a password is needed');

  // the Claim Builder side needs no password
  const sub = must(await api.post({ action: 'submit', claim: claim() }), 'submit without a password');
  must(await api.post({ action: 'upload', id: sub.id, token: sub.token, file: { id: 'f1', name: 'WFC - OCT Claim form.pdf', kind: 'form-pdf', data: b64('%PDF-secret') } }), 'upload without a password');
  must(await api.post({ action: 'finish', id: sub.id, token: sub.token }), 'finish without a password');
  say('the Claim Builder side stays open');

  // nobody else can read or change anything
  refused(await api.get({ action: 'list' }), 'list, no key');
  refused(await api.post({ action: 'list' }), 'list by POST, no key');
  refused(await api.post({ action: 'list', key: 'wrong' }), 'list, wrong key');
  refused(await api.post({ action: 'list', key: password + 'x' }), 'list, almost the key');
  refused(await api.post({ action: 'list', key: '' }), 'list, empty key');
  refused(await api.get({ action: 'file', id: sub.id, file: 'f1' }), 'file by GET, no key');
  refused(await api.post({ action: 'file', id: sub.id, file: 'f1', key: 'wrong' }), 'file, wrong key');
  refused(await api.post({ action: 'status', id: sub.id, status: 'paid' }), 'status, no key');
  refused(await api.post({ action: 'delete', id: sub.id, key: 'wrong' }), 'delete, wrong key');
  say('reading and changing are refused without the password');

  // with the password everything works, by POST and by GET
  const list = must(await api.post({ action: 'list', key: password }), 'list with the key').claims;
  assert.strictEqual(list.length, 1); assert.strictEqual(list[0].status, 'new', 'the refused status change did not happen');
  assert.strictEqual(JSON.stringify(list).includes(password), false);
  assert.strictEqual(must(await api.get({ action: 'list', key: password }), 'list by GET with the key').claims.length, 1);
  assert.strictEqual(must(await api.post({ action: 'file', id: sub.id, file: 'f1', key: password }), 'file with the key').data, b64('%PDF-secret'));
  assert.strictEqual(must(await api.post({ action: 'status', id: sub.id, status: 'checked', key: password }), 'status with the key').claim.status, 'checked');
  must(await api.post({ action: 'delete', id: sub.id, key: password }), 'delete with the key');
  assert.deepStrictEqual(must(await api.post({ action: 'list', key: password }), 'list after delete').claims, []);
  say('everything works with the password');
}

module.exports = { runProtocol, runAuth };
