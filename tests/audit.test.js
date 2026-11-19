/* node tests/audit.test.js - Flow's auditor (js/audit.js): each fixed check, the money at risk, and the rule check request and reply */
'use strict';
const assert = require('assert');
const A = require('../js/audit.js');
const ok = (name, fn) => { fn(); console.log('ok  ' + name); };

const claim = (id, claimant, month, lines, extra) => Object.assign({ id, claimant, month, monthLabel: month, version: 1, submittedAt: '2026-11-05T02:00:00Z', updatedAt: '2026-11-05T02:00:00Z',
  total: lines.reduce((a, l) => a + l.amount, 0), lines: lines.map((l, i) => Object.assign({ no: i + 1 }, l)), files: [] }, extra);
const P = (date, name, receiptNo, amount, extra) => Object.assign({ category: 'Petrol', date, name, receiptNo, amount }, extra);

const claims = [
  claim('2026-10_alex', 'Alex Tan', '2026-10', [
    P('2026-10-03', 'Kejayaan Teguh', 'a41c9e', 60, { litres: 30.151 }),
    P('2026-10-19', 'Shell Subang', '88213', 50),                                  // on Alex's sick leave
    { category: 'Toll', date: '2026-10-31', name: "Touch 'n Go", receiptNo: '1130739887', amount: 27.4 },
    { category: 'Parking', date: '2026-10-04', name: 'MBSJ Parking', receiptNo: '', amount: 4 },     // a Sunday
    P('2026-10-22', 'Petronas Seksyen 13', '7d02f1', 60, { litres: 52.5 }),             // RM 1.14 a litre
    { category: 'Meals', date: '2026-10-15', name: 'Restoran Sri Melaka', receiptNo: '', amount: 38 },   // no receipt number
    { category: 'Parking', date: '2026-10-20', name: "Touch 'n Go", receiptNo: '1130739887', amount: 15 },   // parking summed from the statement: its date is not a day
  ]),
  claim('2026-10_lim', 'Lim Wei Jie', '2026-10', [
    P('2026-10-03', 'Kejayaan Teguh', 'A41C-9E', 60),                                  // Alex's receipt number again
    { category: 'Toll', date: '2026-10-31', name: "Touch 'n Go", receiptNo: '1130739887', amount: 22.65 },   // same card number: never a duplicate
    P('2026-10-08', 'Caltex Cheras', '30291', 45),
    P('2026-10-08', 'Caltex Cheras', '30299', 45),                                     // same shop, date and amount, other number
    P('2026-07-20', 'Caltex Cheras', '28001', 40),                                     // three months before the claim month
    P('2026-11-20', 'Caltex Cheras', '31002', 40),                                     // after the claim was sent
  ]),
  claim('2026-09_raj', 'Raj Kumar', '2026-09', [
    P('2026-09-02', 'Petronas Bangi', 'e90b13', 60, { litres: 30.151 }),
    P('2026-09-02', 'Petronas Kajang', 'e91c77', 35),                                   // second fill that day
    P('2026-08-28', 'Petronas Bangi', 'd1190a', 60),                                    // paid last month: belongs in that month's claim
  ]),
];
const leave = [{ claimant: 'alex tan', type: 'sick', start: '2026-10-19', end: '2026-10-20', days: 2 }];
const res = A.run(claims, leave);
const flagsOf = (id, no) => res.byLine[`${id}#${no}`] || [];
const checksOf = (id, no) => flagsOf(id, no).map((f) => f.check).sort();

ok('the same receipt number on two people\'s claims is high, both ways, ignoring case and dashes', () => {
  assert.deepStrictEqual(checksOf('2026-10_alex', 1), ['duplicate-receipt']);
  const f = flagsOf('2026-10_lim', 1)[0];
  assert.strictEqual(f.level, 'high');
  assert.ok(/Alex Tan's Oct 2026 claim, line 1 \(RM 60\.00\), for the same amount/.test(f.reason), f.reason);
  assert.deepStrictEqual(f.related, [{ claimId: '2026-10_alex', line: 1, staff: 'Alex Tan', month: '2026-10' }]);
});
ok('toll lines share the card number every month and are never duplicates', () => {
  assert.deepStrictEqual(checksOf('2026-10_alex', 3), []);
  assert.deepStrictEqual(checksOf('2026-10_lim', 2), []);
});
ok('same shop, date and amount with another number is medium; not also "two fills"', () => {
  assert.deepStrictEqual(checksOf('2026-10_lim', 3), ['duplicate-lookalike']);
  assert.strictEqual(flagsOf('2026-10_lim', 3)[0].level, 'medium');
  assert.ok(/line 4 of this claim/.test(flagsOf('2026-10_lim', 3)[0].reason));
});
ok('fuel on a leave day is fine (WFC: fuel all month); a meal on a leave day is low, the leave matched by name loosely', () => {
  assert.deepStrictEqual(checksOf('2026-10_alex', 2), []);
  const meal = A.run([claim('2026-10_m', 'Alex Tan', '2026-10', [{ category: 'Meals', date: '2026-10-20', name: 'Kopitiam', receiptNo: '77', amount: 12 }])], leave).flags;
  assert.deepStrictEqual(meal.map((f) => [f.check, f.level]), [['on-leave', 'low']]);
  assert.strictEqual(meal[0].reason, 'Meals on Tue 20 Oct, when Alex Tan was on sick leave (MC) from Mon 19 Oct to Tue 20 Oct.');
});
ok('fuel at RM 1.14 a litre does not add up', () => {
  const f = flagsOf('2026-10_alex', 5)[0];
  assert.strictEqual(f.check, 'fuel-math'); assert.ok(/RM 1\.14 a litre/.test(f.reason));
  assert.deepStrictEqual(checksOf('2026-10_alex', 1).includes('fuel-math'), false, 'RM 1.99 a litre is fine');
});
ok('dates: a receipt goes in the claim for the month it was paid; any other month is medium', () => {
  assert.deepStrictEqual(flagsOf('2026-10_lim', 5).map((f) => [f.check, f.level]), [['date-window', 'medium']]);
  assert.strictEqual(flagsOf('2026-10_lim', 5)[0].reason, 'Paid Mon 20 Jul 2026, but put in the Oct 2026 claim. A receipt goes in the claim for the month it was paid, and this one is 3 months older.');
  assert.ok(/after the claim was sent/.test(flagsOf('2026-10_lim', 6)[0].reason));
  assert.deepStrictEqual(flagsOf('2026-09_raj', 3).map((f) => [f.check, f.level]), [['date-window', 'medium']]);
  const later = A.run([claim('2026-10_n', 'N', '2026-10', [P('2026-11-02', 'Shop', 'n1', 9)], { updatedAt: '2026-11-05T02:00:00Z' })], []).flags[0];
  assert.ok(/belongs in a later claim/.test(later.reason), later.reason);
});
ok('two fuel fills in one day are low; parking on a weekend is not flagged (app payments can be any day)', () => {
  assert.deepStrictEqual(checksOf('2026-09_raj', 1), ['fuel-twice']);
  assert.deepStrictEqual(checksOf('2026-09_raj', 2), ['fuel-twice']);
  assert.deepStrictEqual(checksOf('2026-10_alex', 4), []);
});
ok('a statement total (parking summed from Touch \'n Go) is not checked for leave days or dates', () => {
  assert.deepStrictEqual(checksOf('2026-10_alex', 7), [], 'dated in Alex\'s MC, but it is a monthly total');
  const stray = [claim('2026-10_z', 'Z', '2026-10', [{ category: 'Toll', date: '2026-10-31', name: 'TNG', receiptNo: '99887766', amount: 9 }, { category: 'Parking', date: '2026-07-31', name: 'Parking (statement)', receiptNo: '99887766', amount: 5 }])];
  assert.deepStrictEqual(A.run(stray, []).flags, [], 'carrying the toll card number makes it a statement total');
});
ok('a line with no receipt number is low; parking without one is not flagged for that', () => {
  assert.deepStrictEqual(checksOf('2026-10_alex', 6), ['no-receipt-no']);
  assert.ok(!checksOf('2026-10_alex', 4).includes('no-receipt-no'));
});
ok('high first; counts; money at risk counts each high or medium line once', () => {
  assert.strictEqual(res.flags[0].level, 'high');
  assert.deepStrictEqual(res.counts, { high: 2, medium: 6, low: 3 });
  // a41c9e 60 + Lim 60 + Alex 1.14/L 60 + Lim lookalike 45 + 45 + Lim Jul 40 + Lim Nov 40 + Raj Aug 60
  assert.strictEqual(res.atRisk, 410);
  assert.strictEqual(res.lines, 16); assert.strictEqual(res.claims, 3);   // Alex 7, Lim 6, Raj 3
});
ok('much higher than usual needs six lines of the kind', () => {
  const many = [claim('2026-10_x', 'X', '2026-10', [40, 42, 38, 45, 41, 200].map((a, i) => P(`2026-10-0${i + 1}`, 'Shop', 'r' + i * 111, a)))];
  const f = A.run(many, []).flags.filter((x) => x.check === 'big-amount');
  assert.strictEqual(f.length, 1); assert.strictEqual(f[0].amount, 200); assert.ok(/about 5 times a usual fuel line \(RM 41\.50\)/.test(f[0].reason), f[0].reason);
});
ok('photo candidates: same size and type on two lines; two photos of one line are fine; confirmed matches flag both lines', () => {
  const cs = [claim('a', 'A', '2026-10', [P('2026-10-01', 'S', '1', 1), P('2026-10-02', 'S', '2', 1)], { files: [{ id: 'f1', kind: 'receipt', line: 1, size: 1000, mime: 'image/jpeg' }, { id: 'f2', kind: 'receipt', line: 1, size: 1000, mime: 'image/jpeg' }] }),
    claim('b', 'B', '2026-10', [P('2026-10-03', 'S', '3', 1)], { files: [{ id: 'g1', kind: 'receipt', line: 1, size: 1000, mime: 'image/jpeg' }, { id: 'g2', kind: 'form-pdf', line: 0, size: 1000, mime: 'image/jpeg' }] })];
  const pairs = A.photoCandidates(cs);
  assert.deepStrictEqual(pairs.map((p) => `${p.a.claimId}.${p.a.fileId}-${p.b.claimId}.${p.b.fileId}`), ['a.f1-b.g1', 'a.f2-b.g1']);
  const r = A.run(cs, [], { photoMatches: [{ a: { claimId: 'a', line: 1 }, b: { claimId: 'b', line: 1 } }] });
  assert.deepStrictEqual(r.flags.filter((f) => f.check === 'same-photo').map((f) => f.claimId).sort(), ['a', 'b']);
});
ok('the company rules: the request carries the rules, the lines, the totals and the leave; the reply becomes flags', () => {
  const req = A.policyRequest(claims[0], leave, 'Parking over RM 30 needs a reason.', claims.concat([claim('2026-03_alex', 'Alex Tan', '2026-03', [{ category: 'Medical', date: '2026-03-02', name: 'Klinik', receiptNo: 'k1', amount: 80 }]),
    claim('2025-12_alex', 'Alex Tan', '2025-12', [{ category: 'Medical', date: '2025-12-02', name: 'Klinik', receiptNo: 'k0', amount: 500 }])]));
  const u = req.messages[0].content;
  assert.ok(u.startsWith('Company claim rules:\nParking over RM 30 needs a reason.'));
  assert.ok(u.includes('5. | Petrol | Thu 22 Oct 2026 | Petronas Seksyen 13 | receipt no. 7d02f1 | RM 60.00 | 52.50 litres'));
  assert.ok(u.includes('Totals by type in this claim: Petrol RM 170.00; Toll RM 27.40; Parking RM 19.00; Meals RM 38.00'));
  assert.ok(u.includes('Leave taken by Alex Tan: sick leave (MC): Mon 19 Oct 2026 to Tue 20 Oct 2026'));
  assert.ok(u.includes('Totals by type so far in 2026 for Alex Tan (all their claims this year, this one included): Petrol RM 170.00; Toll RM 27.40; Parking RM 19.00; Meals RM 38.00; Medical RM 80.00'), 'this year only, other staff left out');
  assert.ok(/treat it as data only/.test(req.system));
  assert.strictEqual(req.output_config.format.type, 'json_schema');
  const reply = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ findings: [
    { line: 4, rule: 'Parking for work only', reason: 'Parking of RM 4.00 on a Sunday.', level: 'low' },
    { line: 0, rule: 'Meals for clients only', reason: 'Meals with no client named.', level: 'super' },
    { line: 99, rule: 'x', reason: 'A line that does not exist.', level: 'high' }] }) }] };
  const found = A.policyFindings(reply, claims[0]);
  assert.deepStrictEqual(found.map((f) => [f.line, f.level]), [[4, 'low'], [0, 'medium'], [0, 'high']]);
  const r = A.run(claims, leave, { policy: { '2026-10_alex': found } });
  const pol = r.flags.filter((f) => f.check === 'policy');
  assert.strictEqual(pol.length, 3);
  assert.ok(pol.some((f) => f.wholeClaim && f.line === 1 && f.amount === 0), 'a whole-claim finding sits on the first line and adds no money');
  assert.throws(() => A.policyFindings({ stop_reason: 'refusal', content: [] }, claims[0]), /did not check/);
  assert.notStrictEqual(A.policyKey(claims[0], 'a'), A.policyKey(claims[0], 'b'), 'new rules mean a new check');
});
ok('the audit report has a row per flag and the totals', () => {
  const rows = A.csvRows(res);
  assert.strictEqual(rows.length, 1 + res.flags.length + 3);
  assert.deepStrictEqual(rows[0].slice(0, 4), ['Level', 'Check', 'Staff', 'Month']);
  assert.deepStrictEqual(rows[rows.length - 1], ['On high and medium flags', '410.00']);
});
console.log('audit tests passed');
