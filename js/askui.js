/* Ask Flow, the panel: a question box (typed, or spoken in English, Bahasa Melayu or Chinese), the answer in words, a chart or table, and, when the
   question was spoken, the answer read aloud. The work itself is in js/askflow.js; the Claude calls go through the inbox (Inbox.ask). */
(function () {
  'use strict';
  const A = window.AskFlow, C = window.Carbon;
  const $ = (s, r) => (r || document).querySelector(s);
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'text') e.textContent = v; else if (k === 'html') e.innerHTML = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach((c) => { if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return e;
  }
  const ICON = {
    spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15v5M16.5 17.5h5"/></svg>',
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  };
  const LANGS = [['en', 'EN', 'en-US'], ['ms', 'BM', 'ms-MY'], ['zh', '中文', 'zh-CN']];
  const PLACEHOLDER = 'Type a question…';
  const SUGGEST = [
    'Fuel spend by person this month', 'Who is on leave next week?', 'Carbon this month vs last month',
    'Claims with no receipt number', 'Berapa jumlah tuntutan bulan lepas?', '上个月谁的油费最高？',
  ];
  const ls = { get: (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

  let lang = ls.get('wfc-ask-lang') || (/^ms|^id/i.test(navigator.language) ? 'ms' : /^zh/i.test(navigator.language) ? 'zh' : 'en');
  let busy = false, rec = null, listening = false, voiceAsked = false;

  /* ---------- formatting ---------- */
  const money = (n) => 'RM ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function fmt(v, unit) {
    if (unit === 'RM') return money(v);
    if (unit === 'kg CO₂e') return C ? C.weight(v) + ' CO₂e' : Math.round(v) + ' kg CO₂e';
    if (unit === 'litres') return (Math.round(v * 10) / 10).toLocaleString('en-US') + ' L';
    if (unit === 'days') return `${v} ${v === 1 ? 'day' : 'days'}`;
    return (Number(v) || 0).toLocaleString('en-US');
  }
  const COL = { staff: 'Staff', date: 'Date', category: 'Type', shop: 'Shop', receiptNo: 'Receipt no.', amount: 'Amount', litres: 'Litres', kgCO2: 'kg CO₂e', type: 'Leave', start: 'From', end: 'To', days: 'Days', status: 'Status', month: 'Month', total: 'Total', lines: 'Lines' };
  const cell = (c, v) => (c === 'amount' || c === 'total' ? money(v) : c === 'kgCO2' ? Math.round(v) : c === 'litres' ? (v ? (Math.round(v * 10) / 10) + ' L' : '–') : v == null || v === '' ? '–' : String(v));

  /* ---------- charts ---------- */
  const PALETTE = ['#1f4ad8', '#0f9fa0', '#3d8bff', '#16a34a', '#7c3aed', '#b45309'];
  function bars(groups, unit, green) {
    const top = Math.max.apply(null, groups.map((g) => g.value)) || 1;
    return h('div', { class: 'af-bars' }, groups.map((g) => {
      const fill = h('i'); fill.style.width = Math.max(2, g.value / top * 100).toFixed(1) + '%'; if (green) fill.style.background = '#16a34a';
      return h('div', { class: 'af-bar' }, h('div', { class: 'af-bt' }, h('span', { text: g.label }), h('b', { text: fmt(g.value, unit) })), h('div', { class: 'af-track' }, fill));
    }));
  }
  function columns(groups, unit, green) {
    const W = 480, H = 210, padB = 34, padT = 26, n = groups.length, gap = 14, bw = Math.min(64, (W - gap * (n + 1)) / n);
    const top = Math.max.apply(null, groups.map((g) => g.value)) || 1, x0 = (W - (n * bw + (n - 1) * gap)) / 2;
    const parts = groups.map((g, i) => {
      const bh = Math.max(2, (g.value / top) * (H - padB - padT)), x = x0 + i * (bw + gap), y = H - padB - bh;
      const short = unit === 'RM' ? 'RM ' + (g.value >= 10000 ? (g.value / 1000).toFixed(1) + 'k' : Math.round(g.value).toLocaleString('en-US')) : fmt(g.value, unit).replace(' CO₂e', '');
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="6" fill="${green ? '#16a34a' : i === n - 1 ? '#1f4ad8' : '#9db4f5'}"/>`
        + `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" class="af-v">${esc(short)}</text>`
        + `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" class="af-x">${esc(g.label)}</text>`;
    }).join('');
    return h('div', { class: 'af-cols', html: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Column chart"><line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" class="af-axis"/>${parts}</svg>` });
  }
  function donut(groups, unit) {
    let parts = groups.slice(0, 5);
    if (groups.length > 5) parts.push({ label: 'Others', value: groups.slice(5).reduce((a, g) => a + g.value, 0) });
    const sum = parts.reduce((a, g) => a + g.value, 0) || 1, R = 70, r = 44, cx = 90, cy = 90;
    let a0 = -Math.PI / 2;
    const arcs = parts.map((g, i) => {
      const a1 = a0 + (g.value / sum) * Math.PI * 2, big = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, a) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
      const d = parts.length === 1 ? `M ${cx} ${cy - R} A ${R} ${R} 0 1 1 ${cx - 0.01} ${cy - R} L ${cx - 0.01} ${cy - r} A ${r} ${r} 0 1 0 ${cx} ${cy - r} Z`
        : `M ${p(R, a0)} A ${R} ${R} 0 ${big} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${big} 0 ${p(r, a0)} Z`;
      a0 = a1;
      return `<path d="${d}" fill="${PALETTE[i % PALETTE.length]}"/>`;
    }).join('');
    return h('div', { class: 'af-pie' }, h('div', { html: `<svg viewBox="0 0 180 180" role="img" aria-label="Share of the total">${arcs}</svg>` }),
      h('ul', {}, parts.map((g, i) => h('li', {}, h('i', { style: `background:${PALETTE[i % PALETTE.length]}` }), h('span', { text: g.label }), h('b', { text: `${fmt(g.value, unit)} · ${Math.round(g.value / sum * 100)}%` })))));
  }
  function table(result) {
    if (!result.rows.length) return null;
    return h('div', { class: 'af-tablewrap' }, h('table', { class: 'af-table' },
      h('thead', {}, h('tr', {}, result.columns.map((c) => h('th', { class: /amount|total|kgCO2|litres|days|lines/.test(c) ? 'num' : '', text: COL[c] || c })))),
      h('tbody', {}, result.rows.map((r) => h('tr', {}, result.columns.map((c) => h('td', { class: /amount|total|kgCO2|litres|days|lines/.test(c) ? 'num' : '', text: cell(c, r[c]) })))))));
  }
  function chartFor(plan, result) {
    if (result.empty) return null;
    const green = result.measure === 'kgCO2';
    let kind = plan.chart;
    if (kind === 'list' || (!result.groups.length && kind !== 'number')) return table(result);
    if (kind === 'number' && result.groups.length > 1) kind = 'bar';
    if (kind === 'number' || !result.groups.length) return h('div', { class: 'af-big' }, h('b', { text: fmt(result.total, result.unit) }), h('span', { text: `${result.count} record${result.count === 1 ? '' : 's'}` }));
    if (kind === 'column') return columns(result.groups, result.unit, green);
    if (kind === 'pie') return donut(result.groups, result.unit);
    return bars(result.groups, result.unit, green);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- speaking the answer ---------- */
  const synth = window.speechSynthesis;
  function voiceFor(code) {
    const voices = synth ? synth.getVoices() : [];
    const base = code.slice(0, 2);
    const want = base === 'ms' ? ['ms', 'id'] : [base];         // no Malay voice on this device: an Indonesian one reads Malay well
    for (const w of want) {
      const list = voices.filter((v) => v.lang && v.lang.toLowerCase().replace('_', '-').startsWith(w));
      const best = list.find((v) => /natural|online|google|premium|enhanced/i.test(v.name)) || list[0];
      if (best) return best;
    }
    return null;
  }
  function speak(text, l) {
    if (!synth || !text) return;
    synth.cancel();
    const code = (LANGS.find((x) => x[0] === l) || LANGS[0])[2];
    const u = new SpeechSynthesisUtterance(text);
    u.lang = code; const v = voiceFor(code); if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = l === 'zh' ? 1 : 1.02;
    u.onstart = () => document.querySelectorAll('.af-say').forEach((b) => b.classList.add('on'));
    u.onend = u.onerror = () => document.querySelectorAll('.af-say').forEach((b) => b.classList.remove('on'));
    synth.speak(u);
  }
  if (synth && synth.onvoiceschanged !== undefined) synth.onvoiceschanged = () => synth.getVoices();

  /* ---------- the panel ---------- */
  function build() {
    const scrim = h('div', { class: 'af-scrim', id: 'askScrim', hidden: true, onclick: close });
    const langs = h('div', { class: 'af-langs', role: 'group', 'aria-label': 'Language for voice' }, LANGS.map(([k, label]) =>
      h('button', { type: 'button', 'data-lang': k, 'aria-pressed': String(k === lang), text: label, onclick: () => setLang(k) })));
    const ta = h('textarea', { id: 'askText', rows: '1', placeholder: PLACEHOLDER, 'aria-label': 'Your question' });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; ta.style.overflowY = ta.scrollHeight > 120 ? 'auto' : 'hidden'; });
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mic = h('button', { class: 'af-mic', type: 'button', id: 'askMic', 'aria-label': 'Ask by voice', title: SR ? 'Ask by voice' : 'Voice needs Chrome, Edge or Safari', disabled: !SR, html: ICON.mic, onclick: toggleMic });
    const send = h('button', { class: 'af-send', type: 'submit', 'aria-label': 'Ask', html: ICON.send });
    const form = h('form', { class: 'af-input', onsubmit: (e) => { e.preventDefault(); submit(); } }, ta, mic, send);
    const panel = h('section', { class: 'af', id: 'askPanel', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'askTitle' },
      h('header', { class: 'af-hd' },
        h('span', { class: 'af-logo', html: ICON.spark }),
        h('div', { class: 'af-ttl' }, h('b', { id: 'askTitle', text: 'Ask Flow' }), h('small', { text: 'Claims, fuel, carbon and leave · English, Bahasa Melayu, 中文' })),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: close })),
      h('div', { class: 'af-body', id: 'askBody' }, intro()),
      h('footer', { class: 'af-ft' }, form, h('div', { class: 'af-under' }, langs, h('span', { class: 'af-note', text: 'Numbers are worked out from your records.' }))));
    document.body.append(scrim, panel);
  }
  function intro() {
    return h('div', { class: 'af-intro', id: 'askIntro' },
      h('div', { class: 'af-hello', html: ICON.spark }),
      h('h3', { text: 'What would you like to know?' }),
      h('p', { text: 'Ask in English, Bahasa Melayu or 中文. Type, or tap the microphone and speak; a spoken question is answered out loud too.' }),
      h('div', { class: 'af-sugg' }, SUGGEST.map((s) => h('button', { type: 'button', text: s, onclick: () => { $('#askText').value = s; submit(); } }))));
  }
  function setLang(k) {
    lang = k; ls.set('wfc-ask-lang', k);
    document.querySelectorAll('.af-langs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === k)));
  }

  function open() {
    if (!$('#askPanel')) build();
    $('#askScrim').hidden = false; $('#askPanel').hidden = false;
    document.body.classList.add('af-open');
    setTimeout(() => $('#askText').focus(), 60);
  }
  function close() {
    if (!$('#askPanel')) return;
    stopMic(); if (synth) synth.cancel();
    $('#askScrim').hidden = true; $('#askPanel').hidden = true;
    document.body.classList.remove('af-open');
    const b = $('#btnAsk'); if (b) b.focus();
  }

  /* ---------- voice in ---------- */
  function toggleMic() { if (listening) stopMic(); else startMic(); }
  function startMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || busy) return;
    if (synth) { synth.cancel(); try { synth.speak(new SpeechSynthesisUtterance(' ')); } catch (e) { /* unlock speech on phones */ } }
    const ta = $('#askText');
    rec = new SR();
    rec.lang = (LANGS.find((x) => x[0] === lang) || LANGS[0])[2];
    rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let said = '';
    rec.onresult = (e) => { said = Array.from(e.results).map((r) => r[0].transcript).join(''); ta.value = said; };
    rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') note('The microphone is blocked. Allow it in the browser to ask by voice.'); else if (e.error === 'no-speech') note("I didn't hear anything. Tap the microphone and try again."); };
    rec.onend = () => { listening = false; $('#askMic').classList.remove('on'); if (said.trim()) { voiceAsked = true; submit(); } };
    listening = true; $('#askMic').classList.add('on');
    ta.value = ''; ta.placeholder = { en: 'Listening…', ms: 'Sedang mendengar…', zh: '正在聆听…' }[lang];
    try { rec.start(); } catch (e) { listening = false; $('#askMic').classList.remove('on'); }
  }
  function stopMic() { if (rec && listening) { try { rec.stop(); } catch (e) { /* already stopped */ } } listening = false; const m = $('#askMic'); if (m) m.classList.remove('on'); }
  function note(text) { const b = $('#askBody'); b.append(h('div', { class: 'af-tip', text })); b.scrollTop = b.scrollHeight; }

  /* ---------- a question ---------- */
  async function submit() {
    const ta = $('#askText'), q = ta.value.trim();
    ta.placeholder = PLACEHOLDER;
    if (!q || busy) return;
    const spoken = voiceAsked; voiceAsked = false;
    ta.value = ''; ta.style.height = 'auto';
    const intro = $('#askIntro'); if (intro) intro.remove();
    const body = $('#askBody');
    body.append(h('div', { class: 'af-q' }, h('span', { text: q })));
    const card = h('div', { class: 'af-a' }, h('div', { class: 'af-wait' }, h('span', { class: 'af-dots' }, h('i'), h('i'), h('i')), h('span', { class: 'af-step', text: 'Reading your records…' })));
    body.append(card); body.scrollTop = body.scrollHeight;
    busy = true; $('#askPanel').classList.add('busy');
    const d = window.__dash, S = d && d.S;
    try {
      if (!window.Inbox || !Inbox.askOk) throw new Error(Inbox && Inbox.address() ? 'This inbox cannot answer questions yet. It needs the latest update.' : 'Ask Flow needs the connection to the company inbox.');
      let calls = 0;
      const out = await A.ask(q, {
        claims: S.sample ? S.sampleList : S.real, leave: S.sample ? S.sampleLeave : S.realLeave, today: today(),
        send: async (req) => { calls++; if (calls === 2) card.querySelector('.af-step').textContent = 'Writing the answer…'; return Inbox.ask(req); },
      });
      paintAnswer(card, q, out, spoken);
    } catch (e) {
      card.textContent = '';
      card.classList.add('bad');
      card.append(h('p', { text: String((e && e.message) || e) }));
    } finally {
      busy = false; $('#askPanel').classList.remove('busy');
      body.scrollTop = body.scrollHeight;
    }
  }

  function paintAnswer(card, q, out, spoken) {
    const { plan, result, answer } = out;
    card.textContent = '';
    const say = h('button', { class: 'af-say', type: 'button', 'aria-label': 'Read the answer aloud', title: 'Read aloud', html: ICON.speaker, onclick: () => speak(answer.speech || answer.answer, plan.lang) });
    card.append(h('div', { class: 'af-top' }, h('p', { class: 'af-text', text: answer.answer }), synth ? say : null));
    if ((answer.highlights || []).length) card.append(h('div', { class: 'af-hl' }, answer.highlights.slice(0, 3).map((x) => h('div', {}, h('small', { text: x.label }), h('b', { text: x.value })))));
    const chart = chartFor(plan, result);
    if (chart) card.append(h('figure', { class: 'af-fig' }, plan.title ? h('figcaption', { text: plan.title }) : null, chart));
    if (!result.empty && plan.table !== 'none') {
      const what = plan.table === 'leave' ? 'leave application' : plan.table === 'claims' ? 'claim' : 'claim line';
      card.append(h('div', { class: 'af-src', text: `From ${result.count} ${what}${result.count === 1 ? '' : 's'} in your records${S().sample ? ' (sample data)' : ''}.` }));
    }
    if (spoken) speak(answer.speech || answer.answer, plan.lang);
  }
  const S = () => (window.__dash && window.__dash.S) || {};

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#askPanel') && !$('#askPanel').hidden) { e.stopPropagation(); close(); } }, true);
  window.AskUI = { open, close, speak };
})();
