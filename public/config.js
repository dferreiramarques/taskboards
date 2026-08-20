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
  GOOGLE_CLIENT_ID: '56980482877-s9ueo6802dlvbf88qqkic21rddgmj0ic.apps.googleusercontent.com',   // ← paste your Client ID here, e.g. '123456.apps.googleusercontent.com'

  // ─── Anonymous unique-sign-in counter (optional) ──────────────────────────
  // Not a secret — this key can only insert/update a one-way hash of the
  // signed-in user's Google id (see users_seen table RLS policies). It can
  // never read, list or delete data. Leave blank to disable the counter.
  SUPABASE_URL: 'https://rhmxshbfyamctrblfvse.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJobXhzaGJmeWFtY3RyYmxmdnNlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyNjI5OTUsImV4cCI6MjEwMjgzODk5NX0.SRk046hN2jF3F7uImkwQqaFC7lMP-4ubSatSuHjmtKQ'
};
