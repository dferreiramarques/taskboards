const express = require('express');
const path    = require('path');
const auth    = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);   // behind Render's proxy: real client IP + https

app.use('/auth', auth.router);

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
