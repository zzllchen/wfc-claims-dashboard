/* Talks to the claims inbox (server/server.js locally, backend/Code.gs on Google). Same questions, same answers for both. */
(function (root) {
  'use strict';
  const KEY = 'wfc-dash-api';
  let base = '';

  const withQuery = (api, params) => api + (api.includes('?') ? '&' : '?') + new URLSearchParams(params);

  async function timed(url, init, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 45000);
    try {
      const res = await fetch(url, Object.assign({ cache: 'no-store', signal: ctl.signal }, init));
      let j = null;
      try { j = await res.json(); } catch (e) { /* not JSON */ }
      if (!j) throw new Error(`The inbox gave an answer I could not read (HTTP ${res.status}).`);
      if (!j.ok) throw new Error(j.error || 'The inbox said no.');
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('The inbox took too long to answer.');
      if (e instanceof TypeError) throw new Error("Couldn't connect to the inbox. Check the internet.");
      throw e;
    } finally { clearTimeout(timer); }
  }

  const get = (params, ms) => timed(withQuery(base, params), {}, ms);
  const post = (body) => timed(base, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });

  /* Finds the inbox: ?api=... (remembered), the one remembered before, the one in config.js, then this page's own /api.
     Returns the address, or '' when none answers. */
  async function connect() {
    const fromUrl = new URLSearchParams(location.search).get('api');
    if (fromUrl) { try { localStorage.setItem(KEY, fromUrl); } catch (e) { /* private mode */ } }
    let saved = ''; try { saved = localStorage.getItem(KEY) || ''; } catch (e) { /* private mode */ }
    // on this PC's own copy (localhost) the local inbox comes first, so a demo never shows or touches the real claims
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^https?:$/.test(location.protocol) ? location.origin + '/api' : '';
    const here = !local && /^https?:$/.test(location.protocol) ? location.origin + '/api' : '';
    const list = [fromUrl, local, saved, root.WFC_DASH && root.WFC_DASH.api, here]
      .map((x) => String(x || '').trim()).filter((x, i, a) => x && a.indexOf(x) === i);
    for (const api of list) {
      base = api;
      try { await get({ action: 'ping' }, 20000); return api; } catch (e) { /* try the next */ }
    }
    base = '';
    return '';
  }

  root.Inbox = {
    connect,
    forget() { try { localStorage.removeItem(KEY); } catch (e) { /* private mode */ } },
    address: () => base,
    async list() { return (await get({ action: 'list' })).claims; },
    async file(id, file) { return get({ action: 'file', id, file }); },
    async setStatus(id, status, note) { return (await post({ action: 'status', id, status, note })).claim; },
  };
})(window);
