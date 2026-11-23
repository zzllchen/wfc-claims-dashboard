/* WFC Claims inbox - the Google version (Google Apps Script web app).

   What it does: the Claim Builder posts a saved claim here, the dashboard reads it. Same actions and answers as
   server/server.js (the local version), so the two pages work with either.

   Where things are kept (all in the Google account that deploys this script, created on first use):
     - a Google Sheet "WFC Claims"          one row per claim on its "Claims" sheet, one per leave application on its "Leave" sheet (handy for Agnes to open too)
     - a Drive folder "WFC Claims files"    one sub-folder per claim, holding the claim form, receipts, TNG statement
   Nothing else is stored, and nothing leaves that Google account.

   No login yet (on purpose, for the demo): anyone who has the web app address can read and add claims.
   The setup steps are in README.md, "Put it online (Google)". */

var VERSION = 6;
var MAX_RULES = 4000;                                 // the company's claim rules, in plain words (the dashboard's auditor checks claims against them)
var MAX_LINES = 60;                                   // the claim form has 35 rows
var MAX_FILE = 8 * 1024 * 1024;                      // bytes per file (Apps Script copes with about this much per request)
// a claim goes New > Checked > Paid; a leave application goes New > Recorded (the office filled in the balance). Either can be "Has a question".
var STATUS_BY_KIND = { claim: ['new', 'checked', 'paid', 'question'], leave: ['new', 'recorded', 'question'] };
var STATUS_WORD = { 'new': 'New', 'checked': 'Checked', 'paid': 'Paid', 'recorded': 'Recorded', 'question': 'Has a question' };
var LEAVE_TYPES = { annual: 'Annual leave', sick: 'Sick leave', unpaid: 'Unpaid leave', personal: 'Personal leave', other: 'Other leave' };
var KINDS = ['form-pdf', 'form-xlsx', 'tng', 'tollcheck', 'receipt', 'mc', 'other'];
var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
var MIME = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', zip: 'application/zip' };
var COLS = ['id', 'claimant', 'month', 'total', 'status', 'updated', 'record'];
var LEAVE_COLS = ['id', 'employee', 'start month', 'days', 'status', 'updated', 'record'];      // the "Leave" sheet: same layout, the record column last

/* ---------- web app entry points ---------- */
function doGet(e) {
  return out_(route_('GET', (e && e.parameter) || {}, null));
}

function doPost(e) {
  var body = null;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'Bad request.', code: 400 }); }
  return out_(route_('POST', (e && e.parameter) || {}, body));
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function route_(method, query, body) {
  var lock = null;
  try {
    var params = method === 'POST' ? (body || {}) : query;
    var action = params.action;
    var reads = { ping: 1, list: 1, file: 1 };                 // a read may come by GET or POST; a change only by POST
    var known = { ping: ping_, list: list_, file: file_, submit: submit_, upload: upload_, finish: finish_, status: status_, 'delete': delete_, claude: claude_, ask: ask_, rules: rules_, scan: scan_, seen: seen_ };
    if (!known.hasOwnProperty(action) || (method === 'GET' && !reads[action])) throw fail_('Unknown action.');
    needKey_(action, params);
    // changes to a claim's record are one at a time; uploads of different files can run side by side
    if (action === 'submit' || action === 'finish' || action === 'status' || action === 'delete') { lock = LockService.getScriptLock(); lock.waitLock(30000); }
    return known[action](params);
  } catch (e) {
    if (!e.userMessage) console.error(e && e.stack || e);
    return { ok: false, error: e.userMessage || 'Something went wrong on the server.', code: e.code || 500 };
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e2) { /* already released */ } }
  }
}

function fail_(message, code) { var e = new Error(message); e.userMessage = message; e.code = code || 400; return e; }

/* The password (script property DASH_KEY, set in Project settings > Script properties; never in this code). With none set the inbox is open.
   The Claim Builder's own calls (ping, submit, upload, finish) never need it; reading claims, opening files, changing a status and deleting do. */
var OPEN_ACTIONS = { ping: 1, submit: 1, upload: 1, finish: 1, claude: 1, scan: 1, seen: 1 };
function passwordSet_() { return !!PropertiesService.getScriptProperties().getProperty('DASH_KEY'); }
function needKey_(action, params) {
  if (OPEN_ACTIONS[action]) return;
  var key = PropertiesService.getScriptProperties().getProperty('DASH_KEY');
  if (!key) return;
  if (String(params.key || '') !== key) { Utilities.sleep(1500); throw fail_('Password needed.', 401); }      // the pause makes guessing slow
}

/* ---------- small helpers (same as server.js) ---------- */
function round2_(n) { return Math.round((n + 1e-9) * 100) / 100; }
function str_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, max); }
function slug_(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'staff'; }
function monthLabel_(m) { return MONTHS[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4); }
function safeName_(s) { return str_(s, 120).replace(/[\\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '') || 'file'; }
function emailOf_(v) { return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(v || '').replace(/^\s+|\s+$/g, '')) ? String(v).replace(/^\s+|\s+$/g, '').slice(0, 120) : ''; }
function okId_(id) { return /^(\d{4}-\d{2}|leave-\d{4}-\d{2}-\d{2})_[a-z0-9-]{1,40}$/.test(String(id || '')); }
function isLeaveId_(id) { return String(id || '').indexOf('leave-') === 0; }
function mimeOf_(name, given) {
  if (/^[\w.+-]+\/[\w.+-]+$/.test(given || '')) return given;
  var m = String(name).match(/\.([A-Za-z0-9]+)$/);
  return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream';
}

function cleanClaim_(c) {
  c = c || {};
  var claimant = str_(c.claimant, 80);
  if (!claimant) throw fail_('The claimant name is missing.');
  var month = String(c.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail_('The claim month must look like 2026-10.');
  var src = c.lines instanceof Array ? c.lines : [], lines = [], total = 0;
  if (src.length > MAX_LINES) throw fail_('A claim can have up to ' + MAX_LINES + ' lines.');
  for (var i = 0; i < src.length; i++) {
    var l = src[i] || {};
    var amount = round2_(Math.max(0, Number(l.amount) || 0));
    total += amount;
    var line = { no: i + 1, category: str_(l.category, 40), date: /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? l.date : '', name: str_(l.name, 120), receiptNo: str_(l.receiptNo, 60), amount: amount };
    var litres = Number(l.litres);         // a fuel line may carry the litres pumped and the fuel type: the dashboard works out the carbon of business travel from them
    if (litres > 0 && litres < 300) { line.litres = Math.round(litres * 1000) / 1000; line.fuel = l.fuel === 'diesel' ? 'diesel' : 'petrol'; }
    var sc = scanOf_(l.scan);
    if (sc) line.scan = sc;
    lines.push(line);
  }
  if (!lines.length) throw fail_('The claim has no lines.');
  return { claimant: claimant, month: month, monthLabel: monthLabel_(month), total: round2_(total), lines: lines,
    from: emailOf_(c.from), to: emailOf_(c.to), subject: str_(c.subject, 160), scanLog: scanLogOf_(c.scanLog) };
}

/* what else the claim tool read from a receipt (not on the claim form): the kind of paper, the currency, tax, how it was paid (the card's
   last 4 digits only), due and stay or travel dates, and who read it. Anything else is dropped. */
function scanOf_(sc) {
  if (!sc || typeof sc !== 'object') return null;
  var keep = {}, n = 0;
  ['docType', 'currency', 'taxType', 'paymentMethod', 'source'].forEach(function (k) { var v = str_(sc[k], 40); if (v) { keep[k] = v; n++; } });
  ['dueDate', 'periodStart', 'periodEnd'].forEach(function (k) { if (/^\d{4}-\d{2}-\d{2}$/.test(sc[k] || '')) { keep[k] = sc[k]; n++; } });
  ['total', 'subtotal', 'tax'].forEach(function (k) { var v = Number(sc[k]); if (sc[k] != null && sc[k] !== '' && isFinite(v) && v >= 0 && v < 1e7) { keep[k] = round2_(v); n++; } });
  var l4 = String(sc.last4 == null ? '' : sc.last4).match(/(\d{4})$/);
  if (l4) { keep.last4 = l4[1]; n++; }
  return n ? keep : null;
}
/* the corrections the claimant made to what the claim tool filled in, so the weak spots of the scanner show up */
function scanLogOf_(log) {
  return (log instanceof Array ? log : []).slice(0, 60).map(function (e) {
    e = e || {};
    return { field: str_(e.field, 20), from: str_(e.from, 80), to: str_(e.to, 80), source: str_(e.source, 10), docType: str_(e.docType, 30), category: str_(e.category, 40) };
  }).filter(function (e) { return e.field; });
}
var SCAN_LOG_COLS = ['when', 'claimant', 'claim month', 'field', 'filled in', 'corrected to', 'read by', 'document', 'type'];
function logScan_(db, claim) {
  var log = claim.scanLog || [];
  if (!log.length) return;
  var s = db.ss.getSheetByName('Scan log');
  if (!s) {
    s = db.ss.insertSheet('Scan log', db.ss.getSheets().length);
    s.getRange(1, 1, 1, SCAN_LOG_COLS.length).setValues([SCAN_LOG_COLS]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  var at = new Date().toISOString();
  var rows = log.map(function (e) { return [at, claim.claimant, claim.month, e.field, e.from, e.to, e.source, e.docType, e.category]; });
  s.getRange(s.getLastRow() + 1, 1, rows.length, SCAN_LOG_COLS.length).setValues(rows);
}

/* ---------- leave applications ---------- */
function isoOk_(v) {
  var s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  var d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? '' : s;
}
function dayNo_(iso) { return Math.round(Date.parse(iso + 'T00:00:00Z') / 864e5); }
function weekdays_(start, end) {
  var n = 0;
  for (var d = dayNo_(start); d <= dayNo_(end); d++) { var w = new Date(d * 864e5).getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
function cleanLeave_(l) {
  l = l || {};
  var claimant = str_(l.claimant, 80);
  if (!claimant) throw fail_('The employee name is missing.');
  var start = isoOk_(l.start), end = isoOk_(l.end);
  if (!start || !end) throw fail_('The leave dates must look like 2026-10-31.');
  if (end < start) throw fail_('The leave end date is before the start date.');
  var span = dayNo_(end) - dayNo_(start) + 1;
  if (span > 366) throw fail_('A leave application can cover up to a year.');
  var type = LEAVE_TYPES.hasOwnProperty(l.type) ? l.type : 'other';
  var given = Number(l.days);
  var days = isFinite(given) && given >= 0 && given <= span ? Math.round(given * 2) / 2 : weekdays_(start, end);      // the sender knows the public holidays; without its figure, Monday to Friday
  var month = start.slice(0, 7);
  return { kind: 'leave', claimant: claimant, type: type, typeLabel: LEAVE_TYPES[type], start: start, end: end, days: days, reason: str_(l.reason, 200), signedOn: isoOk_(l.signedOn),
    month: month, monthLabel: monthLabel_(month), from: emailOf_(l.from), to: emailOf_(l.to), subject: str_(l.subject, 160) };
}

/* what the dashboard sees: no folder ids, no upload token */
function publicClaim_(rec) {
  var p = rec && rec.published;
  if (!p) return null;
  var out = {};
  Object.keys(p).forEach(function (k) { if (k !== 'folderId' && k !== 'files') out[k] = p[k]; });
  out.files = (p.files || []).map(function (f) { return { id: f.id, name: f.name, kind: f.kind, line: f.line, mime: f.mime, size: f.size }; });
  return out;
}

/* ---------- storage: one sheet row per claim, files in Drive ---------- */
function open_() {
  var props = PropertiesService.getScriptProperties();
  var ss = null, folder = null, id;
  if ((id = props.getProperty('SHEET_ID'))) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('WFC Claims');
    props.setProperty('SHEET_ID', ss.getId());
    var first = ss.getSheets()[0];
    first.setName('Claims');
    first.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
    first.setFrozenRows(1);
    first.hideColumns(COLS.length);                // the record column is the data; the others are for reading
  }
  if ((id = props.getProperty('FOLDER_ID'))) { try { folder = DriveApp.getFolderById(id); } catch (e) { folder = null; } }
  if (!folder) { folder = DriveApp.createFolder('WFC Claims files'); props.setProperty('FOLDER_ID', folder.getId()); }
  return { ss: ss, sheet: ss.getSheetByName('Claims') || ss.getSheets()[0], folder: folder, leave: null };
}

/* the "Leave" sheet is made the first time a leave application arrives; reading never creates it */
function leaveSheet_(db, create) {
  if (db.leave) return db.leave;
  var s = db.ss.getSheetByName('Leave');
  if (!s && create) {
    s = db.ss.insertSheet('Leave', db.ss.getSheets().length);
    s.getRange(1, 1, 1, LEAVE_COLS.length).setValues([LEAVE_COLS]).setFontWeight('bold');
    s.setFrozenRows(1);
    s.hideColumns(LEAVE_COLS.length);
  }
  db.leave = s || null;
  return db.leave;
}
function sheetFor_(db, id, create) { return isLeaveId_(id) ? leaveSheet_(db, create) : db.sheet; }

function rowOf_(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return 0;
}

function getRec_(db, id) {
  if (!okId_(id)) return null;
  var sheet = sheetFor_(db, id, false);
  if (!sheet) return null;
  var row = rowOf_(sheet, id);
  if (!row) return null;
  try { return JSON.parse(sheet.getRange(row, COLS.length).getValue()); } catch (e) { return null; }
}

function putRec_(db, rec) {
  var p = rec.published;
  if (p && p.history.length > 50) p.history = p.history.slice(-50);
  var json = JSON.stringify(rec);
  if (json.length > 45000) throw fail_('This claim is too big to store.', 413);       // a Google Sheets cell holds 50,000 characters
  var sheet = sheetFor_(db, rec.id, true);
  var row = rowOf_(sheet, rec.id) || sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, COLS.length).setValues([[rec.id, p ? p.claimant : rec.pending.claim.claimant, p ? p.month : rec.pending.claim.month,
    p ? (p.kind === 'leave' ? p.days : p.total) : '', p ? p.status : 'uploading', p ? p.updatedAt : '', json]]);
}

function trash_(folderId) {
  if (!folderId) return;
  try { DriveApp.getFolderById(folderId).setTrashed(true); } catch (e) { /* already gone */ }
}

/* ---------- actions ---------- */
function ping_() { return { ok: true, service: 'wfc-claims', version: VERSION, where: 'google', auth: passwordSet_(), claude: claudeOn_(), leave: true, ask: claudeOn_(), rules: true, scan: claudeOn_(), seen: true }; }

/* ---------- the company's claim rules: plain words the dashboard's auditor checks every claim against (password needed to read or change) ---------- */
function readRules_() {
  try { var r = JSON.parse(PropertiesService.getScriptProperties().getProperty('RULES') || '{}'); return { text: String(r.text || ''), updatedAt: String(r.updatedAt || '') }; }
  catch (e) { return { text: '', updatedAt: '' }; }
}
function rules_(b) {
  var text = String(b.text == null ? '' : b.text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]+/g, ' ').replace(/^\s+|\s+$/g, '');
  if (text.length > MAX_RULES) throw fail_('Keep the rules under ' + MAX_RULES + ' characters.');
  var r = { text: text, updatedAt: new Date().toISOString() };
  PropertiesService.getScriptProperties().setProperty('RULES', JSON.stringify(r));
  return { ok: true, rules: r };
}

/* ---------- Claude relay: the Claim Builder asks here to read a receipt photo, so nobody pastes a key ----------
   The Anthropic key lives only in the script properties (CLAUDE_KEY), never in a web page. Whatever the page asks for, the model is fixed here,
   the answer length is capped, only one JPEG photo and a short note are accepted, and the whole team shares a daily cap, so even if the address
   leaks it cannot run up a bill. (Also set a monthly spend limit on the key in the Anthropic Console.) */
var CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
var CLAUDE_MODEL = 'claude-sonnet-5-5';              // script property CLAUDE_MODEL changes it
var CLAUDE_MAX_TOKENS = 1000;
var CLAUDE_DAILY_CAP = 300;                          // calls a day for the whole team; script property CLAUDE_DAILY_CAP changes it
var CLAUDE_MAX_CHARS = 2400000;                      // the photo as base64, about 1.8 MB

function claudeOn_() { return !!PropertiesService.getScriptProperties().getProperty('CLAUDE_KEY'); }

function claudeCount_(dayProp, capProp, capDefault) {
  dayProp = dayProp || 'CLAUDE_DAY';
  var props = PropertiesService.getScriptProperties();
  var cap = parseInt(props.getProperty(capProp || 'CLAUDE_DAILY_CAP'), 10) || capDefault || CLAUDE_DAILY_CAP;
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var today = new Date().toISOString().slice(0, 10), cur = String(props.getProperty(dayProp) || '').split(':');
    var n = cur[0] === today ? (parseInt(cur[1], 10) || 0) : 0;
    if (n >= cap) throw fail_("The company's Claude limit for today is used up.", 429);
    props.setProperty(dayProp, today + ':' + (n + 1));
  } finally { try { lock.releaseLock(); } catch (e) { /* already released */ } }
}

function callClaude_(payload, effort, key) {
  var p = JSON.parse(JSON.stringify(payload));
  if (effort) p.output_config = effort;
  var res = UrlFetchApp.fetch(CLAUDE_URL, { method: 'post', contentType: 'application/json', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, payload: JSON.stringify(p), muteHttpExceptions: true });
  var code = res.getResponseCode(), text = res.getContentText(), j = null;
  try { j = JSON.parse(text); } catch (e) { j = null; }
  if (code === 400 && effort && /effort|output_config/i.test(text)) return callClaude_(payload, null, key);       // a model that does not take the effort setting
  return { code: code, text: text, json: j };
}

function claude_(b) {
  var props = PropertiesService.getScriptProperties(), key = props.getProperty('CLAUDE_KEY');
  if (!key) throw fail_('Claude is not set up on the inbox.', 503);
  var r = (b && b.request) || {}, m = r.messages;
  if (!(m instanceof Array) || m.length !== 1 || !m[0] || m[0].role !== 'user' || !(m[0].content instanceof Array)) throw fail_('Bad request.');
  var images = 0, texts = 0, chars = 0;
  m[0].content.forEach(function (c) {
    if (c && c.type === 'image' && c.source && c.source.type === 'base64' && c.source.media_type === 'image/jpeg' && typeof c.source.data === 'string') { images++; chars += c.source.data.length; }
    else if (c && c.type === 'text' && typeof c.text === 'string' && c.text.length <= 600) { texts++; chars += c.text.length; }
    else throw fail_('Bad request.');
  });
  if (images !== 1 || texts > 1) throw fail_('Bad request.');
  if (chars > CLAUDE_MAX_CHARS) throw fail_('That photo is too big.', 413);
  if (r.system != null && (typeof r.system !== 'string' || r.system.length > 6000)) throw fail_('Bad request.');
  claudeCount_();
  var payload = { model: props.getProperty('CLAUDE_MODEL') || CLAUDE_MODEL, max_tokens: Math.min(parseInt(r.max_tokens, 10) || CLAUDE_MAX_TOKENS, CLAUDE_MAX_TOKENS), messages: m };
  if (r.system) payload.system = r.system;
  var effort = r.output_config && /^(low|medium|high)$/.test(String(r.output_config.effort)) ? { effort: r.output_config.effort } : null;
  var res = callClaude_(payload, effort, key);
  if (res.code !== 200 || !res.json) {
    // our own words, never Anthropic's text: nothing about the key can leak through an error
    if (res.code === 401 || res.code === 403) throw fail_('The company Claude key was not accepted. Tell whoever looks after the inbox.', 502);
    if (res.code === 429 || /credit|billing|balance/i.test(res.text)) throw fail_('Claude is busy, or the company account has no credit left.', 502);
    throw fail_('Claude could not read that photo (HTTP ' + res.code + ').', 502);
  }
  var j = res.json;
  return { ok: true, reply: { content: j.content, stop_reason: j.stop_reason, usage: j.usage, model: j.model } };
}

/* ---------- the receipt scanner: Claude reads a receipt or invoice the claim tool was not sure about ----------
   Open like the photo check above (staff send claims without the password), so it is kept narrow: one request with 1-3 page images
   (JPEG or PNG) or one PDF, plus at most one text note (the text the claim tool already read); the instructions and the answer's
   shape come with it, but the model must be one of the two allowed, the answer length is capped and there is a daily cap of its own. */
var SCAN_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'];
var SCAN_MODEL = 'claude-sonnet-5-5';                // script property SCAN_MODEL changes the default
var SCAN_MAX_TOKENS = 2500;
var SCAN_MAX_CHARS = 14000000;                       // the pages as base64, about 10 MB
var SCAN_DAILY_CAP = 300;                            // scans a day for the whole team; script property SCAN_DAILY_CAP changes it

function scan_(b) {
  var props = PropertiesService.getScriptProperties(), key = props.getProperty('CLAUDE_KEY');
  if (!key) throw fail_('Claude is not set up on the inbox.', 503);
  var r = (b && b.request) || {}, m = r.messages;
  if (!(m instanceof Array) || m.length !== 1 || !m[0] || m[0].role !== 'user' || !(m[0].content instanceof Array)) throw fail_('Bad request.');
  var images = 0, docs = 0, texts = 0, chars = 0;
  m[0].content.forEach(function (c) {
    var src = c && c.source;
    if (c && c.type === 'image' && src && src.type === 'base64' && /^image\/(jpeg|png)$/.test(src.media_type) && typeof src.data === 'string') { images++; chars += src.data.length; }
    else if (c && c.type === 'document' && src && src.type === 'base64' && src.media_type === 'application/pdf' && typeof src.data === 'string') { docs++; chars += src.data.length; }
    else if (c && c.type === 'text' && typeof c.text === 'string' && c.text.length <= 20000) { texts++; chars += c.text.length; }
    else throw fail_('Bad request.');
  });
  if (texts > 1 || docs > 1 || images > 3 || (images + docs) < 1 || (images && docs)) throw fail_('Bad request.');
  if (chars > SCAN_MAX_CHARS) throw fail_('That file is too big to read.', 413);
  if (typeof r.system !== 'string' || !r.system || r.system.length > 10000) throw fail_('Bad request.');
  var format = r.output_config && r.output_config.format;
  if (format && (format.type !== 'json_schema' || typeof format.schema !== 'object' || JSON.stringify(format.schema).length > 20000)) throw fail_('Bad request.');
  var model = SCAN_MODELS.indexOf(r.model) >= 0 ? r.model : (props.getProperty('SCAN_MODEL') || SCAN_MODEL);
  claudeCount_('SCAN_DAY', 'SCAN_DAILY_CAP', SCAN_DAILY_CAP);
  var effort = r.output_config && /^(low|medium|high)$/.test(String(r.output_config.effort)) ? r.output_config.effort : 'low';
  var oc = { effort: effort };
  if (format) oc.format = { type: 'json_schema', schema: format.schema };
  var payload = { model: model, max_tokens: Math.min(parseInt(r.max_tokens, 10) || SCAN_MAX_TOKENS, SCAN_MAX_TOKENS), system: r.system, messages: m, output_config: oc };
  var res = callAsk_(payload, key, false);
  if (res.code === 400 && /effort|output_config/i.test(res.text) && !format) { delete payload.output_config; res = callAsk_(payload, key, false); }
  if (res.code !== 200 || !res.json) {
    if (res.code === 401 || res.code === 403) throw fail_('The company Claude key was not accepted. Tell whoever looks after the inbox.', 502);
    if (res.code === 429 || /credit|billing|balance/i.test(res.text)) throw fail_('Claude is busy, or the company account has no credit left.', 502);
    throw fail_('Claude could not read that file (HTTP ' + res.code + ').', 502);
  }
  var j = res.json;
  return { ok: true, reply: { content: j.content, stop_reason: j.stop_reason, usage: j.usage, model: j.model } };
}

/* ---------- Ask Flow: questions about the claims and leave, from the dashboard ----------
   Only with the dashboard password (it reads company data). The page sends the instructions and the question as plain text; the model, the
   answer length and a daily cap are fixed here. No photos, no conversation, nothing but one question at a time. */
var ASK_MODEL = 'claude-opus-5-5';                   // script property ASK_MODEL changes it
var ASK_MAX_TOKENS = 3000;
var ASK_DAILY_CAP = 300;                             // questions a day; script property ASK_DAILY_CAP changes it (each question is two calls)

function callAsk_(payload, key, beta) {
  var headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  if (beta) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';      // if the model declines for safety, Anthropic retries on a suitable model
  var res = UrlFetchApp.fetch(CLAUDE_URL, { method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify(payload), muteHttpExceptions: true });
  var code = res.getResponseCode(), text = res.getContentText(), j = null;
  try { j = JSON.parse(text); } catch (e) { j = null; }
  if (code === 400 && beta && /fallback/i.test(text)) { var p = JSON.parse(JSON.stringify(payload)); delete p.fallbacks; return callAsk_(p, key, false); }
  return { code: code, text: text, json: j };
}

function ask_(b) {
  var props = PropertiesService.getScriptProperties(), key = props.getProperty('CLAUDE_KEY');
  if (!key) throw fail_('Claude is not set up on the inbox.', 503);
  var r = (b && b.request) || {}, m = r.messages;
  if (!(m instanceof Array) || m.length !== 1 || !m[0] || m[0].role !== 'user' || typeof m[0].content !== 'string' || !m[0].content || m[0].content.length > 60000) throw fail_('Bad request.');
  if (typeof r.system !== 'string' || !r.system || r.system.length > 20000) throw fail_('Bad request.');
  var oc = { effort: /^(low|medium|high)$/.test(String(r.output_config && r.output_config.effort)) ? r.output_config.effort : 'low' };
  var fmt = r.output_config && r.output_config.format;
  if (fmt != null) {
    if (typeof fmt !== 'object' || fmt.type !== 'json_schema' || !fmt.schema || typeof fmt.schema !== 'object' || JSON.stringify(fmt.schema).length > 20000) throw fail_('Bad request.');
    oc.format = { type: 'json_schema', schema: fmt.schema };
  }
  claudeCount_('ASK_DAY', 'ASK_DAILY_CAP', ASK_DAILY_CAP);
  var payload = { model: props.getProperty('ASK_MODEL') || ASK_MODEL, max_tokens: Math.min(parseInt(r.max_tokens, 10) || ASK_MAX_TOKENS, ASK_MAX_TOKENS),
    system: r.system, messages: [{ role: 'user', content: m[0].content }], output_config: oc, fallbacks: 'default' };
  var res = callAsk_(payload, key, true);
  if (res.code !== 200 || !res.json) {
    // our own words, never Anthropic's text: nothing about the key can leak through an error
    if (res.code === 401 || res.code === 403) throw fail_('The company Claude key was not accepted. Tell whoever looks after the inbox.', 502);
    if (res.code === 429 || /credit|billing|balance/i.test(res.text)) throw fail_('Claude is busy, or the company account has no credit left.', 502);
    throw fail_('Claude could not answer just now (HTTP ' + res.code + '). Please try again.', 502);
  }
  var j = res.json;
  return { ok: true, reply: { content: j.content, stop_reason: j.stop_reason, usage: j.usage, model: j.model } };
}

function readSheet_(sheet) {
  var out = [], last = sheet ? sheet.getLastRow() : 0;
  if (last >= 2) {
    sheet.getRange(2, COLS.length, last - 1, 1).getValues().forEach(function (r) {
      try { var c = publicClaim_(JSON.parse(r[0])); if (c) out.push(c); } catch (e) { /* a row that is not ours */ }
    });
  }
  out.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
  return out;
}

/* leave applications come in their own list, so a dashboard that only knows claims keeps working */
function list_() {
  var db = open_();
  return { ok: true, claims: readSheet_(db.sheet), leave: readSheet_(leaveSheet_(db, false)), rules: readRules_() };
}

/* ---------- receipts claimed before: the Claim Builder asks while a claim is being made (the dashboard's auditor makes the same checks after) ----------
   The same receipt number, or the same shop, date and amount, on a line of an earlier saved claim (any month, anyone). Toll and parking lines
   are left out: they carry the Touch 'n Go card or statement number, the same every month. The claim being re-saved (same person, same month)
   is not compared with itself. Open like the Claim Builder's other calls, so it answers only the month, the status and "yours or not",
   never another person's name or lines. */
var SEEN_OTHER_KIND = /transport|grab|e-?hailing|taxi|travel|flight|air\s?ticket|airfare|\btrains?\b|bus\s?ticket|ferry|online|shopping|shopee|lazada|supplier|purchase|petrol|fuel|diesel|minyak/i;
function statementCat_(cat) { var c = String(cat || ''); return !SEEN_OTHER_KIND.test(c) && /toll|parking/i.test(c); }
function receiptKey_(no) { return String(no || '').toLowerCase().replace(/[\s\-_.#\/:]+/g, ''); }
function shopKey_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/^\s+|\s+$/g, ''); }
function lookKey_(name, date, amount) { var shop = shopKey_(name), a = Number(amount) || 0; return shop && /^\d{4}-\d{2}-\d{2}$/.test(date || '') && a > 0 ? shop + '|' + date + '|' + a.toFixed(2) : ''; }
function seen_(b) {
  var claimant = str_(b.claimant, 80), month = String(b.month || ''), who = claimant ? slug_(claimant) : '';
  var self = who && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month + '_' + who : '';
  var src = b.lines instanceof Array ? b.lines.slice(0, MAX_LINES) : [];
  var byNo = {}, byLook = {};
  readSheet_(open_().sheet).forEach(function (c) {
    if (c.id === self || c.kind === 'leave') return;
    var hit = { month: c.month, monthLabel: c.monthLabel || monthLabel_(c.month), status: c.status, mine: !!who && slug_(c.claimant) === who };
    (c.lines || []).forEach(function (l) {
      if (statementCat_(l.category)) return;
      var rn = receiptKey_(l.receiptNo), lk = lookKey_(l.name, l.date, l.amount);
      if (rn.length >= 3) (byNo[rn] = byNo[rn] || []).push(hit);
      if (lk) (byLook[lk] = byLook[lk] || []).push(hit);
    });
  });
  var matches = [];
  src.forEach(function (l, i) {
    l = l || {};
    if (statementCat_(l.category)) return;
    var rn = receiptKey_(str_(l.receiptNo, 60)), check = 'receipt', hits = rn.length >= 3 ? byNo[rn] : null;
    if (!hits) { var lk = lookKey_(str_(l.name, 120), l.date, l.amount); hits = lk ? byLook[lk] : null; check = 'lookalike'; }
    if (hits && hits.length) matches.push({ ref: str_(l.ref, 40) || String(i), check: check, claims: hits.slice(0, 3) });
  });
  return { ok: true, matches: matches };
}

function file_(q) {
  var db = open_(), rec = getRec_(db, q.id), p = rec && rec.published, f = null;
  if (p) (p.files || []).forEach(function (x) { if (x.id === q.file) f = x; });
  if (!f) throw fail_('That file is not there.', 404);
  var blob = DriveApp.getFileById(f.driveId).getBlob();
  return { ok: true, name: f.name, mime: f.mime, size: f.size, data: Utilities.base64Encode(blob.getBytes()) };
}

function submit_(b) {
  // a saved leave form comes as `leave`, a claim as `claim`; one application per person per start date, one claim per person per month
  var claim = b.leave ? cleanLeave_(b.leave) : cleanClaim_(b.claim), db = open_();
  var id = b.leave ? 'leave-' + claim.start + '_' + slug_(claim.claimant) : claim.month + '_' + slug_(claim.claimant);
  var rec = getRec_(db, id) || { id: id, published: null, pending: null };
  if (rec.pending) trash_(rec.pending.folderId);                 // an earlier upload that never finished
  var token = Utilities.getUuid().replace(/-/g, '');
  var folder = db.folder.createFolder(id + ' (' + token.slice(0, 6) + ')');
  rec.pending = { token: token, folderId: folder.getId(), claim: claim, startedAt: new Date().toISOString() };
  putRec_(db, rec);
  return { ok: true, id: id, token: token };
}

function upload_(b) {
  var db = open_(), rec = getRec_(db, b.id);
  if (!rec || !rec.pending || rec.pending.token !== b.token) throw fail_('This upload is no longer valid. Save the claim again.', 409);
  var f = b.file || {};
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(f.id || ''))) throw fail_('Bad file id.');
  var bytes = Utilities.base64Decode(String(f.data || ''));
  if (!bytes.length) throw fail_('The file is empty.');
  if (bytes.length > MAX_FILE) throw fail_('The file is too big.', 413);
  var name = safeName_(f.name), mime = mimeOf_(name, f.mime);
  var folder = DriveApp.getFolderById(rec.pending.folderId);
  var file = folder.createFile(Utilities.newBlob(bytes, mime, name));
  file.setDescription(JSON.stringify({ fid: f.id, kind: KINDS.indexOf(f.kind) >= 0 ? f.kind : 'other', line: Math.max(0, parseInt(f.line, 10) || 0) }));
  return { ok: true, size: bytes.length };
}

function finish_(b) {
  var db = open_(), rec = getRec_(db, b.id);
  if (!rec || !rec.pending || rec.pending.token !== b.token) throw fail_('This upload is no longer valid. Save the claim again.', 409);
  var old = rec.published, pend = rec.pending, at = new Date().toISOString();
  var byId = {};                                                  // if a file was uploaded twice (a retry), the newest wins
  var it = DriveApp.getFolderById(pend.folderId).getFiles();
  while (it.hasNext()) {
    var file = it.next(), meta = {};
    try { meta = JSON.parse(file.getDescription() || '{}'); } catch (e) { meta = {}; }
    if (!meta.fid) continue;
    var entry = { id: meta.fid, name: file.getName(), kind: meta.kind || 'other', line: meta.line || 0, mime: file.getMimeType(), size: file.getSize(), driveId: file.getId(), made: file.getDateCreated().getTime() };
    if (!byId[meta.fid] || byId[meta.fid].made < entry.made) byId[meta.fid] = entry;
  }
  var files = Object.keys(byId).sort().map(function (k) { var e = byId[k]; delete e.made; return e; });
  var version = (old ? old.version : 0) + 1;
  var history = (old ? old.history : []).concat({ at: at, text: old ? 'Updated by the claimant (version ' + version + ')' : 'Received' });
  var published = { id: rec.id };
  Object.keys(pend.claim).forEach(function (k) { published[k] = pend.claim[k]; });
  published.version = version; published.submittedAt = old ? old.submittedAt : at; published.updatedAt = at;
  published.status = 'new'; published.statusAt = at; published.note = ''; published.history = history;
  published.files = files; published.folderId = pend.folderId;
  if (old) trash_(old.folderId);
  rec.published = published; rec.pending = null;
  putRec_(db, rec);
  if (!isLeaveId_(rec.id)) { try { logScan_(db, published); } catch (e) { console.error(e); } }        // never stops a claim from arriving
  return { ok: true, id: rec.id, version: version, files: files.length };
}

function status_(b) {
  var db = open_(), rec = getRec_(db, b.id), p = rec && rec.published;
  if (!p) throw fail_('That claim is not there.', 404);
  var status = b.status == null ? p.status : String(b.status);
  if (STATUS_BY_KIND[p.kind === 'leave' ? 'leave' : 'claim'].indexOf(status) < 0) throw fail_('Unknown status.');
  var note = b.note == null ? p.note : str_(b.note, 600);
  var at = new Date().toISOString(), notes = [];
  if (status !== p.status) notes.push('Marked as ' + STATUS_WORD[status]);
  if (note !== p.note) notes.push(note ? 'Note updated' : 'Note removed');
  p.status = status; p.note = note;
  if (notes.length) p.statusAt = at;
  notes.forEach(function (text) { p.history.push({ at: at, text: text }); });
  putRec_(db, rec);
  return { ok: true, claim: publicClaim_(rec) };
}

function delete_(b) {
  var db = open_(), rec = getRec_(db, b.id);
  if (!rec) throw fail_('That claim is not there.', 404);
  if (rec.pending) trash_(rec.pending.folderId);
  if (rec.published) trash_(rec.published.folderId);              // to the Drive bin, so it can still be restored from there
  var sheet = sheetFor_(db, rec.id, false);
  sheet.deleteRow(rowOf_(sheet, rec.id));
  return { ok: true };
}
