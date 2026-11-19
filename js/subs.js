/* Flow's subscription finder: the AI tools and software the company pays for through expense claims.
   Found from the claim lines (no AI): lines typed as AI tools or software, and any line naming a known tool.
   For each tool: who pays, in which months, the latest amount, and a yearly figure at that rate. Then what can be saved or
   should be checked: two or more people paying for the same tool, a price that went up, a tool paid every month (a yearly
   plan is often cheaper), and services that look personal. Amounts are what was claimed, in RM. */
(function (root) {
  'use strict';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // known tools: the name to show, and how they are written on receipts
  const TOOLS = [
    ['ChatGPT', /chat\s*gpt|open\s*ai/i], ['Claude', /\bclaude\b|anthropic/i], ['Gemini', /\bgemini\b|google\s*one/i], ['Microsoft 365', /copilot|microsoft\s*365|office\s*365|\bm365\b/i],
    ['Google Workspace', /google\s*workspace|g\s*suite/i], ['Midjourney', /midjourney/i], ['Runway', /runway/i], ['ElevenLabs', /eleven\s*labs/i], ['Canva', /canva/i],
    ['Adobe', /adobe|photoshop|premiere\s*pro|creative\s*cloud|lightroom/i], ['CapCut', /capcut/i], ['Notion', /notion/i], ['Figma', /figma/i], ['Zoom', /\bzoom\b/i],
    ['Grammarly', /grammarly/i], ['Perplexity', /perplexity/i], ['Suno', /\bsuno\b/i], ['HeyGen', /heygen/i], ['Synthesia', /synthesia/i], ['Descript', /descript/i],
    ['Cursor', /\bcursor\b/i], ['GitHub', /github/i], ['Dropbox', /dropbox/i], ['Kling', /\bkling\b/i], ['Luma', /\bluma\b/i], ['Pika', /\bpika\b/i],
    ['Leonardo AI', /leonardo/i], ['Freepik', /freepik/i], ['Envato', /envato/i], ['Higgsfield', /higgsfield/i], ['Krea', /\bkrea\b/i], ['Ideogram', /ideogram/i],
  ];
  // services that are usually personal: not claimable at WFC (personal items never are)
  const PERSONAL = [['Netflix', /netflix/i], ['Spotify', /spotify/i], ['Disney+ Hotstar', /disney|hotstar/i], ['YouTube Premium', /youtube\s*premium/i],
    ['Apple Music', /apple\s*music/i], ['iCloud', /icloud/i], ['Viu', /\bviu\b/i], ['iQIYI', /iqiyi/i]];
  const isToolCategory = (cat) => /\bai\b|software|subscription|saas|app\b|apps\b|langganan/i.test(String(cat || '')) && !/device|hardware|laptop|phone|gadget/i.test(String(cat || ''));

  const r2 = (n) => Math.round(n * 100) / 100;
  const money = (n) => 'RM ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const shortMonth = (m) => (/^\d{4}-\d{2}$/.test(m || '') ? `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}` : m || '');
  const monthIndex = (m) => +m.slice(0, 4) * 12 + +m.slice(5, 7) - 1;
  const tidy = (s) => String(s || '').replace(/\b(inc|llc|ltd|limited|sdn\s*bhd|pte|corp|co)\b\.?/gi, '').replace(/[^\p{L}\p{N}+ ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

  /* which tool a claim line is, if any: { name, personal } */
  function toolOf(l) {
    const text = `${l.name || ''} ${l.category || ''}`;
    for (const [name, re] of PERSONAL) if (re.test(text)) return { name, personal: true, known: true };
    for (const [name, re] of TOOLS) if (re.test(text)) return { name, personal: false, known: true };
    if (!isToolCategory(l.category)) return null;
    const own = tidy(l.name);
    return own ? { name: titleCase(own.toLowerCase()), personal: false, known: false } : null;
  }

  /* claims -> { tools, insights, totals } (claims: the dashboard's claim records) */
  function find(claims) {
    const by = new Map();
    (claims || []).forEach((c) => (c.lines || []).forEach((l) => {
      const t = toolOf(l);
      if (!t || !(Number(l.amount) > 0)) return;
      const month = /^\d{4}-\d{2}-\d{2}$/.test(l.date || '') ? l.date.slice(0, 7) : c.month;           // the month it was paid
      if (!by.has(t.name)) by.set(t.name, { name: t.name, known: t.known, personal: t.personal, uses: [] });
      by.get(t.name).uses.push({ staff: c.claimant, month, amount: r2(Number(l.amount)), claimId: c.id, line: l.no, date: l.date || '' });
    }));
    const latestMonth = Array.from(by.values()).flatMap((t) => t.uses.map((u) => u.month)).sort().pop() || '';
    const tools = Array.from(by.values()).map((t) => {
      const people = new Map();
      t.uses.forEach((u) => { if (!people.has(u.staff)) people.set(u.staff, []); people.get(u.staff).push(u); });
      const payers = Array.from(people, ([staff, uses]) => {
        uses.sort((a, b) => a.month.localeCompare(b.month) || a.date.localeCompare(b.date));
        const months = Array.from(new Set(uses.map((u) => u.month)));
        const last = uses[uses.length - 1];
        const recurring = months.length >= 2;
        // a payment seen in two or more months is taken as monthly; one payment of a known tool is shown, but not counted as monthly
        return { staff, months, times: uses.length, total: r2(uses.reduce((a, u) => a + u.amount, 0)), last: last.amount, lastMonth: last.month, recurring,
          monthly: recurring ? last.amount : 0, yearly: recurring ? r2(last.amount * 12) : 0, first: uses[0], uses, open: { claimId: last.claimId, line: last.line } };
      }).sort((a, b) => b.last - a.last || a.staff.localeCompare(b.staff));
      const months = Array.from(new Set(t.uses.map((u) => u.month))).sort();
      return {
        name: t.name, known: t.known, personal: t.personal, payers, months, recurring: payers.some((p) => p.recurring),
        monthly: r2(payers.reduce((a, p) => a + p.monthly, 0)), yearly: r2(payers.reduce((a, p) => a + p.yearly, 0)),
        total: r2(payers.reduce((a, p) => a + p.total, 0)), last: Math.max(...payers.map((p) => p.last)), lastMonth: months[months.length - 1],
        oneOff: !t.known && payers.every((p) => !p.recurring), open: payers[0].open,
      };
    }).sort((a, b) => (b.yearly - a.yearly) || (b.total - a.total) || a.name.localeCompare(b.name));

    // what to look at: savings first, then checks
    const insights = [];
    tools.forEach((t) => {
      if (t.personal) {
        insights.push({ kind: 'personal', tool: t.name, level: 'bad', title: `${t.name} looks personal`,
          text: `${t.payers.map((p) => p.staff).join(' and ')} claimed it (${money(t.total)}). Personal subscriptions aren't claimable.`, open: t.open });
        return;
      }
      // the same tool paid by two or more people in the same month: one team plan may cost less
      const byMonth = new Map();
      t.payers.forEach((p) => p.months.forEach((m) => { if (!byMonth.has(m)) byMonth.set(m, new Set()); byMonth.get(m).add(p.staff); }));
      const shared = Array.from(byMonth).filter(([, s]) => s.size >= 2).sort((a, b) => b[0].localeCompare(a[0]))[0];
      if (shared) {
        const names = Array.from(shared[1]);
        const paid = t.payers.filter((p) => names.includes(p.staff));
        const monthSum = r2(paid.reduce((a, p) => a + (p.uses.filter((u) => u.month === shared[0]).reduce((x, u) => x + u.amount, 0)), 0));
        const extra = r2(monthSum - Math.max(...paid.map((p) => p.uses.filter((u) => u.month === shared[0]).reduce((x, u) => x + u.amount, 0))));
        insights.push({ kind: 'overlap', tool: t.name, level: 'save', title: `${names.length} people pay for ${t.name}`, overlapYear: r2(extra * 12),
          text: `${names.join(' and ')} each paid in ${shortMonth(shared[0])} (${money(monthSum)} together). One team plan may cost less: the extra is ${money(extra * 12)} a year.`, open: t.open });
      }
      // a price that went up for the same person
      t.payers.forEach((p) => {
        const byM = p.months.map((m) => ({ m, amount: r2(p.uses.filter((u) => u.month === m).reduce((x, u) => x + u.amount, 0)) }));
        for (let i = byM.length - 1; i > 0; i--) {
          if (monthIndex(byM[i].m) - monthIndex(byM[i - 1].m) > 2) break;
          if (byM[i].amount >= byM[i - 1].amount * 1.1 && byM[i].amount - byM[i - 1].amount >= 5) {
            insights.push({ kind: 'price-up', tool: t.name, level: 'warn', title: `${t.name} went up`,
              text: `${p.staff}'s went from ${money(byM[i - 1].amount)} (${shortMonth(byM[i - 1].m)}) to ${money(byM[i].amount)} (${shortMonth(byM[i].m)}). A bigger plan, or a price rise?`, open: p.open });
            break;
          }
        }
      });
      // paid every month for three months or more: a yearly plan is often cheaper
      const steady = t.payers.filter((p) => p.months.length >= 3);
      if (steady.length) insights.push({ kind: 'yearly', tool: t.name, level: 'info', title: `${t.name} is paid every month`,
        text: `${steady.map((p) => `${p.staff}, ${p.months.length} months`).join('; ')}. A yearly plan is often cheaper.`, open: steady[0].open });
    });
    const rank = { bad: 0, save: 1, warn: 2, info: 3 };
    insights.sort((a, b) => rank[a.level] - rank[b.level]);

    const work = tools.filter((t) => !t.personal);
    const people = new Set(work.flatMap((t) => t.payers.map((p) => p.staff)));
    return {
      tools, insights, latestMonth,
      totals: { tools: work.length, people: people.size, monthly: r2(work.reduce((a, t) => a + t.monthly, 0)), yearly: r2(work.reduce((a, t) => a + t.yearly, 0)),
        claimed: r2(work.reduce((a, t) => a + t.total, 0)), overlapYear: r2(insights.filter((i) => i.kind === 'overlap').reduce((a, i) => a + i.overlapYear, 0)) },
    };
  }

  /* one row per tool and person, for the spreadsheet */
  function csvRows(res) {
    const out = [['Tool', 'Staff', 'Months paid', 'Times claimed', 'Latest amount (RM)', 'Total claimed (RM)', 'A month (RM, est.)', 'A year (RM, est.)', 'Note']];
    res.tools.forEach((t) => t.payers.forEach((p) => out.push([t.name, p.staff, p.months.map(shortMonth).join('; '), p.times, p.last.toFixed(2), p.total.toFixed(2),
      p.recurring ? p.monthly.toFixed(2) : '', p.recurring ? p.yearly.toFixed(2) : '', t.personal ? 'Looks personal' : p.recurring ? 'Paid in more than one month' : 'Seen once'])));
    out.push([]);
    res.insights.forEach((i) => out.push(['Note', i.title, i.text]));
    out.push(['Total a year at the latest amounts', '', '', '', '', '', '', res.totals.yearly.toFixed(2)]);
    return out;
  }

  const api = { find, toolOf, csvRows, TOOLS, PERSONAL };
  root.Subs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
