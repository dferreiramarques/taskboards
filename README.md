# ◈ Taskboards

**A fast Kanban board, built for speed, not busywork.** Sign in with Google and your boards live only in your own Drive — Taskboards has no database of its own.

[![Ko-fi](https://img.shields.io/badge/support-ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/dferreiramarques)
[![LinkedIn](https://img.shields.io/badge/David%20Marques-LinkedIn-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/dferreiramarques/)

---

## Features

| | |
|---|---|
| **Multiple boards** | Create as many boards as you need. Tabs auto-paginate when they overflow. Double-click a tab to rename it. |
| **4-zone Kanban** | Archive → To Do → In Progress → Done. Drag cards between columns or reorder within a column. |
| **Inline editing** | Double-click (or double-tap on mobile) any card to edit its title in place. |
| **Owner & due date** | Each card tracks an assignee and optional due date. Overdue = red, due ≤ 3 days = orange. |
| **Owner filter** | Quick-filter chips above the board — tap an owner to see only their cards. |
| **Google sign-in required** | A full-screen gate blocks the board until you sign in with Google. There is no local/offline account-free mode. |
| **Google Drive sync** | Every board saves to your personal Drive (private app folder) — nothing is stored on any Taskboards server. Works across devices. |
| **Share one board** | Click the 🔒 before a board’s name to publish a read-only link. Only that board is shared, protected by a passphrase; 🚀 means it is public, and one click revokes it. |
| **Backup** | Export / import all boards as a `.json` file from the user menu. |
| **Stays signed in** | With the optional session server, a Google refresh token (encrypted, in an httpOnly cookie) renews your sign-in quietly — no hourly re-login. |
| **Installable** | Install banner appears automatically on Chrome/Edge (desktop + Android) and with step-by-step instructions on iOS Safari. |
| **Dark / light theme** | Toggle between themes. Preference saved locally. |
| **Confetti** | Cards moved to Done get a small celebration. 🎉 |

---

## Example workflow

Here's how a small team might use Taskboards for a sprint:

```
1. Create a board called "Sprint 4"

2. Add cards to TO DO:
   - "Design login screen"  → owner: Ana    → due: 10 Apr
   - "Write API tests"      → owner: Bruno  → due: 12 Apr
   - "Fix checkout bug"     → owner: Carla  → due: 9 Apr  ← turns red when overdue

3. Ana starts working → drag "Design login screen" to IN PROGRESS

4. Carla finishes → drag "Fix checkout bug" to DONE  🎉

5. Sprint ends → drag leftover cards to ARCHIVE to park them
   Open next sprint's board — archive is always one click away to reactivate ideas

6. Use owner filter chips to see only Bruno's cards across any board
```

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl` + `Enter` | Open new card modal |
| `Escape` | Close modal / cancel edit |
| Double-click card | Inline edit title |
| Double-tap card (mobile) | Inline edit title |
| Drag card | Move between columns or reorder within column |

---

## Tech stack

- **Vanilla JS + HTML + CSS** — no framework, no build step
- **Service Worker** — offline caching, background sync
- **Google Identity Services (GSI)** — one-tap sign-in
- **Google Drive API** — per-user private app folder storage
- **Railway** — deployment platform
- **Primer design system** — GitHub's open-source token system for colours and typography

---

## One-time setup: Google OAuth

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create a project
2. **APIs & Services → Library** → enable **Google Drive API**
3. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Type: **Web application**
   - Authorized JavaScript origins:
     ```
     https://your-app.railway.app
     http://localhost:3000
     ```
4. Copy the **Client ID**
5. Open `public/config.js` and paste it:
   ```js
   GOOGLE_CLIENT_ID: '123456789.apps.googleusercontent.com'
   ```
6. Commit and push → Railway redeploys → done ✓

> The Client ID is **not a secret** — it identifies the app, not any user. Each user authenticates with their own Google account and data stays in their own Drive.

---

## Sharing a board (read-only)

Each board has a lock in its tab: **🔒 private** (default) or **🚀 public**. Click it to open the share dialog.

- **Share link** publishes just that board as one *encrypted* file in the owner’s Google Drive (visible to anyone with the link, but unreadable without the passphrase). A passphrase like `7KQM-X2PD-9WFH-ZT4C` is generated and shown in the dialog together with the link; **Copy share details** copies both.
- Viewers open `view.html?b=…`, type the passphrase and see the latest version, read-only, refreshed every ~30 s. They don’t need a Google account. Decryption happens in their browser; the passphrase never leaves it.
- Only the owner edits. Every change is re-published automatically within seconds.
- **Revoke public access** deletes the shared copy, so the link stops working immediately and the board is private again. Deleting a shared board (or replacing everything via *Import*) revokes it too.

**Set it up (one time)**

1. **Google Cloud Console → Credentials → Create credentials → API key.** Restrict it: *Application restrictions* → HTTP referrers `https://taskboards.monco.io/*`; *API restrictions* → **Google Drive API**. Paste it in `config.js`: `DRIVE_API_KEY: AIza…` (it is public by design). Until it is set, the app says sharing isn’t enabled and nothing is published.
2. **Google Auth Platform → Data access → Add or remove scopes:** add `.../auth/drive.file` (non-sensitive — no Google review). The app creates files only for boards the user chooses to share.
3. Redeploy the session server (it now also requests `drive.file`). Existing users are asked for the extra permission the first time they share.

> The passphrase is stored in the owner’s own private Drive copy so it can be shown again. Anyone who has both the link and the passphrase can read the board — revoke to cut them off.

---

## Stay signed in: the session server (optional)

Google’s browser-only sign-in only gives 1-hour tokens, so without this the app re-asks Google about once an hour (and some browsers block that pop-up). `auth.js` fixes it with Google’s *authorization code* flow: it keeps a **refresh token** in an encrypted, `httpOnly` cookie in the user’s own browser and swaps it for a fresh access token whenever the app needs one.

- It **stores nothing** — no database, no token list. Board data still goes browser → the user’s Drive.
- If it’s not configured (`AUTH_API` empty in `config.js`), the app falls back to the browser-only sign-in.

**Set it up (one time)**

1. **Use the Railway service that already deploys this repo** (see below) — it serves `/auth/*` by itself, no second service needed. Give it a custom domain **on the same site as the app** — e.g. `auth.monco.io` for `taskboards.monco.io`: Railway → **Settings → Networking → Custom Domain**, then add the CNAME it shows at your DNS. (Its default `*.up.railway.app` address is a different site, so cookies set there would be third-party and get blocked.) Same site is what keeps the cookie first-party, so browsers don’t block it.
2. **Google Cloud Console → Credentials → your OAuth client**: add the authorized redirect URI `https://auth.monco.io/auth/callback`, and copy the **Client secret**.
3. **Set these environment variables** in Railway → **Variables** (see `.env.example`):

   | Variable | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | the same Client ID as in `config.js` |
   | `GOOGLE_CLIENT_SECRET` | the client secret from step 2 (**keep it secret**) |
   | `COOKIE_SECRET` | a long random string, e.g. `openssl rand -hex 32` (encrypts the cookie) |
   | `AUTH_BASE_URL` | `https://auth.monco.io` |
   | `APP_ORIGIN` | `https://taskboards.monco.io` (comma-separate more origins) |

4. In `config.js` set the URL, only for the real domain so other hosts (like the `*.up.railway.app` copy) keep using the browser-only sign-in:
   ```js
   AUTH_API: location.hostname.endsWith('monco.io') ? 'https://auth.monco.io' : '',
   ```
   then push.
5. In the OAuth consent screen, publishing status must be **In production** (in *Testing*, Google expires refresh tokens after 7 days).

> Prefer one host for everything? Point `taskboards.monco.io` itself at the Railway service (instead of GitHub Pages) and set `AUTH_BASE_URL` and `APP_ORIGIN` to that same URL — then no second domain is needed.

> Railway keeps the service running (unless you turn on *App Sleeping*), so there is no cold start. On a host that sleeps when idle, the first sign-in after a quiet spell can take ~30 s.

---

## Deploy on Railway

1. Fork or push this repo to GitHub
2. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
3. Variables: none needed for the app itself — the Client ID lives in `public/config.js`. Without the variables listed above, `/auth/status` answers `{"enabled":false}` and the app uses the browser-only sign-in
4. Railway auto-deploys on every push to `main`

---

## Local development

```bash
npm install
npm start
# open http://localhost:3000
```

> Google SSO requires the page to be served over HTTP/HTTPS (not `file://`). `npm start` on localhost works fine.

---

## Project structure

```
taskboards/
├── public/
│   ├── index.html     # Product / landing page — sign in or continue without an account
│   ├── app.html        # App shell + all modals (the actual board)
│   ├── app.js          # All logic: boards, cards, drag, sync, PWA install
│   ├── style.css       # Primer-based design system, light + dark themes
│   ├── sw.js           # Service worker — cache versioning, offline support
│   ├── manifest.json   # PWA manifest — icons, display mode, theme colour
│   ├── share-core.js   # Passphrase + AES-GCM encryption for shared boards
│   ├── view.html/.js/.css  # Read-only viewer for a shared board
│   └── config.js       # Google Client ID (not secret, safe to commit)
├── auth.js             # Optional session server: refresh-token cookie, /auth/*
├── .env.example        # Session-server settings
└── server.js           # Express: static files + /auth
```

---

## Author

Vibe coded by **[David Marques](https://www.linkedin.com/in/dferreiramarques/)** · Product Manager & occasional vibe coder from Lisbon 🇵🇹

If this saves you time or sparks something, consider buying me a coffee:

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/dferreiramarques)

---

## License

MIT — do whatever you like with it.
