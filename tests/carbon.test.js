/* node tests/carbon.test.js - the carbon of business travel, from the fuel on the claims (js/carbon.js) */
'use strict';
const assert = require('assert');
const C = require('../js/carbon.js');
const ok = (name, fn) => { fn(); console.log('ok  ' + name); };

const claims = [
  { claimant: 'Alex Tan', month: '2026-10', monthLabel: 'October 2026', lines: [
    { category: 'Petrol', date: '2026-10-03', name: 'Kejayaan Teguh', receiptNo: 'a41c9e', amount: 60, litres: 30.151, fuel: 'petrol' },
    { category: 'Petrol', date: '2026-10-10', name: 'Shell Subang', receiptNo: '88213', amount: 59.7 },           // no litres read: estimated
    { category: 'Toll', date: '2026-10-31', name: "Touch 'n Go", amount: 41.2 },
    { category: 'Medical', date: '2026-10-12', name: 'Klinik', amount: 75 },
  ] },
  { claimant: 'Raj Kumar', month: '2026-09', monthLabel: 'September 2026', lines: [
    { category: 'Petrol', date: '2026-09-07', name: 'Petronas Bangi', amount: 50, litres: 16.9, fuel: 'diesel' },
  ] },
];

ok('litres from the slip x the factor; petrol 2.29, diesel 2.66 kg a litre', () => {
  assert.deepStrictEqual(C.lineCarbon(claims[0].lines[0]), { fuel: 'petrol', litres: 30.151, kg: 69, estimated: false });
  assert.deepStrictEqual(C.lineCarbon(claims[1].lines[0]), { fuel: 'diesel', litres: 16.9, kg: 45, estimated: false });
});
ok('no litres: estimated from the amount at RM1.99 a litre, and marked as estimated', () => {
  assert.deepStrictEqual(C.lineCarbon(claims[0].lines[1]), { fuel: 'petrol', litres: 30, kg: 68.7, estimated: true });
});
ok('tolls, parking, medical and empty fuel lines add nothing (the fuel already covers the driving)', () => {
  assert.strictEqual(C.lineCarbon(claims[0].lines[2]), null);
  assert.strictEqual(C.lineCarbon(claims[0].lines[3]), null);
  assert.strictEqual(C.lineCarbon({ category: 'Petrol', amount: 0 }), null);
});
ok('totals, by person and by month', () => {
  const s = C.summarise(claims);
  assert.strictEqual(s.slips, 3); assert.strictEqual(s.estimated, 1);
  assert.strictEqual(s.kg, 182.7); assert.strictEqual(s.litres, 77.1);
  assert.deepStrictEqual(s.byStaff.map((p) => [p.name, p.kg]), [['Alex Tan', 137.7], ['Raj Kumar', 45]]);
  assert.deepStrictEqual(s.byMonth.map((m) => [m.month, m.kg]), [['2026-09', 45], ['2026-10', 137.7]], 'months in order');
});
ok('weights read naturally', () => {
  assert.strictEqual(C.weight(412.4), '412 kg'); assert.strictEqual(C.weight(1234), '1.23 t'); assert.strictEqual(C.weight(0), '0 kg');
});
ok('the export: one row per fuel slip, a total and the method', () => {
  const rows = C.csvRows(claims);
  assert.strictEqual(rows[0][9], 'kg CO2e');
  assert.strictEqual(rows.filter((r) => r.length === 11).length, 1 + 3 + 1, 'header, three slips, total');
  assert.ok(rows.some((r) => r[0] === 'Method' && /IPCC/.test(r[1])));
  assert.strictEqual(rows[1][0], 'Raj Kumar', 'earliest month first');
});
console.log('carbon tests passed');
