const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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

// Migration: parent_token was added after the children table already existed
// in production, so it can't just be part of the CREATE TABLE above -- SQLite
// needs an explicit ALTER TABLE for a column added to a live table. This is
// the long random link a parent uses to open their own child's Parent View,
// with no login. Run before the demo seed below (so freshly-seeded rows get
// the column too); the actual token values are backfilled further down,
// after that seed has had a chance to insert its own tokenless rows.
const hasParentToken = db.prepare("PRAGMA table_info(children)").all().some((c) => c.name === 'parent_token');
if (!hasParentToken) {
  db.exec('ALTER TABLE children ADD COLUMN parent_token TEXT');
}
function newParentToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Later columns, added to live tables the same way as parent_token above.
//  - children.family_id: siblings share one value (the lowest child id in
//    the family); NULL means no linked siblings.
//  - attendance.off_list: 1 when staff released a child to someone who isn't
//    on that child's pickup list, after the warning. Kept as an audit trail.
//  - attendance.nudged_at: when staff last opened the "late pickup" WhatsApp
//    message for this row, so a second teacher can see it's been done.
function addColumnIfMissing(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumnIfMissing('children', 'family_id', 'INTEGER');
addColumnIfMissing('attendance', 'off_list', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('attendance', 'nudged_at', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_children_family ON children(family_id)');

const defaultSettings = {
  cutoff_time: '17:30',
  hourly_rate: '45',
  // Matches the billing workbook's "Daily minimum billed hours" (Rates &
  // Settings!B6) -- even a short stay bills at least this many hours.
  daily_minimum_hours: '1',
  late_fee_per_block: '25',
  currency: 'R',
  // Automatic "today's log" email -- see mailer.js/scheduler.js. Recipients
  // is a plain comma-separated string (no separate table needed for what's
  // realistically a short, rarely-changing list). daily_log_last_sent_date
  // is bookkeeping, not really a "setting" a person edits, but it lives here
  // for the same reason session state lives in SQLite elsewhere in this app
  // -- it has to survive a container restart so a restart right around 6pm
  // can't cause a duplicate send.
  daily_log_enabled: 'false',
  daily_log_recipients: '',
  daily_log_send_time: '18:00',
  daily_log_last_sent_date: ''
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaultSettings)) insertSetting.run(key, value);

// The school's actual aftercare groups -- fixed list, not admin-editable via
// the UI (a typo'd group name would silently split a group in two on the
// roster). Shared between the settings-page dropdown and server-side
// validation on the children endpoints.
const GROUPS = [
  'Baby Monkeys',
  'Busy Bees',
  'Turtles',
  'Butterflies',
  'Dragon Flies',
  'Owls',
  'Ladybirds'
];

// Demo roster, seeded once on a genuinely empty database (first install) so
// the site has something to click through. Only fires when the children
// table has zero rows at all -- including archived ones -- so it can never
// re-add itself after a real roster has been entered and later trimmed.
const DEMO_CHILDREN = [
  { full_name: 'Amara Mokoena', group_name: 'Baby Monkeys', parent_name: 'Thandiwe Mokoena', parent_phone: '082 123 4567', pickup_notes: 'Grandmother (Nomsa), Aftercare van' },
  { full_name: 'Ethan van Wyk', group_name: 'Baby Monkeys', parent_name: 'Lente van Wyk', parent_phone: '083 234 5678', pickup_notes: 'Father only' },
  { full_name: 'Zara Naidoo', group_name: 'Baby Monkeys', parent_name: 'Priya Naidoo', parent_phone: '084 345 6789', pickup_notes: 'Mother, Au pair (Sarah)' },
  { full_name: 'Liam Botha', group_name: 'Busy Bees', parent_name: 'Marlize Botha', parent_phone: '072 456 7890', pickup_notes: 'Mother, Father' },
  { full_name: 'Sipho Dlamini', group_name: 'Busy Bees', parent_name: 'Nomvula Dlamini', parent_phone: '073 567 8901', pickup_notes: 'Grandfather (Bheki)' },
  { full_name: 'Chloe Reddy', group_name: 'Busy Bees', parent_name: 'Kavitha Reddy', parent_phone: '074 678 9012', pickup_notes: 'Nanny (Precious)' },
  { full_name: 'Jayden Pillay', group_name: 'Turtles', parent_name: 'Ravi Pillay', parent_phone: '076 789 0123', pickup_notes: 'Mother only' },
  { full_name: 'Mia Fourie', group_name: 'Turtles', parent_name: 'Elzette Fourie', parent_phone: '078 890 1234', pickup_notes: 'Father, Grandmother' },
  { full_name: 'Kwena Mahlangu', group_name: 'Turtles', parent_name: 'Lindiwe Mahlangu', parent_phone: '079 901 2345', pickup_notes: 'Aunt (Zanele)' },
  { full_name: 'Isabella Coetzee', group_name: 'Butterflies', parent_name: 'Anriette Coetzee', parent_phone: '081 012 3456', pickup_notes: 'Mother, Father, Nanny' },
  { full_name: 'Nathi Zulu', group_name: 'Butterflies', parent_name: 'Thabo Zulu', parent_phone: '082 111 2233', pickup_notes: 'Father only' },
  { full_name: 'Emma Govender', group_name: 'Butterflies', parent_name: 'Suresh Govender', parent_phone: '083 222 3344', pickup_notes: 'Mother, Grandmother' },
  { full_name: 'Michael Adams', group_name: 'Dragon Flies', parent_name: 'Cindy Adams', parent_phone: '084 333 4455', pickup_notes: 'Mother only' },
  { full_name: 'Lerato Khumalo', group_name: 'Dragon Flies', parent_name: 'Nokuthula Khumalo', parent_phone: '072 444 5566', pickup_notes: 'Father, Aunt (Palesa)' },
  { full_name: 'Ruan Kruger', group_name: 'Dragon Flies', parent_name: 'Wynand Kruger', parent_phone: '073 555 6677', pickup_notes: 'Mother, Father' },
  { full_name: 'Ayanda Nkosi', group_name: 'Owls', parent_name: 'Bongani Nkosi', parent_phone: '074 666 7788', pickup_notes: 'Grandmother (Beauty)' },
  { full_name: 'Sophia Marais', group_name: 'Owls', parent_name: 'Chantelle Marais', parent_phone: '076 777 8899', pickup_notes: 'Mother, Father' },
  { full_name: 'Kabelo Sithole', group_name: 'Owls', parent_name: 'Refilwe Sithole', parent_phone: '078 888 9900', pickup_notes: 'Nanny (Grace)' },
  { full_name: 'Grace Steyn', group_name: 'Ladybirds', parent_name: 'Ilse Steyn', parent_phone: '079 999 0011', pickup_notes: 'Mother only' },
  { full_name: 'Junior Mabaso', group_name: 'Ladybirds', parent_name: 'Winnie Mabaso', parent_phone: '081 000 1122', pickup_notes: 'Father, Grandfather' }
];

const childrenCount = db.prepare('SELECT COUNT(*) AS n FROM children').get().n;
if (childrenCount === 0) {
  const insertChild = db.prepare(`
    INSERT INTO children (full_name, group_name, parent_name, parent_phone, pickup_notes, active, created_at, updated_at)
    VALUES (@full_name, @group_name, @parent_name, @parent_phone, @pickup_notes, 1, @now, @now)
  `);
  const now = Date.now();
  const seedDemo = db.transaction((rows) => {
    for (const row of rows) insertChild.run(Object.assign({ now }, row));
  });
  seedDemo(DEMO_CHILDREN);
}

// Every child needs a parent_token, including rows that predate the column
// (backfilled above) and rows the demo seed just inserted (which doesn't set
// one itself) -- one pass here catches both. The unique index goes on last,
// once every row actually has a value to be unique over.
const childrenMissingToken = db.prepare('SELECT id FROM children WHERE parent_token IS NULL').all();
if (childrenMissingToken.length) {
  const setToken = db.prepare('UPDATE children SET parent_token = ? WHERE id = ?');
  for (const row of childrenMissingToken) setToken.run(newParentToken(), row.id);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_children_parent_token ON children(parent_token)');

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
module.exports.GROUPS = GROUPS;
module.exports.newParentToken = newParentToken;
