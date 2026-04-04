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

// Safe localStorage read — treats "null"/"undefined" as missing
function lsGet(key) {
  const v = localStorage.getItem(key);
  return (v === null || v === 'null' || v === 'undefined') ? null : v;
}
function lsSet(key, val) { localStorage.setItem(key, val); }
function lsDel(key)      { localStorage.removeItem(key); }

const DRAG_THRESHOLD  = 8;
const LONG_PRESS_MS   = 2000;
const SAVE_DEBOUNCE   = 1800;  // ms after last change before Drive save

// ─── STATE ───────────────────────────────────────────────────────────────────
let boards         = [];       // [{id, name, cards:[]}]
let currentBoardId = null;
let tabPage        = 0;
let dynamicTabsPerPage = 4;   // computed dynamically based on available width
let archiveExpanded = false;
let doneExpanded    = false;
let selectedColumn  = 'todo';
let dragState       = null;   // extended: { cardId, startX, startY, dragging, sourceEl, currentZone, insertBefore }
let longPressTimer  = null;
let deleteCardId    = null;
let dropIndicator   = null;   // the insertion line element

// Auth state
let gAccessToken   = null;
let gUser          = null;     // {name, email, picture}
let driveFileId    = lsGet(LS_DRIVE_FID);
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
function loadOwners() {
  try { return JSON.parse(localStorage.getItem(LS_OWNERS)) || []; } catch { return []; }
}
function saveOwner(name) {
  if (!name?.trim()) return;
  const owners = loadOwners();
  const t = name.trim();
  if (!owners.includes(t)) {
    owners.unshift(t);
    if (owners.length > 30) owners.pop();
    localStorage.setItem(LS_OWNERS, JSON.stringify(owners));
  }
}

// Returns only owners that exist in at least one card — no localStorage fallback
function activeOwners() {
  const inUse = new Set();
  boards.forEach(b => b.cards.forEach(c => { if (c.owner?.trim()) inUse.add(c.owner.trim()); }));
  // Nuke the old saved list — cards are the source of truth
  localStorage.removeItem(LS_OWNERS);
  return [...inUse].sort((a, b) => a.localeCompare(b));
}

function refreshOwnerUI() {
  const dl     = q('#owner-datalist');
  const chips  = q('#owner-chips');
  const owners = activeOwners();

  if (dl) {
    dl.innerHTML = '';
    owners.forEach(n => { const o = document.createElement('option'); o.value = n; dl.appendChild(o); });
  }

  if (!chips) return;
  if (!owners.length) { chips.style.display = 'none'; return; }

  chips.style.display = 'flex';
  chips.innerHTML = '';
  owners.slice(0, 12).forEach(name => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'owner-chip';
    chip.textContent = name;
    chip.addEventListener('click', () => {
      q('#input-owner').value = name;
      chips.querySelectorAll('.owner-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
    chips.appendChild(chip);
  });
}

// ─── GOOGLE DRIVE ────────────────────────────────────────────────────────────
function driveHeaders(contentType = 'application/json') {
  return { 'Authorization': `Bearer ${gAccessToken}`, 'Content-Type': contentType };
}

async function driveFindFile() {
  // Search by name in appDataFolder
  const url = `${DRIVE_API}/files?spaces=${DRIVE_FOLDER}&fields=files(id,name,modifiedTime)&q=name%3D'${DRIVE_FILENAME}'`;
  const r   = await fetch(url, { headers: driveHeaders() });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    console.error('driveFindFile failed:', r.status, err?.error?.message);
    return null;
  }
  const data = await r.json();
  console.log('driveFindFile results:', data.files);
  // If multiple copies somehow exist, take the most recently modified
  if (!data.files?.length) return null;
  return data.files.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime))[0].id;
}

async function driveLoadData() {
  setSyncStatus('syncing', 'Loading from Drive…');
  try {
    // Always search by name — never use a potentially stale/undefined cached ID
    const fid = await driveFindFile();
    if (!fid) {
      console.log('driveLoadData: no file in Drive yet');
      setSyncStatus('synced', 'Drive ready');
      driveFileId = null;
      lsDel(LS_DRIVE_FID);
      return null;
    }
    driveFileId = fid;
    lsSet(LS_DRIVE_FID, fid);

    console.log('driveLoadData: fetching file', fid);
    const r = await fetch(`${DRIVE_API}/files/${fid}?alt=media`, {
      headers: { 'Authorization': `Bearer ${gAccessToken}` }
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('driveLoadData fetch failed:', r.status, text);
      if (r.status === 404) { driveFileId = null; lsDel(LS_DRIVE_FID); }
      throw new Error(`HTTP ${r.status}`);
    }

    const data = await r.json();
    console.log('driveLoadData success — boards:', data.boards?.length, 'savedAt:', data.savedAt ? new Date(data.savedAt).toLocaleString() : 'unknown');
    setSyncStatus('synced', 'Loaded from Drive ✓');
    return data;
  } catch (err) {
    console.error('driveLoadData error:', err.message);
    setSyncStatus('error', `Load failed — ${err.message}`);
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
      // Update existing file
      r = await fetch(`${DRIVE_UPLOAD_API}/files/${fid}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${gAccessToken}`, 'Content-Type': 'application/json' },
        body: payload
      });
      if (r.status === 404) {
        // File was deleted from Drive — clear ID and create fresh
        console.warn('Drive file 404 on update, recreating…');
        driveFileId = null; fid = null;
        lsDel(LS_DRIVE_FID);
      }
    }

    if (!fid) {
      // Create new file in appDataFolder
      const boundary = 'tb_' + Date.now();
      const body = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify({ name: DRIVE_FILENAME, parents: [DRIVE_FOLDER] }),
        `--${boundary}`,
        'Content-Type: application/json',
        '',
        payload,
        `--${boundary}--`
      ].join('\r\n');

      r = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${gAccessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(`create ${r.status}: ${err?.error?.message || r.statusText}`);
      }
      const res = await r.json();
      if (!res.id) throw new Error('No file ID in create response');
      driveFileId = res.id;
      lsSet(LS_DRIVE_FID, driveFileId);
      console.log('driveCreate success, id:', driveFileId);
      setSyncStatus('synced', 'Saved to Drive ✓');
      return;
    }

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(`update ${r.status}: ${err?.error?.message || r.statusText}`);
    }

    console.log('driveSave success');
    setSyncStatus('synced', 'Saved to Drive ✓');
  } catch (err) {
    console.error('driveSaveData error:', err.message);
    setSyncStatus('error', `Save failed — ${err.message}`);
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
      // Update existing file — simple media upload
      r = await fetch(`${DRIVE_UPLOAD_API}/files/${fid}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${gAccessToken}`, 'Content-Type': 'application/json' },
        body: payload
      });
    } else {
      // Create new file in appDataFolder — use multipart with correct boundary
      const boundary = 'taskboards_boundary_' + Date.now();
      const body = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify({ name: DRIVE_FILENAME, parents: [DRIVE_FOLDER] }),
        `--${boundary}`,
        'Content-Type: application/json',
        '',
        payload,
        `--${boundary}--`
      ].join('\r\n');

      r = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${gAccessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.error('Drive create failed:', r.status, err);
        throw new Error(`create ${r.status}: ${err?.error?.message || r.statusText}`);
      }

      const res = await r.json();
      if (!res.id) throw new Error('No file ID returned');
      driveFileId = res.id;
      lsSet(LS_DRIVE_FID, driveFileId);
      setSyncStatus('synced', 'Saved to Drive ✓');
      return;
    }

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.error('Drive save failed:', r.status, err);
      // If 404 (file deleted from Drive), clear cached ID and retry once
      if (r.status === 404) {
        driveFileId = null;
        lsDel(LS_DRIVE_FID);
        console.warn('Drive file gone, will recreate on next save');
        scheduleDriveSave();
        return;
      }
      throw new Error(`save ${r.status}: ${err?.error?.message || r.statusText}`);
    }

    setSyncStatus('synced', 'Saved to Drive ✓');
  } catch (err) {
    console.error('Drive save error:', err.message);
    setSyncStatus('error', `Save failed — ${err.message}`);
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
    tokenClient.requestAccessToken({ prompt: 'select_account' });
  });
}

async function handleTokenResponse(resp) {
  if (resp.error) { console.error('GSI error:', resp.error); return; }
  gAccessToken = resp.access_token;
  console.log('GSI token received, scopes:', resp.scope);

  // Check if Drive scope was actually granted
  const hasDriveScope = resp.scope?.includes('drive.appdata') || resp.scope?.includes('drive');
  if (!hasDriveScope) {
    console.warn('Drive scope missing — requesting consent again');
    // Force full consent to get the Drive scope
    tokenClient.requestAccessToken({ prompt: 'consent' });
    return;
  }

  // Fetch user profile
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${gAccessToken}` } });
    gUser = await r.json();
    console.log('Logged in as:', gUser.email);
  } catch (e) { console.warn('userinfo failed', e); }

  showUserPill();

  // Always try to load from Drive — Drive is the source of truth when logged in
  const driveData = await driveLoadData();
  if (driveData?.boards?.length) {
    console.log('Restoring', driveData.boards.length, 'boards from Drive');
    boards = driveData.boards;
    currentBoardId = driveData.currentBoardId || boards[0].id;
    if (!boards.find(b => b.id === currentBoardId)) currentBoardId = boards[0].id;
    saveToLocal();
  } else {
    console.log('No Drive data found — saving current local boards to Drive');
    await driveSaveData();
  }

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

function openUserMenu()  { q('#user-pill').classList.add('open'); }
function closeUserMenu() { q('#user-pill').classList.remove('open'); }
function toggleUserMenu(e) { e.stopPropagation(); q('#user-pill').classList.toggle('open'); }

// Click on pill to open menu; click outside to close
q('#user-pill').addEventListener('click', toggleUserMenu);
document.addEventListener('click', e => {
  if (!e.target.closest('#user-pill')) closeUserMenu();
});

function handleLogout() {
  if (gAccessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(gAccessToken, () => {});
  }
  gAccessToken = null;
  gUser = null;
  driveFileId = null;
  lsDel(LS_DRIVE_FID);

  // Clear boards from local storage so next user starts clean
  lsDel(LS_BOARDS);
  lsDel(LS_CURRENT);
  boards = [defaultBoard()];
  currentBoardId = boards[0].id;
  archiveExpanded = false;
  doneExpanded = false;
  q('#archive-bar').classList.remove('expanded');
  q('#done-bar').classList.remove('expanded');
  tabPage = 0;

  closeUserMenu();
  q('#user-pill').classList.add('hidden');
  q('#login-btn').style.display = '';
  setSyncStatus('', 'Offline');
  renderTabs();
  renderBoard();
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
  tabPage = Math.floor((boards.length - 1) / dynamicTabsPerPage);
  onDataChanged();
  renderTabs();
  renderBoard();
}

function deleteBoard(id) {
  if (boards.length <= 1) return;
  boards = boards.filter(b => b.id !== id);
  if (currentBoardId === id) currentBoardId = boards[Math.max(0, boards.length-1)].id;
  tabPage = Math.min(tabPage, Math.floor((boards.length-1)/dynamicTabsPerPage));
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
  const zoneCards = currentBoard().cards.filter(c => c.status === status);
  const maxOrder  = zoneCards.reduce((m, c) => Math.max(m, c.sortOrder ?? c.createdAt), -1);
  const card = { id: uid(), title: title.trim(), owner: owner.trim(), dueDate, status, createdAt: Date.now(), sortOrder: maxOrder + 1 };
  currentBoard().cards.push(card);
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
  moveOrReorderCard(id, newStatus, null);
}

function moveOrReorderCard(id, newStatus, insertBeforeId) {
  const cb = currentBoard();
  const card = cb?.cards.find(c => c.id === id);
  if (!card) return;
  const wasStatus = card.status;

  // Update status
  card.status = newStatus;

  // Build ordered list for the target zone (exclude the dragged card)
  const zoneCards = cb.cards
    .filter(c => c.status === newStatus && c.id !== id)
    .sort((a, b) => (a.sortOrder ?? a.createdAt) - (b.sortOrder ?? b.createdAt));

  // Find insertion index
  let insertIdx = zoneCards.length; // default: end
  if (insertBeforeId) {
    const idx = zoneCards.findIndex(c => c.id === insertBeforeId);
    if (idx >= 0) insertIdx = idx;
  }

  // Insert card at position and reassign sortOrder
  zoneCards.splice(insertIdx, 0, card);
  zoneCards.forEach((c, i) => { c.sortOrder = i; });

  onDataChanged();
  renderBoard();
  if (newStatus === 'done' && wasStatus !== 'done') setTimeout(launchConfetti, 80);
}

// ─── RENDER: TABS ─────────────────────────────────────────────────────────────
// PICO-8 palette — vivid, distinct, works on dark & light
const PICO8 = [
  '#ff004d', // red
  '#ffa300', // orange
  '#ffec27', // yellow
  '#00e436', // green
  '#29adff', // blue
  '#83769c', // lavender
  '#ff77a8', // pink
  '#ffccaa', // peach
  '#00b543', // dark green
  '#1d2b53', // dark navy  — skip on dark, use on light
  '#7e2553', // dark purple
  '#008751', // forest
  '#ab5236', // brown
  '#5f574f', // dark grey
  '#c2c3c7', // light grey
  '#fff1e8', // cream — skip, too light
];
const TAB_COLORS = ['#ff004d','#ffa300','#00e436','#29adff','#83769c','#ff77a8','#ffccaa','#ab5236','#00b543','#7e2553','#008751','#c2c3c7'];

function tabColor(boardId) {
  // Stable color per board based on its id
  let hash = 0;
  for (let i = 0; i < boardId.length; i++) hash = (hash * 31 + boardId.charCodeAt(i)) >>> 0;
  return TAB_COLORS[hash % TAB_COLORS.length];
}

/**
 * Compute how many tabs fit in the available width by doing a hidden probe render.
 * Returns the count that fits starting from the current tabPage * current dynamicTabsPerPage.
 */
function computeTabsPerPage() {
  const container  = q('#boards-tabs');
  const prevBtn    = q('#tab-prev');
  const nextBtn    = q('#tab-next');
  const addBtn     = q('#add-board');
  if (!container) return 4;

  // Available width = full row width minus fixed-width controls + some margin
  const rowWidth   = container.parentElement?.clientWidth || window.innerWidth;
  const btnW       = (prevBtn?.offsetWidth || 28) + (nextBtn?.offsetWidth || 28) + (addBtn?.offsetWidth || 36);
  const availW     = rowWidth - btnW - 24; // 24px for gaps/padding

  if (availW <= 60) return 1;

  // Probe: render all boards in a hidden off-screen flex row to measure real widths
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:-9999px;left:0;display:flex;gap:4px;visibility:hidden;pointer-events:none;';
  document.body.appendChild(probe);

  let totalW = 0, count = 0;
  for (const board of boards) {
    const t = document.createElement('div');
    t.className = 'board-tab';
    t.style.cssText = 'flex-shrink:0;white-space:nowrap;';
    t.innerHTML = `<span class="board-tab__name">${esc(board.name)}</span>${boards.length > 1 ? '<button class="board-tab__delete" style="pointer-events:none">✕</button>' : ''}`;
    probe.appendChild(t);
    totalW += t.getBoundingClientRect().width + 4;
    if (totalW <= availW) count++;
    else break;
  }

  document.body.removeChild(probe);
  return Math.max(1, count);
}

function renderTabs() {
  const container = q('#boards-tabs');
  const prevBtn   = q('#tab-prev');
  const nextBtn   = q('#tab-next');
  container.innerHTML = '';

  dynamicTabsPerPage = computeTabsPerPage();

  const totalPages = Math.ceil(boards.length / dynamicTabsPerPage);
  tabPage = Math.max(0, Math.min(tabPage, totalPages - 1));

  const start = tabPage * dynamicTabsPerPage;
  const slice = boards.slice(start, start + dynamicTabsPerPage);

  slice.forEach(board => {
    const tab = document.createElement('div');
    tab.className = 'board-tab' + (board.id === currentBoardId ? ' active' : '');
    tab.dataset.id = board.id;
    tab.style.setProperty('--tab-color', tabColor(board.id));
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

  // Show prev/next only when there are multiple pages
  const multiPage = totalPages > 1;
  prevBtn.disabled = tabPage === 0;
  nextBtn.disabled = tabPage >= totalPages - 1;
  prevBtn.style.visibility = multiPage ? '' : 'hidden';
  nextBtn.style.visibility = multiPage ? '' : 'hidden';
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
q('#tab-next').addEventListener('click', () => { tabPage = Math.min(Math.ceil(boards.length/dynamicTabsPerPage)-1, tabPage+1); renderTabs(); });
q('#add-board').addEventListener('click', addBoard);

// Re-compute tabs on resize so they always fill available space
let _resizeTimer;
window.addEventListener('resize', () => { clearTimeout(_resizeTimer); _resizeTimer = setTimeout(renderTabs, 120); });

// ─── RENDER: BOARD ────────────────────────────────────────────────────────────
function renderBoard() {
  const cards = currentCards();
  const zones = { todo:[], inprogress:[], archive:[], done:[] };
  cards.forEach(c => { if (zones[c.status]) zones[c.status].push(c); });
  // Sort each zone by sortOrder (falls back to createdAt for legacy cards)
  Object.values(zones).forEach(z => z.sort((a,b) => (a.sortOrder ?? a.createdAt) - (b.sortOrder ?? b.createdAt)));

  renderZone('todo-cards',       zones.todo,        false);
  renderZone('inprogress-cards', zones.inprogress,  false);
  renderZone('archive-cards',    zones.archive,      true);
  renderZone('done-cards',       zones.done,         !doneExpanded); // full cards when expanded

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
    ensureDropIndicator();
  }
  if (dragState.dragging) {
    moveGhost(e.clientX, e.clientY);
    const z = detectZone(e.clientX, e.clientY);
    highlightZone(z);
    dragState.currentZone = z;
    if (z) {
      const { insertBefore, refEl } = detectInsertPosition(z, e.clientX, e.clientY, dragState.cardId);
      dragState.insertBefore = insertBefore;
      showDropIndicator(z, refEl);
    } else {
      hideDropIndicator();
      dragState.insertBefore = null;
    }
  }
}

function onCardUp(e) {
  if (!dragState) return;
  cancelLP();
  hideDropIndicator();
  if (dragState.dragging && dragState.currentZone) {
    moveOrReorderCard(dragState.cardId, dragState.currentZone, dragState.insertBefore || null);
  }
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

// Detect which card the pointer is above within a zone (for reordering)
const ZONE_CARD_CONTAINERS = { archive:'#archive-cards', todo:'#todo-cards', inprogress:'#inprogress-cards', done:'#done-cards' };
function detectInsertPosition(zone, x, y, draggedId) {
  const sel = ZONE_CARD_CONTAINERS[zone];
  if (!sel) return { insertBefore: null, refEl: null };
  const container = q(sel);
  if (!container) return { insertBefore: null, refEl: null };
  const cards = Array.from(container.querySelectorAll('.card:not(.dragging-source)'));
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    const midY = r.top + r.height / 2;
    if (y < midY) return { insertBefore: card.dataset.id, refEl: card };
  }
  return { insertBefore: null, refEl: null }; // insert at end
}

// Drop indicator line
function ensureDropIndicator() {
  if (dropIndicator) return;
  dropIndicator = document.createElement('div');
  dropIndicator.className = 'drop-indicator';
  dropIndicator.style.cssText = 'display:none;height:3px;border-radius:2px;background:var(--accent,#ffa300);margin:2px 0;pointer-events:none;transition:none;';
  document.body.appendChild(dropIndicator);
}
function showDropIndicator(zone, refEl) {
  if (!dropIndicator) return;
  const sel = ZONE_CARD_CONTAINERS[zone];
  const container = q(sel);
  if (!container) { hideDropIndicator(); return; }
  dropIndicator.style.display = 'block';
  if (refEl) {
    container.insertBefore(dropIndicator, refEl);
  } else {
    container.appendChild(dropIndicator);
  }
}
function hideDropIndicator() {
  if (!dropIndicator) return;
  dropIndicator.style.display = 'none';
  if (dropIndicator.parentElement) dropIndicator.parentElement.removeChild(dropIndicator);
}

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
q('#archive-toggle').addEventListener('click', ()=>{ archiveExpanded=!archiveExpanded; q('#archive-bar').classList.toggle('expanded',archiveExpanded); renderBoard(); });
q('#done-toggle').addEventListener('click',    ()=>{ doneExpanded=!doneExpanded;    q('#done-bar').classList.toggle('expanded',doneExpanded); renderBoard(); });

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

// ─── CSS PATCHES ─────────────────────────────────────────────────────────────
(function injectStylePatches() {
  const style = document.createElement('style');
  style.textContent = `
    /* Bigger TaskBoards title */
    .app-title, #app-title, h1.title, .header__title {
      font-size: clamp(1.4rem, 4vw, 2rem) !important;
      letter-spacing: .02em;
    }

    /* Board tabs — show full name, no truncation */
    .board-tab {
      flex-shrink: 0 !important;
      min-width: 0;
      max-width: none !important;
    }
    .board-tab__name {
      overflow: visible !important;
      text-overflow: unset !important;
      white-space: nowrap !important;
      max-width: none !important;
    }

    /* Drop indicator line */
    .drop-indicator {
      height: 3px !important;
      border-radius: 2px !important;
      background: var(--accent, #ffa300) !important;
      margin: 2px 4px !important;
      pointer-events: none !important;
    }

    /* Done section expanded — use grid layout matching main columns */
    #done-bar.expanded #done-cards {
      display: flex !important;
      flex-direction: column !important;
      gap: 8px !important;
      padding: 8px !important;
    }
    /* Full cards inside expanded done look like todo/inprogress cards */
    #done-bar.expanded .card {
      opacity: .85;
    }
  `;
  document.head.appendChild(style);
})();

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
