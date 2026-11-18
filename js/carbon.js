/* The carbon of business travel, worked out from the fuel on the expense claims.
   Staff drive their own cars for work and claim the fuel, so the fuel slips are the record of how much was burned: litres x a standard factor per litre.
   In a sustainability report this is Scope 3, category 6 (business travel). Tolls and parking add nothing: the fuel already covers the driving.
   A slip whose litres could not be read is estimated from the amount paid, and marked as estimated. */
(function (root) {
  'use strict';
  // kg of CO2 per litre burned: IPCC 2006 default factors (motor gasoline 69.3 t CO2 per TJ, gas/diesel oil 74.1 t CO2 per TJ) with typical density and heat value
  const KG_PER_LITRE = { petrol: 2.29, diesel: 2.66 };
  // litres estimated from the amount at this price (RM a litre): RON95 with the Budi95 subsidy, and diesel
  const EST_PRICE = { petrol: 1.99, diesel: 2.95 };
  const SCOPE = 'Scope 3 · Business travel (staff cars)';
  const METHOD = 'Litres on each fuel slip × 2.29 kg CO₂ a litre of petrol (2.66 for diesel), the IPCC 2006 default factors. A slip whose litres could not be read is estimated from the amount at RM1.99 a litre.';

  const r1 = (n) => Math.round(n * 10) / 10;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const isFuel = (category) => /petrol|fuel|diesel/i.test(category || '');

  /* one claim line -> { fuel, litres, kg, estimated } or null when it is not fuel (or has nothing to go on) */
  function lineCarbon(l) {
    if (!l || !isFuel(l.category)) return null;
    const fuel = l.fuel === 'diesel' || /diesel/i.test(l.category) ? 'diesel' : 'petrol';
    let litres = Number(l.litres), estimated = false;
    if (!(litres > 0)) {
      const amount = Number(l.amount);
      if (!(amount > 0)) return null;
      litres = amount / EST_PRICE[fuel]; estimated = true;
    }
    return { fuel, litres: r3(litres), kg: r1(litres * KG_PER_LITRE[fuel]), estimated };
  }

  /* claims -> totals, by person and by month, and one row per fuel line (for the export) */
  function summarise(claims) {
    const rows = [];
    (claims || []).forEach((c) => (c.lines || []).forEach((l) => {
      const x = lineCarbon(l);
      if (x) rows.push(Object.assign({ staff: c.claimant, month: c.month, monthLabel: c.monthLabel, date: l.date, station: l.name, receiptNo: l.receiptNo, amount: Number(l.amount) || 0, sample: !!c.sample }, x));
    }));
    const add = (map, key, extra, x) => { const e = map.get(key) || Object.assign({ kg: 0, litres: 0, slips: 0 }, extra); e.kg += x.kg; e.litres += x.litres; e.slips++; map.set(key, e); };
    const byStaff = new Map(), byMonth = new Map();
    rows.forEach((x) => { add(byStaff, x.staff, { name: x.staff }, x); add(byMonth, x.month, { month: x.month, label: x.monthLabel }, x); });
    const tidy = (e) => Object.assign(e, { kg: r1(e.kg), litres: r1(e.litres) });
    return {
      kg: r1(rows.reduce((a, x) => a + x.kg, 0)), litres: r1(rows.reduce((a, x) => a + x.litres, 0)),
      slips: rows.length, estimated: rows.filter((x) => x.estimated).length,
      byStaff: Array.from(byStaff.values()).map(tidy).sort((a, b) => b.kg - a.kg),
      byMonth: Array.from(byMonth.values()).map(tidy).sort((a, b) => a.month.localeCompare(b.month)),
      rows,
    };
  }

  /* "412 kg" or "1.24 t" */
  const weight = (kg) => (kg >= 1000 ? (kg / 1000).toFixed(2) + ' t' : Math.round(kg).toLocaleString('en-US') + ' kg');

  /* the export, ready for csv(): one row per fuel slip */
  function csvRows(claims) {
    const s = summarise(claims);
    const out = [['Staff', 'Month', 'Date', 'Station', 'Receipt no.', 'Amount (RM)', 'Fuel', 'Litres', 'Litres estimated?', 'kg CO2e', 'Scope']];
    s.rows.sort((a, b) => a.month.localeCompare(b.month) || a.staff.localeCompare(b.staff) || String(a.date).localeCompare(String(b.date)))
      .forEach((x) => out.push([x.staff, x.monthLabel, x.date, x.station, x.receiptNo, x.amount.toFixed(2), x.fuel, x.litres.toFixed(3), x.estimated ? 'yes (from the amount)' : 'no (from the slip)', x.kg.toFixed(1), 'Scope 3 cat. 6 business travel']));
    out.push([]);
    out.push(['Total', '', '', '', '', '', '', s.litres.toFixed(1), '', s.kg.toFixed(1), '']);
    out.push(['Method', METHOD]);
    return out;
  }

  const api = { KG_PER_LITRE, EST_PRICE, SCOPE, METHOD, isFuel, lineCarbon, summarise, weight, csvRows };
  root.Carbon = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
