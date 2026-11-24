/* WFC Claims inbox - the Google version (Google Apps Script web app).

   What it does: the Claim Builder posts a saved claim here, the dashboard reads it. Same actions and answers as
   server/server.js (the local version), so the two pages work with either.

   Where things are kept (all in the Google account that deploys this script, created on first use):
     - a Google Sheet "WFC Claims"          one row per claim on its "Claims" sheet, one per leave application on its "Leave" sheet (handy for Agnes to open too)
     - a Drive folder "WFC Claims files"    one sub-folder per claim, holding the claim form, receipts, TNG statement
     - a sheet "Reminders"                  who switched on the monthly claim reminder (their name and phone's push address), made on first use
   Nothing else is stored, and nothing leaves that Google account (except the reminder pings, which go to Google's, Apple's, Mozilla's or Microsoft's push service).

   No login yet (on purpose, for the demo): anyone who has the web app address can read and add claims.
   The setup steps are in README.md, "Put it online (Google)". */

var VERSION = 7;
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
    var known = { ping: ping_, list: list_, file: file_, submit: submit_, upload: upload_, finish: finish_, status: status_, 'delete': delete_, claude: claude_, ask: ask_, rules: rules_, scan: scan_, seen: seen_, remind: remind_ };
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
var OPEN_ACTIONS = { ping: 1, submit: 1, upload: 1, finish: 1, claude: 1, scan: 1, seen: 1, remind: 1 };
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
function ping_() { return { ok: true, service: 'wfc-claims', version: VERSION, where: 'google', auth: passwordSet_(), claude: claudeOn_(), leave: true, ask: claudeOn_(), rules: true, scan: claudeOn_(), seen: true, remind: true }; }

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

/* ---------- monthly claim reminders (web push) ----------
   Staff switch the reminder on inside the Claim Builder (action: remind). On the 1st, 8th, 13th and 15th of each month, about 09:00 Malaysia
   time, a daily time trigger (remindDaily, made by running setupReminders once) pings every phone or laptop whose owner has not yet sent
   last month's claim. The ping is a Web Push (RFC 8030) signed with VAPID (RFC 8292) and carries NO text: the Claim Builder's service worker
   writes the notification from the date, so nothing needs encrypting.
   Apps Script has no ECDSA, so the signature (ES256 = ECDSA on P-256 with SHA-256) is worked out below with BigInt. The sender's key pair is made
   by the script the first time it is needed and kept in the script properties VAPID_PRIVATE and VAPID_PUBLIC (never in this code). Do not delete
   them: every phone that switched reminders on is tied to that public key and would have to switch on again. */
var REMIND_DAYS = [1, 8, 13, 15];                      // days of the month (Malaysia time) on which staff are reminded
var REMIND_TZ = 'Asia/Kuala_Lumpur';
var REMIND_MAX = 300;                                  // phones and laptops that can have reminders on
var REMIND_BUDGET_MS = 4 * 60 * 1000;                  // stop sending after about four minutes (a run may last six)
var REMIND_COLS = ['endpoint', 'name', 'slug', 'email', 'added', 'updated', 'lastSent', 'lastResult'];
var PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com', 'push.apple.com', 'notify.windows.com'];
var VAPID_SUBJECT = 'mailto:marketing.wfcsystems@gmail.com';       // who a push service can contact about this sender (script property VAPID_SUBJECT changes it)

/* ---- P-256 (secp256r1) with BigInt: points are kept as Jacobian [X, Y, Z] (affine x = X/Z^2, y = Y/Z^3), Z = 0 is the point at infinity ----
   Not constant-time, which does not matter here: the only secret is used inside Google's server for a few signatures, never in a loop an
   outsider can time. Numbers are made with BigInt('0x..') rather than 5n so every editor and linter reads the file. */
var P256_ = null;
function p256_() {
  if (!P256_) {
    var hex = function (s) { return BigInt('0x' + s); };
    P256_ = { p: hex('ffffffff00000001000000000000000000000000ffffffffffffffffffffffff'), n: hex('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),
      gx: hex('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'), gy: hex('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'),
      zero: BigInt(0), one: BigInt(1), two: BigInt(2), three: BigInt(3), four: BigInt(4), eight: BigInt(8) };
  }
  return P256_;
}
function bigMod_(a, m) { var r = a % m; return r < p256_().zero ? r + m : r; }
function modInv_(a, m) {                                  // extended Euclid
  var c = p256_(), r0 = m, r1 = bigMod_(a, m), s0 = c.zero, s1 = c.one;
  while (r1 !== c.zero) {
    var q = r0 / r1, t = r0 - q * r1;
    r0 = r1; r1 = t;
    t = s0 - q * s1; s0 = s1; s1 = t;
  }
  if (r0 !== c.one) throw new Error('No inverse.');
  return bigMod_(s0, m);
}
function jDouble_(P) {
  var c = p256_(), p = c.p, X = P[0], Y = P[1], Z = P[2];
  if (Z === c.zero || Y === c.zero) return [c.one, c.one, c.zero];
  var delta = Z * Z % p, gamma = Y * Y % p, beta = X * gamma % p;
  var alpha = c.three * bigMod_((X - delta) * (X + delta), p) % p;                   // 3 (X - Z^2) (X + Z^2), because a = -3
  var X3 = bigMod_(alpha * alpha - c.eight * beta, p);
  var Z3 = bigMod_((Y + Z) * (Y + Z) - gamma - delta, p);
  var Y3 = bigMod_(alpha * (c.four * beta - X3) - c.eight * gamma * gamma, p);
  return [X3, Y3, Z3];
}
function jAdd_(P, Q) {
  var c = p256_(), p = c.p;
  if (P[2] === c.zero) return Q;
  if (Q[2] === c.zero) return P;
  var z1z1 = P[2] * P[2] % p, z2z2 = Q[2] * Q[2] % p;
  var u1 = P[0] * z2z2 % p, u2 = Q[0] * z1z1 % p;
  var s1 = P[1] * Q[2] % p * z2z2 % p, s2 = Q[1] * P[2] % p * z1z1 % p;
  var h = bigMod_(u2 - u1, p);
  if (h === c.zero) return s1 === s2 ? jDouble_(P) : [c.one, c.one, c.zero];       // the same point, or opposite points
  var i = c.four * h * h % p, j = h * i % p, r = c.two * bigMod_(s2 - s1, p), v = u1 * i % p;
  var X3 = bigMod_(r * r - j - c.two * v, p);
  var Y3 = bigMod_(r * (v - X3) - c.two * s1 * j, p);
  var Z3 = bigMod_(((P[2] + Q[2]) * (P[2] + Q[2]) - z1z1 - z2z2) * h, p);
  return [X3, Y3, Z3];
}
/* k * (x, y) as {x, y} (BigInt), or null for the point at infinity */
function p256Mul_(k, x, y) {
  var c = p256_(), R = [c.one, c.one, c.zero], Q = [x, y, c.one], bits = k.toString(2);
  for (var i = 0; i < bits.length; i++) {
    R = jDouble_(R);
    if (bits.charAt(i) === '1') R = jAdd_(R, Q);
  }
  if (R[2] === c.zero) return null;
  var zi = modInv_(R[2], c.p), zi2 = zi * zi % c.p;
  return { x: R[0] * zi2 % c.p, y: R[1] * zi2 % c.p * zi % c.p };
}

/* ---- bytes ----
   Apps Script gives and takes signed bytes (-128..127); in here a byte list is always 0..255 and is made signed only for a Google call. */
function u8_(a) { var o = []; for (var i = 0; i < a.length; i++) o.push(a[i] & 255); return o; }
function s8_(a) { var o = []; for (var i = 0; i < a.length; i++) o.push((a[i] & 255) > 127 ? (a[i] & 255) - 256 : a[i] & 255); return o; }
function asciiBytes_(s) { var o = []; for (var i = 0; i < s.length; i++) o.push(s.charCodeAt(i) & 127); return o; }
function bigFromBytes_(b) {
  var h = '';
  for (var i = 0; i < b.length; i++) h += ('0' + (b[i] & 255).toString(16)).slice(-2);
  return BigInt('0x' + (h || '0'));
}
function bigToBytes_(x, len) {
  var h = x.toString(16), o = [];
  while (h.length < len * 2) h = '0' + h;
  for (var i = 0; i < h.length; i += 2) o.push(parseInt(h.substr(i, 2), 16));
  return o;
}
function b64u_(bytes) { return Utilities.base64Encode(s8_(bytes)).replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64uBytes_(s) {
  var t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return u8_(Utilities.base64Decode(t));
}
function sha256_(bytes) { return u8_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s8_(bytes))); }
function hmac256_(keyBytes, msgBytes) { return u8_(Utilities.computeHmacSha256Signature(s8_(msgBytes), s8_(keyBytes))); }

/* ---- ES256: the 64-byte signature r || s (what a JWT carries) ----
   The one-time number k is not random: it is HMAC(private key, hash of the message + a counter), 512 bits reduced mod n, so the same message
   always gets the same signature and two different messages never share a k. If k, r or s comes out 0 the counter moves on. */
function es256Sign_(d, msg) {
  var c = p256_(), hash = sha256_(msg), z = bigFromBytes_(hash), dBytes = bigToBytes_(d, 32);
  for (var ctr = 0; ctr < 32; ctr++) {
    var k = bigMod_(bigFromBytes_(hmac256_(dBytes, hash.concat([ctr, 1])).concat(hmac256_(dBytes, hash.concat([ctr, 2])))), c.n);
    if (k === c.zero) continue;
    var R = p256Mul_(k, c.gx, c.gy), r = bigMod_(R.x, c.n);
    if (r === c.zero) continue;
    var s = bigMod_(modInv_(k, c.n) * (z + r * d), c.n);
    if (s === c.zero) continue;
    return bigToBytes_(r, 32).concat(bigToBytes_(s, 32));
  }
  throw new Error('Could not sign.');
}
function p256PublicBytes_(d) {                            // the 65-byte uncompressed point 04 || x || y
  var c = p256_(), R = p256Mul_(d, c.gx, c.gy);
  return [4].concat(bigToBytes_(R.x, 32), bigToBytes_(R.y, 32));
}

/* ---- the sender's key pair (VAPID), made here the first time it is needed ---- */
function randomScalar_() {                                // 1 .. n-1, from the random parts of four UUIDs mixed through HMAC (twice, so the reduction mod n has no bias)
  var c = p256_(), key = asciiBytes_(Utilities.getUuid() + Utilities.getUuid()), seed = Utilities.getUuid() + Utilities.getUuid() + ':' + Date.now();
  var raw = hmac256_(key, asciiBytes_(seed + ':1')).concat(hmac256_(key, asciiBytes_(seed + ':2')));
  return bigMod_(bigFromBytes_(raw), c.n - c.one) + c.one;
}
function parseVapidPrivate_(s) {
  var c = p256_();
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(s || ''))) return null;
  var d = bigFromBytes_(b64uBytes_(s));
  return d > c.zero && d < c.n ? d : null;
}
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { try { lock.releaseLock(); } catch (e) { /* already released */ } }
}
/* { d: private scalar (BigInt), pub: the public key as base64url of the 65-byte point } */
function vapidKeys_() {
  var props = PropertiesService.getScriptProperties();
  var read = function () { return { d: parseVapidPrivate_(props.getProperty('VAPID_PRIVATE')), pub: String(props.getProperty('VAPID_PUBLIC') || '') }; };
  var k = read();
  if (k.d && /^[A-Za-z0-9_-]{87}$/.test(k.pub)) return k;
  return withLock_(function () {                          // two first requests at once must not make two key pairs
    var k2 = read();
    if (!k2.d) { k2.d = randomScalar_(); props.setProperty('VAPID_PRIVATE', b64u_(bigToBytes_(k2.d, 32))); }
    var pub = b64u_(p256PublicBytes_(k2.d));
    if (pub !== k2.pub) props.setProperty('VAPID_PUBLIC', pub);
    return { d: k2.d, pub: pub };
  });
}
function vapidSubject_() {
  var s = String(PropertiesService.getScriptProperties().getProperty('VAPID_SUBJECT') || '');
  return /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(s) && /^[\x21-\x7e]+$/.test(s) ? s : VAPID_SUBJECT;
}

/* The Authorization header for one push: 'vapid t=<JWT>, k=<public key>'. The JWT says who the push is for (the push service's origin),
   until when (12 hours) and who to contact. `cache` (optional, one run) keeps the keys and one header per push service. */
function pushOrigin_(endpoint) {
  var m = /^https:\/\/([a-z0-9.-]+)(?::443)?(?:[\/?#]|$)/i.exec(String(endpoint));
  return m ? 'https://' + m[1].toLowerCase() : '';
}
function buildVapidHeader_(endpoint, nowSec, cache) {
  var aud = pushOrigin_(endpoint);
  if (!aud) throw new Error('Not an https address.');
  cache = cache || {};
  if (cache['h ' + aud]) return cache['h ' + aud];
  var keys = cache.keys || (cache.keys = vapidKeys_());
  var input = b64u_(asciiBytes_('{"typ":"JWT","alg":"ES256"}')) + '.' + b64u_(asciiBytes_(JSON.stringify({ aud: aud, exp: nowSec + 12 * 3600, sub: vapidSubject_() })));
  var header = 'vapid t=' + input + '.' + b64u_(es256Sign_(keys.d, asciiBytes_(input))) + ', k=' + keys.pub;
  cache['h ' + aud] = header;
  return header;
}

/* ---- who is on the list: the "Reminders" sheet ---- */
function remindSheet_(db, create) {
  var s = db.ss.getSheetByName('Reminders');
  if (!s && create) {
    s = db.ss.insertSheet('Reminders', db.ss.getSheets().length);
    s.getRange(1, 1, 1, REMIND_COLS.length).setValues([REMIND_COLS]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s || null;
}
function remindRowOf_(sheet, endpoint) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var eps = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < eps.length; i++) if (eps[i][0] === endpoint) return i + 2;
  return 0;
}
function readSubscribers_(sheet) {
  var last = sheet ? sheet.getLastRow() : 0, out = [];
  if (last < 2) return out;
  sheet.getRange(2, 1, last - 1, REMIND_COLS.length).getValues().forEach(function (r, i) {
    if (r[0]) out.push({ row: i + 2, endpoint: String(r[0]), name: String(r[1]), slug: String(r[2]), email: String(r[3]), added: r[4], updated: r[5], lastSent: r[6], lastResult: r[7] });
  });
  return out;
}
/* the push address to keep, or '' if it is not one we send to: https, not too long, on one of the push services' own hosts, no odd characters */
function pushEndpointOk_(v) {
  if (typeof v !== 'string' || v.length > 1000) return '';
  var m = /^https:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::443)?(?:\/[\x21-\x7e]*)?$/i.exec(v);
  if (!m) return '';
  var host = m[1].toLowerCase();
  return PUSH_HOSTS.some(function (h) { return host === h || host.slice(-h.length - 1) === '.' + h; }) ? v : '';
}
/* text for a sheet cell: a leading = + - @ would make Sheets read it as a formula */
function cellText_(s) { return String(s).replace(/^[=+\-@\s]+/, ''); }

/* ---------- the remind action: { action: 'remind', op: 'key' | 'join' | 'leave' | 'status', ... } ---------- */
function remind_(b) {
  var op = typeof b.op === 'string' ? b.op : '';
  if (op === 'key') return { ok: true, key: vapidKeys_().pub };
  if (op === 'join') return remindJoin_(b);
  if (op === 'leave') return remindLeave_(b);
  if (op === 'status') return remindStatus_(b);
  throw fail_('Unknown reminder request.');
}
function remindJoin_(b) {
  var endpoint = pushEndpointOk_(b.endpoint);
  if (!endpoint) throw fail_('That phone or browser address cannot be used for reminders.');
  var name = cellText_(str_(typeof b.name === 'string' ? b.name : '', 80));
  if (!name) throw fail_('The name is missing.');
  var email = typeof b.email === 'string' ? cellText_(emailOf_(b.email)) : '';
  return withLock_(function () {
    var db = open_(), sheet = remindSheet_(db, true), row = remindRowOf_(sheet, endpoint), at = new Date().toISOString();
    if (row) {
      var added = sheet.getRange(row, 5, 1, 1).getValue();
      sheet.getRange(row, 2, 1, 5).setValues([[name, slug_(name), email, added, at]]);
    } else {
      if (sheet.getLastRow() - 1 >= REMIND_MAX) throw fail_('Too many phones have reminders on already.');
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, REMIND_COLS.length).setValues([[endpoint, name, slug_(name), email, at, at, '', '']]);
    }
    return { ok: true };
  });
}
function remindLeave_(b) {
  var endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
  return withLock_(function () {
    var sheet = remindSheet_(open_(), false), row = sheet && endpoint ? remindRowOf_(sheet, endpoint) : 0;
    if (row) sheet.deleteRow(row);
    return { ok: true };
  });
}
function remindStatus_(b) {
  var endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
  var sheet = remindSheet_(open_(), false);
  return { ok: true, on: !!(sheet && endpoint && remindRowOf_(sheet, endpoint)) };
}

/* ---------- sending ---------- */
function shouldRemind_(day) { return REMIND_DAYS.indexOf(day) >= 0; }
function remindParts_(date) {                             // today in Malaysia, whatever time zone the script itself is set to
  var s = Utilities.formatDate(date, REMIND_TZ, 'yyyy-MM-dd').split('-');
  return { y: +s[0], m: +s[1], d: +s[2] };
}
function targetMonth_(parts) {                            // the month before (parts = { y, m }), as 2026-10
  var y = parts.y, m = parts.m - 1;
  if (m < 1) { m = 12; y--; }
  return y + '-' + (m < 10 ? '0' : '') + m;
}
/* the people still to be reminded: whoever has no claim for `month` (isClaimed gets the claim id 2026-10_chin-zhi-liang; people are matched by slug_(name) only) */
function subscribersToRemind_(subs, month, isClaimed) {
  return subs.filter(function (s) { return !isClaimed(month + '_' + slug_(s.name)); });
}
/* has this claim id been sent (or started to be sent)? The id column is read once, only the rows that exist are opened */
function claimedCheck_(db) {
  var ids = Object.create(null), last = db.sheet.getLastRow();
  if (last >= 2) db.sheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { ids[r[0]] = 1; });
  return function (id) {
    if (ids[id] !== 1) return false;
    var rec = getRec_(db, id);
    return !!(rec && (rec.published || rec.pending));
  };
}
/* one push with no text; returns the push service's HTTP status */
function sendPush_(endpoint, cache) {
  var res = UrlFetchApp.fetch(endpoint, { method: 'post', muteHttpExceptions: true,
    headers: { 'TTL': '86400', 'Urgency': 'normal', 'Authorization': buildVapidHeader_(endpoint, Math.floor(Date.now() / 1000), cache) } });
  return res.getResponseCode();
}
/* write down what happened (under the lock, finding each row again by its address: rows move when people join or leave in the meantime) */
function remindSave_(db, results) {
  if (!results.length) return 0;
  return withLock_(function () {
    var sheet = remindSheet_(db, false), last = sheet ? sheet.getLastRow() : 0, removed = 0;
    if (last < 2) return 0;
    var eps = sheet.getRange(2, 1, last - 1, 1).getValues(), tail = sheet.getRange(2, 7, last - 1, 2).getValues(), byEp = Object.create(null), gone = [];
    results.forEach(function (r) { byEp[r.endpoint] = r; });
    for (var i = 0; i < eps.length; i++) {
      var r = byEp[eps[i][0]];
      if (!r) continue;
      if (r.code === 404 || r.code === 410) gone.push(i + 2);          // the phone or browser has switched notifications off for good
      else tail[i] = [r.at, r.code];
    }
    sheet.getRange(2, 7, last - 1, 2).setValues(tail);
    gone.reverse().forEach(function (row) { sheet.deleteRow(row); removed++; });
    return removed;
  });
}
/* the whole job; `force` (remindNow) ignores the day and the "already claimed" check */
function remindRun_(now, force) {
  var parts = remindParts_(now), month = targetMonth_(parts);
  var summary = { day: parts.d, month: month, subscribers: 0, due: 0, sent: 0, ok: 0, failed: 0, removed: 0, notReached: 0 };
  if (!force && !shouldRemind_(parts.d)) { console.log('Reminders: the ' + parts.d + ' is not a reminder day (' + REMIND_DAYS.join(', ') + '), nothing sent.'); return summary; }
  var db = open_(), subs = readSubscribers_(remindSheet_(db, false));
  var due = force ? subs : subscribersToRemind_(subs, month, claimedCheck_(db));
  summary.subscribers = subs.length; summary.due = due.length;
  if (due.length) {
    var cache = {}, started = Date.now(), results = [];
    for (var i = 0; i < due.length; i++) {
      if (Date.now() - started >= REMIND_BUDGET_MS) { summary.notReached = due.length - i; break; }
      var code;
      try {
        if (!pushEndpointOk_(due[i].endpoint)) throw new Error('not a push address');           // the sheet may have been edited by hand
        code = sendPush_(due[i].endpoint, cache);
      } catch (e) { code = 'error: ' + str_(e && e.message, 60); }
      results.push({ endpoint: due[i].endpoint, code: code, at: new Date().toISOString() });
      summary.sent++;
      if (code >= 200 && code < 300) summary.ok++; else if (code !== 404 && code !== 410) summary.failed++;
    }
    summary.removed = remindSave_(db, results);
  }
  console.log('Reminders for ' + month + ': ' + summary.subscribers + ' on the list, ' + summary.due + ' to remind, ' + summary.sent + ' sent (' + summary.ok + ' accepted, ' +
    summary.failed + ' failed, ' + summary.removed + ' removed as gone)' + (summary.notReached ? ', ' + summary.notReached + ' not reached before the time ran out' : '') + '.');
  return summary;
}

/* The time trigger's job: on a reminder day, ping everyone who has not sent last month's claim yet. */
function remindDaily() { return remindRun_(new Date(), false); }
/* For testing by hand (editor: pick remindNow, Run): pings everyone on the list now, claimed or not, on any day. */
function remindNow() {
  var s = remindRun_(new Date(), true);
  console.log('remindNow: ' + s.sent + ' reminder(s) sent to ' + s.subscribers + ' on the list.');
  return s;
}
/* Run once from the editor (pick setupReminders, Run): a daily trigger at 9am Malaysia time (Google runs it some time between 9 and 10). */
function setupReminders() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'remindDaily') { ScriptApp.deleteTrigger(t); removed++; }
  });
  ScriptApp.newTrigger('remindDaily').timeBased().everyDays(1).atHour(9).inTimezone(REMIND_TZ).create();
  vapidKeys_();                                           // the sender's key pair exists from now on
  console.log('setupReminders: ' + (removed ? 'replaced ' + removed + ' old trigger(s) with' : 'made') + ' one daily trigger for remindDaily at 09:00 ' + REMIND_TZ +
    '. It sends on the ' + REMIND_DAYS.join(', ') + ' of each month.');
}
