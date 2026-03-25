// ─────────────────────────────────────────────────────────────────────────────
// TASKBOARDS CONFIG — Edit this file before deploying
// ─────────────────────────────────────────────────────────────────────────────
//
// To enable Google SSO + Drive sync:
//
//  1. Go to https://console.cloud.google.com
//  2. Create a project (or use an existing one)
//  3. Enable "Google Drive API" in APIs & Services → Library
//  4. Go to APIs & Services → Credentials → Create Credentials → OAuth client ID
//  5. Application type: Web application
//  6. Authorized JavaScript origins:
//       http://localhost:3000          (for local dev)
//       https://YOUR-APP.onrender.com  (for production)
//  7. Authorized redirect URIs: same as above
//  8. Copy the Client ID below
//
// Leave as empty string '' to run in offline/localStorage-only mode.
//
window.TASKBOARDS_CONFIG = {
  GOOGLE_CLIENT_ID: ''
};
