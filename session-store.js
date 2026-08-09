const session = require('express-session');
const Database = require('better-sqlite3');

const DAY_MS = 24 * 60 * 60 * 1000;

// A minimal express-session store backed by better-sqlite3, so sessions
// persist across restarts without pulling in a second, separate SQLite
// driver alongside better-sqlite3.
class SQLiteSessionStore extends session.Store {
  constructor(dbPath) {
    super();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        expires INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);
    this._cleanup();
    setInterval(() => this._cleanup(), DAY_MS).unref();
  }

  _cleanup() {
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sessionData, cb) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge;
      const expires = Date.now() + (typeof maxAge === 'number' ? maxAge : DAY_MS);
      this.db.prepare(`
        INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data
      `).run(sid, expires, JSON.stringify(sessionData));
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  touch(sid, sessionData, cb) {
    this.set(sid, sessionData, cb);
  }
}

module.exports = SQLiteSessionStore;
