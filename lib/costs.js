// Shared cost-computation core, used by both api/costs.js (the dashboard)
// and lib/digest.js (the daily email) so the two never drift apart on what
// "this user's spend" means.
const cryptoLib = require("./crypto");
const { getAllProviderKeys, getUserSettings } = require("./supabase");

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
  const dayModelTotals = new Map(); // "date|provider|model" -> { date, provider, model, amount_usd }

  settled.forEach((result, i) => {
    const p = providers[i];
    if (result.status === "rejected") {
      errors[p.name] = result.reason.message;
      return;
    }
    const { days: providerDays, models: providerModels, dayModels: providerDayModels } = result.value;

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

    for (const { date, model, amount_usd } of providerDayModels || []) {
      if (!model || !Number.isFinite(amount_usd)) continue;
      const key = `${date}|${p.name}:${model}`;
      const existing = dayModelTotals.get(key);
      if (existing) existing.amount_usd += amount_usd;
      else dayModelTotals.set(key, { date, provider: p.name, model, amount_usd });
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
    dayModels: [...dayModelTotals.values()],
  };
}

// Month-to-date + a simple linear forecast, computed from the `days` array
// already fetched above — no extra provider API calls. The 31-day rolling
// window `days` covers always includes the 1st of the current month (it
// only needs to reach back at most 30 days from today to do so).
function buildSummary(days, budget) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthStartStr = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const daysElapsed = now.getUTCDate();

  const mtd = days
    .filter(d => d.date >= monthStartStr)
    .reduce((sum, d) => sum + providers.reduce((s, p) => s + (d[p.name] || 0), 0), 0);

  const forecast = daysElapsed > 0 ? (mtd / daysElapsed) * daysInMonth : 0;

  return { mtd, forecast, days_elapsed: daysElapsed, days_in_month: daysInMonth, budget };
}

// Any failure here (not configured, no row yet) just means no budget set.
async function resolveBudget(userId) {
  if (!userId) return null;
  try {
    const settings = await getUserSettings(userId);
    return settings?.monthly_budget ?? null;
  } catch (e) {
    console.warn(`Could not load budget: ${e.message}`);
    return null;
  }
}

module.exports = { resolveOverrides, fetchAllCosts, buildSummary, resolveBudget };
