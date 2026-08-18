// Alert-check scheduler (see vercel.json crons) — daily for now, same
// cadence as before. This changes once real anomaly alerts are built (see
// lib/alertRunner.js). Its own route/schedule now that Vercel Pro allows
// more than one cron and more than 12 functions — this used to be folded
// into api/cron/digest.js on Hobby. Triggered by Vercel Cron, not a user
// session, so it's gated by CRON_SECRET instead of a JWT: Vercel
// automatically sends `Authorization: Bearer $CRON_SECRET` on cron
// requests when that env var is set, which is what's checked below.
const { listAlertEnabledUsers } = require("../../lib/supabase");
const { runAlertChecksForUser } = require("../../lib/alertRunner");

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const alertsDue = await listAlertEnabledUsers();
    const alertResults = await Promise.allSettled(alertsDue.map(row => runAlertChecksForUser(row.user_id, {
      spikeEnabled: row.spike_alerts_enabled,
      budgetEnabled: row.budget_alerts_enabled,
    })));
    const sent = alertResults.reduce((n, r) => n + (r.status === "fulfilled" ? r.value.sent.length : 0), 0);
    const errors = alertResults
      .map((r, i) => (r.status === "rejected" ? { user_id: alertsDue[i].user_id, error: r.reason.message } : null))
      .filter(Boolean);

    res.status(200).json({ ok: true, checked: alertsDue.length, sent, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
