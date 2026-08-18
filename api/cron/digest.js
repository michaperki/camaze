// Daily scheduler (see vercel.json crons) — syncs provider costs into
// Supabase, then sends the digest, then checks alerts, all in one cron run.
// Runs once/day at a fixed UTC hour: Vercel Hobby cron jobs can't run more
// than once per day, so there's no per-user delivery time yet even though
// the setting exists (see api/notifications.js). The cost sync used to be
// its own cron/route (api/cron/sync-costs.js), but Hobby also caps a
// deployment at 12 serverless functions — folded in here rather than adding
// a 13th. Triggered by Vercel Cron, not a user session, so it's gated by
// CRON_SECRET instead of a JWT: Vercel automatically sends
// `Authorization: Bearer $CRON_SECRET` on cron requests when that env var
// is set, which is what's checked below.
const { listEnabledDigestUsers, listAlertEnabledUsers, listUsersWithProviderKeys } = require("../../lib/supabase");
const { sendDigestForUser } = require("../../lib/digest");
const { runAlertChecksForUser } = require("../../lib/alertRunner");
const { syncUserMonth } = require("../../lib/costSync");
const { reconcileUserMonth } = require("../../lib/reconcile");

function currentMonthStr(now) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function prevMonthStr(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return currentMonthStr(d);
}

// Syncs every connected user's provider costs into daily_costs/
// monthly_attribution/cost_sync_state (see lib/costSync.js) so api/costs.js
// can read from Postgres instead of hitting provider APIs on every
// dashboard load. Entirely independent of the digest/alerts phases below —
// a sync failure (or this whole phase throwing) must never block either of
// them, same as alerts vs. digest already don't block each other.
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

// Checks one closed month (see pickRotatingMonth) against a live fetch for
// every connected user — the guard on the whole sync layer (lib/reconcile.js).
// Deliberately last: it's the least urgent phase (nothing here is visible to
// a user in real time the way a digest/alert email is), and a slow or
// failing reconciliation run must never delay those emails going out.
async function runReconciliation() {
  const userIds = await listUsersWithProviderKeys();
  const now = new Date();
  const month = pickRotatingMonth(now, closedMonthsBack(now, 3));

  const results = await Promise.allSettled(userIds.map(userId => reconcileUserMonth(userId, month)));

  let ok = 0, drift = 0, unchecked = 0, failed = 0;
  const driftDetails = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      failed++;
      driftDetails.push({ user_id: userIds[i], month, error: r.reason.message });
      return;
    }
    for (const row of r.value.checked) {
      if (row.status === "drift") { drift++; driftDetails.push({ user_id: userIds[i], month, provider: row.provider, diff_usd: row.diff_usd }); }
      else if (row.status === "unchecked") unchecked++;
      else ok++;
    }
  });

  return { month, users: userIds.length, ok, drift, unchecked, failed, driftDetails };
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const costSync = await runCostSync().catch((err) => {
      console.warn(`Cost sync phase failed: ${err.message}`);
      return { users: 0, jobs: 0, succeeded: 0, failed: 0, errors: [{ error: err.message }] };
    });
    console.log(JSON.stringify({ event: "cost_sync_cron", ...costSync }));

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

    // Last on purpose — see runReconciliation's comment. Digest and alert
    // emails have already gone out by this point regardless of how long (or
    // how badly) this phase goes.
    const reconciliation = await runReconciliation().catch((err) => {
      console.warn(`Reconciliation phase failed: ${err.message}`);
      return { month: null, users: 0, ok: 0, drift: 0, unchecked: 0, failed: 0, driftDetails: [{ error: err.message }] };
    });
    console.log(JSON.stringify({ event: "reconciliation_cron", ...reconciliation }));

    res.status(200).json({
      ok: true,
      costSync,
      checked: due.length,
      sent,
      errors,
      alerts: { checked: alertsDue.length, sent: alertsSent, errors: alertErrors },
      reconciliation,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
