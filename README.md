# ◈ Taskboards

**A fast, offline-first Kanban PWA** — multiple boards, Google Drive sync, installable on desktop and mobile.

🔗 **Live app → [taskboards.up.railway.app](https://taskboards.up.railway.app)**

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
| **Google Drive sync** | Sign in with Google to save all boards to your personal Drive (private app folder). Works across devices. |
| **Offline-first PWA** | Service worker caches all assets. Works without internet after the first load. |
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

## Deploy on Railway

1. Fork or push this repo to GitHub
2. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
3. No environment variables needed — the Client ID lives in `public/config.js`
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
│   ├── index.html      # App shell + all modals
│   ├── app.js          # All logic: boards, cards, drag, sync, PWA install
│   ├── style.css       # Primer-based design system, light + dark themes
│   ├── sw.js           # Service worker — cache versioning, offline support
│   ├── manifest.json   # PWA manifest — icons, display mode, theme colour
│   └── config.js       # Google Client ID (not secret, safe to commit)
└── server.js           # Minimal Express static server for Railway
```

---

## Author

Vibe coded by **[David Marques](https://www.linkedin.com/in/dferreiramarques/)** · Product Manager & occasional vibe coder from Lisbon 🇵🇹

If this saves you time or sparks something, consider buying me a coffee:

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/dferreiramarques)

---

## License

MIT — do whatever you like with it.
