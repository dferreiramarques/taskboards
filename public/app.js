'use strict';

// ─── STATE ───────────────────────────────────────────────────────────────────
const STORAGE_KEY   = 'taskboard-v2-cards';
const THEME_KEY     = 'taskboard-theme';

let cards           = loadCards();
let dragState       = null;
let longPressTimer  = null;
let deleteCardId    = null;
let archiveExpanded = false;
let doneExpanded    = false;
let selectedColumn  = 'todo';

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
function loadCards() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function saveCards() { localStorage.setItem(STORAGE_KEY, JSON.stringify(cards)); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ─── THEME ───────────────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved, false);
}

function applyTheme(theme, animate = true) {
  document.documentElement.setAttribute('data-theme', theme);
  q('#theme-icon').textContent = theme === 'dark' ? '☽' : '☀';
  localStorage.setItem(THEME_KEY, theme);
  // Update PWA meta
  const mc = document.querySelector('meta[name="theme-color"]');
  if (mc) mc.setAttribute('content', theme === 'dark' ? '#0e0e16' : '#f3f0e8');
  if (animate) {
    const btn = q('#theme-btn');
    btn.style.animation = 'none';
    requestAnimationFrame(() => { btn.style.animation = ''; });
  }
}

q('#theme-btn').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
  burstParticles(q('#theme-btn'));
});

// ─── HELP MODAL ──────────────────────────────────────────────────────────────
q('#help-btn').addEventListener('click',  () => q('#help-overlay').classList.remove('hidden'));
q('#help-close').addEventListener('click', () => q('#help-overlay').classList.add('hidden'));
q('#help-overlay').addEventListener('click', e => {
  if (e.target === q('#help-overlay')) q('#help-overlay').classList.add('hidden');
});

// ─── CARD CRUD ────────────────────────────────────────────────────────────────
function createCard(title, owner, dueDate, status) {
  const card = { id: uid(), title: title.trim(), owner: owner.trim(), dueDate, status, createdAt: Date.now() };
  cards.push(card);
  saveCards();
  render();
  // Animate the new card after render
  requestAnimationFrame(() => {
    const el = document.querySelector(`.card[data-id="${card.id}"]`);
    if (el) { el.classList.add('card--entering'); el.addEventListener('animationend', () => el.classList.remove('card--entering'), { once: true }); }
  });
}

function deleteCard(id) {
  const el = document.querySelector(`.card[data-id="${id}"]`);
  if (el) {
    el.style.transition = 'transform .2s ease, opacity .2s ease';
    el.style.transform  = 'scale(0.7)';
    el.style.opacity    = '0';
    setTimeout(() => {
      cards = cards.filter(c => c.id !== id);
      deleteCardId = null;
      saveCards();
      render();
    }, 200);
  } else {
    cards = cards.filter(c => c.id !== id);
    deleteCardId = null;
    saveCards();
    render();
  }
}

function moveCard(id, newStatus) {
  const card = cards.find(c => c.id === id);
  if (!card || card.status === newStatus) return;
  card.status = newStatus;
  saveCards();
  render();
  if (newStatus === 'done') {
    setTimeout(() => launchConfetti(), 80);
  }
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function render() {
  const zones = { todo: [], inprogress: [], archive: [], done: [] };
  cards.forEach(c => { if (zones[c.status]) zones[c.status].push(c); });

  // Sort by creation date
  Object.values(zones).forEach(z => z.sort((a, b) => a.createdAt - b.createdAt));

  renderZone('todo-cards',       zones.todo,       false);
  renderZone('inprogress-cards', zones.inprogress, false);
  renderZone('archive-cards',    zones.archive,    true);
  renderZone('done-cards',       zones.done,       true);

  q('#todo-count').textContent       = zones.todo.length;
  q('#inprogress-count').textContent = zones.inprogress.length;
  q('#archive-count').textContent    = zones.archive.length;
  q('#done-count').textContent       = zones.done.length;

  vis('#todo-empty',       zones.todo.length === 0);
  vis('#inprogress-empty', zones.inprogress.length === 0);
  vis('#archive-empty',    zones.archive.length === 0);
  vis('#done-empty',       zones.done.length === 0);
}

function renderZone(containerId, zoneCards, compact) {
  const container = q('#' + containerId);
  Array.from(container.querySelectorAll('.card')).forEach(el => el.remove());
  zoneCards.forEach(card => container.appendChild(buildCardEl(card, compact)));
}

function buildCardEl(card, compact) {
  const el = document.createElement('div');
  el.className = `card card--${card.status}`;
  el.dataset.id = card.id;

  if (compact) {
    el.innerHTML = `
      <div class="card__delete-btn" tabindex="-1">✕</div>
      <span class="card__title-compact">${esc(card.title)}</span>
      ${card.owner ? `<span class="card__owner-compact">${esc(card.owner)}</span>` : ''}
    `;
  } else {
    const dc = getDateClass(card.dueDate);
    el.innerHTML = `
      <div class="card__delete-btn" tabindex="-1">✕</div>
      <h3 class="card__title">${esc(card.title)}</h3>
      <div class="card__meta">
        ${card.owner ? `<span class="card__owner">${esc(card.owner)}</span>` : '<span></span>'}
        ${card.dueDate ? `<span class="card__date ${dc}">${fmtDate(card.dueDate)}</span>` : ''}
      </div>
    `;
  }

  if (card.id === deleteCardId) el.classList.add('delete-mode');
  attachCardEvents(el);
  return el;
}

// ─── DRAG & LONG PRESS ────────────────────────────────────────────────────────
const DRAG_THRESHOLD = 8;
const LONG_PRESS_MS  = 2000;

function attachCardEvents(el) {
  el.addEventListener('pointerdown', onCardDown, { passive: false });
  el.querySelector('.card__delete-btn').addEventListener('pointerdown', e => e.stopPropagation());
  el.querySelector('.card__delete-btn').addEventListener('click', e => {
    e.stopPropagation();
    const id = el.dataset.id;
    if (deleteCardId === id) deleteCard(id);
  });
}

function onCardDown(e) {
  if (e.target.closest('.card__delete-btn')) return;
  const cardEl = e.currentTarget;
  const id = cardEl.dataset.id;

  if (deleteCardId && deleteCardId !== id) { dismissDelete(); return; }
  if (deleteCardId === id) return;

  e.preventDefault();
  cardEl.setPointerCapture(e.pointerId);

  dragState = { cardId: id, startX: e.clientX, startY: e.clientY, dragging: false, sourceEl: cardEl, currentZone: null };

  startRing(e.clientX, e.clientY);
  longPressTimer = setTimeout(() => activateDelete(id), LONG_PRESS_MS);

  cardEl.addEventListener('pointermove', onCardMove);
  cardEl.addEventListener('pointerup',   onCardUp);
  cardEl.addEventListener('pointercancel', onCardCancel);
}

function onCardMove(e) {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;

  if (!dragState.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
    cancelLP();
    dragState.dragging = true;
    dragState.sourceEl.classList.add('dragging-source');
    document.body.classList.add('dragging-active');
    showGhost(dragState.cardId, e.clientX, e.clientY);
  }

  if (dragState.dragging) {
    moveGhost(e.clientX, e.clientY);
    const z = detectZone(e.clientX, e.clientY);
    highlightZone(z);
    dragState.currentZone = z;
  }
}

function onCardUp(e) {
  if (!dragState) return;
  cancelLP();
  if (dragState.dragging && dragState.currentZone) moveCard(dragState.cardId, dragState.currentZone);
  cleanupDrag(dragState.sourceEl);
  dragState = null;
}

function onCardCancel(e) {
  if (!dragState) return;
  cancelLP();
  cleanupDrag(dragState.sourceEl);
  dragState = null;
}

function cleanupDrag(el) {
  if (el) {
    el.classList.remove('dragging-source');
    el.removeEventListener('pointermove', onCardMove);
    el.removeEventListener('pointerup',   onCardUp);
    el.removeEventListener('pointercancel', onCardCancel);
  }
  hideGhost();
  clearZones();
  document.body.classList.remove('dragging-active');
}

// ─── GHOST ───────────────────────────────────────────────────────────────────
function showGhost(id, x, y) {
  const card = cards.find(c => c.id === id);
  if (!card) return;
  const g = q('#drag-ghost');
  g.innerHTML = `<div class="drag-ghost__title">${esc(card.title)}</div>${card.owner ? `<div class="drag-ghost__owner">${esc(card.owner)}</div>` : ''}`;
  g.style.left = (x - 75) + 'px';
  g.style.top  = (y - 28) + 'px';
  g.classList.add('visible');
}
function moveGhost(x, y) {
  const g = q('#drag-ghost');
  g.style.left = (x - 75) + 'px';
  g.style.top  = (y - 28) + 'px';
}
function hideGhost() { q('#drag-ghost').classList.remove('visible'); }

// ─── ZONES ───────────────────────────────────────────────────────────────────
const ZONES = ['archive', 'todo', 'inprogress', 'done'];
const ZONE_EL = { archive: '#archive-bar', todo: '#todo-column', inprogress: '#inprogress-column', done: '#done-bar' };

function detectZone(x, y) {
  for (const z of ZONES) {
    const r = q(ZONE_EL[z])?.getBoundingClientRect();
    if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return z;
  }
  return null;
}

function highlightZone(zone) {
  clearZones();
  if (zone) q(ZONE_EL[zone])?.classList.add('drag-over');
}
function clearZones() { ZONES.forEach(z => q(ZONE_EL[z])?.classList.remove('drag-over')); }

// ─── LONG PRESS RING ──────────────────────────────────────────────────────────
function startRing(x, y) {
  const ring = q('#press-ring'), fill = q('#press-ring-fill');
  ring.style.left = x + 'px';
  ring.style.top  = y + 'px';
  ring.classList.remove('hidden');
  fill.style.transition = 'none';
  fill.style.strokeDashoffset = '113.1';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fill.style.transition = `stroke-dashoffset ${LONG_PRESS_MS}ms linear`;
    fill.style.strokeDashoffset = '0';
  }));
}

function hideRing() {
  const ring = q('#press-ring'), fill = q('#press-ring-fill');
  ring.classList.add('hidden');
  fill.style.transition = 'none';
  fill.style.strokeDashoffset = '113.1';
}

function cancelLP() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  hideRing();
}

function activateDelete(id) {
  hideRing();
  deleteCardId = id;
  longPressTimer = null;
  const el = document.querySelector(`.card[data-id="${id}"]`);
  if (el) el.classList.add('delete-mode');
}

function dismissDelete() {
  if (!deleteCardId) return;
  const el = document.querySelector(`.card[data-id="${deleteCardId}"]`);
  if (el) el.classList.remove('delete-mode');
  deleteCardId = null;
}

document.addEventListener('pointerdown', e => {
  if (!deleteCardId) return;
  const card = e.target.closest('.card');
  if (!card || card.dataset.id !== deleteCardId) dismissDelete();
});

// ─── SHELF EXPAND/COLLAPSE ────────────────────────────────────────────────────
q('#archive-toggle').addEventListener('click', () => {
  archiveExpanded = !archiveExpanded;
  q('#archive-bar').classList.toggle('expanded', archiveExpanded);
});

q('#done-toggle').addEventListener('click', () => {
  doneExpanded = !doneExpanded;
  q('#done-bar').classList.toggle('expanded', doneExpanded);
});

// ─── NEW CARD MODAL ───────────────────────────────────────────────────────────
q('#fab').addEventListener('click', openModal);
q('#modal-close').addEventListener('click', closeModal);
q('#modal-overlay').addEventListener('click', e => { if (e.target === q('#modal-overlay')) closeModal(); });

q('#modal').querySelectorAll('.modal__toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    q('#modal').querySelectorAll('.modal__toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedColumn = btn.dataset.col;
  });
});

q('#modal-submit').addEventListener('click', submitCard);
q('#input-title').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitCard();
  if (e.key === 'Escape') closeModal();
});

function openModal() {
  q('#modal-overlay').classList.remove('hidden');
  q('#input-title').value = '';
  q('#input-owner').value = '';
  q('#input-date').value  = '';
  selectedColumn = 'todo';
  q('#modal').querySelectorAll('.modal__toggle-btn').forEach(b => b.classList.remove('active'));
  q('[data-col="todo"]').classList.add('active');
  setTimeout(() => q('#input-title').focus(), 80);
}

function closeModal() { q('#modal-overlay').classList.add('hidden'); }

function submitCard() {
  const title = q('#input-title').value.trim();
  if (!title) { shakeEl(q('#input-title')); return; }
  createCard(title, q('#input-owner').value, q('#input-date').value, selectedColumn);
  closeModal();
}

function shakeEl(el) {
  el.style.animation = 'none';
  requestAnimationFrame(() => { el.style.animation = 'delete-shake .35s ease'; });
}

// ─── CONFETTI ────────────────────────────────────────────────────────────────
const CONFETTI_COLORS = ['#f0c040','#4f9cf9','#fb923c','#a855f7','#34d399','#f87171','#fbbf24'];

function launchConfetti() {
  const layer = q('#confetti-layer');
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight * 0.7;
  const count = 28;

  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    const size  = 6 + Math.random() * 8;
    const angle = (Math.random() * 360) * (Math.PI / 180);
    const speed = 80 + Math.random() * 140;
    const vx    = Math.cos(angle) * speed;
    const vy    = -Math.abs(Math.sin(angle)) * speed - 40;
    const dur   = 0.9 + Math.random() * 0.6;

    piece.style.cssText = `
      left: ${cx + vx * 0.05}px;
      top:  ${cy + vy * 0.05}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${Math.random() > .5 ? '50%' : '2px'};
      animation-duration: ${dur}s;
      animation-delay: ${i * 0.025}s;
    `;

    layer.appendChild(piece);
    piece.addEventListener('animationend', () => piece.remove(), { once: true });
  }
}

// ─── MINI BURST (theme toggle) ────────────────────────────────────────────────
function burstParticles(el) {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top  + r.height / 2;
  const layer = q('#confetti-layer');

  for (let i = 0; i < 10; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    const angle = (i / 10) * Math.PI * 2;
    p.style.cssText = `
      left: ${cx}px; top: ${cy}px;
      width: 5px; height: 5px;
      background: ${CONFETTI_COLORS[i % CONFETTI_COLORS.length]};
      border-radius: 50%;
      animation-duration: .6s;
      animation-delay: ${i * 0.03}s;
    `;
    layer.appendChild(p);
    p.addEventListener('animationend', () => p.remove(), { once: true });
  }
}

// ─── FLOATING PARTICLES ──────────────────────────────────────────────────────
const FLOAT_CHARS = ['✦','◆','●','◈','○','◑','✓','◇','▲','△','◻','✧'];

function spawnParticle() {
  const container = q('#particles');
  const el = document.createElement('span');
  el.className = 'particle';
  el.textContent = FLOAT_CHARS[Math.floor(Math.random() * FLOAT_CHARS.length)];
  el.style.left   = Math.random() * 100 + 'vw';
  el.style.bottom = '-20px';
  const dur  = 18 + Math.random() * 22;
  const size = 10 + Math.random() * 10;
  el.style.fontSize         = size + 'px';
  el.style.animationDuration = dur + 's';
  el.style.animationDelay   = (Math.random() * -dur) + 's';
  el.style.color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
  container.appendChild(el);
  setTimeout(() => el.remove(), (dur + 2) * 1000);
}

// Seed initial particles
for (let i = 0; i < 12; i++) spawnParticle();
setInterval(spawnParticle, 3000);

// ─── KEYBOARD ────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!q('#modal-overlay').classList.contains('hidden')) { closeModal(); return; }
    if (!q('#help-overlay').classList.contains('hidden'))  { q('#help-overlay').classList.add('hidden'); return; }
    dismissDelete();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') openModal();
});

// ─── UTILS ───────────────────────────────────────────────────────────────────
function q(sel) { return document.querySelector(sel); }

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function vis(sel, show) {
  const el = q(sel);
  if (el) el.style.display = show ? '' : 'none';
}

function fmtDate(ds) {
  if (!ds) return '';
  const [y, m, d] = ds.split('-');
  return `${d}/${m}/${y}`;
}

function getDateClass(ds) {
  if (!ds) return '';
  const now = new Date(); now.setHours(0,0,0,0);
  const due = new Date(ds + 'T00:00:00');
  const diff = (due - now) / 86400000;
  if (diff < 0) return 'overdue';
  if (diff <= 3) return 'soon';
  return '';
}

// ─── SERVICE WORKER ──────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ─── INIT ────────────────────────────────────────────────────────────────────
initTheme();
render();
