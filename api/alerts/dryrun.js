// Read-only spike-detection preview over the last 30 days of real data —
// lets you tune the four constants in lib/alerts.js against actual history
// and demo the detector without waiting for a live spike. Never sends
// anything and never touches alert_state. Same JWT auth pattern as the
// other endpoints.
//
// Accepts optional query params to override the four constants for this
// call only (never persisted): ?multiplier=4&floor=1.5&minBaseline=0.5&wake=2
const { verifyUser } = require("../../lib/supabase");
const { resolveOverrides, fetchAllCosts } = require("../../lib/costs");
const {
  evaluateSpike,
  dailyUsage,
  SPIKE_MULTIPLIER,
  ABSOLUTE_FLOOR,
  MIN_BASELINE,
  WAKE_THRESHOLD,
} = require("../../lib/alerts");

// Falls back to the module default for anything absent, non-numeric, or
// negative — a malformed query param should never crash the endpoint.
function overrideOrDefault(value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

module.exports = async (req, res) => {
  const user = await verifyUser(req.headers.authorization).catch(() => null);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const constants = {
      SPIKE_MULTIPLIER: overrideOrDefault(req.query?.multiplier, SPIKE_MULTIPLIER),
      ABSOLUTE_FLOOR: overrideOrDefault(req.query?.floor, ABSOLUTE_FLOOR),
      MIN_BASELINE: overrideOrDefault(req.query?.minBaseline, MIN_BASELINE),
      WAKE_THRESHOLD: overrideOrDefault(req.query?.wake, WAKE_THRESHOLD),
    };

    const overrides = await resolveOverrides(user.id);
    if (Object.keys(overrides).length === 0) {
      res.status(200).json({ constants, days: [] });
      return;
    }

    const costData = await fetchAllCosts(overrides, false);
    const usageSeries = dailyUsage(costData.days);

    const days = costData.days.map((d) => {
      const spike = evaluateSpike(usageSeries, d.date, constants);
      return {
        date: d.date,
        usage_usd: d.usage_usd,
        subscription_usd: d.subscription_usd,
        baseline: spike.baseline,
        ratio: spike.ratio,
        mode: spike.mode,
        wouldFire: spike.wouldFire,
        reason: spike.reason,
      };
    });

    res.status(200).json({ constants, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
