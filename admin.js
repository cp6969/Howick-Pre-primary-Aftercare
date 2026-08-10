const express = require('express');
const reports = require('./reports');
const { getSettings, monthlyTallyForAllChildren, attendanceHistoryForChild } = reports;

// Mounted at /api/admin in server.js, behind BOTH the ordinary site-login
// gate (requireSiteAuthApi, applied to all of /api/*) and the Admin-PIN
// gate (requireAdminAuthApi, applied specifically to /api/admin/*) -- see
// server.js for both.

const router = express.Router();

// ---------- aftercare rates (moved here from /api/settings, section 4c-era) ----------
// The point of moving these behind the PIN wasn't just to hide the form --
// day-to-day staff shouldn't be able to read or change billing rates via a
// direct API call either, so this genuinely replaces the old routes rather
// than just adding a read-only mirror of them.

router.get('/settings', (req, res) => {
  res.json(getSettings());
});

router.put('/settings', (req, res) => {
  const allowed = ['cutoff_time', 'hourly_rate', 'daily_minimum_hours', 'late_fee_per_block', 'currency'];
  for (const key of allowed) {
    if (req.body && req.body[key] !== undefined) reports.setSetting(key, req.body[key]);
  }
  res.json(getSettings());
});

// ---------- children: attendance log + monthly tally ----------

router.get('/children-tally', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  try {
    const rows = monthlyTallyForAllChildren(month, { includeArchived: req.query.all === '1' });
    res.json({ month, children: rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/children/:id/history', (req, res) => {
  res.json(attendanceHistoryForChild(req.params.id));
});

module.exports = router;
