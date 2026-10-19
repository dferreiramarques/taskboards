const express = require('express');
const path    = require('path');
const auth    = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);   // behind Render's proxy: real client IP + https

app.use('/auth', auth.router);

// The roadmap is public data that other sites read (see roadmap-embed.js): allow it cross-origin, never stale
app.use('/roadmap.json', (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Taskboards on port ${PORT} (session server ${auth.enabled ? 'on' : 'off'})`));
