/* node tests/subs.test.js - the subscription finder (js/subs.js): tools found from claim lines, yearly figures, and what can be saved */
'use strict';
const assert = require('assert');
const S = require('../js/subs.js');
const ok = (name, fn) => { fn(); console.log('ok  ' + name); };

const claim = (id, claimant, month, lines) => ({ id, claimant, month, lines: lines.map((l, i) => Object.assign({ no: i + 1, receiptNo: 'r' + i }, l)) });
const L = (category, date, name, amount) => ({ category, date, name, amount });
const claims = [
  claim('09_alex', 'Alex Tan', '2026-09', [L('AI tools', '2026-09-12', 'Runway', 52.3), L('AI tools', '2026-09-03', 'OpenAI ChatGPT Plus', 94.5), L('Petrol', '2026-09-05', 'Shell', 60)]),
  claim('10_alex', 'Alex Tan', '2026-10', [L('AI tools', '2026-10-12', 'RunwayML Inc.', 99), L('AI tools', '2026-10-03', 'ChatGPT', 94.5), L('AI tools', '2026-10-14', 'Eleven Labs', 46.7)]),
  claim('10_lim', 'Lim Wei Jie', '2026-10', [L('Software', '2026-10-06', 'OpenAI, LLC', 94.5), L('Other', '2026-10-09', 'Netflix.com', 54.9)]),
  claim('11_alex', 'Alex Tan', '2026-11', [L('AI tools', '2026-11-03', 'ChatGPT', 94.5)]),
  claim('10_ewe', 'EWE CHWAN YAW', '2026-10', [L('AI DEVICE', '2026-11-11', 'Plaud Note', 465), L('Subscription', '2026-10-20', 'Some Studio Sdn Bhd', 30)]),
];
const res = S.find(claims);
const tool = (n) => res.tools.find((t) => t.name === n);

ok('known tools are named the same however the receipt writes them; devices and fuel are not tools', () => {
  assert.deepStrictEqual(res.tools.map((t) => t.name).sort(), ['ChatGPT', 'ElevenLabs', 'Netflix', 'Runway', 'Some Studio'].sort());
  assert.strictEqual(S.toolOf({ category: 'AI DEVICE', name: 'Plaud Note' }), null);
  assert.strictEqual(S.toolOf({ category: 'Petrol', name: 'Shell' }), null);
  assert.deepStrictEqual(S.toolOf({ category: 'Other', name: 'Canva Pty Ltd' }), { name: 'Canva', personal: false, known: true });
});
ok('paid in two or more months counts as monthly, with a yearly figure at the latest amount; one payment does not', () => {
  const g = tool('ChatGPT');
  const alex = g.payers.find((p) => p.staff === 'Alex Tan');
  assert.deepStrictEqual(alex.months, ['2026-09', '2026-10', '2026-11']);
  assert.strictEqual(alex.monthly, 94.5); assert.strictEqual(alex.yearly, 1134);
  const lim = g.payers.find((p) => p.staff === 'Lim Wei Jie');
  assert.strictEqual(lim.recurring, false); assert.strictEqual(lim.yearly, 0);
  assert.strictEqual(tool('ElevenLabs').recurring, false);
});
ok('two people paying for the same tool in a month: the extra is shown a year', () => {
  const i = res.insights.find((x) => x.kind === 'overlap');
  assert.strictEqual(i.tool, 'ChatGPT');
  assert.strictEqual(i.title, '2 people pay for ChatGPT');
  assert.strictEqual(i.text, 'Alex Tan and Lim Wei Jie each paid in Oct 2026 (RM 189.00 together). One team plan may cost less: the extra is RM 1,134.00 a year.');
  assert.strictEqual(res.totals.overlapYear, 1134);
});
ok('a price that went up month on month', () => {
  const i = res.insights.find((x) => x.kind === 'price-up');
  assert.strictEqual(i.text, "Alex Tan's went from RM 52.30 (Sep 2026) to RM 99.00 (Oct 2026). A bigger plan, or a price rise?");
  assert.deepStrictEqual(i.open, { claimId: '10_alex', line: 1 });
});
ok('paid every month for three months: a yearly plan may be cheaper', () => {
  assert.ok(res.insights.some((x) => x.kind === 'yearly' && x.tool === 'ChatGPT' && x.text === 'Alex Tan, 3 months. A yearly plan is often cheaper.'));
});
ok('personal services are flagged first and left out of the totals', () => {
  assert.strictEqual(res.insights[0].kind, 'personal');
  assert.strictEqual(res.insights[0].text, "Lim Wei Jie claimed it (RM 54.90). Personal subscriptions aren't claimable.");
  assert.strictEqual(res.totals.tools, 4);
  // a month at the latest amounts: ChatGPT (Alex) 94.50 + Runway (Alex) 99.00
  assert.strictEqual(res.totals.monthly, 193.5); assert.strictEqual(res.totals.yearly, 2322);
  assert.strictEqual(res.totals.people, 3);
});
ok('an unknown tool typed as a subscription keeps its own (tidied) name; the spreadsheet has a row per tool and person', () => {
  assert.ok(tool('Some Studio').oneOff);
  const rows = S.csvRows(res);
  assert.deepStrictEqual(rows[0].slice(0, 3), ['Tool', 'Staff', 'Months paid']);
  assert.ok(rows.some((r) => r[0] === 'ChatGPT' && r[1] === 'Alex Tan' && r[7] === '1134.00'));
  assert.deepStrictEqual(rows[rows.length - 1].slice(0, 1).concat(rows[rows.length - 1].slice(7)), ['Total a year at the latest amounts', '2322.00']);
});
ok('nothing to find in claims with no tools', () => {
  const none = S.find([claim('x', 'X', '2026-10', [L('Petrol', '2026-10-01', 'Shell', 50)])]);
  assert.deepStrictEqual([none.tools.length, none.insights.length, none.totals.yearly], [0, 0, 0]);
});
console.log('subs tests passed');
