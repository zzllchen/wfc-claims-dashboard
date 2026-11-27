/* WFC Claims - the accountant's view. Reads the claims inbox; no login yet (on purpose, for the demo). */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const pad = (n) => String(n).padStart(2, '0');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const SHORT = MONTHS.map((m) => m.slice(0, 3));
  const LK = window.LeaveKit;       // dates and sums for leave (js/leave.js)

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
  const niceDay = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    if (!m) return '';
    return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]} ${+m[3]} ${SHORT[+m[2] - 1]} ${m[1]}`;
  };
  const sizeText = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const safe = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();

  /* ---------- statuses ---------- */
  const STATUS = { new: 'New', checked: 'Checked', paid: 'Paid', recorded: 'Recorded', question: 'Has a question' };
  const STATUS_KEYS = ['new', 'checked', 'paid', 'question'];                // a claim
  const LEAVE_STATUS_KEYS = ['new', 'recorded', 'question'];                 // a leave application: recorded = the office has filled in the balance
  const STATUS_RANK = ['new', 'question', 'checked', 'recorded', 'paid'];

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
    device: svg('<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>'),
    annual: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    unpaid: svg('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M16 14.5h2"/>'),
    personal: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
    leaveother: svg('<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>'),
  };
  Object.assign(ICON, {
    travel: svg('<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>'),
    transport: svg('<path d="M5 17h14v-5l-1.8-4.6A2 2 0 0 0 15.3 6H8.7a2 2 0 0 0-1.9 1.4L5 12z"/><path d="M5 12h14"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/>'),
    shopping: svg('<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>'),
    supplier: svg('<path d="M3 7h11v10H3z"/><path d="M14 10h4l3 3v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>'),
  });
  ICON.sick = ICON.medical;
  const KIND_LABEL = { fuel: 'Petrol', toll: 'Toll', parking: 'Parking', medical: 'Medical', ai: 'AI tools', device: 'Devices', stay: 'Accommodation', meals: 'Meals', stationery: 'Stationery',
    travel: 'Travel', transport: 'Transport', shopping: 'Online shopping', supplier: 'Supplier invoices', other: 'Other' };
  const kindOf = (cat) => {
    const c = String(cat || '');
    return /transport|grab|e-?hailing|taxi/i.test(c) ? 'transport' : /travel|flight|air\s?ticket|airfare|\btrains?\b|bus\s?ticket|ferry/i.test(c) ? 'travel'
      : /online|shopping|shopee|lazada/i.test(c) ? 'shopping' : /supplier|purchase/i.test(c) ? 'supplier'
      : /petrol|fuel/i.test(c) ? 'fuel' : /toll/i.test(c) ? 'toll' : /parking/i.test(c) ? 'parking'
      : /medical|klinik|clinic|pharmac|farmasi/i.test(c) ? 'medical' : /device|hardware|laptop|gadget|phone\b|tablet\b/i.test(c) ? 'device' : /\bai\b|software|subscription|saas/i.test(c) ? 'ai'
        : /accommodation|hotel/i.test(c) ? 'stay' : /meal|food|lunch|dinner|makan/i.test(c) ? 'meals' : /stationer|office suppl/i.test(c) ? 'stationery' : 'other';
  };
  function icon(kind, cls) { const e = h('span', { class: `ico ${cls || ''} k-${kind}` }); e.innerHTML = ICON[kind]; return e; }

  /* ---------- state ---------- */
  const S = {
    real: [], sampleList: [], realLeave: [], sampleLeave: [], view: 'claims', sample: false, address: '', connected: false, firstLoad: true, loading: false, error: '', loadedAt: null,
    f: { month: 'all', staff: 'all', status: 'all', q: '' }, sort: { key: 'updatedAt', dir: -1 },
    lf: { month: 'all', staff: 'all', status: 'all', q: '' }, lsort: { key: 'start', dir: -1 },        // the same, for the Leave tab
    open: null, prev: null, fresh: new Set(), saving: 0, blobs: new Map(), lastFocus: null, drawerSig: '', draft: { id: '', text: null },
    rules: null, sampleRules: null, photoMatches: [], photoBusy: false, pol: { busy: false, done: 0, total: 0, error: '', again: false }, audit: null, auditSig: '', auditAll: false,   // Flow's auditor
  };
  const all = () => (S.sample ? S.sampleList : S.real);
  const find = (id) => all().find((c) => c.id === id) || (S.sample ? S.sampleLeave : S.realLeave).find((c) => c.id === id);

  /* ---------- Flow's auditor (js/audit.js): fixed checks on every line, plus the company's own rules read by Claude through the inbox ---------- */
  const AUD = window.Audit;
  const POLICY_STORE = 'wfc-audit-rules-v1', PHOTO_STORE = 'wfc-audit-photos-v1', LOCAL_RULES = 'wfc-audit-rules-local';
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch (e) { return {}; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full, or private mode */ } },
  };
  // the sample view can try rules out without saving them; otherwise the company's rules from the inbox (or this computer, for an older inbox)
  const rulesText = () => (S.sample && S.sampleRules != null ? S.sampleRules : (S.rules && S.rules.text) || '');
  function auditNow() {
    if (!AUD) return null;
    const list = all(), lv = leaveAll(), rules = rulesText(), policy = {};
    if (rules) { const saved = store.get(POLICY_STORE); list.forEach((c) => { const hit = saved[AUD.policyKey(c, rules)]; if (hit) policy[c.id] = hit.f; }); }
    const sig = [list.map(sigOf).join(','), lv.map((v) => v.id + v.updatedAt).join(','), rules, Object.keys(policy).join(','), S.photoMatches.length, S.sample].join('|');
    if (sig !== S.auditSig) { S.audit = AUD.run(list, lv, { policy, photoMatches: S.sample ? [] : S.photoMatches }); S.auditSig = sig; }
    return S.audit;
  }
  const flagsFor = (id) => { const a = auditNow(); return (a && a.byClaim[id]) || []; };
  // the money on lines with a high or medium flag, each line once
  const atRiskOf = (flags) => { const m = new Map(); flags.forEach((f) => { if (f.level !== 'low' && !f.wholeClaim) m.set(`${f.claimId}#${f.line}`, f.amount); }); return Array.from(m.values()).reduce((a, n) => a + n, 0); };

  /* the company's rules, one claim at a time: each answer is kept in this browser under a key that changes with the claim or the rules */
  let polTimer = 0;
  const schedulePolicy = () => { clearTimeout(polTimer); polTimer = setTimeout(runPolicy, 800); };
  async function runPolicy() {
    const rules = rulesText();
    if (!AUD || !rules || S.locked || !Inbox.askOk || (Inbox.needsKey && !Inbox.hasKey())) return;
    if (S.pol.busy) { S.pol.again = true; return; }
    const saved = store.get(POLICY_STORE);
    const todo = all().filter((c) => !saved[AUD.policyKey(c, rules)]).slice(0, 40);
    if (!todo.length) { if (S.pol.error) { S.pol.error = ''; render(); } return; }
    S.pol = { busy: true, done: 0, total: todo.length, error: '', again: false };
    render();
    for (const c of todo) {
      if (rulesText() !== rules) break;                     // the rules changed meanwhile: start again with the new ones
      try {
        const found = AUD.policyFindings(await Inbox.ask(AUD.policyRequest(c, leaveAll(), rules, all())), c);
        const st = store.get(POLICY_STORE);
        st[AUD.policyKey(c, rules)] = { at: Date.now(), f: found };
        const keys = Object.keys(st);
        if (keys.length > 300) keys.sort((a, b) => st[a].at - st[b].at).slice(0, keys.length - 300).forEach((k) => { delete st[k]; });
        store.set(POLICY_STORE, st);
      } catch (e) {
        S.pol.busy = false;
        if (e && e.code === 401) { Inbox.clearKey(); showLock('The password was changed. Enter the new one.'); return; }
        S.pol.error = (e && e.message) || String(e);
        break;
      }
      S.pol.done++;
      render();
    }
    const again = S.pol.again;
    S.pol.busy = false; S.pol.again = false;
    render();
    if (again || rulesText() !== rules) schedulePolicy();
  }

  /* the same receipt photo on two lines: files of the same size and type are fetched and their fingerprints (SHA-256) compared */
  async function checkPhotos() {
    if (!AUD || S.sample || S.photoBusy || !(window.crypto && crypto.subtle)) return;
    const pairs = AUD.photoCandidates(S.real).slice(0, 12);
    if (!pairs.length) { if (S.photoMatches.length) { S.photoMatches = []; render(); } return; }
    S.photoBusy = true;
    const hashes = store.get(PHOTO_STORE), matches = [];
    const hashOf = async (p) => {
      const k = `${p.claimId}|${p.version}|${p.fileId}`;
      if (!hashes[k]) {
        const c = S.real.find((x) => x.id === p.claimId), f = c && (c.files || []).find((x) => x.id === p.fileId);
        if (!f) return '';
        const buf = await crypto.subtle.digest('SHA-256', await (await fetchBlob(c, f)).arrayBuffer());
        hashes[k] = Array.from(new Uint8Array(buf).slice(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join('');
      }
      return hashes[k];
    };
    try {
      for (const pr of pairs) {
        const a = await hashOf(pr.a), b = await hashOf(pr.b);
        if (a && a === b) matches.push({ a: { claimId: pr.a.claimId, line: pr.a.line }, b: { claimId: pr.b.claimId, line: pr.b.line } });
      }
    } catch (e) { /* a file could not be fetched: tried again on the next refresh */ }
    store.set(PHOTO_STORE, Object.keys(hashes).length > 600 ? {} : hashes);
    S.photoBusy = false;
    if (JSON.stringify(matches) !== JSON.stringify(S.photoMatches)) { S.photoMatches = matches; render(); }
  }

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
      if (Inbox.needsKey && !Inbox.hasKey()) { showLock(''); return; }          // a password is set and this browser does not have it yet
      const got = await Inbox.list();
      hideLock();
      S.connected = true; S.error = ''; S.loadedAt = new Date();
      if (!S.saving) applyClaims(got.claims, got.leave);
      S.rules = got.rules || (Inbox.rulesOk ? null : (store.get(LOCAL_RULES).text ? store.get(LOCAL_RULES) : null));
      schedulePolicy(); checkPhotos();
    } catch (e) {
      if (e && e.code === 401) { Inbox.clearKey(); S.real = []; S.realLeave = []; S.prev = null; showLock(S.askedPw ? "That password isn't right." : ''); return; }
      S.error = (e && e.message) || String(e);
      if (!S.real.length) S.connected = false;
    } finally {
      S.loading = false; S.firstLoad = false; render();
      if (!quiet && S.error) toast(S.error, true);
    }
  }

  /* ---------- the password screen (only when the inbox has a password) ---------- */
  function showLock(msg) {
    S.locked = true;
    $('#lock').hidden = false; $('#lockErr').textContent = msg || '';
    document.body.style.overflow = 'hidden';
    closeDrawer();
    setTimeout(() => $('#lockPw').focus(), 50);
  }
  function hideLock() {
    S.locked = false; S.askedPw = false;
    $('#lock').hidden = true; $('#lockPw').value = ''; $('#lockErr').textContent = '';
    if (!S.open) document.body.style.overflow = '';
  }

  function applyClaims(nextClaims, nextLeave) {
    const next = nextClaims.concat(nextLeave || []);
    const changed = [];
    if (S.prev) next.forEach((c) => { if (S.prev.get(c.id) !== c.updatedAt) changed.push(c.id); });
    changed.forEach((id) => { S.fresh.add(id); setTimeout(() => { S.fresh.delete(id); }, 6000); });      // each highlight fades on its own timer
    S.prev = new Map(next.map((c) => [c.id, c.updatedAt]));
    // an item that did not change stays the very same object, so the open panel never holds on to an outdated copy
    const keep = (oldList, list) => { const old = new Map(oldList.map((c) => [c.id, c])); return list.map((n) => { const o = old.get(n.id); return o && sigOf(o) === sigOf(n) ? o : n; }); };
    S.real = keep(S.real, nextClaims); S.realLeave = keep(S.realLeave, nextLeave || []);
    if (changed.length) {
      const first = next.find((c) => c.id === changed[0]);
      toast(changed.length > 1 ? `${changed.length} items are new or updated`
        : first.kind === 'leave' ? `${first.claimant} sent a leave application for ${LK.rangeText(first.start, first.end)}` : `${first.claimant} sent a claim for ${first.monthLabel}`);
    }
  }

  /* ---------- drawing the page ---------- */
  /* ---------- clean claims in one go: the New claims on screen that passed every check (see Audit.cleanClaims) ---------- */
  function cleanNow() {
    if (!AUD) return { ready: [], waiting: [] };
    const rules = rulesText(), read = rules ? store.get(POLICY_STORE) : null, waiting = new Set();
    if (!S.sample) {                                        // two lines whose photos still have to be compared (only the first 12 pairs ever are)
      const hashes = store.get(PHOTO_STORE);
      AUD.photoCandidates(S.real).forEach((p, i) => [p.a, p.b].forEach((x) => { if (i >= 12 || !hashes[`${x.claimId}|${x.version}|${x.fileId}`]) waiting.add(x.claimId); }));
    }
    const audit = auditNow();
    return AUD.cleanClaims(all().filter(inScope), (audit && audit.byClaim) || {}, { rulesRead: (c) => !rules || !!read[AUD.policyKey(c, rules)], waiting });
  }
  function paintClean() {
    const bar = $('#cleanBar'), { ready, waiting } = cleanNow(), n = ready.length;
    bar.hidden = !n && !waiting.length;
    const text = [];
    if (n) text.push(`${n} new claim${n > 1 ? 's' : ''} passed every check.`);
    if (waiting.length) text.push(`${waiting.length} more still being checked.`);
    $('#cleanText').textContent = text.join(' ');
    const b = $('#cleanBtn');
    b.hidden = !n; b.textContent = `Mark ${n} clean claim${n > 1 ? 's' : ''} as Checked`;
  }
  let cleanIds = [];
  function openClean() {
    const list = cleanNow().ready.slice().sort((a, b) => a.claimant.localeCompare(b.claimant) || a.month.localeCompare(b.month));
    if (!list.length) return;
    cleanIds = list.map((c) => c.id);
    $('#cleanList').textContent = '';
    list.forEach((c) => $('#cleanList').append(h('li', {}, h('span', {}, h('b', { text: c.claimant }), h('small', { text: `${c.monthLabel} · ${c.lines.length} receipt${c.lines.length > 1 ? 's' : ''}` })), h('b', { text: money(c.total) }))));
    $('#cleanSum').textContent = `${list.length} claim${list.length > 1 ? 's' : ''}, ${money(list.reduce((t, c) => t + Number(c.total || 0), 0))}`;
    $('#cleanDlg').showModal();
  }
  async function markClean() {
    $('#cleanDlg').close();
    const still = new Set(cleanNow().ready.map((c) => c.id));          // checked again: a claim may have changed while the list was open
    const ids = cleanIds.filter((id) => still.has(id));
    $('#cleanBtn').disabled = true;
    for (const id of ids) { if (S.locked) break; await changeStatus(id, 'checked'); }
    $('#cleanBtn').disabled = false;
    const done = ids.filter((id) => { const c = find(id); return c && c.status === 'checked'; }).length, left = cleanIds.length - done;
    toast(`Marked ${done} claim${done === 1 ? '' : 's'} as Checked${left ? `. ${left} not marked: look at ${left === 1 ? 'it' : 'them'} again.` : S.sample ? ' (sample only)' : '.'}`, !!left);
  }

  function render() {
    paintTop(); paintTabs(); paintBanner();
    if (S.view === 'leave') paintLeave(); else { paintFilters(); paintTiles(); paintTable(); paintAudit(); paintSpend(); paintSubs(); paintCarbon(); paintGlance(); paintClean(); }
    if (S.open) {                  // the panel is only redrawn when its claim changed, so a note being typed is not wiped by the 20-second refresh
      const c = find(S.open);
      if (!c) closeDrawer(); else if (S.drawerSig !== drawerSigOf(c)) paintDrawer(true);
    }
  }
  const sigOf = (c) => [c.id, c.version, c.updatedAt, c.status, c.note, (c.history || []).length, S.sample].join('|');
  const drawerSigOf = (c) => sigOf(c) + '|' + (c.kind === 'leave' ? '' : flagsFor(c.id).map((f) => f.key).join(','));

  /* the two tabs, each with how many are still New */
  function paintTabs() {
    [['claims', all(), '#cntClaims'], ['leave', leaveAll(), '#cntLeave']].forEach(([v, list, id]) => {
      const n = list.filter((c) => c.status === 'new').length, el = $(id);
      el.textContent = String(n); el.hidden = !n;
    });
    $('#tabClaims').classList.toggle('on', S.view === 'claims'); $('#tabLeave').classList.toggle('on', S.view === 'leave');
    $('#tabClaims').setAttribute('aria-selected', String(S.view === 'claims')); $('#tabLeave').setAttribute('aria-selected', String(S.view === 'leave'));
  }

  function setView(v, keepUrl) {
    const next = v === 'leave' ? 'leave' : 'claims';
    if (next !== S.view && S.open) closeDrawer();
    if (next !== S.view && S.ip) closeInsight();
    S.view = next;
    $('#viewClaims').hidden = next !== 'claims'; $('#viewLeave').hidden = next !== 'leave';
    document.querySelectorAll('#exportMenu [data-view]').forEach((b) => { b.hidden = b.dataset.view !== next; });
    if (!keepUrl) { try { history.replaceState(null, '', next === 'leave' ? '#leave' : location.pathname + location.search); } catch (e) { /* not allowed here */ } }
    render();
    stickyCheck(true);
  }

  function paintTop() {
    $('#btnLock').hidden = !(Inbox.needsKey && Inbox.hasKey() && !S.locked);
    const t = $('#updText');
    t.textContent = S.sample ? 'Showing sample claims' : S.loadedAt ? `Updated ${clock(S.loadedAt)}` : '';
    const b = $('#btnRefresh');
    b.disabled = S.loading || S.sample; b.textContent = S.loading ? 'Refreshing…' : 'Refresh';
  }

  function paintBanner() {
    const box = $('#banner');
    box.textContent = '';
    if (S.sample) {
      box.append(h('div', { class: 'banner' }, h('b', { text: 'Sample claims and leave.' }), 'Made-up examples to show how this page looks. None of it is real, and nothing you click here is saved.',
        h('button', { class: 'link', type: 'button', text: 'Back to real data', onclick: () => { S.sample = false; S.open = null; closeDrawer(); render(); schedulePolicy(); } })));
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
    if (window.FlowSelect) window.FlowSelect.sync(sel);          // Flow's own dropdown shows the same choice
  }

  function paintFilters() {
    const list = all();
    const months = Array.from(new Map(list.map((c) => [c.month, c.monthLabel]))).sort((a, b) => b[0].localeCompare(a[0]));
    const staff = Array.from(new Set(list.map((c) => c.claimant))).sort((a, b) => a.localeCompare(b));
    if (S.f.month !== 'all' && !months.some((m) => m[0] === S.f.month)) S.f.month = 'all';
    if (S.f.staff !== 'all' && !staff.includes(S.f.staff)) S.f.staff = 'all';
    setOptions($('#fMonth'), [['all', 'All months']].concat(months), S.f.month);
    setOptions($('#fStaff'), [['all', 'Everyone']].concat(staff.map((s) => [s, s])), S.f.staff);
    $('#fClear').hidden = S.f.month === 'all' && S.f.staff === 'all' && S.f.status === 'all' && !S.f.q.trim();
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
    document.querySelectorAll('#tbl .sort').forEach((b) => { if (b.dataset.sort === S.sort.key) b.dataset.dir = String(S.sort.dir); else delete b.dataset.dir; });
    rows.textContent = '';
    list.forEach((c) => {
      const open = () => openDrawer(c.id);
      rows.append(h('tr', { tabindex: '0', 'data-id': c.id, class: S.fresh.has(c.id) ? 'fresh' : '', onclick: open, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
        h('td', {}, h('div', { class: 'who' }, c.claimant, c.sample ? h('span', { class: 'tag', text: 'Sample' }) : null, flagChip(c)), h('div', { class: 'sub show-sm', text: `${c.monthLabel} · ${c.lines.length} lines · ${ago(c.updatedAt)}` })),
        h('td', { class: 'hide-sm', title: c.monthLabel, text: /^\d{4}-\d{2}$/.test(c.month) ? `${SHORT[+c.month.slice(5, 7) - 1]} ${c.month.slice(0, 4)}` : c.monthLabel }),
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

  function showSample() {
    S.sample = true; S.sampleList = WFC_SAMPLE(); S.sampleLeave = WFC_SAMPLE_LEAVE();
    S.f = { month: 'all', staff: 'all', status: 'all', q: '' }; S.lf = { month: 'all', staff: 'all', status: 'all', q: '' };
    $('#fSearch').value = ''; $('#lSearch').value = ''; S.sampleRules = null; render(); schedulePolicy();
  }

  const scopeText = () => [S.f.month === 'all' ? 'All months' : (all().find((c) => c.month === S.f.month) || {}).monthLabel, S.f.staff === 'all' ? null : S.f.staff, S.f.status === 'all' ? null : STATUS[S.f.status]].filter(Boolean).join(' · ');

  /* ---------- the auditor card: what to check before paying, in the claims in view ---------- */
  const SHIELD = svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>');
  const FLAG = svg('<path d="M5 21V4"/><path d="M5 4h11l-2.5 4L16 12H5"/>');
  const LEVEL_WORD = { high: 'High', medium: 'Medium', low: 'Low' };
  function flagChip(c) {
    const fl = flagsFor(c.id).filter((f) => f.level !== 'low');
    if (!fl.length) return null;
    const e = h('span', { class: `flagchip lvl-${fl[0].level}`, title: `${fl.length} thing${fl.length > 1 ? 's' : ''} to check (Flow auditor)` });
    e.innerHTML = FLAG; e.append(String(fl.length));
    return e;
  }
  const flagMeta = (f) => [f.staff, f.monthLabel, f.wholeClaim ? 'whole claim' : `line ${f.line}`, f.wholeClaim ? '' : money(f.amount)].filter(Boolean).join(' · ');
  function paintAudit() {
    const box = $('#audit'); if (!box) return;
    box.textContent = '';
    const a = auditNow();
    if (!a) return;
    const inv = all().filter(inView), ids = new Set(inv.map((c) => c.id));
    const flags = a.flags.filter((f) => ids.has(f.claimId));
    const nLines = inv.reduce((n, c) => n + c.lines.length, 0);
    const counts = { high: 0, medium: 0, low: 0 };
    flags.forEach((f) => { counts[f.level]++; });
    const serious = counts.high + counts.medium, rules = rulesText();
    const title = h('h2', {}); title.innerHTML = SHIELD; title.append('Flow auditor');
    box.append(h('div', { class: 'ahead' }, h('div', {}, title, h('div', { class: 'sub', text: scopeText() })),
      h('button', { class: 'ghost sm', type: 'button', text: rules ? 'Company rules' : 'Add company rules', onclick: openRules })));
    if (!nLines) { box.append(h('div', { class: 'none', text: 'No claims in this view.' })); return; }
    box.append(serious
      ? h('div', { class: 'aud-num' }, h('b', { text: String(serious) }), h('span', {}, `to check`, h('small', { text: `${money(atRiskOf(flags))} on these lines` })))
      : h('div', { class: 'aud-num clear' }, h('b', { text: 'All clear' }), h('span', {}, h('small', { text: counts.low ? `${counts.low} small point${counts.low > 1 ? 's' : ''} below` : 'Nothing to check' }))));
    const ruleNote = !rules ? ' Add your company rules to check claims against them too.'
      : S.pol.busy ? ` Checking against your rules: ${S.pol.done} of ${S.pol.total} claims…`
        : S.pol.error ? ` The rule check stopped: ${S.pol.error}`
          : !Inbox.askOk ? ' The rule check needs the Google inbox.' : ' Also checked against your company rules.';
    box.append(h('p', { class: 'aud-what' }, `Checked ${nLines} line${nLines > 1 ? 's' : ''} on ${inv.length} claim${inv.length > 1 ? 's' : ''}.`, h('span', { class: S.pol.busy ? 'busy' : S.pol.error ? 'err' : '', text: ruleNote })));
    if (flags.length) box.append(h('div', { class: 'aud-levels' }, AUD.LEVELS.filter((l) => counts[l]).map((l) => h('span', { class: `lvl lvl-${l}` }, h('i'), `${LEVEL_WORD[l]} ${counts[l]}`))));
    const top = flags.filter((f) => f.level !== 'low');
    const shown = S.auditAll ? flags : (top.length ? top : flags).slice(0, 5);
    if (shown.length) {
      box.append(h('div', { class: 'aud-list' }, shown.map((f) => h('button', { class: `aud-item lvl-${f.level}`, type: 'button', title: 'Open this claim', onclick: () => openDrawer(f.claimId, f.line) },
        h('i', { class: 'ldot' }),
        h('span', { class: 'aud-body' }, h('b', { text: f.title }), h('span', { class: 'aud-why', text: f.reason }), h('span', { class: 'aud-meta', text: flagMeta(f) }))))));
      if (flags.length > shown.length || S.auditAll) box.append(h('button', { class: 'link aud-more', type: 'button', text: S.auditAll ? 'Show fewer' : `Show all ${flags.length}`, onclick: () => { S.auditAll = !S.auditAll; paintAudit(); } }));
    }
    box.append(h('div', { class: 'how' }, h('b', { text: 'How it works. ' }), 'Each line is checked against every claim, from everyone, in every month, and against your company rules (read by Claude). Flags are for you to look at; nothing is refused on its own.'));
  }

  /* ---------- at a glance: four summary cards over the claims list; each opens its full details in the side panel ---------- */
  const BARS = svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>');
  const GLANCE_ICON = { audit: () => SHIELD, spend: () => BARS, subs: () => LAYERS, carbon: () => LEAF };
  const SHORT_LABEL = { subs: 'AI & software' };          // on phones, where the full name does not fit beside the number
  function paintGlance() {
    const box = $('#ins'); if (!box) return;
    const inv = all().filter(inView), ids = new Set(inv.map((c) => c.id));
    const nLines = inv.reduce((n, c) => n + c.lines.length, 0);
    // every card has the same parts: a header, the headline number, one bar, its colour key, and a short line at the bottom
    const seg = (parts, total) => h('span', { class: 'icbar' }, parts.map((p) => { const i = h('i', { class: p.cls || '', title: p.title || '' }); if (p.color) i.style.background = p.color; i.style.width = (p.v / (total || 1) * 100).toFixed(2) + '%'; return i; }));
    const key = (parts) => h('span', { class: 'iclg' }, parts.map((p) => { const d = h('i', { class: p.cls || '' }); if (p.color) d.style.background = p.color; return h('span', { class: `lg ${p.cls || ''}`, title: p.title || '' }, d, h('span', { class: 'lgn', text: p.name }), p.val ? h('b', { text: p.val }) : null); }));
    const card = (k, cls, label, value, unit, viz, foot, footCls) => {
      const ic = h('span', { class: 'ici' }); ic.innerHTML = GLANCE_ICON[k]();
      return h('button', { class: `icard ic-${k} ${cls || ''}`, type: 'button', 'aria-label': `${label}: ${value}${unit ? ' ' + unit : ''}. Open the details.`, onclick: () => openInsight(k) },
        h('span', { class: 'ich' }, ic, h('span', { class: 'icl' }, h('span', { class: 'lf', text: label }), SHORT_LABEL[k] ? h('span', { class: 'ls', text: SHORT_LABEL[k] }) : null), h('span', { class: 'icgo', 'aria-hidden': 'true', text: '›' })),
        h('span', { class: 'icv' }, h('b', { text: value }), unit ? h('small', { text: unit }) : null),
        viz || h('span', { class: 'icbar none' }),
        foot ? h('span', { class: `ics ${footCls || ''}`, text: foot }) : null);
    };
    // the biggest two in their own colours, the rest together as "N more" (three items: the key fits the card without cutting names)
    const topParts = (rows, name, val, colors) => {
      const parts = (rows.length <= 3 ? rows : rows.slice(0, 2)).map((r, i) => ({ name: name(r), v: r.v, val: val(r.v), color: colors[i] }));
      if (rows.length > 3) { const rest = rows.slice(2), v = rest.reduce((t, r) => t + r.v, 0); parts.push({ name: `${rest.length} more`, v, val: val(v), cls: 'k-rest', title: rest.map((r) => `${name(r)} ${val(r.v)}`).join(', ') }); }
      return parts;
    };
    const pct = (v, sum) => { const n = v / (sum || 1) * 100; return n > 0 && n < 1 ? '<1%' : `${Math.round(n)}%`; };
    box.textContent = '';

    // 1. the auditor: how many to check, by level
    const a = auditNow(), flags = a ? a.flags.filter((f) => ids.has(f.claimId)) : [];
    const lv = { high: 0, medium: 0, low: 0 };
    flags.forEach((f) => { lv[f.level]++; });
    const serious = lv.high + lv.medium, rules = rulesText();
    const ruleLine = S.pol.busy ? `Checking against your rules (${S.pol.done} of ${S.pol.total})` : rules ? 'Company rules checked too' : 'Every line checked';
    if (!nLines) box.append(card('audit', 'empty', 'Flow auditor', '–', '', null, 'No claims in this view'));
    else if (serious) {
      const parts = ['high', 'medium', 'low'].filter((l) => lv[l]).map((l) => ({ name: LEVEL_WORD[l], v: lv[l], val: String(lv[l]), cls: `lvl-${l}` }));
      box.append(card('audit', 'alert', 'Flow auditor', String(serious), 'to check', h('span', { class: 'icviz' }, seg(parts, flags.length), key(parts)), `${money(atRiskOf(flags))} on these lines`, 'warn'));
    } else {
      const parts = [{ name: 'Checked', v: nLines - lv.low, val: String(nLines), cls: 'lvl-ok', title: `${nLines} lines checked` }].concat(lv.low ? [{ name: 'Notes', v: lv.low, val: String(lv.low), cls: 'lvl-low', title: `${lv.low} small note${lv.low > 1 ? 's' : ''} to glance at` }] : []);
      box.append(card('audit', 'ok', 'Flow auditor', 'All clear', '', h('span', { class: 'icviz' }, seg(parts, nLines), key(parts)), ruleLine));
    }

    // 2. spend by type
    const by = new Map();
    inv.forEach((c) => c.lines.forEach((l) => { const k = kindOf(l.category); by.set(k, (by.get(k) || 0) + (Number(l.amount) || 0)); }));
    const rows = Array.from(by, ([k, v]) => ({ k, v })).sort((x, y) => y.v - x.v), sum = rows.reduce((t, r) => t + r.v, 0);
    if (rows.length) {
      const parts = (rows.length <= 4 ? rows : rows.slice(0, 3)).map((r) => ({ name: KIND_LABEL[r.k], v: r.v, val: pct(r.v, sum), cls: `k-${r.k}`, title: money(r.v) }));
      if (rows.length > 4) { const rest = rows.slice(3), v = rest.reduce((t, r) => t + r.v, 0); parts.push({ name: `${rest.length} more`, v, val: pct(v, sum), cls: 'k-rest', title: rest.map((r) => `${KIND_LABEL[r.k]} ${money(r.v)}`).join(', ') }); }
      box.append(card('spend', '', 'Spend', money(sum), '', h('span', { class: 'icviz' }, seg(parts, sum), key(parts)), `${nLines} line${nLines === 1 ? '' : 's'} on ${inv.length} claim${inv.length === 1 ? '' : 's'}`));
    } else box.append(card('spend', 'empty', 'Spend', 'RM 0.00', '', null, 'Nothing claimed in this view'));

    // 3. software & AI tools: each tool, a month at its latest price
    const sr = window.Subs ? window.Subs.find(subsScope()) : null;
    const tools = sr ? sr.tools.filter((t) => !t.personal) : [];
    if (tools.length) {
      const t = sr.totals, notes = sr.insights.length;
      const trows = tools.map((x) => ({ name: x.name, v: x.monthly || x.last })).sort((p, q) => q.v - p.v);
      const tsum = trows.reduce((s2, r) => s2 + r.v, 0);
      const parts = topParts(trows, (r) => r.name, (v) => `RM ${Math.round(v).toLocaleString('en-US')}`, ['#7c3aed', '#a78bfa', '#c4b5fd', '#ddd6fe']);
      parts.forEach((p) => { if (!p.title) p.title = `${p.name} ${money(p.v)} a month`; });
      box.append(card('subs', '', 'Software & AI tools', money(t.monthly || t.claimed), t.monthly ? 'a month' : 'claimed', h('span', { class: 'icviz' }, seg(parts, tsum), key(parts)),
        notes ? `${notes} thing${notes === 1 ? '' : 's'} to look at` : t.monthly ? `About ${money(t.yearly)} a year` : `${t.tools} tool${t.tools === 1 ? '' : 's'}, paid once`, notes ? 'warn' : ''));
    } else box.append(card('subs', 'empty', 'Software & AI tools', 'None yet', '', null, 'No subscriptions in these claims'));

    // 4. carbon: who drove the most
    const C = window.Carbon, cs = C ? C.summarise(inv) : null;
    if (cs && cs.slips) {
      const [num, unit] = C.weight(cs.kg).split(' ');
      const prows = cs.byStaff.map((p) => ({ name: p.name, v: p.kg }));
      const short = (n) => { const w = String(n).trim().split(/\s+/)[0] || ''; return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : n; };      // first names on the card; the full name on hover and in the details
      const parts = topParts(prows, (r) => short(r.name), (v) => C.weight(v), ['#15803d', '#4ade80', '#86efac', '#bbf7d0']);
      parts.forEach((p, i) => { if (!p.title && prows[i]) p.title = prows[i].name; });
      box.append(card('carbon', '', 'Carbon', num, `${unit} CO₂e`, h('span', { class: 'icviz' }, seg(parts, cs.kg), key(parts)), `${cs.slips} fuel slip${cs.slips > 1 ? 's' : ''} · Scope 3 business travel`));
    } else box.append(card('carbon', 'empty', 'Carbon', '–', '', null, 'No fuel claims in this view'));
  }

  /* the side panel with the full details: the auditor, spend, software & AI tools, carbon (tabs at the top) */
  function openInsight(key) {
    if (S.open) closeDrawer();
    const first = !S.ip;
    S.ip = key;
    if (first) S.ipFocus = document.activeElement;
    $('#iscrim').hidden = false; $('#ipanel').hidden = false; document.body.style.overflow = 'hidden';
    document.querySelectorAll('#ipanel .iptabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.ip === key)));
    document.querySelectorAll('#ipanel .ipbody > .card').forEach((c) => c.classList.toggle('on', c.dataset.ip === key));
    $('#ipanel').scrollTop = 0;
    if (first) { const t = $(`#ipanel .iptabs button[data-ip="${key}"]`); if (t) t.focus({ preventScroll: true }); }
  }
  function closeInsight(keepScrollLock) {
    S.ip = null;
    $('#iscrim').hidden = true; $('#ipanel').hidden = true;
    if (!keepScrollLock) { document.body.style.overflow = ''; if (S.ipFocus && document.contains(S.ipFocus)) S.ipFocus.focus({ preventScroll: true }); }
  }

  /* ---------- the company's claim rules ---------- */
  const countRules = () => { $('#rulesCount').textContent = `${$('#rulesText').value.length.toLocaleString('en-US')} / 4,000`; };
  function openRules() {
    const ta = $('#rulesText');
    ta.value = rulesText();
    $('#rulesNote').textContent = S.sample ? 'Sample view: rules typed here are tried on the sample claims only and are not saved.'
      : !Inbox.rulesOk ? "This inbox can't keep rules yet, so they are kept on this computer only."
        : S.rules && S.rules.updatedAt && S.rules.text ? `Saved for everyone who opens this page. Last changed ${fullWhen(S.rules.updatedAt)}.` : 'Saved for everyone who opens this page.';
    countRules();
    $('#rulesDlg').showModal();
    ta.focus();
  }
  async function saveRules() {
    const text = $('#rulesText').value.trim(), btn = $('#rulesSave');
    if (S.sample) { S.sampleRules = text; $('#rulesDlg').close(); toast(text ? 'Trying the rules on the sample claims (not saved)' : 'Rules cleared (sample only)'); render(); schedulePolicy(); return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (Inbox.rulesOk) S.rules = await Inbox.saveRules(text);
      else { S.rules = { text, updatedAt: new Date().toISOString() }; store.set(LOCAL_RULES, S.rules); }
      $('#rulesDlg').close();
      toast(text ? 'Rules saved. Checking the claims against them…' : 'Rules cleared');
      render(); schedulePolicy();
    } catch (e) {
      if (e && e.code === 401) { $('#rulesDlg').close(); Inbox.clearKey(); showLock('The password was changed. Enter the new one.'); }
      else toast("Couldn't save the rules: " + ((e && e.message) || e), true);
    } finally { btn.disabled = false; btn.textContent = 'Save rules'; }
  }

  function paintSpend() {
    const box = $('#spend'), list = all().filter(inView);
    const by = new Map();
    list.forEach((c) => c.lines.forEach((l) => { const k = kindOf(l.category); by.set(k, (by.get(k) || 0) + (Number(l.amount) || 0)); }));
    const rows = Array.from(by).sort((a, b) => b[1] - a[1]);
    const sum = rows.reduce((a, r) => a + r[1], 0);
    const scope = scopeText();
    box.textContent = '';
    const st = h('h2', {}); st.innerHTML = svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'); st.append('Spend by type');
    box.append(h('div', {}, st, h('div', { class: 'sub', text: scope })));
    if (!rows.length) { box.append(h('div', { class: 'none', text: 'Nothing to show yet.' })); return; }
    box.append(h('div', { class: 'bars' }, rows.map(([k, v]) => {
      const fill = h('div', { class: 'fill' }); fill.style.width = (v / rows[0][1] * 100).toFixed(1) + '%';
      return h('div', { class: `bar k-${k}` },
        h('div', { class: 'bt' }, icon(k), h('span', { class: 'bn', text: KIND_LABEL[k] }), h('span', { class: 'ba', text: money(v) }), h('span', { class: 'bp', text: Math.round(v / sum * 100) + '%' })),
        h('div', { class: 'track' }, fill));
    })));
    const nl = list.reduce((n, c) => n + c.lines.length, 0);
    box.append(h('div', { class: 'stot' }, h('span', { text: `${nl} line${nl === 1 ? '' : 's'} on ${list.length} claim${list.length === 1 ? '' : 's'}` }), h('span', {}, 'Total ', h('b', { text: money(sum) }))));
  }

  /* ---------- software and AI tools paid through claims (js/subs.js): every month of history, for the person picked (if any) ---------- */
  const LAYERS = svg('<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>');
  const SUB_ICON = { bad: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>'), save: svg('<path d="M12 3v18M17 7.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2.2 2.6 5 3.3 5 1.4 5 3.4-2.2 3.3-5 3.3-5-1.2-5-3.1"/>'),
    warn: svg('<path d="m4 16 6-6 4 4 6-6"/><path d="M15 8h5v5"/>'), info: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>') };
  const subsScope = () => all().filter((c) => S.f.staff === 'all' || c.claimant === S.f.staff);
  // "Oct 2026", "Sep – Oct 2026", "Dec 2025 – Jan 2026"
  const monthSpan = (ms) => { const a = ms[0], b = ms[ms.length - 1], f = (m) => SHORT[+m.slice(5, 7) - 1];
    return a === b ? `${f(a)} ${a.slice(0, 4)}` : a.slice(0, 4) === b.slice(0, 4) ? `${f(a)} – ${f(b)} ${b.slice(0, 4)}` : `${f(a)} ${a.slice(0, 4)} – ${f(b)} ${b.slice(0, 4)}`; };
  function paintSubs() {
    const box = $('#subs'); if (!box) return;
    box.textContent = '';
    if (!window.Subs) return;
    const r = window.Subs.find(subsScope());
    const title = h('h2', {}); title.innerHTML = LAYERS; title.append('Software & AI tools');
    box.append(h('div', { class: 'chead' }, title, h('div', { class: 'sub', text: `${S.f.staff === 'all' ? 'Everyone' : S.f.staff} · every month on record` })));
    if (!r.tools.length) { box.append(h('div', { class: 'none', text: 'No AI tools or software in these claims yet. They show up here when a claim line is typed as AI tools or software, or names a known tool.' })); return; }
    const t = r.totals;
    box.append(t.monthly
      ? h('div', { class: 'sbig' }, h('b', { text: money(t.monthly) }), h('span', { text: 'a month' }))
      : h('div', { class: 'sbig' }, h('b', { text: money(t.claimed) }), h('span', { text: 'claimed' })));
    box.append(h('div', { class: 'from', text: [t.monthly ? `About ${money(t.yearly)} a year` : 'No repeat payments yet', `${t.tools} tool${t.tools === 1 ? '' : 's'}`, `${t.people} ${t.people === 1 ? 'person' : 'people'}`].join(' · ') }));
    if (r.insights.length) {
      box.append(h('div', { class: 'sub-ins' }, r.insights.slice(0, 3).map((i) => {
        const ic = h('span', { class: `sic s-${i.level}` }); ic.innerHTML = SUB_ICON[i.level];
        return h('button', { class: 'sub-in', type: 'button', title: 'Open the claim', onclick: () => openDrawer(i.open.claimId, i.open.line) }, ic,
          h('span', { class: 'sub-tx' }, h('b', { text: i.title }), h('span', { text: i.text })));
      })));
    }
    const shown = S.subsAll ? r.tools : r.tools.slice(0, 4);
    box.append(h('ul', { class: 'tools' }, shown.map((x) => h('li', {},
      h('button', { type: 'button', class: 'tool' + (x.personal ? ' personal' : ''), title: 'Open the latest claim with it', onclick: () => openDrawer(x.open.claimId, x.open.line) },
        h('span', { class: 'tini', text: x.name.slice(0, 1).toUpperCase() }),
        h('span', { class: 'tnm' }, h('b', { text: x.name }), h('small', { text: `${x.payers.map((p) => p.staff).join(', ')} · ${monthSpan(x.months)}` })),
        h('span', { class: 'tam' }, h('b', { text: x.recurring ? money(x.monthly) : money(x.last) }), h('small', { text: x.personal ? 'personal' : x.recurring ? 'a month' : 'once' })))))));
    if (r.tools.length > 4) box.append(h('button', { class: 'link more', type: 'button', text: S.subsAll ? 'Show fewer' : `Show all ${r.tools.length} tools`, onclick: () => { S.subsAll = !S.subsAll; paintSubs(); } }));
    box.append(h('div', { class: 'how' }, h('b', { text: 'How it is found. ' }), 'Lines typed as AI tools or software, and known tool names. Paid in two or more months counts as monthly, at the latest price.'));
  }

  /* the carbon of business travel, from the litres on the fuel slips of the claims in view (js/carbon.js) */
  const LEAF = svg('<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>');
  const carbonText = (l) => { const x = window.Carbon && window.Carbon.lineCarbon(l); return x ? `${x.estimated ? '≈ ' : ''}${x.litres.toFixed(1)} L · ${Math.round(x.kg)} kg CO₂e` : ''; };
  function paintCarbon() {
    const box = $('#carbon'); if (!box || !window.Carbon) return;
    const C = window.Carbon, s = C.summarise(all().filter(inView));
    const scope = scopeText();
    box.textContent = '';
    const title = h('h2', {}); title.innerHTML = LEAF; title.append('Carbon from business travel');
    box.append(h('div', {}, title, h('div', { class: 'sub', text: scope })));
    if (!s.slips) { box.append(h('div', { class: 'none', text: 'No fuel claims in this view.' })); return; }
    const [num, unit] = C.weight(s.kg).split(' ');
    box.append(h('div', { class: 'co2' }, h('b', { text: num }), h('span', { text: unit + ' CO₂e' })));
    box.append(h('div', { class: 'from', text: `from ${s.litres.toLocaleString('en-US')} litres of fuel on ${s.slips} slip${s.slips > 1 ? 's' : ''}` + (s.estimated ? ` · ${s.estimated} estimated from the amount` : '') }));
    box.append(h('span', { class: 'scope', text: C.SCOPE }));
    // who (or, for one person, which months) drove the most
    const one = S.f.staff !== 'all';
    const parts = (one ? s.byMonth.map((m) => ({ name: m.label, kg: m.kg })) : s.byStaff).slice(0, 6);
    const top = Math.max.apply(null, parts.map((p) => p.kg)) || 1;
    box.append(h('div', { class: 'bars' }, parts.map((p) => {
      const fill = h('div', { class: 'fill' }); fill.style.width = (p.kg / top * 100).toFixed(1) + '%';
      return h('div', { class: 'bar' }, h('div', { class: 'bt' }, h('span', { class: 'bn', text: p.name }), h('span', { class: 'ba', text: C.weight(p.kg) })), h('div', { class: 'track' }, fill));
    })));
    box.append(h('div', { class: 'how' }, h('b', { text: 'How it is worked out. ' }), C.METHOD));
  }

  /* ---------- the Leave tab ---------- */
  const todayIso = () => LK.localIso(new Date());
  const leaveAll = () => (S.sample ? S.sampleLeave : S.realLeave);
  const LEAVE_ICON = { annual: 'annual', sick: 'sick', unpaid: 'unpaid', personal: 'personal', other: 'leaveother' };
  const leaveIcon = (c, cls) => icon(LEAVE_ICON[LK.typeOf(c)], cls);
  const shortType = (t) => LK.TYPE_LABEL[t].replace(/ leave$/, '');

  function lMatches(c, q) {
    if (!q) return true;
    const hay = [c.claimant, LK.TYPE_LABEL[LK.typeOf(c)], c.reason, c.note, c.from, c.monthLabel, STATUS[c.status]].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
  const lInScope = (c) => (S.lf.month === 'all' || c.month === S.lf.month) && (S.lf.staff === 'all' || c.claimant === S.lf.staff) && lMatches(c, S.lf.q.trim());
  const lInView = (c) => lInScope(c) && (S.lf.status === 'all' || c.status === S.lf.status);
  const LSORTERS = {
    claimant: (a, b) => a.claimant.localeCompare(b.claimant),
    type: (a, b) => LK.TYPE_LABEL[LK.typeOf(a)].localeCompare(LK.TYPE_LABEL[LK.typeOf(b)]),
    start: (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
    days: (a, b) => a.days - b.days,
    updatedAt: (a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)),
    status: (a, b) => STATUS_RANK.indexOf(a.status) - STATUS_RANK.indexOf(b.status),
  };

  function paintLeaveFilters() {
    const list = leaveAll();
    const months = Array.from(new Map(list.map((c) => [c.month, c.monthLabel]))).sort((a, b) => b[0].localeCompare(a[0]));
    const staff = Array.from(new Set(list.map((c) => c.claimant))).sort((a, b) => a.localeCompare(b));
    if (S.lf.month !== 'all' && !months.some((m) => m[0] === S.lf.month)) S.lf.month = 'all';
    if (S.lf.staff !== 'all' && !staff.includes(S.lf.staff)) S.lf.staff = 'all';
    setOptions($('#lMonth'), [['all', 'All months']].concat(months), S.lf.month);
    setOptions($('#lStaff'), [['all', 'Everyone']].concat(staff.map((s) => [s, s])), S.lf.staff);
    $('#lClear').hidden = S.lf.month === 'all' && S.lf.staff === 'all' && S.lf.status === 'all' && !S.lf.q.trim();
  }

  function paintLeaveTiles() {
    const box = $('#ltiles'), scoped = leaveAll().filter(lInScope);
    box.textContent = '';
    LEAVE_STATUS_KEYS.forEach((k) => {
      const mine = scoped.filter((c) => c.status === k);
      const days = mine.reduce((a, c) => a + (Number(c.days) || 0), 0);
      box.append(h('button', {
        class: `tile s-${k}`, type: 'button', 'aria-pressed': S.lf.status === k ? 'true' : 'false', title: S.lf.status === k ? 'Click again to show all' : `Show only: ${STATUS[k]}`,
        onclick: () => { S.lf.status = S.lf.status === k ? 'all' : k; render(); },
      }, h('span', { class: 'tl' }, h('span', { class: 'dot' }), STATUS[k]), h('span', { class: 'tn', text: String(mine.length) }), h('span', { class: 'ta', text: mine.length ? LK.dayWord(days) : '–' })));
    });
    const now = LK.awaySplit(leaveAll(), todayIso(), 30).now;
    box.append(h('div', { class: 'tile info s-away' }, h('span', { class: 'tl' }, h('span', { class: 'dot' }), 'Away today'), h('span', { class: 'tn', text: String(now.length) }),
      h('span', { class: 'ta', title: now.map((c) => c.claimant).join(', '), text: now.length ? now.map((c) => c.claimant).join(', ') : 'Nobody' })));
  }

  function paintLeaveTable() {
    const rows = $('#lrows'), empty = $('#lempty'), scroll = $('#ltbl').closest('.scroll'), today = todayIso();
    const list = leaveAll().filter(lInView).sort((a, b) => S.lsort.dir * (LSORTERS[S.lsort.key](a, b) || String(a.id).localeCompare(b.id)));
    document.querySelectorAll('#ltbl .sort').forEach((b) => { if (b.dataset.lsort === S.lsort.key) b.dataset.dir = String(S.lsort.dir); else delete b.dataset.dir; });
    rows.textContent = '';
    list.forEach((c) => {
      const open = () => openDrawer(c.id);
      const w = LK.when(c, today, 30), wt = LK.whenText(c, today);
      rows.append(h('tr', { tabindex: '0', 'data-id': c.id, class: S.fresh.has(c.id) ? 'fresh' : '', onclick: open, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
        h('td', {}, h('div', { class: 'who' }, c.claimant, c.sample ? h('span', { class: 'tag', text: 'Sample' }) : null),
          h('div', { class: 'sub show-sm', text: `${shortType(LK.typeOf(c))} · ${LK.rangeText(c.start, c.end)}${wt ? ' · ' + wt : ''}` })),
        h('td', { class: 'hide-sm' }, h('div', { class: 'tcell' }, leaveIcon(c), h('span', { text: shortType(LK.typeOf(c)) }), LK.hasMc(c) ? h('span', { class: 'tag mc', title: 'Medical certificate attached', text: 'MC' }) : null)),
        h('td', { class: 'hide-sm' }, h('div', { text: LK.rangeText(c.start, c.end) }), wt ? h('div', { class: 'sub ' + (w === 'away' ? 'now' : 'soon'), text: wt }) : null),
        h('td', { class: 'num total' }, String(c.days), h('span', { class: 'unit', text: c.days === 1 ? ' day' : ' days' })),       // the unit shows on a phone, where the column heading is gone
        h('td', { class: 'hide-sm muted', title: fullWhen(c.updatedAt), text: ago(c.updatedAt) }),
        h('td', {}, h('span', { class: `pill s-${c.status}`, text: STATUS[c.status] }))));
    });

    const tf = $('#ltfoot');
    tf.textContent = '';
    if (list.length) tf.append(h('span', {}, `${list.length} application${list.length > 1 ? 's' : ''}`), h('span', {}, 'Total ', h('b', { text: LK.dayWord(list.reduce((a, c) => a + (Number(c.days) || 0), 0)) })));

    scroll.hidden = !list.length;
    empty.hidden = !!list.length;
    empty.textContent = '';
    if (list.length) return;
    const btn = (text, fn, cls) => h('button', { class: cls || 'ghost', type: 'button', text, onclick: fn });
    if (S.firstLoad) empty.append(h('p', { text: 'Loading leave…' }));
    else if (!S.sample && !S.connected) {
      empty.append(h('h3', { text: "Can't find the inbox" }),
        h('p', { text: 'This page is not connected to where claims and leave are sent yet.' }),
        h('div', { class: 'row' }, btn('Try again', () => { S.address = ''; load(); }, 'primary'), btn('Show sample leave', showSample)));
    } else if (!S.sample && !Inbox.leaveOk) {
      empty.append(h('h3', { text: "This inbox can't track leave yet" }),
        h('p', { text: 'It needs a small update first. Ask whoever set it up to put the new version in (README, "Put it online").' }));
    } else if (!leaveAll().length) {
      empty.append(h('h3', { text: 'No leave applications yet' }), h('p', { text: 'When someone presses Save my leave form in the Claim Builder, it shows up here within a few seconds.' }),
        S.sample ? null : btn('Show sample leave', showSample));
    } else {
      empty.append(h('h3', { text: 'Nothing matches' }), h('p', { text: 'Try a different month, person or search word.' }),
        btn('Clear filters', () => { S.lf = { month: 'all', staff: 'all', status: 'all', q: '' }; $('#lSearch').value = ''; render(); }));
    }
  }

  /* the card beside the table: who is away now, who is coming up, days taken this year. It is about the team, so the filters do not change it. */
  function paintAway() {
    const box = $('#away'), list = leaveAll(), today = todayIso(), year = today.slice(0, 4);
    const { now, soon } = LK.awaySplit(list, today, 30);
    const row = (c) => h('button', { class: 'awrow', type: 'button', onclick: () => openDrawer(c.id) }, leaveIcon(c),
      h('div', { style: 'min-width:0' }, h('div', { class: 'nm', text: c.claimant }), h('div', { class: 'dt', text: `${shortType(LK.typeOf(c))} · ${LK.rangeText(c.start, c.end)}` })),
      h('div', { class: 'dd', text: LK.dayWord(c.days) }));
    const by = LK.daysByPerson(list, year), max = by.length ? by[0].total : 0;
    box.textContent = '';
    box.append(
      h('div', {}, h('h2', { text: 'Who is away' }), h('div', { class: 'sub', text: S.sample ? 'Sample leave' : 'The whole team' })),
      h('div', {}, h('h3', { text: 'Away today' }), now.length ? h('div', { class: 'awlist' }, now.map(row)) : h('div', { class: 'none', text: 'Nobody is away today.' })),
      h('div', {}, h('h3', { text: 'Coming up (next 30 days)' }),
        soon.length ? h('div', { class: 'awlist' }, soon.slice(0, 6).map(row), soon.length > 6 ? h('div', { class: 'more', text: `+ ${soon.length - 6} more` }) : null) : h('div', { class: 'none', text: 'Nothing booked.' })),
      h('div', {}, h('h3', { text: `Days taken in ${year}` }),
        by.length ? h('div', { class: 'bars' }, by.map((e) => {
          const fill = h('div', { class: 'fill' }); fill.style.width = (max ? e.total / max * 100 : 0).toFixed(1) + '%';
          const parts = LK.TYPES.filter((t) => e.byType[t]).map((t) => `${shortType(t)} ${Number.isInteger(e.byType[t]) ? e.byType[t] : e.byType[t].toFixed(1)}`).join(' · ');
          return h('div', { class: 'bar' }, h('div', { class: 'bt' }, h('span', { class: 'bn', text: e.name }), h('span', { class: 'ba', text: LK.dayWord(e.total) })), h('div', { class: 'track' }, fill), h('div', { class: 'bsub', text: parts }));
        })) : h('div', { class: 'none', text: 'No leave this year yet.' })));
  }

  function paintLeave() { paintLeaveFilters(); paintLeaveTiles(); paintLeaveTable(); paintAway(); }

  /* ---------- one claim, in the side panel ---------- */
  function openDrawer(id, line) {
    if (S.ip) closeInsight(true);
    if (!S.open) S.lastFocus = document.activeElement;
    S.open = id;
    $('#scrim').hidden = false; $('#drawer').hidden = false; document.body.style.overflow = 'hidden';
    paintDrawer(false);
    $('#drawer').scrollTop = 0;
    const x = $('#drawer .x'); if (x) x.focus({ preventScroll: true });
    const ln = line && $(`#drawer .ln[data-line="${Number(line)}"]`);         // from the auditor: show that line
    if (ln) { ln.scrollIntoView({ block: 'center' }); ln.classList.add('pulse'); setTimeout(() => ln.classList.remove('pulse'), 2200); }
  }

  function closeDrawer() {
    S.open = null;
    $('#scrim').hidden = true; $('#drawer').hidden = true; document.body.style.overflow = '';
    if (S.lastFocus && document.contains(S.lastFocus)) S.lastFocus.focus();
  }

  function paintDrawer(keepScroll) {
    const c = find(S.open), d = $('#drawer');
    if (!c) { closeDrawer(); return; }
    const isLeave = c.kind === 'leave';
    const keys = isLeave ? LEAVE_STATUS_KEYS : STATUS_KEYS;
    const top = d.scrollTop;
    S.drawerSig = drawerSigOf(c);
    if (S.draft.id !== c.id) S.draft = { id: c.id, text: null };
    const noteBox = h('textarea', { rows: '3', placeholder: 'Add a note for yourself or the claimant (optional)', maxlength: '600' });
    noteBox.value = S.draft.text != null ? S.draft.text : (c.note || '');      // what was typed but not saved yet stays
    const saveNote = h('button', { class: 'primary sm', type: 'button', text: 'Save note', disabled: noteBox.value.trim() === (c.note || ''), onclick: () => saveNoteNow(c.id, noteBox.value, saveNote) });
    noteBox.addEventListener('input', () => { S.draft.text = noteBox.value; saveNote.disabled = noteBox.value.trim() === (c.note || ''); });

    const receiptsFor = (l) => (c.files || []).filter((f) => (f.kind === 'receipt' && f.line === l.no) || ((kindOf(l.category) === 'toll' || kindOf(l.category) === 'parking') && f.kind === 'tollcheck'));
    const fileKind = isLeave
      ? { 'form-pdf': 'Leave form (PDF)', 'form-xlsx': 'Leave form (Excel)', mc: 'Medical certificate (MC)', other: 'File' }
      : { 'form-pdf': 'Claim form (PDF)', 'form-xlsx': 'Claim form (Excel)', tng: "Touch 'n Go statement", tollcheck: 'Toll check list', receipt: 'Receipt', other: 'File' };
    const sampleTag = c.sample ? h('span', { class: 'tag', text: 'Sample' }) : null;
    const sentWhen = `sent ${fullWhen(c.updatedAt)}${c.version > 1 ? ` · version ${c.version}` : ''}`;

    const head = isLeave
      ? h('div', { class: 't' }, h('h2', {}, c.claimant, sampleTag), h('div', { class: 's', text: `${LK.TYPE_LABEL[LK.typeOf(c)]} · ${sentWhen}` }))
      : h('div', { class: 't' }, h('h2', {}, c.claimant, sampleTag), h('div', { class: 's', text: `${c.monthLabel} · ${sentWhen}` }));
    const big = isLeave
      ? h('div', { class: 'big' }, h('span', { class: 'n', text: LK.dayWord(c.days) }), h('span', { class: 'l', text: LK.rangeText(c.start, c.end) }))
      : h('div', { class: 'big' }, h('span', { class: 'n', text: money(c.total) }), h('span', { class: 'l', text: `${c.lines.length} line${c.lines.length > 1 ? 's' : ''}` }));

    // the two things the accountant wants most, one click away; the files come through the inbox, so no Google account or Drive access is needed
    const quick = (c.files || []).length ? h('div', { class: 'quick' },
      (c.files || []).some((f) => f.kind === 'form-pdf') ? h('button', { class: 'primary', type: 'button', text: isLeave ? 'Open leave form' : 'Open claim form', onclick: () => viewFile(c, c.files.find((f) => f.kind === 'form-pdf')) }) : null,
      h('button', { class: 'ghost', type: 'button', id: 'btnAllFiles', text: 'Download everything (.zip)', onclick: (e) => downloadAll(c, e.currentTarget) })) : null;

    const flags = isLeave ? [] : flagsFor(c.id);
    const audSec = flags.length ? h('div', { class: 'sec audsec' }, h('h3', {}, 'Flow auditor', h('span', { class: 'cnt', text: `${flags.length} to look at` })),
      flags.map((f) => h('div', { class: `aflag lvl-${f.level}` }, h('i', { class: 'ldot' }),
        h('div', { style: 'min-width:0' }, h('b', { text: f.title }), h('div', { class: 'aud-why', text: f.reason }),
          h('div', { class: 'aud-meta' }, h('span', { text: [LEVEL_WORD[f.level], f.wholeClaim ? 'whole claim' : `line ${f.line}`, f.rule ? `rule: ${f.rule}` : ''].filter(Boolean).join(' · ') }),
            f.related.filter((r) => r.claimId !== c.id).map((r) => { const o = find(r.claimId); return o ? h('button', { class: 'link', type: 'button', text: `Open ${o.claimant}'s ${o.monthLabel} claim`, onclick: () => openDrawer(r.claimId, r.line) }) : null; })))))) : null;

    const statusSec = h('div', { class: 'sec' }, h('h3', { text: 'Status' }),
      h('div', { class: 'seg' + (isLeave ? ' three' : ''), role: 'group', 'aria-label': 'Status' }, keys.map((k) => h('button', { class: `s-${k}`, type: 'button', 'aria-pressed': c.status === k ? 'true' : 'false', onclick: () => changeStatus(c.id, k) }, h('span', { class: 'dot' }), STATUS[k]))),
      h('div', { class: 'note-row' }, noteBox, h('div', { class: 'acts' }, saveNote)));

    const middle = isLeave
      ? h('div', { class: 'sec' }, h('h3', { text: 'Details' }),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Type' }), h('dd', { text: LK.TYPE_LABEL[LK.typeOf(c)] }),
          h('dt', { text: 'From' }), h('dd', { text: niceDay(c.start) }),
          h('dt', { text: 'To' }), h('dd', { text: niceDay(c.end) }),
          h('dt', { text: 'Days' }), h('dd', { text: LK.dayWord(c.days) + (c.start !== c.end ? ' (weekdays, without public holidays)' : '') }),
          h('dt', { text: 'Reason' }), h('dd', { text: c.reason || '–' }),
          h('dt', { text: 'Signed on' }), h('dd', { text: niceDay(c.signedOn) || '–' }),
          LK.typeOf(c) === 'sick' ? h('dt', { text: 'MC' }) : null, LK.typeOf(c) === 'sick' ? h('dd', { text: LK.hasMc(c) ? 'Attached' : c.sample ? 'Attached (sample)' : 'Not attached' }) : null))
      : h('div', { class: 'sec' }, h('h3', { text: 'Lines' }),
        c.lines.map((l) => {
          const rc = receiptsFor(l);
          const lf = flags.filter((f) => f.line === l.no && !f.wholeClaim);
          return h('div', { class: 'ln' + (lf.length ? ` flagged lvl-${lf[0].level}` : ''), 'data-line': String(l.no) }, icon(kindOf(l.category)),
            h('div', { style: 'min-width:0' }, h('div', { class: 'nm', text: l.name || l.category }),
              h('div', { class: 'dt', text: [l.category, niceDate(l.date), l.receiptNo ? 'No. ' + l.receiptNo : '', carbonText(l)].filter(Boolean).join(' · ') }),
              lf.length ? h('div', { class: 'lnflag', text: lf.map((f) => f.title).join(' · ') }) : null),
            h('div', {}, h('div', { class: 'am', text: money(l.amount) }),
              rc.length ? h('div', { class: 'vw' }, rc.map((f, i) => h('button', { class: 'link', type: 'button', text: f.kind === 'tollcheck' ? 'Toll list' : rc.length > 1 ? `Receipt ${i + 1}` : 'Receipt', onclick: () => viewFile(c, f) }))) : null));
        }),
        h('div', { class: 'ltot' }, h('span', { text: 'Total' }), h('span', { text: money(c.total) })));

    const filesSec = h('div', { class: 'sec' }, h('h3', { text: 'Files' }),
      c.sample ? h('div', { class: 'sample-note', text: isLeave ? 'Sample leave applications have no files. A real one lists its leave form and any medical certificate here.' : 'Sample claims have no files. A real claim lists its claim form, statement and receipts here.' })
        : !(c.files || []).length ? h('div', { class: 'sample-note', text: isLeave ? 'No files came with this application.' : 'No files came with this claim.' })
          : h('div', {}, (c.files || []).map((f) => h('div', { class: 'fl' },
            h('div', { style: 'min-width:0' }, h('div', { class: 'fn', title: f.name, text: f.name }), h('div', { class: 'fs', text: `${fileKind[f.kind] || 'File'} · ${sizeText(f.size)}` })),
            h('div', { class: 'fa' }, h('button', { class: 'link', type: 'button', text: 'View', onclick: () => viewFile(c, f) }), h('button', { class: 'link', type: 'button', text: 'Download', onclick: () => downloadFile(c, f) })))),
            h('p', { class: 'hint', text: 'Files open straight from here. No Google account is needed.' })));

    d.textContent = '';
    d.append(
      h('div', { class: 'dhead' }, head, h('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×', onclick: closeDrawer })),
      h('div', { class: 'dbody' }, big, quick, audSec, statusSec, middle, filesSec,
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
      if (e && e.code === 401) { Inbox.clearKey(); showLock('The password was changed. Enter the new one.'); return; }
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
      const base = safe(c.kind === 'leave' ? `Leave - ${c.claimant} - ${LK.rangeText(c.start, c.end)}` : `Claim - ${c.monthLabel} - ${c.claimant}`);
      const zip = new JSZip(), root = zip.folder(base);
      for (let i = 0; i < files.length; i++) {
        btn.textContent = `Getting files… ${i + 1} of ${files.length}`;
        root.file(files[i].name, await fetchBlob(c, files[i]));
      }
      btn.textContent = 'Zipping…';
      saveAs(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), base + '.zip');
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

  /* ---------- export for AutoCount (js/autocount.js): the claims on screen as journal entries, so the accountant imports instead of typing.
     Account codes and column names are the accountant's own: typed once here and remembered on this PC. ---------- */
  const AC_KEY = 'wfc-autocount';
  const acLoad = () => { try { return JSON.parse(localStorage.getItem(AC_KEY) || '{}') || {}; } catch (e) { return {}; } };
  const acStore = (v) => { try { localStorage.setItem(AC_KEY, JSON.stringify(v)); } catch (e) { /* private window */ } };
  let acCfg = null;
  const acClaims = () => {
    const w = $('#acWhich').value;
    return all().filter(inScope).filter((c) => (w === 'all' ? true : c.status === 'checked' || (w === 'newchecked' && c.status === 'new')))
      .sort((a, b) => a.month.localeCompare(b.month) || a.claimant.localeCompare(b.claimant));
  };
  const acField = (label, value, attrs) => h('label', { class: 'ac-f' }, h('span', { text: label }), h('input', Object.assign({ type: 'text', value }, attrs)));
  function openAutocount() {
    acCfg = window.AutoCount.settings(acLoad());
    $('#acJType').value = acCfg.journalType; $('#acPrefix').value = acCfg.prefix; $('#acDate').value = acCfg.dateMode; $('#acGroup').value = acCfg.grouping;
    $('#acHeaders').textContent = '';
    window.AutoCount.COLUMNS.forEach((k) => $('#acHeaders').append(acField(k, acCfg.headers[k], { 'data-head': k, maxlength: '40' })));
    $('#acWhich').value = all().filter(inScope).some((c) => c.status === 'checked') ? 'checked' : 'newchecked';
    paintAccounts(); paintAutocount();
    $('#acDlg').showModal();
  }
  // a box for the account of every type in the chosen claims, and one for the account the money is owed from
  function paintAccounts() {
    const used = new Set();
    acClaims().forEach((c) => c.lines.forEach((l) => used.add(window.AutoCount.CATEGORIES.includes(l.category) ? l.category : 'Other')));
    const box = $('#acAccounts');
    box.textContent = '';
    window.AutoCount.CATEGORIES.filter((k) => used.has(k)).forEach((k) => box.append(acField(k + ' account', acCfg.accounts[k], { 'data-cat': k, maxlength: '12' })));
    if (used.size) box.append(acField('Claims payable account', acCfg.payable, { 'data-payable': '1', maxlength: '12' }));
  }
  function readAutocount() {
    acCfg.journalType = $('#acJType').value; acCfg.prefix = $('#acPrefix').value; acCfg.dateMode = $('#acDate').value; acCfg.grouping = $('#acGroup').value;
    document.querySelectorAll('#acAccounts [data-cat]').forEach((i) => { acCfg.accounts[i.dataset.cat] = i.value; });
    const p = document.querySelector('#acAccounts [data-payable]'); if (p) acCfg.payable = p.value;
    document.querySelectorAll('#acHeaders [data-head]').forEach((i) => { acCfg.headers[i.dataset.head] = i.value; });
    acStore(acCfg);
  }
  function paintAutocount() {
    const out = window.AutoCount.build(acClaims(), acCfg), n = out.docs.length;
    $('#acSum').textContent = n ? `${n} claim${n > 1 ? 's' : ''}, ${out.lines} receipt${out.lines > 1 ? 's' : ''}, ${money(out.total)}` : 'No claims match. Mark claims as Checked, or choose another list above.';
    document.querySelectorAll('#acAccounts input').forEach((i) => i.classList.toggle('ac-tbc', !i.value.trim() || /^TBC-/i.test(i.value.trim())));
    const warn = $('#acWarn');
    warn.textContent = '';
    if (S.sample) warn.append(h('p', { class: 'ac-note', text: 'These are sample claims with made-up figures. Do not import them into your books.' }));
    if (out.placeholders.length) warn.append(h('p', { class: 'ac-note', text: 'The yellow codes starting "TBC-" are placeholders. Type your own AutoCount account codes before importing; they are remembered on this PC.' }));
    out.problems.forEach((t) => warn.append(h('p', { class: 'ac-note', text: t })));
    $('#acGo').disabled = !n;
  }
  async function saveAutocount() {
    readAutocount();
    const out = window.AutoCount.build(acClaims(), acCfg);
    if (!out.docs.length) return;
    try {
      const months = Array.from(new Set(out.docs.map((d) => d.month)));
      saveAs(await window.AutoCount.xlsxBlob(out), `${S.sample ? 'SAMPLE - ' : ''}AutoCount claims - ${months.length === 1 ? months[0] : months.length + ' months'}.xlsx`);
      $('#acDlg').close();
      toast(`Saved ${out.docs.length} journal ${out.docs.length > 1 ? 'entries' : 'entry'}. In AutoCount: Journal Entry, then Import From Excel.`);
    } catch (e) { console.error(e); toast("The Excel file couldn't be made: " + ((e && e.message) || e), true); }
  }
  function wireAutocount() {
    $('#acCancel').addEventListener('click', () => $('#acDlg').close());
    $('#acForm').addEventListener('submit', (e) => { e.preventDefault(); saveAutocount(); });
    $('#acWhich').addEventListener('change', () => { paintAccounts(); paintAutocount(); });
    $('#acForm').addEventListener('input', (e) => { if (e.target.id !== 'acWhich') { readAutocount(); paintAutocount(); } });
  }

  function exportCsv(kind) {
    if (kind === 'autocount') { openAutocount(); return; }
    if (kind === 'leave') {
      const ll = leaveAll().filter(lInView).sort((a, b) => a.start.localeCompare(b.start) || a.claimant.localeCompare(b.claimant));
      if (!ll.length) { toast('Nothing to export for this view.', true); return; }
      const t = new Date();
      saveAs(new Blob([csv(LK.csvRows(ll, STATUS))], { type: 'text/csv;charset=utf-8' }), `WFC leave - ${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}.csv`);
      return;
    }
    const list = all().filter(inView).sort((a, b) => a.month.localeCompare(b.month) || a.claimant.localeCompare(b.claimant));
    if (!list.length) { toast('Nothing to export for this view.', true); return; }
    let rows;
    if (kind === 'audit') {
      const a = auditNow(), ids = new Set(list.map((c) => c.id));
      const flags = a.flags.filter((f) => ids.has(f.claimId));
      const d1 = new Date();
      saveAs(new Blob([csv(AUD.csvRows({ flags, lines: list.reduce((n, c) => n + c.lines.length, 0), claims: list.length, atRisk: atRiskOf(flags) }))], { type: 'text/csv;charset=utf-8' }),
        `WFC audit report - ${d1.getFullYear()}-${pad(d1.getMonth() + 1)}-${pad(d1.getDate())}.csv`);
      return;
    }
    if (kind === 'subs') {
      const d2 = new Date();
      saveAs(new Blob([csv(window.Subs.csvRows(window.Subs.find(subsScope())))], { type: 'text/csv;charset=utf-8' }), `WFC software and AI tools - ${d2.getFullYear()}-${pad(d2.getMonth() + 1)}-${pad(d2.getDate())}.csv`);
      return;
    }
    if (kind === 'carbon') {
      const d0 = new Date();
      saveAs(new Blob([csv(window.Carbon.csvRows(list))], { type: 'text/csv;charset=utf-8' }), `WFC carbon from business travel - ${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}.csv`);
      return;
    }
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

  /* ---------- the filters stay at hand: once the page scrolls past them they stick under the header, compact (no labels; on phones only
     month and staff). The space they leave is kept with a bottom margin, so the page does not jump when they stick. ---------- */
  let stickyBusy = false;
  function stickyUpdate(reset) {
    stickyBusy = false;
    const top = $('.top'), hdr = top && getComputedStyle(top).position === 'sticky' ? top.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--hdr', hdr + 'px');
    document.querySelectorAll('.view > .toolbar').forEach((bar) => {
      if (reset) { bar.classList.remove('stuck'); bar.style.marginBottom = ''; }
      if (!bar.offsetParent) return;                                       // the other tab
      const prev = bar.previousElementSibling, gap = parseFloat(getComputedStyle(bar.parentElement).rowGap) || 0;
      const stuck = !!prev && prev.getBoundingClientRect().bottom + gap < hdr - 1;          // where the bar would be, without sticking
      if (stuck === bar.classList.contains('stuck')) return;
      if (stuck) { const h0 = bar.offsetHeight; bar.classList.add('stuck'); bar.style.marginBottom = (h0 - bar.offsetHeight) + 'px'; }
      else { bar.classList.remove('stuck'); bar.style.marginBottom = ''; }
    });
  }
  function stickyCheck(reset) {
    if (reset) { stickyUpdate(true); return; }
    if (!stickyBusy) { stickyBusy = true; requestAnimationFrame(() => stickyUpdate(false)); }
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
    if (window.FlowSelect) ['#fMonth', '#fStaff', '#lMonth', '#lStaff'].forEach((s) => window.FlowSelect.enhance($(s)));
    $('#fMonth').addEventListener('change', (e) => { S.f.month = e.target.value; render(); });
    $('#fStaff').addEventListener('change', (e) => { S.f.staff = e.target.value; render(); });
    $('#fSearch').addEventListener('input', (e) => { S.f.q = e.target.value; render(); });
    document.querySelectorAll('#tbl .sort').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.sort;
      S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: ['claimant', 'month', 'status'].includes(k) ? 1 : -1 };
      render();
    }));
    // the Leave tab
    $('#lMonth').addEventListener('change', (e) => { S.lf.month = e.target.value; render(); });
    $('#lStaff').addEventListener('change', (e) => { S.lf.staff = e.target.value; render(); });
    $('#lSearch').addEventListener('input', (e) => { S.lf.q = e.target.value; render(); });
    document.querySelectorAll('#ltbl .sort').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.lsort;
      S.lsort = S.lsort.key === k ? { key: k, dir: -S.lsort.dir } : { key: k, dir: ['claimant', 'type', 'status'].includes(k) ? 1 : -1 };
      render();
    }));
    $('#btnAsk').addEventListener('click', () => { if (window.AskUI) window.AskUI.open(); });
    wireAutocount();
    $('#cleanBtn').addEventListener('click', openClean);
    $('#cleanCancel').addEventListener('click', () => $('#cleanDlg').close());
    $('#cleanForm').addEventListener('submit', (e) => { e.preventDefault(); markClean(); });
    addEventListener('scroll', () => stickyCheck(), { passive: true });
    addEventListener('resize', () => stickyCheck(true));
    $('#fClear').addEventListener('click', () => { S.f = { month: 'all', staff: 'all', status: 'all', q: '' }; $('#fSearch').value = ''; render(); stickyCheck(true); });
    $('#lClear').addEventListener('click', () => { S.lf = { month: 'all', staff: 'all', status: 'all', q: '' }; $('#lSearch').value = ''; render(); stickyCheck(true); });
    $('#rulesText').addEventListener('input', countRules);
    $('#rulesExample').addEventListener('click', () => { const ta = $('#rulesText'); ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + AUD.EXAMPLE_RULES; countRules(); ta.focus(); });
    $('#rulesCancel').addEventListener('click', () => $('#rulesDlg').close());
    $('#rulesForm').addEventListener('submit', (e) => { e.preventDefault(); saveRules(); });
    $('#tabClaims').addEventListener('click', () => setView('claims'));
    $('#tabLeave').addEventListener('click', () => setView('leave'));
    window.addEventListener('hashchange', () => setView(location.hash === '#leave' ? 'leave' : 'claims', true));
    S.view = location.hash === '#leave' ? 'leave' : 'claims';
    $('#viewClaims').hidden = S.view !== 'claims'; $('#viewLeave').hidden = S.view !== 'leave';
    document.querySelectorAll('#exportMenu [data-view]').forEach((b) => { b.hidden = b.dataset.view !== S.view; });
    $('#btnRefresh').addEventListener('click', () => load());
    $('#lockForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = $('#lockPw').value;
      if (!pw) return;
      Inbox.setKey(pw); S.askedPw = true;
      const btn = $('#lockBtn'); btn.disabled = true; btn.textContent = 'Checking…';
      await load();
      btn.disabled = false; btn.textContent = 'Open';
    });
    $('#btnLock').addEventListener('click', () => { Inbox.clearKey(); S.real = []; S.realLeave = []; S.prev = null; S.sample = false; render(); showLock(''); });
    croppedLogo().then((u) => { $('#lockLogo').src = u; }).catch(() => $('#lockLogo').remove());
    $('#scrim').addEventListener('click', closeDrawer);
    $('#iscrim').addEventListener('click', () => closeInsight());
    $('#ipClose').addEventListener('click', () => closeInsight());
    document.querySelectorAll('#ipanel .iptabs button').forEach((b) => b.addEventListener('click', () => openInsight(b.dataset.ip)));
    $('#vClose').addEventListener('click', () => $('#viewer').close());
    $('#viewer').addEventListener('click', (e) => { if (e.target === $('#viewer')) $('#viewer').close(); });
    const menu = $('#exportMenu'), mb = $('#btnExport');
    const setMenu = (on) => { menu.hidden = !on; mb.setAttribute('aria-expanded', String(on)); };
    mb.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
    menu.addEventListener('click', (e) => { const b = e.target.closest('[data-export]'); if (b) { setMenu(false); exportCsv(b.dataset.export); } });
    document.addEventListener('click', () => setMenu(false));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!menu.hidden) setMenu(false); else if (!$('#viewer').open && S.open) closeDrawer(); else if (S.ip && !$('#rulesDlg').open) closeInsight();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.connected && !S.sample) load(true); });
    setInterval(() => { if (!document.hidden && S.connected && !S.sample && !S.saving) load(true); }, 20000);
    render();
    stickyCheck(true);
    load();
  }

  window.__dash = { S, load, render, showSample, openDrawer, closeDrawer, csv, setView, audit: auditNow };      // handy for testing
  init();
})();
