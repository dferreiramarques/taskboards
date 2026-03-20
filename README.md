# TaskBoard PWA

Task management board with Archive, ToDo, InProgress, and Done zones.

## Features

- **Archive bar** (top) — drag cards to archive; click to expand/collapse
- **ToDo & InProgress columns** (center) — card view with title, owner, due date
- **Done bar** (bottom) — drag completed cards here; click to expand/collapse
- **Drag & drop** between all zones (mouse and touch)
- **Long press 2s** on a card to activate delete mode (red ✕ button appears)
- **Floating + button** to create new cards
- **Color-coded dates** — red = overdue, orange = due in ≤3 days
- **PWA** — installable on mobile and desktop, works offline
- **localStorage** — data persists across sessions

## Keyboard Shortcuts

| Key         | Action          |
|-------------|-----------------|
| `Ctrl+Enter` | New card       |
| `Escape`    | Close modal / cancel delete |

## Deploy to Render.com

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repo
4. Render will auto-detect `render.yaml` and configure everything
5. Click **Deploy**

Or manually:
- **Build command:** `npm install`
- **Start command:** `npm start`
- **Node version:** 18+

## Local Development

```bash
npm install
npm start
# open http://localhost:3000
```
