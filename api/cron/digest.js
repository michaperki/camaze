// Daily scheduler (see vercel.json crons) — sends the digest to every user
// with it enabled. Runs once/day at a fixed UTC hour: Vercel Hobby cron
// jobs can't run more than once per day, so there's no per-user delivery
// time yet even though the setting exists (see api/notifications.js).
// Triggered by Vercel Cron, not a user session, so it's gated by
// CRON_SECRET instead of a JWT: Vercel automatically sends
// `Authorization: Bearer $CRON_SECRET` on cron requests when that env var
// is set, which is what's checked below.
const { listEnabledDigestUsers, listAlertEnabledUsers } = require("../../lib/supabase");
const { sendDigestForUser } = require("../../lib/digest");
const { runAlertChecksForUser } = require("../../lib/alertRunner");

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const due = await listEnabledDigestUsers();

    const results = await Promise.allSettled(due.map(row => sendDigestForUser(row.user_id)));
    const sent = results.filter(r => r.status === "fulfilled").length;
    const errors = results
      .map((r, i) => (r.status === "rejected" ? { user_id: due[i].user_id, error: r.reason.message } : null))
      .filter(Boolean);

    // Rides the same once-a-day cron run (Vercel Hobby allows only one),
    // but is a fully separate pass over a separate user list — a user can
    // have alerts on with the digest off, or vice versa. Independent
    // try/catch per user, and independent from the digest loop above, so an
    // alert-check failure (or an alert email failure) can never prevent the
    // digest from sending.
    const alertsDue = await listAlertEnabledUsers().catch((err) => {
      console.warn(`Could not load alert-enabled users: ${err.message}`);
      return [];
    });
    const alertResults = await Promise.allSettled(alertsDue.map(row => runAlertChecksForUser(row.user_id, {
      spikeEnabled: row.spike_alerts_enabled,
      budgetEnabled: row.budget_alerts_enabled,
    })));
    const alertsSent = alertResults.reduce((n, r) => n + (r.status === "fulfilled" ? r.value.sent.length : 0), 0);
    const alertErrors = alertResults
      .map((r, i) => (r.status === "rejected" ? { user_id: alertsDue[i].user_id, error: r.reason.message } : null))
      .filter(Boolean);

    res.status(200).json({
      ok: true,
      checked: due.length,
      sent,
      errors,
      alerts: { checked: alertsDue.length, sent: alertsSent, errors: alertErrors },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
