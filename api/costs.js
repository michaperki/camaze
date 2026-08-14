// camaze — minimal AI spend tracker.
// Vercel serverless function: proxies each provider's cost API so keys stay server-side.
const providers = [
  require("../providers/anthropic"),
  require("../providers/openai"),
  require("../providers/google"),
];

async function fetchAllCosts() {
  // Last 30 full days plus today, snapped to midnight UTC.
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));

  const settled = await Promise.allSettled(providers.map(p => p.fetchCosts(start)));

  const errors = {};
  const byDay = new Map(); // date -> { anthropic: usd, openai: usd, ... }
  const totals = { combined: 0 };
  for (const p of providers) totals[p.name] = 0;

  settled.forEach((result, i) => {
    const p = providers[i];
    if (result.status === "rejected") {
      errors[p.name] = result.reason.message;
      return;
    }
    for (const { date, amount_usd } of result.value) {
      if (!Number.isFinite(amount_usd)) {
        console.warn(`Ignoring non-finite amount from ${p.name} on ${date}: ${amount_usd}`);
        continue;
      }
      if (!byDay.has(date)) byDay.set(date, {});
      byDay.get(date)[p.name] = (byDay.get(date)[p.name] || 0) + amount_usd;
      totals[p.name] += amount_usd;
      totals.combined += amount_usd;
    }
  });

  // Continuous 31-day axis, zero-filled per provider.
  const days = [];
  for (let d = new Date(start); d <= now; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const entry = { date };
    for (const p of providers) entry[p.name] = byDay.get(date)?.[p.name] || 0;
    days.push(entry);
  }

  return {
    providers: providers.map(p => ({ name: p.name, label: p.label, failed: p.name in errors })),
    days,
    totals,
    errors,
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null; // { data, fetchedAt }

module.exports = async (req, res) => {
  try {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      res.status(200).json({ ...cache.data, cached: true, cachedAt: new Date(cache.fetchedAt).toISOString() });
      return;
    }

    const data = await fetchAllCosts();
    cache = { data, fetchedAt: now };
    res.status(200).json({ ...data, cached: false, cachedAt: new Date(now).toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
