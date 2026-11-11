/* node tests/appsscript.test.js - runs backend/Code.gs against a stand-in for Google (Sheets, Drive, Properties, Lock).
   It proves the logic and that Code.gs gives the same answers as the local inbox. It cannot prove Google itself accepts the script:
   that is only known after the first real deploy (see README, "Put it online"). */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runProtocol, runAuth } = require('./protocol');

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
      setName() { return sheet; }, setFrozenRows() { return sheet; }, hideColumns(c) { hidden.push(c); return sheet; },
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

  const G = {
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ getContent: () => s, setMimeType() { return this; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')).map((b) => (b > 127 ? b - 256 : b)),      // Google gives signed bytes
      base64Encode: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString('base64'),
      newBlob: (bytes, mime, name) => ({ getBytes: () => bytes, getContentType: () => mime, getName: () => name }),
      sleep: () => {},
    },
    SpreadsheetApp: {
      create(name) { const id = nextId('sheet'); const s = makeSheet(); sheets.set(id, { name, sheet: s }); return { getId: () => id, getSheets: () => [s] }; },
      openById(id) { const x = sheets.get(id); if (!x) throw new Error('no sheet'); return { getId: () => id, getSheets: () => [x.sheet] }; },
    },
    DriveApp: {
      createFolder: (name) => makeFolder(name),
      getFolderById(id) { const f = folders.get(id); if (!f) throw new Error('no folder'); return folderApi(f); },
      getFileById(id) { const r = files.get(id); if (!r) throw new Error('no file'); return fileApi(r); },
    },
  };
  return { G, props, sheets, folders, files };
}

(async () => {
  const fake = fakeGoogle();
  const sandbox = Object.assign({ console }, fake.G);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });

  const api = {
    async get(q) { return JSON.parse(sandbox.doGet({ parameter: q }).getContent()); },
    async post(b) { return JSON.parse(sandbox.doPost({ parameter: {}, postData: { contents: JSON.stringify(b) } }).getContent()); },
  };
  await runProtocol(api, (s) => console.log('  ok  ' + s));

  // things only the Google version has
  assert.ok(fake.props.SHEET_ID && fake.props.FOLDER_ID, 'the sheet and the folder were created on first use');
  const trashed = Array.from(fake.folders.values()).filter((f) => f.trashed).length;
  assert.ok(trashed >= 3, 'replaced and deleted claims go to the Drive bin (got ' + trashed + ')');
  const bad = JSON.parse(sandbox.doPost({ parameter: {}, postData: { contents: 'nope' } }).getContent());
  assert.strictEqual(bad.ok, false);
  console.log('  ok  sheet + folder made on first use, old versions go to the bin');

  // the same inbox once the password (script property DASH_KEY) is set
  fake.props.DASH_KEY = 'Correct Horse 42';
  await runAuth(api, 'Correct Horse 42', (s) => console.log('  ok  password: ' + s));
  console.log('Apps Script tests passed');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
