// Spike and budget-threshold detection. Pure functions over data
// api/costs.js already fetches — no extra provider calls, no history table
// (camaze has none yet; baselines are computed from the live 30-day window
// each run). Shared by api/cron/digest.js (the live check, which also
// writes to alert_state) and api/alerts/dryrun.js (read-only, for tuning).
const { isSubscriptionLine } = require("./costs");

// Tunable knobs, named so they're easy to find and adjust. All four are
// overridable per-call by api/alerts/dryrun.js (query params), never
// persisted — the live cron path always uses these defaults.
const SPIKE_MULTIPLIER = 3;
const ABSOLUTE_FLOOR = 1.00;
const MIN_BASELINE = 0.50;
const WAKE_THRESHOLD = 1.00;
const SPIKE_BASELINE_WINDOW_DAYS = 7;
const BUDGET_DEFAULT_THRESHOLD_PCT = 80;

const DEFAULT_SPIKE_CONSTANTS = { SPIKE_MULTIPLIER, ABSOLUTE_FLOOR, MIN_BASELINE, WAKE_THRESHOLD };

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// `dailyUsage`: [{ date, usage_usd }] ascending, contiguous — one entry per
// calendar day, usage only (subscriptions excluded — see lib/costs.js).
// `targetDate`: the day being evaluated ("yesterday" in the live cron
// check; any day in the 30-day dry-run scan).
//
// Two modes, chosen by whether the trailing baseline is even meaningful:
//   - ratio mode (baseline >= MIN_BASELINE): fire on a multiple of the
//     trailing 7-day median, same idea as before.
//   - absolute mode (baseline < MIN_BASELINE, including exactly zero, or no
//     prior days at all): a ratio against a near-zero baseline is
//     meaningless (or undefined at zero), so fire on any meaningful amount
//     of spend at all — this is what catches spend resuming after a quiet
//     stretch, which a "need 4 non-zero baseline days" guard used to skip
//     over backwards (treating the quietest, most notable case as
//     unmeasurable instead of exactly the case worth flagging).
function evaluateSpike(dailyUsage, targetDate, constants = DEFAULT_SPIKE_CONSTANTS) {
  const { SPIKE_MULTIPLIER: multiplier, ABSOLUTE_FLOOR: floor, MIN_BASELINE: minBaseline, WAKE_THRESHOLD: wake } = constants;

  const idx = dailyUsage.findIndex(d => d.date === targetDate);
  if (idx === -1) {
    return { usage: 0, baseline: null, ratio: null, mode: null, wouldFire: false, reason: "no-data" };
  }
  const usage = dailyUsage[idx].usage_usd;
  const window = dailyUsage.slice(Math.max(0, idx - SPIKE_BASELINE_WINDOW_DAYS), idx);
  const baseline = median(window.map(d => d.usage_usd));

  if (baseline >= minBaseline) {
    const ratio = usage / baseline;
    const wouldFire = usage >= baseline * multiplier && usage >= floor;
    return { usage, baseline, ratio, mode: "ratio", wouldFire, reason: wouldFire ? "spike" : "normal" };
  }

  const wouldFire = usage >= wake;
  return { usage, baseline, ratio: null, mode: "absolute", wouldFire, reason: wouldFire ? "resumed-after-quiet" : "normal" };
}

// `forecast`/`budget`: dollars, full projected bill (usage + subscriptions
// — see lib/costs.js's buildSummary). `thresholdPct`: e.g. 80. Budget
// alerts are a forward-looking, single-point-in-time check (today's
// forecast vs. the monthly budget) — unlike spikes, there's no meaningful
// "would this have fired on day X" replay, since the forecast is only
// defined as of today.
function evaluateBudgetThreshold(forecast, budget, thresholdPct) {
  if (!budget || budget <= 0) {
    return { pct: null, wouldFire: false, reason: "no-budget" };
  }
  const pct = (forecast / budget) * 100;
  const wouldFire = pct >= thresholdPct;
  return { pct, wouldFire, reason: wouldFire ? "budget" : "under-threshold" };
}

// [{ date, usage_usd }] view of fetchAllCosts()'s `days` — what the spike
// detector operates on.
function dailyUsage(days) {
  return days.map(d => ({ date: d.date, usage_usd: d.usage_usd }));
}

// { providerLabel, amount, modelLabel } for whichever provider/model
// contributed the most usage on `date`, or null if there's no data for that
// day. Provider amounts come from `days` (already usage-only); the model
// pick excludes subscription lines — a flat monthly charge can't spike, so
// it can never be "what drove" a spike.
function topDriver(costData, date) {
  const dayEntry = costData.days.find(d => d.date === date);
  if (!dayEntry) return null;

  let topProvider = null;
  for (const p of costData.providers) {
    const amount = dayEntry[p.name] || 0;
    if (amount > 0 && (!topProvider || amount > topProvider.amount)) {
      topProvider = { providerLabel: p.label, amount };
    }
  }
  if (!topProvider) return null;

  const topModel = costData.dayModels
    .filter(m => m.date === date && m.amount_usd > 0 && !isSubscriptionLine(m.model))
    .sort((a, b) => b.amount_usd - a.amount_usd)[0];

  return { ...topProvider, modelLabel: topModel ? topModel.model : null };
}

module.exports = {
  SPIKE_MULTIPLIER,
  ABSOLUTE_FLOOR,
  MIN_BASELINE,
  WAKE_THRESHOLD,
  SPIKE_BASELINE_WINDOW_DAYS,
  BUDGET_DEFAULT_THRESHOLD_PCT,
  evaluateSpike,
  evaluateBudgetThreshold,
  dailyUsage,
  topDriver,
};
