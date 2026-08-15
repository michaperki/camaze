// Hourly scheduler (see vercel.json crons) — sends the daily digest to
// every user whose digest_hour matches the current UTC hour. Triggered by
// Vercel Cron, not a user session, so it's gated by CRON_SECRET instead of
// a JWT: Vercel automatically sends `Authorization: Bearer $CRON_SECRET` on
// cron requests when that env var is set, which is what's checked below.
const { listDueDigestUsers } = require("../../lib/supabase");
const { sendDigestForUser } = require("../../lib/digest");

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const hour = new Date().getUTCHours();
    const due = await listDueDigestUsers(hour);

    const results = await Promise.allSettled(due.map(row => sendDigestForUser(row.user_id)));
    const sent = results.filter(r => r.status === "fulfilled").length;
    const errors = results
      .map((r, i) => (r.status === "rejected" ? { user_id: due[i].user_id, error: r.reason.message } : null))
      .filter(Boolean);

    res.status(200).json({ ok: true, hour, checked: due.length, sent, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
