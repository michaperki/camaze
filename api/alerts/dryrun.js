// Read-only spike-detection preview over the last 30 days of real data —
// lets you tune SPIKE_MULTIPLIER/SPIKE_ABSOLUTE_FLOOR_USD (lib/alerts.js)
// against actual history and demo the detector without waiting for a live
// spike. Never sends anything and never touches alert_state. Same JWT auth
// pattern as the other endpoints.
const { verifyUser } = require("../../lib/supabase");
const { resolveOverrides, fetchAllCosts } = require("../../lib/costs");
const { evaluateSpike, dailyTotals } = require("../../lib/alerts");

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
    const overrides = await resolveOverrides(user.id);
    if (Object.keys(overrides).length === 0) {
      res.status(200).json([]);
      return;
    }

    const costData = await fetchAllCosts(overrides, false);
    const providerNames = costData.providers.map(p => p.name);
    const totals = dailyTotals(costData.days, providerNames);

    const results = totals.map(({ date }) => {
      const { total, baseline, ratio, wouldFire, reason } = evaluateSpike(totals, date);
      return { date, total, baseline, ratio, wouldFire, reason };
    });

    res.status(200).json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
