const db = require('./db');
const { nowMs, sastDateTimeMs } = db;

// Shared between api.js (the /attendance/* routes) and scheduler.js (the
// automatic 6pm email) so "is today's log ready" and "what does the CSV
// look like" can never drift between the manual button and the automated
// send -- both call the exact same functions.

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function cutoffMsFor(dateStr, settings) {
  const [hh, mm] = (settings.cutoff_time || '17:30').split(':').map(Number);
  return sastDateTimeMs(dateStr, hh, mm);
}

function fmtSastTime(ms) {
  if (ms == null) return null;
  return new Date(ms + 2 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

const ATTENDANCE_JOIN = `
  SELECT a.*, c.full_name, c.group_name, c.parent_name
  FROM attendance a
  JOIN children c ON c.id = a.child_id
`;

function serializeAttendanceRow(row, settings) {
  const cutoff = cutoffMsFor(row.date, settings);
  const collected = row.collected_at != null;
  let status;
  if (collected) status = 'collected';
  else if (nowMs() > cutoff) status = 'late';
  else status = 'checked_in';

  return {
    id: row.id,
    child_id: row.child_id,
    date: row.date,
    full_name: row.full_name,
    group_name: row.group_name,
    parent_name: row.parent_name,
    checked_in_at: row.checked_in_at,
    checked_in_time: fmtSastTime(row.checked_in_at),
    collected_at: row.collected_at,
    collected_time: fmtSastTime(row.collected_at),
    collected_by: row.collected_by,
    notes: row.notes,
    status,
    late_collection: collected && row.collected_at > cutoff
  };
}

function attendanceForDate(dateStr) {
  const settings = getSettings();
  const rows = db.prepare(`${ATTENDANCE_JOIN} WHERE a.date = ? ORDER BY a.checked_in_at ASC`).all(dateStr);
  return rows.map(r => serializeAttendanceRow(r, settings));
}

function attendanceForRange(from, to) {
  const settings = getSettings();
  const rows = db.prepare(`${ATTENDANCE_JOIN} WHERE a.date BETWEEN ? AND ? ORDER BY a.date ASC, c.full_name ASC`).all(from, to);
  return rows.map(r => serializeAttendanceRow(r, settings));
}

// Whether a given day's log is "done" -- everyone who checked in has also
// been collected. A day with nobody checked in at all isn't "ready" either
// (there's nothing meaningful to export/email yet), which also happens to
// be the correct behavior for the auto-email: no attendance yet just means
// keep waiting, not "send an empty log".
function dayCollectionStatus(dateStr) {
  const rows = attendanceForDate(dateStr);
  const collected = rows.filter(r => r.status === 'collected').length;
  return {
    date: dateStr,
    total: rows.length,
    collected,
    awaiting: rows.length - collected,
    ready: rows.length > 0 && collected === rows.length
  };
}

// Full history for one child, newest first -- powers the Admin page's
// per-child attendance log. Not scoped to any date range, since there's no
// obvious "recent enough" cutoff for a small school roster.
function attendanceHistoryForChild(childId) {
  const settings = getSettings();
  const rows = db.prepare(`${ATTENDANCE_JOIN} WHERE a.child_id = ? ORDER BY a.date DESC`).all(childId);
  return rows.map(r => serializeAttendanceRow(r, settings));
}

function monthDateRange(yearMonth) {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth || '');
  if (!m) throw new Error('month must be in YYYY-MM format');
  const year = Number(m[1]);
  const month = Number(m[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month = last day of this one
  return { from: `${yearMonth}-01`, to: `${yearMonth}-${String(lastDay).padStart(2, '0')}` };
}

// One row per child (active only by default) with how many days of
// aftercare they attended in the given month -- the Admin page's monthly
// tally, one query per month rather than pulling every attendance row and
// counting client-side.
function monthlyTallyForAllChildren(yearMonth, { includeArchived } = {}) {
  const { from, to } = monthDateRange(yearMonth);
  const children = db.prepare(
    includeArchived
      ? 'SELECT id, full_name, group_name, active FROM children ORDER BY full_name'
      : 'SELECT id, full_name, group_name, active FROM children WHERE active = 1 ORDER BY full_name'
  ).all();
  const tallyRows = db.prepare('SELECT child_id, COUNT(*) AS days FROM attendance WHERE date BETWEEN ? AND ? GROUP BY child_id').all(from, to);
  const tallyByChild = new Map(tallyRows.map(r => [r.child_id, r.days]));
  return children.map(c => ({
    id: c.id,
    full_name: c.full_name,
    group_name: c.group_name,
    active: !!c.active,
    days_this_month: tallyByChild.get(c.id) || 0
  }));
}

const CSV_HEADER = ['Date', 'Child Name', 'Group', 'Parent / Guardian', 'Arrival Time', 'Collection Time', 'Collected By', 'Late Pickup?'];

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push([
      r.date,
      r.full_name,
      r.group_name || '',
      r.parent_name || '',
      r.checked_in_time || '',
      r.collected_time || '',
      r.collected_by || '',
      r.late_collection ? 'Late' : ''
    ].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

module.exports = {
  getSettings,
  setSetting,
  cutoffMsFor,
  fmtSastTime,
  ATTENDANCE_JOIN,
  serializeAttendanceRow,
  attendanceForDate,
  attendanceForRange,
  attendanceHistoryForChild,
  monthDateRange,
  monthlyTallyForAllChildren,
  dayCollectionStatus,
  buildCsv
};
