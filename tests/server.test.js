/* node tests/server.test.js - the local inbox, over real HTTP */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../server/server');
const { runProtocol, runAuth } = require('./protocol');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-claims-test-'));
  const srv = await start({ port: 0, dataDir, quiet: true });
  try {
    const api = {
      async get(q) { const r = await fetch(srv.url + '/api?' + new URLSearchParams(q)); return r.json(); },
      async post(b) { const r = await fetch(srv.url + '/api', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(b) }); return r.json(); },
    };
    await runProtocol(api, (s) => console.log('  ok  ' + s));

    // the browser rules: any site may call it, including the pre-flight check
    const pre = await fetch(srv.url + '/api', { method: 'OPTIONS', headers: { Origin: 'https://zzllchen.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } });
    assert.strictEqual(pre.status, 204);
    assert.strictEqual(pre.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(pre.headers.get('access-control-allow-private-network'), 'true');
    const g = await fetch(srv.url + '/api?action=ping');
    assert.strictEqual(g.headers.get('access-control-allow-origin'), '*');
    console.log('  ok  browser (CORS) headers');

    // only the page is served - never the data or the server code
    for (const p of ['/data/x', '/server/server.js', '/tests/protocol.js', '/backend/Code.gs', '/..%2f..%2fWindows/win.ini', '/css/../server/server.js', '/package.json']) {
      const r = await fetch(srv.url + p);
      assert.strictEqual(r.status, 404, p + ' must not be served, got ' + r.status);
    }
    if (fs.existsSync(path.join(__dirname, '..', 'index.html'))) {
      const r = await fetch(srv.url + '/');
      assert.strictEqual(r.status, 200); assert.ok((await r.text()).includes('<html'));
    }
    console.log('  ok  only the page is served');

    // a body that is not JSON
    const bad = await fetch(srv.url + '/api', { method: 'POST', body: 'not json' });
    assert.strictEqual(bad.status, 400);
    console.log('server tests passed');

    // the same inbox started with a password
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-claims-test-pw-'));
    const locked = await start({ port: 0, dataDir: dir2, quiet: true, password: 'Correct Horse 42' });
    try {
      const api2 = {
        async get(q) { const r = await fetch(locked.url + '/api?' + new URLSearchParams(q)); return r.json(); },
        async post(b) { const r = await fetch(locked.url + '/api', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(b) }); return r.json(); },
      };
      await runAuth(api2, 'Correct Horse 42', (s) => console.log('  ok  password: ' + s));
    } finally { await locked.close(); fs.rmSync(dir2, { recursive: true, force: true }); }
    console.log('server password tests passed');
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
