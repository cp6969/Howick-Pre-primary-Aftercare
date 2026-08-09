const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS children (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    group_name TEXT,
    parent_name TEXT,
    parent_phone TEXT,
    pickup_notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- One row per child per day they actually attend aftercare. Absence is
  -- just the lack of a row (see the requirement this app is built on: not
  -- every child comes every day) -- there is no separate "expected" state
  -- to reconcile against. checked_in_at is always stamped to 13:00 SAST on
  -- the row's date when it's created (every aftercare day starts then);
  -- only collected_at/collected_by vary per child.
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    checked_in_at INTEGER NOT NULL,
    collected_at INTEGER,
    collected_by TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(child_id, date)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
  CREATE INDEX IF NOT EXISTS idx_attendance_child ON attendance(child_id);
  CREATE INDEX IF NOT EXISTS idx_children_active ON children(active);
`);

const defaultSettings = {
  cutoff_time: '17:30',
  hourly_rate: '45',
  late_fee_per_block: '25',
  currency: 'R'
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaultSettings)) insertSetting.run(key, value);

// --- SAST (Africa/Johannesburg, UTC+2 year-round, no DST) date helpers ---
// Deliberately not relying on the server's local timezone (a Docker
// container's default is UTC), so "today" and "13:00" always mean the same
// wall-clock moment in Howick regardless of where this is hosted.
const SAST_OFFSET = '+02:00';

function todaySAST() {
  const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function nowMs() {
  return Date.now();
}

function sastDateTimeMs(dateStr, hh, mm) {
  const h = String(hh).padStart(2, '0');
  const m = String(mm).padStart(2, '0');
  return new Date(`${dateStr}T${h}:${m}:00${SAST_OFFSET}`).getTime();
}

function sastArrivalMs(dateStr) {
  return sastDateTimeMs(dateStr, 13, 0);
}

module.exports = db;
module.exports.todaySAST = todaySAST;
module.exports.nowMs = nowMs;
module.exports.sastDateTimeMs = sastDateTimeMs;
module.exports.sastArrivalMs = sastArrivalMs;
