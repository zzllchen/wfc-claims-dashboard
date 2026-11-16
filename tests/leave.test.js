/* node tests/leave.test.js - the dates and sums behind the Leave tab */
'use strict';
const assert = require('assert');
const K = require('../js/leave.js');

// ranges read cleanly
assert.strictEqual(K.rangeText('2026-11-05', '2026-11-05'), '5 Nov 2026');
assert.strictEqual(K.rangeText('2026-11-05', '2026-11-09'), '5 – 9 Nov 2026');
assert.strictEqual(K.rangeText('2026-11-28', '2026-12-02'), '28 Nov – 2 Dec 2026');
assert.strictEqual(K.rangeText('2026-12-30', '2027-01-02'), '30 Dec 2026 – 2 Jan 2027');
assert.strictEqual(K.rangeText('nope', '2026-11-05'), '');
assert.strictEqual(K.dayWord(1), '1 day'); assert.strictEqual(K.dayWord(3), '3 days'); assert.strictEqual(K.dayWord(0.5), '0.5 days'); assert.strictEqual(K.dayWord(2.5), '2.5 days');

const L = (claimant, start, end, days, extra) => Object.assign({ claimant, type: 'annual', start, end, days, status: 'new', files: [] }, extra);
const today = '2026-11-16';

// where a leave application sits in time
assert.strictEqual(K.when(L('a', '2026-11-16', '2026-11-18', 3), today), 'away', 'starts today');
assert.strictEqual(K.when(L('a', '2026-11-13', '2026-11-16', 2), today), 'away', 'ends today');
assert.strictEqual(K.when(L('a', '2026-11-10', '2026-11-12', 3), today), 'past');
assert.strictEqual(K.when(L('a', '2026-11-17', '2026-11-17', 1), today), 'soon');
assert.strictEqual(K.when(L('a', '2026-12-16', '2026-12-16', 1), today), 'soon', 'exactly 30 days ahead is still soon');
assert.strictEqual(K.when(L('a', '2026-12-17', '2026-12-18', 2), today), 'later');
assert.strictEqual(K.whenText(L('a', '2026-11-14', '2026-11-18', 3), today), 'Away now');
assert.strictEqual(K.whenText(L('a', '2026-11-14', '2026-11-16', 3), today), 'Away now, back tomorrow');
assert.strictEqual(K.whenText(L('a', '2026-11-17', '2026-11-17', 1), today), 'Starts tomorrow');
assert.strictEqual(K.whenText(L('a', '2026-11-25', '2026-11-26', 2), today), 'Starts in 9 days');
assert.strictEqual(K.whenText(L('a', '2026-10-01', '2026-10-02', 2), today), '');
assert.strictEqual(K.whenText(L('a', '2027-02-01', '2027-02-02', 2), today), '');

// the side card: who is away now, who is coming up (soonest first)
const list = [L('Raj', '2026-11-25', '2026-11-27', 3), L('Alex', '2026-11-14', '2026-11-18', 3), L('Siti', '2026-11-17', '2026-11-17', 1), L('Old', '2026-09-01', '2026-09-02', 2), L('Far', '2027-03-01', '2027-03-02', 2), L('Lim', '2026-11-16', '2026-11-16', 1)];
const split = K.awaySplit(list, today);
assert.deepStrictEqual(split.now.map((c) => c.claimant), ['Alex', 'Lim']);
assert.deepStrictEqual(split.soon.map((c) => c.claimant), ['Siti', 'Raj']);

// days taken in a year, per person, biggest first, by type
const year = [L('Alex', '2026-03-02', '2026-03-04', 3), L('Alex', '2026-11-14', '2026-11-18', 3, { type: 'sick' }), L('Raj', '2026-05-01', '2026-05-01', 1), L('Raj', '2026-06-02', '2026-06-02', 0.5, { type: 'personal' }), L('Siti', '2025-12-30', '2026-01-02', 2), L('Nobody', '2027-01-04', '2027-01-04', 1)];
const by = K.daysByPerson(year, 2026);
assert.deepStrictEqual(by.map((e) => [e.name, e.total]), [['Alex', 6], ['Raj', 1.5]], 'counted by the year the leave starts in');
assert.deepStrictEqual(by[0].byType, { annual: 3, sick: 3 });
assert.deepStrictEqual(by[1].byType, { annual: 1, personal: 0.5 });
assert.deepStrictEqual(K.daysByPerson(year, 2025).map((e) => e.name), ['Siti']);
assert.deepStrictEqual(K.daysByPerson([], 2026), []);
assert.deepStrictEqual(K.daysByPerson([L('x', '2026-01-01', '2026-01-01', 'abc')], 2026)[0].total, 0, 'a bad number counts as zero');
assert.strictEqual(K.typeOf({ type: 'honeymoon' }), 'other');

// the Excel export
const rows = K.csvRows([L('Alex', '2026-11-05', '2026-11-07', 3, { reason: 'Trip', signedOn: '2026-11-02', note: 'ok', status: 'recorded', files: [{ kind: 'mc' }], from: 'a@b.com', to: 'c@d.com', subject: 'Leave', updatedAt: '2026-11-02T10:00:00Z' })], { recorded: 'Recorded' });
assert.strictEqual(rows.length, 2);
assert.deepStrictEqual(rows[1], ['Alex', 'Annual leave', '2026-11-05', '2026-11-07', 3, 'Trip', '2026-11-02', 'Yes', 'Recorded', 'ok', '2026-11-02T10:00:00Z', 'a@b.com', 'c@d.com', 'Leave']);
assert.strictEqual(rows[0].length, rows[1].length, 'header and row have the same number of columns');

console.log('leave tests passed');
