/* Export for AutoCount: the claims as journal entries in one Excel file, so the accountant imports them instead of typing them.
   AutoCount: Journal Entry > Import From Excel (the first sheet, "Journal"). Each claim is one document: a debit line per receipt (or per account)
   on the expense account of its type, and one credit line on the staff-claims payable account, so every document balances.
   The DocNo is made from the claim itself, so exporting the same claim again updates that entry instead of adding a second one.
   NOT YET CONFIRMED against the accountant's own AutoCount template: the column names follow AutoCount's published naming (DocNo, DocDate as
   dd/MM/yyyy, AccNo ...) and every one can be renamed in the export window to match it. Account codes starting "TBC-" are placeholders.
   Pure and tested in node (tests/autocount.test.js); the xlsx file is made with JSZip. */
(function (root) {
  'use strict';
  const CATEGORIES = ['Petrol', 'Toll', 'Parking', 'Medical', 'AI tools', 'Accommodation', 'Meals', 'Stationery', 'Travel', 'Transport', 'Online shopping', 'Supplier invoice', 'Other'];
  const COLUMNS = ['DocNo', 'DocDate', 'JournalType', 'Description', 'CurrencyCode', 'CurrencyRate', 'AccNo', 'ToAccountRate', 'DetailDescription', 'DR', 'CR'];
  const code = (c) => 'TBC-' + c.toUpperCase().replace(/[^A-Z]+/g, '').slice(0, 8);
  const defaults = () => ({
    journalType: 'GENERAL', payable: 'TBC-CLAIMPAY', prefix: 'CL', dateMode: 'monthEnd', grouping: 'receipt',
    accounts: Object.fromEntries(CATEGORIES.map((c) => [c, code(c)])),
    headers: Object.fromEntries(COLUMNS.map((c) => [c, c])),
  });
  // saved settings over the defaults (anything missing or odd falls back)
  function settings(saved) {
    const d = defaults(), s = saved || {};
    ['journalType', 'payable', 'prefix'].forEach((k) => { if (typeof s[k] === 'string' && s[k].trim()) d[k] = s[k].trim(); });
    if (s.dateMode === 'sent' || s.dateMode === 'monthEnd') d.dateMode = s.dateMode;
    if (s.grouping === 'account' || s.grouping === 'receipt') d.grouping = s.grouping;
    CATEGORIES.forEach((c) => { const v = s.accounts && s.accounts[c]; if (typeof v === 'string' && v.trim()) d.accounts[c] = v.trim(); });
    COLUMNS.forEach((c) => { const v = s.headers && s.headers[c]; if (typeof v === 'string' && v.trim()) d.headers[c] = v.trim(); });
    return d;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const r2 = (n) => Math.round((Number(n) + Math.sign(Number(n)) * 1e-9) * 100) / 100;
  const cut = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const categoryOf = (c) => (CATEGORIES.includes(c) ? c : 'Other');
  // a short, repeatable tag of the claim id (so two people with similar names never share a number)
  const tag = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36).toUpperCase().padStart(4, '0').slice(-4); };
  // "CL2610-ALEXTAN-1X9K": at most 20 characters, which is AutoCount's limit for a document number
  function docNo(claim, cfg) {
    const head = cut(cfg.prefix, 3).replace(/\s/g, '') + String(claim.month || '').slice(2, 4) + String(claim.month || '').slice(5, 7) + '-';
    const name = String(claim.claimant || 'STAFF').toUpperCase().replace(/[^A-Z0-9]+/g, '') || 'STAFF';
    return (head + name.slice(0, Math.max(0, 20 - head.length - 5)) + '-' + tag(String(claim.id || claim.claimant + claim.month))).slice(0, 20);
  }
  // 'YYYY-MM-DD': the last day of the claim month, or the day the claim was sent (Malaysia time)
  function docDate(claim, cfg) {
    if (cfg.dateMode === 'sent') { const t = Date.parse(claim.updatedAt || ''); if (!isNaN(t)) return new Date(t + 8 * 3600e3).toISOString().slice(0, 10); }
    const m = /^(\d{4})-(\d{2})$/.exec(claim.month || '');
    if (!m) return '';
    return `${m[1]}-${m[2]}-${pad(new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate())}`;
  }
  const shortDay = (iso) => { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[2]}/${m[1]}` : ''; };

  /* claims -> { header, rows, docs, total, lines, placeholders, problems }; each row follows COLUMNS */
  function build(claims, saved) {
    const cfg = settings(saved);
    const rows = [], docs = [], problems = [], used = new Set(), seen = new Set();
    let total = 0, count = 0;
    (claims || []).forEach((c) => {
      const date = docDate(c, cfg);
      if (!date) { problems.push(`${c.claimant}: no claim month, left out.`); return; }
      const good = (c.lines || []).filter((l) => isFinite(Number(l.amount)) && r2(l.amount) > 0);
      if (good.length !== (c.lines || []).length) problems.push(`${c.claimant} ${c.monthLabel || c.month}: ${(c.lines || []).length - good.length} line(s) with no amount left out.`);
      if (!good.length) return;
      let no = docNo(c, cfg);
      for (let i = 2; seen.has(no); i++) no = docNo(c, cfg).slice(0, 18) + '-' + i;
      seen.add(no);
      const sum = r2(good.reduce((t, l) => t + r2(l.amount), 0));
      if (c.total != null && Math.abs(r2(c.total) - sum) > 0.005) problems.push(`${c.claimant} ${c.monthLabel || c.month}: lines add up to RM ${sum.toFixed(2)} but the claim says RM ${r2(c.total).toFixed(2)}. The lines are exported.`);
      const what = cut(`Staff claim ${c.monthLabel || c.month} - ${c.claimant}`, 80);
      const head = [no, { date }, cut(cfg.journalType, 10), what, 'MYR', 1];
      let debits;
      if (cfg.grouping === 'account') {
        const by = new Map();
        good.forEach((l) => { const a = cfg.accounts[categoryOf(l.category)]; const g = by.get(a) || { account: a, kinds: new Set(), amount: 0, n: 0 }; g.kinds.add(categoryOf(l.category)); g.amount = r2(g.amount + r2(l.amount)); g.n++; by.set(a, g); });
        debits = Array.from(by.values()).map((g) => ({ account: g.account, text: cut(`${Array.from(g.kinds).join(', ')} (${g.n} receipt${g.n > 1 ? 's' : ''}) - ${c.claimant}`, 100), amount: g.amount }));
      } else {
        debits = good.map((l) => ({ account: cfg.accounts[categoryOf(l.category)], text: cut([categoryOf(l.category), shortDay(l.date), l.name, l.receiptNo ? '#' + l.receiptNo : '', '- ' + c.claimant].filter(Boolean).join(' '), 100), amount: r2(l.amount) }));
      }
      debits.forEach((d) => { used.add(d.account); rows.push(head.concat([cut(d.account, 12), 1, d.text, d.amount, 0])); });
      used.add(cfg.payable);
      rows.push(head.concat([cut(cfg.payable, 12), 1, cut(`Claim payable - ${c.claimant} - ${c.monthLabel || c.month}`, 100), 0, sum]));
      docs.push({ docNo: no, claimant: c.claimant, month: c.monthLabel || c.month, status: c.status || '', lines: good.length, total: sum, date });
      total = r2(total + sum); count += good.length;
    });
    return { header: COLUMNS.map((k) => cfg.headers[k]), rows, docs, total, lines: count, problems, placeholders: Array.from(used).filter((a) => /^TBC-/i.test(a)), settings: cfg };
  }

  /* ---------- a small .xlsx writer: text, numbers and dates, a bold first row ---------- */
  const xml = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colName = (i) => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
  const serial = (iso) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 864e5);
  function sheetXml(rows, widths) {
    const body = rows.map((r, y) => `<row r="${y + 1}">` + r.map((v, x) => {
      const ref = colName(x) + (y + 1);
      if (v == null || v === '') return '';
      if (typeof v === 'object' && v.date) return `<c r="${ref}" s="2"><v>${serial(v.date)}</v></c>`;
      if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"${Number.isInteger(v) ? '' : ' s="3"'}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${y === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    }).join('') + '</row>').join('');
    const cols = widths ? '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
  }
  /* [{ name, rows, widths }] -> the files of a workbook (a map of path -> text), ready to zip */
  function workbookFiles(sheets) {
    const files = {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        + sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    };
    sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows, s.widths); });
    return files;
  }
  /* the two sheets of the export: what AutoCount imports, and a one-line-per-claim list to check the totals against */
  function sheetsOf(out) {
    return [
      { name: 'Journal', rows: [out.header].concat(out.rows), widths: [22, 12, 12, 44, 10, 10, 14, 10, 62, 11, 11] },
      { name: 'Check', rows: [['DocNo', 'Staff', 'Month', 'Status', 'Receipts', 'Total (RM)']].concat(out.docs.map((d) => [d.docNo, d.claimant, d.month, d.status, d.lines, d.total]), [['', 'Total', '', '', out.lines, out.total]]), widths: [22, 24, 18, 10, 10, 13] },
    ];
  }
  async function xlsxBlob(out, JSZipClass) {
    const Zip = JSZipClass || root.JSZip, zip = new Zip(), files = workbookFiles(sheetsOf(out));
    Object.keys(files).forEach((p) => zip.file(p, files[p]));
    return zip.generateAsync({ type: JSZipClass ? 'nodebuffer' : 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  const api = { CATEGORIES, COLUMNS, defaults, settings, docNo, docDate, build, sheetsOf, workbookFiles, xlsxBlob, serial, colName };
  root.AutoCount = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
