const db = require('./db');
const { nowMs, sastDateTimeMs, todaySAST } = db;

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
  SELECT a.*, c.full_name, c.group_name, c.parent_name, c.family_id
  FROM attendance a
  JOIN children c ON c.id = a.child_id
`;

const MS_PER_HOUR = 60 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;

// Mirrors the billing workbook's math (Rates & Settings -> Daily Log ->
// Billing Summary), except the spreadsheet can't know exact late minutes
// (no live timestamps to read), so it charges a flat 4-block placeholder
// per late day. This app has the real collected_at, so it charges the
// actual number of 15-minute blocks (or part thereof) past cutoff, per
// Rates & Settings' own description of the fee ("Charged for each 15-minute
// block (or part thereof) past the cutoff").
//
// An attendance row still open (no collected_at yet) is billed as running
// to "now" if it's today's row -- that's what makes the Admin tally a live
// running total instead of a snapshot -- but a stale, never-collected past
// day is capped at the cutoff instead of accruing forever.
function costForRow(row, settings) {
  const hourlyRate = Number(settings.hourly_rate) || 0;
  const minHours = Number(settings.daily_minimum_hours) || 0;
  const lateFeePerBlock = Number(settings.late_fee_per_block) || 0;
  const cutoff = cutoffMsFor(row.date, settings);
  const endMs = row.collected_at != null ? row.collected_at : (row.date === todaySAST() ? nowMs() : cutoff);

  const durationHours = Math.max(0, endMs - row.checked_in_at) / MS_PER_HOUR;
  const billedHours = Math.max(durationHours, minHours);
  const baseCharge = billedHours * hourlyRate;

  const lateMs = Math.max(0, endMs - cutoff);
  const lateBlocks = lateMs > 0 ? Math.ceil(lateMs / BLOCK_MS) : 0;
  const lateFee = lateBlocks * lateFeePerBlock;

  return { billed_hours: billedHours, base_charge: baseCharge, late_blocks: lateBlocks, late_fee: lateFee, total: baseCharge + lateFee };
}

function serializeAttendanceRow(row, settings) {
  const cutoff = cutoffMsFor(row.date, settings);
  const collected = row.collected_at != null;
  let status;
  if (collected) status = 'collected';
  else if (nowMs() > cutoff) status = 'late';
  else status = 'checked_in';

  const cost = costForRow(row, settings);

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
    off_list: !!row.off_list,
    nudged_at: row.nudged_at || null,
    nudged_time: fmtSastTime(row.nudged_at),
    family_id: row.family_id || null,
    notes: row.notes,
    status,
    late_collection: collected && row.collected_at > cutoff,
    base_charge: cost.base_charge,
    late_fee: cost.late_fee,
    total_cost: cost.total
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
// aftercare they attended in the given month, and a running cost tally
// (base charges + late fees, see costForRow) -- the Admin page's monthly
// tally. Reads each attendance row once and aggregates both figures
// client-side in JS rather than a second SQL pass, since the cost math
// needs settings + per-row cutoff logic SQL can't express.
function monthlyTallyForAllChildren(yearMonth, { includeArchived } = {}) {
  const { from, to } = monthDateRange(yearMonth);
  const settings = getSettings();
  const children = db.prepare(
    includeArchived
      ? 'SELECT id, full_name, group_name, active, family_id FROM children ORDER BY full_name'
      : 'SELECT id, full_name, group_name, active, family_id FROM children WHERE active = 1 ORDER BY full_name'
  ).all();
  const attendanceRows = db.prepare('SELECT child_id, date, checked_in_at, collected_at FROM attendance WHERE date BETWEEN ? AND ?').all(from, to);

  const daysByChild = new Map();
  const costByChild = new Map();
  for (const row of attendanceRows) {
    daysByChild.set(row.child_id, (daysByChild.get(row.child_id) || 0) + 1);
    costByChild.set(row.child_id, (costByChild.get(row.child_id) || 0) + costForRow(row, settings).total);
  }

  return children.map(c => ({
    id: c.id,
    full_name: c.full_name,
    group_name: c.group_name,
    active: !!c.active,
    family_key: familyKeyFor(c),
    days_this_month: daysByChild.get(c.id) || 0,
    cost_this_month: Math.round((costByChild.get(c.id) || 0) * 100) / 100
  }));
}

// Everything the Parent View needs for one child, looked up by their
// no-login magic-link token rather than an id -- the token IS the auth here,
// so a miss just means "no such link" (a 404 upstream), never a lookup by a
// guessable id. Today's status, this month's running tally, and a handful
// of recent completed days: enough for a parent to check on their own child
// without exposing anything about anyone else's.
function parentSummaryForChild(token, { scope } = {}) {
  const child = db.prepare('SELECT * FROM children WHERE parent_token = ?').get(token);
  if (!child) return null;

  const settings = getSettings();
  const date = todaySAST();
  const todayRow = db.prepare(`${ATTENDANCE_JOIN} WHERE a.child_id = ? AND a.date = ?`).get(child.id, date);

  const { from, to } = monthDateRange(date.slice(0, 7));
  const monthRows = db.prepare('SELECT child_id, date, checked_in_at, collected_at FROM attendance WHERE child_id = ? AND date BETWEEN ? AND ?').all(child.id, from, to);
  const costThisMonth = monthRows.reduce((sum, r) => sum + costForRow(r, settings).total, 0);

  // Default view: a handful of recent completed days regardless of month
  // boundary (so the start of a new month doesn't suddenly show nothing).
  // "scope=month" (the Parent View's "view the full month" toggle) instead
  // shows every completed day within the current calendar month.
  const recentRows = scope === 'month'
    ? db.prepare(`${ATTENDANCE_JOIN} WHERE a.child_id = ? AND a.date BETWEEN ? AND ? AND a.collected_at IS NOT NULL ORDER BY a.date DESC`).all(child.id, from, to)
    : db.prepare(`${ATTENDANCE_JOIN} WHERE a.child_id = ? AND a.collected_at IS NOT NULL ORDER BY a.date DESC LIMIT 6`).all(child.id);

  return {
    child: { full_name: child.full_name, group_name: child.group_name },
    currency: settings.currency || 'R',
    today: todayRow ? serializeAttendanceRow(todayRow, settings) : null,
    days_this_month: monthRows.length,
    cost_this_month: Math.round(costThisMonth * 100) / 100,
    recent: recentRows.map(r => serializeAttendanceRow(r, settings))
  };
}

// "Pickup Check" is last so the first eight columns still paste straight
// into the billing workbook's Daily Log tab as before.
// ---------- monthly family statements ----------
// One statement per family: linked siblings (children.family_id) share one,
// any other child gets their own. Only families with at least one day of
// aftercare in the month are included. Uses the same costForRow as the
// Admin tally and Parent View, so the three can never disagree.

function familyKeyFor(child) {
  return child.family_id ? 'f' + child.family_id : 'c' + child.id;
}

function monthLabel(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function round2(n) { return Math.round(n * 100) / 100; }

function familyStatements(yearMonth, { familyKey } = {}) {
  const { from, to } = monthDateRange(yearMonth);
  const settings = getSettings();
  const children = db.prepare('SELECT id, full_name, group_name, parent_name, parent_phone, family_id FROM children').all();
  const childById = new Map(children.map(c => [c.id, c]));
  const rows = db.prepare('SELECT * FROM attendance WHERE date BETWEEN ? AND ? ORDER BY date ASC').all(from, to);

  const families = new Map();
  for (const row of rows) {
    const child = childById.get(row.child_id);
    if (!child) continue;
    const key = familyKeyFor(child);
    if (familyKey && key !== familyKey) continue;
    if (!families.has(key)) families.set(key, { key, children: new Map() });
    const fam = families.get(key);
    if (!fam.children.has(child.id)) {
      fam.children.set(child.id, { id: child.id, full_name: child.full_name, group_name: child.group_name, parent_name: child.parent_name, parent_phone: child.parent_phone, days: [], subtotal: 0 });
    }
    const cost = costForRow(row, settings);
    const entry = fam.children.get(child.id);
    entry.days.push({
      date: row.date,
      arrival: fmtSastTime(row.checked_in_at),
      collection: fmtSastTime(row.collected_at),
      open: row.collected_at == null,
      collected_by: row.collected_by,
      billed_hours: round2(cost.billed_hours),
      base_charge: round2(cost.base_charge),
      late_blocks: cost.late_blocks,
      late_fee: round2(cost.late_fee),
      total: round2(cost.total)
    });
    entry.subtotal += cost.total;
  }

  const out = [...families.values()].map(fam => {
    const kids = [...fam.children.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
    kids.forEach(k => { k.subtotal = round2(k.subtotal); });
    const parentNames = [...new Set(kids.map(k => k.parent_name).filter(Boolean))];
    return {
      key: fam.key,
      parent_names: parentNames,
      parent_phone: (kids.find(k => k.parent_phone) || {}).parent_phone || null,
      children: kids,
      days: kids.reduce((n, k) => n + k.days.length, 0),
      late_fees: round2(kids.reduce((n, k) => n + k.days.reduce((m, d) => m + d.late_fee, 0), 0)),
      total: round2(kids.reduce((n, k) => n + k.subtotal, 0))
    };
  }).sort((a, b) => (a.parent_names[0] || a.children[0].full_name).localeCompare(b.parent_names[0] || b.children[0].full_name));

  return {
    month: yearMonth,
    month_label: monthLabel(yearMonth),
    generated_on: todaySAST(),
    rates: {
      currency: settings.currency || 'R',
      hourly_rate: Number(settings.hourly_rate) || 0,
      daily_minimum_hours: Number(settings.daily_minimum_hours) || 0,
      late_fee_per_block: Number(settings.late_fee_per_block) || 0,
      cutoff_time: settings.cutoff_time || '17:30'
    },
    families: out
  };
}

const CSV_HEADER = ['Date', 'Child Name', 'Group', 'Parent / Guardian', 'Arrival Time', 'Collection Time', 'Collected By', 'Late Pickup?', 'Pickup Check'];

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
      r.late_collection ? 'Late' : '',
      r.off_list ? 'Not on pickup list' : ''
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
  costForRow,
  serializeAttendanceRow,
  attendanceForDate,
  attendanceForRange,
  attendanceHistoryForChild,
  monthDateRange,
  monthlyTallyForAllChildren,
  familyKeyFor,
  familyStatements,
  parentSummaryForChild,
  dayCollectionStatus,
  buildCsv
};
