/* Talks to the claims inbox (server/server.js locally, backend/Code.gs on Google). Same questions, same answers for both.
   If the inbox has a password, it is asked once and remembered in this browser; it is sent only to the inbox, in the body of a POST (never in an address). */
(function (root) {
  'use strict';
  const KEY = 'wfc-dash-api', PW = 'wfc-dash-key';
  let base = '', needsKey = false;

  const withQuery = (api, params) => api + (api.includes('?') ? '&' : '?') + new URLSearchParams(params);
  const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const lsSet = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* private mode */ } };

  async function timed(url, init, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 60000);
    try {
      const res = await fetch(url, Object.assign({ cache: 'no-store', signal: ctl.signal }, init));
      let j = null;
      try { j = await res.json(); } catch (e) { /* not JSON */ }
      if (!j) throw new Error(`The inbox gave an answer I could not read (HTTP ${res.status}).`);
      if (!j.ok) { const err = new Error(j.error || 'The inbox said no.'); err.code = j.code; throw err; }
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('The inbox took too long to answer.');
      if (e instanceof TypeError) throw new Error("Couldn't connect to the inbox. Check the internet.");
      throw e;
    } finally { clearTimeout(timer); }
  }

  const get = (params, ms) => timed(withQuery(base, params), {}, ms);
  const post = (body, ms) => timed(base, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }, ms);
  /* reads go by plain GET while the inbox is open, and by POST (the password in the body) once it has one */
  const read = (body) => (needsKey ? post(Object.assign({}, body, { key: lsGet(PW) })) : get(body));

  /* Finds the inbox: ?api=... (remembered), the one remembered before, the one in config.js, then this page's own /api.
     Returns the address, or '' when none answers. */
  async function connect() {
    const fromUrl = new URLSearchParams(location.search).get('api');
    if (fromUrl) lsSet(KEY, fromUrl);
    const saved = lsGet(KEY);
    // on this PC's own copy (localhost) the local inbox comes first, so a demo never shows or touches the real claims
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^https?:$/.test(location.protocol) ? location.origin + '/api' : '';
    const here = !local && /^https?:$/.test(location.protocol) ? location.origin + '/api' : '';
    const list = [fromUrl, local, saved, root.WFC_DASH && root.WFC_DASH.api, here]
      .map((x) => String(x || '').trim()).filter((x, i, a) => x && a.indexOf(x) === i);
    for (const api of list) {
      base = api;
      try { const j = await get({ action: 'ping' }, 20000); needsKey = !!j.auth; return api; } catch (e) { /* try the next */ }
    }
    base = '';
    return '';
  }

  root.Inbox = {
    connect,
    forget() { lsSet(KEY, ''); },
    address: () => base,
    get needsKey() { return needsKey; },
    hasKey: () => !!lsGet(PW),
    setKey(pw) { lsSet(PW, String(pw || '')); },
    clearKey() { lsSet(PW, ''); },
    async list() { return (await read({ action: 'list' })).claims; },
    async file(id, file) { return read({ action: 'file', id, file }); },
    async setStatus(id, status, note) { return (await post({ action: 'status', id, status, note, key: lsGet(PW) })).claim; },
  };
})(window);
