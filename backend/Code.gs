/* WFC Claims inbox - the Google version (Google Apps Script web app).

   What it does: the Claim Builder posts a saved claim here, the dashboard reads it. Same actions and answers as
   server/server.js (the local version), so the two pages work with either.

   Where things are kept (all in the Google account that deploys this script, created on first use):
     - a Google Sheet "WFC Claims"          one row per claim (handy for Agnes to open too)
     - a Drive folder "WFC Claims files"    one sub-folder per claim, holding the claim form, receipts, TNG statement
   Nothing else is stored, and nothing leaves that Google account.

   No login yet (on purpose, for the demo): anyone who has the web app address can read and add claims.
   The setup steps are in README.md, "Put it online (Google)". */

var VERSION = 1;
var MAX_LINES = 60;                                   // the claim form has 35 rows
var MAX_FILE = 8 * 1024 * 1024;                      // bytes per file (Apps Script copes with about this much per request)
var STATUSES = ['new', 'checked', 'paid', 'question'];
var STATUS_WORD = { 'new': 'New', 'checked': 'Checked', 'paid': 'Paid', 'question': 'Has a question' };
var KINDS = ['form-pdf', 'form-xlsx', 'tng', 'tollcheck', 'receipt', 'other'];
var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
var MIME = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', zip: 'application/zip' };
var COLS = ['id', 'claimant', 'month', 'total', 'status', 'updated', 'record'];

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
    var known = { ping: ping_, list: list_, file: file_, submit: submit_, upload: upload_, finish: finish_, status: status_, 'delete': delete_ };
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
var OPEN_ACTIONS = { ping: 1, submit: 1, upload: 1, finish: 1 };
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
function okId_(id) { return /^\d{4}-\d{2}_[a-z0-9-]{1,40}$/.test(String(id || '')); }
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
    lines.push({ no: i + 1, category: str_(l.category, 40), date: /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? l.date : '', name: str_(l.name, 120), receiptNo: str_(l.receiptNo, 60), amount: amount });
  }
  if (!lines.length) throw fail_('The claim has no lines.');
  return { claimant: claimant, month: month, monthLabel: monthLabel_(month), total: round2_(total), lines: lines,
    from: emailOf_(c.from), to: emailOf_(c.to), subject: str_(c.subject, 160) };
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
  return { sheet: ss.getSheets()[0], folder: folder };
}

function rowOf_(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return 0;
}

function getRec_(db, id) {
  if (!okId_(id)) return null;
  var row = rowOf_(db.sheet, id);
  if (!row) return null;
  try { return JSON.parse(db.sheet.getRange(row, COLS.length).getValue()); } catch (e) { return null; }
}

function putRec_(db, rec) {
  var p = rec.published;
  if (p && p.history.length > 50) p.history = p.history.slice(-50);
  var json = JSON.stringify(rec);
  if (json.length > 45000) throw fail_('This claim is too big to store.', 413);       // a Google Sheets cell holds 50,000 characters
  var row = rowOf_(db.sheet, rec.id) || db.sheet.getLastRow() + 1;
  db.sheet.getRange(row, 1, 1, COLS.length).setValues([[rec.id, p ? p.claimant : rec.pending.claim.claimant, p ? p.month : rec.pending.claim.month,
    p ? p.total : '', p ? p.status : 'uploading', p ? p.updatedAt : '', json]]);
}

function trash_(folderId) {
  if (!folderId) return;
  try { DriveApp.getFolderById(folderId).setTrashed(true); } catch (e) { /* already gone */ }
}

/* ---------- actions ---------- */
function ping_() { return { ok: true, service: 'wfc-claims', version: VERSION, where: 'google', auth: passwordSet_() }; }

function list_() {
  var db = open_(), last = db.sheet.getLastRow(), claims = [];
  if (last >= 2) {
    db.sheet.getRange(2, COLS.length, last - 1, 1).getValues().forEach(function (r) {
      try { var c = publicClaim_(JSON.parse(r[0])); if (c) claims.push(c); } catch (e) { /* a row that is not ours */ }
    });
  }
  claims.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
  return { ok: true, claims: claims };
}

function file_(q) {
  var db = open_(), rec = getRec_(db, q.id), p = rec && rec.published, f = null;
  if (p) (p.files || []).forEach(function (x) { if (x.id === q.file) f = x; });
  if (!f) throw fail_('That file is not there.', 404);
  var blob = DriveApp.getFileById(f.driveId).getBlob();
  return { ok: true, name: f.name, mime: f.mime, size: f.size, data: Utilities.base64Encode(blob.getBytes()) };
}

function submit_(b) {
  var claim = cleanClaim_(b.claim), db = open_();
  var id = claim.month + '_' + slug_(claim.claimant);
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
  return { ok: true, id: rec.id, version: version, files: files.length };
}

function status_(b) {
  var db = open_(), rec = getRec_(db, b.id), p = rec && rec.published;
  if (!p) throw fail_('That claim is not there.', 404);
  var status = b.status == null ? p.status : String(b.status);
  if (STATUSES.indexOf(status) < 0) throw fail_('Unknown status.');
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
  db.sheet.deleteRow(rowOf_(db.sheet, rec.id));
  return { ok: true };
}
