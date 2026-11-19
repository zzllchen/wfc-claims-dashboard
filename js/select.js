/* Flow's dropdown: the page's own list for a <select>, in Flow's look (the browser's own list cannot be styled: square, grey).
   The <select> stays in the page, hidden, and keeps the value, so the page's code reads and sets it as before; picking an item sets
   it and sends the usual "change". On a computer the list opens under the box (keyboard: arrows, Home/End, Enter, Escape, type a
   letter to jump); on a phone it opens as a sheet from the bottom with big rows. FlowSelect.sync(select) after changing it in code. */
(function (root) {
  'use strict';
  const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const asSheet = () => root.matchMedia('(max-width: 640px)').matches;
  let open = null;           // { sel, list, scrim, active, sheet, overflow }
  let uid = 0;

  const labelOf = (sel) => { const l = sel.closest('label'); const s = l && l.querySelector('span'); return s ? s.textContent.trim() : ''; };

  function sync(sel) {
    const w = sel && sel._fs; if (!w) return;
    const o = sel.options[sel.selectedIndex];
    w.text.textContent = o ? o.text : '';
    w.btn.disabled = sel.disabled;
    const name = labelOf(sel);
    w.btn.setAttribute('aria-label', `${name ? name + ': ' : ''}${o ? o.text : ''}`);
    if (open && open.sel === sel) close();
  }

  function enhance(sel) {
    if (!sel || sel._fs) return sel && sel._fs;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'fsel';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    const text = document.createElement('span'); text.className = 'fsel-t';
    btn.append(text); btn.insertAdjacentHTML('beforeend', CHEVRON);
    sel.classList.add('fs-native'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
    sel.after(btn);
    btn.addEventListener('click', (e) => { e.preventDefault(); if (open && open.sel === sel) close(true); else show(sel); });
    btn.addEventListener('keydown', (e) => { if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show(sel); } });
    sel._fs = { btn, text };
    sync(sel);
    return sel._fs;
  }

  function show(sel) {
    close();
    const w = sel._fs, sheet = asSheet(), id = `fs-list-${++uid}`;
    const list = document.createElement('div');
    list.className = 'fmenu' + (sheet ? ' sheet' : '');
    list.id = id; list.setAttribute('role', 'listbox'); list.tabIndex = -1;
    const name = labelOf(sel);
    if (name) list.setAttribute('aria-label', name);
    let scrim = null;
    if (sheet) {
      scrim = document.createElement('div'); scrim.className = 'fscrim';
      scrim.addEventListener('click', () => close(true));
      const head = document.createElement('div'); head.className = 'fsheet-h';
      head.innerHTML = '<span class="fgrab" aria-hidden="true"></span>';
      const t = document.createElement('b'); t.textContent = name || 'Choose'; head.append(t);
      list.append(head);
    }
    const box = document.createElement('div'); box.className = 'fopts';
    Array.from(sel.options).forEach((o, i) => {
      const it = document.createElement('div');
      it.className = 'fopt'; it.id = `${id}-${i}`; it.setAttribute('role', 'option'); it.dataset.i = String(i);
      it.setAttribute('aria-selected', String(i === sel.selectedIndex));
      const s = document.createElement('span'); s.textContent = o.text;
      it.append(s); it.insertAdjacentHTML('beforeend', CHECK);
      it.addEventListener('click', () => pick(i));
      it.addEventListener('mousemove', () => { if (open && open.active !== i) setActive(i, false); });
      box.append(it);
    });
    list.append(box);
    if (sheet) { document.body.append(scrim, list); }
    else { document.body.append(list); place(w.btn, list); }
    open = { sel, list, scrim, active: -1, sheet, overflow: document.body.style.overflow };
    if (sheet) document.body.style.overflow = 'hidden';
    w.btn.setAttribute('aria-expanded', 'true'); w.btn.setAttribute('aria-controls', id); w.btn.classList.add('on');
    setActive(Math.max(0, sel.selectedIndex), true);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keys, true);
    root.addEventListener('scroll', onScroll, true);
    root.addEventListener('resize', onResize);
  }

  /* under the box (or above it when there is no room below), never past the screen edges */
  function place(btn, list) {
    const r = btn.getBoundingClientRect(), gap = 6, margin = 12;
    list.style.minWidth = Math.max(r.width, 200) + 'px';
    const h = list.offsetHeight, below = innerHeight - r.bottom - margin, above = r.top - margin;
    const up = h > below && above > below;
    list.style.maxHeight = Math.max(160, Math.min(340, up ? above - gap : below - gap)) + 'px';
    list.style.top = (up ? Math.max(margin, r.top - gap - Math.min(h, above - gap)) : r.bottom + gap) + 'px';
    const left = Math.min(r.left, innerWidth - list.offsetWidth - margin);
    list.style.left = Math.max(margin, left) + 'px';
    list.classList.toggle('up', up);
  }

  function setActive(i, scroll) {
    if (!open) return;
    const items = open.list.querySelectorAll('.fopt');
    if (!items.length) return;
    i = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((it, k) => it.classList.toggle('active', k === i));
    open.active = i;
    open.sel._fs.btn.setAttribute('aria-activedescendant', items[i].id);
    if (scroll) items[i].scrollIntoView({ block: 'nearest' });
  }

  function pick(i) {
    if (!open) return;
    const sel = open.sel, changed = sel.selectedIndex !== i;
    close(true);
    sel.selectedIndex = i;
    sync(sel);
    if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function close(focus) {
    if (!open) return;
    const { sel, list, scrim, overflow, sheet } = open;
    open = null;
    list.remove(); if (scrim) scrim.remove();
    if (sheet) document.body.style.overflow = overflow;
    const btn = sel._fs.btn;
    btn.setAttribute('aria-expanded', 'false'); btn.removeAttribute('aria-activedescendant'); btn.classList.remove('on');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keys, true);
    root.removeEventListener('scroll', onScroll, true);
    root.removeEventListener('resize', onResize);
    if (focus) btn.focus({ preventScroll: true });
  }

  function outside(e) {
    if (!open) return;
    if (open.list.contains(e.target) || open.sel._fs.btn.contains(e.target)) return;
    close();
  }
  function onScroll(e) { if (open && !open.sheet && !open.list.contains(e.target)) close(); }
  function onResize() { if (open && !open.sheet) close(); }

  let typed = '', typedAt = 0;
  function keys(e) {
    if (!open) return;
    const n = open.sel.options.length;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') { stop(); close(true); }
    else if (e.key === 'ArrowDown') { stop(); setActive(open.active + 1, true); }
    else if (e.key === 'ArrowUp') { stop(); setActive(open.active - 1, true); }
    else if (e.key === 'Home') { stop(); setActive(0, true); }
    else if (e.key === 'End') { stop(); setActive(n - 1, true); }
    else if (e.key === 'Enter' || e.key === ' ') { stop(); pick(open.active); }
    else if (e.key === 'Tab') { close(); }
    else if (e.key.length === 1 && /\S/.test(e.key)) {          // type a letter or two to jump to an item
      stop();
      const now = Date.now(); typed = (now - typedAt > 700 ? '' : typed) + e.key.toLowerCase(); typedAt = now;
      const opts = Array.from(open.sel.options).map((o) => o.text.toLowerCase());
      let k = opts.findIndex((t, i) => i > open.active - (typed.length > 1 ? 1 : 0) && t.startsWith(typed));
      if (k < 0) k = opts.findIndex((t) => t.startsWith(typed));
      if (k >= 0) setActive(k, true);
    }
  }

  root.FlowSelect = { enhance, sync, close: () => close() };
})(window);
