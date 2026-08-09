const nodemailer = require('nodemailer');

// Fully optional -- if SMTP isn't configured in .env, the app still runs
// fine, the daily-log feature just can't send (surfaced via /api/daily-log/status's
// smtp_configured flag rather than crashing anything).
function configured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!configured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      // Most providers (Gmail, Office365, SendGrid SMTP) use STARTTLS on
      // 587 -- SMTP_SECURE=true is only for a legacy implicit-TLS port
      // like 465.
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return transporter;
}

async function sendDailyLog({ date, recipients, csv, summary }) {
  const t = getTransporter();
  if (!t) throw new Error('SMTP is not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS in .env)');

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const plural = summary.total === 1 ? '' : 'ren';
  await t.sendMail({
    from,
    to: recipients.join(', '),
    subject: `Howick Aftercare — today's log (${date})`,
    text:
      `Attached: the aftercare sign-in/sign-out log for ${date}.\n\n` +
      `${summary.total} child${plural} attended aftercare today, all collected.\n\n` +
      `This was sent automatically once every child checked in today had been collected.`,
    attachments: [{ filename: `aftercare-attendance-${date}.csv`, content: csv }]
  });
}

module.exports = { configured, sendDailyLog };
