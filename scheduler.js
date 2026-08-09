const db = require('./db');
const { todaySAST } = db;
const reports = require('./reports');
const mailer = require('./mailer');

const CHECK_INTERVAL_MS = 60 * 1000;

// Only logged once per day (not every 60s tick) so "not ready yet" doesn't
// spam the container logs while everyone waits for the last few pickups.
let warnedForDate = null;

function parseSendTime(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((str || '').trim());
  if (!m) return { hh: 18, mm: 0 };
  return { hh: Math.min(23, Math.max(0, Number(m[1]))), mm: Math.min(59, Math.max(0, Number(m[2]))) };
}

function nowSastHHMM() {
  // Deliberately not relying on the container's local timezone -- same
  // SAST-is-UTC+2-always convention already used throughout db.js.
  const d = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return { hh: d.getUTCHours(), mm: d.getUTCMinutes() };
}

// Attempts to send today's log by email. Never throws -- returns a result
// object describing what happened (sent, or why not), so both the 60s
// scheduler tick and the "Send now" button (an explicit force=true call)
// can use the exact same logic and just act on the result.
//
// The "everyone collected" rule is never skippable, force or not -- that's
// the one invariant this whole feature exists to enforce.
async function attemptDailySend({ force } = {}) {
  const settings = reports.getSettings();
  const date = todaySAST();

  if (!force && settings.daily_log_enabled !== 'true') {
    return { sent: false, reason: 'disabled' };
  }

  const recipients = (settings.daily_log_recipients || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: 'no_recipients' };

  if (!force && settings.daily_log_last_sent_date === date) {
    return { sent: false, reason: 'already_sent_today' };
  }

  const status = reports.dayCollectionStatus(date);
  if (!status.ready) {
    return Object.assign({ sent: false, reason: status.total === 0 ? 'no_attendance' : 'awaiting_pickups' }, status);
  }

  const csv = reports.buildCsv(reports.attendanceForDate(date));

  try {
    await mailer.sendDailyLog({ date, recipients, csv, summary: status });
  } catch (err) {
    return Object.assign({ sent: false, reason: 'send_failed', error: err.message }, status);
  }

  reports.setSetting('daily_log_last_sent_date', date);
  return Object.assign({ sent: true }, status);
}

function startScheduler() {
  setInterval(async () => {
    try {
      const settings = reports.getSettings();
      if (settings.daily_log_enabled !== 'true') return;

      const date = todaySAST();
      if (settings.daily_log_last_sent_date === date) return;

      const { hh, mm } = parseSendTime(settings.daily_log_send_time);
      const now = nowSastHHMM();
      const pastSendTime = now.hh > hh || (now.hh === hh && now.mm >= mm);
      if (!pastSendTime) return;

      const result = await attemptDailySend();

      if (result.sent) {
        console.log(`[daily-log] Sent ${date}'s log (${result.total} collected) to configured recipients.`);
        warnedForDate = null;
      } else if (result.reason === 'awaiting_pickups' || result.reason === 'no_attendance') {
        if (warnedForDate !== date) {
          console.log(`[daily-log] ${date}: not ready yet (${result.collected || 0}/${result.total || 0} collected) — will keep checking every minute.`);
          warnedForDate = date;
        }
      } else if (result.reason === 'send_failed') {
        console.error(`[daily-log] Failed to send ${date}'s log: ${result.error}`);
      } else if (result.reason === 'no_recipients' && warnedForDate !== date) {
        console.log(`[daily-log] Enabled but no recipients configured — nothing to send.`);
        warnedForDate = date;
      }
    } catch (err) {
      console.error('[daily-log] scheduler tick error:', err.message);
    }
  }, CHECK_INTERVAL_MS);
}

module.exports = { startScheduler, attemptDailySend };
