#!/usr/bin/env node
/* WFC Claims inbox - local version.
   Does the same job as backend/Code.gs (the Google version): the Claim Builder posts a saved claim here, the dashboard reads it.
   Claims are kept as plain files under ./data, so nothing needs installing: `node server/server.js` (or Start.bat).
   It also serves the dashboard page itself, so http://localhost:8787/ is the whole demo on one PC.
   No login yet (on purpose, for the demo): anyone who can reach this address can read and add claims. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE = path.join(__dirname, '..');
const STATUSES = ['new', 'checked', 'paid', 'question'];
const KINDS = ['form-pdf', 'form-xlsx', 'tng', 'tollcheck', 'receipt', 'other'];
const MAX_LINES = 60;                 // the claim form has 35 rows
const MAX_FILE = 30 * 1024 * 1024;
const MAX_BODY = 48 * 1024 * 1024;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MIME = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', zip: 'application/zip' };

/* ---------- small helpers (the Google version has the same ones) ---------- */
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'staff';
const monthLabel = (m) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const safeName = (s) => str(s, 120).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim() || 'file';
const mimeOf = (name, given) => {
  if (/^[\w.+-]+\/[\w.+-]+$/.test(given || '')) return given;
  const m = String(name).match(/\.([A-Za-z0-9]+)$/);
  return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream';
};
const emailOf = (v) => (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(v || '').trim()) ? String(v).trim().slice(0, 120) : '');
function fail(message, code) { const e = new Error(message); e.userMessage = message; e.code = code || 400; return e; }

function cleanClaim(c) {
  c = c || {};
  const claimant = str(c.claimant, 80);
  if (!claimant) throw fail('The claimant name is missing.');
  const month = String(c.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail('The claim month must look like 2026-10.');
  if (Array.isArray(c.lines) && c.lines.length > MAX_LINES) throw fail(`A claim can have up to ${MAX_LINES} lines.`);
  const lines = (Array.isArray(c.lines) ? c.lines : []).map((l, i) => ({
    no: i + 1, category: str(l && l.category, 40), date: /^\d{4}-\d{2}-\d{2}$/.test(l && l.date) ? l.date : '',
    name: str(l && l.name, 120), receiptNo: str(l && l.receiptNo, 60), amount: round2(Math.max(0, Number(l && l.amount) || 0)),
  }));
  if (!lines.length) throw fail('The claim has no lines.');
  return { claimant, month, monthLabel: monthLabel(month), total: round2(lines.reduce((a, l) => a + l.amount, 0)), lines,
    from: emailOf(c.from), to: emailOf(c.to), subject: str(c.subject, 160) };
}

/* the dashboard only ever sees this: no folder names, no upload token */
function publicClaim(rec) {
  const p = rec && rec.published;
  if (!p) return null;
  const { dir, ...rest } = p;      // eslint-disable-line no-unused-vars
  return Object.assign({}, rest, { files: (p.files || []).map(({ file, ...f }) => f) });   // eslint-disable-line no-unused-vars
}

/* ---------- storage ---------- */
function makeStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const recPath = (id) => path.join(dataDir, id, 'record.json');
  const okId = (id) => /^\d{4}-\d{2}_[a-z0-9-]{1,40}$/.test(String(id || ''));
  return {
    dataDir, okId,
    get(id) { if (!okId(id)) return null; try { return JSON.parse(fs.readFileSync(recPath(id), 'utf8')); } catch (e) { return null; } },
    put(rec) { fs.mkdirSync(path.join(dataDir, rec.id), { recursive: true }); fs.writeFileSync(recPath(rec.id), JSON.stringify(rec, null, 1)); },
    all() { return fs.readdirSync(dataDir, { withFileTypes: true }).filter((d) => d.isDirectory() && okId(d.name)).map((d) => this.get(d.name)).filter(Boolean); },
    dirOf(id, name) { return path.join(dataDir, id, name); },
    rm(p) { fs.rmSync(p, { recursive: true, force: true }); },
  };
}

/* ---------- the actions (same names and answers as the Google version) ---------- */
function makeApi(dataDir, opts) {
  const db = makeStore(dataDir);
  const now = () => new Date().toISOString();
  const password = String((opts && opts.password) || '');         // empty = open, as in the demo
  const OPEN = ['ping', 'submit', 'upload', 'finish'];             // what the Claim Builder does: never needs the password

  const actions = {
    ping() { return { ok: true, service: 'wfc-claims', version: 1, where: 'local', auth: !!password }; },

    list() {
      const claims = db.all().map(publicClaim).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return { ok: true, claims };
    },

    file(q) {
      const rec = db.get(q.id);
      const p = rec && rec.published;
      const f = p && p.files.find((x) => x.id === q.file);
      if (!f) throw fail('That file is not there.', 404);
      const data = fs.readFileSync(path.join(db.dirOf(rec.id, p.dir), f.file)).toString('base64');
      return { ok: true, name: f.name, mime: f.mime, size: f.size, data };
    },

    submit(b) {
      const claim = cleanClaim(b.claim);
      const id = `${claim.month}_${slug(claim.claimant)}`;
      const rec = db.get(id) || { id, published: null, pending: null };
      if (rec.pending) db.rm(db.dirOf(id, rec.pending.dir));         // an earlier upload that never finished
      const token = crypto.randomBytes(12).toString('hex');
      const dir = 'pending-' + token;
      fs.mkdirSync(db.dirOf(id, dir), { recursive: true });
      rec.pending = { token, dir, claim, files: [], startedAt: now() };
      db.put(rec);
      return { ok: true, id, token };
    },

    upload(b) {
      const rec = db.okId(b.id) && db.get(b.id);
      if (!rec || !rec.pending || rec.pending.token !== b.token) throw fail('This upload is no longer valid. Save the claim again.', 409);
      const f = b.file || {};
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(f.id || ''))) throw fail('Bad file id.');
      const bytes = Buffer.from(String(f.data || ''), 'base64');
      if (!bytes.length) throw fail('The file is empty.');
      if (bytes.length > MAX_FILE) throw fail('The file is too big.', 413);
      const name = safeName(f.name);
      const disk = `${f.id}__${name}`;
      fs.writeFileSync(path.join(db.dirOf(rec.id, rec.pending.dir), disk), bytes);
      rec.pending.files = rec.pending.files.filter((x) => x.id !== f.id).concat({
        id: f.id, name, kind: KINDS.includes(f.kind) ? f.kind : 'other', line: Math.max(0, parseInt(f.line, 10) || 0),
        mime: mimeOf(name, f.mime), size: bytes.length, file: disk,
      });
      db.put(rec);
      return { ok: true, size: bytes.length };
    },

    finish(b) {
      const rec = db.okId(b.id) && db.get(b.id);
      if (!rec || !rec.pending || rec.pending.token !== b.token) throw fail('This upload is no longer valid. Save the claim again.', 409);
      const old = rec.published, pend = rec.pending, at = now();
      const version = (old ? old.version : 0) + 1;
      const dir = 'v' + version + '-' + pend.token.slice(0, 6);
      fs.renameSync(db.dirOf(rec.id, pend.dir), db.dirOf(rec.id, dir));
      if (old) db.rm(db.dirOf(rec.id, old.dir));
      const history = (old ? old.history : []).concat({ at, text: old ? `Updated by the claimant (version ${version})` : 'Received' }).slice(-50);
      rec.published = Object.assign({ id: rec.id }, pend.claim, {
        version, submittedAt: old ? old.submittedAt : at, updatedAt: at, status: 'new', statusAt: at, note: '', history,
        files: pend.files, dir,
      });
      rec.pending = null;
      db.put(rec);
      return { ok: true, id: rec.id, version, files: pend.files.length };
    },

    status(b) {
      const rec = db.okId(b.id) && db.get(b.id);
      const p = rec && rec.published;
      if (!p) throw fail('That claim is not there.', 404);
      const status = b.status == null ? p.status : String(b.status);
      if (!STATUSES.includes(status)) throw fail('Unknown status.');
      const note = b.note == null ? p.note : str(b.note, 600);
      const at = now(), notes = [];
      if (status !== p.status) notes.push(`Marked as ${({ new: 'New', checked: 'Checked', paid: 'Paid', question: 'Has a question' })[status]}`);
      if (note !== p.note) notes.push(note ? 'Note updated' : 'Note removed');
      p.status = status; p.note = note;
      if (notes.length) p.statusAt = at;
      notes.forEach((text) => p.history.push({ at, text }));
      p.history = p.history.slice(-50);
      db.put(rec);
      return { ok: true, claim: publicClaim(rec) };
    },

    delete(b) {
      const rec = db.okId(b.id) && db.get(b.id);
      if (!rec) throw fail('That claim is not there.', 404);
      db.rm(path.join(db.dataDir, rec.id));
      return { ok: true };
    },
  };

  /* method + query string + parsed JSON body -> answer object */
  return function handle(method, query, body) {
    try {
      const params = method === 'POST' ? (body || {}) : query;
      const action = params.action;
      if (!actions[action] || (method === 'GET' && !['ping', 'list', 'file'].includes(action))) throw fail('Unknown action.');     // a read may come by GET or POST; a change only by POST
      if (password && !OPEN.includes(action)) {
        const a = Buffer.from(String(params.key || '')), b = Buffer.from(password);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail('Password needed.', 401);
      }
      return actions[action](params);
    } catch (e) {
      if (!e.userMessage) console.error(e);
      return { ok: false, error: e.userMessage || 'Something went wrong on the server.', code: e.code || 500 };
    }
  };
}

/* ---------- http ---------- */
const PUBLIC_DIRS = ['css', 'js', 'vendor', 'assets'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function start({ port = 8787, dataDir = path.join(SITE, 'data'), quiet = false, host, password = process.env.WFC_DASH_PASSWORD || '' } = {}) {
  const handle = makeApi(dataDir, { password });
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600',
    };
    const url = new URL(req.url, 'http://localhost');
    const json = (obj, status) => { res.writeHead(status || 200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors)); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    if (url.pathname === '/api') {
      if (req.method === 'GET') { json(handle('GET', Object.fromEntries(url.searchParams), null)); return; }
      if (req.method === 'POST') {
        const chunks = []; let size = 0, dead = false;
        req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { dead = true; json({ ok: false, error: 'That upload is too big.' }, 413); req.destroy(); } else chunks.push(c); });
        req.on('end', () => {
          if (dead) return;
          let body = null;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { json({ ok: false, error: 'Bad request.' }, 400); return; }
          json(handle('POST', {}, body));
        });
        return;
      }
      json({ ok: false, error: 'Unknown action.' }, 405); return;
    }

    // the dashboard page itself
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const top = rel.split('/')[1];
    const file = path.normalize(path.join(SITE, rel));
    if ((rel !== '/index.html' && !PUBLIC_DIRS.includes(top)) || !file.startsWith(SITE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const p = server.address().port;
      if (!quiet) console.log(`WFC Claims is running:  http://localhost:${p}/   (claims are kept in ${dataDir})\nPress Ctrl+C to stop.`);
      resolve({ server, port: p, url: `http://localhost:${p}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { start, makeApi, cleanClaim, slug };

if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  start({ port: +arg('--port', 8787), dataDir: arg('--data', path.join(SITE, 'data')), password: arg('--password', process.env.WFC_DASH_PASSWORD || '') }).catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? 'That port is already in use - is WFC Claims already running? Try http://localhost:8787/' : e);
    process.exit(1);
  });
}
