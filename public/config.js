// ─── TASKBOARDS — Google OAuth App Registration ───────────────────────────────
//
// This Client ID identifies THIS APP to Google — it is NOT a secret and
// is safe to be public/committed to git.
//
// Every user signs in with their OWN Google account.
// Each user's boards are saved to THEIR OWN Google Drive (private appDataFolder).
//
// SETUP (one-time, done by the app developer):
//  1. console.cloud.google.com → New Project
//  2. APIs & Services → Library → enable "Google Drive API"
//  3. APIs & Services → Credentials → Create OAuth 2.0 Client ID
//     Type: Web application
//     Authorized JavaScript origins:
//       https://your-app.railway.app
//       http://localhost:3000
//  4. Paste the Client ID below and deploy. Done.
//
window.TASKBOARDS_CONFIG = {
  GOOGLE_CLIENT_ID: '56980482877-s9ueo6802dlvbf88qqkic21rddgmj0ic.apps.googleusercontent.com'   // ← paste your Client ID here, e.g. '123456.apps.googleusercontent.com'
};
