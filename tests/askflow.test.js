/* node tests/askflow.test.js - Ask Flow's lookup engine (js/askflow.js): the numbers come from the records, Claude only plans and phrases */
'use strict';
const assert = require('assert');
global.window = global;
require('../js/carbon.js');
const A = require('../js/askflow.js');
const ok = (name, fn) => Promise.resolve(fn()).then(() => console.log('ok  ' + name));

const claims = [
  { claimant: 'Alex Tan', month: '2026-10', monthLabel: 'October 2026', total: 175.64, status: 'new', updatedAt: '2026-11-03T02:00:00Z', lines: [
    { category: 'Petrol', date: '2026-10-03', name: 'Kejayaan Teguh', receiptNo: 'a41c9e', amount: 60, litres: 30.151, fuel: 'petrol' },
    { category: 'Petrol', date: '2026-10-11', name: 'Kejayaan Teguh', receiptNo: '', amount: 55.64 },
    { category: 'Toll', date: '2026-10-31', name: "Touch 'n Go", receiptNo: '', amount: 60 },
  ] },
  { claimant: 'Raj Kumar', month: '2026-10', monthLabel: 'October 2026', total: 120, status: 'checked', updatedAt: '2026-11-04T02:00:00Z', lines: [
    { category: 'Petrol', date: '2026-10-02', name: 'Petronas Bangi', receiptNo: 'e90b13', amount: 120, litres: 60.302, fuel: 'petrol' },
  ] },
  { claimant: 'Alex Tan', month: '2026-09', monthLabel: 'September 2026', total: 80, status: 'paid', updatedAt: '2026-10-02T02:00:00Z', lines: [
    { category: 'Petrol', date: '2026-09-05', name: 'Kejayaan Teguh', receiptNo: '9ad3c0', amount: 60, litres: 30.151, fuel: 'petrol' },
    { category: 'Medical', date: '2026-09-12', name: 'Klinik Putra Care', receiptNo: '5521', amount: 20 },
  ] },
];
const leave = [
  { claimant: 'Alex Tan', type: 'annual', start: '2026-11-24', end: '2026-11-25', days: 2, status: 'new', reason: 'Hometown visit' },
  { claimant: 'Raj Kumar', type: 'sick', start: '2026-11-10', end: '2026-11-10', days: 1, status: 'recorded', reason: 'Fever' },
  { claimant: 'Siti Aminah', type: 'annual', start: '2026-11-27', end: '2026-12-02', days: 4, status: 'new', reason: '' },
];
const t = A.tables(claims, leave);
const plan = (over) => Object.assign({ lang: 'en', table: 'lines', filters: { staff: [], month: [], category: [], status: [], leaveType: [], dateFrom: '', dateTo: '', missingReceiptNo: false, text: '' },
  groupBy: 'none', measure: 'amount', sort: 'desc', limit: 10, chart: 'number', title: 'x', unanswerable: '' }, over, { filters: Object.assign({ staff: [], month: [], category: [], status: [], leaveType: [], dateFrom: '', dateTo: '', missingReceiptNo: false, text: '' }, (over || {}).filters) });

(async () => {
  await ok('fuel in October by person: exact sums from the records', () => {
    const r = A.run(plan({ filters: { month: ['2026-10'], category: ['fuel'] }, groupBy: 'staff', chart: 'bar' }), t);
    assert.deepStrictEqual(r.groups.map((g) => [g.label, g.value]), [['Raj Kumar', 120], ['Alex Tan', 115.64]]);
    assert.strictEqual(r.total, 235.64); assert.strictEqual(r.count, 3); assert.strictEqual(r.unit, 'RM');
  });
  await ok('carbon this month vs last month: grouped by month, the change worked out here', () => {
    const r = A.run(plan({ filters: { month: ['2026-09', '2026-10'] }, groupBy: 'month', measure: 'kgCO2', chart: 'column' }), t);
    assert.deepStrictEqual(r.groups.map((g) => [g.label, g.value]), [['Sep 2026', 69], ['Oct 2026', 271.1]]);
    assert.deepStrictEqual(r.change, { from: 'Sep 2026', to: 'Oct 2026', diff: 202.1, pct: 292.9 });
    assert.ok(r.columns.includes('kgCO2'));
  });
  await ok('who is on leave next week: any overlap with the period, as a list', () => {
    const r = A.run(plan({ table: 'leave', filters: { dateFrom: '2026-11-23', dateTo: '2026-11-29' }, chart: 'list', sort: 'time', measure: 'days' }), t);
    assert.deepStrictEqual(r.rows.map((x) => [x.staff, x.type, x.start]), [['Alex Tan', 'Annual leave', '2026-11-24'], ['Siti Aminah', 'Annual leave', '2026-11-27']]);
  });
  await ok('MC means sick leave; leave measures fall back to days', () => {
    const r = A.run(plan({ table: 'leave', filters: { leaveType: ['MC'] }, measure: 'amount' }), t);
    assert.strictEqual(r.count, 1); assert.strictEqual(r.measure, 'days'); assert.strictEqual(r.total, 1);
  });
  await ok('lines with no receipt number (toll and parking carry a statement number, so they are left out)', () => {
    const r = A.run(plan({ filters: { missingReceiptNo: true }, chart: 'list' }), t);
    assert.deepStrictEqual(r.rows.map((x) => [x.staff, x.shop, x.amount]), [['Alex Tan', 'Kejayaan Teguh', 55.64]]);
  });
  await ok('names match loosely, and a total claim figure comes from the claims table', () => {
    const r = A.run(plan({ table: 'claims', filters: { staff: ['alex'] }, groupBy: 'month', measure: 'amount', chart: 'column' }), t);
    assert.deepStrictEqual(r.groups.map((g) => [g.key, g.value]), [['2026-09', 80], ['2026-10', 175.64]]);
  });
  await ok('top 5 limit, and "none" answers nothing', () => {
    assert.strictEqual(A.run(plan({ groupBy: 'shop', limit: 1 }), t).groups.length, 1);
    assert.strictEqual(A.run(plan({ table: 'none' }), t).empty, true);
  });
  await ok('the plan request carries names and months only, never amounts; both requests stay small', () => {
    const big = A.tables(Array.from({ length: 300 }, (_, i) => Object.assign({}, claims[0], { claimant: 'Staff ' + (i % 40) })), leave);
    const pr = A.planRequest('How much fuel did we claim in October?', big, '2026-11-18');
    assert.ok(!/60\.00|55\.64|175\.64/.test(pr.messages[0].content), 'no amounts in the plan step');
    assert.ok(/Today: 2026-11-18 \(Wednesday\)/.test(pr.messages[0].content));
    assert.ok(pr.system.length < 20000 && pr.messages[0].content.length < 60000);
    assert.strictEqual(pr.output_config.format.type, 'json_schema');
    const r = A.run(plan({ chart: 'list', limit: 50 }), big);
    const ar = A.answerRequest('q', plan({}), r);
    assert.ok(ar.messages[0].content.length < 60000, 'at most 25 rows go to the answer step');
  });
  await ok('the whole question: two calls, plan then answer, thinking blocks skipped', async () => {
    const sent = [];
    const send = async (req) => {
      sent.push(req);
      const body = sent.length === 1 ? JSON.stringify(plan({ lang: 'ms', filters: { month: ['2026-10'], category: ['Petrol'] }, groupBy: 'staff', chart: 'bar', title: 'Minyak ikut staf' }))
        : JSON.stringify({ answer: 'Jumlah minyak Oktober ialah RM 235.64.', speech: 'Jumlah minyak Oktober ialah 235 ringgit 64 sen.', highlights: [{ label: 'Jumlah', value: 'RM 235.64' }] });
      return { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: body }], stop_reason: 'end_turn' };
    };
    const out = await A.ask('Berapa jumlah minyak bulan Oktober?', { claims, leave, today: '2026-11-18', send });
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(out.result.total, 235.64);
    assert.ok(/235\.64/.test(sent[1].messages[0].content), 'the answer step sees the worked-out figures');
    assert.ok(/Bahasa Melayu/.test(sent[1].messages[0].content));
    assert.strictEqual(out.answer.highlights[0].value, 'RM 235.64');
  });
  await ok('a question the records cannot answer: one call, a plain reason', async () => {
    let n = 0;
    const send = async () => { n++; return { content: [{ type: 'text', text: JSON.stringify(plan({ table: 'none', unanswerable: 'The records do not hold salaries.' })) }], stop_reason: 'end_turn' }; };
    const out = await A.ask('What is Alex paid?', { claims, leave, today: '2026-11-18', send });
    assert.strictEqual(n, 1); assert.strictEqual(out.answer.answer, 'The records do not hold salaries.');
  });
  await ok('a refusal or unreadable reply is a plain error', () => {
    assert.throws(() => A.replyJson({ stop_reason: 'refusal', content: [] }), /did not answer/);
    assert.throws(() => A.replyJson({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'nope' }] }), /could not read/);
  });
  console.log('askflow tests passed');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
