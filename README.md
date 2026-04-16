# Taskboards PWA

Multi-board task manager with Google SSO and Drive sync.

## How the Google login works

- The **Client ID** identifies this *app* to Google — it is **not a secret** and not per-user.
- Each user signs in with their **own Google account**.
- Each user's boards are saved to **their own Google Drive** (in a private app folder invisible to others).
- You set the Client ID once, commit it, and everyone can use it.

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

## Deploy on Railway

1. Push repo to GitHub
2. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. No environment variables needed — Client ID is in `config.js`

## Local development

```bash
npm install
npm start
# open http://localhost:3000
```

> Google SSO requires the page to be served (not `file://`).
> With `npm start` on localhost it works fine.
