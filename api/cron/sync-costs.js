// Syncs every connected user's provider costs into Supabase (see
// lib/costSync.js) so api/costs.js can read from Postgres instead of
// hitting provider APIs on every dashboard load. Triggered by Vercel Cron,
// not a user session — gated by CRON_SECRET, same as api/cron/digest.js.
const { listUsersWithProviderKeys } = require("../../lib/supabase");
const { syncUserMonth } = require("../../lib/costSync");

function currentMonthStr(now) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function prevMonthStr(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return currentMonthStr(d);
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const userIds = await listUsersWithProviderKeys();
    const now = new Date();
    // The current month, plus the previous one for the first 5 days of a
    // new month — providers backfill/revise recent days after the fact, so
    // a month that just closed still needs a couple more syncs to settle.
    const months = [currentMonthStr(now)];
    if (now.getUTCDate() <= 5) months.push(prevMonthStr(now));

    const jobs = userIds.flatMap(userId => months.map(month => ({ userId, month })));
    // Each (user, month) sync is independent — one user's failure (or one
    // provider's, inside syncUserMonth) must never stop the run.
    const results = await Promise.allSettled(jobs.map(j => syncUserMonth(j.userId, j.month)));

    let succeeded = 0, failed = 0;
    const errors = [];
    results.forEach((r, i) => {
      const { userId, month } = jobs[i];
      if (r.status === "fulfilled" && r.value.status !== "error") {
        succeeded++;
      } else {
        failed++;
        errors.push({ user_id: userId, month, error: r.status === "fulfilled" ? r.value.errors : r.reason.message });
      }
    });

    const summary = { ok: true, users: userIds.length, jobs: jobs.length, succeeded, failed, errors };
    console.log(JSON.stringify({ event: "cost_sync_cron", ...summary }));
    res.status(200).json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
