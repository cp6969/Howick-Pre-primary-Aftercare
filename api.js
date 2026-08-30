const express = require('express');
const db = require('./db');
const { todaySAST, nowMs, sastArrivalMs, GROUPS, newParentToken } = db;
const reports = require('./reports');
const { getSettings, attendanceForDate, attendanceForRange, dayCollectionStatus, buildCsv } = reports;
const mailer = require('./mailer');
const scheduler = require('./scheduler');

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

function serializeChild(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    group_name: row.group_name,
    parent_name: row.parent_name,
    parent_phone: row.parent_phone,
    pickup_notes: row.pickup_notes,
    active: !!row.active,
    // Not a secret from staff -- they already see every child's full record --
    // just the link that opens this one child's no-login Parent View, so the
    // roster screen can offer a "copy parent link" action per child.
    parent_token: row.parent_token
  };
}

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
    INSERT INTO children (full_name, group_name, parent_name, parent_phone, pickup_notes, active, created_at, updated_at, parent_token)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(full_name.trim(), group.value, parent_name || null, parent_phone || null, pickup_notes || null, now, now, newParentToken());

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

// If a parent link was ever sent to the wrong person, this swaps the child's
// token for a fresh one -- the old link stops working immediately since
// lookups are by exact token match.
router.post('/children/:id/regenerate-parent-token', (req, res) => {
  const token = newParentToken();
  const result = db.prepare('UPDATE children SET parent_token = ?, updated_at = ? WHERE id = ?').run(token, nowMs(), req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Child not found' });
  res.json({ parent_token: token });
});

// ---------- attendance ----------

router.get('/attendance/today', (req, res) => {
  res.json(attendanceForDate(todaySAST()));
});

router.post('/attendance/check-in', (req, res) => {
  const { child_id } = req.body || {};
  if (!child_id) return res.status(400).json({ error: 'child_id is required' });

  const child = db.prepare('SELECT * FROM children WHERE id = ? AND active = 1').get(child_id);
  if (!child) return res.status(404).json({ error: 'Child not found' });

  const date = todaySAST();
  const existing = db.prepare('SELECT * FROM attendance WHERE child_id = ? AND date = ?').get(child_id, date);
  if (existing) {
    const row = attendanceForDate(date).find(r => r.id === existing.id);
    return res.status(200).json(row);
  }

  const now = nowMs();
  const result = db.prepare(`
    INSERT INTO attendance (child_id, date, checked_in_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(child_id, date, sastArrivalMs(date), now, now);

  const row = attendanceForDate(date).find(r => r.id === result.lastInsertRowid);
  res.status(201).json(row);
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

  const row = attendanceForDate(existing.date).find(r => r.id === existing.id);
  res.json(row);
});

router.post('/attendance/:id/uncollect', (req, res) => {
  const existing = db.prepare('SELECT * FROM attendance WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Attendance record not found' });

  db.prepare(`
    UPDATE attendance SET collected_at = NULL, collected_by = NULL, updated_at = ? WHERE id = ?
  `).run(nowMs(), req.params.id);

  const row = attendanceForDate(existing.date).find(r => r.id === existing.id);
  res.json(row);
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
  const todayRows = attendanceForDate(date);

  const checkedInToday = todayRows.length;
  const awaitingPickup = todayRows.filter(r => r.status !== 'collected').length;
  const collectedToday = todayRows.filter(r => r.status === 'collected').length;
  const collectedRows = todayRows.filter(r => r.status === 'collected');
  const avgStayMs = collectedRows.length
    ? collectedRows.reduce((sum, r) => sum + (r.collected_at - r.checked_in_at), 0) / collectedRows.length
    : null;

  // Late collections over the trailing 7 days (including today).
  const weekAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const weekRows = attendanceForRange(weekAgo, date).filter(r => r.collected_at != null);
  const lateThisWeek = weekRows.filter(r => r.late_collection).length;

  res.json({
    date,
    checked_in_today: checkedInToday,
    awaiting_pickup: awaitingPickup,
    collected_today: collectedToday,
    avg_stay_minutes: avgStayMs != null ? Math.round(avgStayMs / 60000) : null,
    late_collections_7d: lateThisWeek,
    // Powers both the manual "Export today's log" button (index.html) and
    // is re-derived independently by the daily-log scheduler -- this flag
    // is informational for the UI, never trusted as the actual gate on the
    // server side (see dayCollectionStatus / attemptDailySend).
    ready_to_export: checkedInToday > 0 && awaitingPickup === 0
  });
});

// ---------- CSV export (feeds the billing workbook's Daily Log tab) ----------

router.get('/attendance/export.csv', (req, res) => {
  const from = req.query.from || todaySAST();
  const to = req.query.to || from;
  const csv = buildCsv(attendanceForRange(from, to));

  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="aftercare-attendance-${from}_to_${to}.csv"`);
  res.send(csv);
});

// Aftercare rates (cutoff time / hourly rate / late fee / currency) moved
// to /api/admin/settings, gated behind the Admin PIN -- see admin.js. Not
// left here even as a read-only GET, since the whole point of moving them
// was to keep day-to-day staff out of billing rates, not just hide the form.

// ---------- daily log email ----------
// Automatically emails "today's log" once every checked-in child has been
// collected, checked every minute from the configured send time onward
// (see scheduler.js) -- never before everyone's collected, and never twice
// in one day. "Send now" (below) uses the exact same readiness check, just
// bypassing the enabled/time/already-sent gates so it can be used to test
// the email or to resend on demand.

router.get('/daily-log/status', (req, res) => {
  const settings = getSettings();
  const date = todaySAST();
  res.json({
    enabled: settings.daily_log_enabled === 'true',
    recipients: settings.daily_log_recipients || '',
    send_time: settings.daily_log_send_time || '18:00',
    last_sent_date: settings.daily_log_last_sent_date || '',
    smtp_configured: mailer.configured(),
    today: dayCollectionStatus(date)
  });
});

router.put('/daily-log/settings', (req, res) => {
  const { enabled, recipients, send_time } = req.body || {};

  if (send_time !== undefined && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(send_time).trim())) {
    return res.status(400).json({ error: 'Send time must be in HH:MM 24-hour format, e.g. 18:00' });
  }
  let cleanedRecipients;
  if (recipients !== undefined) {
    cleanedRecipients = String(recipients).split(',').map(s => s.trim()).filter(Boolean);
    const bad = cleanedRecipients.find(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (bad) return res.status(400).json({ error: `"${bad}" doesn't look like a valid email address` });
  }

  if (enabled !== undefined) reports.setSetting('daily_log_enabled', enabled ? 'true' : 'false');
  if (cleanedRecipients !== undefined) reports.setSetting('daily_log_recipients', cleanedRecipients.join(', '));
  if (send_time !== undefined) reports.setSetting('daily_log_send_time', String(send_time).trim());

  res.json({ ok: true });
});

router.post('/daily-log/send-now', async (req, res) => {
  const result = await scheduler.attemptDailySend({ force: true });
  res.json(result);
});

module.exports = router;
