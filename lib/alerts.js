// Spike and budget-threshold detection. Pure functions over data
// api/costs.js already fetches — no extra provider calls, no history table
// (camaze has none yet; baselines are computed from the live 30-day window
// each run). Shared by api/cron/digest.js (the live check, which also
// writes to alert_state) and api/alerts/dryrun.js (read-only, for tuning).

// Tunable knobs, named so they're easy to find and adjust.
const SPIKE_MULTIPLIER = 3;
const SPIKE_ABSOLUTE_FLOOR_USD = 1.00;
const SPIKE_BASELINE_WINDOW_DAYS = 7;
const SPIKE_MIN_NONZERO_DAYS = 4;
const BUDGET_DEFAULT_THRESHOLD_PCT = 80;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// `dailyTotals`: [{ date, total }] ascending, contiguous — one entry per
// calendar day. `targetDate`: the day being evaluated ("yesterday" in the
// live cron check; any day in the 30-day dry-run scan). Baseline is the
// median of the up-to-7 days strictly before targetDate, so a single heavy
// day can't drag the bar up the way a mean would.
function evaluateSpike(dailyTotals, targetDate) {
  const idx = dailyTotals.findIndex(d => d.date === targetDate);
  if (idx === -1) {
    return { total: 0, baseline: null, ratio: null, wouldFire: false, reason: "no-data" };
  }
  const total = dailyTotals[idx].total;
  const window = dailyTotals.slice(Math.max(0, idx - SPIKE_BASELINE_WINDOW_DAYS), idx);
  const nonZeroCount = window.filter(d => d.total > 0).length;

  if (nonZeroCount < SPIKE_MIN_NONZERO_DAYS) {
    return { total, baseline: null, ratio: null, wouldFire: false, reason: "insufficient-baseline" };
  }

  const baseline = median(window.map(d => d.total));
  const ratio = baseline > 0 ? total / baseline : null;
  const wouldFire = total >= baseline * SPIKE_MULTIPLIER && total >= SPIKE_ABSOLUTE_FLOOR_USD;
  return { total, baseline, ratio, wouldFire, reason: wouldFire ? "spike" : "normal" };
}

// `forecast`/`budget`: dollars. `thresholdPct`: e.g. 80. Budget alerts are a
// forward-looking, single-point-in-time check (today's forecast vs. the
// monthly budget) — unlike spikes, there's no meaningful "would this have
// fired on day X" replay, since the forecast is only defined as of today.
function evaluateBudgetThreshold(forecast, budget, thresholdPct) {
  if (!budget || budget <= 0) {
    return { pct: null, wouldFire: false, reason: "no-budget" };
  }
  const pct = (forecast / budget) * 100;
  const wouldFire = pct >= thresholdPct;
  return { pct, wouldFire, reason: wouldFire ? "budget" : "under-threshold" };
}

// Reduces the per-provider `days` array from fetchAllCosts() into a plain
// [{ date, total }] series, and separately finds which provider/model drove
// a given day's spend — used to make alert copy concrete ("Anthropic
// accounted for $7.90 of it") instead of just stating a number.
function dailyTotals(days, providerNames) {
  return days.map(d => ({
    date: d.date,
    total: providerNames.reduce((sum, name) => sum + (d[name] || 0), 0),
  }));
}

// { providerLabel, amount, modelLabel } for whichever provider/model
// contributed the most on `date`, or null if there's no data for that day.
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
    .filter(m => m.date === date && m.amount_usd > 0)
    .sort((a, b) => b.amount_usd - a.amount_usd)[0];

  return { ...topProvider, modelLabel: topModel ? topModel.model : null };
}

module.exports = {
  SPIKE_MULTIPLIER,
  SPIKE_ABSOLUTE_FLOOR_USD,
  SPIKE_BASELINE_WINDOW_DAYS,
  SPIKE_MIN_NONZERO_DAYS,
  BUDGET_DEFAULT_THRESHOLD_PCT,
  evaluateSpike,
  evaluateBudgetThreshold,
  dailyTotals,
  topDriver,
};
