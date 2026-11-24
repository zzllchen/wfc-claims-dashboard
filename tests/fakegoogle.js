/* A stand-in for the Google services backend/Code.gs uses (Sheets, Drive, Properties, Lock, Utilities, triggers), shared by the Apps Script tests. */
'use strict';
const crypto = require('crypto');

function fakeGoogle() {
  const props = {};
  const sheets = new Map(), folders = new Map(), files = new Map();
  let n = 0;
  const nextId = (p) => p + (++n) + crypto.randomBytes(3).toString('hex');

  function makeSheet() {
    const rows = [];       // rows[r][c], 0-based
    let hidden = [];
    const sheet = {
      rows, _hidden: () => hidden,
      setName(n) { sheet._name = n; return sheet; }, setFrozenRows() { return sheet; }, hideColumns(c) { hidden.push(c); return sheet; },
      getLastRow() { let l = 0; rows.forEach((r, i) => { if (r && r.some((v) => v !== '' && v != null)) l = i + 1; }); return l; },
      getRange(r, c, nr = 1, nc = 1) {
        const rg = {
          setValues(v) { v.forEach((row, i) => row.forEach((val, j) => { rows[r - 1 + i] = rows[r - 1 + i] || []; rows[r - 1 + i][c - 1 + j] = val; })); return rg; },
          getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((rows[r - 1 + i] || [])[c - 1 + j]) ?? ''); out.push(row); } return out; },
          getValue() { return rg.getValues()[0][0]; },
          setFontWeight() { return rg; },
        };
        return rg;
      },
      deleteRow(r) { rows.splice(r - 1, 1); },
    };
    return sheet;
  }
  function makeFolder(name) {
    const id = nextId('folder'); const f = { id, name, trashed: false, files: [] };
    folders.set(id, f);
    return folderApi(f);
  }
  function folderApi(f) {
    const api = {
      getId: () => f.id,
      createFolder: (nm) => makeFolder(nm),
      createFile(blob) {
        const fid = nextId('file'); const rec = { id: fid, name: blob.getName(), bytes: blob.getBytes(), mime: blob.getContentType(), description: '', created: new Date(Date.now() + n) };
        files.set(fid, rec); f.files.push(rec);
        return fileApi(rec);
      },
      getFiles() { let i = 0; const list = f.files.slice(); return { hasNext: () => i < list.length, next: () => fileApi(list[i++]) }; },
      setTrashed(t) { f.trashed = t; return api; },
    };
    return api;
  }
  const fileApi = (rec) => ({
    getId: () => rec.id, getName: () => rec.name, getMimeType: () => rec.mime, getSize: () => rec.bytes.length,
    getDescription: () => rec.description, setDescription(d) { rec.description = d; return this; },
    getDateCreated: () => rec.created, getBlob: () => ({ getBytes: () => rec.bytes }),
  });

  // a spreadsheet can have several sheets (the inbox keeps claims on "Claims" and leave on "Leave")
  const book = (id, x) => ({
    getId: () => id, getSheets: () => x.list.slice(),
    getSheetByName: (nm) => x.list.find((sh) => (sh._name || x.names.get(sh)) === nm) || null,
    insertSheet(nm, at) { const sh = makeSheet(); x.names.set(sh, nm); sh._name = nm; x.list.splice(at == null ? x.list.length : at, 0, sh); return sh; },
  });
  const fetches = [], triggers = [];
  let responder = null;
  const asBuffer = (v) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(Array.from(v).map((b) => b & 255)));
  const signed = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
  const OK_BODY = JSON.stringify({ content: [{ type: 'text', text: '{"isReceipt":true,"amount":60}' }], stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 80 }, model: 'claude-sonnet-5-5', id: 'msg_x' });
  const G = {
    UrlFetchApp: {
      fetch(url, opts) {
        const payload = opts.payload == null ? null : JSON.parse(opts.payload);
        fetches.push({ url, opts, payload });
        const r = responder ? responder(fetches.length, payload) : { code: 200, body: OK_BODY };
        return { getResponseCode: () => r.code, getContentText: () => r.body };
      },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ getContent: () => s, setMimeType() { return this; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')).map((b) => (b > 127 ? b - 256 : b)),      // Google gives signed bytes
      base64Encode: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString('base64'),
      newBlob: (bytes, mime, name) => ({ getBytes: () => bytes, getContentType: () => mime, getName: () => name }),
      sleep: () => {},
      // text or a list of bytes (signed or not) in; Google gives signed bytes back
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (alg, v) => { if (alg !== 'SHA_256') throw new Error('only SHA_256 is faked'); return signed(crypto.createHash('sha256').update(asBuffer(v)).digest()); },
      computeHmacSha256Signature: (v, key) => signed(crypto.createHmac('sha256', asBuffer(key)).update(asBuffer(v)).digest()),
      formatDate(date, tz, fmt) {
        const p = {};
        new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
          .formatToParts(date).forEach((x) => { p[x.type] = x.value; });
        const w = { yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second, d: String(+p.day), M: String(+p.month) };
        return fmt.replace(/yyyy|MM|dd|HH|mm|ss|d|M/g, (t) => w[t]);
      },
    },
    // time triggers: ScriptApp.newTrigger(fn).timeBased().everyDays(n).atHour(h).inTimezone(tz).create(); the made ones are in `triggers`
    ScriptApp: {
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.handler, getUniqueId: () => t.id })),
      deleteTrigger(t) { const i = triggers.findIndex((x) => x.id === t.getUniqueId()); if (i < 0) throw new Error('no such trigger'); triggers.splice(i, 1); },
      newTrigger(handler) {
        const t = { id: 'trigger' + (++n), handler };
        const clock = { everyDays(d) { t.everyDays = d; return clock; }, atHour(h) { t.atHour = h; return clock; }, inTimezone(z) { t.timezone = z; return clock; }, create() { triggers.push(t); return { getUniqueId: () => t.id }; } };
        return { timeBased() { t.kind = 'time'; return clock; } };
      },
    },
    SpreadsheetApp: {
      create(name) { const id = nextId('sheet'); const first = makeSheet(); const x = { name, list: [first], names: new Map([[first, 'Sheet1']]) }; sheets.set(id, x); return book(id, x); },
      openById(id) { const x = sheets.get(id); if (!x) throw new Error('no sheet'); return book(id, x); },
    },
    DriveApp: {
      createFolder: (name) => makeFolder(name),
      getFolderById(id) { const f = folders.get(id); if (!f) throw new Error('no folder'); return folderApi(f); },
      getFileById(id) { const r = files.get(id); if (!r) throw new Error('no file'); return fileApi(r); },
    },
  };
  return { G, props, sheets, folders, files, fetches, triggers, respond: (f) => { responder = f; } };
}

module.exports = { fakeGoogle };
