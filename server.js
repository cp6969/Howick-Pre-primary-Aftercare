require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const SQLiteSessionStore = require('./session-store');

const apiRouter = require('./api');
const scheduler = require('./scheduler');

const REQUIRED_ENV = ['SESSION_SECRET', 'APP_USERNAME', 'APP_PASSWORD_HASH'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();

app.set('trust proxy', 1);
app.set('etag', false);

app.use(express.json());
app.use(session({
  store: new SQLiteSessionStore(path.join(__dirname, 'data', 'sessions.db')),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    // 'auto' checks req.secure per-request (via the trusted X-Forwarded-Proto
    // header) instead of a static flag -- needed behind a reverse proxy /
    // Cloudflare Tunnel where the browser<->proxy hop is HTTPS but the
    // proxy<->container hop is plain HTTP. A static `secure: true` here
    // would silently drop the Set-Cookie header and sessions would never
    // persist.
    secure: 'auto',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
}));

// One shared login for all aftercare staff -- gates the whole app shell.
function requireSiteAuth(req, res, next) {
  if (req.session && req.session.siteAuthed) return next();
  res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
}
function requireSiteAuthApi(req, res, next) {
  if (req.session && req.session.siteAuthed) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const usernameOk = username === process.env.APP_USERNAME;
  const passwordOk = usernameOk && password && await bcrypt.compare(password, process.env.APP_PASSWORD_HASH);
  if (!passwordOk) return res.status(401).json({ error: 'Invalid username or password' });
  req.session.siteAuthed = true;
  res.status(204).end();
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

// Every /api/* response depends on the caller's session, so it must never be
// cached or conditionally revalidated by the browser.
app.use('/api', requireSiteAuthApi);
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', apiRouter);

app.use(requireSiteAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Howick aftercare tracker listening on port ${port}`);
});

// No-op every tick unless the daily-log email is turned on in Settings --
// safe to always run.
scheduler.startScheduler();
