// camaze — minimal AI spend tracker.
// Vercel serverless function: proxies each provider's cost API so keys stay server-side.
const cryptoLib = require("../lib/crypto");
const { verifyUser, getAllProviderKeys } = require("../lib/supabase");

const providers = [
  require("../providers/anthropic"),
  require("../providers/openai"),
  require("../providers/google"),
];

// Loads and decrypts the logged-in user's stored provider keys into the
// per-provider override shape each fetchCosts() accepts. Any failure here
// (not configured, decrypt error, one bad row) just yields fewer overrides
// — those providers then fall back to env vars like an anonymous request.
async function resolveOverrides(userId) {
  const overrides = {};
  if (!userId) return overrides;

  let rows;
  try {
    rows = await getAllProviderKeys(userId);
  } catch (e) {
    console.warn(`Could not load user provider keys: ${e.message}`);
    return overrides;
  }

  for (const row of rows) {
    try {
      const plaintext = cryptoLib.decrypt(row.encrypted_data);
      overrides[row.provider] = row.provider === "google" ? JSON.parse(plaintext) : plaintext;
    } catch (e) {
      console.warn(`Could not decrypt stored key for ${row.provider}: ${e.message}`);
    }
  }
  return overrides;
}

async function fetchAllCosts(overrides) {
  // Last 30 full days plus today, snapped to midnight UTC.
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));

  const settled = await Promise.allSettled(providers.map(p => p.fetchCosts(start, overrides[p.name])));

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
// Keyed per user (or "env" for anonymous/env-var requests) — a shared cache
// would otherwise serve one user's provider totals to another.
const cache = new Map(); // cacheKey -> { data, fetchedAt }

module.exports = async (req, res) => {
  try {
    const user = await verifyUser(req.headers.authorization).catch(() => null);
    const cacheKey = user?.id || "env";

    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      res.status(200).json({ ...cached.data, cached: true, cachedAt: new Date(cached.fetchedAt).toISOString() });
      return;
    }

    const overrides = await resolveOverrides(user?.id);
    const data = await fetchAllCosts(overrides);
    cache.set(cacheKey, { data, fetchedAt: now });
    res.status(200).json({ ...data, cached: false, cachedAt: new Date(now).toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
