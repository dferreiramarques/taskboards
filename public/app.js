'use strict';

// ─── CONFIG & CONSTANTS ───────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID  = (window.TASKBOARDS_CONFIG || {}).GOOGLE_CLIENT_ID || '';
const DRIVE_SCOPE       = 'https://www.googleapis.com/auth/drive.appdata openid email profile';
const DRIVE_FILENAME    = 'taskboards-data.json';
const DRIVE_FOLDER      = 'appDataFolder';
const DRIVE_API         = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API  = 'https://www.googleapis.com/upload/drive/v3';

const LS_BOARDS    = 'taskboards-v1-boards';
const LS_CURRENT   = 'taskboards-v1-current';
const LS_THEME     = 'taskboards-theme';
const LS_OWNERS    = 'taskboards-owners';
const LS_DRIVE_FID = 'taskboards-drive-fileid';

const TABS_PER_PAGE   = 4;
const DRAG_THRESHOLD  = 8;
const LONG_PRESS_MS   = 2000;
const SAVE_DEBOUNCE   = 1800;  // ms after last change before Drive save

// ─── STATE ───────────────────────────────────────────────────────────────────
let boards         = [];       // [{id, name, cards:[]}]
let currentBoardId = null;
let tabPage        = 0;
let archiveExpanded = false;
let doneExpanded    = false;
let selectedColumn  = 'todo';
let dragState       = null;
let longPressTimer  = null;
let deleteCardId    = null;

// Auth state
let gAccessToken   = null;
let gUser          = null;     // {name, email, picture}
let driveFileId    = localStorage.getItem(LS_DRIVE_FID) || null;
let saveTimer      = null;
let tokenClient    = null;

// ─── UTILS ───────────────────────────────────────────────────────────────────
const q    = sel => document.querySelector(sel);
const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc  = s  => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const vis  = (sel, show) => { const e = q(sel); if (e) e.style.display = show ? '' : 'none'; };
const fmtDate   = ds => { if (!ds) return ''; const [y,m,d]=ds.split('-'); return `${d}/${m}/${y}`; };
const getDateCls = ds => {
  if (!ds) return '';
  const now = new Date(); now.setHours(0,0,0,0);
  const diff = (new Date(ds+'T00:00:00') - now) / 86400000;
  return diff < 0 ? 'overdue' : diff <= 3 ? 'soon' : '';
};

// ─── BOARD HELPERS ────────────────────────────────────────────────────────────
function currentBoard() { return boards.find(b => b.id === currentBoardId) || boards[0]; }
function currentCards() { return currentBoard()?.cards || []; }

function defaultBoard() {
  return { id: uid(), name: 'Board 1', cards: [], createdAt: Date.now() };
}

// ─── LOCAL STORAGE ────────────────────────────────────────────────────────────
function loadFromLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_BOARDS));
    if (Array.isArray(raw) && raw.length > 0) return raw;
  } catch {}
  return [defaultBoard()];
}

function saveToLocal() {
  localStorage.setItem(LS_BOARDS, JSON.stringify(boards));
  localStorage.setItem(LS_CURRENT, currentBoardId);
}

// ─── OWNER HISTORY ────────────────────────────────────────────────────────────
function loadOwners() {
  try { return JSON.parse(localStorage.getItem(LS_OWNERS)) || []; } catch { return []; }
}
function saveOwner(name) {
  if (!name?.trim()) return;
  const owners = loadOwners();
  const t = name.trim();
  if (!owners.includes(t)) {
    owners.unshift(t);
    if (owners.length > 20) owners.pop();
    localStorage.setItem(LS_OWNERS, JSON.stringify(owners));
  }
  refreshOwnerUI();
}
function refreshOwnerUI() {
  const dl = q('#owner-datalist'), chips = q('#owner-chips');
  const owners = loadOwners();
  if (dl) { dl.innerHTML = ''; owners.forEach(n => { const o=document.createElement('option'); o.value=n; dl.appendChild(o); }); }
  if (chips) {
    if (!owners.length) { chips.style.display='none'; return; }
    chips.style.display = 'flex';
    chips.innerHTML = '';
    owners.slice(0,6).forEach(name => {
      const chip = document.createElement('button');
      chip.type='button'; chip.className='owner-chip'; chip.textContent=name;
      chip.onclick = () => {
        q('#input-owner').value = name;
        chips.querySelectorAll('.owner-chip').forEach(c=>c.classList.remove('active'));
        chip.classList.add('active');
      };
      chips.appendChild(chip);
    });
  }
}

// ─── GOOGLE DRIVE ────────────────────────────────────────────────────────────
function driveHeaders() {
  return { 'Authorization': `Bearer ${gAccessToken}`, 'Content-Type': 'application/json' };
}

async function driveFindFile() {
  const r = await fetch(`${DRIVE_API}/files?spaces=${DRIVE_FOLDER}&fields=files(id,name)&q=name='${DRIVE_FILENAME}'`, { headers: driveHeaders() });
  const data = await r.json();
  return data.files?.[0]?.id || null;
}

async function driveLoadData() {
  setSyncStatus('syncing', 'Syncing…');
  try {
    let fid = driveFileId || await driveFindFile();
    if (!fid) { setSyncStatus('synced', 'Drive ready'); return null; }
    driveFileId = fid;
    localStorage.setItem(LS_DRIVE_FID, fid);
    const r = await fetch(`${DRIVE_API}/files/${fid}?alt=media`, { headers: driveHeaders() });
    if (!r.ok) throw new Error('fetch failed');
    const data = await r.json();
    setSyncStatus('synced', 'Synced');
    return data;
  } catch (err) {
    console.warn('Drive load error:', err);
    setSyncStatus('error', 'Sync error');
    return null;
  }
}

async function driveSaveData() {
  if (!gAccessToken) return;
  setSyncStatus('syncing', 'Saving…');
  const payload = JSON.stringify({ boards, currentBoardId, savedAt: Date.now() });
  try {
    let fid = driveFileId || await driveFindFile();
    let r;
    if (fid) {
      r = await fetch(`${DRIVE_UPLOAD_API}/files/${fid}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${gAccessToken}`, 'Content-Type': 'application/json' },
        body: payload
      });
    } else {
      // Create new file
      const meta = { name: DRIVE_FILENAME, parents: [DRIVE_FOLDER] };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(meta)], {type:'application/json'}));
      form.append('file', new Blob([payload], {type:'application/json'}));
      r = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${gAccessToken}` },
        body: form
      });
      const res = await r.json();
      driveFileId = res.id;
      localStorage.setItem(LS_DRIVE_FID, driveFileId);
    }
    if (r.ok) setSyncStatus('synced', 'Saved to Drive');
    else throw new Error('save failed');
  } catch (err) {
    console.warn('Drive save error:', err);
    setSyncStatus('error', 'Save failed');
  }
}

function scheduleDriveSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(driveSaveData, SAVE_DEBOUNCE);
}

function setSyncStatus(state, label) {
  const dot = q('#sync-dot'), lbl = q('#sync-label');
  if (dot) { dot.className = 'sync-dot ' + state; }
  if (lbl) lbl.textContent = label;
}

// ─── GOOGLE IDENTITY SERVICES ────────────────────────────────────────────────
function initGSI() {
  if (!GOOGLE_CLIENT_ID) {
    // Hide the sign-in button, show a subtle local-mode badge in its place
    q('#login-btn').style.display = 'none';
    const badge = document.createElement('span');
    badge.className = 'no-gsi-notice';
    badge.title = 'Add GOOGLE_CLIENT_ID in config.js to enable Google login';
    badge.textContent = '⬡ Local';
    q('#login-area').appendChild(badge);
    return;
  }

  // Wait for GSI library to load
  const waitGSI = setInterval(() => {
    if (!window.google?.accounts?.oauth2) return;
    clearInterval(waitGSI);

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: handleTokenResponse
    });
  }, 200);

  q('#login-btn').addEventListener('click', () => {
    if (!tokenClient) return;
    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

async function handleTokenResponse(resp) {
  if (resp.error) { console.error('GSI error:', resp.error); return; }
  gAccessToken = resp.access_token;

  // Fetch user profile
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${gAccessToken}` } });
    gUser = await r.json();
  } catch {}

  showUserPill();
  setSyncStatus('syncing', 'Loading…');

  // Load boards from Drive (merge with local if first time)
  const driveData = await driveLoadData();
  if (driveData?.boards?.length) {
    boards = driveData.boards;
    currentBoardId = driveData.currentBoardId || boards[0].id;
  }
  saveToLocal();
  renderTabs();
  renderBoard();
}

function showUserPill() {
  if (!gUser) return;
  q('#login-btn').style.display = 'none';
  const pill = q('#user-pill');
  pill.classList.remove('hidden');
  q('#user-avatar').src = gUser.picture || '';
  q('#user-name').textContent = gUser.given_name || gUser.name || 'User';
  q('#user-email-menu').textContent = gUser.email || '';
}

function handleLogout() {
  if (gAccessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(gAccessToken, () => {});
  }
  gAccessToken = null;
  gUser = null;
  driveFileId = null;
  localStorage.removeItem(LS_DRIVE_FID);

  q('#user-pill').classList.add('hidden');
  q('#login-btn').style.display = '';
  setSyncStatus('', 'Offline');
}

q('#logout-btn')?.addEventListener('click', handleLogout);

// ─── CHANGE HANDLER ───────────────────────────────────────────────────────────
function onDataChanged() {
  saveToLocal();
  if (gAccessToken) scheduleDriveSave();
}

// ─── BOARD CRUD ───────────────────────────────────────────────────────────────
function addBoard() {
  const idx = boards.length + 1;
  const b = { id: uid(), name: `Board ${idx}`, cards: [], createdAt: Date.now() };
  boards.push(b);
  currentBoardId = b.id;
  // Go to last tab page to show new board
  tabPage = Math.floor((boards.length - 1) / TABS_PER_PAGE);
  onDataChanged();
  renderTabs();
  renderBoard();
}

function deleteBoard(id) {
  if (boards.length <= 1) return;
  boards = boards.filter(b => b.id !== id);
  if (currentBoardId === id) currentBoardId = boards[Math.max(0, boards.length-1)].id;
  tabPage = Math.min(tabPage, Math.floor((boards.length-1)/TABS_PER_PAGE));
  onDataChanged();
  renderTabs();
  renderBoard();
}

function switchBoard(id) {
  if (currentBoardId === id) return;
  currentBoardId = id;
  archiveExpanded = false;
  doneExpanded    = false;
  q('#archive-bar').classList.remove('expanded');
  q('#done-bar').classList.remove('expanded');
  onDataChanged();
  renderTabs();
  renderBoard();
}

function renameBoard(id, name) {
  const b = boards.find(b => b.id === id);
  if (b) { b.name = name.trim() || b.name; onDataChanged(); }
}

// ─── CARD CRUD ────────────────────────────────────────────────────────────────
function createCard(title, owner, dueDate, status) {
  const card = { id: uid(), title: title.trim(), owner: owner.trim(), dueDate, status, createdAt: Date.now() };
  currentBoard().cards.push(card);
  saveOwner(owner);
  onDataChanged();
  renderBoard();
  requestAnimationFrame(() => {
    const el = document.querySelector(`.card[data-id="${card.id}"]`);
    if (el) { el.classList.add('card--entering'); el.addEventListener('animationend', () => el.classList.remove('card--entering'), {once:true}); }
  });
}

function deleteCard(id) {
  const el = document.querySelector(`.card[data-id="${id}"]`);
  const doDelete = () => {
    const cb = currentBoard();
    if (cb) cb.cards = cb.cards.filter(c => c.id !== id);
    deleteCardId = null;
    onDataChanged();
    renderBoard();
  };
  if (el) {
    el.style.transition = 'transform .2s ease, opacity .2s ease';
    el.style.transform  = 'scale(0.7)';
    el.style.opacity    = '0';
    setTimeout(doDelete, 200);
  } else doDelete();
}

function moveCard(id, newStatus) {
  const cb = currentBoard();
  const card = cb?.cards.find(c => c.id === id);
  if (!card || card.status === newStatus) return;
  card.status = newStatus;
  onDataChanged();
  renderBoard();
  if (newStatus === 'done') setTimeout(launchConfetti, 80);
}

// ─── RENDER: TABS ─────────────────────────────────────────────────────────────
function renderTabs() {
  const container = q('#boards-tabs');
  const prevBtn   = q('#tab-prev');
  const nextBtn   = q('#tab-next');
  container.innerHTML = '';

  const totalPages = Math.ceil(boards.length / TABS_PER_PAGE);
  tabPage = Math.max(0, Math.min(tabPage, totalPages - 1));

  const start = tabPage * TABS_PER_PAGE;
  const slice = boards.slice(start, start + TABS_PER_PAGE);

  slice.forEach(board => {
    const tab = document.createElement('div');
    tab.className = 'board-tab' + (board.id === currentBoardId ? ' active' : '');
    tab.dataset.id = board.id;
    tab.innerHTML = `
      <span class="board-tab__name">${esc(board.name)}</span>
      ${boards.length > 1 ? `<button class="board-tab__delete" title="Delete board">✕</button>` : ''}
    `;

    // Click to switch
    tab.addEventListener('click', e => {
      if (e.target.closest('.board-tab__delete')) return;
      if (e.target.closest('.board-tab__name-input')) return;
      switchBoard(board.id);
    });

    // Double-click name to rename
    const nameEl = tab.querySelector('.board-tab__name');
    nameEl.addEventListener('dblclick', e => {
      e.stopPropagation();
      startRename(tab, board.id, nameEl);
    });

    // Delete
    tab.querySelector('.board-tab__delete')?.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Delete board "${board.name}"? All cards will be lost.`)) deleteBoard(board.id);
    });

    container.appendChild(tab);
  });

  prevBtn.disabled = tabPage === 0;
  nextBtn.disabled = tabPage >= totalPages - 1;
  prevBtn.style.visibility = totalPages > 1 ? '' : 'hidden';
  nextBtn.style.visibility = totalPages > 1 ? '' : 'hidden';
}

function startRename(tab, boardId, nameEl) {
  const board = boards.find(b => b.id === boardId);
  if (!board) return;
  const input = document.createElement('input');
  input.className = 'board-tab__name-input';
  input.value = board.name;
  input.maxLength = 32;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const val = input.value.trim() || board.name;
    renameBoard(boardId, val);
    renderTabs();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = board.name; input.blur(); }
    e.stopPropagation();
  });
}

q('#tab-prev').addEventListener('click', () => { tabPage = Math.max(0, tabPage-1); renderTabs(); });
q('#tab-next').addEventListener('click', () => { tabPage = Math.min(Math.ceil(boards.length/TABS_PER_PAGE)-1, tabPage+1); renderTabs(); });
q('#add-board').addEventListener('click', addBoard);

// ─── RENDER: BOARD ────────────────────────────────────────────────────────────
function renderBoard() {
  const cards = currentCards();
  const zones = { todo:[], inprogress:[], archive:[], done:[] };
  cards.forEach(c => { if (zones[c.status]) zones[c.status].push(c); });
  Object.values(zones).forEach(z => z.sort((a,b) => a.createdAt-b.createdAt));

  renderZone('todo-cards',       zones.todo,        false);
  renderZone('inprogress-cards', zones.inprogress,  false);
  renderZone('archive-cards',    zones.archive,      true);
  renderZone('done-cards',       zones.done,         true);

  q('#todo-count').textContent        = zones.todo.length;
  q('#inprogress-count').textContent  = zones.inprogress.length;
  q('#archive-count').textContent     = zones.archive.length;
  q('#done-count').textContent        = zones.done.length;

  vis('#todo-empty',       zones.todo.length === 0);
  vis('#inprogress-empty', zones.inprogress.length === 0);
  vis('#archive-empty',    zones.archive.length === 0);
  vis('#done-empty',       zones.done.length === 0);
}

function renderZone(containerId, zoneCards, compact) {
  const c = q('#'+containerId);
  Array.from(c.querySelectorAll('.card')).forEach(el=>el.remove());
  zoneCards.forEach(card => c.appendChild(buildCardEl(card, compact)));
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
    const dc = getDateCls(card.dueDate);
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

// ─── DRAG ────────────────────────────────────────────────────────────────────
function attachCardEvents(el) {
  el.addEventListener('pointerdown', onCardDown, {passive:false});
  el.querySelector('.card__delete-btn').addEventListener('pointerdown', e=>e.stopPropagation());
  el.querySelector('.card__delete-btn').addEventListener('click', e => {
    e.stopPropagation();
    if (deleteCardId === el.dataset.id) deleteCard(el.dataset.id);
  });
}

function onCardDown(e) {
  if (e.target.closest('.card__delete-btn')) return;
  const cardEl = e.currentTarget, id = cardEl.dataset.id;
  if (deleteCardId && deleteCardId !== id) { dismissDelete(); return; }
  if (deleteCardId === id) return;
  e.preventDefault();
  cardEl.setPointerCapture(e.pointerId);
  dragState = { cardId:id, startX:e.clientX, startY:e.clientY, dragging:false, sourceEl:cardEl, currentZone:null };
  startRing(e.clientX, e.clientY);
  longPressTimer = setTimeout(() => activateDelete(id), LONG_PRESS_MS);
  cardEl.addEventListener('pointermove', onCardMove);
  cardEl.addEventListener('pointerup',   onCardUp);
  cardEl.addEventListener('pointercancel', onCardUp);
}

function onCardMove(e) {
  if (!dragState) return;
  if (!dragState.dragging && Math.hypot(e.clientX-dragState.startX, e.clientY-dragState.startY) > DRAG_THRESHOLD) {
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
  const el = dragState.sourceEl;
  el.classList.remove('dragging-source');
  el.removeEventListener('pointermove', onCardMove);
  el.removeEventListener('pointerup', onCardUp);
  el.removeEventListener('pointercancel', onCardUp);
  hideGhost(); clearZones();
  document.body.classList.remove('dragging-active');
  dragState = null;
}

// Ghost
function showGhost(id, x, y) {
  const card = currentCards().find(c=>c.id===id);
  if (!card) return;
  const g = q('#drag-ghost');
  g.innerHTML = `<div class="drag-ghost__title">${esc(card.title)}</div>${card.owner?`<div class="drag-ghost__owner">${esc(card.owner)}</div>`:''}`;
  g.style.left=(x-75)+'px'; g.style.top=(y-28)+'px'; g.classList.add('visible');
}
function moveGhost(x,y) { const g=q('#drag-ghost'); g.style.left=(x-75)+'px'; g.style.top=(y-28)+'px'; }
function hideGhost()     { q('#drag-ghost').classList.remove('visible'); }

// Zones
const ZONES   = ['archive','todo','inprogress','done'];
const ZONE_EL = { archive:'#archive-bar', todo:'#todo-column', inprogress:'#inprogress-column', done:'#done-bar' };
function detectZone(x,y) {
  for (const z of ZONES) { const r=q(ZONE_EL[z])?.getBoundingClientRect(); if(r&&x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom) return z; } return null;
}
function highlightZone(zone) { clearZones(); if(zone) q(ZONE_EL[zone])?.classList.add('drag-over'); }
function clearZones() { ZONES.forEach(z=>q(ZONE_EL[z])?.classList.remove('drag-over')); }

// Long press ring
function startRing(x,y) {
  const ring=q('#press-ring'), fill=q('#press-ring-fill');
  ring.style.left=x+'px'; ring.style.top=y+'px'; ring.classList.remove('hidden');
  fill.style.transition='none'; fill.style.strokeDashoffset='113.1';
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    fill.style.transition=`stroke-dashoffset ${LONG_PRESS_MS}ms linear`;
    fill.style.strokeDashoffset='0';
  }));
}
function hideRing() { const r=q('#press-ring'),f=q('#press-ring-fill'); r.classList.add('hidden'); f.style.transition='none'; f.style.strokeDashoffset='113.1'; }
function cancelLP() { if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;} hideRing(); }
function activateDelete(id) { hideRing(); deleteCardId=id; longPressTimer=null; document.querySelector(`.card[data-id="${id}"]`)?.classList.add('delete-mode'); }
function dismissDelete() { if(!deleteCardId)return; document.querySelector(`.card[data-id="${deleteCardId}"]`)?.classList.remove('delete-mode'); deleteCardId=null; }

document.addEventListener('pointerdown', e => {
  if (!deleteCardId) return;
  const card=e.target.closest('.card');
  if (!card||card.dataset.id!==deleteCardId) dismissDelete();
});

// ─── SHELF EXPAND ─────────────────────────────────────────────────────────────
q('#archive-toggle').addEventListener('click', ()=>{ archiveExpanded=!archiveExpanded; q('#archive-bar').classList.toggle('expanded',archiveExpanded); });
q('#done-toggle').addEventListener('click',    ()=>{ doneExpanded=!doneExpanded;    q('#done-bar').classList.toggle('expanded',doneExpanded); });

// ─── CARD MODAL ───────────────────────────────────────────────────────────────
q('#fab').addEventListener('click', openModal);
q('#modal-close').addEventListener('click', closeModal);
q('#modal-overlay').addEventListener('click', e=>{ if(e.target===q('#modal-overlay')) closeModal(); });
q('#modal').querySelectorAll('.modal__toggle-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    q('#modal').querySelectorAll('.modal__toggle-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); selectedColumn=btn.dataset.col;
  });
});
q('#modal-submit').addEventListener('click', submitCard);
q('#input-title').addEventListener('keydown', e=>{ if(e.key==='Enter') submitCard(); if(e.key==='Escape') closeModal(); });

function openModal() {
  q('#modal-overlay').classList.remove('hidden');
  q('#input-title').value=''; q('#input-owner').value=''; q('#input-date').value='';
  selectedColumn='todo';
  q('#modal').querySelectorAll('.modal__toggle-btn').forEach(b=>b.classList.remove('active'));
  q('[data-col="todo"]').classList.add('active');
  refreshOwnerUI();
  setTimeout(()=>q('#input-title').focus(), 80);
}
function closeModal() { q('#modal-overlay').classList.add('hidden'); }
function submitCard() {
  const title=q('#input-title').value.trim();
  if (!title) { shakeEl(q('#input-title')); return; }
  createCard(title, q('#input-owner').value, q('#input-date').value, selectedColumn);
  closeModal();
}
function shakeEl(el) { el.style.animation='none'; requestAnimationFrame(()=>{ el.style.animation='delete-shake .35s ease'; }); }

// ─── HELP MODAL ───────────────────────────────────────────────────────────────
q('#help-btn').addEventListener('click',  ()=>q('#help-overlay').classList.remove('hidden'));
q('#help-close').addEventListener('click',()=>q('#help-overlay').classList.add('hidden'));
q('#help-overlay').addEventListener('click', e=>{ if(e.target===q('#help-overlay')) q('#help-overlay').classList.add('hidden'); });

// ─── THEME ────────────────────────────────────────────────────────────────────
function initTheme() {
  applyTheme(localStorage.getItem(LS_THEME) || 'dark', false);
}
function applyTheme(theme, animate=true) {
  document.documentElement.setAttribute('data-theme', theme);
  q('#theme-icon').textContent = theme==='dark' ? '☽' : '☀';
  localStorage.setItem(LS_THEME, theme);
  const mc=document.querySelector('meta[name="theme-color"]');
  if(mc) mc.setAttribute('content', theme==='dark'?'#0e0e16':'#f3f0e8');
}
q('#theme-btn').addEventListener('click', ()=>{
  const cur=document.documentElement.getAttribute('data-theme');
  applyTheme(cur==='dark'?'light':'dark');
  burstParticles(q('#theme-btn'));
});

// ─── CONFETTI ────────────────────────────────────────────────────────────────
const CONFETTI_COLORS = ['#fb923c','#f0c040','#fbbf24','#f97316','#fdba74','#fcd34d','#fed7aa'];

function launchConfetti() {
  const layer=q('#confetti-layer');
  const originX=window.innerWidth*0.5, originY=window.innerHeight*0.92;
  for (let i=0; i<45; i++) {
    const p=document.createElement('div'); p.className='confetti-piece';
    const color=CONFETTI_COLORS[Math.floor(Math.random()*CONFETTI_COLORS.length)];
    const size=5+Math.random()*9;
    const angle=(-160+Math.random()*140)*(Math.PI/180);
    const dist=80+Math.random()*280;
    const tx=Math.cos(angle)*dist, ty=Math.sin(angle)*dist;
    const dur=0.7+Math.random()*0.8;
    const rot=(Math.random()>.5?1:-1)*(360+Math.random()*720);
    const shape=Math.random();
    p.style.cssText=`left:${originX+(Math.random()-.5)*60}px;top:${originY}px;width:${size}px;height:${shape<.33?size:size*.4}px;background:${color};border-radius:${shape<.33?'50%':shape<.66?'1px':'50% 0'};--tx:${tx}px;--ty:${ty}px;--rot:${rot}deg;animation-duration:${dur}s;animation-delay:${i*.018}s;`;
    layer.appendChild(p);
    p.addEventListener('animationend', ()=>p.remove(), {once:true});
  }
}

function burstParticles(el) {
  const r=el.getBoundingClientRect(), cx=r.left+r.width/2, cy=r.top+r.height/2;
  const layer=q('#confetti-layer');
  for (let i=0; i<10; i++) {
    const p=document.createElement('div'); p.className='confetti-piece';
    const angle=(i/10)*Math.PI*2, dist=30+Math.random()*50;
    p.style.cssText=`left:${cx}px;top:${cy}px;width:5px;height:5px;background:${CONFETTI_COLORS[i%CONFETTI_COLORS.length]};border-radius:50%;--tx:${Math.cos(angle)*dist}px;--ty:${Math.sin(angle)*dist}px;--rot:${Math.random()*360}deg;animation-duration:.55s;animation-delay:${i*.03}s;`;
    layer.appendChild(p);
    p.addEventListener('animationend', ()=>p.remove(), {once:true});
  }
}

// ─── FLOATING PARTICLES ──────────────────────────────────────────────────────
const FLOAT_CHARS=['✦','◆','●','◈','○','◑','✓','◇','▲','△','◻','✧'];
function spawnParticle() {
  const el=document.createElement('span'); el.className='particle';
  el.textContent=FLOAT_CHARS[Math.floor(Math.random()*FLOAT_CHARS.length)];
  el.style.left=Math.random()*100+'vw';
  el.style.bottom='-20px';
  const dur=18+Math.random()*22, size=10+Math.random()*10;
  el.style.fontSize=size+'px';
  el.style.animationDuration=dur+'s';
  el.style.animationDelay=(Math.random()*-dur)+'s';
  el.style.color=CONFETTI_COLORS[Math.floor(Math.random()*CONFETTI_COLORS.length)];
  q('#particles').appendChild(el);
  setTimeout(()=>el.remove(), (dur+2)*1000);
}
for(let i=0;i<10;i++) spawnParticle();
setInterval(spawnParticle, 3000);

// ─── KEYBOARD ────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e=>{
  if (e.key==='Escape') {
    if (!q('#modal-overlay').classList.contains('hidden'))  { closeModal(); return; }
    if (!q('#help-overlay').classList.contains('hidden'))   { q('#help-overlay').classList.add('hidden'); return; }
    dismissDelete();
  }
  if ((e.ctrlKey||e.metaKey) && e.key==='Enter') openModal();
});

// ─── SERVICE WORKER ──────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});

// ─── INIT ────────────────────────────────────────────────────────────────────
initTheme();
boards = loadFromLocal();
currentBoardId = localStorage.getItem(LS_CURRENT) || boards[0]?.id;
if (!boards.find(b=>b.id===currentBoardId)) currentBoardId = boards[0]?.id;

renderTabs();
renderBoard();
initGSI();
