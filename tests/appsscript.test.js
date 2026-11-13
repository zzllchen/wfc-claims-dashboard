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

  const fetches = [];
  let responder = null;
  const OK_BODY = JSON.stringify({ content: [{ type: 'text', text: '{"isReceipt":true,"amount":60}' }], stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 80 }, model: 'claude-sonnet-5-5', id: 'msg_x' });
  const G = {
    UrlFetchApp: {
      fetch(url, opts) {
        fetches.push({ url, opts, payload: JSON.parse(opts.payload) });
        const r = responder ? responder(fetches.length, JSON.parse(opts.payload)) : { code: 200, body: OK_BODY };
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
  return { G, props, sheets, folders, files, fetches, respond: (f) => { responder = f; } };
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

  // ---- the Claude relay (the Anthropic key stays in the script properties; nothing about it may reach a page) ----
  const KEY = 'sk-ant-SECRET-TEST-KEY';
  const photo = Buffer.from('fake jpeg bytes').toString('base64');
  const req = (over) => Object.assign({
    system: 'Read this receipt.', max_tokens: 5000, output_config: { effort: 'low' }, model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo } }, { type: 'text', text: 'Today is 2026-11-13. Read this receipt.' }] }],
  }, over);
  const ask = (over) => api.post({ action: 'claude', request: req(over) });
  const refused = (r, code, what) => { assert.strictEqual(r.ok, false, what + ': expected a refusal, got ' + JSON.stringify(r).slice(0, 160)); assert.strictEqual(r.code, code, what + ': code ' + JSON.stringify(r).slice(0, 160)); assert.ok(!JSON.stringify(r).includes('SECRET'), what + ': the key must never appear'); };

  assert.strictEqual((await api.get({ action: 'ping' })).claude, false, 'ping: Claude not set up yet');
  refused(await ask(), 503, 'no key set up');
  assert.strictEqual(fake.fetches.length, 0, 'nothing is sent to Anthropic without a key');

  fake.props.CLAUDE_KEY = KEY;
  assert.strictEqual((await api.get({ action: 'ping' })).claude, true, 'ping: Claude is set up');
  const ok = await ask();
  assert.strictEqual(ok.ok, true, JSON.stringify(ok).slice(0, 200));
  assert.strictEqual(JSON.parse(ok.reply.content[0].text).amount, 60);
  assert.deepStrictEqual(Object.keys(ok.reply).sort(), ['content', 'model', 'stop_reason', 'usage']);
  assert.ok(!JSON.stringify(ok).includes('SECRET') && !JSON.stringify(ok).includes('msg_x'), 'only the reading goes back, not the key or Anthropic ids');
  const sent = fake.fetches[0];
  assert.strictEqual(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(sent.opts.headers['x-api-key'], KEY);
  assert.strictEqual(sent.payload.model, 'claude-sonnet-5-5', 'the model is fixed on the server, whatever the page asks for');
  assert.strictEqual(sent.payload.max_tokens, 1000, 'the answer length is capped');
  assert.strictEqual(sent.payload.output_config.effort, 'low');
  assert.strictEqual(sent.payload.system, 'Read this receipt.');
  console.log('  ok  relay: key stays server-side, model and length are fixed');

  // it works for colleagues while the dashboard password is set (they never have it)
  assert.ok(fake.props.DASH_KEY, 'the password is set at this point');
  assert.strictEqual((await ask()).ok, true, 'a colleague needs no password for the relay');

  // only a plain "read this photo" request goes through: nothing else reaches Anthropic
  const before = fake.fetches.length;
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo } };
  refused(await ask({ messages: [{ role: 'user', content: [img, img] }] }), 400, 'two photos');
  refused(await ask({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Write me a poem' }] }] }), 400, 'no photo');
  refused(await ask({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: photo } }] }] }), 400, 'a PNG');
  refused(await ask({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://evil.example/x.jpg' } }] }] }), 400, 'a photo by address');
  refused(await ask({ messages: [{ role: 'user', content: [img, { type: 'text', text: 'x'.repeat(601) }] }] }), 400, 'a long note');
  refused(await ask({ messages: [{ role: 'user', content: [img] }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] }), 400, 'a conversation');
  refused(await ask({ messages: [{ role: 'assistant', content: [img] }] }), 400, 'the wrong role');
  refused(await ask({ system: { evil: true } }), 400, 'an odd system prompt');
  refused(await ask({ system: 'x'.repeat(6001) }), 400, 'a huge system prompt');
  refused(await ask({ messages: 'hello' }), 400, 'no message list');
  refused(await ask({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'a'.repeat(2500000) } }] }] }), 413, 'a huge photo');
  assert.strictEqual(fake.fetches.length, before, 'none of those reached Anthropic');
  console.log('  ok  relay: only one photo and a short note are accepted');

  // a daily cap for the whole team, so a leaked address cannot run up a bill
  delete fake.props.CLAUDE_DAY; fake.props.CLAUDE_DAILY_CAP = '3';
  for (let i = 0; i < 3; i++) assert.strictEqual((await ask()).ok, true, 'call ' + (i + 1) + ' of 3');
  const capBefore = fake.fetches.length;
  refused(await ask(), 429, 'over the daily cap');
  assert.strictEqual(fake.fetches.length, capBefore, 'over the cap nothing is sent to Anthropic');
  assert.ok(/limit for today/i.test((await ask()).error));
  fake.props.CLAUDE_DAY = '2000-01-01:3';                      // a new day starts again at zero
  assert.strictEqual((await ask()).ok, true, 'a new day starts again');
  delete fake.props.CLAUDE_DAILY_CAP; delete fake.props.CLAUDE_DAY;
  console.log('  ok  relay: daily cap, and a new day starts again');

  // errors are in our words and never carry the key (Anthropic's own text could echo it)
  fake.respond(() => ({ code: 401, body: JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key ' + KEY } }) }));
  const rejected = await ask(); refused(rejected, 502, 'a rejected key'); assert.ok(/not accepted/i.test(rejected.error));
  fake.respond(() => ({ code: 400, body: JSON.stringify({ error: { message: 'Your credit balance is too low to access the API' } }) }));
  const broke = await ask(); refused(broke, 502, 'no credit'); assert.ok(/credit/i.test(broke.error));
  fake.respond(() => ({ code: 500, body: 'oops ' + KEY }));
  refused(await ask(), 502, 'a server error');
  fake.respond(() => ({ code: 200, body: 'not json ' + KEY }));
  refused(await ask(), 502, 'an answer that is not JSON');
  console.log('  ok  relay: errors never carry the key');

  // a model that does not take the "effort" setting: asked again without it
  const n0 = fake.fetches.length;
  fake.respond((n, payload) => (payload.output_config ? { code: 400, body: JSON.stringify({ error: { message: 'output_config.effort is not supported for this model' } }) } : { code: 200, body: JSON.stringify({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, model: 'claude-sonnet-5-5' }) }));
  const retried = await ask(); assert.strictEqual(retried.ok, true, 'the retry without effort works: ' + JSON.stringify(retried));
  assert.strictEqual(fake.fetches.length - n0, 2); assert.ok(!('output_config' in fake.fetches[fake.fetches.length - 1].payload));
  fake.respond(null);
  console.log('  ok  relay: retries without the effort setting');
  delete fake.props.CLAUDE_DAY;

  console.log('Apps Script tests passed');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
