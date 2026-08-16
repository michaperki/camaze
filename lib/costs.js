// Shared cost-computation core, used by both api/costs.js (the dashboard)
// and lib/digest.js (the daily email) so the two never drift apart on what
// "this user's spend" means.
const cryptoLib = require("./crypto");
const { getAllProviderKeys, getUserSettings } = require("./supabase");

const anthropicProvider = require("../providers/anthropic");
const openaiProvider = require("../providers/openai");
const googleProvider = require("../providers/google");
const providers = [anthropicProvider, openaiProvider, googleProvider];

// A line item is a flat recurring charge, not usage, if its provider-given
// description says so (e.g. Google's BigQuery export SKU description
// "Gemini Code Assist monthly subscription") — metadata the provider
// assigns, not a pattern inferred from repeating dollar amounts. Neither
// Anthropic's Admin cost-report API nor OpenAI's org Costs API expose any
// such distinction (both are pure usage billing for API access), so this
// only ever matches Google today; it's provider-agnostic on purpose so a
// future provider with the same kind of metadata doesn't need a second
// classifier.
function isSubscriptionLine(model) {
  return /subscription/i.test(model || "");
}

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
  const byDay = new Map(); // date -> { anthropic: usageUsd, openai: usageUsd, ... }
  const subByDay = new Map(); // date -> subscription usd, all providers combined
  const totals = { combined: 0, usage: 0, subscriptions: 0 };
  for (const p of providers) totals[p.name] = 0; // usage-only, matches the chart bars
  const modelTotals = new Map(); // "provider:model" -> { provider, model, amount_usd }
  const dayModelTotals = new Map(); // "date|provider|model" -> { date, provider, model, amount_usd }
  const projectTotals = new Map(); // "provider:id" -> { provider, id, name, amount_usd } — only Google populates this today

  settled.forEach((result, i) => {
    const p = providers[i];
    if (result.status === "rejected") {
      errors[p.name] = result.reason.message;
      return;
    }
    const { days: providerDays, models: providerModels, dayModels: providerDayModels, projects: providerProjects } = result.value;

    // This provider's subscription amount per day, from its own dayModels —
    // used below to split each day's authoritative total (providerDays)
    // into usage vs subscription. Line items with no model at all (so they
    // can't be classified either way) fall through to usage by subtraction,
    // same as the "no way to distinguish" fallback for a whole provider.
    const providerSubByDay = new Map();
    for (const { date, model, amount_usd } of providerDayModels || []) {
      if (!isSubscriptionLine(model) || !Number.isFinite(amount_usd)) continue;
      providerSubByDay.set(date, (providerSubByDay.get(date) || 0) + amount_usd);
    }

    for (const { date, amount_usd } of providerDays) {
      if (!Number.isFinite(amount_usd)) {
        console.warn(`Ignoring non-finite amount from ${p.name} on ${date}: ${amount_usd}`);
        continue;
      }
      const subAmt = providerSubByDay.get(date) || 0;
      const usageAmt = Math.max(0, amount_usd - subAmt);

      if (!byDay.has(date)) byDay.set(date, {});
      byDay.get(date)[p.name] = (byDay.get(date)[p.name] || 0) + usageAmt;
      subByDay.set(date, (subByDay.get(date) || 0) + subAmt);

      totals[p.name] += usageAmt;
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

    for (const { id, name, amount_usd } of providerProjects || []) {
      if (!id || !Number.isFinite(amount_usd)) continue;
      const key = `${p.name}:${id}`;
      const existing = projectTotals.get(key);
      if (existing) existing.amount_usd += amount_usd;
      else projectTotals.set(key, { provider: p.name, id, name: name || id, amount_usd });
    }
  });

  // Continuous 31-day axis, zero-filled per provider. Per-provider values
  // are usage-only (subscriptions never appear as bar segments); usage_usd/
  // subscription_usd carry the same split at the whole-day level for the
  // spike detector and email copy.
  const days = [];
  for (let d = new Date(start); d <= now; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const entry = { date };
    let usageSum = 0;
    for (const p of providers) {
      const v = byDay.get(date)?.[p.name] || 0;
      entry[p.name] = v;
      usageSum += v;
    }
    entry.usage_usd = usageSum;
    entry.subscription_usd = subByDay.get(date) || 0;
    days.push(entry);
  }

  // Split the aggregated per-model totals into real usage (rows under a
  // cent are clutter, not signal) and flat recurring charges (e.g. Google's
  // "Gemini Code Assist monthly subscription") — same classification either
  // way, just routed into two different lists instead of one being dropped.
  const allModels = [...modelTotals.values()];
  const models = allModels
    .filter(m => m.amount_usd >= 0.01 && !isSubscriptionLine(m.model))
    .sort((a, b) => b.amount_usd - a.amount_usd);
  const subscriptions = allModels
    .filter(m => isSubscriptionLine(m.model))
    .map(({ provider, model, amount_usd }) => ({ provider, name: model, amount_usd }))
    .sort((a, b) => b.amount_usd - a.amount_usd);

  totals.subscriptions = subscriptions.reduce((sum, s) => sum + s.amount_usd, 0);
  totals.usage = totals.combined - totals.subscriptions;

  return {
    providers: providers.map(p => ({ name: p.name, label: p.label, failed: p.name in errors })),
    days,
    totals,
    errors,
    models,
    subscriptions,
    dayModels: [...dayModelTotals.values()],
    // Provider-native project/workspace breakdown, where a provider's own
    // fetchCosts() already has it "for free" from the same query (Google's
    // BigQuery billing export is grouped by project alongside day+model).
    // Anthropic and OpenAI don't populate this — their attribution needs
    // dedicated calls the daily digest shouldn't pay for, so it's fetched
    // separately by fetchAttribution() below, dashboard-only.
    projects: [...projectTotals.values()],
  };
}

// Month-to-date + a forecast, computed from the `days` array already
// fetched above — no extra provider API calls. The 31-day rolling window
// `days` always covers the 1st of the current month (it only needs to
// reach back at most 30 days from today to do so).
//
// The forecast is usage and subscriptions projected separately, then
// summed — not one linear projection of the blended total. Usage can spike
// or dip, so its run-rate is extrapolated from days elapsed. A subscription
// is flat by definition: linearly projecting its (near-constant) daily
// rate from partial-month data isn't really an extrapolation at all, it
// converges on the true monthly total almost exactly, which is the point —
// it just adds the accrual it's already known to be making, rather than
// treating a fixed cost as if it could vary the way usage does.
function buildSummary(days, budget) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthStartStr = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const daysElapsed = now.getUTCDate();

  const monthDays = days.filter(d => d.date >= monthStartStr);
  const usageMtd = monthDays.reduce((sum, d) => sum + d.usage_usd, 0);
  const subscriptionMtd = monthDays.reduce((sum, d) => sum + d.subscription_usd, 0);
  const mtd = usageMtd + subscriptionMtd;

  const usageForecast = daysElapsed > 0 ? (usageMtd / daysElapsed) * daysInMonth : 0;
  const subscriptionForecast = daysElapsed > 0 ? (subscriptionMtd / daysElapsed) * daysInMonth : 0;
  const forecast = usageForecast + subscriptionForecast;

  return { mtd, usageMtd, subscriptionMtd, forecast, days_elapsed: daysElapsed, days_in_month: daysInMonth, budget };
}

// Per-API-key / per-workspace / per-project spend for the last 30 days —
// dashboard-only (api/costs.js), deliberately not part of fetchAllCosts()
// above so the daily digest never pays for Anthropic/OpenAI's extra
// attribution calls it doesn't use. `googleProjects`: the `projects` array
// already returned by fetchAllCosts() for this same request — Google's data
// comes from the query fetchAllCosts() already ran, not a second one.
// A provider whose call fails is left out of the array entirely rather than
// failing the whole thing, same graceful-degradation pattern as the main
// per-provider fetch above.
async function fetchAttribution(overrides, allowEnvFallback, googleProjects) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));

  const attribution = [];

  if (overrides.anthropic || allowEnvFallback) {
    try {
      attribution.push(...await anthropicProvider.fetchAttribution(start, now, overrides.anthropic));
    } catch (e) {
      console.warn(`Could not load Anthropic attribution: ${e.message}`);
    }
  }

  if (overrides.openai || allowEnvFallback) {
    try {
      attribution.push(...await openaiProvider.fetchAttribution(start, now, overrides.openai));
    } catch (e) {
      console.warn(`Could not load OpenAI attribution: ${e.message}`);
    }
  }

  for (const { id, name, amount_usd } of googleProjects || []) {
    attribution.push({ provider: "google", scope: "project", id, name, amount_usd, estimated: false });
  }

  return attribution.sort((a, b) => b.amount_usd - a.amount_usd);
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

module.exports = { resolveOverrides, fetchAllCosts, buildSummary, resolveBudget, isSubscriptionLine, fetchAttribution };
