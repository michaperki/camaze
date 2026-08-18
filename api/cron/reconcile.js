// Reconciliation scheduler (see vercel.json crons) — daily. Its own
// route/schedule now that Vercel Pro allows more than one cron and more
// than 12 functions — this used to share an invocation with cost sync,
// digest, and alerts on Hobby (see api/cron/cost-sync.js, digest.js,
// alerts.js). Now that it isn't sharing an invocation with anything else,
// there's no per-run user cap — every connected user is checked every run.
// Still sequential with a delay between users, though: that was about
// provider rate limits (concurrent reconciliation fanning out on top of
// the sync phase's own fan-out tripped OpenAI's 30-requests/minute limit
// during the initial backfill), and those limits are unrelated to Vercel's
// plan and haven't changed. Triggered by Vercel Cron, not a user session,
// so it's gated by CRON_SECRET instead of a JWT: Vercel automatically
// sends `Authorization: Bearer $CRON_SECRET` on cron requests when that
// env var is set, which is what's checked below.
const { listUsersWithProviderKeys } = require("../../lib/supabase");
const { reconcileUserMonth } = require("../../lib/reconcile");

function currentMonthStr(now) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Picks 1 of the last `count` closed months, rotating by one slot per day —
// deterministic (no state to persist) and the same for every user on a
// given day, so over `count` days each closed month gets checked roughly
// once. Current month excluded: reconciliation only makes sense once a
// month is final.
function closedMonthsBack(now, count) {
  const months = [];
  for (let i = 1; i <= count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(currentMonthStr(d));
  }
  return months;
}

function pickRotatingMonth(now, months) {
  const dayIndex = Math.floor(now.getTime() / 86400000);
  return months[dayIndex % months.length];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const RECONCILE_USER_DELAY_MS = 2000;

// Checks one closed month (see pickRotatingMonth) against a live fetch for
// every connected user — the guard on the whole sync layer (lib/reconcile.js).
// Sequential with a delay between users, not concurrent, to stay under
// provider rate limits (see file header).
async function runReconciliation() {
  const userIds = await listUsersWithProviderKeys();
  const now = new Date();
  const month = pickRotatingMonth(now, closedMonthsBack(now, 3));

  let ok = 0, drift = 0, unchecked = 0, failed = 0;
  const driftDetails = [];
  for (let i = 0; i < userIds.length; i++) {
    const userId = userIds[i];
    try {
      const result = await reconcileUserMonth(userId, month);
      for (const row of result.checked) {
        if (row.status === "drift") { drift++; driftDetails.push({ user_id: userId, month, provider: row.provider, diff_usd: row.diff_usd }); }
        else if (row.status === "unchecked") unchecked++;
        else ok++;
      }
    } catch (err) {
      failed++;
      driftDetails.push({ user_id: userId, month, error: err.message });
    }
    if (i < userIds.length - 1) await sleep(RECONCILE_USER_DELAY_MS);
  }

  return { month, usersChecked: userIds.length, ok, drift, unchecked, failed, driftDetails };
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const reconciliation = await runReconciliation();
    console.log(JSON.stringify({ event: "reconciliation_cron", ...reconciliation }));
    res.status(200).json({ ok: true, reconciliation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
