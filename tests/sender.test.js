/* node tests/sender.test.js - the Claim Builder's own sender (js/accounts.js) talking to the real local inbox over HTTP.
   Skipped when the Claim Builder folder is not next to this one. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../server/server');

const senderPath = path.join(__dirname, '..', '..', 'WFC Claim Builder', 'js', 'accounts.js');
if (!fs.existsSync(senderPath)) { console.log('skipped: the Claim Builder folder is not next to this one'); process.exit(0); }
const Accounts = require(senderPath);

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfc-sender-test-'));
  const srv = await start({ port: 0, dataDir, quiet: true });
  try {
    const api = srv.url + '/api';
    const claim = { claimant: 'Chin Zhi Liang', month: '2026-10', from: 'edward.wfcsystems@gmail.com', to: 'agnes@yutech.com.my', subject: 'Claim - October 2026',
      lines: [{ category: 'Petrol', date: '2026-10-05', name: 'Kejayaan Teguh', receiptNo: 'a1b2c3', amount: 60 }, { category: 'Toll', date: '2026-10-31', name: "Touch 'n Go", receiptNo: '1130739887', amount: 27.4 }] };
    const photo = new Uint8Array(300000).map((_, i) => (i * 7) % 256);        // a binary "photo", to prove the bytes arrive unchanged
    const files = [
      { name: 'WFC - OCT Claim form.pdf', data: new Blob(['%PDF-fake'], { type: 'application/pdf' }), kind: 'form-pdf' },
      { name: 'Receipt 01 - Petrol - 05-10-2026.jpg', data: photo, kind: 'receipt', line: 1, mime: 'image/jpeg' },
      { name: 'TNG toll check list.pdf', data: new TextEncoder().encode('%PDF-toll').buffer, kind: 'tollcheck' },
    ];
    const r = await Accounts.send({ api, claim, files });
    assert.strictEqual(r.version, 1); assert.strictEqual(r.files, 3); assert.deepStrictEqual(r.skipped, []);

    const list = (await (await fetch(api + '?action=list')).json()).claims;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].total, 87.4);
    const rec = list[0].files.find((f) => f.kind === 'receipt');
    assert.strictEqual(rec.line, 1);
    const got = await (await fetch(`${api}?action=file&id=${list[0].id}&file=${rec.id}`)).json();
    assert.ok(Buffer.from(got.data, 'base64').equals(Buffer.from(photo)), 'the photo arrives byte for byte');
    assert.strictEqual(await Accounts.ping(api).then((j) => j.service), 'wfc-claims');

    // saving again replaces it
    const r2 = await Accounts.send({ api, claim, files: files.slice(0, 1) });
    assert.strictEqual(r2.version, 2);
    assert.strictEqual((await (await fetch(api + '?action=list')).json()).claims[0].files.length, 1);
    console.log('sender + inbox tests passed');
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
