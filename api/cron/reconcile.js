// Reconciliation scheduler (see vercel.json crons) — daily at 10:00 UTC,
// an hour after digest/alerts so all three don't fire concurrently against
// the same provider APIs for the same users now that Pro crons fire within
// the minute rather than spread across the hour. Its own route/schedule
// now that Vercel Pro allows more than one cron and more than 12
// functions — this used to share an invocation with cost sync, digest,
// and alerts on Hobby (see api/cron/cost-sync.js, digest.js, alerts.js).
//
// No per-run user cap — every connected user is due to be checked every
// run — but that's uncapped against a fixed 300s ceiling (maxDuration,
// vercel.json) with a 2s delay per user (see RECONCILE_USER_DELAY_MS
// below), which silently truncates somewhere around 150 users. Instead of
// capping, this tracks elapsed time and stops cleanly with margin to spare
// (see TIME_BUDGET_MS), logs whoever wasn't reached, and persists a cursor
// (lib/reconcile.js's reconciliation_cursor row) so the next run resumes
// this same month from that point rather than restarting from the top or
// letting the daily month-rotation move on early. Still sequential with a
// delay between users: that was about provider rate limits (concurrent
// reconciliation fanning out on top of the sync phase's own fan-out
// tripped OpenAI's 30-requests/minute limit during the initial backfill),
// and those limits are unrelated to Vercel's plan and haven't changed.
//
// Triggered by Vercel Cron, not a user session, so it's gated by
// CRON_SECRET instead of a JWT: Vercel automatically sends
// `Authorization: Bearer $CRON_SECRET` on cron requests when that env var
// is set, which is what's checked below.
const { listUsersWithProviderKeys } = require("../../lib/supabase");
const { reconcileUserMonth, getReconciliationCursor, setReconciliationCursor } = require("../../lib/reconcile");

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

// Budget under the 300s maxDuration (vercel.json), not the ceiling itself —
// leaves ~30s margin for listing users, the cursor read/write, and the
// in-flight user's own reconcileUserMonth() call (checked before starting
// a user, not interrupted mid-call, so the actual run can run slightly
// past this).
const TIME_BUDGET_MS = 270 * 1000;

// Checks one closed month (see pickRotatingMonth) against a live fetch for
// every connected user — the guard on the whole sync layer (lib/reconcile.js).
// Sequential with a delay between users, not concurrent, to stay under
// provider rate limits (see file header).
//
// If a previous run ran out of time budget mid-list, its cursor names the
// same month and the last user_id it finished — that month stays the
// target (overriding the day's normal rotation pick) and the list picks up
// right after that user, in the same stable sort order, until the whole
// month is caught up. Only once a month finishes in one run (or a resumed
// run finally reaches the end of its list) does rotation move on.
async function runReconciliation() {
  const startedAt = Date.now();
  const allUserIds = await listUsersWithProviderKeys();
  const sorted = [...allUserIds].sort();

  const cursor = await getReconciliationCursor();
  const resuming = !!(cursor && cursor.month);
  const month = resuming ? cursor.month : pickRotatingMonth(new Date(), closedMonthsBack(new Date(), 3));
  const userIds = resuming && cursor.lastUserId ? sorted.filter(id => id > cursor.lastUserId) : sorted;

  let ok = 0, drift = 0, unchecked = 0, failed = 0;
  const driftDetails = [];
  // Only ever moves past a user whose reconciliation actually completed —
  // a user whose check threw stays un-advanced-past so a truncated run
  // retries them next time instead of silently counting them as done.
  let lastCompleted = resuming ? cursor.lastUserId : null;
  let i = 0;
  for (; i < userIds.length; i++) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    const userId = userIds[i];
    try {
      const result = await reconcileUserMonth(userId, month);
      for (const row of result.checked) {
        if (row.status === "drift") { drift++; driftDetails.push({ user_id: userId, month, provider: row.provider, diff_usd: row.diff_usd }); }
        else if (row.status === "unchecked") unchecked++;
        else ok++;
      }
      lastCompleted = userId;
    } catch (err) {
      failed++;
      driftDetails.push({ user_id: userId, month, error: err.message });
    }
    if (i < userIds.length - 1) await sleep(RECONCILE_USER_DELAY_MS);
  }

  const remaining = userIds.slice(i);
  if (remaining.length > 0) {
    await setReconciliationCursor(month, lastCompleted);
    console.log(JSON.stringify({ event: "reconciliation_truncated", month, remaining_count: remaining.length, remaining }));
  } else if (resuming) {
    // Only clear when a cursor actually existed — a same-day run that
    // finishes without ever having resumed never wrote one.
    await setReconciliationCursor(null, null);
  }

  return {
    month, resumed: resuming, usersTotal: sorted.length, usersChecked: i,
    truncated: remaining.length > 0, remaining: remaining.length,
    ok, drift, unchecked, failed, driftDetails,
  };
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
