'use strict';
// Roadmap editor / viewer. One roadmap.json holds the NOW / NEXT / LATER lists of every product.
// Edits are kept in this browser; Export downloads roadmap.json, which is committed to publish it.
// Product pages show the published file with roadmap-embed.js.
(() => {
  const LS_DATA  = 'taskboards-roadmap-v1';
  const LS_CUR   = 'taskboards-roadmap-current';
  const LS_THEME = 'taskboards-theme';

  const COLS = [
    { id: 'now',   label: 'Now',   sub: 'Working on' },
    { id: 'next',  label: 'Next',  sub: 'Up next' },
    { id: 'later', label: 'Later', sub: 'On the horizon' }
  ];
  const TONES = ['success', 'info', 'warn', 'danger', 'secondary', 'contrast'];
  const TONE_LABEL = { success: 'Success', info: 'Info', warn: 'Warning', danger: 'Danger', secondary: 'Neutral', contrast: 'Contrast' };

  const params   = new URLSearchParams(location.search);
  const READONLY = params.get('view') === '1';
  document.body.classList.toggle('readonly', READONLY);

  const $     = s => document.querySelector(s);
  const uid   = () => Math.random().toString(36).slice(2, 9);
  const today = () => new Date().toISOString().slice(0, 10);

  // ── tiny DOM helper: everything user-written goes in as text, never as HTML ─────────────
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;            // only ever static icon markup
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  const ICON_PATHS = {
    plus:   '<path d="M12 5v14M5 12h14"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash:  '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
    left:   '<path d="m15 18-6-6 6-6"/>',
    right:  '<path d="m9 18 6-6-6-6"/>',
    sun:    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon:   '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    check:  '<path d="M20 6 9 17l-5-5"/>',
    x:      '<path d="M18 6 6 18M6 6l12 12"/>'
  };
  const icon = name => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

  // ── data ────────────────────────────────────────────────────────────────────────────
  const str  = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'app';
  const cleanUrl = v => { v = String(v || '').trim(); return /^https?:\/\/[^\s]+$/i.test(v) ? v.slice(0, 200) : ''; };

  function normItem(it, ids) {
    if (!it || typeof it !== 'object') return null;
    const title = str(it.title, 80);
    if (!title) return null;
    let id = str(it.id, 24) || uid();
    while (ids.has(id)) id = uid();
    ids.add(id);
    return { id, title, description: str(it.description, 280), tag: str(it.tag, 20), tone: TONES.includes(it.tone) ? it.tone : 'secondary' };
  }

  const emptyProduct = name => ({ id: slug(name), name, tagline: '', url: '', now: [], next: [], later: [] });

  function normalize(raw) {
    const seen = new Set();
    const products = [];
    for (const p of Array.isArray(raw?.products) ? raw.products : []) {
      const name = str(p?.name, 40);
      if (!name) continue;
      let id = slug(p.id || name);
      while (seen.has(id)) id += '-' + uid().slice(0, 2);
      seen.add(id);
      const ids = new Set();
      const prod = { id, name, tagline: str(p.tagline, 140), url: cleanUrl(p.url) };
      for (const c of COLS) prod[c.id] = (Array.isArray(p[c.id]) ? p[c.id] : []).map(it => normItem(it, ids)).filter(Boolean);
      products.push(prod);
    }
    if (!products.length) products.push(emptyProduct('My app'));
    return { version: 1, updatedAt: /^\d{4}-\d{2}-\d{2}$/.test(raw?.updatedAt) ? raw.updatedAt : today(), products };
  }

  const clone   = d => JSON.parse(JSON.stringify(d));
  const normStr = d => JSON.stringify(normalize(d).products);   // updatedAt is ignored when comparing

  let data = null;      // the working copy
  let pub = null;       // what is published (roadmap.json), or null if it can't be read
  let baseStr = '';     // published version the local edits started from
  let current = '';     // selected product id

  const product = () => data.products.find(p => p.id === current) || data.products[0];
  const dirty   = () => !!pub && normStr(data) !== normStr(pub);

  function persist() {
    if (READONLY) return;
    try { localStorage.setItem(LS_DATA, JSON.stringify({ data, base: baseStr })); } catch {}
  }
  function touch() { data.updatedAt = today(); persist(); renderAll(); }

  async function fetchPublished() {
    try {
      const r = await fetch('./roadmap.json', { cache: 'no-store' });
      if (!r.ok) return null;
      return normalize(await r.json());
    } catch { return null; }
  }

  function readLocal() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_DATA));
      return s && s.data ? { data: normalize(s.data), base: String(s.base || '') } : null;
    } catch { return null; }
  }

  // ── toast ───────────────────────────────────────────────────────────────────────────
  function toast(msg, tone) {
    const t = el('div', { class: 'toast' + (tone === 'warn' ? ' toast--warn' : ''), html: icon(tone === 'warn' ? 'x' : 'check') }, msg);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 3200);
  }

  // ── dialog ──────────────────────────────────────────────────────────────────────────
  function openDialog({ title, body, foot, onClose }) {
    const prev = document.activeElement;
    const overlay = el('div', { class: 'overlay', role: 'presentation' });
    const dlg = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('div', { class: 'dialog__head' },
        el('h2', { class: 'dialog__title' }, title),
        el('button', { class: 'btn btn--text btn--icon btn--sm', 'aria-label': 'Close', html: icon('x'), onclick: () => close() })),
      el('div', { class: 'dialog__body' }, body),
      el('div', { class: 'dialog__foot' }, foot));
    overlay.append(dlg);
    document.body.append(overlay);

    const focusables = () => [...dlg.querySelectorAll('input, textarea, select, button:not([disabled])')];
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    function close() {
      if (!overlay.isConnected) return;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
      onClose?.();
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    (dlg.querySelector('input, textarea, select') || dlg.querySelector('.dialog__foot button:last-child'))?.focus();
    return { close, dlg };
  }

  function confirmDialog({ title, message, confirm = 'Confirm', danger = false }) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (done) return; done = true; d.close(); resolve(v); };
      const d = openDialog({
        title,
        body: el('p', { class: 'dialog__msg' }, message),
        foot: [
          el('button', { class: 'btn btn--text', onclick: () => finish(false) }, 'Cancel'),
          el('button', { class: 'btn ' + (danger ? 'btn--danger' : 'btn--primary'), onclick: () => finish(true) }, confirm)
        ],
        onClose: () => finish(false)
      });
    });
  }

  function field(label, control, hint) {
    const id = 'f' + uid();
    control.id = id;
    return el('div', { class: 'field' }, el('label', { for: id }, label), control, hint && el('span', { class: 'field__hint' }, hint));
  }

  function segmented(options, value, onPick) {
    const wrap = el('div', { class: 'seg', role: 'group' });
    const paint = () => [...wrap.children].forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].id === value)));
    options.forEach(o => wrap.append(el('button', { type: 'button', class: 'seg__btn', onclick: () => { value = o.id; paint(); onPick(o.id); } }, o.label)));
    paint();
    return wrap;
  }

  // ── product dialog ──────────────────────────────────────────────────────────────────
  function productDialog(p) {
    const isNew = !p;
    const name = el('input', { class: 'input', maxlength: 40, placeholder: 'Product name', value: p?.name || '' });
    const tagline = el('input', { class: 'input', maxlength: 140, placeholder: 'One line about the product', value: p?.tagline || '' });
    const url = el('input', { class: 'input', maxlength: 200, placeholder: 'https://', value: p?.url || '', inputmode: 'url' });

    const save = () => {
      if (!str(name.value, 40)) { name.setAttribute('aria-invalid', 'true'); name.focus(); return; }
      if (isNew) {
        const np = emptyProduct(str(name.value, 40));
        let id = np.id;
        while (data.products.some(x => x.id === id)) id += '-' + uid().slice(0, 2);
        np.id = id;
        np.tagline = str(tagline.value, 140);
        np.url = cleanUrl(url.value);
        data.products.push(np);
        select(np.id, true);
      } else {
        p.name = str(name.value, 40);
        p.tagline = str(tagline.value, 140);
        p.url = cleanUrl(url.value);
      }
      d.close();
      touch();
    };
    const foot = [
      !isNew && data.products.length > 1 && el('button', { class: 'btn btn--text btn--del-left', style: 'color:var(--danger)', onclick: async () => {
        if (!await confirmDialog({ title: `Delete “${p.name}”?`, message: 'Its whole roadmap is removed from your working copy. You can still discard changes before publishing.', confirm: 'Delete', danger: true })) return;
        data.products = data.products.filter(x => x.id !== p.id);
        d.close();
        select(data.products[0].id, true);
        touch();
      } }, 'Delete product'),
      el('button', { class: 'btn btn--text', onclick: () => d.close() }, 'Cancel'),
      el('button', { class: 'btn btn--primary', onclick: save }, isNew ? 'Add product' : 'Save')
    ];
    const d = openDialog({ title: isNew ? 'Add product' : 'Edit product', body: [field('Name', name), field('Tagline', tagline), field('Website', url, 'Shown as a link under the title.')], foot });
    [name, tagline, url].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') save(); }));
  }

  // ── feature dialog ──────────────────────────────────────────────────────────────────
  function colOf(id) { const p = product(); return COLS.find(c => p[c.id].some(x => x.id === id))?.id; }

  function itemDialog(item, colId) {
    const isNew = !item;
    const draft = { col: colId, tone: item?.tone || 'secondary' };
    const title = el('input', { class: 'input', maxlength: 80, placeholder: 'Feature name', value: item?.title || '' });
    const desc = el('textarea', { class: 'textarea', maxlength: 280, placeholder: 'What it is and why it matters (optional)' }, item?.description || '');
    const tag = el('input', { class: 'input', maxlength: 20, placeholder: 'e.g. Free, Teams, Beta', value: item?.tag || '' });

    const tones = el('div', { class: 'tones', role: 'group', 'aria-label': 'Tag colour' });
    const paintTones = () => [...tones.children].forEach((b, i) => b.setAttribute('aria-pressed', String(TONES[i] === draft.tone)));
    TONES.forEach(t => tones.append(el('button', { type: 'button', class: 'tone-opt', 'aria-label': TONE_LABEL[t], onclick: () => { draft.tone = t; paintTones(); } },
      el('span', { class: 'tag', 'data-tone': t }, TONE_LABEL[t]))));
    paintTones();

    const colSeg = segmented(COLS, draft.col, v => { draft.col = v; });

    const save = () => {
      const t = str(title.value, 80);
      if (!t) { title.setAttribute('aria-invalid', 'true'); title.focus(); return; }
      const fields = { title: t, description: str(desc.value, 280), tag: str(tag.value, 20), tone: draft.tone };
      const p = product();
      if (isNew) {
        p[draft.col].push({ id: uid(), ...fields });
      } else if (draft.col === colId) {
        Object.assign(item, fields);
      } else {
        p[colId] = p[colId].filter(x => x.id !== item.id);
        Object.assign(item, fields);
        p[draft.col].push(item);
      }
      d.close();
      touch();
    };
    const foot = [
      !isNew && el('button', { class: 'btn btn--text btn--del-left', style: 'color:var(--danger)', onclick: () => { d.close(); deleteItem(item.id); } }, 'Delete'),
      el('button', { class: 'btn btn--text', onclick: () => d.close() }, 'Cancel'),
      el('button', { class: 'btn btn--primary', onclick: save }, isNew ? 'Add feature' : 'Save')
    ];
    const d = openDialog({
      title: isNew ? 'Add feature' : 'Edit feature',
      body: [
        field('Title', title),
        field('Description', desc),
        el('div', { class: 'row2' }, field('Tag', tag, 'A short label on the card.'), el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Column'), colSeg)),
        el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Tag colour'), tones)
      ],
      foot
    });
    title.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  }

  async function deleteItem(id) {
    const p = product();
    const col = colOf(id);
    const it = col && p[col].find(x => x.id === id);
    if (!it) return;
    if (!await confirmDialog({ title: 'Delete this feature?', message: `“${it.title}” will be removed from the ${COLS.find(c => c.id === col).label.toLowerCase()} list.`, confirm: 'Delete', danger: true })) return;
    p[col] = p[col].filter(x => x.id !== id);
    touch();
  }

  // ── moving ──────────────────────────────────────────────────────────────────────────
  function moveItem(id, toCol, toIdx) {
    const p = product();
    let item = null;
    for (const c of COLS) {
      const i = p[c.id].findIndex(x => x.id === id);
      if (i >= 0) { item = p[c.id].splice(i, 1)[0]; break; }
    }
    if (!item) return;
    const arr = p[toCol];
    arr.splice(toIdx == null ? arr.length : Math.max(0, Math.min(toIdx, arr.length)), 0, item);
    touch();
  }
  const focusCard = id => requestAnimationFrame(() => document.querySelector(`.card[data-id="${id}"]`)?.focus());

  function moveByKey(id, dCol, dIdx) {
    const col = colOf(id);
    const ci = COLS.findIndex(c => c.id === col);
    if (dCol) {
      const to = COLS[ci + dCol];
      if (!to) return;
      moveItem(id, to.id, null);
    } else {
      const arr = product()[col];
      const i = arr.findIndex(x => x.id === id);
      const j = i + dIdx;
      if (j < 0 || j >= arr.length) return;
      moveItem(id, col, j);
    }
    focusCard(id);
  }

  // drag & drop (mouse); touch and keyboard use the ‹ › buttons and Alt + arrows
  let drag = null;
  let slot = null;

  function dropIndex(list, y) {
    const cards = [...list.querySelectorAll('.card:not(.dragging)')];
    const i = cards.findIndex(c => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    return i < 0 ? cards.length : i;
  }
  function placeSlot(list, idx) {
    slot = slot || el('div', { class: 'drop-slot' });
    const cards = [...list.querySelectorAll('.card:not(.dragging)')];
    if (idx < cards.length) list.insertBefore(slot, cards[idx]); else list.append(slot);
  }
  function endDrag() {
    drag = null;
    slot?.remove();
    slot = null;
    document.querySelectorAll('.col.over').forEach(c => c.classList.remove('over'));
    document.querySelectorAll('.card.dragging').forEach(c => c.classList.remove('dragging'));
  }
  function wireDrop(col, list, colId) {
    col.addEventListener('dragover', e => {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.col.over').forEach(c => { if (c !== col) c.classList.remove('over'); });
      col.classList.add('over');
      placeSlot(list, dropIndex(list, e.clientY));
    });
    col.addEventListener('dragleave', e => {
      if (col.contains(e.relatedTarget)) return;
      col.classList.remove('over');
      slot?.remove();
    });
    col.addEventListener('drop', e => {
      if (!drag) return;
      e.preventDefault();
      const idx = dropIndex(list, e.clientY);
      const id = drag.id;
      endDrag();
      moveItem(id, colId, idx);
    });
  }

  // ── rendering ───────────────────────────────────────────────────────────────────────
  function tagEl(it) { return it.tag ? el('span', { class: 'tag', 'data-tone': it.tone }, it.tag) : null; }

  function cardEl(it, colId) {
    const ci = COLS.findIndex(c => c.id === colId);
    const card = el('article', { class: 'card', 'data-id': it.id, role: 'listitem', tabindex: READONLY ? null : '0' },
      el('h3', { class: 'card__title' }, it.title),
      it.description && el('p', { class: 'card__desc' }, it.description),
      (it.tag || !READONLY) && el('div', { class: 'card__foot' },
        tagEl(it),
        !READONLY && el('div', { class: 'card__actions only-edit' },
          ci > 0 && el('button', { class: 'btn btn--text btn--icon btn--sm', title: `Move to ${COLS[ci - 1].label}`, 'aria-label': `Move to ${COLS[ci - 1].label}`, html: icon('left'), onclick: () => moveByKey(it.id, -1, 0) }),
          ci < COLS.length - 1 && el('button', { class: 'btn btn--text btn--icon btn--sm', title: `Move to ${COLS[ci + 1].label}`, 'aria-label': `Move to ${COLS[ci + 1].label}`, html: icon('right'), onclick: () => moveByKey(it.id, 1, 0) }),
          el('button', { class: 'btn btn--text btn--icon btn--sm', title: 'Edit', 'aria-label': 'Edit', html: icon('pencil'), onclick: () => itemDialog(it, colId) }),
          el('button', { class: 'btn btn--text btn--icon btn--sm btn--del', title: 'Delete', 'aria-label': 'Delete', html: icon('trash'), onclick: () => deleteItem(it.id) })))
    );
    if (!READONLY) {
      card.draggable = true;
      card.addEventListener('dragstart', e => {
        drag = { id: it.id };
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', it.id); } catch {}
        setTimeout(() => card.classList.add('dragging'), 0);
      });
      card.addEventListener('dragend', endDrag);
      card.addEventListener('keydown', e => {
        if (e.target !== card) return;
        if (e.altKey && e.key === 'ArrowUp')    { e.preventDefault(); moveByKey(it.id, 0, -1); }
        else if (e.altKey && e.key === 'ArrowDown')  { e.preventDefault(); moveByKey(it.id, 0, 1); }
        else if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); moveByKey(it.id, -1, 0); }
        else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); moveByKey(it.id, 1, 0); }
        else if (e.key === 'Enter') { e.preventDefault(); itemDialog(it, colOf(it.id)); }
        else if (e.key === 'Delete') { e.preventDefault(); deleteItem(it.id); }
      });
    }
    return card;
  }

  function renderProducts() {
    const box = $('#products');
    box.replaceChildren(...[
      ...data.products.map(p => el('button', { class: 'seg__btn', 'aria-pressed': String(p.id === current), onclick: () => select(p.id) }, p.name)),
      !READONLY && el('button', { class: 'seg__btn seg__add only-edit', title: 'Add product', 'aria-label': 'Add product', html: icon('plus'), onclick: () => productDialog(null) })
    ].filter(Boolean));
    box.hidden = READONLY && data.products.length < 2;
  }

  function renderHero() {
    const p = product();
    const hero = $('#hero');
    const when = new Date(data.updatedAt + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    let host = '';
    try { host = p.url ? new URL(p.url).host : ''; } catch {}
    hero.replaceChildren(
      el('div', { class: 'hero__row' },
        el('div', {}, el('h1', {}, p.name), p.tagline && el('p', { class: 'hero__tag' }, p.tagline)),
        !READONLY && el('button', { class: 'btn btn--outline only-edit', html: icon('pencil') + ' Edit product', onclick: () => productDialog(p) })),
      el('div', { class: 'hero__meta' },
        p.url && el('a', { href: p.url, target: '_blank', rel: 'noopener' }, host),
        el('span', {}, 'Updated ' + when),
        !READONLY && pub && (dirty()
          ? el('span', { class: 'chip', title: 'This differs from the published roadmap.json. Export it and commit it to publish.' }, 'Unpublished changes')
          : el('span', { class: 'chip chip--ok', title: 'Matches the published roadmap.json' }, 'Published')),
        !READONLY && pub && dirty() && el('button', { class: 'btn btn--text btn--sm', onclick: discard }, 'Discard changes'))
    );
    document.title = `${p.name} · Roadmap`;
  }

  function renderCols() {
    const p = product();
    const root = $('#cols');
    root.replaceChildren();
    for (const c of COLS) {
      const items = p[c.id];
      const list = el('div', { class: 'col__list', role: 'list' });
      items.forEach(it => list.append(cardEl(it, c.id)));
      if (!items.length) {
        list.append(el('div', { class: 'empty' },
          READONLY ? 'Nothing planned here yet.' : 'Nothing here yet.',
          !READONLY && el('button', { class: 'btn btn--outline btn--sm only-edit', html: icon('plus') + ' Add feature', onclick: () => itemDialog(null, c.id) })));
      }
      const col = el('section', { class: 'col', 'data-col': c.id },
        el('div', { class: 'col__head' },
          el('span', { class: 'col__dot' }),
          el('span', { class: 'col__title' }, c.label),
          el('span', { class: 'col__sub' }, c.sub),
          el('span', { class: 'col__count' }, String(items.length)),
          !READONLY && el('button', { class: 'btn btn--text btn--icon btn--sm col__add only-edit', title: `Add to ${c.label}`, 'aria-label': `Add to ${c.label}`, html: icon('plus'), onclick: () => itemDialog(null, c.id) })),
        list);
      if (!READONLY) wireDrop(col, list, c.id);
      root.append(col);
    }
  }

  function renderAll() { renderProducts(); renderHero(); renderCols(); }

  function select(id, silent) {
    if (!data.products.some(p => p.id === id)) id = data.products[0].id;
    current = id;
    try { localStorage.setItem(LS_CUR, id); } catch {}
    const u = new URL(location.href);
    u.searchParams.set('app', id);
    history.replaceState(null, '', u);
    if (!silent) renderAll();
  }

  async function discard() {
    if (!await confirmDialog({ title: 'Discard your changes?', message: 'Your working copy goes back to the published roadmap.json. This can’t be undone.', confirm: 'Discard', danger: true })) return;
    data = clone(pub);
    baseStr = normStr(pub);
    if (!data.products.some(p => p.id === current)) current = data.products[0].id;
    persist();
    renderAll();
    toast('Back to the published roadmap');
  }

  // ── theme (only colours change) ─────────────────────────────────────────────────────
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(LS_THEME, t); } catch {}
    $('#btn-theme').innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#09090b');
  }
  $('#btn-theme').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

  // ── import / export ─────────────────────────────────────────────────────────────────
  $('#btn-export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
    const a = el('a', { href: url, download: 'roadmap.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('roadmap.json downloaded — commit it to publish');
  });
  $('#btn-import').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      if (f.size > 2e6) throw new Error('too large');
      const parsed = JSON.parse(await f.text());
      if (!Array.isArray(parsed?.products)) throw new Error('no products');
      const clean = normalize(parsed);
      if (!await confirmDialog({ title: 'Replace the roadmap?', message: `Everything here is replaced by the ${clean.products.length} product(s) in “${f.name}”.`, confirm: 'Replace', danger: true })) return;
      data = clean;
      select(data.products.some(p => p.id === current) ? current : data.products[0].id, true);
      persist();
      renderAll();
      toast('Roadmap imported');
    } catch { toast('That file isn’t a valid roadmap.json', 'warn'); }
  });

  // ── start ───────────────────────────────────────────────────────────────────────────
  (async function init() {
    pub = await fetchPublished();
    const saved = READONLY ? null : readLocal();
    if (!saved) {
      data = pub ? clone(pub) : normalize(null);
      baseStr = pub ? normStr(pub) : normStr(data);
    } else if (saved.base === normStr(saved.data)) {
      // no local edits: follow whatever is published now
      data = pub ? clone(pub) : saved.data;
      baseStr = pub ? normStr(pub) : saved.base;
    } else {
      data = saved.data;
      baseStr = saved.base;
      if (pub && normStr(pub) !== baseStr) toast('The published roadmap changed while you had edits here', 'warn');
    }
    let start = params.get('app');
    if (!data.products.some(p => p.id === start)) { try { start = localStorage.getItem(LS_CUR); } catch { start = ''; } }
    current = data.products.some(p => p.id === start) ? start : data.products[0].id;
    if (!READONLY) persist();
    select(current, true);
    renderAll();
  })();
})();
