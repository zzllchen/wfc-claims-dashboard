/* node tests/autocount.test.js - the AutoCount export: balanced journal entries, stable document numbers, and a real .xlsx file (invented claims) */
'use strict';
const assert = require('assert');
const A = require('../js/autocount.js');
const JSZip = require('../vendor/jszip.min.js');
const ok = (name, fn) => Promise.resolve().then(fn).then(() => console.log('ok  ' + name));

const line = (category, date, name, receiptNo, amount) => ({ category, date, name, receiptNo, amount });
const claim = (id, claimant, month, lines, extra) => Object.assign({ id, claimant, month, monthLabel: 'October 2026', status: 'checked', updatedAt: '2026-11-03T20:00:00.000Z', lines, total: Math.round(lines.reduce((t, l) => t + l.amount, 0) * 100) / 100 }, extra);
const alex = claim('2026-10_alex-tan', 'Alex Tan', '2026-10', [line('Petrol', '2026-10-03', 'Shell Subang', '88213', 60), line('Petrol', '2026-10-11', 'Petronas', '5cc50b', 55.64), line('Toll', '2026-10-28', "Touch 'n Go", '113', 27.4)]);
const siti = claim('2026-10_siti-aminah', 'Siti Aminah', '2026-10', [line('Medical', '2026-10-09', 'Klinik <Putra> & Care', '5521', 75), line('AI tools', '2026-10-02', '=HYPERLINK("x")', 'CNV-1', 54.9), line('Mystery', '2026-10-05', 'Odd shop', '', 0.1), line('Mystery', '2026-10-06', 'Odd shop', '', 0.2)]);
const col = (out, row, name) => row[A.COLUMNS.indexOf(name)];

(async () => {
  await ok('every claim is one document that balances: debits per receipt, one credit to the payable account', () => {
    const out = A.build([alex, siti]);
    assert.deepStrictEqual(out.header, A.COLUMNS);
    assert.strictEqual(out.docs.length, 2);
    assert.strictEqual(out.rows.length, 3 + 1 + 4 + 1);
    out.docs.forEach((d) => {
      const rs = out.rows.filter((r) => r[0] === d.docNo);
      const dr = rs.reduce((t, r) => t + col(out, r, 'DR'), 0), cr = rs.reduce((t, r) => t + col(out, r, 'CR'), 0);
      assert.ok(Math.abs(dr - cr) < 1e-9 && Math.abs(dr - d.total) < 1e-9, `${d.docNo} ${dr} ${cr}`);
      assert.strictEqual(rs.filter((r) => col(out, r, 'CR') > 0).length, 1);
      assert.strictEqual(col(out, rs[rs.length - 1], 'AccNo'), 'TBC-CLAIMPAY');
    });
    assert.strictEqual(out.total, 273.24);
    assert.strictEqual(out.lines, 7);
  });
  await ok('document numbers: at most 20 characters, the same every time, different for look-alike names', () => {
    const a = A.docNo(alex, A.defaults()), again = A.docNo(Object.assign({}, alex, { status: 'paid' }), A.defaults());
    assert.strictEqual(a, again);
    assert.ok(a.length <= 20 && /^CL2610-ALEXTAN-[0-9A-Z]{4}$/.test(a), a);
    const x = A.docNo(claim('2026-10_muhammad-abdullah-bin-ali', 'Muhammad Abdullah bin Ali', '2026-10', [line('Petrol', '2026-10-01', 'S', '1', 1)]), A.defaults());
    const y = A.docNo(claim('2026-10_muhammad-abdullah-bin-abu', 'Muhammad Abdullah bin Abu', '2026-10', [line('Petrol', '2026-10-01', 'S', '1', 1)]), A.defaults());
    assert.ok(x.length <= 20 && y.length <= 20 && x !== y, x + ' ' + y);
  });
  await ok('the date is the last day of the claim month (February too), or the day it was sent in Malaysia', () => {
    assert.strictEqual(A.docDate(alex, A.defaults()), '2026-10-31');
    assert.strictEqual(A.docDate({ month: '2028-02' }, A.defaults()), '2028-02-29');
    assert.strictEqual(A.docDate(alex, A.settings({ dateMode: 'sent' })), '2026-11-04', '20:00 UTC is 4 am next day in Kuala Lumpur');
  });
  await ok('account codes by type, unknown types go to Other, typed codes replace the TBC placeholders', () => {
    const out = A.build([alex, siti]);
    assert.deepStrictEqual(Array.from(new Set(out.placeholders)).sort(), ['TBC-AITOOLS', 'TBC-CLAIMPAY', 'TBC-MEDICAL', 'TBC-OTHER', 'TBC-PETROL', 'TBC-TOLL']);
    const mine = A.build([alex], { payable: '400-C001', accounts: { Petrol: '900-P001', Toll: '900-T001' } });
    assert.deepStrictEqual(mine.rows.map((r) => col(mine, r, 'AccNo')), ['900-P001', '900-P001', '900-T001', '400-C001']);
    assert.deepStrictEqual(mine.placeholders, []);
  });
  await ok('one line per account adds receipts together and still balances', () => {
    const out = A.build([alex, siti], { grouping: 'account' });
    const rs = out.rows.filter((r) => r[0] === out.docs[0].docNo);
    assert.deepStrictEqual(rs.map((r) => [col(out, r, 'AccNo'), col(out, r, 'DR'), col(out, r, 'CR')]), [['TBC-PETROL', 115.64, 0], ['TBC-TOLL', 27.4, 0], ['TBC-CLAIMPAY', 0, 143.04]]);
    const other = out.rows.find((r) => col(out, r, 'AccNo') === 'TBC-OTHER');
    assert.strictEqual(col(out, other, 'DR'), 0.3, '0.1 + 0.2 stays 0.30');
  });
  await ok('lines with no amount are left out and said; a total that disagrees with its lines is said', () => {
    const bad = claim('2026-10_b', 'Bee', '2026-10', [line('Meals', '2026-10-01', 'Cafe', '1', 10), { category: 'Meals', amount: '' }], { total: 99 });
    const out = A.build([bad, claim('2026-10_c', 'Cee', '', [line('Meals', '2026-10-01', 'x', '1', 5)])]);
    assert.strictEqual(out.docs.length, 1);
    assert.strictEqual(out.problems.length, 3, out.problems.join(' | '));
  });
  await ok('column names can be renamed to match the accountant\'s template', () => {
    const out = A.build([alex], { headers: { DR: 'Debit', CR: 'Credit', DocNo: 'Voucher No' } });
    assert.deepStrictEqual([out.header[0], out.header[9], out.header[10]], ['Voucher No', 'Debit', 'Credit']);
  });
  await ok('the .xlsx opens as a zip with two sheets; text stays text, dates are real dates, nothing becomes a formula', async () => {
    const buf = await A.xlsxBlob(A.build([alex, siti]), JSZip);
    const zip = await JSZip.loadAsync(buf);
    const wb = await zip.file('xl/workbook.xml').async('string'), s1 = await zip.file('xl/worksheets/sheet1.xml').async('string'), s2 = await zip.file('xl/worksheets/sheet2.xml').async('string');
    assert.ok(/name="Journal"/.test(wb) && /name="Check"/.test(wb));
    assert.ok(s1.includes('Klinik &lt;Putra&gt; &amp; Care'), 'special characters are escaped');
    assert.ok(!/<f>/.test(s1), 'no formulas');
    assert.ok(s1.includes('=HYPERLINK(&quot;x&quot;)'));
    assert.ok(s1.includes(`<c r="B2" s="2"><v>${A.serial('2026-10-31')}</v></c>`), 'a date cell');
    assert.strictEqual(A.serial('2026-10-31'), 46326);
    assert.strictEqual(A.colName(0) + A.colName(10) + A.colName(26), 'AKAA');
    assert.ok(s2.includes('Alex Tan') && s2.includes('273.24'));
    if (process.argv[2]) require('fs').writeFileSync(process.argv[2], buf);
  });
  console.log('autocount tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
