// Digest scheduler (see vercel.json crons) — daily, unchanged. Its own
// route/schedule now that Vercel Pro allows more than one cron and more
// than 12 functions — this used to also run cost sync, alerts, and
// reconciliation in the same invocation on Hobby (see api/cron/cost-sync.js,
// api/cron/alerts.js, api/cron/reconcile.js). Still runs once/day at a
// fixed UTC hour, so there's no per-user delivery time yet even though the
// setting exists (see api/notifications.js). Triggered by Vercel Cron, not
// a user session, so it's gated by CRON_SECRET instead of a JWT: Vercel
// automatically sends `Authorization: Bearer $CRON_SECRET` on cron
// requests when that env var is set, which is what's checked below.
const { listEnabledDigestUsers } = require("../../lib/supabase");
const { sendDigestForUser } = require("../../lib/digest");

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

    res.status(200).json({ ok: true, checked: due.length, sent, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
