'use strict';

// ─── STATE ───────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'taskboard-v1-cards';

let cards = loadCards();
let dragState = null;          // { cardId, startX, startY, moved, ghost, sourceEl }
let longPressTimer = null;
let deleteCardId = null;       // card currently in delete-mode
let archiveExpanded = false;
let doneExpanded = false;
let selectedColumn = 'todo';

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
function loadCards() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}

function saveCards() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── CARD CRUD ────────────────────────────────────────────────────────────────
function createCard(title, owner, dueDate, status) {
  const card = { id: uid(), title: title.trim(), owner: owner.trim(), dueDate, status, createdAt: Date.now() };
  cards.push(card);
  saveCards();
  render();
}

function deleteCard(id) {
  cards = cards.filter(c => c.id !== id);
  deleteCardId = null;
  saveCards();
  render();
}

function moveCard(id, newStatus) {
  const card = cards.find(c => c.id === id);
  if (card && card.status !== newStatus) {
    card.status = newStatus;
    saveCards();
    render();
  }
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function render() {
  const zones = { todo: [], inprogress: [], archive: [], done: [] };
  cards.forEach(c => { if (zones[c.status]) zones[c.status].push(c); });

  renderZone('todo-cards',       zones.todo,       'todo',       false);
  renderZone('inprogress-cards', zones.inprogress,  'inprogress', false);
  renderZone('archive-cards',    zones.archive,     'archive',    true);
  renderZone('done-cards',       zones.done,        'done',       true);

  // Counts
  q('#todo-count').textContent       = zones.todo.length;
  q('#inprogress-count').textContent = zones.inprogress.length;
  q('#archive-count').textContent    = zones.archive.length;
  q('#done-count').textContent       = zones.done.length;

  // Empty states
  setVisible('#todo-empty',      zones.todo.length === 0);
  setVisible('#inprogress-empty', zones.inprogress.length === 0);
  setVisible('#archive-empty',   zones.archive.length === 0);
  setVisible('#done-empty',      zones.done.length === 0);
}

function renderZone(containerId, zoneCards, status, compact) {
  const container = q('#' + containerId);
  // Remove all card elements, keep .column__empty / .shelf__empty
  Array.from(container.querySelectorAll('.card')).forEach(el => el.remove());

  zoneCards.forEach(card => {
    const el = buildCardElement(card, compact);
    container.appendChild(el);
    // Restore delete mode if this card was in delete mode
    if (card.id === deleteCardId) el.classList.add('delete-mode');
  });
}

function buildCardElement(card, compact) {
  const el = document.createElement('div');
  el.className = `card card--${card.status}`;
  el.dataset.id = card.id;
  el.setAttribute('touch-action', 'none');

  if (compact) {
    el.innerHTML = `
      <div class="card__delete-btn" data-delete="${card.id}">✕</div>
      <span class="card__title-compact">${esc(card.title)}</span>
      ${card.owner ? `<span class="card__owner-compact">${esc(card.owner)}</span>` : ''}
    `;
  } else {
    const dateStr = formatDate(card.dueDate);
    const dateClass = getDateClass(card.dueDate);
    el.innerHTML = `
      <div class="card__delete-btn" data-delete="${card.id}">✕</div>
      <h3 class="card__title">${esc(card.title)}</h3>
      <div class="card__meta">
        ${card.owner ? `<span class="card__owner">${esc(card.owner)}</span>` : '<span></span>'}
        ${card.dueDate ? `<span class="card__date ${dateClass}">${dateStr}</span>` : ''}
      </div>
    `;
  }

  attachCardEvents(el);
  return el;
}

// ─── POINTER / DRAG LOGIC ─────────────────────────────────────────────────────
const DRAG_THRESHOLD = 7;    // px before drag activates
const LONG_PRESS_MS  = 2000; // ms

function attachCardEvents(el) {
  el.addEventListener('pointerdown', onCardPointerDown, { passive: false });
  el.querySelector('.card__delete-btn').addEventListener('pointerdown', onDeleteBtnDown, { passive: false });
}

function onDeleteBtnDown(e) {
  e.stopPropagation();
}

function onCardPointerDown(e) {
  // Don't initiate on delete button clicks
  if (e.target.closest('.card__delete-btn')) return;

  const cardEl = e.currentTarget;
  const id = cardEl.dataset.id;

  // If another card is in delete mode, dismiss it
  if (deleteCardId && deleteCardId !== id) {
    dismissDeleteMode();
    return;
  }

  // If this card already in delete mode, do nothing (let btn handle it)
  if (deleteCardId === id) return;

  e.preventDefault();
  cardEl.setPointerCapture(e.pointerId);

  dragState = {
    cardId: id,
    startX: e.clientX,
    startY: e.clientY,
    pointerId: e.pointerId,
    moved: false,
    dragging: false,
    ghost: null,
    sourceEl: cardEl,
    currentZone: null
  };

  // Start long press ring
  startPressRing(e.clientX, e.clientY);
  longPressTimer = setTimeout(() => activateDeleteMode(id), LONG_PRESS_MS);

  cardEl.addEventListener('pointermove', onCardPointerMove);
  cardEl.addEventListener('pointerup',   onCardPointerUp);
  cardEl.addEventListener('pointercancel', onCardPointerCancel);
}

function onCardPointerMove(e) {
  if (!dragState) return;

  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  const dist = Math.hypot(dx, dy);

  if (!dragState.dragging && dist > DRAG_THRESHOLD) {
    // Cancel long press, start drag
    cancelLongPress();
    dragState.moved = true;
    dragState.dragging = true;
    startDragGhost(dragState.cardId, dragState.sourceEl, e.clientX, e.clientY);
    dragState.sourceEl.classList.add('dragging-source');
    document.body.classList.add('dragging-active');
  }

  if (dragState.dragging) {
    moveGhost(e.clientX, e.clientY);
    const zone = detectDropZone(e.clientX, e.clientY);
    highlightZone(zone);
    dragState.currentZone = zone;
  }
}

function onCardPointerUp(e) {
  if (!dragState) return;

  cancelLongPress();

  if (dragState.dragging) {
    finishDrag(dragState.cardId, dragState.currentZone);
  }

  cleanup(dragState.sourceEl);
  dragState = null;
}

function onCardPointerCancel(e) {
  if (!dragState) return;
  cancelLongPress();
  if (dragState.dragging) finishDrag(dragState.cardId, null);
  cleanup(dragState.sourceEl);
  dragState = null;
}

function cleanup(sourceEl) {
  if (sourceEl) {
    sourceEl.classList.remove('dragging-source');
    sourceEl.removeEventListener('pointermove', onCardPointerMove);
    sourceEl.removeEventListener('pointerup',   onCardPointerUp);
    sourceEl.removeEventListener('pointercancel', onCardPointerCancel);
  }
  destroyGhost();
  clearAllZoneHighlights();
  document.body.classList.remove('dragging-active');
}

// ─── DRAG GHOST ───────────────────────────────────────────────────────────────
function startDragGhost(id, sourceEl, x, y) {
  const card = cards.find(c => c.id === id);
  if (!card) return;

  const ghost = q('#drag-ghost');
  ghost.innerHTML = `
    <div class="drag-ghost__title">${esc(card.title)}</div>
    ${card.owner ? `<div class="drag-ghost__owner">${esc(card.owner)}</div>` : ''}
  `;
  ghost.style.left = (x - 80) + 'px';
  ghost.style.top  = (y - 30) + 'px';
  ghost.classList.add('visible');
  dragState.ghost = ghost;
}

function moveGhost(x, y) {
  const ghost = q('#drag-ghost');
  ghost.style.left = (x - 80) + 'px';
  ghost.style.top  = (y - 30) + 'px';
}

function destroyGhost() {
  const ghost = q('#drag-ghost');
  ghost.classList.remove('visible');
}

// ─── DROP ZONE DETECTION ──────────────────────────────────────────────────────
const ZONES = ['archive', 'todo', 'inprogress', 'done'];

function detectDropZone(x, y) {
  for (const zone of ZONES) {
    const el = getZoneEl(zone);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return zone;
  }
  return null;
}

function getZoneEl(zone) {
  if (zone === 'archive')    return q('#archive-bar');
  if (zone === 'todo')       return q('#todo-column');
  if (zone === 'inprogress') return q('#inprogress-column');
  if (zone === 'done')       return q('#done-bar');
  return null;
}

function highlightZone(zone) {
  clearAllZoneHighlights();
  if (zone) getZoneEl(zone)?.classList.add('drag-over');
}

function clearAllZoneHighlights() {
  ZONES.forEach(z => getZoneEl(z)?.classList.remove('drag-over'));
}

function finishDrag(cardId, zone) {
  if (zone) moveCard(cardId, zone);
}

// ─── LONG PRESS / DELETE MODE ─────────────────────────────────────────────────
function startPressRing(x, y) {
  const ring = q('#press-ring');
  const fill = q('#press-ring-fill');
  ring.style.left = x + 'px';
  ring.style.top  = y + 'px';
  ring.classList.remove('hidden');
  // Reset then trigger animation
  fill.style.transition = 'none';
  fill.style.strokeDashoffset = '100.53';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.transition = `stroke-dashoffset ${LONG_PRESS_MS}ms linear`;
      fill.style.strokeDashoffset = '0';
    });
  });
}

function hidePressRing() {
  const ring = q('#press-ring');
  const fill = q('#press-ring-fill');
  ring.classList.add('hidden');
  fill.style.transition = 'none';
  fill.style.strokeDashoffset = '100.53';
}

function cancelLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  hidePressRing();
}

function activateDeleteMode(id) {
  hidePressRing();
  deleteCardId = id;
  const el = document.querySelector(`.card[data-id="${id}"]`);
  if (el) {
    el.classList.add('delete-mode');
    // Wire up the delete button click
    const btn = el.querySelector('.card__delete-btn');
    btn.addEventListener('click', () => deleteCard(id), { once: true });
  }
  longPressTimer = null;
}

function dismissDeleteMode() {
  if (!deleteCardId) return;
  const el = document.querySelector(`.card[data-id="${deleteCardId}"]`);
  if (el) el.classList.remove('delete-mode');
  deleteCardId = null;
}

// Clicking anywhere else dismisses delete mode
document.addEventListener('pointerdown', (e) => {
  if (!deleteCardId) return;
  const card = e.target.closest('.card');
  if (!card || card.dataset.id !== deleteCardId) {
    dismissDeleteMode();
  }
});

// ─── ARCHIVE / DONE EXPAND ───────────────────────────────────────────────────
q('#archive-toggle').addEventListener('click', () => {
  archiveExpanded = !archiveExpanded;
  q('#archive-bar').classList.toggle('expanded', archiveExpanded);
  q('#archive-chevron').style.transform = archiveExpanded ? 'rotate(180deg)' : '';
});

q('#done-toggle').addEventListener('click', () => {
  doneExpanded = !doneExpanded;
  q('#done-bar').classList.toggle('expanded', doneExpanded);
});

// ─── MODAL ────────────────────────────────────────────────────────────────────
q('#fab').addEventListener('click', openModal);
q('#modal-close').addEventListener('click', closeModal);
q('#modal-overlay').addEventListener('click', (e) => { if (e.target === q('#modal-overlay')) closeModal(); });

q('#modal').querySelectorAll('.modal__toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    q('#modal').querySelectorAll('.modal__toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedColumn = btn.dataset.col;
  });
});

q('#modal-submit').addEventListener('click', submitCard);

q('#input-title').addEventListener('keydown', (e) => {
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

function closeModal() {
  q('#modal-overlay').classList.add('hidden');
}

function submitCard() {
  const title = q('#input-title').value.trim();
  if (!title) { q('#input-title').focus(); shake(q('#input-title')); return; }
  const owner   = q('#input-owner').value;
  const dueDate = q('#input-date').value;
  createCard(title, owner, dueDate, selectedColumn);
  closeModal();
}

function shake(el) {
  el.style.animation = 'none';
  requestAnimationFrame(() => {
    el.style.animation = 'shake .3s ease';
  });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function q(sel) { return document.querySelector(sel); }

function esc(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setVisible(sel, visible) {
  const el = q(sel);
  if (el) el.style.display = visible ? '' : 'none';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function getDateClass(dateStr) {
  if (!dateStr) return '';
  const now = new Date(); now.setHours(0,0,0,0);
  const due = new Date(dateStr + 'T00:00:00');
  const diff = (due - now) / 86400000;
  if (diff < 0)  return 'overdue';
  if (diff <= 3) return 'soon';
  return '';
}

// ─── SERVICE WORKER ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ─── KEYBOARD ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!q('#modal-overlay').classList.contains('hidden')) { closeModal(); return; }
    dismissDeleteMode();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') openModal();
});

// ─── INIT ─────────────────────────────────────────────────────────────────────
render();
