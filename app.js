'use strict';

// ─── VERSION ─────────────────────────────────────────────────────────────────
const APP_VERSION = '3.4.0'; // sturdier sign-in: token renewal, no save after a failed load, retry/flush/conflict-safe Drive sync
console.log('%c TaskBoards v' + APP_VERSION + ' loaded', 'background:#ffa300;color:#000;padding:2px 8px;border-radius:4px;font-weight:bold');

// ─── CONFIG & CONSTANTS ───────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID  = (window.TASKBOARDS_CONFIG || {}).GOOGLE_CLIENT_ID || '';
const DRIVE_APPDATA     = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE        = 'https://www.googleapis.com/auth/drive.file';   // lets the app create the shared copy of a board
const DRIVE_SCOPE       = `${DRIVE_APPDATA} ${DRIVE_FILE} openid email profile`;
const DRIVE_FILENAME    = 'taskboards-data.json';
const DRIVE_FOLDER      = 'appDataFolder';
const DRIVE_API         = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API  = 'https://www.googleapis.com/upload/drive/v3';

// Optional session server (see auth.js). When set, the app keeps a long-lived
// Google session through it instead of re-asking Google every hour.
const AUTH_API          = ((window.TASKBOARDS_CONFIG || {}).AUTH_API || '').replace(/\/$/, '');

// Public key the viewer page uses to download a shared board. Sharing stays off until it is set.
const DRIVE_API_KEY     = (window.TASKBOARDS_CONFIG || {}).DRIVE_API_KEY || '';

const SUPABASE_URL      = (window.TASKBOARDS_CONFIG || {}).SUPABASE_URL || '';
const SUPABASE_ANON_KEY = (window.TASKBOARDS_CONFIG || {}).SUPABASE_ANON_KEY || '';

const LS_BOARDS    = 'taskboards-v1-boards';
const LS_CURRENT   = 'taskboards-v1-current';
const LS_THEME     = 'taskboards-theme';
const LS_OWNERS    = 'taskboards-owners';
const LS_DRIVE_FID = 'taskboards-drive-fileid';
const LS_DIRTY     = 'taskboards-dirty';          // unsynced local edits
const LS_BASE      = 'taskboards-drive-base';     // Drive modifiedTime our copy is based on
const LS_HINT      = 'taskboards-login-hint';     // last signed-in profile (no secrets)
const LS_SUB       = 'taskboards-user-sub';       // owner of the boards in localStorage
const SS_TOKEN     = 'taskboards-token';          // this tab's access token (sessionStorage)
const TOKEN_SKEW_MS = 5 * 60 * 1000;                // renew this long before expiry

// Safe localStorage read — treats "null"/"undefined" as missing
function lsGet(key) {
  const v = localStorage.getItem(key);
  return (v === null || v === 'null' || v === 'undefined') ? null : v;
}
function lsSet(key, val) { localStorage.setItem(key, val); }
function lsDel(key)      { localStorage.removeItem(key); }

const DRAG_THRESHOLD  = 5;
const SAVE_DEBOUNCE   = 1800;  // ms after last change before Drive save

// ─── STATE ───────────────────────────────────────────────────────────────────
let boards         = [];       // [{id, name, cards:[]}]
let currentBoardId = null;
let tabPage        = 0;
let dynamicTabsPerPage = 4;   // computed dynamically based on available width
let archiveExpanded = false;
let doneExpanded    = false;
let selectedColumn  = 'todo';
let dragState       = null;
let deleteCardId    = null;
let dropIndicator   = null;   // the insertion line element
let selectedOwners  = new Set(); // for filtering cards by owner

// Auth state
let gAccessToken   = null;
let gScopes        = '';       // scopes Google actually granted
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

// ─── TOAST NOTIFICATIONS ─────────────────────────────────────────────────────
const TOAST_DURATION = 2500;
function showToast(message, type = 'success') {
  const container = q('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  
  const icons = { success: '✓', error: '✕', info: '◈', loading: '◐' };
  toast.innerHTML = `<span class="toast__icon">${icons[type] || icons.success}</span><span class="toast__message">${esc(message)}</span>`;
  
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast--visible'));
  
  setTimeout(() => {
    toast.classList.remove('toast--visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, TOAST_DURATION);
}

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

// ─── OWNER FILTER ────────────────────────────────────────────────────────────
const LS_FILTER_OWNERS = 'taskboards-v1-filter-owners';

function loadSelectedOwners() {
  try {
    const saved = localStorage.getItem(LS_FILTER_OWNERS);
    if (saved) {
      return new Set(JSON.parse(saved));
    }
  } catch {}
  return new Set();
}

function saveSelectedOwners() {
  localStorage.setItem(LS_FILTER_OWNERS, JSON.stringify([...selectedOwners]));
}

function toggleOwnerFilter(ownerName) {
  if (selectedOwners.has(ownerName)) {
    selectedOwners.delete(ownerName);
  } else {
    selectedOwners.add(ownerName);
  }
  saveSelectedOwners();
  renderOwnerFilterChips();
  renderBoard();
}

function clearOwnerFilter() {
  selectedOwners.clear();
  saveSelectedOwners();
  renderOwnerFilterChips();
  renderBoard();
}

function isCardVisible(card) {
  if (selectedOwners.size === 0) return true;
  if (!card.owner?.trim()) return false;
  return selectedOwners.has(card.owner.trim());
}

function renderOwnerFilterChips() {
  const container = q('#owner-filter-chips');
  const bar = q('#owner-filter-bar');
  if (!container) return;
  
  const owners = activeOwners();
  if (owners.length === 0) {
    bar?.classList.remove('has-owners');
    return;
  }
  
  bar?.classList.add('has-owners');
  container.innerHTML = '';
  
  owners.forEach(name => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'owner-filter-chip' + (selectedOwners.has(name) ? ' active' : '');
    chip.textContent = name;
    chip.title = selectedOwners.has(name) ? 'Click to remove filter' : 'Click to filter by owner';
    chip.addEventListener('click', () => toggleOwnerFilter(name));
    container.appendChild(chip);
  });
  
  // Add clear button if any filter is active
  if (selectedOwners.size > 0) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'owner-filter-clear';
    clearBtn.textContent = '✕';
    clearBtn.title = 'Clear all filters';
    clearBtn.addEventListener('click', clearOwnerFilter);
    container.appendChild(clearBtn);
  }
}

// ─── GOOGLE DRIVE ────────────────────────────────────────────────────────────
// Sync model: localStorage is the working copy, Drive is the durable copy.
//  • changeSeq/savedSeq track unsynced edits; LS_DIRTY survives a closed tab.
//  • driveModified (mirrored in LS_BASE) is the Drive version our copy is based
//    on — if Drive has moved on since, we ask instead of silently overwriting.
//  • A failed or ambiguous load never leads to a save (driveReady stays false),
//    so a network blip can't replace the user's boards with an empty board.
class AuthError extends Error {}

let changeSeq     = 0;
let savedSeq      = 0;
let driveReady    = false;            // true once we know what is in Drive
let driveModified = lsGet(LS_BASE);   // Drive modifiedTime our copy is based on
let saving        = false;
let saveQueued    = false;
let retryTimer    = null;
let retryDelay    = 0;

const isDirty   = () => changeSeq !== savedSeq;
function markDirty() { changeSeq++; lsSet(LS_DIRTY, '1'); }
function setDriveModified(t) {
  driveModified = t || null;
  if (t) lsSet(LS_BASE, t); else lsDel(LS_BASE);
}

// Authenticated fetch: always uses a fresh token and retries once on a 401.
async function driveFetch(url, opts = {}, canRetry = true) {
  const token = await ensureToken();
  if (!token) throw authTransient ? new Error('Sign-in service unreachable') : new AuthError('Session expired');
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
  if (r.status === 401) {
    if (!canRetry) throw new AuthError('Session expired');
    gTokenExpiry = 0; // Google rejected the token — force a refresh
    return driveFetch(url, opts, false);
  }
  return r;
}

// Resolves the newest {id, modifiedTime} or null when no file exists yet.
async function driveFindFile() {
  const url = `${DRIVE_API}/files?spaces=${DRIVE_FOLDER}&fields=files(id,name,modifiedTime)&q=name%3D'${DRIVE_FILENAME}'`;
  const r = await driveFetch(url);
  if (!r.ok) throw new Error(`find ${r.status}`);
  const { files } = await r.json();
  if (!files?.length) return null;
  return files.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime))[0];
}

// Resolves {data, modifiedTime}, or null when the user has no file yet.
// Throws on any failure — callers must never treat an error as "empty".
async function driveLoadData() {
  const file = await driveFindFile();
  if (!file) { driveFileId = null; lsDel(LS_DRIVE_FID); return null; }
  driveFileId = file.id;
  lsSet(LS_DRIVE_FID, file.id);
  const r = await driveFetch(`${DRIVE_API}/files/${file.id}?alt=media`);
  if (!r.ok) throw new Error(`load ${r.status}`);
  const data = await r.json();
  if (!Array.isArray(data?.boards)) throw new Error('unexpected file format');
  return { data, modifiedTime: file.modifiedTime };
}

// Replace the in-memory boards with what Drive holds.
function applyRemote({ data, modifiedTime }) {
  boards = data.boards.length ? data.boards : [defaultBoard()];
  currentBoardId = boards.find(b => b.id === data.currentBoardId) ? data.currentBoardId : boards[0].id;
  tabPage = Math.min(tabPage, Math.floor((boards.length - 1) / dynamicTabsPerPage));
  saveToLocal();
  setDriveModified(modifiedTime);
  savedSeq = changeSeq;
  lsDel(LS_DIRTY);
  renderTabs();
  renderOwnerFilterChips();
  renderBoard();
}

function keepLocalOnConflict() {
  return confirm(
    'Your boards were changed somewhere else (another device, or unsaved edits here).\n\n' +
    'OK = keep THIS device’s version and overwrite Drive\n' +
    'Cancel = load the version from Drive'
  );
}

// One save attempt. Throws on failure; resolves quietly if Drive's version won.
async function driveWrite() {
  const seq     = changeSeq;
  const payload = JSON.stringify({ boards, currentBoardId, savedAt: Date.now() });

  let file = driveFileId ? { id: driveFileId } : await driveFindFile();
  if (file) {
    // Has Drive moved on since we last synced?
    const m = await driveFetch(`${DRIVE_API}/files/${file.id}?fields=modifiedTime`);
    if (m.status === 404) {
      file = null; driveFileId = null; lsDel(LS_DRIVE_FID); setDriveModified(null);
    } else if (!m.ok) {
      throw new Error(`check ${m.status}`);
    } else {
      const { modifiedTime } = await m.json();
      if (!driveModified || Date.parse(modifiedTime) > Date.parse(driveModified)) {
        if (!keepLocalOnConflict()) {
          const remote = await driveLoadData();
          if (remote) { applyRemote(remote); return; }
          file = null;
        }
      }
    }
  }

  let r;
  if (file) {
    r = await driveFetch(`${DRIVE_UPLOAD_API}/files/${file.id}?uploadType=media&fields=id,modifiedTime`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: payload.length < 60000   // lets the last save survive a closing tab
    });
    if (r.status === 404) {
      driveFileId = null; lsDel(LS_DRIVE_FID); setDriveModified(null);
      throw new Error('file moved, retrying');
    }
  } else {
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
    r = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,modifiedTime`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
  }

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`save ${r.status}: ${err?.error?.message || r.statusText}`);
  }
  const res = await r.json();
  if (!res.id) throw new Error('No file ID in response');
  driveFileId = res.id;
  lsSet(LS_DRIVE_FID, res.id);
  setDriveModified(res.modifiedTime);
  savedSeq = seq;                       // edits made mid-save stay dirty
  if (seq === changeSeq) lsDel(LS_DIRTY);
}

async function driveSaveData() {
  if (!driveReady || needsReauth) return;
  if (saving) { saveQueued = true; return; }
  if (!isDirty()) return;
  saving = true;
  clearTimeout(retryTimer);
  setSyncStatus('syncing', 'Saving…');
  try {
    await driveWrite();
    retryDelay = 0;
    setSyncStatus('synced', 'Saved to Drive ✓');
    publishShares();   // keep the public copies of shared boards current
  } catch (err) {
    console.error('Drive save error:', err.message);
    if (err instanceof AuthError) {
      setSyncStatus('error', 'Session expired');
      requestReconnect();
    } else {
      // Network/5xx: keep the edits, retry with backoff (also on `online`)
      retryDelay = Math.min((retryDelay || 2000) * 2, 60000);
      retryTimer = setTimeout(driveSaveData, retryDelay);
      setSyncStatus('error', navigator.onLine ? 'Save failed — retrying…' : 'Offline — saved on this device');
    }
  } finally {
    saving = false;
    if (saveQueued) { saveQueued = false; scheduleDriveSave(); }
  }
}

function scheduleDriveSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(driveSaveData, SAVE_DEBOUNCE);
}

function flushSave() {
  if (!driveReady || !isDirty()) return;
  clearTimeout(saveTimer);
  driveSaveData();
}

// Pull in edits made on another device (called when the tab comes back).
async function driveRefreshIfNewer() {
  if (!driveReady || saving || isDirty() || !driveFileId) return;
  try {
    const m = await driveFetch(`${DRIVE_API}/files/${driveFileId}?fields=modifiedTime`);
    if (!m.ok) return;
    const { modifiedTime } = await m.json();
    if (Date.parse(modifiedTime) <= Date.parse(driveModified || 0)) return;
    const remote = await driveLoadData();
    if (remote && !isDirty()) { applyRemote(remote); showToast('Updated from another device', 'info'); }
  } catch (e) { console.warn('refresh check failed (non-fatal):', e.message); }
}

function setSyncStatus(state, label) {
  const dot = q('#sync-dot'), lbl = q('#sync-label');
  if (dot) { dot.className = 'sync-dot ' + state; }
  if (lbl) lbl.textContent = label;
  const chip = q('#sync-chip');
  if (chip) {
    chip.hidden = false;
    chip.textContent = label;
    chip.className = 'chip ' + ({ synced: 'chip--ok', syncing: 'chip--info', error: 'chip--danger' }[state] || 'chip--muted');
  }
}

// ─── SKELETON LOADING ────────────────────────────────────────────────────────
function showSkeleton(show) {
  const skeleton = q('#skeleton-loader');
  if (skeleton) {
    skeleton.classList.toggle('skeleton--visible', show);
  }
}

function createSkeletonLoader() {
  const skeleton = document.createElement('div');
  skeleton.id = 'skeleton-loader';
  skeleton.className = 'skeleton-loader';
  skeleton.innerHTML = `
    <div class="skeleton-card"></div>
    <div class="skeleton-card skeleton-card--short"></div>
    <div class="skeleton-card"></div>
    <div class="skeleton-card skeleton-card--medium"></div>
  `;
  document.body.appendChild(skeleton);
}

// ─── AUTH GATE ───────────────────────────────────────────────────────────────
// Taskboards requires a Google sign-in before any board is shown — there is
// no local/offline-only mode. Boards only ever live in the signed-in user's
// own Drive; this app has no database of its own.
function showAuthGate() { q('#auth-gate').classList.remove('hidden'); }
function hideAuthGate() { q('#auth-gate').classList.add('hidden'); }
function setGateStatus(msg) { q('#gate-status').textContent = msg || ''; }

// A returning user sees "Continue as <email>" instead of a cold sign-in.
function renderGate() {
  const label = q('#gate-login-btn .login-btn__label');
  const alt   = q('#gate-switch-btn');
  if (loginHint?.email) {
    label.textContent = `Continue as ${loginHint.email}`;
    alt?.classList.remove('hidden');
  } else {
    label.textContent = 'Continue with Google';
    alt?.classList.add('hidden');
  }
}

// The session can't be renewed silently — ask for one click. Edits stay safe in
// localStorage and are uploaded as soon as the user reconnects.
function requestReconnect() {
  needsReauth = true;
  renderGate();
  setGateStatus('Your Google session expired. Reconnect to keep syncing — your changes are safe on this device.');
  showAuthGate();
}

// ─── ANONYMOUS UNIQUE-SIGN-IN COUNTER ────────────────────────────────────────
// Records that *some* Google account signed in — never which one. The Google
// account id is hashed client-side before it ever leaves the browser, so we
// (and Supabase) only ever see an irreversible hash, never the email or name.
async function pingUniqueUser() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !gUser?.sub) return;
  try {
    const bytes = new TextEncoder().encode(gUser.sub);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const userHash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');

    // Plain insert, not an upsert — the primary key rejects repeat sign-ins
    // (409, ignored below) so each hash is only ever recorded once.
    await fetch(`${SUPABASE_URL}/rest/v1/users_seen`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify([{ user_hash: userHash }])
    });
  } catch (e) { console.warn('unique-user ping failed (non-fatal):', e); }
}

// ─── TOKEN LIFECYCLE ─────────────────────────────────────────────────────────
// Google's browser-only flow hands out 1-hour access tokens and no refresh
// token, so we manage the hour ourselves: remember when it ends, renew it
// quietly before then (and again lazily whenever it's needed, because timers
// stop while a laptop sleeps), and fall back to a one-click gate if Google
// won't renew without the user.
const loadHint = () => { try { return JSON.parse(lsGet(LS_HINT)); } catch { return null; } };
function saveHint(u) {
  loginHint = { sub: u.sub, email: u.email, name: u.name, given_name: u.given_name, picture: u.picture };
  lsSet(LS_HINT, JSON.stringify(loginHint));
}

let loginHint     = loadHint();   // who signed in last time (no secrets)
let gTokenExpiry  = 0;
let refreshTimer  = null;
let needsReauth   = false;        // true while only an interactive click can renew
let needConsent   = false;        // user un-ticked the Drive permission
let authWaiters   = [];
let authTimeout   = null;
let lastAuthError = null;
let lastSilentFailAt = 0;
let authTransient = false;        // last renewal failed for a reason that isn't "sign in again"
let refreshInFlight = null;
let offlineMode   = false;        // working from the local copy until Drive is reachable
let reconcileTimer = null;
let reconciling   = false;
let gsiWaiting    = false;

const tokenFresh = (margin = 30000) => !!gAccessToken && Date.now() < gTokenExpiry - margin;
const hasDriveScope = resp => google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_APPDATA);

function applyToken(resp) {
  gAccessToken = resp.access_token;
  gTokenExpiry = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
  needsReauth  = false;
  if (resp.scope) gScopes = resp.scope;
  try { sessionStorage.setItem(SS_TOKEN, JSON.stringify({ token: gAccessToken, exp: gTokenExpiry, scope: gScopes })); } catch {}
  scheduleTokenRefresh();
}

// Reuse this tab's token across reloads so a refresh doesn't mean a new login.
function restoreToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem(SS_TOKEN));
    if (t?.token && t.exp - Date.now() > TOKEN_SKEW_MS) {
      gAccessToken = t.token;
      gTokenExpiry = t.exp;
      gScopes = t.scope || '';
      scheduleTokenRefresh();
      return true;
    }
  } catch {}
  return false;
}

function scheduleTokenRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => ensureToken(), Math.max(5000, gTokenExpiry - TOKEN_SKEW_MS - Date.now()));
}

function settleAuth(resp, errType) {
  clearTimeout(authTimeout);
  lastAuthError = errType || null;
  authWaiters.splice(0).forEach(fn => fn(resp));
}

// One Google request at a time; concurrent callers share the result.
function requestToken(prompt, hint) {
  return new Promise(resolve => {
    authWaiters.push(resolve);
    if (authWaiters.length > 1) return;
    authTimeout = setTimeout(() => settleAuth(null, 'timeout'), prompt === '' ? 20000 : 300000);
    try {
      const cfg = { prompt };
      if (hint) cfg.login_hint = hint;
      tokenClient.requestAccessToken(cfg);
    } catch (e) { settleAuth(null, 'exception'); }
  });
}

// A valid token, renewed silently when it is close to expiring; null if only
// an interactive sign-in can get one.
async function ensureToken() {
  if (tokenFresh(TOKEN_SKEW_MS)) return gAccessToken;
  const fallback = () => (tokenFresh() ? gAccessToken : null);
  authTransient = false;
  if (!navigator.onLine) { authTransient = true; return fallback(); }
  if (needsReauth) return fallback();

  if (AUTH_API) {
    // Session server: a refresh token (kept in an httpOnly cookie) renews it with no popup
    const res = await serverRefresh();
    if (res.status === 'ok') return gAccessToken;
    authTransient = res.status === 'transient';
    return fallback();
  }

  if (!tokenClient) return fallback();
  if (Date.now() - lastSilentFailAt < 60000) return fallback();   // don't spam popups
  const resp = await requestToken('', loginHint?.email);
  if (resp) return gAccessToken;
  lastSilentFailAt = Date.now();
  return fallback();
}

// New access token from the session server. 'reauth' = no/dead session (sign in
// again); 'transient' = server asleep or offline (keep going, try later).
function serverRefresh() {
  refreshInFlight ??= (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45000);   // free hosts take a while to wake up
    try {
      const r = await fetch(`${AUTH_API}/auth/refresh`, { method: 'POST', credentials: 'include', signal: ctl.signal });
      if (r.ok) { applyToken(await r.json()); return { status: 'ok' }; }
      if (r.status === 401) return { status: 'reauth' };
      return { status: 'transient' };
    } catch { return { status: 'transient' }; }
    finally { clearTimeout(timer); refreshInFlight = null; }
  })();
  return refreshInFlight;
}

function startServerLogin(switchAccount) {
  const u = new URL(`${AUTH_API}/auth/login`);
  u.searchParams.set('app', location.origin);
  if (switchAccount || !loginHint?.email) u.searchParams.set('switch', '1');
  else u.searchParams.set('hint', loginHint.email);
  setGateStatus('Redirecting to Google…');
  location.href = u.toString();
}

function serverAuthErrorMessage(code) {
  if (code === 'access_denied') return 'Sign-in was cancelled — try again.';
  if (code === 'scope') return 'Taskboards needs permission to use its private Drive folder — tick the Drive box and try again.';
  return 'Sign-in didn’t complete — please try again.';
}
const SERVER_DOWN_MSG = 'Can’t reach the sign-in service right now — check your connection and try again.';

function gateErrorMessage(type) {
  if (type === 'popup_failed_to_open') return 'Your browser blocked the sign-in window — allow pop-ups for this site and try again.';
  if (type === 'popup_closed' || type === 'access_denied') return 'Sign-in was cancelled — try again.';
  return 'Couldn’t reach Google — check your connection and try again.';
}

// ─── GOOGLE IDENTITY SERVICES ────────────────────────────────────────────────
function createTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: resp => {
      if (resp.error) return settleAuth(null, resp.error);
      applyToken(resp);
      settleAuth(resp);
    },
    error_callback: err => settleAuth(null, err?.type || 'error')
  });
}

// Wait for the GSI library (an ad-blocker can stop it entirely)
function waitForGsi() {
  if (gsiWaiting) return;
  gsiWaiting = true;
  const started = Date.now();
  const timer = setInterval(() => {
    if (!window.google?.accounts?.oauth2) {
      if (Date.now() - started > 15000) {
        clearInterval(timer);
        gsiWaiting = false;
        if (!offlineMode) setGateStatus('Couldn’t load Google sign-in — check your connection or content blocker, then reload.');
      }
      return;
    }
    clearInterval(timer);
    gsiWaiting = false;
    createTokenClient();
    if (offlineMode) return;   // reconcile() takes it from here
    setGateStatus('');
    trySilentSignIn();
  }, 200);
}

// The page's own <script> fails when it loads offline — fetch it again later
function ensureGsiLoaded() {
  if (window.google?.accounts?.oauth2) { if (!tokenClient) createTokenClient(); return; }
  if (!document.querySelector('script[data-gsi-retry]')) {
    const el = document.createElement('script');
    el.src = 'https://accounts.google.com/gsi/client';
    el.async = true;
    el.dataset.gsiRetry = '1';
    el.onerror = () => el.remove();
    document.head.appendChild(el);
  }
  waitForGsi();
}

// ─── OFFLINE ─────────────────────────────────────────────────────────────────
// If Drive can't be reached but this device has signed in before, keep working
// from the local copy. Edits stay flagged as unsynced; as soon as Drive is
// reachable bootData() decides who is newer — upload ours, or ask on a real conflict.
const hasOfflineProfile = () => !!(lsGet(LS_SUB) && loginHint?.email);

function enterOfflineMode() {
  const first = !offlineMode;
  offlineMode = true;
  driveReady  = false;          // nothing is written to Drive until we've compared versions
  gUser = gUser || loginHint;
  showUserPill();
  showSkeleton(false);
  renderTabs();
  renderOwnerFilterChips();
  renderBoard();
  hideAuthGate();
  setGateStatus('');
  setSyncStatus('error', navigator.onLine ? 'Drive unreachable — saved on this device' : 'Offline — saved on this device');
  if (first) showToast('Offline — your changes are kept here and sync when you’re back', 'info');
  scheduleReconcile();
}

function leaveOfflineMode() { offlineMode = false; clearTimeout(reconcileTimer); }

function scheduleReconcile(delay = 20000) {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(reconcile, delay);
}

// Try to get back in sync with Drive.
async function reconcile() {
  if (!offlineMode || reconciling) return;
  if (!navigator.onLine) return scheduleReconcile();
  if (!AUTH_API && !tokenClient) { ensureGsiLoaded(); return scheduleReconcile(5000); }
  reconciling = true;
  try {
    if (!tokenFresh() && !(await ensureToken())) {
      if (authTransient) return scheduleReconcile();
      return requestReconnect();   // the session is gone — one click needed
    }
    await completeSignIn(true);
  } finally { reconciling = false; }
}

function initGSI() {
  q('#gate-login-btn').addEventListener('click', () => onGateContinue(false));
  q('#gate-switch-btn')?.addEventListener('click', () => onGateContinue(true));
  renderGate();

  if (AUTH_API) { trySilentSignIn(); return; }

  if (!GOOGLE_CLIENT_ID) {
    setGateStatus('Google sign-in isn’t configured for this deployment.');
    q('#gate-login-btn').disabled = true;
    return;
  }

  if (!navigator.onLine && hasOfflineProfile()) enterOfflineMode();   // opened with no connection
  waitForGsi();
}

// On load: pick up where the user left off without a click if Google allows.
async function trySilentSignIn() {
  if (AUTH_API) {
    const err = new URLSearchParams(location.search).get('auth_error');
    if (err) { history.replaceState(null, '', location.pathname); setGateStatus(serverAuthErrorMessage(err)); }
    if (restoreToken()) { await completeSignIn(); return; }
    const res = await serverRefresh();
    if (res.status === 'ok') await completeSignIn();
    else if (res.status === 'transient') {
      if (hasOfflineProfile()) enterOfflineMode();
      else setGateStatus(SERVER_DOWN_MSG);
    }
    return;
  }
  if (restoreToken()) { await completeSignIn(); return; }
  if (!loginHint) return;
  const resp = await requestToken('', loginHint.email);
  if (resp && hasDriveScope(resp)) await completeSignIn();
  else setGateStatus('');   // popup blocked or session gone — one click continues
}

// Token in hand: reopen the app (first sign-in) or just resume syncing (reconnect).
async function afterToken(switchAccount) {
  if (driveReady && !switchAccount) {
    hideAuthGate();
    setGateStatus('');
    if (isDirty()) driveSaveData();
    return;
  }
  await completeSignIn();
}

async function onGateContinue(switchAccount) {
  if (!AUTH_API && !tokenClient) { setGateStatus('Loading Google sign-in…'); return; }
  const btn = q('#gate-login-btn');
  btn.disabled = true;
  try {
    // Retrying after a failed Drive load: the token is still good, skip Google
    if (!switchAccount && !needsReauth && tokenFresh()) { await completeSignIn(); return; }

    if (AUTH_API) {
      if (!switchAccount) {
        // A session may still be alive (e.g. the server was only asleep) — try that first
        setGateStatus('Signing you in…');
        const res = await serverRefresh();
        if (res.status === 'ok') { needsReauth = false; await afterToken(false); return; }
        if (res.status === 'transient') { setGateStatus(SERVER_DOWN_MSG); return; }
      }
      startServerLogin(switchAccount);
      return;
    }

    setGateStatus('Opening Google sign-in…');
    const prompt = needConsent ? 'consent' : (switchAccount || !loginHint ? 'select_account' : '');
    const resp = await requestToken(prompt, switchAccount ? undefined : loginHint?.email);
    if (!resp) { setGateStatus(gateErrorMessage(lastAuthError)); return; }

    if (!hasDriveScope(resp)) {
      needConsent = true;
      setGateStatus('Taskboards needs permission to use its private Drive folder — tick the Drive box and try again.');
      return;
    }
    needConsent = false;

    await afterToken(switchAccount);
  } finally {
    btn.disabled = false;
  }
}

async function completeSignIn(quiet = false) {
  if (!quiet) setGateStatus('Loading your boards…');
  driveReady = false;
  await loadUser();
  await bootData(quiet);
}

async function loadUser() {
  gUser = null;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${gAccessToken}` } });
    if (r.ok) gUser = await r.json();
  } catch (e) { console.warn('userinfo failed', e); }
  if (!gUser && loginHint) gUser = loginHint;   // keep going if only userinfo is down

  if (gUser?.sub) {
    // A different account must never inherit (and upload) the previous user's boards
    const prev = lsGet(LS_SUB);
    if (prev && prev !== gUser.sub) resetLocalData();
    lsSet(LS_SUB, gUser.sub);
    saveHint(gUser);
  }
  showUserPill();
}

function resetLocalData() {
  [LS_BOARDS, LS_CURRENT, LS_DRIVE_FID, LS_DIRTY, LS_BASE].forEach(k => lsDel(k));
  driveFileId = null;
  driveModified = null;
  changeSeq = savedSeq = 0;
  lsDel(LS_PENDING_REVOKES);
  shareKeys.clear();
  lastPublished.clear();
  boards = [defaultBoard()];
  currentBoardId = boards[0].id;
}

// Decide between this device's copy and Drive's, then open the app.
async function bootData(quiet = false) {
  setSyncStatus('syncing', 'Loading from Drive…');
  if (!quiet) showSkeleton(true);
  try {
    const remote      = await driveLoadData();
    const hasRemote   = !!remote?.data.boards.length;
    const localDirty  = lsGet(LS_DIRTY) === '1';
    const base        = lsGet(LS_BASE);
    let upload = false;

    if (hasRemote && !localDirty) {
      applyRemote(remote);
      showToast(`Loaded ${remote.data.boards.length} boards`, 'success');
    } else if (hasRemote) {
      // Unsynced edits from a previous session: keep them unless Drive changed too
      const moved = !base || Date.parse(remote.modifiedTime) > Date.parse(base);
      if (moved && !keepLocalOnConflict()) applyRemote(remote);
      else { setDriveModified(remote.modifiedTime); upload = true; }
    } else {
      setDriveModified(remote?.modifiedTime);
      upload = true;
      showToast('Ready to save to Drive', 'info');
    }

    driveReady = true;
    const wasOffline = offlineMode;
    leaveOfflineMode();
    showSkeleton(false);
    renderTabs();
    renderOwnerFilterChips();
    renderBoard();
    hideAuthGate();
    setGateStatus('');
    pingUniqueUser(); // fire-and-forget anonymous sign-in counter

    if (upload) {
      markDirty();
      await driveSaveData();
      if (wasOffline && !isDirty()) showToast('Back online — your changes are synced', 'success');
    }
    else setSyncStatus('synced', 'Loaded from Drive ✓');
    publishShares();
  } catch (err) {
    console.error('bootData error:', err.message);
    showSkeleton(false);
    setSyncStatus('error', 'Load failed');
    if (err instanceof AuthError) { requestReconnect(); return; }
    // Couldn't reach Drive: a returning user keeps working from the local copy
    if (hasOfflineProfile()) { enterOfflineMode(); return; }
    // Never save over Drive after a failed load — just offer a retry
    renderGate();
    showAuthGate();
    setGateStatus('Couldn’t load your boards from Drive — check your connection and try again.');
  }
}

function showUserPill() {
  if (!gUser) return;
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

async function handleLogout() {
  // Don't drop edits that haven't reached Drive without saying so
  clearTimeout(saveTimer);
  const unsynced = () => isDirty() || lsGet(LS_DIRTY) === '1';
  if ((driveReady || offlineMode) && unsynced()) {
    await driveSaveData();
    if (unsynced() && !confirm('Some changes haven’t reached Drive yet and will be lost if you sign out. Sign out anyway?')) return;
  }

  if (AUTH_API) {
    // Revokes the refresh token at Google and clears the session cookie
    try { await fetch(`${AUTH_API}/auth/logout`, { method: 'POST', credentials: 'include' }); } catch {}
  } else if (gAccessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(gAccessToken, () => {});
  }
  clearTimeout(refreshTimer);
  clearTimeout(retryTimer);
  try { sessionStorage.removeItem(SS_TOKEN); } catch {}
  gAccessToken = null;
  gTokenExpiry = 0;
  gUser = null;
  loginHint = null;
  driveReady = false;
  leaveOfflineMode();
  needsReauth = false;
  lsDel(LS_HINT);
  lsDel(LS_SUB);

  // Clear boards from local storage so next user starts clean
  resetLocalData();
  archiveExpanded = false;
  doneExpanded = false;
  q('#archive-bar').classList.remove('expanded');
  q('#done-bar').classList.remove('expanded');
  tabPage = 0;

  closeUserMenu();
  q('#user-pill').classList.add('hidden');
  setSyncStatus('', 'Offline');
  renderGate();
  showAuthGate();

  // Back to the landing page — signing out means leaving the app, not just
  // re-showing the gate on top of it.
  location.href = './index.html';
}

q('#logout-btn')?.addEventListener('click', handleLogout);

// ─── BACKUP: EXPORT / IMPORT ─────────────────────────────────────────────────
// A plain .json copy of all boards — a safety net outside Drive and the browser.

function exportBackup() {
  const data = { app: 'taskboards', version: 1, exportedAt: new Date().toISOString(), boards, currentBoardId };
  downloadText(JSON.stringify(data, null, 2), `taskboards-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  showToast('Backup downloaded', 'success');
}

// Keep only fields we know, so a hand-edited or foreign file can't inject odd data.
function cleanBoards(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('no boards');
  const boardIds = new Set();
  return raw.map((b, i) => {
    if (!b || typeof b !== 'object' || !Array.isArray(b.cards)) throw new Error('bad board');
    const id = typeof b.id === 'string' && b.id && !boardIds.has(b.id) ? b.id : uid();
    boardIds.add(id);
    const cards = TBShare.cleanCards(b.cards, uid);
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : `Board ${i + 1}`;
    const board = { id, name, cards, createdAt: Number(b.createdAt) || Date.now() };
    if (HEX_COLOR.test(b.color)) board.color = b.color;
    return board;
  });
}

async function importBackup(file) {
  let imported, parsed;
  try {
    if (file.size > 20e6) throw new Error('file too large');
    parsed = JSON.parse(await file.text());
    imported = cleanBoards(parsed?.boards ?? parsed);   // also accepts the raw Drive file
  } catch (e) {
    console.warn('import failed:', e.message);
    showToast('That file isn’t a valid Taskboards backup', 'error');
    return;
  }
  const nCards = imported.reduce((n, b) => n + b.cards.length, 0);
  // Public links belong to the boards they were made for: keep them for boards that are
  // still in the file, and take the rest offline rather than leave them orphaned.
  const current = new Map(boards.map(b => [b.id, b]));
  imported.forEach(b => { const o = current.get(b.id); if (o?.share) b.share = o.share; });
  const kept = new Set(imported.filter(b => b.share).map(b => b.share.fileId));
  const orphaned = boards.filter(b => b.share?.fileId && !kept.has(b.share.fileId));
  if (!confirm(
    `Replace ALL your current boards with the ${imported.length} board(s) and ${nCards} card(s) in "${file.name}"?\n\n` +
    (orphaned.length ? `${orphaned.length} shared board(s) will stop being shared.\n\n` : '') +
    'Tip: export a backup of your current boards first — this can’t be undone.'
  )) return;
  orphaned.forEach(b => queueRevoke(b.share.fileId));

  boards = imported;
  currentBoardId = imported.find(b => b.id === parsed?.currentBoardId)?.id || imported[0].id;
  tabPage = 0;
  onDataChanged();   // saved locally now, synced to Drive as usual
  renderTabs();
  renderOwnerFilterChips();
  renderBoard();
  showToast(`Imported ${imported.length} board(s)`, 'success');
}

q('#export-btn')?.addEventListener('click', exportBackup);
q('#import-btn')?.addEventListener('click', () => q('#import-file').click());
q('#import-file')?.addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';   // allow re-importing the same file
  if (file) importBackup(file);
});

// ─── REPORT: MARKDOWN SNAPSHOT ───────────────────────────────────────────────
// A readable snapshot of the current board, cards grouped by status — to keep a
// record of the week's work before clearing Done. Saved to "taskboards_reports"
// in the root of the user's Drive, or downloaded when Drive can't take it.
const REPORT_FOLDER   = 'taskboards_reports';
const LS_REPORT_FID   = 'taskboards-report-folder';
const REPORT_SECTIONS = [['done', 'Done'], ['inprogress', 'In progress'], ['todo', 'To do'], ['archive', 'Archive']];

const pad2 = n => String(n).padStart(2, '0');
const mdText = s => String(s || '').replace(/\s+/g, ' ').replace(/([\\`*_[\]<>#|])/g, '\\$1').trim();

function reportFilename(board, d) {
  const name = board.name.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'board';
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `taskboards_${name}_${date}_${time}.md`;
}

function buildReport(board, d) {
  const sorted = status => board.cards.filter(c => c.status === status)
    .sort((a, b) => (a.sortOrder ?? a.createdAt) - (b.sortOrder ?? b.createdAt));
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const lines = [
    `# ${mdText(board.name)}`, '',
    `Taskboards snapshot · ${stamp}`, '',
    REPORT_SECTIONS.map(([s, label]) => `${label}: ${sorted(s).length}`).join(' · '), ''
  ];
  for (const [status, label] of REPORT_SECTIONS) {
    const cards = sorted(status);
    lines.push(`## ${label} (${cards.length})`, '');
    if (!cards.length) { lines.push('_No cards_', ''); continue; }
    for (const c of cards) {
      const meta = [c.owner && `@${mdText(c.owner)}`, c.dueDate && `due ${c.dueDate}`].filter(Boolean).join(' · ');
      lines.push(`- [${status === 'done' ? 'x' : ' '}] ${mdText(c.title)}${meta ? ` — ${meta}` : ''}`);
      if (c.note) c.note.split('\n').forEach(l => lines.push(`  > ${l}`));
    }
    lines.push('');
  }
  return lines.join('\n');
}

function downloadText(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The app only sees Drive folders it created itself (drive.file), so it keeps its own.
async function reportFolderId() {
  const cached = lsGet(LS_REPORT_FID);
  if (cached) {
    const r = await driveFetch(`${DRIVE_API}/files/${cached}?fields=id,trashed`);
    if (r.ok && !(await r.json()).trashed) return cached;
    lsDel(LS_REPORT_FID);
  }
  const query = encodeURIComponent(`name='${REPORT_FOLDER}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`);
  const found = await driveFetch(`${DRIVE_API}/files?q=${query}&fields=files(id)&spaces=drive`);
  if (!found.ok) throw new Error(`folder lookup ${found.status}`);
  let id = (await found.json()).files?.[0]?.id;
  if (!id) {
    const r = await driveFetch(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: REPORT_FOLDER, mimeType: 'application/vnd.google-apps.folder', parents: ['root'] })
    });
    if (!r.ok) throw new Error(`folder create ${r.status}`);
    id = (await r.json()).id;
  }
  lsSet(LS_REPORT_FID, id);
  return id;
}

async function driveSaveReport(text, filename) {
  const parent = await reportFolderId();
  const boundary = 'tb' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: filename, mimeType: 'text/markdown', parents: [parent] }) +
    `\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
  const r = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!r.ok) throw new Error(`report upload ${r.status}`);
}

let reportBusy = false;
async function exportReport() {
  const board = currentBoard();
  if (!board || reportBusy) return;
  const d = new Date();
  const text = buildReport(board, d);
  const filename = reportFilename(board, d);
  if (driveReady && navigator.onLine && hasShareScope()) {
    reportBusy = true;
    try {
      await driveSaveReport(text, filename);
      showToast(`Report saved to Drive › ${REPORT_FOLDER}`, 'success');
      return;
    } catch (e) {
      console.warn('report to Drive failed:', e.message);
    } finally { reportBusy = false; }
  }
  downloadText(text, filename, 'text/markdown');
  showToast('Report downloaded — couldn’t save it to Drive', 'info');
}

q('#report-btn')?.addEventListener('click', exportReport);

// Keep the Drive copy fresh and complete as the tab/device comes and goes
document.addEventListener('visibilitychange', async () => {
  if (!driveReady) return;
  if (document.visibilityState === 'hidden') { flushSave(); return; }
  if (await ensureToken()) driveRefreshIfNewer();
  else if (!authTransient) requestReconnect();
});
window.addEventListener('pagehide', flushSave);
window.addEventListener('online', () => {
  if (offlineMode) { showToast('Back online — syncing…', 'info'); reconcile(); return; }
  if (driveReady && isDirty()) driveSaveData();
  publishShares();
});
window.addEventListener('offline', () => {
  if (!driveReady) return;
  setSyncStatus('error', 'Offline — saved on this device');
  showToast('You’re offline — changes are kept here and sync later', 'info');
});

// ─── SHARING: read-only public link, encrypted with a passphrase ─────────────
// Sharing is per board. A shared board is copied to ONE separate Drive file that anyone
// with the link can download, but its content is AES-encrypted with a passphrase that only
// the owner and the people they tell know (see share-core.js). Every other board stays
// private, and the owner's own copy remains the only editable one: the shared file is
// overwritten whenever the board changes, so viewers always see the latest version.
// Revoking deletes the file, which kills the link for good.
class ShareError extends Error {}

const LS_PENDING_REVOKES = 'taskboards-pending-revokes';   // shared files still to delete (board deleted offline…)
const shareKeys     = new Map();   // boardId → CryptoKey (derived once per session)
const lastPublished = new Map();   // boardId → snapshot already on Drive
let sharePublishing = false;
let shareRetryTimer = null;
let shareRetryDelay = 0;
let shareModalBoardId = null;

const hasShareScope = () => gScopes.includes(DRIVE_FILE);
const shareUrl      = board => `${location.origin}/view.html?b=${encodeURIComponent(board.share.fileId)}`;

// What a viewer gets: the board's name and cards — nothing else
const sharePayload = board => ({
  v: 1,
  name: board.name,
  cards: board.cards.map(c => ({
    id: c.id, title: c.title, owner: c.owner || '', dueDate: c.dueDate || '',
    status: c.status, createdAt: c.createdAt, sortOrder: c.sortOrder
  }))
});

async function shareEnvelope(board, share = board.share) {
  let key = shareKeys.get(board.id);
  if (!key || share !== board.share) key = await TBShare.deriveKey(share.passphrase, share.salt);
  const payload = sharePayload(board);
  const env = await TBShare.encrypt({ ...payload, publishedAt: Date.now() }, key, share.salt);
  return { key, snapshot: JSON.stringify(payload), body: JSON.stringify(env) };
}

// Make this board public (read-only). Throws ShareError('scope') if Google hasn't granted file access yet.
async function shareCreate(board) {
  if (!hasShareScope()) throw new ShareError('scope');
  const share = { fileId: null, passphrase: TBShare.generatePassphrase(), salt: TBShare.newSalt(), createdAt: Date.now() };
  const { key, snapshot, body } = await shareEnvelope(board, share);

  const boundary = 'taskboards_share_' + Date.now();
  const multipart = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify({ name: `Taskboards — ${board.name}`, mimeType: 'application/json' }),
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    body,
    `--${boundary}--`
  ].join('\r\n');
  const r = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart
  });
  if (r.status === 403) throw new ShareError('scope');
  if (!r.ok) throw new Error(`create ${r.status}`);
  share.fileId = (await r.json()).id;
  if (!share.fileId) throw new Error('no file id');

  // Anyone with the link can download it — but it is encrypted, and not listed or searchable
  const p = await driveFetch(`${DRIVE_API}/files/${share.fileId}/permissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false })
  });
  if (!p.ok) {
    await driveFetch(`${DRIVE_API}/files/${share.fileId}`, { method: 'DELETE' }).catch(() => {});
    throw new Error(`permission ${p.status}`);
  }

  board.share = share;
  shareKeys.set(board.id, key);
  lastPublished.set(board.id, snapshot);
  onDataChanged();
  renderTabs();
}

// Delete the shared copy; the link stops working immediately. Nothing changes if this fails.
async function shareRevoke(board) {
  const r = await driveFetch(`${DRIVE_API}/files/${board.share.fileId}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw new Error(`revoke ${r.status}`);
  board.share = null;
  shareKeys.delete(board.id);
  lastPublished.delete(board.id);
  onDataChanged();
  renderTabs();
}

// The shared file vanished (deleted in Drive): the board is private again
function shareLost(board) {
  board.share = null;
  shareKeys.delete(board.id);
  lastPublished.delete(board.id);
  onDataChanged();
  renderTabs();
  showToast(`“${board.name}” is private again — its shared copy was removed from Drive`, 'info');
}

async function sharePublishOne(board) {
  const { key, snapshot, body } = await shareEnvelope(board);
  shareKeys.set(board.id, key);
  const r = await driveFetch(`${DRIVE_UPLOAD_API}/files/${board.share.fileId}?uploadType=media&fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: body.length < 60000
  });
  if (r.status === 404) return shareLost(board);
  if (!r.ok) throw new Error(`publish ${r.status}`);
  lastPublished.set(board.id, snapshot);
}

// Push any shared board that changed since the last publish (and finish pending revocations)
async function publishShares() {
  if (!driveReady || sharePublishing || needsReauth) return;
  sharePublishing = true;
  try {
    await processPendingRevokes();
    for (const b of boards.filter(b => b.share?.fileId && JSON.stringify(sharePayload(b)) !== lastPublished.get(b.id))) {
      await sharePublishOne(b);
    }
    shareRetryDelay = 0;
  } catch (e) {
    console.warn('share publish failed:', e.message);
    if (!(e instanceof AuthError)) {   // network/5xx: try again, edits are never lost
      shareRetryDelay = Math.min((shareRetryDelay || 4000) * 2, 60000);
      clearTimeout(shareRetryTimer);
      shareRetryTimer = setTimeout(publishShares, shareRetryDelay);
    }
  } finally { sharePublishing = false; }
}

// Deleting a shared board (or replacing everything via import) must also take its public copy offline
const pendingRevokes = () => { try { return JSON.parse(lsGet(LS_PENDING_REVOKES)) || []; } catch { return []; } };
function queueRevoke(fileId) {
  const list = pendingRevokes();
  if (!list.includes(fileId)) { list.push(fileId); lsSet(LS_PENDING_REVOKES, JSON.stringify(list)); }
}
async function processPendingRevokes() {
  const list = pendingRevokes();
  if (!list.length) return;
  const left = [];
  for (const id of list) {
    try {
      const r = await driveFetch(`${DRIVE_API}/files/${id}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) left.push(id);
    } catch (e) { if (e instanceof AuthError) throw e; left.push(id); }
  }
  if (left.length) lsSet(LS_PENDING_REVOKES, JSON.stringify(left)); else lsDel(LS_PENDING_REVOKES);
}

// ── share dialog ─────────────────────────────────────────────────────────────
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

const shareBoard = () => boards.find(b => b.id === shareModalBoardId);

function openShareModal(boardId) {
  shareModalBoardId = boardId;
  renderShareModal();
  q('#share-overlay').classList.remove('hidden');
}
function closeShareModal() {
  q('#share-overlay').classList.add('hidden');
  shareModalBoardId = null;
}

// state: { busy: 'text' } | { needScope: true } | { error: 'text' }
function renderShareModal(state = {}) {
  const board = shareBoard();
  if (!board) { closeShareModal(); return; }
  const body = q('#share-body');
  q('#share-title').innerHTML = board.share ? `${ICON_ROCKET} PUBLIC BOARD` : `${ICON_LOCK} PRIVATE BOARD`;

  if (state.busy) { body.innerHTML = `<p class="share__text">${esc(state.busy)}</p>`; return; }

  const err = state.error ? `<p class="share__error">${esc(state.error)}</p>` : '';

  if (!board.share && !DRIVE_API_KEY) {
    body.innerHTML = `
      <p class="share__text">Only you can see <strong>${esc(board.name)}</strong>.</p>
      <p class="share__note">Board sharing isn’t enabled on this site yet.</p>`;
    return;
  }

  if (!board.share) {
    body.innerHTML = `
      <p class="share__text">Only you can see <strong>${esc(board.name)}</strong>.</p>
      <p class="share__text share__text--dim">Share a read-only link: anyone with the link <em>and</em> the passphrase can see the latest version of this board. Your other boards stay private.</p>
      ${state.needScope ? '<p class="share__note">Sharing needs one more Google permission — to create the shared copy of this board in your Drive.</p>' : ''}
      ${err}
      <div class="share__actions">
        <button class="modal__submit" data-act="${state.needScope ? 'grant' : 'create'}">${state.needScope ? 'GRANT PERMISSION' : 'SHARE LINK'}</button>
      </div>`;
    return;
  }

  body.innerHTML = `
    <div class="modal__field">
      <label class="modal__label" for="share-link">LINK</label>
      <div class="share__row"><input class="modal__input" id="share-link" readonly value="${esc(shareUrl(board))}" /><button class="share__copy" data-act="copy" data-target="share-link">COPY</button></div>
    </div>
    <div class="modal__field">
      <label class="modal__label" for="share-pass">PASSPHRASE</label>
      <div class="share__row"><input class="modal__input share__pass" id="share-pass" readonly value="${esc(board.share.passphrase)}" /><button class="share__copy" data-act="copy" data-target="share-pass">COPY</button></div>
    </div>
    <p class="share__text share__text--dim">Read-only. Viewers see the latest version of <strong>${esc(board.name)}</strong> — your edits are published within seconds. Only this board is shared.</p>
    ${err}
    <div class="share__actions">
      <button class="modal__submit" data-act="copy-all">COPY SHARE DETAILS</button>
      <button class="modal__submit modal__submit--danger" data-act="revoke">REVOKE PUBLIC ACCESS</button>
    </div>`;
}

function shareErrorState(e) {
  if (e instanceof ShareError) return { needScope: true };
  if (e instanceof AuthError) return { error: 'Your Google session expired — reconnect and try again.' };
  return { error: 'Couldn’t reach Google Drive — check your connection and try again. Nothing was changed.' };
}

async function onShareAction(act, target) {
  const board = shareBoard();
  if (!board) return;

  if (act === 'copy') {
    const ok = await copyText(q('#' + target).value);
    showToast(ok ? 'Copied' : 'Couldn’t copy — select the text and copy it manually', ok ? 'success' : 'error');
    return;
  }
  if (act === 'copy-all') {
    const text = `Taskboards — ${board.name}\nLink: ${shareUrl(board)}\nPassphrase: ${board.share.passphrase}`;
    const ok = await copyText(text);
    showToast(ok ? 'Share details copied' : 'Couldn’t copy — select the text and copy it manually', ok ? 'success' : 'error');
    return;
  }

  if (act === 'grant') {
    flushSave();
    if (AUTH_API) { startServerLogin(false); return; }   // Google asks again, then brings the user back
    renderShareModal({ busy: 'Waiting for Google…' });
    const resp = await requestToken('consent', loginHint?.email);
    renderShareModal(!resp ? { error: gateErrorMessage(lastAuthError) } : hasShareScope() ? {} : { needScope: true });
    return;
  }

  if (act === 'create') {
    if (!driveReady || !navigator.onLine) { renderShareModal({ error: 'Sharing needs a connection to Google Drive — try again when you’re online.' }); return; }
    if (!hasShareScope()) { renderShareModal({ needScope: true }); return; }
    renderShareModal({ busy: 'Creating the shared copy…' });
    try {
      await shareCreate(board);
      renderShareModal();
      showToast('Board is now public (read-only)', 'success');
    } catch (e) { renderShareModal(shareErrorState(e)); }
    return;
  }

  if (act === 'revoke') {
    if (!confirm(`Stop sharing “${board.name}”?\n\nThe public copy is deleted and the link stops working immediately. The board stays in your account.`)) return;
    renderShareModal({ busy: 'Revoking public access…' });
    try {
      await shareRevoke(board);
      renderShareModal();
      showToast('Board is private again', 'success');
    } catch (e) { renderShareModal(shareErrorState(e)); }
  }
}

q('#share-body').addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (btn) onShareAction(btn.dataset.act, btn.dataset.target);
});
q('#share-close').addEventListener('click', closeShareModal);
q('#share-overlay').addEventListener('click', e => { if (e.target === q('#share-overlay')) closeShareModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && shareModalBoardId) closeShareModal(); });

// ─── CHANGE HANDLER ───────────────────────────────────────────────────────────
function onDataChanged() {
  saveToLocal();
  markDirty();
  if (driveReady) scheduleDriveSave();
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
  renderOwnerFilterChips();
  renderBoard();
}

function deleteBoard(id) {
  if (boards.length <= 1) return;
  const gone = boards.find(b => b.id === id);
  if (gone?.share?.fileId) queueRevoke(gone.share.fileId);   // its public copy goes with it
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
  renderOwnerFilterChips();
  renderBoard();
}

function renameBoard(id, name) {
  const b = boards.find(b => b.id === id);
  if (b) { b.name = name.trim() || b.name; onDataChanged(); }
}

// ─── CARD CRUD ────────────────────────────────────────────────────────────────
function createCard(title, owner, dueDate, status, note = '') {
  const zoneCards = currentBoard().cards.filter(c => c.status === status);
  const maxOrder  = zoneCards.reduce((m, c) => Math.max(m, c.sortOrder ?? c.createdAt), -1);
  const card = { id: uid(), title: title.trim(), owner: owner.trim(), dueDate, status, createdAt: Date.now(), sortOrder: maxOrder + 1 };
  if (note.trim()) card.note = note.trim();
  currentBoard().cards.push(card);
  onDataChanged();
  renderOwnerFilterChips();
  renderBoard();
  requestAnimationFrame(() => {
    const el = document.querySelector(`.card[data-id="${card.id}"]`);
    if (el) { el.classList.add('card--entering'); el.addEventListener('animationend', () => el.classList.remove('card--entering'), {once:true}); }
  });
  showToast(`Card "${title.trim().slice(0, 20)}${title.length > 20 ? '...' : ''}" created`, 'success');
}

function deleteCard(id) {
  const el = document.querySelector(`.card[data-id="${id}"]`);
  const card = currentBoard()?.cards.find(c => c.id === id);
  const cardTitle = card?.title || 'Card';
  const doDelete = () => {
    const cb = currentBoard();
    if (cb) cb.cards = cb.cards.filter(c => c.id !== id);
    deleteCardId = null;
    onDataChanged();
    renderOwnerFilterChips();
    renderBoard();
    showToast('Card deleted', 'info');
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
  const cardTitle = card.title || 'Card';

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
  if (newStatus === 'done' && wasStatus !== 'done') {
    setTimeout(launchConfetti, 80);
    showToast(`"${cardTitle.slice(0, 25)}${cardTitle.length > 25 ? '...' : ''}" completed!`, 'success');
  }
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

// A board's own colour (right-click its tab), else a stable one derived from its id
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const boardColor = board => (HEX_COLOR.test(board?.color) ? board.color : tabColor(board.id));

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
    t.innerHTML = `<button class="board-tab__share" style="pointer-events:none">${ICON_LOCK}</button><span class="board-tab__name">${esc(board.name)}</span>${boards.length > 1 ? '<button class="board-tab__delete" style="pointer-events:none">✕</button>' : ''}`;
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
    tab.style.setProperty('--tab-color', boardColor(board));
    if (tabDrag?.active && tabDrag.id === board.id) tab.classList.add('dragging-source');
    tab.innerHTML = `
      <button class="board-tab__share" title="${board.share ? 'Public (read-only) — click for share details' : 'Private — click to share'}" aria-label="${board.share ? 'Public board — share details' : 'Private board — share'}">${board.share ? ICON_ROCKET : ICON_LOCK}</button>
      <span class="board-tab__name">${esc(board.name)}</span>
      ${boards.length > 1 ? `<button class="board-tab__delete" title="Delete board">✕</button>` : ''}
    `;

    // Click to switch
    tab.addEventListener('click', e => {
      if (Date.now() < suppressTabClickUntil) return;   // a drag / long-press just ended on this tab
      if (e.target.closest('.board-tab__delete')) return;
      if (e.target.closest('.board-tab__share')) return;
      if (e.target.closest('.board-tab__name-input')) return;
      switchBoard(board.id);
    });

    // Right-click (or long-press on touch): pick the board's colour
    tab.addEventListener('contextmenu', e => {
      if (e.target.closest('.board-tab__name-input')) return;   // keep the normal menu while renaming
      e.preventDefault();
      openColorMenu(board, e.clientX, e.clientY);
    });

    // Drag to reorder
    tab.addEventListener('pointerdown', e => onTabPointerDown(e, board, tab));

    // Lock / rocket: open the share dialog for THIS board
    tab.querySelector('.board-tab__share').addEventListener('click', e => {
      e.stopPropagation();
      openShareModal(board.id);
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

// ─── BOARD COLOUR MENU ───────────────────────────────────────────────────────
let colorMenuEl = null;
function closeColorMenu() {
  colorMenuEl?.remove();
  colorMenuEl = null;
  document.removeEventListener('pointerdown', onColorMenuOutside, true);
  document.removeEventListener('keydown', onColorMenuKey, true);
  window.removeEventListener('resize', closeColorMenu);
}
function onColorMenuOutside(e) { if (colorMenuEl && !colorMenuEl.contains(e.target)) closeColorMenu(); }
function onColorMenuKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeColorMenu(); } }

function setBoardColor(boardId, color) {
  const b = boards.find(b => b.id === boardId);
  if (!b) return;
  if (color && HEX_COLOR.test(color)) b.color = color; else delete b.color;   // no colour = back to automatic
  onDataChanged();
  renderTabs();
}

function openColorMenu(board, x, y) {
  closeColorMenu();
  const current = boardColor(board).toLowerCase();
  const menu = document.createElement('div');
  menu.className = 'color-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Board colour');
  menu.innerHTML = `
    <div class="color-menu__title">Board colour</div>
    <div class="color-menu__grid">${TAB_COLORS.map(c =>
      `<button type="button" class="color-menu__sw${c.toLowerCase() === current ? ' active' : ''}" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('')}</div>
    <div class="color-menu__row">
      <label class="color-menu__custom">Custom <input type="color" value="${current}" aria-label="Custom colour"></label>
      <button type="button" class="color-menu__auto" data-color="">Auto</button>
    </div>`;
  document.body.appendChild(menu);
  colorMenuEl = menu;

  // keep it on screen
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth  - r.width  - 8)) + 'px';
  menu.style.top  = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';

  menu.addEventListener('click', e => {
    const btn = e.target.closest('[data-color]');
    if (!btn) return;
    setBoardColor(board.id, btn.dataset.color || null);
    closeColorMenu();
  });
  menu.querySelector('input[type=color]').addEventListener('change', e => {
    setBoardColor(board.id, e.target.value);
    closeColorMenu();
  });
  document.addEventListener('pointerdown', onColorMenuOutside, true);
  document.addEventListener('keydown', onColorMenuKey, true);
  window.addEventListener('resize', closeColorMenu);
}

// ─── BOARD TABS: DRAG TO REORDER ─────────────────────────────────────────────
// Pointer-based (so it works with mouse and touch). Hover over ‹ › while dragging to reach
// another page of tabs. A long-press on touch opens the colour menu, like right-click.
let tabDrag = null;
let suppressTabClickUntil = 0;

function onTabPointerDown(e, board, tabEl) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.target.closest('button, input')) return;
  tabDrag = { id: board.id, tabEl, startX: e.clientX, startY: e.clientY, active: false, insertIdx: null };
  if (e.pointerType === 'touch') {
    tabDrag.pressTimer = setTimeout(() => {
      if (!tabDrag || tabDrag.active) return;
      const { startX, startY } = tabDrag;
      endTabDrag();
      suppressTabClickUntil = Date.now() + 500;
      openColorMenu(board, startX, startY);
    }, 550);
  }
  document.addEventListener('pointermove', onTabPointerMove);
  document.addEventListener('pointerup', onTabPointerUp);
  document.addEventListener('pointercancel', onTabPointerUp);
}

function onTabPointerMove(e) {
  const d = tabDrag;
  if (!d) return;
  if (!d.active) {
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
    clearTimeout(d.pressTimer);
    if (boards.length < 2) { endTabDrag(); return; }
    d.active = true;
    const r = d.tabEl.getBoundingClientRect();
    d.grabDX = d.startX - r.left;
    d.ghost = d.tabEl.cloneNode(true);
    d.ghost.classList.add('tab-drag-ghost');
    d.ghost.style.width = r.width + 'px';
    d.ghost.style.height = r.height + 'px';
    document.body.appendChild(d.ghost);
    d.marker = document.createElement('div');
    d.marker.className = 'tab-drop-marker';
    document.body.appendChild(d.marker);
    d.tabEl.classList.add('dragging-source');
    document.body.classList.add('tab-dragging');
  }
  e.preventDefault();
  d.ghost.style.left = (e.clientX - d.grabDX) + 'px';
  d.ghost.style.top  = (d.tabEl.isConnected ? d.tabEl.getBoundingClientRect().top : q('#boards-tabs').getBoundingClientRect().top) + 'px';
  updateTabDropTarget(e);
  autoFlipTabPage(e);
}

// Where would the dragged board land? (index in the list without the dragged board)
function updateTabDropTarget(e) {
  const d = tabDrag;
  const bar = q('#boards-tabs').getBoundingClientRect();
  const others = [...document.querySelectorAll('#boards-tabs .board-tab')].filter(t => t.dataset.id !== d.id);
  const rest = boards.filter(b => b.id !== d.id);
  const inBar = e.clientY > bar.top - 50 && e.clientY < bar.bottom + 50;   // drop far away = cancel

  if (!inBar) { d.insertIdx = null; d.marker.style.display = 'none'; return; }
  if (!others.length) {
    d.insertIdx = boards.findIndex(b => b.id === d.id);
    d.marker.style.display = 'none';
    return;
  }
  let k = 0;
  while (k < others.length) {
    const r = others[k].getBoundingClientRect();
    if (e.clientX < r.left + r.width / 2) break;
    k++;
  }
  const ref = k < others.length ? others[k] : others[others.length - 1];
  const idxOfRef = rest.findIndex(b => b.id === ref.dataset.id);
  d.insertIdx = k < others.length ? idxOfRef : idxOfRef + 1;

  const rr = ref.getBoundingClientRect();
  d.marker.style.left    = ((k < others.length ? rr.left : rr.right) - 5) + 'px';
  d.marker.style.top     = rr.top + 'px';
  d.marker.style.height  = rr.height + 'px';
  d.marker.style.display = 'block';
}

// Hovering ‹ › while dragging turns the page, so a board can travel past the visible tabs
function autoFlipTabPage(e) {
  const d = tabDrag;
  const dir = [['#tab-prev', -1], ['#tab-next', 1]].find(([sel]) => {
    const b = q(sel), r = b?.getBoundingClientRect();
    return b && !b.disabled && r.width && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  })?.[1];
  if (!dir) { clearTimeout(d.flipTimer); d.flipTimer = null; d.flipDir = 0; return; }
  if (d.flipDir === dir) return;
  d.flipDir = dir;
  clearTimeout(d.flipTimer);
  const flip = () => {
    if (!tabDrag || tabDrag.flipDir !== dir) return;
    const pages = Math.ceil(boards.length / dynamicTabsPerPage);
    const next = Math.max(0, Math.min(tabPage + dir, pages - 1));
    if (next === tabPage) return;
    tabPage = next;
    renderTabs();
    d.tabEl = document.querySelector(`#boards-tabs .board-tab[data-id="${d.id}"]`) || d.tabEl;
    tabDrag.flipTimer = setTimeout(flip, 650);
  };
  d.flipTimer = setTimeout(flip, 450);
}

function endTabDrag() {
  const d = tabDrag;
  if (!d) return;
  clearTimeout(d.pressTimer);
  clearTimeout(d.flipTimer);
  d.ghost?.remove();
  d.marker?.remove();
  document.body.classList.remove('tab-dragging');
  document.querySelectorAll('.board-tab.dragging-source').forEach(t => t.classList.remove('dragging-source'));
  document.removeEventListener('pointermove', onTabPointerMove);
  document.removeEventListener('pointerup', onTabPointerUp);
  document.removeEventListener('pointercancel', onTabPointerUp);
  tabDrag = null;
}

function onTabPointerUp(e) {
  const d = tabDrag;
  if (!d) return;
  const commit = d.active && e.type === 'pointerup' && d.insertIdx != null;
  const { id, insertIdx, active } = d;
  endTabDrag();
  if (active) suppressTabClickUntil = Date.now() + 400;   // the drop must not also switch boards
  if (commit) reorderBoard(id, insertIdx);
}

function reorderBoard(id, toIndex) {
  const from = boards.findIndex(b => b.id === id);
  if (from < 0) return;
  const [moved] = boards.splice(from, 1);
  const to = Math.max(0, Math.min(toIndex, boards.length));
  boards.splice(to, 0, moved);
  if (to === from) { renderTabs(); return; }
  tabPage = Math.floor(to / dynamicTabsPerPage);
  onDataChanged();
  renderTabs();
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
  const zoneCounts = { todo:0, inprogress:0, archive:0, done:0 };
  
  cards.forEach(c => { 
    if (zones[c.status]) {
      zones[c.status].push(c);
      zoneCounts[c.status]++;
    }
  });
  
  // Sort each zone by sortOrder (falls back to createdAt for legacy cards)
  Object.values(zones).forEach(z => z.sort((a,b) => (a.sortOrder ?? a.createdAt) - (b.sortOrder ?? b.createdAt)));

  // Filter cards by owner if filter is active
  const filteredZones = {};
  const filteredCounts = { todo:0, inprogress:0, archive:0, done:0 };
  
  Object.entries(zones).forEach(([status, zoneCards]) => {
    filteredZones[status] = zoneCards.filter(card => isCardVisible(card));
    filteredCounts[status] = filteredZones[status].length;
  });

  renderZone('todo-cards',       filteredZones.todo,        false);
  renderZone('inprogress-cards', filteredZones.inprogress,  false);
  renderZone('archive-cards',    filteredZones.archive,      true);
  renderZone('done-cards',       filteredZones.done,         !doneExpanded);

  // Update counts: show filtered/total
  const hasFilter = selectedOwners.size > 0;
  const fmtCount = (filtered, total) => hasFilter ? `${filtered}/${total}` : String(filtered);
  
  q('#todo-count').textContent        = fmtCount(filteredCounts.todo, zoneCounts.todo);
  q('#inprogress-count').textContent  = fmtCount(filteredCounts.inprogress, zoneCounts.inprogress);
  q('#archive-count').textContent     = fmtCount(filteredCounts.archive, zoneCounts.archive);
  q('#done-count').textContent        = fmtCount(filteredCounts.done, zoneCounts.done);

  vis('#todo-empty',       filteredCounts.todo === 0);
  vis('#inprogress-empty', filteredCounts.inprogress === 0);
  vis('#archive-empty',    filteredCounts.archive === 0);
  vis('#done-empty',       filteredCounts.done === 0);
}

function renderZone(containerId, zoneCards, compact) {
  const c = q('#'+containerId);
  Array.from(c.querySelectorAll('.card')).forEach(el=>el.remove());
  zoneCards.forEach(card => c.appendChild(buildCardEl(card, compact)));
}

// Single-colour line icons (they follow the text colour) instead of colour emoji
const ICON_LOCK   = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
const ICON_SUN    = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const ICON_MOON   = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
const ICON_ROCKET = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2c3 2.5 4.5 6 4.5 9.5V16l2 3h-4L12 22l-2.5-3h-4l2-3v-4.5C7.5 8 9 4.5 12 2z"/><circle cx="12" cy="10" r="1.6"/></svg>`;

// Shown at the right of a card once it is red (double-click / right-click)
const ACTIONS_MARKUP = `<div class="card__actions" tabindex="-1">
        <button type="button" class="card__edit-btn" title="Edit card" aria-label="Edit card"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        <button type="button" class="card__delete-btn" title="Delete card" aria-label="Delete card">✕</button>
      </div>`;

// 🗒 at the bottom right of a card that has a note; click it to read the note
const NOTE_BTN_MARKUP = `<button type="button" class="card__note-btn" title="Show note" aria-label="Show note" aria-expanded="false">🗒️</button>`;

function buildCardEl(card, compact) {
  const el = document.createElement('div');
  el.className = `card card--${card.status}`;
  el.dataset.id = card.id;
  if (compact) {
    el.innerHTML = `
      ${ACTIONS_MARKUP}
      <span class="card__title-compact">${esc(card.title)}</span>
      ${card.owner ? `<span class="card__owner-compact">${esc(card.owner)}</span>` : ''}
      ${card.note ? NOTE_BTN_MARKUP : ''}
    `;
  } else {
    const dc = getDateCls(card.dueDate);
    el.innerHTML = `
      ${ACTIONS_MARKUP}
      <h3 class="card__title">${esc(card.title)}</h3>
      <div class="card__meta">
        ${card.owner ? `<span class="card__owner">${esc(card.owner)}</span>` : '<span></span>'}
        <span class="card__meta-end">
          ${card.dueDate ? `<span class="card__date ${dc}">${fmtDate(card.dueDate)}</span>` : ''}
          ${card.note ? NOTE_BTN_MARKUP : ''}
        </span>
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
  el.addEventListener('dblclick', onCardDblClick);
  el.addEventListener('contextmenu', onCardContext);

  const actions = el.querySelector('.card__actions');
  actions.addEventListener('pointerdown', e => e.stopPropagation());
  actions.addEventListener('dblclick', e => e.stopPropagation());
  actions.addEventListener('contextmenu', e => e.stopPropagation());
  el.querySelector('.card__delete-btn').addEventListener('click', e => {
    e.stopPropagation();
    if (deleteCardId === el.dataset.id) deleteCard(el.dataset.id);
  });
  el.querySelector('.card__edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    openEditModal(el.dataset.id);
  });
  const noteBtn = el.querySelector('.card__note-btn');
  if (noteBtn) {
    noteBtn.addEventListener('pointerdown', e => e.stopPropagation());   // must not start a drag
    noteBtn.addEventListener('dblclick', e => e.stopPropagation());
    noteBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleNoteTip(noteBtn, el.dataset.id);
    });
  }
}

// ─── NOTE TOOLTIP ────────────────────────────────────────────────────────────
let noteTip = null;   // { el, btn, id } while a card's note is open

// Note text as DOM nodes: http(s):// and www. addresses become links that open in a new tab
const NOTE_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
function linkifyNote(text) {
  const nodes = [];
  let last = 0;
  for (const m of text.matchAll(NOTE_URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]}]+$/, '');   // trailing punctuation belongs to the sentence
    if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = /^www\./i.test(url) ? `https://${url}` : url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = url;
    nodes.push(a);
    last = m.index + url.length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}
function toggleNoteTip(btn, id) {
  const open = noteTip && noteTip.id === id;
  closeNoteTip();
  if (open) return;
  const card = currentCards().find(c => c.id === id);
  if (!card?.note) return;
  const tip = document.createElement('div');
  tip.className = 'note-tip';
  tip.setAttribute('role', 'tooltip');
  tip.append(...linkifyNote(card.note));
  tip.addEventListener('click', e => { if (e.target.closest('a')) closeNoteTip(); });
  document.body.appendChild(tip);
  // Above the 🗒, right-aligned with it; below when there is no room above
  const r = btn.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - t.width, innerWidth - t.width - 8));
  const top  = r.top - t.height - 6 >= 8 ? r.top - t.height - 6 : r.bottom + 6;
  tip.style.left = `${left}px`;
  tip.style.top  = `${top}px`;
  btn.setAttribute('aria-expanded', 'true');
  noteTip = { el: tip, btn, id };
}
function closeNoteTip() {
  if (!noteTip) return;
  noteTip.el.remove();
  noteTip.btn.setAttribute('aria-expanded', 'false');
  noteTip = null;
}
document.addEventListener('pointerdown', e => {
  if (noteTip && !e.target.closest('.note-tip, .card__note-btn')) closeNoteTip();
});
addEventListener('resize', closeNoteTip);
document.addEventListener('scroll', closeNoteTip, true);

// Double-click (desktop), long-press (touch) or right-click: the card turns red and shows ✎ edit and ✕ delete
const LONG_PRESS_MS = 500;
let lastCardPointerType = 'mouse';
function armCard(id) {
  if (deleteCardId === id) return;
  if (deleteCardId) dismissDelete();
  activateDelete(id);
}
function onCardDblClick(e) {
  if (e.target.closest('.card__actions')) return;
  if (lastCardPointerType === 'touch') return;   // on touch only a long-press enters edit mode
  armCard(e.currentTarget.dataset.id);
}
function onCardContext(e) {
  e.preventDefault();
  closeColorMenu();
  armCard(e.currentTarget.dataset.id);
}

function onCardDown(e) {
  if (e.target.closest('.card__actions'))  return;
  if (e.button === 2) return;   // right-click arms the card, it must not start a drag
  const cardEl = e.currentTarget, id = cardEl.dataset.id;
  lastCardPointerType = e.pointerType;
  if (deleteCardId && deleteCardId !== id) { dismissDelete(); return; }
  if (deleteCardId === id) return;
  cardEl.setPointerCapture(e.pointerId);
  const sourceZone = cardEl.closest('[data-zone]')?.dataset.zone || 'todo';
  dragState = { cardId:id, startX:e.clientX, startY:e.clientY, dragging:false, cancelled:false, sourceEl:cardEl, currentZone:null, insertBefore:null, sourceZone };
  if (e.pointerType === 'touch') {
    // Vertical swipes scroll the list (touch-action: pan-y); holding still arms the card
    dragState.pressTimer = setTimeout(() => {
      if (!dragState || dragState.dragging || dragState.sourceEl !== cardEl) return;
      onCardUp();
      armCard(id);
    }, LONG_PRESS_MS);
  }
  cardEl.addEventListener('pointermove', onCardMove);
  cardEl.addEventListener('pointerup',   onCardUp);
  cardEl.addEventListener('pointercancel', onCardUp);
}

function onCardMove(e) {
  if (!dragState || dragState.cancelled) return;
  if (!dragState.dragging) {
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    const dist = Math.hypot(dx, dy);
    if (dist < DRAG_THRESHOLD) return;
    clearTimeout(dragState.pressTimer);

    // Start drag in any direction
    e.preventDefault();
    dragState.dragging = true;
    dragState.sourceEl.classList.add('dragging-source');
    document.body.classList.add('dragging-active');
    showGhost(dragState.cardId, e.clientX, e.clientY);
    ensureDropIndicator();
  }
  if (dragState.dragging) {
    e.preventDefault();
    dragState.lastX = e.clientX; dragState.lastY = e.clientY;
    moveGhost(e.clientX, e.clientY);
    updateDropTarget();
    startAutoScroll();
  }
}

// Zone, drop position and indicator for the last known pointer position
function updateDropTarget() {
  const { lastX: x, lastY: y } = dragState;
  const z = detectZone(x, y);
  const targetZone = z || dragState.sourceZone;
  highlightZone(targetZone);
  dragState.currentZone = targetZone;
  if (targetZone) {
    const { insertBefore, refEl } = detectInsertPosition(targetZone, x, y, dragState.cardId);
    dragState.insertBefore = insertBefore;
    showDropIndicator(targetZone, refEl);
  } else {
    hideDropIndicator();
    dragState.insertBefore = null;
  }
}

// Auto-scroll: holding a dragged card near the top/bottom edge of a list scrolls it
// (speed grows towards the edge) until the card is dropped or moved away.
const AUTOSCROLL_EDGE = 56, AUTOSCROLL_MAX = 14;   // px band, max px per frame
let autoScrollRaf = 0;
function scrollerOf(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}
function autoScrollStep() {
  autoScrollRaf = 0;
  if (!dragState || !dragState.dragging || !dragState.currentZone) return;
  const zoneRect = q(ZONE_EL[dragState.currentZone])?.getBoundingClientRect();
  const sc = scrollerOf(q(ZONE_CARD_CONTAINERS[dragState.currentZone]));
  if (!zoneRect || !sc) return;
  const y = dragState.lastY, r = sc.getBoundingClientRect();
  if (y < zoneRect.top || y > zoneRect.bottom) return;
  let dy = 0;
  if (y < r.top + AUTOSCROLL_EDGE)         dy = -AUTOSCROLL_MAX * Math.min(1, (r.top + AUTOSCROLL_EDGE - y) / AUTOSCROLL_EDGE);
  else if (y > r.bottom - AUTOSCROLL_EDGE) dy =  AUTOSCROLL_MAX * Math.min(1, (y - (r.bottom - AUTOSCROLL_EDGE)) / AUTOSCROLL_EDGE);
  if (!dy) return;
  const before = sc.scrollTop;
  sc.scrollTop += dy;
  if (sc.scrollTop === before) return;   // already at the end
  updateDropTarget();                     // cards moved under the pointer
  autoScrollRaf = requestAnimationFrame(autoScrollStep);
}
function startAutoScroll() {
  if (!autoScrollRaf) autoScrollRaf = requestAnimationFrame(autoScrollStep);
}

function onCardUp(e) {
  if (!dragState) return;
  clearTimeout(dragState.pressTimer);
  cancelAnimationFrame(autoScrollRaf); autoScrollRaf = 0;
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

// Drop indicator line — always lives in document.body with position:fixed
// so it NEVER shifts card layout (which would break mobile drag detection)
function ensureDropIndicator() {
  if (dropIndicator) return;
  dropIndicator = document.createElement('div');
  dropIndicator.className = 'drop-indicator';
  dropIndicator.style.cssText = 'position:fixed;display:none;height:3px;border-radius:2px;background:var(--accent,#ffa300);pointer-events:none;z-index:9999;transition:top .08s ease;box-shadow:0 0 6px var(--accent,#ffa300);';
  document.body.appendChild(dropIndicator);
}

function showDropIndicator(zone, refEl) {
  if (!dropIndicator) return;
  const containerEl = q(ZONE_CARD_CONTAINERS[zone]);
  if (!containerEl) { hideDropIndicator(); return; }

  const cr = containerEl.getBoundingClientRect();
  let indicatorY;

  if (refEl) {
    indicatorY = refEl.getBoundingClientRect().top - 2;
  } else {
    const lastCard = [...containerEl.querySelectorAll('.card:not(.dragging-source)')].pop();
    indicatorY = lastCard ? lastCard.getBoundingClientRect().bottom + 2 : cr.top + 4;
  }

  dropIndicator.style.left    = (cr.left + 6) + 'px';
  dropIndicator.style.width   = (cr.width - 12) + 'px';
  dropIndicator.style.top     = indicatorY + 'px';
  dropIndicator.style.display = 'block';
}

function hideDropIndicator() {
  if (dropIndicator) dropIndicator.style.display = 'none';
}

function activateDelete(id) { 
  deleteCardId=id; 
  document.querySelector(`.card[data-id="${id}"]`)?.classList.add('delete-mode'); 
}

function dismissDelete() { 
  if(!deleteCardId)return; 
  document.querySelector(`.card[data-id="${deleteCardId}"]`)?.classList.remove('delete-mode'); 
  deleteCardId=null; 
}

document.addEventListener('pointerdown', e => {
  if (deleteCardId) {
    const card = e.target.closest('.card');
    if (!card || card.dataset.id !== deleteCardId) dismissDelete();
  }
});

// ─── SHELF EXPAND ─────────────────────────────────────────────────────────────
q('#archive-toggle').addEventListener('click', ()=>{
  archiveExpanded = !archiveExpanded;
  q('#archive-bar').classList.toggle('expanded', archiveExpanded);
  const hint = q('#archive-bar .shelf__hint');
  if (hint) hint.textContent = archiveExpanded ? 'click to collapse' : 'click to expand';
  renderBoard();
});
q('#done-toggle').addEventListener('click', () => {
  doneExpanded = !doneExpanded;
  q('#done-bar').classList.toggle('expanded', doneExpanded);
  document.body.classList.toggle('done-expanded', doneExpanded);
  const hint = q('#done-bar .shelf__hint');
  if (hint) hint.textContent = doneExpanded ? 'click to collapse' : 'click to expand';
  renderBoard();
});

// Clear the Done shelf in one go (only the cards the owner filter shows)
function deleteAllDone() {
  const cb = currentBoard();
  const ids = new Set((cb?.cards || []).filter(c => c.status === 'done' && isCardVisible(c)).map(c => c.id));
  if (!ids.size) { showToast('No done cards to delete', 'info'); return; }
  if (!confirm(
    `Delete ${ids.size} done card(s) from “${cb.name}”?\n\n` +
    'Tip: export a report first to keep a record — this can’t be undone.'
  )) return;
  const els = [...document.querySelectorAll('#done-cards .card')];
  els.forEach((el, i) => {
    el.style.transition = `transform .25s ease ${i * 25}ms, opacity .25s ease ${i * 25}ms`;
    el.style.transform  = 'scale(0.7)';
    el.style.opacity    = '0';
  });
  launchConfetti();
  setTimeout(launchConfetti, 250);
  setTimeout(() => {
    cb.cards = cb.cards.filter(c => !ids.has(c.id));
    onDataChanged();
    renderOwnerFilterChips();
    renderBoard();
    showToast(`${ids.size} done card(s) cleared — nice week!`, 'success');
  }, 250 + Math.min(els.length, 20) * 25);
}

q('#done-report-btn').addEventListener('click', e => { e.stopPropagation(); exportReport(); });
q('#done-clear-btn').addEventListener('click', e => { e.stopPropagation(); deleteAllDone(); });

// ─── CARD MODAL ───────────────────────────────────────────────────────────────
q('#fab').addEventListener('click', () => openModal());
q('#modal-close').addEventListener('click', closeModal);
// Clicking outside the card modal doesn't close it — only ✕ (or Esc) and Save/Create do
q('#modal').querySelectorAll('.modal__toggle-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    q('#modal').querySelectorAll('.modal__toggle-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); selectedColumn=btn.dataset.col;
  });
});
q('#modal-submit').addEventListener('click', submitCard);
q('#note-toggle').addEventListener('click', () => {
  const show = q('#input-note').hidden;
  showNoteField(show);
  if (show) q('#input-note').focus();
});
q('#input-title').addEventListener('keydown', e=>{ if(e.key==='Enter') submitCard(); if(e.key==='Escape') closeModal(); });

let editingCardId = null;   // set while the card modal is editing an existing card

function setModalMode(editing) {
  q('#modal-title').textContent  = editing ? 'EDIT CARD' : 'NEW CARD';
  q('#modal-submit').textContent = editing ? 'SAVE CHANGES →' : 'CREATE CARD →';
  q('#modal-col-label').textContent = editing ? 'COLUMN' : 'STARTING COLUMN';
}
function syncColumnToggle() {
  q('#modal').querySelectorAll('.modal__toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.col === selectedColumn));
}

function openModal() {
  editingCardId = null;
  setModalMode(false);
  q('#modal-col-field').hidden = false;
  q('#modal-overlay').classList.remove('hidden');
  q('#input-title').value=''; q('#input-owner').value=''; q('#input-date').value='';
  setNoteField('');
  selectedColumn='todo';
  syncColumnToggle();
  refreshOwnerUI();
  setTimeout(()=>q('#input-title').focus(), 80);
}

// Same form as "new card", filled in with the card's current values
function openEditModal(id) {
  const card = currentCards().find(c => c.id === id);
  if (!card) return;
  dismissDelete();
  editingCardId = id;
  setModalMode(true);
  q('#modal-overlay').classList.remove('hidden');
  q('#input-title').value = card.title;
  q('#input-owner').value = card.owner || '';
  q('#input-date').value  = card.dueDate || '';
  setNoteField(card.note || '');
  // Only To Do / In Progress can be switched here; Archive and Done cards keep their place
  const movable = card.status === 'todo' || card.status === 'inprogress';
  q('#modal-col-field').hidden = !movable;
  selectedColumn = card.status;
  syncColumnToggle();
  refreshOwnerUI();
  setTimeout(() => { const t = q('#input-title'); t.focus(); t.select(); }, 80);
}

// The note textarea stays folded behind the 🗒 button until it is opened or the card has a note
function setNoteField(note) {
  q('#input-note').value = note;
  showNoteField(!!note);
}
function showNoteField(show) {
  q('#input-note').hidden = !show;
  q('#note-toggle').setAttribute('aria-expanded', String(show));
  q('#note-toggle-label').textContent = show ? 'NOTE' : 'ADD NOTE';
}

function closeModal() { q('#modal-overlay').classList.add('hidden'); editingCardId = null; }

function updateCard(id, { title, owner, dueDate, note, status }) {
  const card = currentCards().find(c => c.id === id);
  if (!card) return;
  card.title   = title.trim();
  card.owner   = owner.trim();
  card.dueDate = dueDate;
  if (note.trim()) card.note = note.trim(); else delete card.note;
  const movable = card.status === 'todo' || card.status === 'inprogress';
  if (movable && status !== card.status) {
    moveOrReorderCard(id, status, null);   // joins the end of the other column (also saves + re-renders)
  } else {
    onDataChanged();
    renderBoard();
  }
  renderOwnerFilterChips();
  showToast('Card updated', 'success');
}

function submitCard() {
  const title=q('#input-title').value.trim();
  if (!title) { shakeEl(q('#input-title')); return; }
  const note = q('#input-note').value;
  if (editingCardId) updateCard(editingCardId, { title, owner: q('#input-owner').value, dueDate: q('#input-date').value, note, status: selectedColumn });
  else createCard(title, q('#input-owner').value, q('#input-date').value, selectedColumn, note);
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
  q('#theme-icon').innerHTML = theme==='dark' ? ICON_SUN : ICON_MOON;   // same icons as Roadmaps: the icon offers the other theme
  localStorage.setItem(LS_THEME, theme);
  const mc=document.querySelector('meta[name="theme-color"]');
  // browser chrome follows the theme's own background, so light and dark stay consistent
  if(mc) mc.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--f-bg1').trim() || (theme==='dark' ? '#141414' : '#ffffff'));
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
    if (noteTip) { closeNoteTip(); return; }
    if (!q('#modal-overlay').classList.contains('hidden'))  { closeModal(); return; }
    if (!q('#help-overlay').classList.contains('hidden'))   { q('#help-overlay').classList.add('hidden'); return; }
    dismissDelete();
  }
  if ((e.ctrlKey||e.metaKey) && e.key==='Enter') openModal();
});

// ─── SERVICE WORKER ──────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  // Cache-bust the registration URL on every version bump — some hosts
  // (e.g. GitHub Pages) cache sw.js itself for a few minutes, which would
  // otherwise hide new deploys from reg.update() until that cache expires.
  navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`).then(reg => {
    // Force check for updates immediately so new assets are served
    reg.update().catch(() => {});
  }).catch(() => {});

  // A new worker takes over when a release is deployed. Reloading the moment that happens made the
  // page flash — and the very first visit reloaded itself too, because the first install also
  // "changes" the controller. So: nothing to do on a first install (nothing is stale yet); for an
  // update, apply it quietly the next time the tab is hidden. Unsaved edits are already persisted
  // locally and reconciled on the next start, so the reload is safe.
  const hadController = !!navigator.serviceWorker.controller;
  let updateReady = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) updateReady = true; });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && updateReady) window.location.reload();
  });
}

// ─── INIT ────────────────────────────────────────────────────────────────────
initTheme();
createSkeletonLoader();
selectedOwners = loadSelectedOwners(); // Load saved filter preferences
boards = loadFromLocal();
currentBoardId = localStorage.getItem(LS_CURRENT) || boards[0]?.id;
if (!boards.find(b=>b.id===currentBoardId)) currentBoardId = boards[0]?.id;

renderTabs();
renderOwnerFilterChips();
renderBoard();
initGSI();

// ─── PWA INSTALL BUTTON ──────────────────────────────────────────────────────
(function initInstallBtn() {
  const btn = document.getElementById('install-btn');
  if (!btn) return;

  // Already installed — don't show
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (isStandalone) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  let deferredPrompt = null;

  function showBtn() { btn.style.display = ''; }
  function hideBtn()  { btn.style.display = 'none'; }

  if (isIOS) {
    // iOS Safari: no native prompt — show button with instructions
    btn.title = 'Install app';
    showBtn();
    btn.addEventListener('click', () => {
      alert('To install on iOS:\n\n1. Tap the Share button (□↑) in Safari\n2. Tap "Add to Home Screen"\n3. Tap "Add"');
    });
  } else {
    // Chrome / Edge / Android: native install prompt
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredPrompt = e;
      showBtn();
    });

    btn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (outcome === 'accepted') hideBtn();
    });

    window.addEventListener('appinstalled', hideBtn);
  }
})();
