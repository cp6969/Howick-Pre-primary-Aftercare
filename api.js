const express = require('express');
const db = require('./db');
const { todaySAST, nowMs, sastArrivalMs, GROUPS, newParentToken } = db;
const reports = require('./reports');
const { getSettings, attendanceForDate, attendanceForRange, dayCollectionStatus, buildCsv, cutoffMsFor } = reports;
const mailer = require('./mailer');
const { checkPickup } = require('./pickup');
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
    parent_token: row.parent_token,
    // Siblings are the other children sharing this value (null = none).
    family_id: row.family_id || null
  };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Replaces one child's set of linked siblings. Picking a sibling who is
// already in a family brings that whole family along (so linking a third
// child to either of two linked siblings links all three). A family left
// with a single member is dissolved.
const setSiblings = db.transaction((childId, siblingIds) => {
  childId = Number(childId);
  const ids = [...new Set((siblingIds || []).map(Number))].filter((id) => id && id !== childId);
  const found = ids.length
    ? db.prepare(`SELECT id, family_id FROM children WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : [];
  if (found.length !== ids.length) throw new HttpError(400, 'One of the chosen siblings is no longer on the roster.');

  const self = db.prepare('SELECT family_id FROM children WHERE id = ?').get(childId);
  const touched = new Set();
  if (self && self.family_id) touched.add(self.family_id);
  db.prepare('UPDATE children SET family_id = NULL WHERE id = ?').run(childId);

  if (ids.length) {
    const members = new Set([childId, ...ids]);
    for (const f of found) {
      if (!f.family_id) continue;
      touched.add(f.family_id);
      db.prepare('SELECT id FROM children WHERE family_id = ?').all(f.family_id).forEach((r) => members.add(r.id));
    }
    const familyId = Math.min(...members);
    const update = db.prepare('UPDATE children SET family_id = ? WHERE id = ?');
    for (const id of members) update.run(familyId, id);
  }

  for (const familyId of touched) {
    const left = db.prepare('SELECT id FROM children WHERE family_id = ?').all(familyId);
    if (left.length === 1) db.prepare('UPDATE children SET family_id = NULL WHERE id = ?').run(left[0].id);
  }
});

function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  throw err;
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
  let newId;
  try {
    db.transaction(() => {
      newId = db.prepare(`
        INSERT INTO children (full_name, group_name, parent_name, parent_phone, pickup_notes, active, created_at, updated_at, parent_token)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(full_name.trim(), group.value, parent_name || null, parent_phone || null, pickup_notes || null, now, now, newParentToken()).lastInsertRowid;
      if (Array.isArray(req.body.sibling_ids) && req.body.sibling_ids.length) setSiblings(newId, req.body.sibling_ids);
    })();
  } catch (err) { return sendError(res, err); }

  const row = db.prepare('SELECT * FROM children WHERE id = ?').get(newId);
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

  if (Array.isArray(req.body.sibling_ids)) {
    try { setSiblings(req.params.id, req.body.sibling_ids); } catch (err) { return sendError(res, err); }
  }

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

// "Same as yesterday": who came on the most recent earlier aftercare day
// (so on a Monday that's Friday, after a holiday it's the last day open).
// Archived children are left out; the page drops anyone already in today.
router.get('/attendance/previous-day', (req, res) => {
  const today = todaySAST();
  const prev = db.prepare('SELECT MAX(date) AS date FROM attendance WHERE date < ?').get(today).date;
  if (!prev) return res.json({ today, date: null, child_ids: [] });
  const childIds = db.prepare(`
    SELECT a.child_id FROM attendance a JOIN children c ON c.id = a.child_id
    WHERE a.date = ? AND c.active = 1 ORDER BY c.full_name COLLATE NOCASE
  `).all(prev).map((r) => r.child_id);
  res.json({ today, date: prev, child_ids: childIds });
});

// Roll call's "Most frequent" sort: hours each child has spent at aftercare
// so far this month (13:00 to collection; days not yet collected don't
// count). Hours only, no money -- this is the staff side, not Admin.
router.get('/attendance/month-hours', (req, res) => {
  const month = todaySAST().slice(0, 7);
  const rows = db.prepare(`
    SELECT child_id, SUM(collected_at - checked_in_at) AS ms FROM attendance
    WHERE date LIKE ? AND collected_at IS NOT NULL GROUP BY child_id
  `).all(month + '-%');
  const hours = {};
  for (const r of rows) hours[r.child_id] = Math.round(Math.max(r.ms, 0) / 360000) / 10;
  res.json({ month, hours });
});

// Checks in several children at once (roll call's "same as yesterday").
// Children already in today are left as they are; archived or unknown ids
// are skipped (counted in "skipped"). Answers with the attendance ids this
// call created, which is exactly what an undo should remove.
router.post('/attendance/check-in-many', (req, res) => {
  const ids = (req.body || {}).child_ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'child_ids must be a non-empty list' });
  const childIds = [...new Set(ids.map(Number))].filter((id) => Number.isInteger(id) && id > 0);

  const date = todaySAST();
  const now = nowMs();
  const isActive = db.prepare('SELECT 1 FROM children WHERE id = ? AND active = 1');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO attendance (child_id, date, checked_in_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const createdIds = db.transaction(() => {
    const out = [];
    for (const id of childIds) {
      if (!isActive.get(id)) continue;
      const r = insert.run(id, date, sastArrivalMs(date), now, now);
      if (r.changes) out.push(Number(r.lastInsertRowid));
    }
    return out;
  })();

  res.status(201).json({ created_ids: createdIds, skipped: childIds.length - createdIds.length });
});

// Undo for check-in-many. Only today's rows that haven't been collected yet
// are removed, so a child collected in the meantime keeps their record.
router.post('/attendance/undo-check-in', (req, res) => {
  const ids = (req.body || {}).attendance_ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'attendance_ids must be a non-empty list' });
  const del = db.prepare('DELETE FROM attendance WHERE id = ? AND date = ? AND collected_at IS NULL');
  const date = todaySAST();
  const removed = db.transaction(() => ids.reduce((n, id) => n + del.run(Number(id), date).changes, 0))();
  res.json({ removed, kept: ids.length - removed });
});

// Collects one child, optionally with siblings in the same call
// (also_attendance_ids), all logged with the same person and time.
//
// Each child is checked against their own pickup list (see pickup.js). If
// anyone is off-list, nothing is saved and this answers 409 with who and
// why, so the page can warn. Sending the same request again with
// override: true records the release with off_list = 1 as an audit trail.
router.post('/attendance/:id/collect', (req, res) => {
  const body = req.body || {};
  const collectedBy = String(body.collected_by || '').trim();
  if (!collectedBy) return res.status(400).json({ error: 'collected_by is required' });

  const primaryId = Number(req.params.id);
  const extraIds = Array.isArray(body.also_attendance_ids) ? body.also_attendance_ids.map(Number) : [];
  const ids = [...new Set([primaryId, ...extraIds])];

  const lookup = db.prepare(`
    SELECT a.*, c.full_name, c.parent_name, c.pickup_notes
    FROM attendance a JOIN children c ON c.id = a.child_id
    WHERE a.id = ?
  `);
  const rows = ids.map((id) => lookup.get(id));
  if (rows.some((r) => !r)) return res.status(404).json({ error: 'Attendance record not found' });
  const date = rows[0].date;
  if (rows.some((r) => r.date !== date)) return res.status(400).json({ error: 'Siblings can only be collected together on the same day.' });

  const offList = rows
    .map((row) => ({ row, check: checkPickup(row, collectedBy) }))
    .filter((x) => !x.check.ok);

  if (offList.length && !body.override) {
    const names = offList.map((x) => x.row.full_name.split(' ')[0]);
    const list = names.length === 1 ? names[0] + '’s' : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + '’s';
    return res.status(409).json({
      error: `${collectedBy} isn’t on ${list} pickup list.`,
      code: 'not_on_pickup_list',
      collected_by: collectedBy,
      children: offList.map((x) => ({
        attendance_id: x.row.id,
        full_name: x.row.full_name,
        pickup_notes: x.row.pickup_notes,
        allowed: x.check.allowed
      }))
    });
  }

  const offListIds = new Set(offList.map((x) => x.row.id));
  const collectedAt = body.collected_at ? Number(body.collected_at) : nowMs();
  const update = db.prepare(`
    UPDATE attendance SET collected_at = ?, collected_by = ?, off_list = ?, updated_at = ? WHERE id = ?
  `);
  db.transaction(() => {
    for (const row of rows) {
      // A sibling collected on another device in the meantime keeps its own time.
      if (row.id !== primaryId && row.collected_at != null) continue;
      update.run(collectedAt, collectedBy, offListIds.has(row.id) ? 1 : 0, nowMs(), row.id);
    }
  })();

  const today = attendanceForDate(date);
  const primary = today.find((r) => r.id === primaryId);
  res.json(Object.assign({}, primary, { collected_ids: ids }));
});

router.post('/attendance/:id/uncollect', (req, res) => {
  const existing = db.prepare('SELECT * FROM attendance WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Attendance record not found' });

  db.prepare(`
    UPDATE attendance SET collected_at = NULL, collected_by = NULL, off_list = 0, updated_at = ? WHERE id = ?
  `).run(nowMs(), req.params.id);

  const row = attendanceForDate(existing.date).find(r => r.id === existing.id);
  res.json(row);
});

// Records that staff opened the late-pickup WhatsApp message for this child,
// so the "Messaged 17:24" note shows on every device.
router.post('/attendance/:id/nudge', (req, res) => {
  const existing = db.prepare('SELECT * FROM attendance WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Attendance record not found' });
  db.prepare('UPDATE attendance SET nudged_at = ?, updated_at = ? WHERE id = ?').run(nowMs(), nowMs(), req.params.id);
  res.json(attendanceForDate(existing.date).find((r) => r.id === existing.id));
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
    // The collection cutoff is operational, not a billing rate, so staff get
    // it here: the tracker uses it to offer the late-pickup message.
    cutoff_time: settings.cutoff_time || '17:30',
    cutoff_at: cutoffMsFor(date, settings),
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
