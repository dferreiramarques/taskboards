'use strict';
// Read-only viewer for a shared board. The board is an encrypted file on the owner's
// Drive; this page downloads it with a public API key (no sign-in), decrypts it in the
// browser with the passphrase, and shows the latest version.
(function () {
  const cfg      = window.TASKBOARDS_CONFIG || {};
  const API_KEY  = cfg.DRIVE_API_KEY || '';
  const API      = 'https://www.googleapis.com/drive/v3/files';
  const POLL_MS  = 30000;
  const fileId   = new URLSearchParams(location.search).get('b') || '';
  const SS_PASS  = 'taskboards-view-pass-' + fileId;
  const LS_THEME = 'taskboards-theme';

  const q = sel => document.querySelector(sel);
  const makeId = () => Math.random().toString(36).slice(2, 10);

  let passphrase = null;
  let key = null;          // derived once; reused while the owner keeps the same salt
  let salt = null;
  let modified = null;     // Drive modifiedTime of what we are showing
  let pollTimer = null;
  let busy = false;

  // ── theme (same preference as the app) ─────────────────────────────────────
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    q('#theme-icon').textContent = theme === 'dark' ? '☽' : '☀';
    try { localStorage.setItem(LS_THEME, theme); } catch {}
  }
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem(LS_THEME) || 'dark'; } catch {}
  applyTheme(savedTheme);
  q('#theme-btn').addEventListener('click', () =>
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  // ── gate states ────────────────────────────────────────────────────────────
  const status = msg => { q('#view-status').textContent = msg || ''; };
  function showGate({ title, sub, form }) {
    q('#view-gate').classList.remove('hidden');
    document.body.classList.add('locked');
    q('#view-gate .auth-gate__title').textContent = title;
    q('#view-gate .auth-gate__sub').textContent = sub;
    q('#view-pass').hidden = !form;
    q('#view-open').hidden = !form;
  }
  function showDead(title, sub) {
    clearInterval(pollTimer);
    showGate({ title, sub, form: false });
    status('');
  }

  // ── Drive (public file + API key, no sign-in) ──────────────────────────────
  async function getJson(url) {
    let r;
    try { r = await fetch(url, { cache: 'no-store' }); }
    catch { throw Object.assign(new Error('network'), { code: 'network' }); }
    if (!r.ok) throw Object.assign(new Error('http ' + r.status), { code: r.status === 404 || r.status === 403 ? 'gone' : 'http' });
    try { return await r.json(); }
    catch { throw Object.assign(new Error('bad-file'), { code: 'bad-file' }); }
  }

  async function fetchBoard(force) {
    const id = encodeURIComponent(fileId);
    const meta = await getJson(`${API}/${id}?fields=modifiedTime&key=${API_KEY}`);
    if (!force && meta.modifiedTime === modified) return null;   // nothing new
    const env = await getJson(`${API}/${id}?alt=media&key=${API_KEY}`);

    let payload;
    if (key && env.salt === salt) {
      payload = await TBShare.decryptWithKey(env, key);
    } else {
      const res = await TBShare.decrypt(env, passphrase);
      payload = res.payload;
      key = res.key;
      salt = env.salt;
    }
    modified = meta.modifiedTime;
    return payload;
  }

  // ── rendering (everything is set as text — never as HTML) ──────────────────
  const fmtDate = ds => { const [y, m, d] = ds.split('-'); return `${d}/${m}/${y}`; };
  function dateCls(ds) {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const diff = (new Date(ds + 'T00:00:00') - now) / 86400000;
    return diff < 0 ? 'overdue' : diff <= 3 ? 'soon' : '';
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function cardEl(card, compact) {
    const c = el('div', `card card--${card.status}`);
    if (compact) {
      c.appendChild(el('span', 'card__title-compact', card.title));
      if (card.owner) c.appendChild(el('span', 'card__owner-compact', card.owner));
      return c;
    }
    c.appendChild(el('h3', 'card__title', card.title));
    const meta = el('div', 'card__meta');
    meta.appendChild(card.owner ? el('span', 'card__owner', card.owner) : el('span'));
    if (card.dueDate) meta.appendChild(el('span', `card__date ${dateCls(card.dueDate)}`.trim(), fmtDate(card.dueDate)));
    c.appendChild(meta);
    return c;
  }

  function render(payload) {
    const cards = TBShare.cleanCards(payload.cards, makeId);
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 120) : 'Shared board';
    const when = new Date(Number(payload.publishedAt) || Date.now());

    q('#view-name').textContent = name;
    document.title = `${name} · Taskboards`;
    q('#view-meta').textContent = `Read-only · updated ${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    for (const zone of ['todo', 'inprogress', 'archive', 'done']) {
      const list = cards.filter(c => c.status === zone).sort((a, b) => (a.sortOrder ?? a.createdAt) - (b.sortOrder ?? b.createdAt));
      const box = q(`#${zone}-cards`);
      box.replaceChildren();
      const compact = zone === 'archive' || zone === 'done';
      list.forEach(c => box.appendChild(cardEl(c, compact)));
      if (!list.length) box.appendChild(el('div', 'column__empty', 'Nothing here'));
      q(`#${zone}-count`).textContent = String(list.length);
    }

    q('#view-gate').classList.add('hidden');
    document.body.classList.remove('locked');
  }

  // ── flow ───────────────────────────────────────────────────────────────────
  function failure(err, interactive) {
    if (err.message === 'bad-passphrase') {
      key = null; salt = null;
      try { sessionStorage.removeItem(SS_PASS); } catch {}
      if (interactive) return status('Wrong passphrase — check it and try again.');
      return showGate({ title: 'Passphrase changed', sub: 'The owner changed this board’s passphrase. Enter the new one to keep viewing.', form: true });
    }
    if (err.code === 'gone') return showDead('No longer shared', 'The owner has stopped sharing this board, or the link is not valid.');
    if (err.message === 'bad-file' || err.code === 'bad-file') return showDead('Not a shared board', 'This link doesn’t point to a shared Taskboards board.');
    if (interactive) return status('Couldn’t reach Google Drive — check your connection and try again.');
    // background refresh: stay quiet, keep showing the last version
  }

  async function open(pass, interactive) {
    if (busy) return;
    busy = true;
    q('#view-open').disabled = true;
    status(interactive ? 'Decrypting…' : '');
    try {
      passphrase = pass;
      const payload = await fetchBoard(true);
      try { sessionStorage.setItem(SS_PASS, pass); } catch {}
      render(payload);
      clearInterval(pollTimer);
      pollTimer = setInterval(refresh, POLL_MS);
    } catch (err) { failure(err, interactive); }
    finally { busy = false; q('#view-open').disabled = false; }
  }

  async function refresh() {
    if (busy || document.hidden || !passphrase) return;
    busy = true;
    try {
      const payload = await fetchBoard(false);
      if (payload) render(payload);
    } catch (err) { failure(err, false); }
    finally { busy = false; }
  }

  q('#view-form').addEventListener('submit', e => {
    e.preventDefault();
    const pass = TBShare.normalizePassphrase(q('#view-pass').value);
    if (!pass) return status('Enter the passphrase first.');
    open(pass, true);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  // ── start ──────────────────────────────────────────────────────────────────
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) {
    showDead('Invalid link', 'This link is missing or incomplete — ask the owner to send it again.');
  } else if (!API_KEY) {
    showDead('Not available', 'Board sharing isn’t configured on this site.');
  } else {
    let saved = null;
    try { saved = sessionStorage.getItem(SS_PASS); } catch {}
    if (saved) open(saved, false);
    else q('#view-pass').focus();
  }
})();
