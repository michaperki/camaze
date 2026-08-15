// Runs the spike + budget-threshold check for one user: pulls the same cost
// data api/costs.js and lib/digest.js already compute, evaluates both
// detectors, and — for whichever would fire — claims a slot in alert_state
// and sends the alert email. A failed claim (already sent this month/day, or
// a concurrent/retried cron run beat us to it) means "don't send", not an
// error. No provider keys connected means no data to alert on, so it's a
// silent no-op rather than the error lib/digest.js throws in that case.
const { resolveOverrides, fetchAllCosts, buildSummary } = require("./costs");
const { getUserById, getUserSettings, claimAlert } = require("./supabase");
const {
  evaluateSpike,
  evaluateBudgetThreshold,
  dailyUsage,
  topDriver,
  BUDGET_DEFAULT_THRESHOLD_PCT,
} = require("./alerts");
const { renderSpikeAlert, renderBudgetAlert, sendAlertEmail } = require("./alertEmail");

async function runAlertChecksForUser(userId, { spikeEnabled, budgetEnabled }) {
  if (!spikeEnabled && !budgetEnabled) return { sent: [] };

  const user = await getUserById(userId);
  if (!user?.email) throw new Error("Could not resolve the user's email address");

  const [overrides, settings] = await Promise.all([
    resolveOverrides(userId),
    getUserSettings(userId),
  ]);
  if (Object.keys(overrides).length === 0) return { sent: [] };

  const costData = await fetchAllCosts(overrides, false);
  const usageSeries = dailyUsage(costData.days);

  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const dateStr = yesterday.toISOString().slice(0, 10);
  const monthKey = now.toISOString().slice(0, 7);

  const sent = [];

  if (spikeEnabled) {
    const spike = evaluateSpike(usageSeries, dateStr);
    if (spike.wouldFire) {
      const claimed = await claimAlert(userId, `spike:${dateStr}`);
      if (claimed) {
        const driver = topDriver(costData, dateStr);
        const email = renderSpikeAlert({
          dateStr, usage: spike.usage, baseline: spike.baseline, ratio: spike.ratio, mode: spike.mode, driver,
        });
        await sendAlertEmail(user.email, email);
        sent.push("spike");
      }
    }
  }

  const budget = settings?.monthly_budget;
  if (budgetEnabled && budget > 0) {
    const summary = buildSummary(costData.days, budget);
    const thresholdPct = settings?.alert_threshold ?? BUDGET_DEFAULT_THRESHOLD_PCT;
    const budgetEval = evaluateBudgetThreshold(summary.forecast, budget, thresholdPct);
    if (budgetEval.wouldFire) {
      const claimed = await claimAlert(userId, `budget:${thresholdPct}:${monthKey}`);
      if (claimed) {
        const email = renderBudgetAlert({
          forecast: summary.forecast, budget, pct: budgetEval.pct, thresholdPct,
        });
        await sendAlertEmail(user.email, email);
        sent.push("budget");
      }
    }
  }

  return { sent };
}

module.exports = { runAlertChecksForUser };
