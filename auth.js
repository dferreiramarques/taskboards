'use strict';
// Long-lived Google sessions for Taskboards.
//
// The browser-only Google flow only yields 1-hour access tokens. This router adds
// the "authorization code" flow: it keeps a Google *refresh token* so the app can
// quietly get a new access token whenever it needs one.
//
// It stores NOTHING: the refresh token lives in an encrypted, httpOnly cookie in
// the user's own browser. Board data never touches this server — it still goes
// straight from the browser to the user's Google Drive.
//
//   GET  /auth/status    → { enabled }
//   GET  /auth/login     → redirect to Google (access_type=offline)
//   GET  /auth/callback  → exchange the code, set the cookie, back to the app
//   POST /auth/refresh   → new access token from the cookie
//   POST /auth/logout    → revoke the refresh token and clear the cookie

const crypto  = require('crypto');
const express = require('express');

const env = process.env;
const CLIENT_ID     = env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET || '';
const COOKIE_SECRET = env.COOKIE_SECRET || '';
const BASE_URL      = (env.AUTH_BASE_URL || '').replace(/\/$/, '');   // public URL of THIS server
const APP_ORIGINS   = (env.APP_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

const GOOGLE_AUTH_URL   = env.GOOGLE_AUTH_URL   || 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL  = env.GOOGLE_TOKEN_URL  || 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
const DRIVE_APPDATA     = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE        = 'https://www.googleapis.com/auth/drive.file';   // create the shared copy of a board
const SCOPE             = `openid email profile ${DRIVE_APPDATA} ${DRIVE_FILE}`;

const enabled = !!(CLIENT_ID && CLIENT_SECRET && COOKIE_SECRET && BASE_URL && APP_ORIGINS.length);
const SECURE  = BASE_URL.startsWith('https://');

const COOKIE_RT    = 'tb_rt';      // encrypted refresh token
const COOKIE_STATE = 'tb_state';   // CSRF state for the login round-trip
const RT_MAX_AGE   = 400 * 24 * 3600;   // browsers cap cookies at ~400 days

// ─── cookie crypto (AES-256-GCM, key derived from COOKIE_SECRET) ─────────────
const KEY = enabled
  ? Buffer.from(crypto.hkdfSync('sha256', COOKIE_SECRET, 'taskboards', 'cookie-encryption', 32))
  : null;

function seal(text) {
  const iv = crypto.randomBytes(12);
  const c  = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

function unseal(token) {
  try {
    const buf = Buffer.from(token, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function setCookie(res, name, value, maxAge) {
  res.append('Set-Cookie',
    `${name}=${value}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`);
}
const clearCookie = (res, name) => setCookie(res, name, '', 0);

// ─── helpers ─────────────────────────────────────────────────────────────────
async function googleToken(params) {
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params })
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

function profileFromIdToken(idToken) {
  try {
    const p = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return { sub: p.sub, email: p.email, name: p.name, given_name: p.given_name, picture: p.picture };
  } catch { return null; }
}

const pickApp = o => (APP_ORIGINS.includes(o) ? o : APP_ORIGINS[0]);
const backToApp = (res, app, error) =>
  res.redirect(`${app}/app.html${error ? `?auth_error=${encodeURIComponent(error)}` : ''}`);

// Tiny per-IP limiter so the refresh endpoint can't be hammered
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now(), k = req.ip;
    const h = hits.get(k);
    if (!h || now - h.t > windowMs) hits.set(k, { n: 1, t: now });
    else if (++h.n > max) return res.status(429).json({ error: 'rate_limited' });
    if (hits.size > 5000) for (const [key, v] of hits) if (now - v.t > windowMs) hits.delete(key);
    next();
  };
}

// ─── router ──────────────────────────────────────────────────────────────────
const router = express.Router();

// CORS: only the app's own origin(s), with cookies
router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && APP_ORIGINS.includes(origin)) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Vary': 'Origin'
    });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// State-changing calls must come from the app itself (belt and braces on top of SameSite)
function requireAppOrigin(req, res, next) {
  if (!APP_ORIGINS.includes(req.headers.origin)) return res.status(403).json({ error: 'bad_origin' });
  next();
}
function requireEnabled(req, res, next) {
  if (!enabled) return res.status(503).json({ error: 'not_configured' });
  next();
}

router.get('/status', (req, res) => res.json({ enabled }));

router.get('/login', requireEnabled, (req, res) => {
  const app   = pickApp(req.query.app);
  const nonce = crypto.randomBytes(16).toString('hex');
  setCookie(res, COOKIE_STATE, seal(JSON.stringify({ nonce, app })), 600);

  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/callback`,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',            // ask for a refresh token…
    include_granted_scopes: 'true',
    prompt: req.query.switch ? 'select_account consent' : 'consent',   // …and make sure Google issues one
    state: nonce
  });
  if (req.query.hint && !req.query.switch) q.set('login_hint', String(req.query.hint).slice(0, 254));
  res.redirect(`${GOOGLE_AUTH_URL}?${q}`);
});

router.get('/callback', requireEnabled, async (req, res) => {
  const st  = unseal(readCookies(req)[COOKIE_STATE] || '');
  const ctx = st ? JSON.parse(st) : null;
  const app = pickApp(ctx?.app);
  clearCookie(res, COOKIE_STATE);

  if (!ctx || ctx.nonce !== req.query.state) return backToApp(res, app, 'state');
  if (req.query.error) return backToApp(res, app, String(req.query.error).slice(0, 40));
  if (!req.query.code) return backToApp(res, app, 'exchange');

  let tok;
  try {
    tok = await googleToken({
      grant_type: 'authorization_code',
      code: String(req.query.code),
      redirect_uri: `${BASE_URL}/auth/callback`
    });
  } catch { return backToApp(res, app, 'exchange'); }

  if (!tok.ok) return backToApp(res, app, 'exchange');
  if (!String(tok.body.scope || '').includes(DRIVE_APPDATA)) return backToApp(res, app, 'scope');
  if (!tok.body.refresh_token) return backToApp(res, app, 'no_refresh');

  setCookie(res, COOKIE_RT, seal(tok.body.refresh_token), RT_MAX_AGE);
  backToApp(res, app);
});

router.post('/refresh', requireEnabled, requireAppOrigin, limit(120, 60000), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rt = unseal(readCookies(req)[COOKIE_RT] || '');
  if (!rt) return res.status(401).json({ error: 'no_session' });

  let tok;
  try { tok = await googleToken({ grant_type: 'refresh_token', refresh_token: rt }); }
  catch { return res.status(502).json({ error: 'upstream' }); }

  if (!tok.ok) {
    if (tok.body.error === 'invalid_grant') {       // revoked, expired or password changed
      clearCookie(res, COOKIE_RT);
      return res.status(401).json({ error: 'reauth' });
    }
    return res.status(502).json({ error: 'upstream' });   // transient — keep the cookie
  }

  setCookie(res, COOKIE_RT, seal(tok.body.refresh_token || rt), RT_MAX_AGE);   // slide the expiry
  res.json({
    access_token: tok.body.access_token,
    expires_in: tok.body.expires_in,
    scope: tok.body.scope,
    user: tok.body.id_token ? profileFromIdToken(tok.body.id_token) : null
  });
});

router.post('/logout', requireEnabled, requireAppOrigin, async (req, res) => {
  const rt = unseal(readCookies(req)[COOKIE_RT] || '');
  clearCookie(res, COOKIE_RT);
  if (rt) {
    try {
      await fetch(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: rt })
      });
    } catch { /* cookie is gone either way */ }
  }
  res.sendStatus(204);
});

module.exports = { router, enabled };
