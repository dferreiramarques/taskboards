'use strict';
// Read-only roadmap page. The roadmap itself is edited in the Roadmaps app (hosted separately) and read from
// ROADMAP_SRC in config.js; until that is set it falls back to the roadmap.json that sits next to this page.
(() => {
  const SRC = (window.TASKBOARDS_CONFIG || {}).ROADMAP_SRC || './roadmap.json';
  const LS_THEME = 'taskboards-theme';
  const COLS = [
    { id: 'now',   label: 'Now',   sub: 'Working on' },
    { id: 'next',  label: 'Next',  sub: 'Up next' },
    { id: 'later', label: 'Later', sub: 'On the horizon' }
  ];
  const TONES = ['success', 'info', 'warn', 'danger', 'secondary', 'contrast'];

  const $ = s => document.querySelector(s);
  const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

  // everything from the data goes in as text, never as HTML
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

  const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  const icon = p => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

  // ── data ────────────────────────────────────────────────────────────────────────────
  function normalize(raw) {
    const products = [];
    for (const p of Array.isArray(raw?.products) ? raw.products : []) {
      const name = str(p?.name, 40);
      if (!name) continue;
      const prod = { id: str(p.id, 32) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, tagline: str(p.tagline, 140), url: /^https?:\/\/\S+$/i.test(p.url || '') ? String(p.url).slice(0, 200) : '' };
      for (const c of COLS) {
        prod[c.id] = (Array.isArray(p[c.id]) ? p[c.id] : []).map(it => {
          const title = str(it?.title, 80);
          return title ? { title, description: str(it.description, 280), tag: str(it.tag, 20), tone: TONES.includes(it.tone) ? it.tone : 'secondary' } : null;
        }).filter(Boolean);
      }
      products.push(prod);
    }
    return { updatedAt: /^\d{4}-\d{2}-\d{2}/.test(raw?.updatedAt) ? raw.updatedAt.slice(0, 10) : '', products };
  }

  let data = { products: [] };
  let current = '';

  const product = () => data.products.find(p => p.id === current) || data.products[0];

  // ── rendering ───────────────────────────────────────────────────────────────────────
  function cardEl(it) {
    return el('article', { class: 'card', role: 'listitem' },
      el('h3', { class: 'card__title' }, it.title),
      it.description && el('p', { class: 'card__desc' }, it.description),
      it.tag && el('div', { class: 'card__foot' }, el('span', { class: 'tag', 'data-tone': it.tone }, it.tag)));
  }

  function render() {
    const p = product();
    const switcher = $('#products');
    switcher.replaceChildren(...data.products.map(x => el('button', { class: 'seg__btn', 'aria-pressed': String(x.id === p.id), onclick: () => select(x.id) }, x.name)));
    switcher.hidden = data.products.length < 2;

    let host = '';
    try { host = p.url ? new URL(p.url).host : ''; } catch {}
    const when = data.updatedAt ? new Date(data.updatedAt + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    $('#hero').replaceChildren(
      el('h1', {}, p.name),
      p.tagline && el('p', { class: 'hero__tag' }, p.tagline),
      el('div', { class: 'hero__meta' },
        p.url && el('a', { href: p.url, target: '_blank', rel: 'noopener' }, host),
        when && el('span', {}, 'Updated ' + when)));
    document.title = `${p.name} · Roadmap`;

    $('#cols').replaceChildren(...COLS.map(c => {
      const items = p[c.id];
      return el('section', { class: 'col', 'data-col': c.id },
        el('div', { class: 'col__head' },
          el('span', { class: 'col__dot' }),
          el('span', { class: 'col__title' }, c.label),
          el('span', { class: 'col__sub' }, c.sub),
          el('span', { class: 'col__count' }, String(items.length))),
        el('div', { class: 'col__list', role: 'list' },
          items.length ? items.map(cardEl) : el('div', { class: 'empty' }, 'Nothing planned here yet.')));
    }));
  }

  function select(id) {
    current = id;
    const u = new URL(location.href);
    u.searchParams.set('app', id);
    history.replaceState(null, '', u);
    render();
  }

  // ── theme (only colours change) ─────────────────────────────────────────────────────
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(LS_THEME, t); } catch {}
    $('#btn-theme').innerHTML = icon(t === 'dark' ? SUN : MOON);
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#09090b');
  }
  $('#btn-theme').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

  // ── start ───────────────────────────────────────────────────────────────────────────
  (async function init() {
    try {
      const r = await fetch(SRC, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      data = normalize(await r.json());
      if (!data.products.length) throw new Error('empty');
    } catch {
      $('#hero').replaceChildren(el('h1', {}, 'Roadmap'), el('p', { class: 'hero__tag' }, 'The roadmap couldn’t be loaded right now. Please try again in a moment.'));
      return;
    }
    const wanted = new URLSearchParams(location.search).get('app');
    current = data.products.some(p => p.id === wanted) ? wanted : data.products[0].id;
    render();
  })();
})();
