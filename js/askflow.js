/* Ask Flow: questions about the claims and leave, in plain words (English, Bahasa Melayu or Chinese), typed or spoken.
   Three steps, so every number comes from the records and none from the AI's memory:
     1. plan:   Claude turns the question into a lookup (which table, which filters, how to group, what to add up, which chart)
     2. run:    this page runs the lookup on the claims and leave it already has (run(), below: plain code, tested)
     3. answer: Claude writes a short answer from the result, in the language of the question, plus a line to read aloud
   Both Claude calls go through the inbox (action "ask"), which keeps the company key, fixes the model and needs the dashboard password. */
(function (root) {
  'use strict';
  const LANG_NAME = { en: 'English', ms: 'Bahasa Melayu (Malay)', zh: 'Simplified Chinese' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const LEAVE_TYPES = ['annual', 'sick', 'personal', 'unpaid', 'other'];
  const LEAVE_LABEL = { annual: 'Annual leave', sick: 'Sick leave', personal: 'Personal leave', unpaid: 'Unpaid leave', other: 'Other leave' };
  const MEASURE_UNIT = { amount: 'RM', count: '', kgCO2: 'kg CO₂e', litres: 'litres', days: 'days' };
  const r2 = (n) => Math.round(n * 100) / 100;
  const monthLabel = (m) => (/^\d{4}-\d{2}$/.test(m) ? `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}` : m);
  const dayNo = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / 864e5);

  /* ---------- the records, as three plain tables ---------- */
  function tables(claims, leave) {
    const C = root.Carbon;
    const lines = [], cl = [], lv = [];
    (claims || []).forEach((c) => {
      cl.push({ staff: c.claimant, month: c.month, total: Number(c.total) || 0, lines: (c.lines || []).length, status: c.status, sent: String(c.updatedAt || '').slice(0, 10) });
      (c.lines || []).forEach((l) => {
        const x = C ? C.lineCarbon(l) : null;
        lines.push({ staff: c.claimant, month: c.month, date: l.date || '', category: l.category || 'Other', shop: l.name || '', receiptNo: l.receiptNo || '',
          amount: Number(l.amount) || 0, litres: x ? x.litres : 0, kgCO2: x ? x.kg : 0, estimated: !!(x && x.estimated), status: c.status });
      });
    });
    (leave || []).forEach((v) => lv.push({ staff: v.claimant, type: LEAVE_TYPES.includes(v.type) ? v.type : 'other', start: v.start, end: v.end || v.start, days: Number(v.days) || 0, status: v.status, reason: v.reason || '' }));
    return { lines, claims: cl, leave: lv };
  }

  /* what the data holds, so Claude can use the real names and months (no amounts: those stay on this page until the answer step) */
  function catalog(t, today) {
    const uniq = (a) => Array.from(new Set(a.filter(Boolean))).sort();
    const d = new Date(today + 'T00:00:00Z');
    const leaveDates = t.leave.map((v) => v.start).concat(t.leave.map((v) => v.end)).filter(Boolean).sort();
    return [
      `Today: ${today} (${DAYS[d.getUTCDay()]})`,
      `Staff: ${uniq(t.claims.map((c) => c.staff).concat(t.leave.map((v) => v.staff))).join('; ') || 'none yet'}`,
      `Claim months: ${uniq(t.claims.map((c) => c.month)).join(', ') || 'none yet'}`,
      `Claim line categories: ${uniq(t.lines.map((l) => l.category)).join(', ') || 'none yet'}`,
      'Claim statuses: new, checked, paid, question',
      `Leave types: ${LEAVE_TYPES.join(', ')}; leave statuses: new, recorded, question`,
      leaveDates.length ? `Leave dates run from ${leaveDates[0]} to ${leaveDates[leaveDates.length - 1]}` : 'No leave applications yet',
      `Rows: ${t.lines.length} claim lines, ${t.claims.length} claims, ${t.leave.length} leave applications`,
    ].join('\n');
  }

  /* ---------- step 1: the plan ---------- */
  const strArr = { type: 'array', items: { type: 'string' } };
  const PLAN_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['lang', 'table', 'filters', 'groupBy', 'measure', 'sort', 'limit', 'chart', 'title', 'unanswerable'],
    properties: {
      lang: { type: 'string', enum: ['en', 'ms', 'zh'] },
      table: { type: 'string', enum: ['lines', 'claims', 'leave', 'none'] },
      filters: {
        type: 'object', additionalProperties: false,
        required: ['staff', 'month', 'category', 'status', 'leaveType', 'dateFrom', 'dateTo', 'missingReceiptNo', 'text'],
        properties: { staff: strArr, month: strArr, category: strArr, status: strArr, leaveType: strArr, dateFrom: { type: 'string' }, dateTo: { type: 'string' }, missingReceiptNo: { type: 'boolean' }, text: { type: 'string' } },
      },
      groupBy: { type: 'string', enum: ['none', 'staff', 'month', 'category', 'leaveType', 'status', 'date', 'shop'] },
      measure: { type: 'string', enum: ['amount', 'count', 'kgCO2', 'litres', 'days'] },
      sort: { type: 'string', enum: ['desc', 'asc', 'time'] },
      limit: { type: 'integer' },
      chart: { type: 'string', enum: ['number', 'bar', 'column', 'pie', 'list'] },
      title: { type: 'string' },
      unanswerable: { type: 'string' },
    },
  };
  const PLAN_SYSTEM = `You turn a manager's question about their company's expense claims and leave into a lookup plan for a dashboard. The dashboard runs the plan on its own records, so you never calculate or state numbers yourself.

The records are three tables:
- lines: one row per receipt line of a monthly expense claim. Fields: staff, month (YYYY-MM, the claim month), date (YYYY-MM-DD, the receipt date), category, shop, receiptNo, amount (RM), litres (fuel lines only), kgCO2 (carbon of the fuel, fuel lines only), status (of its claim).
- claims: one row per monthly claim. Fields: staff, month, total (RM), lines (count), status (new, checked, paid, question), sent (date).
- leave: one row per leave application. Fields: staff, type (annual, sick, personal, unpaid, other; "MC" means sick), start, end (YYYY-MM-DD), days (working days), status (new, recorded, question), reason.

Plan fields:
- lang: the language the question is written in: en, ms (Malay), zh (Chinese).
- table: the table that answers it; "none" when these records cannot answer it (then say why in unanswerable, in that language, one short sentence).
- filters: leave a list empty or a string "" when it does not apply. Use the staff names, months and categories exactly as listed below (match loosely: "Ali" -> the listed full name). month filters claims and claim lines by claim month. dateFrom/dateTo (YYYY-MM-DD) filter lines by receipt date and leave by any overlap with the period. missingReceiptNo picks lines with no receipt number. text searches shop names and leave reasons.
- groupBy: how to split the result ("none" for one figure or a list of rows). measure: what to add up: amount (RM), count, kgCO2, litres, days.
- sort: desc or asc by the measure, or time (oldest first). limit: how many groups or rows to show (1-50; 10 is usual; 5 for "top five").
- chart: number (one figure), bar (ranking people, shops or categories), column (months or dates, a trend or a comparison over time), pie (shares of a total, at most 6 parts), list (individual rows: "which claims", "who is on leave").
- title: a short chart title in the question's language, in sentence case (write CO₂, not CO2).

Dates: use "Today" below. "This month" is today's calendar month, "last month" the one before; a claim for a month is sent early the next month. "This week" and "next week" run Monday to Sunday. Fuel, petrol and minyak mean the category Petrol. Carbon, CO2, emissions and pelepasan karbon mean measure kgCO2 on table lines. For a comparison of two months, filter those two months and group by month.`;

  function planRequest(question, t, today) {
    return {
      system: PLAN_SYSTEM, max_tokens: 1500,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
      messages: [{ role: 'user', content: `${catalog(t, today)}\n\nQuestion: ${question}` }],
    };
  }

  /* ---------- step 2: the lookup, run here on the real records ---------- */
  const lc = (s) => String(s || '').toLowerCase();
  const CATEGORY_WORDS = { petrol: /petrol|fuel|minyak|diesel/i, toll: /toll|tol\b/i, parking: /parking|letak/i, medical: /medic|clinic|klinik/i, 'ai tools': /\bai\b|software|subscription/i, accommodation: /accommodation|hotel/i };
  function catMatch(cat, wanted) {
    return wanted.some((w) => { const a = lc(cat), b = lc(w); return a === b || a.includes(b) || b.includes(a) || (CATEGORY_WORDS[a] && CATEGORY_WORDS[a].test(w)); });
  }
  const nameMatch = (name, wanted) => wanted.some((w) => { const a = lc(name), b = lc(w).trim(); return a === b || (b.length >= 3 && (a.includes(b) || b.includes(a))); });
  const isoOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

  function pick(plan, t) {
    const f = plan.filters || {}, table = plan.table;
    let rows = (t[table] || []).slice();
    if (f.staff && f.staff.length) rows = rows.filter((r) => nameMatch(r.staff, f.staff));
    if (f.status && f.status.length) rows = rows.filter((r) => f.status.map(lc).includes(lc(r.status)));
    if (table === 'leave') {
      if (f.leaveType && f.leaveType.length) rows = rows.filter((r) => f.leaveType.map(lc).some((x) => x === r.type || (x === 'mc' && r.type === 'sick')));
      if (f.month && f.month.length) rows = rows.filter((r) => f.month.some((m) => r.start.slice(0, 7) <= m && r.end.slice(0, 7) >= m));
      if (isoOk(f.dateFrom)) rows = rows.filter((r) => r.end >= f.dateFrom);
      if (isoOk(f.dateTo)) rows = rows.filter((r) => r.start <= f.dateTo);
      if (f.text) rows = rows.filter((r) => lc(r.reason).includes(lc(f.text)));
    } else {
      if (f.month && f.month.length) rows = rows.filter((r) => f.month.includes(r.month));
      if (table === 'lines') {
        if (f.category && f.category.length) rows = rows.filter((r) => catMatch(r.category, f.category));
        if (isoOk(f.dateFrom)) rows = rows.filter((r) => r.date >= f.dateFrom);
        if (isoOk(f.dateTo)) rows = rows.filter((r) => r.date && r.date <= f.dateTo);
        if (f.missingReceiptNo) rows = rows.filter((r) => !String(r.receiptNo).trim() && !/toll|parking/i.test(r.category));      // toll and parking lines carry the statement number, not a receipt
        if (f.text) rows = rows.filter((r) => lc(r.shop).includes(lc(f.text)));
      }
    }
    return rows;
  }

  function valueOf(r, measure, table) {
    if (measure === 'count') return 1;
    if (measure === 'amount') return table === 'claims' ? r.total : (r.amount || 0);
    if (measure === 'days') return r.days || 0;
    return Number(r[measure]) || 0;
  }
  const keyOf = (r, g) => (g === 'leaveType' ? r.type : g === 'date' ? (r.date || r.start || '') : r[g]);
  const labelOf = (k, g) => (g === 'month' ? monthLabel(k) : g === 'leaveType' ? (LEAVE_LABEL[k] || k) : g === 'status' ? ({ new: 'New', checked: 'Checked', paid: 'Paid', question: 'Has a question', recorded: 'Recorded' }[k] || k) : String(k || '–'));

  /* plan -> { measure, unit, total, count, groups: [{ key, label, value }], rows, columns, change } */
  function run(plan, t) {
    if (!plan || plan.table === 'none' || !t[plan.table]) return { empty: true, total: 0, count: 0, groups: [], rows: [] };
    const table = plan.table;
    const measure = table === 'leave' && !['count', 'days'].includes(plan.measure) ? 'days' : table !== 'lines' && ['kgCO2', 'litres'].includes(plan.measure) ? 'amount' : plan.measure || 'count';
    let rows = pick(plan, t);
    if (measure === 'kgCO2' || measure === 'litres') rows = rows.filter((r) => r.kgCO2 || r.litres);   // carbon and litres come from fuel slips only
    const limit = Math.max(1, Math.min(50, parseInt(plan.limit, 10) || 10));
    const total = r2(rows.reduce((a, r) => a + valueOf(r, measure, table), 0));
    const out = { table, measure, unit: MEASURE_UNIT[measure], total, count: rows.length, groups: [], rows: [], columns: [], empty: !rows.length };
    if (measure === 'kgCO2' || measure === 'litres') {                  // fuel slips whose litres were not read: their figure comes from the amount
      const fuel = rows.filter((r) => r.kgCO2 || r.litres);
      out.fuelSlips = fuel.length;
      out.estimatedSlips = fuel.filter((r) => r.estimated).length;
    }
    let g = plan.groupBy || 'none';
    if (g === 'leaveType' && table !== 'leave') g = table === 'lines' ? 'category' : 'none';
    if (g === 'category' && table !== 'lines') g = 'none';
    if (g === 'shop' && table !== 'lines') g = 'none';
    if (g !== 'none') {
      const m = new Map();
      rows.forEach((r) => { const k = keyOf(r, g); m.set(k, r2((m.get(k) || 0) + valueOf(r, measure, table))); });
      let groups = Array.from(m, ([key, value]) => ({ key, label: labelOf(key, g), value }));
      if (g === 'month' || g === 'date' || plan.sort === 'time') groups.sort((a, b) => String(a.key).localeCompare(String(b.key)));
      else groups.sort((a, b) => (plan.sort === 'asc' ? a.value - b.value : b.value - a.value));
      out.groupedBy = g;
      out.groupCount = groups.length;
      out.groups = (g === 'month' || g === 'date') ? groups.slice(-limit) : groups.slice(0, limit);
      if (g === 'month' && out.groups.length === 2) {            // a comparison of two months: the change is worked out here, not by the AI
        const [a, b] = out.groups, diff = r2(b.value - a.value);
        out.change = { from: a.label, to: b.label, diff, pct: a.value ? Math.round(diff / a.value * 1000) / 10 : null };
      }
    }
    // the rows themselves, for lists (and as the evidence behind any figure)
    const sorted = rows.slice().sort(plan.sort === 'time' || plan.chart === 'list'
      ? (a, b) => String(a.date || a.start || a.month).localeCompare(String(b.date || b.start || b.month))
      : (a, b) => (plan.sort === 'asc' ? 1 : -1) * (valueOf(a, measure, table) - valueOf(b, measure, table)));
    out.columns = table === 'leave' ? ['staff', 'type', 'start', 'end', 'days', 'status'] : table === 'claims' ? ['staff', 'month', 'total', 'lines', 'status'] : ['staff', 'date', 'category', 'shop', 'receiptNo', 'amount'].concat(measure === 'kgCO2' || measure === 'litres' ? ['litres', 'kgCO2'] : []);
    out.rows = sorted.slice(0, plan.chart === 'list' ? limit : Math.min(limit, 25)).map((r) => {
      const o = {}; out.columns.forEach((c) => { o[c] = c === 'type' ? LEAVE_LABEL[r.type] : c === 'month' ? monthLabel(r.month) : r[c]; }); return o;
    });
    return out;
  }

  /* ---------- step 3: the answer, in the question's language ---------- */
  const ANSWER_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['answer', 'speech', 'highlights'],
    properties: {
      answer: { type: 'string' }, speech: { type: 'string' },
      highlights: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'string' } } } },
    },
  };
  const ROW_KIND = { lines: 'receipt lines', claims: 'monthly claims', leave: 'leave applications' };
  const ANSWER_SYSTEM = `You answer a manager's question about their company's expense claims and leave, for a dashboard that shows your answer above a chart.
Use only the figures in the result you are given. Copy figures exactly as written there (RM amounts with two decimals and thousands commas, such as RM 1,575.40). Never add, average or recalculate anything yourself; a "change" in the result is already worked out and may be quoted.
- answer: 1 to 3 short sentences in the requested language, plain words for a busy boss, the key figure first. No markdown, no bullet points. If the result is empty, say plainly that nothing matches. rowsAre says what was counted: receipt lines are receipts (resit, 收据), not claims; a claim is one person's monthly form. If estimatedFromAmount is given, add a few words that those slips' litres were worked out from the amount paid, so the figure is an estimate.
- speech: one or two sentences in the same language for reading aloud: say amounts as words a person would speak (English "718 ringgit 91 sen", Malay "718 ringgit 91 sen", Chinese "718.91令吉"), no symbols or abbreviations.
- highlights: up to 3 label and value pairs taken from the result (for example "Total" and "RM 718.91"), labels in the requested language.`;

  /* figures as the boss should read them ("RM 1,575.40", "827.3 kg CO₂e"), so Claude copies them as they are */
  function shown(v, unit) {
    const n = Number(v) || 0;
    if (unit === 'RM') return 'RM ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (unit === 'kg CO₂e') return n.toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' kg CO₂e';
    if (unit === 'litres') return n.toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' litres';
    if (unit === 'days') return `${n} ${n === 1 ? 'day' : 'days'}`;
    return n.toLocaleString('en-US');
  }

  function answerRequest(question, plan, result) {
    const lines = [`Requested language: ${LANG_NAME[plan.lang] || 'English'}`, `Question: ${question}`, `Chart title: ${plan.title}`,
      `Result: ${JSON.stringify({ measure: result.measure, unit: result.unit, total: shown(result.total, result.unit), rowsMatching: result.count, rowsAre: ROW_KIND[result.table] || 'records',
        estimatedFromAmount: result.estimatedSlips ? `${result.estimatedSlips} of ${result.fuelSlips} fuel slips` : undefined, groupedBy: result.groupedBy || 'none', groups: result.groups.map((x) => ({ label: x.label, value: shown(x.value, result.unit) })), groupCount: result.groupCount, change: result.change || null, rows: result.rows.slice(0, 25) })}`];
    return {
      system: ANSWER_SYSTEM, max_tokens: 1200,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
      messages: [{ role: 'user', content: lines.join('\n') }],
    };
  }

  /* the text of a Claude reply (thinking blocks are skipped), parsed as JSON */
  function replyJson(reply) {
    if (!reply || reply.stop_reason === 'refusal') throw new Error('Claude did not answer that question.');
    const text = (reply.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
    try { return JSON.parse(text); } catch (e) { throw new Error('The answer came back in a form I could not read. Please ask again.'); }
  }

  /* the whole question: ask(question) -> { plan, result, answer: { answer, speech, highlights } }. send(request) posts to the inbox. */
  async function ask(question, { claims, leave, today, send }) {
    const t = tables(claims, leave);
    const plan = replyJson(await send(planRequest(question, t, today)));
    if (plan.table === 'none') return { plan, result: run(plan, t), answer: { answer: plan.unanswerable || 'These records cannot answer that question.', speech: plan.unanswerable || '', highlights: [] } };
    const result = run(plan, t);
    const answer = replyJson(await send(answerRequest(question, plan, result)));
    return { plan, result, answer };
  }

  const api = { tables, catalog, planRequest, run, answerRequest, replyJson, ask, PLAN_SCHEMA, ANSWER_SCHEMA, monthLabel, LEAVE_LABEL, MEASURE_UNIT };
  root.AskFlow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
