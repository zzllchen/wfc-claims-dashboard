/* The leave side of the dashboard, the parts that are only sums and dates (no drawing), so they can be tested without a browser.
   A leave application: { claimant, type, start, end, days, ... } with dates as YYYY-MM-DD. */
(function (root) {
  'use strict';
  const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const TYPES = ['annual', 'sick', 'personal', 'unpaid', 'other'];
  const TYPE_LABEL = { annual: 'Annual leave', sick: 'Sick leave', unpaid: 'Unpaid leave', personal: 'Personal leave', other: 'Other leave' };
  const pad = (n) => String(n).padStart(2, '0');
  const dayNo = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 864e5);
  const isoOf = (no) => new Date(no * 864e5).toISOString().slice(0, 10);
  const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const typeOf = (c) => (TYPES.includes(c && c.type) ? c.type : 'other');

  /* "5 Nov 2026", "5 - 9 Nov 2026", "28 Nov - 2 Dec 2026", "30 Dec 2026 - 2 Jan 2027" (a thin dash with spaces reads cleanly) */
  function rangeText(start, end) {
    const f = new Date(start + 'T00:00:00Z'), t = new Date(end + 'T00:00:00Z');
    if (isNaN(f) || isNaN(t)) return '';
    const d = (x) => x.getUTCDate(), m = (x) => SHORT[x.getUTCMonth()], y = (x) => x.getUTCFullYear();
    if (start === end) return `${d(f)} ${m(f)} ${y(f)}`;
    if (y(f) === y(t) && f.getUTCMonth() === t.getUTCMonth()) return `${d(f)} – ${d(t)} ${m(f)} ${y(f)}`;
    if (y(f) === y(t)) return `${d(f)} ${m(f)} – ${d(t)} ${m(t)} ${y(f)}`;
    return `${d(f)} ${m(f)} ${y(f)} – ${d(t)} ${m(t)} ${y(t)}`;
  }

  const dayWord = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)} ${n === 1 ? 'day' : 'days'}`;

  /* where a leave application sits in time, as of today: 'away' (today is inside it), 'soon' (starts within `horizon` days), 'later', or 'past' */
  function when(c, today, horizon) {
    if (c.start <= today && today <= c.end) return 'away';
    if (c.end < today) return 'past';
    return dayNo(c.start) - dayNo(today) <= (horizon || 30) ? 'soon' : 'later';
  }

  /* a short phrase for the Dates column: "Away now", "Starts tomorrow", "Starts in 9 days", or '' */
  function whenText(c, today) {
    const w = when(c, today, 30);
    if (w === 'away') return c.end === today ? 'Away now, back tomorrow' : 'Away now';
    if (w !== 'soon') return '';
    const n = dayNo(c.start) - dayNo(today);
    return n === 1 ? 'Starts tomorrow' : `Starts in ${n} days`;
  }

  /* who is away today and who is about to be, for the side card */
  function awaySplit(list, today, horizon) {
    const byStart = (a, b) => a.start.localeCompare(b.start) || a.claimant.localeCompare(b.claimant);
    return {
      now: list.filter((c) => when(c, today, horizon) === 'away').sort(byStart),
      soon: list.filter((c) => when(c, today, horizon) === 'soon').sort(byStart),
    };
  }

  /* days taken in a year, per person, biggest first: [{ name, total, byType: { annual: 5, sick: 1 } }] (by the year the leave starts in) */
  function daysByPerson(list, year) {
    const by = new Map();
    list.filter((c) => String(c.start).slice(0, 4) === String(year)).forEach((c) => {
      const e = by.get(c.claimant) || { name: c.claimant, total: 0, byType: {} };
      e.total += Number(c.days) || 0; e.byType[typeOf(c)] = (e.byType[typeOf(c)] || 0) + (Number(c.days) || 0);
      by.set(c.claimant, e);
    });
    return Array.from(by.values()).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }

  const hasMc = (c) => (c.files || []).some((f) => f.kind === 'mc');

  /* rows for the Excel (CSV) export: one row per leave application */
  function csvRows(list, statusWord) {
    const rows = [['Staff', 'Type', 'From', 'To', 'Days', 'Reason', 'Signed on', 'MC attached', 'Status', 'Note', 'Sent', 'From', 'To', 'Subject']];
    list.forEach((c) => rows.push([c.claimant, TYPE_LABEL[typeOf(c)], c.start, c.end, c.days, c.reason, c.signedOn, hasMc(c) ? 'Yes' : '', statusWord[c.status] || c.status, c.note, c.updatedAt, c.from, c.to, c.subject]));
    return rows;
  }

  const api = { TYPES, TYPE_LABEL, typeOf, rangeText, dayWord, when, whenText, awaySplit, daysByPerson, hasMc, csvRows, dayNo, isoOf, localIso };
  root.LeaveKit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
