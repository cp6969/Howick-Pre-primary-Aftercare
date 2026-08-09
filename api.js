const express = require('express');
const db = require('./db');
const { todaySAST, nowMs, sastDateTimeMs, sastArrivalMs, GROUPS } = db;

const router = express.Router();

// ---------- helpers ----------

function validGroupOrNull(group_name) {
  // No group assigned is fine (some kids aren't in a class group yet); an
  // unrecognized one almost always means a typo that would silently split
  // a group across two spellings on the roster, so it's rejected outright.
  if (group_name === undefined || group_name === null || group_name === '') return { ok: true, value: null };
  if (GROUPS.includes(group_name)) return { ok: true, value: group_name };
  return { ok: false };
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function cutoffMsFor(dateStr, settings) {
  const [hh, mm] = (settings.cutoff_time || '17:30').split(':').map(Number);
  return sastDateTimeMs(dateStr, hh, mm);
}

function fmtSastTime(ms) {
  if (ms == null) return null;
  return new Date(ms + 2 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

function serializeChild(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    group_name: row.group_name,
    parent_name: row.parent_name,
    parent_phone: row.parent_phone,
    pickup_notes: row.pickup_notes,
    active: !!row.active
  };
}

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

const ATTENDANCE_JOIN = `
  SELECT a.*, c.full_name, c.group_name, c.parent_name
  FROM attendance a
  JOIN children c ON c.id = a.child_id
`;

// ---------- groups ----------

router.get('/groups', (req, res) => {
  res.json(GROUPS);
});

// ---------- children ----------

router.get('/children', (req, res) => {
  const includeArchived = req.query.all === '1';
  const rows = includeArchived
    ? db.prepare('SELECT * FROM children ORDER BY full_name').all()
    : db.prepare('SELECT * FROM children WHERE active = 1 ORDER BY full_name').all();
  res.json(rows.map(serializeChild));
});

router.post('/children', (req, res) => {
  const { full_name, group_name, parent_name, parent_phone, pickup_notes } = req.body || {};
  if (!full_name || !full_name.trim()) return res.status(400).json({ error: 'full_name is required' });

  const group = validGroupOrNull(group_name);
  if (!group.ok) return res.status(400).json({ error: `Unknown group "${group_name}". Must be one of: ${GROUPS.join(', ')}` });

  const now = nowMs();
  const result = db.prepare(`
    INSERT INTO children (full_name, group_name, parent_name, parent_phone, pickup_notes, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(full_name.trim(), group.value, parent_name || null, parent_phone || null, pickup_notes || null, now, now);

  const row = db.prepare('SELECT * FROM children WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(serializeChild(row));
});

router.put('/children/:id', (req, res) => {
  const child = db.prepare('SELECT * FROM children WHERE id = ?').get(req.params.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const { full_name, group_name, parent_name, parent_phone, pickup_notes } = req.body || {};
  if (full_name !== undefined && !full_name.trim()) return res.status(400).json({ error: 'full_name cannot be empty' });

  const group = group_name !== undefined ? validGroupOrNull(group_name) : { ok: true, value: child.group_name };
  if (!group.ok) return res.status(400).json({ error: `Unknown group "${group_name}". Must be one of: ${GROUPS.join(', ')}` });

  db.prepare(`
    UPDATE children SET
      full_name = ?, group_name = ?, parent_name = ?, parent_phone = ?, pickup_notes = ?, updated_at = ?
    WHERE id = ?
  `).run(
    full_name !== undefined ? full_name.trim() : child.full_name,
    group.value,
    parent_name !== undefined ? parent_name : child.parent_name,
    parent_phone !== undefined ? parent_phone : child.parent_phone,
    pickup_notes !== undefined ? pickup_notes : child.pickup_notes,
    nowMs(),
    req.params.id
  );

  const row = db.prepare('SELECT * FROM children WHERE id = ?').get(req.params.id);
  res.json(serializeChild(row));
});

router.post('/children/:id/archive', (req, res) => {
  const result = db.prepare('UPDATE children SET active = 0, updated_at = ? WHERE id = ?').run(nowMs(), req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Child not found' });
  res.status(204).end();
});

router.post('/children/:id/restore', (req, res) => {
  const result = db.prepare('UPDATE children SET active = 1, updated_at = ? WHERE id = ?').run(nowMs(), req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Child not found' });
  res.status(204).end();
});

// ---------- attendance ----------

router.get('/attendance/today', (req, res) => {
  const settings = getSettings();
  const date = todaySAST();
  const rows = db.prepare(`${ATTENDANCE_JOIN} WHERE a.date = ? ORDER BY a.checked_in_at ASC`).all(date);
  res.json(rows.map(r => serializeAttendanceRow(r, settings)));
});

router.post('/attendance/check-in', (req, res) => {
  const { child_id } = req.body || {};
  if (!child_id) return res.status(400).json({ error: 'child_id is required' });

  const child = db.prepare('SELECT * FROM children WHERE id = ? AND active = 1').get(child_id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const date = todaySAST();
  const existing = db.prepare('SELECT * FROM attendance WHERE child_id = ? AND date = ?').get(child_id, date);
  if (existing) {
    const settings = getSettings();
    const row = db.prepare(`${ATTENDANCE_JOIN} WHERE a.id = ?`).get(existing.id);
    return res.status(200).json(serializeAttendanceRow(row, settings));
  }

  const now = nowMs();
  const result = db.prepare(`
    INSERT INTO attendance (child_id, date, checked_in_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(child_id, date, sastArrivalMs(date), now, now);

  const settings = getSettings();
  const row = db.prepare(`${ATTENDANCE_JOIN} WHERE a.id = ?`).get(result.lastInsertRowid);
  res.status(201).json(serializeAttendanceRow(row, settings));
});

router.post('/attendance/:id/collect', (req, res) => {
  const existing = db.prepare('SELECT * FROM attendance WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Attendance record not found' });

  const { collected_by } = req.body || {};
  if (!collected_by || !collected_by.trim()) return res.status(400).json({ error: 'collected_by is required' });

  const collectedAt = req.body.collected_at ? Number(req.body.collected_at) : nowMs();
  db.prepare(`
    UPDATE attendance SET collected_at = ?, collected_by = ?, updated_at = ? WHERE id = ?
  `).run(collectedAt, collected_by.trim(), nowMs(), req.params.id);

  const settings = getSettings();
  const row = db.prepare(`${ATTENDANCE_JOIN} WHERE a.id = ?`).get(req.params.id);
  res.json(serializeAttendanceRow(row, settings));
});

router.post('/attendance/:id/uncollect', (req, res) => {
  const result = db.prepare(`
    UPDATE attendance SET collected_at = NULL, collected_by = NULL, updated_at = ? WHERE id = ?
  `).run(nowMs(), req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Attendance record not found' });

  const settings = getSettings();
  const row = db.prepare(`${ATTENDANCE_JOIN} WHERE a.id = ?`).get(req.params.id);
  res.json(serializeAttendanceRow(row, settings));
});

router.delete('/attendance/:id', (req, res) => {
  const result = db.prepare('DELETE FROM attendance WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Attendance record not found' });
  res.status(204).end();
});

// ---------- stats ----------

router.get('/stats/today', (req, res) => {
  const settings = getSettings();
  const date = todaySAST();
  const todayRows = db.prepare(`${ATTENDANCE_JOIN} WHERE a.date = ?`).all(date).map(r => serializeAttendanceRow(r, settings));

  const checkedInToday = todayRows.length;
  const awaitingPickup = todayRows.filter(r => r.status !== 'collected').length;
  const collectedToday = todayRows.filter(r => r.status === 'collected').length;
  const collectedRows = todayRows.filter(r => r.status === 'collected');
  const avgStayMs = collectedRows.length
    ? collectedRows.reduce((sum, r) => sum + (r.collected_at - r.checked_in_at), 0) / collectedRows.length
    : null;

  // Late collections over the trailing 7 days (including today).
  const weekAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const weekRows = db.prepare(`${ATTENDANCE_JOIN} WHERE a.date >= ? AND a.collected_at IS NOT NULL`).all(weekAgo);
  const lateThisWeek = weekRows.filter(r => {
    const cutoff = cutoffMsFor(r.date, settings);
    return r.collected_at > cutoff;
  }).length;

  res.json({
    date,
    checked_in_today: checkedInToday,
    awaiting_pickup: awaitingPickup,
    collected_today: collectedToday,
    avg_stay_minutes: avgStayMs != null ? Math.round(avgStayMs / 60000) : null,
    late_collections_7d: lateThisWeek
  });
});

// ---------- CSV export (feeds the billing workbook's Daily Log tab) ----------

router.get('/attendance/export.csv', (req, res) => {
  const from = req.query.from || todaySAST();
  const to = req.query.to || from;
  const settings = getSettings();

  const rows = db.prepare(`
    ${ATTENDANCE_JOIN} WHERE a.date BETWEEN ? AND ? ORDER BY a.date ASC, c.full_name ASC
  `).all(from, to).map(r => serializeAttendanceRow(r, settings));

  const header = ['Date', 'Child Name', 'Group', 'Parent / Guardian', 'Arrival Time', 'Collection Time', 'Collected By', 'Late Pickup?'];
  const csvEscape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
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

  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="aftercare-attendance-${from}_to_${to}.csv"`);
  res.send(lines.join('\n'));
});

// ---------- settings ----------

router.get('/settings', (req, res) => {
  res.json(getSettings());
});

router.put('/settings', (req, res) => {
  const allowed = ['cutoff_time', 'hourly_rate', 'late_fee_per_block', 'currency'];
  const update = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const key of allowed) {
    if (req.body && req.body[key] !== undefined) update.run(key, String(req.body[key]));
  }
  res.json(getSettings());
});

module.exports = router;
