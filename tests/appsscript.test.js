/* node tests/appsscript.test.js - runs backend/Code.gs against a stand-in for Google (Sheets, Drive, Properties, Lock).
   It proves the logic and that Code.gs gives the same answers as the local inbox. It cannot prove Google itself accepts the script:
   that is only known after the first real deploy (see README, "Put it online"). */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runProtocol, runAuth, runLeave } = require('./protocol');

const { fakeGoogle } = require('./fakegoogle');

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
  await runLeave(api, (s) => console.log('  ok  ' + s));
  const pinged = await api.get({ action: 'ping' });
  assert.strictEqual(pinged.version, 7, 'the script is version 7 (monthly reminders)');
  assert.strictEqual(pinged.remind, true, 'ping says reminders are understood');
  assert.strictEqual((await api.get({ action: 'remind', op: 'key' })).ok, false, 'reminders are a change: POST only');
  console.log('  ok  ping: version 7, remind: true (the reminders themselves are in tests/remind.test.js)');

  // things only the Google version has
  assert.ok(fake.props.SHEET_ID && fake.props.FOLDER_ID, 'the sheet and the folder were created on first use');
  const trashed = Array.from(fake.folders.values()).filter((f) => f.trashed).length;
  assert.ok(trashed >= 3, 'replaced and deleted claims go to the Drive bin (got ' + trashed + ')');
  const bad = JSON.parse(sandbox.doPost({ parameter: {}, postData: { contents: 'nope' } }).getContent());
  assert.strictEqual(bad.ok, false);
  const book1 = fake.sheets.get(fake.props.SHEET_ID);
  assert.deepStrictEqual(book1.list.map((sh) => sh._name || book1.names.get(sh)), ['Claims', 'Scan log', 'Leave'], 'claims and leave each have their own sheet (and corrections to the scanner a Scan log)');
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

  // ---- Ask Flow: questions about the claims, from the dashboard only (it reads company data) ----
  const PW = fake.props.DASH_KEY;
  const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
  const askReq = (over) => Object.assign({ system: 'You answer questions about expense claims.', max_tokens: 9000, output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } }, model: 'claude-haiku-5-5',
    messages: [{ role: 'user', content: 'Question: how much fuel in October?\nData: ...' }] }, over);
  const askFlow = (over, key) => api.post({ action: 'ask', key: key === undefined ? PW : key, request: askReq(over) });
  assert.strictEqual((await api.get({ action: 'ping' })).ask, true, 'ping says Ask Flow is on');
  const a0 = fake.fetches.length;
  refused(await askFlow({}, ''), 401, 'Ask Flow without the password');
  refused(await askFlow({}, 'wrong'), 401, 'Ask Flow with a wrong password');
  assert.strictEqual(fake.fetches.length, a0, 'nothing reaches Anthropic without the password');
  fake.respond(() => ({ code: 200, body: JSON.stringify({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"answer":"RM 718.91"}' }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 40 }, model: 'claude-opus-5-5', id: 'msg_y' }) }));
  const asked = await askFlow();
  assert.strictEqual(asked.ok, true, JSON.stringify(asked).slice(0, 200));
  assert.strictEqual(asked.reply.content[1].text, '{"answer":"RM 718.91"}');
  assert.ok(!JSON.stringify(asked).includes('msg_y'));
  const q = fake.fetches[fake.fetches.length - 1];
  assert.strictEqual(q.payload.model, 'claude-opus-5-5', 'the model is fixed on the server');
  assert.strictEqual(q.payload.max_tokens, 3000, 'the answer length is capped');
  assert.deepStrictEqual(q.payload.output_config, { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } });
  assert.strictEqual(q.payload.fallbacks, 'default'); assert.strictEqual(q.opts.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.strictEqual(q.payload.messages[0].content, 'Question: how much fuel in October?\nData: ...');
  console.log('  ok  Ask Flow: password needed, model and length fixed, structured answer passed on');

  const a1 = fake.fetches.length;
  refused(await askFlow({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo } }] }] }), 400, 'a photo');
  refused(await askFlow({ messages: [{ role: 'user', content: 'x'.repeat(60001) }] }), 400, 'too much data');
  refused(await askFlow({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }), 400, 'a conversation');
  refused(await askFlow({ system: '' }), 400, 'no instructions');
  refused(await askFlow({ output_config: { format: { type: 'text' } } }), 400, 'an odd format');
  assert.strictEqual(fake.fetches.length, a1, 'none of those reached Anthropic');
  console.log('  ok  Ask Flow: one plain-text question at a time');

  // an older Anthropic setup that does not know "fallbacks": asked again without it
  const a2 = fake.fetches.length;
  fake.respond((n, payload) => (payload.fallbacks ? { code: 400, body: JSON.stringify({ error: { message: 'fallbacks: Extra inputs are not permitted' } }) } : { code: 200, body: JSON.stringify({ content: [{ type: 'text', text: '{"answer":"ok"}' }], stop_reason: 'end_turn', usage: {}, model: 'claude-opus-5-5' }) }));
  assert.strictEqual((await askFlow()).ok, true);
  assert.strictEqual(fake.fetches.length - a2, 2); assert.ok(!('fallbacks' in fake.fetches[fake.fetches.length - 1].payload)); assert.ok(!fake.fetches[fake.fetches.length - 1].opts.headers['anthropic-beta']);
  // its own daily cap, separate from the receipt reader's
  fake.respond(null); fake.props.ASK_DAILY_CAP = '1'; delete fake.props.ASK_DAY;
  assert.strictEqual((await askFlow()).ok, true); refused(await askFlow(), 429, 'over the Ask Flow cap');
  delete fake.props.ASK_DAILY_CAP; delete fake.props.ASK_DAY;
  console.log('  ok  Ask Flow: retries without fallbacks, has its own daily cap');

  // the receipt scanner: 1-3 pages or one PDF, one of two models, its own cap, no password needed
  const scanReq = (over) => Object.assign({ model: 'claude-opus-5-5', max_tokens: 9000, system: 'Read this receipt.', output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
    messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } }, { type: 'text', text: 'Text read on the PC: TOTAL 10.00' }] }] }, over);
  const scan = (over) => api.post({ action: 'scan', request: scanReq(over) });
  fake.respond(null);
  const s0 = fake.fetches.length;
  const sc = await scan();
  assert.strictEqual(sc.ok, true, JSON.stringify(sc).slice(0, 200));
  const sp = fake.fetches[fake.fetches.length - 1].payload;
  assert.strictEqual(sp.model, 'claude-opus-5-5', 'one of the two allowed models');
  assert.strictEqual(sp.max_tokens, 2500, 'the answer length is capped');
  assert.deepStrictEqual(sp.output_config, { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } });
  assert.strictEqual((await scan({ model: 'claude-mythos-9' })).ok, true);
  assert.strictEqual(fake.fetches[fake.fetches.length - 1].payload.model, 'claude-sonnet-5-5', 'any other model falls back to the default');
  const pg = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: photo } };
  assert.strictEqual((await scan({ messages: [{ role: 'user', content: [pg, pg, pg] }] })).ok, true, 'three page images');
  const s1 = fake.fetches.length;
  refused(await scan({ messages: [{ role: 'user', content: [pg, pg, pg, pg] }] }), 400, 'four pages');
  refused(await scan({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }), 400, 'no page at all');
  refused(await scan({ messages: [{ role: 'user', content: [pg, scanReq().messages[0].content[0]] }] }), 400, 'pages and a PDF together');
  refused(await scan({ system: '' }), 400, 'no instructions');
  refused(await scan({ messages: [{ role: 'user', content: [pg] }, { role: 'assistant', content: 'x' }] }), 400, 'a conversation');
  assert.strictEqual(fake.fetches.length, s1, 'none of those reached Anthropic');
  fake.props.SCAN_DAILY_CAP = '1'; delete fake.props.SCAN_DAY;
  assert.strictEqual((await scan()).ok, true); refused(await scan(), 429, 'over the scanner cap');
  delete fake.props.SCAN_DAILY_CAP; delete fake.props.SCAN_DAY;
  assert.ok(s0 < fake.fetches.length);
  console.log('  ok  receipt scanner: pages or a PDF, two allowed models, capped, its own daily cap');

  console.log('Apps Script tests passed');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
