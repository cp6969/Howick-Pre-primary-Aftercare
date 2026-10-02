require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const SQLiteSessionStore = require('./session-store');

const apiRouter = require('./api');
const adminRouter = require('./admin');
const scheduler = require('./scheduler');
const reports = require('./reports');

const REQUIRED_ENV = ['SESSION_SECRET', 'APP_USERNAME', 'APP_PASSWORD_HASH', 'ADMIN_PIN_HASH'];
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

// A second, narrower gate on top of the site login -- the Admin area
// (billing rates, per-child attendance history) needs a PIN even from an
// already-logged-in staff member. Requires siteAuthed too, but only
// because these are always registered after app.use(requireSiteAuth)
// below, not because these functions check it themselves.
function requireAdminAuth(req, res, next) {
  if (req.session && req.session.adminAuthed) return next();
  res.redirect('/admin-login.html');
}
function requireAdminAuthApi(req, res, next) {
  if (req.session && req.session.adminAuthed) return next();
  res.status(403).json({ error: 'Admin PIN required' });
}

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Nothing sensitive in any of these -- font data and CSS/JS color tokens,
// not attendance/child data -- and the login page needs them to actually
// render styled before a session exists. Serving the whole public/ dir here
// instead would also expose index.html/settings.html unauthenticated, so
// this stays an explicit, narrow allowlist rather than moving the general
// express.static mount above the auth gate.
const PUBLIC_ASSETS = ['fonts.css', 'theme.css', 'group-colors.js', 'logo.png'];
for (const file of PUBLIC_ASSETS) {
  app.get('/' + file, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', file));
  });
}

// Parent View -- a no-login page a parent opens via a long random link
// unique to their own child (the token itself is the auth, so this is
// deliberately outside every other gate in this file, not just placed before
// them). /parent/:token always serves the page; the page's own JS fetches
// /parent/:token/data and shows a friendly "link not found" state for a bad
// or since-regenerated token rather than a raw 404 page.
app.get('/parent/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'parent.html'));
});
app.get('/parent/:token/data', (req, res) => {
  const summary = reports.parentSummaryForChild(req.params.token, { scope: req.query.scope === 'month' ? 'month' : undefined });
  if (!summary) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-store');
  res.json(summary);
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

app.post('/admin/login', async (req, res) => {
  if (!(req.session && req.session.siteAuthed)) return res.status(401).json({ error: 'Not authenticated' });
  const { pin } = req.body || {};
  const pinOk = pin && await bcrypt.compare(String(pin), process.env.ADMIN_PIN_HASH);
  if (!pinOk) return res.status(401).json({ error: 'Incorrect PIN' });
  req.session.adminAuthed = true;
  res.status(204).end();
});

// "Lock admin" -- clears just the admin flag, not the whole site session
// (a logged-in staff member stays logged in, they just need the PIN again
// to get back into the Admin area).
app.post('/admin/logout', (req, res) => {
  if (req.session) req.session.adminAuthed = false;
  res.status(204).end();
});

// Every /api/* response depends on the caller's session, so it must never be
// cached or conditionally revalidated by the browser.
app.use('/api', requireSiteAuthApi);
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', apiRouter);
app.use('/api/admin', requireAdminAuthApi);
app.use('/api/admin', adminRouter);

app.use(requireSiteAuth);

app.get('/admin-login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});
app.get('/admin.html', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/statement.html', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'statement.html'));
});

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
