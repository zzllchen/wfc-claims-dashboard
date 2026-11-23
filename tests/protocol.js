/* One scenario that both inboxes (server/server.js and backend/Code.gs) must pass.
   api = { get(queryObject) -> answer, post(bodyObject) -> answer }, both async. */
'use strict';
const assert = require('assert');

const b64 = (s) => Buffer.from(s).toString('base64');
const claim = (extra) => Object.assign({
  claimant: 'Chin Zhi Liang', month: '2026-10', total: 9999, from: 'edward.wfcsystems@gmail.com', to: 'agnes@yutech.com.my', subject: 'Claim - October 2026',
  lines: [
    { category: 'Petrol', date: '2026-10-05', name: 'Kejayaan Teguh Enterprise', receiptNo: 'a1b2c3', amount: 60, litres: 30.1505, fuel: 'petrol' },
    { category: 'Toll', date: '2026-10-31', name: "Touch 'n Go", receiptNo: '1130739887', amount: 27.4 },
    { category: 'Medical', date: '2026-10-12', name: 'Klinik Putra Care', receiptNo: '5521', amount: 75.1,
      scan: { docType: 'receipt', currency: 'MYR', tax: 4.5, paymentMethod: 'Visa', last4: '4111111111114444', periodStart: 'soon', bogus: 'x', source: 'claude' } },
  ],
  scanLog: [{ field: 'amount', from: '75.00', to: '75.10', source: 'claude', docType: 'receipt', category: 'Medical' }, { from: 'no field' }],
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

  // the company's claim rules: kept in the inbox, come back with the list, a change only by POST
  assert.strictEqual(must(await api.get({ action: 'ping' }), 'ping').rules, true, 'ping says rules are understood');
  assert.deepStrictEqual(must(await api.get({ action: 'list' }), 'list').rules.text, '', 'no rules yet');
  mustFail(await api.get({ action: 'rules', text: 'x' }), 'rules by GET');
  mustFail(await api.post({ action: 'rules', text: 'x'.repeat(4001) }), 'rules too long');
  const saved = must(await api.post({ action: 'rules', text: '  Parking over RM30 needs a reason.\r\nNo fuel on leave days.\u0007 ' }), 'save rules').rules;
  assert.strictEqual(saved.text, 'Parking over RM30 needs a reason.\nNo fuel on leave days.', 'line breaks kept, control characters and outer spaces gone');
  assert.ok(saved.updatedAt);
  assert.strictEqual(must(await api.get({ action: 'list' }), 'list').rules.text, saved.text, 'the rules come back with the list');
  say('company rules are saved and listed');

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
  assert.deepStrictEqual(c.lines[2].scan, { docType: 'receipt', currency: 'MYR', paymentMethod: 'Visa', source: 'claude', tax: 4.5, last4: '4444' }, 'receipt extras kept, the card cut to 4 digits, anything odd dropped');
  assert.ok(!('scan' in c.lines[0]), 'a line with nothing extra has no scan');
  assert.deepStrictEqual(c.scanLog, [{ field: 'amount', from: '75.00', to: '75.10', source: 'claude', docType: 'receipt', category: 'Medical' }], 'corrections kept, empty ones dropped');
  assert.strictEqual(c.claimant, 'Chin Zhi Liang'); assert.strictEqual(c.monthLabel, 'October 2026');
  assert.strictEqual(c.total, 162.5, 'the total is added up by the inbox, not taken from the sender');
  assert.strictEqual(c.status, 'new'); assert.strictEqual(c.version, 1); assert.strictEqual(c.lines.length, 3);
  assert.strictEqual(c.lines[0].no, 1); assert.strictEqual(c.from, 'edward.wfcsystems@gmail.com');
  assert.strictEqual(c.lines[0].litres, 30.151, 'a fuel line keeps its litres (3 decimals), for the carbon figures'); assert.strictEqual(c.lines[0].fuel, 'petrol');
  assert.ok(!('litres' in c.lines[1]) && !('fuel' in c.lines[1]), 'a line with no litres has no fuel fields');
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

  // receipts claimed before: asked by the Claim Builder while a claim is made, no password, no names in the answer
  assert.strictEqual(must(await api.get({ action: 'ping' }), 'ping').seen, true, 'ping says the lookup is there');
  mustFail(await api.get({ action: 'seen', claimant: 'Chin Zhi Liang', month: '2026-11' }), 'seen by GET');
  const ask = async (who, month, lines) => must(await api.post({ action: 'seen', claimant: who, month, lines }), 'seen').matches;
  const nov = await ask('Chin Zhi Liang', '2026-11', [
    { ref: 'a', category: 'Petrol', date: '2026-11-03', name: 'Some Station', receiptNo: 'A1-B2 C3', amount: 61 },      // the same receipt no., written another way
    { ref: 'b', category: 'Toll', date: '2026-11-30', name: "Touch 'n Go", receiptNo: '1130739887', amount: 27.4 },     // the TNG card number: never a duplicate
    { ref: 'c', category: 'Medical', date: '2026-10-12', name: 'KLINIK PUTRA CARE', receiptNo: 'zz99', amount: 75.1 },  // same shop, date and amount
    { ref: 'd', category: 'Meals', date: '2026-11-04', name: 'New Cafe', receiptNo: '7788', amount: 12 },             // new
  ]);
  assert.deepStrictEqual(nov.map((m) => [m.ref, m.check]), [['a', 'receipt'], ['c', 'lookalike']]);
  assert.deepStrictEqual(nov[0].claims.map((x) => [x.month, x.mine]).sort(), [['2026-09', false], ['2026-10', true]], 'claimed by this person in October and by someone else in September');
  assert.deepStrictEqual(Object.keys(nov[0].claims[0]).sort(), ['mine', 'month', 'monthLabel', 'status']);
  assert.ok(!JSON.stringify(nov).includes('Siti') && !JSON.stringify(nov).includes('Chin'), 'never another person\'s name');
  const oct = await ask('Chin Zhi Liang', '2026-10', [{ ref: 'a', category: 'Petrol', date: '2026-10-05', name: 'Kejayaan Teguh Enterprise', receiptNo: 'a1b2c3', amount: 60 }]);
  assert.deepStrictEqual(oct[0].claims.map((x) => [x.month, x.mine]), [['2026-09', false]], 'the claim being saved again is not compared with itself');
  assert.deepStrictEqual(await ask('Chin Zhi Liang', '2026-11', []), []);
  say('receipts claimed before');

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
  assert.strictEqual(must(await api.post({ action: 'seen', claimant: 'Someone', month: '2026-11', lines: [{ category: 'Petrol', receiptNo: 'a1b2c3', amount: 60 }] }), 'seen without a password').matches.length, 1);
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
  refused(await api.post({ action: 'rules', text: 'Anything goes.' }), 'rules, no key');
  say('reading and changing are refused without the password');

  // with the password everything works, by POST and by GET
  const list = must(await api.post({ action: 'list', key: password }), 'list with the key').claims;
  assert.strictEqual(list.length, 1); assert.strictEqual(list[0].status, 'new', 'the refused status change did not happen');
  assert.strictEqual(JSON.stringify(list).includes(password), false);
  assert.strictEqual(must(await api.get({ action: 'list', key: password }), 'list by GET with the key').claims.length, 1);
  assert.strictEqual(must(await api.post({ action: 'file', id: sub.id, file: 'f1', key: password }), 'file with the key').data, b64('%PDF-secret'));
  assert.strictEqual(must(await api.post({ action: 'status', id: sub.id, status: 'checked', key: password }), 'status with the key').claim.status, 'checked');
  assert.strictEqual(must(await api.post({ action: 'rules', text: 'Receipts within 30 days.', key: password }), 'rules with the key').rules.text, 'Receipts within 30 days.');
  must(await api.post({ action: 'delete', id: sub.id, key: password }), 'delete with the key');
  assert.deepStrictEqual(must(await api.post({ action: 'list', key: password }), 'list after delete').claims, []);
  say('everything works with the password');
}


/* Leave applications: a saved leave form is sent like a claim (submit, upload, finish) but as `leave`, and lands in its own list. */
const leaveForm = (extra) => Object.assign({
  claimant: 'Chin Zhi Liang', type: 'annual', start: '2026-11-05', end: '2026-11-09', days: 2, reason: 'Hometown visit', signedOn: '2026-11-02',
  from: 'edward.wfcsystems@gmail.com', to: 'agnes@yutech.com.my', subject: 'Leave application - 5 - 9 Nov 2026',
}, extra);

async function runLeave(api, log) {
  const say = log || (() => {});
  const must = (r, what) => { assert.strictEqual(r.ok, true, `${what}: expected ok, got ${JSON.stringify(r).slice(0, 200)}`); return r; };
  const mustFail = (r, what) => { assert.strictEqual(r.ok, false, `${what}: expected a refusal, got ${JSON.stringify(r).slice(0, 200)}`); assert.ok(r.error, `${what}: refusal needs a plain message`); return r; };
  const lists = async () => must(await api.get({ action: 'list' }), 'list');
  const send = async (leave, files) => {
    const sub = must(await api.post({ action: 'submit', leave }), 'submit leave');
    for (const f of files || []) must(await api.post({ action: 'upload', id: sub.id, token: sub.token, file: f }), 'upload ' + f.id);
    return { sub, fin: must(await api.post({ action: 'finish', id: sub.id, token: sub.token }), 'finish leave') };
  };

  assert.strictEqual(must(await api.get({ action: 'ping' }), 'ping').leave, true, 'ping says leave is understood');
  const empty = await lists();
  assert.deepStrictEqual(empty.claims, []); assert.deepStrictEqual(empty.leave, [], 'an empty leave list is there');

  mustFail(await api.post({ action: 'submit', leave: leaveForm({ claimant: '  ' }) }), 'no name');
  mustFail(await api.post({ action: 'submit', leave: leaveForm({ start: 'next week' }) }), 'bad start');
  mustFail(await api.post({ action: 'submit', leave: leaveForm({ end: '2026-02-30' }) }), 'a date that does not exist');
  mustFail(await api.post({ action: 'submit', leave: leaveForm({ start: '2026-11-09', end: '2026-11-05' }) }), 'ends before it starts');
  mustFail(await api.post({ action: 'submit', leave: leaveForm({ start: '2026-01-01', end: '2027-03-01' }) }), 'longer than a year');
  mustFail(await api.post({ action: 'submit' }), 'neither a claim nor leave');
  say('leave: validation');

  const files = [
    { id: 'f1', name: 'WFC - NOV Leave form (5Nov).pdf', kind: 'form-pdf', mime: 'application/pdf', data: b64('%PDF-leave') },
    { id: 'f2', name: 'WFC - NOV Leave form (5Nov).xlsx', kind: 'form-xlsx', data: b64('XLSXDATA') },
    { id: 'f3', name: 'MC 1 - 5 - 9 Nov 2026.jpg', kind: 'mc', mime: 'image/jpeg', data: b64('MCPHOTO') },
  ];
  const sub = must(await api.post({ action: 'submit', leave: leaveForm() }), 'submit');
  assert.strictEqual(sub.id, 'leave-2026-11-05_chin-zhi-liang');
  assert.deepStrictEqual((await lists()).leave, [], 'an application being uploaded is not shown yet');
  for (const f of files) must(await api.post({ action: 'upload', id: sub.id, token: sub.token, file: f }), 'upload ' + f.id);
  const fin = must(await api.post({ action: 'finish', id: sub.id, token: sub.token }), 'finish');
  assert.strictEqual(fin.version, 1); assert.strictEqual(fin.files, 3);

  const got = await lists();
  assert.deepStrictEqual(got.claims, [], 'a leave application is never listed as a claim');
  assert.strictEqual(got.leave.length, 1);
  const l = got.leave[0];
  assert.strictEqual(l.kind, 'leave'); assert.strictEqual(l.claimant, 'Chin Zhi Liang'); assert.strictEqual(l.type, 'annual'); assert.strictEqual(l.typeLabel, 'Annual leave');
  assert.strictEqual(l.start, '2026-11-05'); assert.strictEqual(l.end, '2026-11-09'); assert.strictEqual(l.days, 2, 'the sender knows the public holidays, so its day count is kept');
  assert.strictEqual(l.reason, 'Hometown visit'); assert.strictEqual(l.signedOn, '2026-11-02');
  assert.strictEqual(l.month, '2026-11'); assert.strictEqual(l.monthLabel, 'November 2026');
  assert.strictEqual(l.status, 'new'); assert.strictEqual(l.version, 1); assert.strictEqual(l.from, 'edward.wfcsystems@gmail.com');
  assert.strictEqual(l.files.length, 3); assert.strictEqual(l.files.find((f) => f.id === 'f3').kind, 'mc');
  assert.strictEqual(l.history[0].text, 'Received');
  ['token', 'driveId', 'folderId', 'pending', '"dir"', '"file":'].forEach((k) => assert.ok(!JSON.stringify(got).includes(k), 'the list must not show ' + k));
  assert.strictEqual(must(await api.get({ action: 'file', id: sub.id, file: 'f3' }), 'the MC').data, b64('MCPHOTO'));
  say('leave: submit + upload + finish + list');

  // the days are worked out when the sender gives none or a silly figure (Monday to Friday)
  const plain = await send(leaveForm({ start: '2026-11-16', end: '2026-11-22', days: undefined, type: 'honeymoon' }), [files[0]]);
  const plainRec = (await lists()).leave.find((x) => x.id === plain.sub.id);
  assert.strictEqual(plainRec.days, 5, 'Mon-Sun is five working days'); assert.strictEqual(plainRec.type, 'other', 'an unknown type becomes Other');
  const silly = await send(leaveForm({ start: '2026-11-23', end: '2026-11-24', days: 99 }), [files[0]]);
  assert.strictEqual((await lists()).leave.find((x) => x.id === silly.sub.id).days, 2, 'more days than the dates cover is replaced');
  const half = await send(leaveForm({ start: '2026-11-25', end: '2026-11-25', days: 0.5 }), [files[0]]);
  assert.strictEqual((await lists()).leave.find((x) => x.id === half.sub.id).days, 0.5, 'half a day is allowed');
  for (const x of [plain, silly, half]) must(await api.post({ action: 'delete', id: x.sub.id }), 'tidy up');
  say('leave: days');

  // statuses: a leave application is New, Recorded or Has a question; a claim keeps its own
  const rec = must(await api.post({ action: 'status', id: sub.id, status: 'recorded', note: 'Balance filled in' }), 'recorded');
  assert.strictEqual(rec.claim.status, 'recorded'); assert.deepStrictEqual(rec.claim.history.slice(-2).map((h) => h.text), ['Marked as Recorded', 'Note updated']);
  mustFail(await api.post({ action: 'status', id: sub.id, status: 'paid' }), 'a leave application is never Paid');
  mustFail(await api.post({ action: 'status', id: sub.id, status: 'checked' }), 'a leave application is never Checked');
  must(await api.post({ action: 'status', id: sub.id, status: 'question' }), 'a question');
  const cl = must(await api.post({ action: 'submit', claim: claim() }), 'a claim in the same month');
  must(await api.post({ action: 'finish', id: cl.id, token: cl.token }), 'finish the claim');
  mustFail(await api.post({ action: 'status', id: cl.id, status: 'recorded' }), 'a claim is never Recorded');
  assert.strictEqual(must(await api.post({ action: 'status', id: cl.id, status: 'checked' }), 'a claim can still be Checked').claim.status, 'checked');
  const both = await lists();
  assert.strictEqual(both.claims.length, 1); assert.strictEqual(both.leave.length, 1, 'a claim and a leave application of the same person do not mix');
  must(await api.post({ action: 'delete', id: cl.id }), 'delete the claim');
  say('leave: statuses');

  // saving the same leave form again replaces it (same person, same start date); a different start date is another application
  const again = must(await api.post({ action: 'submit', leave: leaveForm({ end: '2026-11-10', days: 3, reason: 'Hometown visit and a wedding' }) }), 'resubmit');
  assert.strictEqual(again.id, sub.id);
  assert.strictEqual((await lists()).leave[0].days, 2, 'still the old version while uploading');
  must(await api.post({ action: 'upload', id: again.id, token: again.token, file: files[0] }), 'upload v2');
  assert.strictEqual(must(await api.post({ action: 'finish', id: again.id, token: again.token }), 'finish v2').version, 2);
  const v2 = (await lists()).leave;
  assert.strictEqual(v2.length, 1); assert.strictEqual(v2[0].days, 3); assert.strictEqual(v2[0].status, 'new'); assert.strictEqual(v2[0].files.length, 1);
  assert.ok(v2[0].history.some((h) => /Updated by the claimant/.test(h.text)) && v2[0].history.some((h) => h.text === 'Marked as Recorded'), 'the history is kept');
  const other = await send(leaveForm({ start: '2026-12-01', end: '2026-12-01', days: 1, type: 'sick' }), [files[0], files[2]]);
  assert.strictEqual((await lists()).leave.length, 2, 'a different start date is another application');
  say('leave: save again');

  must(await api.post({ action: 'delete', id: sub.id }), 'delete');
  must(await api.post({ action: 'delete', id: other.sub.id }), 'delete the other');
  assert.deepStrictEqual((await lists()).leave, []);
  mustFail(await api.post({ action: 'delete', id: sub.id }), 'delete twice');
  mustFail(await api.get({ action: 'file', id: 'leave-2026-11-05_../x', file: 'f1' }), 'file by an odd leave id');
  say('leave: delete');
}

module.exports = { runProtocol, runAuth, runLeave };
