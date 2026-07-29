const express = require('express');
const path = require('path');
const { init } = require('./src/db');

init();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api', require('./src/api'));
app.use('/api', require('./src/exports'));
app.use('/api', require('./src/email'));
app.use('/api', require('./src/ai'));
app.use('/api/import', require('./src/imports'));

// no-cache so the browser always loads the latest UI (dev/local app)
app.use((req, res, next) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); next(); });
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n  United Tower running →  http://localhost:${PORT}\n  Login: admin / admin123\n`);
});
