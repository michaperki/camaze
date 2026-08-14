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
// (decrypt error, one bad row) just yields fewer overrides for that provider.
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

// `allowEnvFallback`: local dev only (no SUPABASE_SERVICE_ROLE_KEY) — lets a
// provider with no stored override fall back to its env var, same as before
// per-user keys existed. In production, a provider with no override is
// reported as not connected rather than silently trying env vars.
async function fetchAllCosts(overrides, allowEnvFallback) {
  // Last 30 full days plus today, snapped to midnight UTC.
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));

  const settled = await Promise.allSettled(providers.map(p => {
    const override = overrides[p.name];
    if (!override && !allowEnvFallback) {
      return Promise.reject(new Error("Not connected — add a key on the Integrations page."));
    }
    return p.fetchCosts(start, override);
  }));

  const errors = {};
  const byDay = new Map(); // date -> { anthropic: usd, openai: usd, ... }
  const totals = { combined: 0 };
  for (const p of providers) totals[p.name] = 0;
  const modelTotals = new Map(); // "provider:model" -> { provider, model, amount_usd }

  settled.forEach((result, i) => {
    const p = providers[i];
    if (result.status === "rejected") {
      errors[p.name] = result.reason.message;
      return;
    }
    const { days: providerDays, models: providerModels } = result.value;

    for (const { date, amount_usd } of providerDays) {
      if (!Number.isFinite(amount_usd)) {
        console.warn(`Ignoring non-finite amount from ${p.name} on ${date}: ${amount_usd}`);
        continue;
      }
      if (!byDay.has(date)) byDay.set(date, {});
      byDay.get(date)[p.name] = (byDay.get(date)[p.name] || 0) + amount_usd;
      totals[p.name] += amount_usd;
      totals.combined += amount_usd;
    }

    for (const { model, amount_usd } of providerModels || []) {
      if (!model || !Number.isFinite(amount_usd)) continue;
      const key = `${p.name}:${model}`;
      const existing = modelTotals.get(key);
      if (existing) existing.amount_usd += amount_usd;
      else modelTotals.set(key, { provider: p.name, model, amount_usd });
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

  // Drop noise: flat recurring subscriptions (e.g. Google's "Gemini Code
  // Assist monthly subscription") aren't per-token model usage, and rows
  // under a cent are clutter, not signal.
  const models = [...modelTotals.values()]
    .filter(m => m.amount_usd >= 0.01 && !/subscription/i.test(m.model))
    .sort((a, b) => b.amount_usd - a.amount_usd);

  return {
    providers: providers.map(p => ({ name: p.name, label: p.label, failed: p.name in errors })),
    days,
    totals,
    errors,
    models,
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
// Keyed per user (or "env" for anonymous/env-var requests) — a shared cache
// would otherwise serve one user's provider totals to another.
const cache = new Map(); // cacheKey -> { data, fetchedAt }

module.exports = async (req, res) => {
  try {
    // Local dev without a service role key can't look up per-user keys at
    // all, so it keeps behaving like the pre-auth env-var-only setup.
    const localDevFallback = !process.env.SUPABASE_SERVICE_ROLE_KEY;
    const user = await verifyUser(req.headers.authorization).catch(() => null);
    const cacheKey = user?.id || "env";
    // Set by the dashboard right after a key was connected/disconnected on
    // Integrations, so that change shows up immediately instead of waiting
    // out a cached response computed from the old set of keys.
    const forceRefresh = req.query?.refresh === "1";

    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (!forceRefresh && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      res.status(200).json({ ...cached.data, cached: true, cachedAt: new Date(cached.fetchedAt).toISOString() });
      return;
    }

    const overrides = localDevFallback ? {} : await resolveOverrides(user?.id);

    if (!localDevFallback && Object.keys(overrides).length === 0) {
      // Nothing connected, nothing to fetch — and deliberately not cached,
      // so connecting a key on Integrations shows up on the next load
      // instead of waiting out a stale "no keys" response.
      res.status(200).json({
        no_keys: true,
        providers: [],
        days: [],
        totals: { combined: 0 },
        errors: {},
        models: [],
        cached: false,
        cachedAt: new Date(now).toISOString(),
      });
      return;
    }

    const data = await fetchAllCosts(overrides, localDevFallback);
    cache.set(cacheKey, { data, fetchedAt: now });
    res.status(200).json({ ...data, cached: false, cachedAt: new Date(now).toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
