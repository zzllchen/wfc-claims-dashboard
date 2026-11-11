/* WFC Claims - the accountant's view. Reads the claims inbox; no login yet (on purpose, for the demo). */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const pad = (n) => String(n).padStart(2, '0');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const SHORT = MONTHS.map((m) => m.slice(0, 3));

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      const v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'value' || k === 'checked' || k === 'disabled') e[k] = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach((c) => { if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c)); });
    return e;
  }

  /* ---------- formatting ---------- */
  const money = (n) => 'RM ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const niceDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${+m[3]} ${SHORT[+m[2] - 1]} ${m[1]}` : ''; };
  const clock = (d) => { let hr = d.getHours(); const ap = hr >= 12 ? 'pm' : 'am'; hr = hr % 12 || 12; return `${hr}:${pad(d.getMinutes())} ${ap}`; };
  const fullWhen = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getDate()} ${SHORT[d.getMonth()]} ${d.getFullYear()}, ${clock(d)}`; };
  function ago(iso) {
    const d = new Date(iso), s = (Date.now() - d.getTime()) / 1000;
    if (isNaN(d)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) { const hrs = Math.floor(s / 3600); return `${hrs} hour${hrs > 1 ? 's' : ''} ago`; }
    if (s < 172800) return 'yesterday';
    if (s < 86400 * 14) return `${Math.floor(s / 86400)} days ago`;
    return `${d.getDate()} ${SHORT[d.getMonth()]}`;
  }
  const sizeText = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const safe = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();

  /* ---------- statuses ---------- */
  const STATUS = { new: 'New', checked: 'Checked', paid: 'Paid', question: 'Has a question' };
  const STATUS_KEYS = ['new', 'checked', 'paid', 'question'];
  const STATUS_RANK = ['new', 'question', 'checked', 'paid'];

  /* ---------- kinds of claim: one small drawing each ---------- */
  const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const ICON = {      // fixed markup, never user text
    fuel: svg('<path d="M3 22h12"/><path d="M4 9h10"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.8a2 2 0 0 0-.6-1.4L18 5"/>'),
    toll: svg('<rect x="2.5" y="8" width="5" height="13" rx="1"/><rect x="7.5" y="11" width="14" height="4" rx="1"/><path d="M12 11v4M16 11v4"/><path d="M2 21h20"/>'),
    parking: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9.5 17V7.5h3.2a2.8 2.8 0 0 1 0 5.6H9.5"/>'),
    medical: svg('<path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/>'),
    ai: svg('<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M19 16v5M16.5 18.5h5"/>'),
    stay: svg('<path d="M3 20V5"/><path d="M3 16h18v4"/><path d="M21 16v-3a3 3 0 0 0-3-3h-7v6"/><circle cx="7" cy="12" r="2"/>'),
    meals: svg('<path d="M6 3v6a3 3 0 0 0 6 0V3"/><path d="M9 3v18"/><path d="M17 21V3c-2.5 1-4 4-4 8h4"/>'),
    stationery: svg('<path d="M4 20l1-5L16 4a2.1 2.1 0 0 1 3 3L8 18z"/><path d="M14 6l3 3"/>'),
    other: svg('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'),
    file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  };
  const KIND_LABEL = { fuel: 'Petrol', toll: 'Toll', parking: 'Parking', medical: 'Medical', ai: 'AI tools', stay: 'Accommodation', meals: 'Meals', stationery: 'Stationery', other: 'Other' };
  const kindOf = (cat) => {
    const c = String(cat || '');
    return /petrol|fuel/i.test(c) ? 'fuel' : /toll/i.test(c) ? 'toll' : /parking/i.test(c) ? 'parking'
      : /medical|klinik|clinic|pharmac|farmasi/i.test(c) ? 'medical' : /\bai\b|software|subscription|saas/i.test(c) ? 'ai'
        : /accommodation|hotel/i.test(c) ? 'stay' : /meal|food|lunch|dinner|makan/i.test(c) ? 'meals' : /stationer|office suppl/i.test(c) ? 'stationery' : 'other';
  };
  function icon(kind, cls) { const e = h('span', { class: `ico ${cls || ''} k-${kind}` }); e.innerHTML = ICON[kind]; return e; }

  /* ---------- state ---------- */
  const S = {
    real: [], sampleList: [], sample: false, address: '', connected: false, firstLoad: true, loading: false, error: '', loadedAt: null,
    f: { month: 'all', staff: 'all', status: 'all', q: '' }, sort: { key: 'updatedAt', dir: -1 },
    open: null, prev: null, fresh: new Set(), saving: 0, blobs: new Map(), lastFocus: null, drawerSig: '', draft: { id: '', text: null },
  };
  const all = () => (S.sample ? S.sampleList : S.real);
  const find = (id) => all().find((c) => c.id === id);

  function matchesQuery(c, q) {
    if (!q) return true;
    const hay = [c.claimant, c.monthLabel, c.note, c.from, STATUS[c.status]].concat(c.lines.map((l) => [l.category, l.name, l.receiptNo].join(' '))).join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
  const inScope = (c) => (S.f.month === 'all' || c.month === S.f.month) && (S.f.staff === 'all' || c.claimant === S.f.staff) && matchesQuery(c, S.f.q.trim());
  const inView = (c) => inScope(c) && (S.f.status === 'all' || c.status === S.f.status);

  const SORTERS = {
    claimant: (a, b) => a.claimant.localeCompare(b.claimant), month: (a, b) => a.month.localeCompare(b.month),
    lines: (a, b) => a.lines.length - b.lines.length, total: (a, b) => a.total - b.total,
    updatedAt: (a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)),
    status: (a, b) => STATUS_RANK.indexOf(a.status) - STATUS_RANK.indexOf(b.status),
  };

  /* ---------- loading ---------- */
  async function load(quiet) {
    if (S.loading) return;
    S.loading = true; paintTop();
    try {
      if (!S.address) S.address = await Inbox.connect();
      if (!S.address) { S.connected = false; S.error = ''; return; }
      const claims = await Inbox.list();
      S.connected = true; S.error = ''; S.loadedAt = new Date();
      if (!S.saving) applyClaims(claims);
    } catch (e) {
      S.error = (e && e.message) || String(e);
      if (!S.real.length) S.connected = false;
    } finally {
      S.loading = false; S.firstLoad = false; render();
      if (!quiet && S.error) toast(S.error, true);
    }
  }

  function applyClaims(next) {
    const changed = [];
    if (S.prev) next.forEach((c) => { if (S.prev.get(c.id) !== c.updatedAt) changed.push(c.id); });
    changed.forEach((id) => { S.fresh.add(id); setTimeout(() => { S.fresh.delete(id); }, 6000); });      // each highlight fades on its own timer
    S.prev = new Map(next.map((c) => [c.id, c.updatedAt]));
    // a claim that did not change stays the very same object, so the open panel never holds on to an outdated copy
    const old = new Map(S.real.map((c) => [c.id, c]));
    S.real = next.map((n) => { const o = old.get(n.id); return o && sigOf(o) === sigOf(n) ? o : n; });
    if (changed.length) {
      const first = next.find((c) => c.id === changed[0]);
      toast(changed.length === 1 ? `${first.claimant} sent a claim for ${first.monthLabel}` : `${changed.length} claims are new or updated`);
    }
  }

  /* ---------- drawing the page ---------- */
  function render() {
    paintTop(); paintBanner(); paintFilters(); paintTiles(); paintTable(); paintSpend();
    if (S.open) {                  // the panel is only redrawn when its claim changed, so a note being typed is not wiped by the 20-second refresh
      const c = find(S.open);
      if (!c) closeDrawer(); else if (S.drawerSig !== sigOf(c)) paintDrawer(true);
    }
  }
  const sigOf = (c) => [c.id, c.version, c.updatedAt, c.status, c.note, (c.history || []).length, S.sample].join('|');

  function paintTop() {
    const t = $('#updText');
    t.textContent = S.sample ? 'Showing sample claims' : S.loadedAt ? `Updated ${clock(S.loadedAt)}` : '';
    const b = $('#btnRefresh');
    b.disabled = S.loading || S.sample; b.textContent = S.loading ? 'Refreshing…' : 'Refresh';
  }

  function paintBanner() {
    const box = $('#banner');
    box.textContent = '';
    if (S.sample) {
      box.append(h('div', { class: 'banner' }, h('b', { text: 'Sample claims.' }), 'Made-up examples to show how this page looks. None of it is real, and nothing you click here is saved.',
        h('button', { class: 'link', type: 'button', text: 'Back to real claims', onclick: () => { S.sample = false; S.open = null; closeDrawer(); render(); } })));
    } else if (S.error && S.connected) {
      box.append(h('div', { class: 'banner warn' }, `Couldn't refresh (${S.error}). Showing the last list.`, h('button', { class: 'link', type: 'button', text: 'Try again', onclick: () => load() })));
    }
  }

  function setOptions(sel, options, value) {
    const sig = options.map((o) => o[0] + '|' + o[1]).join('\n');
    if (sel.dataset.sig !== sig) {
      sel.textContent = '';
      options.forEach(([v, label]) => sel.append(h('option', { value: v, text: label })));
      sel.dataset.sig = sig;
    }
    sel.value = options.some((o) => o[0] === value) ? value : options[0][0];
  }

  function paintFilters() {
    const list = all();
    const months = Array.from(new Map(list.map((c) => [c.month, c.monthLabel]))).sort((a, b) => b[0].localeCompare(a[0]));
    const staff = Array.from(new Set(list.map((c) => c.claimant))).sort((a, b) => a.localeCompare(b));
    if (S.f.month !== 'all' && !months.some((m) => m[0] === S.f.month)) S.f.month = 'all';
    if (S.f.staff !== 'all' && !staff.includes(S.f.staff)) S.f.staff = 'all';
    setOptions($('#fMonth'), [['all', 'All months']].concat(months), S.f.month);
    setOptions($('#fStaff'), [['all', 'Everyone']].concat(staff.map((s) => [s, s])), S.f.staff);
  }

  function paintTiles() {
    const box = $('#tiles');
    const scoped = all().filter(inScope);
    box.textContent = '';
    STATUS_KEYS.forEach((k) => {
      const mine = scoped.filter((c) => c.status === k);
      const sum = mine.reduce((a, c) => a + c.total, 0);
      box.append(h('button', {
        class: `tile s-${k}`, type: 'button', 'aria-pressed': S.f.status === k ? 'true' : 'false', title: S.f.status === k ? 'Click again to show all' : `Show only: ${STATUS[k]}`,
        onclick: () => { S.f.status = S.f.status === k ? 'all' : k; render(); },
      }, h('span', { class: 'tl' }, h('span', { class: 'dot' }), STATUS[k]), h('span', { class: 'tn', text: String(mine.length) }), h('span', { class: 'ta', text: mine.length ? money(sum) : '–' })));
    });
  }

  function paintTable() {
    const rows = $('#rows'), empty = $('#empty'), scroll = $('#tbl').closest('.scroll');
    const list = all().filter(inView).sort((a, b) => S.sort.dir * (SORTERS[S.sort.key](a, b) || String(a.id).localeCompare(b.id)));
    document.querySelectorAll('.sort').forEach((b) => { if (b.dataset.sort === S.sort.key) b.dataset.dir = String(S.sort.dir); else delete b.dataset.dir; });
    rows.textContent = '';
    list.forEach((c) => {
      const open = () => openDrawer(c.id);
      rows.append(h('tr', { tabindex: '0', 'data-id': c.id, class: S.fresh.has(c.id) ? 'fresh' : '', onclick: open, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
        h('td', {}, h('div', { class: 'who' }, c.claimant, c.sample ? h('span', { class: 'tag', text: 'Sample' }) : null), h('div', { class: 'sub show-sm', text: `${c.monthLabel} · ${c.lines.length} lines · ${ago(c.updatedAt)}` })),
        h('td', { class: 'hide-sm', text: c.monthLabel }),
        h('td', { class: 'num hide-sm', text: String(c.lines.length) }),
        h('td', { class: 'num total', text: money(c.total) }),
        h('td', { class: 'hide-sm muted', title: fullWhen(c.updatedAt), text: ago(c.updatedAt) }),
        h('td', {}, h('span', { class: `pill s-${c.status}`, text: STATUS[c.status] }))));
    });

    const total = list.reduce((a, c) => a + c.total, 0);
    const tf = $('#tfoot');
    tf.textContent = '';
    if (list.length) tf.append(h('span', {}, `${list.length} claim${list.length > 1 ? 's' : ''}`), h('span', {}, 'Total ', h('b', { text: money(total) })));

    scroll.hidden = !list.length;
    empty.hidden = !!list.length;
    empty.textContent = '';
    if (list.length) return;
    const btn = (text, fn, cls) => h('button', { class: cls || 'ghost', type: 'button', text, onclick: fn });
    if (S.firstLoad) empty.append(h('p', { text: 'Loading claims…' }));
    else if (!S.sample && !S.connected) {
      empty.append(h('h3', { text: "Can't find the claims inbox" }),
        h('p', { text: 'This page is not connected to where claims are sent yet. Start the local inbox with Start.bat, or put the Google address in js/config.js.' }),
        h('div', { class: 'row' }, btn('Try again', () => { S.address = ''; load(); }, 'primary'), btn('Show sample claims', showSample)));
    } else if (!all().length) {
      empty.append(h('h3', { text: 'No claims yet' }), h('p', { text: 'When someone presses Save my claim in the Claim Builder, it shows up here within a few seconds.' }),
        S.sample ? null : btn('Show sample claims', showSample));
    } else {
      empty.append(h('h3', { text: 'Nothing matches' }), h('p', { text: 'Try a different month, person or search word.' }),
        btn('Clear filters', () => { S.f = { month: 'all', staff: 'all', status: 'all', q: '' }; $('#fSearch').value = ''; render(); }));
    }
  }

  function showSample() { S.sample = true; S.sampleList = WFC_SAMPLE(); S.f = { month: 'all', staff: 'all', status: 'all', q: '' }; $('#fSearch').value = ''; render(); }

  function paintSpend() {
    const box = $('#spend'), list = all().filter(inView);
    const by = new Map();
    list.forEach((c) => c.lines.forEach((l) => { const k = kindOf(l.category); by.set(k, (by.get(k) || 0) + (Number(l.amount) || 0)); }));
    const rows = Array.from(by).sort((a, b) => b[1] - a[1]);
    const sum = rows.reduce((a, r) => a + r[1], 0);
    const scope = [S.f.month === 'all' ? 'All months' : (all().find((c) => c.month === S.f.month) || {}).monthLabel, S.f.staff === 'all' ? null : S.f.staff, S.f.status === 'all' ? null : STATUS[S.f.status]].filter(Boolean).join(' · ');
    box.textContent = '';
    box.append(h('div', {}, h('h2', { text: 'Spend by type' }), h('div', { class: 'sub', text: scope })));
    if (!rows.length) { box.append(h('div', { class: 'none', text: 'Nothing to show yet.' })); return; }
    box.append(h('div', { class: 'bars' }, rows.map(([k, v]) => {
      const fill = h('div', { class: 'fill' }); fill.style.width = (v / rows[0][1] * 100).toFixed(1) + '%';
      return h('div', { class: 'bar' },
        h('div', { class: 'bt' }, icon(k), h('span', { class: 'bn', text: KIND_LABEL[k] }), h('span', { class: 'ba', text: money(v) }), h('span', { class: 'bp', text: Math.round(v / sum * 100) + '%' })),
        h('div', { class: 'track' }, fill));
    })));
  }

  /* ---------- one claim, in the side panel ---------- */
  function openDrawer(id) {
    S.open = id; S.lastFocus = document.activeElement;
    $('#scrim').hidden = false; $('#drawer').hidden = false; document.body.style.overflow = 'hidden';
    paintDrawer(false);
    $('#drawer').scrollTop = 0;
    const x = $('#drawer .x'); if (x) x.focus();
  }

  function closeDrawer() {
    S.open = null;
    $('#scrim').hidden = true; $('#drawer').hidden = true; document.body.style.overflow = '';
    if (S.lastFocus && document.contains(S.lastFocus)) S.lastFocus.focus();
  }

  function paintDrawer(keepScroll) {
    const c = find(S.open), d = $('#drawer');
    if (!c) { closeDrawer(); return; }
    const top = d.scrollTop;
    S.drawerSig = sigOf(c);
    if (S.draft.id !== c.id) S.draft = { id: c.id, text: null };
    const noteBox = h('textarea', { rows: '3', placeholder: 'Add a note for yourself or the claimant (optional)', maxlength: '600' });
    noteBox.value = S.draft.text != null ? S.draft.text : (c.note || '');      // what was typed but not saved yet stays
    const saveNote = h('button', { class: 'primary sm', type: 'button', text: 'Save note', disabled: noteBox.value.trim() === (c.note || ''), onclick: () => saveNoteNow(c.id, noteBox.value, saveNote) });
    noteBox.addEventListener('input', () => { S.draft.text = noteBox.value; saveNote.disabled = noteBox.value.trim() === (c.note || ''); });

    const receiptsFor = (l) => (c.files || []).filter((f) => (f.kind === 'receipt' && f.line === l.no) || ((kindOf(l.category) === 'toll' || kindOf(l.category) === 'parking') && f.kind === 'tollcheck'));
    const fileKind = { 'form-pdf': 'Claim form (PDF)', 'form-xlsx': 'Claim form (Excel)', tng: "Touch 'n Go statement", tollcheck: 'Toll check list', receipt: 'Receipt', other: 'File' };

    d.textContent = '';
    d.append(
      h('div', { class: 'dhead' },
        h('div', { class: 't' }, h('h2', {}, c.claimant, c.sample ? h('span', { class: 'tag', text: 'Sample' }) : null), h('div', { class: 's', text: `${c.monthLabel} · sent ${fullWhen(c.updatedAt)}${c.version > 1 ? ` · version ${c.version}` : ''}` })),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: closeDrawer })),
      h('div', { class: 'dbody' },
        h('div', { class: 'big' }, h('span', { class: 'n', text: money(c.total) }), h('span', { class: 'l', text: `${c.lines.length} line${c.lines.length > 1 ? 's' : ''}` })),

        h('div', { class: 'sec' }, h('h3', { text: 'Status' }),
          h('div', { class: 'seg', role: 'group', 'aria-label': 'Status' }, STATUS_KEYS.map((k) => h('button', { class: `s-${k}`, type: 'button', 'aria-pressed': c.status === k ? 'true' : 'false', onclick: () => changeStatus(c.id, k) }, h('span', { class: 'dot' }), STATUS[k]))),
          h('div', { class: 'note-row' }, noteBox, h('div', { class: 'acts' }, saveNote))),

        h('div', { class: 'sec' }, h('h3', { text: 'Lines' }),
          c.lines.map((l) => {
            const rc = receiptsFor(l);
            return h('div', { class: 'ln' }, icon(kindOf(l.category)),
              h('div', { style: 'min-width:0' }, h('div', { class: 'nm', text: l.name || l.category }),
                h('div', { class: 'dt', text: [l.category, niceDate(l.date), l.receiptNo ? 'No. ' + l.receiptNo : ''].filter(Boolean).join(' · ') })),
              h('div', {}, h('div', { class: 'am', text: money(l.amount) }),
                rc.length ? h('div', { class: 'vw' }, rc.map((f, i) => h('button', { class: 'link', type: 'button', text: f.kind === 'tollcheck' ? 'Toll list' : rc.length > 1 ? `Receipt ${i + 1}` : 'Receipt', onclick: () => viewFile(c, f) }))) : null));
          }),
          h('div', { class: 'ltot' }, h('span', { text: 'Total' }), h('span', { text: money(c.total) }))),

        h('div', { class: 'sec' }, h('h3', { text: 'Files' }),
          c.sample ? h('div', { class: 'sample-note', text: 'Sample claims have no files. A real claim lists its claim form, statement and receipts here.' })
            : !(c.files || []).length ? h('div', { class: 'sample-note', text: 'No files came with this claim.' })
              : h('div', {}, (c.files || []).map((f) => h('div', { class: 'fl' },
                h('div', { style: 'min-width:0' }, h('div', { class: 'fn', title: f.name, text: f.name }), h('div', { class: 'fs', text: `${fileKind[f.kind] || 'File'} · ${sizeText(f.size)}` })),
                h('div', { class: 'fa' }, h('button', { class: 'link', type: 'button', text: 'View', onclick: () => viewFile(c, f) }), h('button', { class: 'link', type: 'button', text: 'Download', onclick: () => downloadFile(c, f) })))),
                h('div', { style: 'margin-top:12px' }, h('button', { class: 'ghost', type: 'button', id: 'btnAllFiles', text: `Download everything (.zip)`, onclick: (e) => downloadAll(c, e.currentTarget) })))),

        h('div', { class: 'sec' }, h('h3', { text: 'Sent' }),
          h('dl', { class: 'kv' },
            h('dt', { text: 'From' }), h('dd', { text: c.from || '–' }),
            h('dt', { text: 'To' }), h('dd', { text: c.to || '–' }),
            h('dt', { text: 'Subject' }), h('dd', { text: c.subject || '–' }))),

        h('div', { class: 'sec' }, h('h3', { text: 'History' }),
          h('ul', { class: 'hist' }, (c.history || []).slice().reverse().map((e) => h('li', {}, e.text, h('time', { text: fullWhen(e.at) })))))));
    if (keepScroll) d.scrollTop = top;
  }

  async function changeStatus(id, status) {
    const c = find(id);                        // looked up now, not when the panel was drawn: a refresh may have replaced the claim since
    if (!c || c.status === status) return;
    const before = { status: c.status, statusAt: c.statusAt, history: (c.history || []).slice() };
    const at = new Date().toISOString();
    c.status = status; c.statusAt = at; c.history = (c.history || []).concat({ at, text: `Marked as ${STATUS[status]}` });
    render();
    if (c.sample) { toast(`Marked as ${STATUS[status]} (sample only)`); return; }
    S.saving++;
    try {
      Object.assign(c, await Inbox.setStatus(c.id, status));
      toast(`${c.claimant}: marked as ${STATUS[status]}`);
    } catch (e) {
      Object.assign(c, before);
      toast("Couldn't save that: " + ((e && e.message) || e), true);
    } finally { S.saving--; render(); }
  }

  async function saveNoteNow(id, text, btn) {
    const c = find(id);
    if (!c) return;
    const note = text.trim();
    if (c.sample) { c.note = note; S.draft = { id: c.id, text: null }; toast('Note kept (sample only)'); render(); return; }
    btn.disabled = true; btn.textContent = 'Saving…'; S.saving++;
    try { Object.assign(c, await Inbox.setStatus(c.id, c.status, note)); S.draft = { id: c.id, text: null }; toast('Note saved'); }
    catch (e) { toast("Couldn't save the note: " + ((e && e.message) || e), true); btn.disabled = false; btn.textContent = 'Save note'; }
    finally { S.saving--; render(); }
  }

  /* ---------- files ---------- */
  function b64Blob(b64, mime) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: mime || 'application/octet-stream' });
  }

  async function fetchBlob(c, f) {
    const key = `${c.id}|${c.version}|${f.id}`;
    if (!S.blobs.has(key)) {
      const r = await Inbox.file(c.id, f.id);
      S.blobs.set(key, b64Blob(r.data, r.mime || f.mime));
    }
    return S.blobs.get(key);
  }

  function saveAs(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  async function downloadFile(c, f) {
    try { saveAs(await fetchBlob(c, f), f.name); } catch (e) { toast("Couldn't get that file: " + ((e && e.message) || e), true); }
  }

  async function downloadAll(c, btn) {
    const files = c.files || [];
    const label = btn.textContent;
    btn.disabled = true;
    try {
      const zip = new JSZip(), root = zip.folder(safe(`Claim - ${c.monthLabel} - ${c.claimant}`));
      for (let i = 0; i < files.length; i++) {
        btn.textContent = `Getting files… ${i + 1} of ${files.length}`;
        root.file(files[i].name, await fetchBlob(c, files[i]));
      }
      btn.textContent = 'Zipping…';
      saveAs(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), safe(`Claim - ${c.monthLabel} - ${c.claimant}`) + '.zip');
    } catch (e) { toast("Couldn't make the zip: " + ((e && e.message) || e), true); }
    btn.disabled = false; btn.textContent = label;
  }

  async function viewFile(c, f) {
    const dlg = $('#viewer'), body = $('#vBody'), dl = $('#vDownload');
    $('#vTitle').textContent = f.name;
    body.textContent = '';
    body.append(h('div', { class: 'msg', text: 'Loading…' }));
    dl.removeAttribute('href'); dl.setAttribute('download', f.name);
    if (!dlg.open) dlg.showModal();
    try {
      const blob = await fetchBlob(c, f), url = URL.createObjectURL(blob);
      dl.href = url;
      body.textContent = '';
      if (/^image\/(jpeg|png|webp|gif)/.test(blob.type)) body.append(h('img', { src: url, alt: f.name }));
      else if (blob.type === 'application/pdf') body.append(h('iframe', { src: url, title: f.name }));
      else body.append(h('div', { class: 'msg', text: "This kind of file can't be shown here. Use Download to open it in Excel or another app." }));
    } catch (e) {
      body.textContent = '';
      body.append(h('div', { class: 'msg', text: "Couldn't get that file: " + ((e && e.message) || e) }));
    }
  }

  /* ---------- export (CSV opens in Excel) ---------- */
  function csv(rows) {
    const cell = (v) => {
      let s = v == null ? '' : String(v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;      // text that Excel would run as a formula stays text
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  function exportCsv(kind) {
    const list = all().filter(inView).sort((a, b) => a.month.localeCompare(b.month) || a.claimant.localeCompare(b.claimant));
    if (!list.length) { toast('Nothing to export for this view.', true); return; }
    let rows;
    if (kind === 'lines') {
      rows = [['Staff', 'Month', 'Line', 'Type', 'Date', 'Description', 'Receipt no.', 'Amount (RM)', 'Status']];
      list.forEach((c) => c.lines.forEach((l) => rows.push([c.claimant, c.monthLabel, l.no, l.category, l.date, l.name, l.receiptNo, Number(l.amount).toFixed(2), STATUS[c.status]])));
    } else {
      rows = [['Staff', 'Month', 'Lines', 'Total (RM)', 'Status', 'Note', 'Sent', 'From', 'To', 'Subject']];
      list.forEach((c) => rows.push([c.claimant, c.monthLabel, c.lines.length, Number(c.total).toFixed(2), STATUS[c.status], c.note, c.updatedAt, c.from, c.to, c.subject]));
    }
    const d = new Date();
    saveAs(new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' }), `WFC claims${kind === 'lines' ? ' - every line' : ''} - ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`);
  }

  /* ---------- small bits ---------- */
  let toastTimer = 0;
  function toast(text, bad) {
    const t = $('#toast');
    t.textContent = text; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3500);
  }

  async function croppedLogo() {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = window.WFC_LOGO_PNG; });
    const sx = img.width * 0.16148, sy = img.height * 0.30219, sw = img.width * (1 - 0.16148 - 0.15802), sh = img.height * (1 - 0.30219 - 0.34717);
    const c = document.createElement('canvas'); c.width = Math.round(sw); c.height = Math.round(sh);
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  /* ---------- start ---------- */
  function init() {
    croppedLogo().then((u) => { $('#brandLogo').src = u; }).catch(() => $('#brandLogo').remove());
    $('#fMonth').addEventListener('change', (e) => { S.f.month = e.target.value; render(); });
    $('#fStaff').addEventListener('change', (e) => { S.f.staff = e.target.value; render(); });
    $('#fSearch').addEventListener('input', (e) => { S.f.q = e.target.value; render(); });
    document.querySelectorAll('.sort').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.sort;
      S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: ['claimant', 'month', 'status'].includes(k) ? 1 : -1 };
      render();
    }));
    $('#btnRefresh').addEventListener('click', () => load());
    $('#scrim').addEventListener('click', closeDrawer);
    $('#vClose').addEventListener('click', () => $('#viewer').close());
    $('#viewer').addEventListener('click', (e) => { if (e.target === $('#viewer')) $('#viewer').close(); });
    const menu = $('#exportMenu'), mb = $('#btnExport');
    const setMenu = (on) => { menu.hidden = !on; mb.setAttribute('aria-expanded', String(on)); };
    mb.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
    menu.addEventListener('click', (e) => { const b = e.target.closest('[data-export]'); if (b) { setMenu(false); exportCsv(b.dataset.export); } });
    document.addEventListener('click', () => setMenu(false));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!menu.hidden) setMenu(false); else if (!$('#viewer').open && S.open) closeDrawer();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.connected && !S.sample) load(true); });
    setInterval(() => { if (!document.hidden && S.connected && !S.sample && !S.saving) load(true); }, 20000);
    render();
    load();
  }

  window.__dash = { S, load, render, showSample, openDrawer, closeDrawer, csv };      // handy for testing
  init();
})();
