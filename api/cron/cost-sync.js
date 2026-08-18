// Cost-sync scheduler (see vercel.json crons) — runs every 15 minutes to
// keep daily_costs/monthly_attribution/cost_sync_state (lib/costSync.js)
// fresh, so api/costs.js can read from Postgres instead of hitting
// provider APIs on every dashboard load. Its own route/schedule now that
// Vercel Pro allows more than one cron and more than 12 functions — this
// used to be folded into api/cron/digest.js on Hobby. Triggered by Vercel
// Cron, not a user session, so it's gated by CRON_SECRET instead of a JWT:
// Vercel automatically sends `Authorization: Bearer $CRON_SECRET` on cron
// requests when that env var is set, which is what's checked below.
const { listUsersWithProviderKeys } = require("../../lib/supabase");
const { syncUserMonth } = require("../../lib/costSync");

function currentMonthStr(now) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function prevMonthStr(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return currentMonthStr(d);
}

async function runCostSync() {
  const userIds = await listUsersWithProviderKeys();
  const now = new Date();
  // The current month, plus the previous one for the first 5 days of a new
  // month — providers backfill/revise recent days after the fact, so a
  // month that just closed still needs a couple more syncs to settle.
  const months = [currentMonthStr(now)];
  if (now.getUTCDate() <= 5) months.push(prevMonthStr(now));

  const jobs = userIds.flatMap(userId => months.map(month => ({ userId, month })));
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

  return { users: userIds.length, jobs: jobs.length, succeeded, failed, errors };
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const costSync = await runCostSync();
    console.log(JSON.stringify({ event: "cost_sync_cron", ...costSync }));
    res.status(200).json({ ok: true, costSync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
