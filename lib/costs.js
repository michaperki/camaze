// Shared cost-computation core, used by both api/costs.js (the dashboard)
// and lib/digest.js (the daily email) so the two never drift apart on what
// "this user's spend" means.
const cryptoLib = require("./crypto");
const { getAllProviderKeys, getUserSettings } = require("./supabase");
const { activeFixedCostsForMonth } = require("./fixedCosts");
const timing = require("./timing");

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

// Google's BigQuery billing export has no service filter, so every GCP SKU
// in the project shows up as a "model" line — Compute Engine, Storage,
// networking, support, alongside actual Vertex AI/Gemini usage. Only the
// latter belongs in the per-model breakdown; broad on purpose, since an
// unrecognized genAI SKU landing in "models" is a smaller problem than a
// real one getting silently misclassified as "other."
const GOOGLE_MODEL_SKU_RE = /gemini|palm|vertex ai|imagen|codey|generative language|model garden|text embedding|multimodal embedding/i;
function isNonModelLine(provider, model) {
  if (provider !== "google") return false;
  return !GOOGLE_MODEL_SKU_RE.test(model || "");
}

// Sentinel "model" for a day/provider's unattributed remainder — line items
// a provider bills for but doesn't tag with a model (see the day-total vs.
// modeled-lines gap fetchAllCosts() already tolerates below, "falls through
// to usage by subtraction"). Real spend, just not attributable to any one
// model. lib/costSync.js writes one of these per day/provider when that gap
// is nonzero, so daily_costs's stored rows always sum to the same day total
// a live fetch would report — dropping it would silently under-report.
const UNATTRIBUTED_MODEL = "__unattributed__";

// Resolves a "YYYY-MM" string (or a falsy value, meaning "current month")
// into a concrete UTC date range. `end` is an exclusive upper bound, used
// both as the provider APIs' ending_at/end_time and as the days-array loop
// bound below — the current month stops at `now`, a past month stops at
// the first moment of the following month. A month in the future (the UI
// never offers one, but defend anyway) collapses to an empty range.
function resolveMonthRange(monthStr, now) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr || "");
  const year = m ? Number(m[1]) : now.getUTCFullYear();
  const month = m ? Number(m[2]) - 1 : now.getUTCMonth(); // 0-indexed

  const start = new Date(Date.UTC(year, month, 1));
  const isCurrentMonth = year === now.getUTCFullYear() && month === now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthEndExclusive = new Date(Date.UTC(year, month + 1, 1));
  const end = isCurrentMonth ? now : (start > now ? start : monthEndExclusive);

  return { start, end, isCurrentMonth, daysInMonth, month: `${year}-${String(month + 1).padStart(2, "0")}` };
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
// `monthStr`: optional "YYYY-MM" to scope the request to one calendar month
// (api/costs.js, the dashboard). Omitted entirely by lib/digest.js and
// lib/alertRunner.js, which need the old rolling 30-day window regardless
// of calendar boundaries (the spike detector needs a full window of
// history even two days into a new month) — so this falls back to exactly
// that window, unchanged, rather than resolveMonthRange's "current month"
// default.
async function fetchAllCosts(overrides, allowEnvFallback, monthStr) {
  const now = new Date();
  let start, end, isCurrentMonth, daysInMonth, month;
  if (monthStr) {
    ({ start, end, isCurrentMonth, daysInMonth, month } = resolveMonthRange(monthStr, now));
  } else {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));
    end = now;
  }

  const settled = await Promise.allSettled(providers.map(p => {
    const override = overrides[p.name];
    if (!override && !allowEnvFallback) {
      return Promise.reject(new Error("Not connected — add a key on the Integrations page."));
    }
    return timing.mark(`provider:${p.name}`, () => p.fetchCosts(start, end, override));
  }));

  // Map<providerName, { days, models, dayModels, projects } | { error }> —
  // the common currency between a live provider call and a reconstruction
  // from stored daily_costs rows (see costDataFromStoredRows below), so both
  // can share the exact same aggregation logic in aggregateProviderResults.
  const resultsByProvider = new Map();
  settled.forEach((result, i) => {
    const p = providers[i];
    resultsByProvider.set(p.name, result.status === "fulfilled" ? result.value : { error: result.reason.message });
  });

  return aggregateProviderResults(resultsByProvider, start, end, { isCurrentMonth, daysInMonth, month });
}

// Shared by fetchAllCosts() (fed live provider results) and
// costDataFromStoredRows() (fed a reconstruction of the same shape from
// daily_costs) — this is the actual chart/model/subscription aggregation,
// identical either way so a cache-hit response can never drift from what a
// live fetch would have produced.
function aggregateProviderResults(resultsByProvider, start, end, { isCurrentMonth, daysInMonth, month } = {}) {
  const errors = {};
  const byDay = new Map(); // date -> { anthropic: usageUsd, openai: usageUsd, ... }
  const subByDay = new Map(); // date -> subscription usd, all providers combined
  const totals = { combined: 0, usage: 0, subscriptions: 0 };
  for (const p of providers) totals[p.name] = 0; // usage-only, matches the chart bars
  // Raw per-provider total — usage + subscription + any unattributed
  // remainder, i.e. exactly what that provider's daily_costs rows sum to
  // (see lib/costSync.js's UNATTRIBUTED_MODEL handling). totals[p.name]
  // above is usage-only for the chart; this is what lib/reconcile.js
  // compares stored data against, since a usage-only number would flag
  // false drift on every provider with subscription/unattributed spend.
  const providerRawUsd = {};
  for (const p of providers) providerRawUsd[p.name] = 0;
  const modelTotals = new Map(); // "provider:model" -> { provider, model, amount_usd }
  const dayModelTotals = new Map(); // "date|provider|model" -> { date, provider, model, amount_usd }
  const projectTotals = new Map(); // "provider:id" -> { provider, id, name, amount_usd } — only Google populates this today

  for (const p of providers) {
    const result = resultsByProvider.get(p.name);
    if (!result || result.error) {
      if (result?.error) errors[p.name] = result.error;
      continue;
    }
    const { days: providerDays, models: providerModels, dayModels: providerDayModels, projects: providerProjects } = result;

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
      providerRawUsd[p.name] += amount_usd;
    }

    for (const { model, amount_usd } of providerModels || []) {
      if (!model || model === UNATTRIBUTED_MODEL || !Number.isFinite(amount_usd)) continue;
      const key = `${p.name}:${model}`;
      const existing = modelTotals.get(key);
      if (existing) existing.amount_usd += amount_usd;
      else modelTotals.set(key, { provider: p.name, model, amount_usd });
    }

    for (const { date, model, amount_usd } of providerDayModels || []) {
      if (!model || model === UNATTRIBUTED_MODEL || !Number.isFinite(amount_usd)) continue;
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
  }

  // Continuous day axis for [start, end), zero-filled per provider.
  // Per-provider values are usage-only (subscriptions never appear as bar
  // segments); usage_usd/subscription_usd carry the same split at the
  // whole-day level for the spike detector and email copy.
  const days = [];
  for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
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
    .filter(m => m.amount_usd >= 0.01 && !isSubscriptionLine(m.model) && !isNonModelLine(m.provider, m.model))
    .sort((a, b) => b.amount_usd - a.amount_usd);
  const allSubscriptionLines = allModels
    .filter(m => isSubscriptionLine(m.model) || isNonModelLine(m.provider, m.model));

  // The section total includes every subscription/non-model line, even ones
  // that round to $0.00 individually (e.g. BigQuery's "Active Logical
  // Storage") — several of those can still add up to something worth
  // showing. Only the row list applies the same >= $0.01 floor as the model
  // breakdown, so rows that round to zero aren't rendered individually.
  totals.subscriptions = allSubscriptionLines.reduce((sum, s) => sum + s.amount_usd, 0);
  totals.usage = totals.combined - totals.subscriptions;

  const subscriptions = allSubscriptionLines
    .filter(m => m.amount_usd >= 0.01)
    .map(({ provider, model, amount_usd }) => ({ provider, name: model, amount_usd }))
    .sort((a, b) => b.amount_usd - a.amount_usd);

  return {
    providers: providers.map(p => ({ name: p.name, label: p.label, failed: p.name in errors })),
    days,
    totals,
    providerRawUsd,
    errors,
    models,
    subscriptions,
    dayModels: [...dayModelTotals.values()],
    // Provider-native project/workspace breakdown, where a provider's own
    // fetchCosts() already has it "for free" from the same query (Google's
    // BigQuery billing export is grouped by project alongside day+model).
    // Anthropic and OpenAI don't populate this — their attribution needs
    // dedicated calls the daily digest shouldn't pay for, so it's fetched
    // separately by fetchProviderAttribution()/buildGoogleAttribution() below, dashboard-only.
    projects: [...projectTotals.values()],
    // month/isCurrentMonth/daysInMonth are undefined for legacy (no-month)
    // callers — digest.js and alertRunner.js don't read them.
    month,
    isCurrentMonth,
    daysInMonth,
  };
}

// Rebuilds the exact fetchAllCosts() shape from daily_costs rows already
// stored for one user+month (see lib/costSync.js) — a cache-hit response is
// indistinguishable from a live one to every downstream consumer
// (buildSummary, the dashboard's per-model/per-day breakdowns), because
// both funnel through aggregateProviderResults above.
//
// `configuredProviders`: this user's currently-connected provider names
// (Object.keys(resolveOverrides(...))) — a provider not in this list reads
// as "Not connected", exactly like a live fetch, even if stale rows for it
// happen to still be in the table (shouldn't happen, but this keeps the
// dashboard's story consistent with Integrations regardless).
// `providersSucceededLastRun`: cost_sync_state's record of which providers
// the most recent sync wrote successfully. A configured provider with zero
// stored rows is only "genuinely $0 this month" if it's in this list —
// otherwise (never synced, or synced and failed, with no prior data to fall
// back on) it reads as "Not yet synced" rather than silently as $0.
function costDataFromStoredRows(rows, monthStr, now, configuredProviders, providersSucceededLastRun = []) {
  const { start, end, isCurrentMonth, daysInMonth, month } = resolveMonthRange(monthStr, now);

  const byProvider = new Map(); // provider -> { dayTotals: Map(date->usd), dayModels: [...], models: Map(model->usd) }
  for (const r of rows) {
    if (!Number.isFinite(r.amount_usd)) continue;
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, { dayTotals: new Map(), dayModels: [], models: new Map() });
    const p = byProvider.get(r.provider);
    p.dayTotals.set(r.date, (p.dayTotals.get(r.date) || 0) + r.amount_usd);
    // The unattributed-remainder sentinel counts toward the day total above
    // (that's its whole purpose) but was never a real model, so it's kept
    // out of dayModels/models the same way aggregateProviderResults already
    // filters it out for the live path.
    if (r.model !== UNATTRIBUTED_MODEL) {
      p.dayModels.push({ date: r.date, model: r.model, amount_usd: r.amount_usd });
      p.models.set(r.model, (p.models.get(r.model) || 0) + r.amount_usd);
    }
  }

  const resultsByProvider = new Map();
  for (const p of providers) {
    if (!configuredProviders.includes(p.name)) {
      resultsByProvider.set(p.name, { error: "Not connected — add a key on the Integrations page." });
      continue;
    }
    const stored = byProvider.get(p.name);
    if (stored) {
      resultsByProvider.set(p.name, {
        days: [...stored.dayTotals].map(([date, amount_usd]) => ({ date, amount_usd })),
        models: [...stored.models].map(([model, amount_usd]) => ({ model, amount_usd })),
        dayModels: stored.dayModels,
        projects: [], // attribution is read separately from monthly_attribution, not needed here
      });
    } else if (providersSucceededLastRun.includes(p.name)) {
      resultsByProvider.set(p.name, { days: [], models: [], dayModels: [], projects: [] });
    } else {
      resultsByProvider.set(p.name, { error: "Not yet synced." });
    }
  }

  return aggregateProviderResults(resultsByProvider, start, end, { isCurrentMonth, daysInMonth, month });
}

// Month-to-date + a forecast. Two modes, distinguished by whether the
// caller passes `isCurrentMonth` at all:
//
// - Legacy (digest.js, alertRunner.js — 2-arg calls): `days` is the old
//   rolling 30-day window, which always covers the 1st of the real current
//   month, so this derives "this month" from today's date and filters the
//   window down to it, exactly as it always has.
// - Month-scoped (api/costs.js): `days` is already exactly one calendar
//   month (see fetchAllCosts), so no filtering is needed — `isCurrentMonth`/
//   `daysInMonth` come straight from resolveMonthRange. A past month's
//   forecast is null (it's a known, final total, not a projection); the
//   frontend shows "—" for that.
//
// The forecast (current month only) is usage and subscriptions projected
// separately, then summed — not one linear projection of the blended
// total. Usage can spike or dip, so its run-rate is extrapolated from days
// elapsed. A subscription is flat by definition: linearly projecting its
// (near-constant) daily rate from partial-month data isn't really an
// extrapolation at all, it converges on the true monthly total almost
// exactly, which is the point — it just adds the accrual it's already
// known to be making, rather than treating a fixed cost as if it could
// vary the way usage does.
//
// `fixedCostsTotal`: this month's manually-entered fixed costs (see
// lib/fixedCosts.js) — already the full month amount, never a per-day rate,
// so it's added directly to both mtd and forecast rather than run-rated
// like usage/subscriptions above. Extrapolating a flat $200/mo subscription
// from a few days of "elapsed" data would overstate the forecast early in
// the month; it's $200 whether it's the 3rd or the 30th.
function buildSummary(days, budget, isCurrentMonth, daysInMonth, fixedCostsTotal = 0) {
  const now = new Date();

  if (isCurrentMonth === undefined) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const monthStartStr = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const legacyDaysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const daysElapsed = now.getUTCDate();

    const monthDays = days.filter(d => d.date >= monthStartStr);
    const usageMtd = monthDays.reduce((sum, d) => sum + d.usage_usd, 0);
    const subscriptionMtd = monthDays.reduce((sum, d) => sum + d.subscription_usd, 0);
    const mtd = usageMtd + subscriptionMtd + fixedCostsTotal;

    const usageForecast = daysElapsed > 0 ? (usageMtd / daysElapsed) * legacyDaysInMonth : 0;
    const subscriptionForecast = daysElapsed > 0 ? (subscriptionMtd / daysElapsed) * legacyDaysInMonth : 0;

    return {
      mtd, usageMtd, subscriptionMtd, fixedCostsMtd: fixedCostsTotal,
      forecast: usageForecast + subscriptionForecast + fixedCostsTotal,
      days_elapsed: daysElapsed, days_in_month: legacyDaysInMonth, budget,
    };
  }

  const usageMtd = days.reduce((sum, d) => sum + d.usage_usd, 0);
  const subscriptionMtd = days.reduce((sum, d) => sum + d.subscription_usd, 0);
  const mtd = usageMtd + subscriptionMtd + fixedCostsTotal;
  const daysElapsed = isCurrentMonth ? days.length : daysInMonth;

  let forecast = null;
  if (isCurrentMonth && daysElapsed > 0) {
    const usageForecast = (usageMtd / daysElapsed) * daysInMonth;
    const subscriptionForecast = (subscriptionMtd / daysElapsed) * daysInMonth;
    forecast = usageForecast + subscriptionForecast + fixedCostsTotal;
  }

  return {
    mtd, usageMtd, subscriptionMtd, fixedCostsMtd: fixedCostsTotal,
    forecast, days_elapsed: daysElapsed, days_in_month: daysInMonth, budget,
  };
}

// Anthropic's api_key/workspace rows overlap hierarchically — every key
// lives inside a workspace, so showing both as siblings double-counts the
// same spend. Each provider therefore contributes rows at exactly ONE
// scope: the first one in this list it actually has data for. OpenAI only
// ever produces "project" rows (see providers/openai.js — per-key rows were
// removed after their name-resolution fan-out tripped OpenAI's rate limit
// while never actually being displayed); add "api_key" back here if that
// capability is reintroduced with proper batching.
const PROVIDER_SCOPE_PREFERENCE = {
  anthropic: ["api_key", "workspace"],
  openai: ["project"],
  google: ["project"],
};

function selectPreferredScope(rows, providerName) {
  for (const scope of PROVIDER_SCOPE_PREFERENCE[providerName] || []) {
    const matching = rows.filter(r => r.scope === scope);
    if (matching.length > 0) return matching;
  }
  // None of the preferred scopes had data — surface whatever came back
  // rather than silently dropping a scope this provider didn't anticipate.
  return rows;
}

// Anthropic + OpenAI per-API-key / per-workspace / per-project spend for one
// calendar month — dashboard-only (api/costs.js), deliberately not part of
// fetchAllCosts() above so the daily digest never pays for these extra
// calls it doesn't use. Unlike Google's attribution (see
// buildGoogleAttribution below), this doesn't depend on fetchAllCosts()'s
// result at all, so callers can start this immediately, in parallel with
// the chart fetch, instead of waiting for it to resolve first. The two
// providers run concurrently; one failing is left out of the array entirely
// rather than failing the whole thing, same graceful-degradation pattern as
// the main per-provider fetch above. Returns `errors` alongside `attribution`
// (keyed by provider, only for a provider that was actually attempted and
// threw — an unconfigured provider resolves to [] and is never an error)
// so lib/costSync.js can tell which providers' attribution actually synced.
async function fetchProviderAttribution(overrides, allowEnvFallback, monthStr) {
  const { start, end } = resolveMonthRange(monthStr, new Date());

  const [anthropicResult, openaiResult] = await Promise.allSettled([
    overrides.anthropic || allowEnvFallback
      ? timing.mark("attribution:anthropic", () => anthropicProvider.fetchAttribution(start, end, overrides.anthropic))
      : Promise.resolve([]),
    overrides.openai || allowEnvFallback
      ? timing.mark("attribution:openai", () => openaiProvider.fetchAttribution(start, end, overrides.openai))
      : Promise.resolve([]),
  ]);

  const attribution = [];
  const errors = {};
  if (anthropicResult.status === "fulfilled") {
    attribution.push(...selectPreferredScope(anthropicResult.value, "anthropic"));
  } else {
    errors.anthropic = anthropicResult.reason.message;
    console.warn(`Could not load Anthropic attribution: ${anthropicResult.reason.message}`);
  }
  if (openaiResult.status === "fulfilled") {
    attribution.push(...selectPreferredScope(openaiResult.value, "openai"));
  } else {
    errors.openai = openaiResult.reason.message;
    console.warn(`Could not load OpenAI attribution: ${openaiResult.reason.message}`);
  }
  return { attribution, errors };
}

// Google's project attribution rows, straight from the `projects` array
// fetchAllCosts() already returned for this same request (no extra call) —
// reshaped into the same row format the other providers use above.
function buildGoogleAttribution(googleProjects) {
  return (googleProjects || []).map(({ id, name, amount_usd }) => ({
    provider: "google", scope: "project", id, name, amount_usd, estimated: false,
  }));
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

// This user's manually-entered fixed costs (see lib/fixedCosts.js) active
// during the given month, plus their combined total. `monthStr` is required
// here — unlike resolveBudget, there's no rolling-window fallback, since a
// fixed cost's activity is inherently calendar-month-scoped (started_on/
// ended_on). Any failure (not configured, no rows yet) just means nothing
// to add, same graceful-degradation pattern as resolveBudget above.
async function resolveFixedCosts(userId, monthStr) {
  if (!userId || !monthStr) return { rows: [], total: 0 };
  try {
    const rows = await activeFixedCostsForMonth(userId, monthStr);
    const total = rows.reduce((sum, r) => sum + r.amount_usd, 0);
    return { rows, total };
  } catch (e) {
    console.warn(`Could not load fixed costs: ${e.message}`);
    return { rows: [], total: 0 };
  }
}

module.exports = {
  resolveOverrides, fetchAllCosts, buildSummary, resolveBudget, resolveFixedCosts,
  isSubscriptionLine, isNonModelLine, fetchProviderAttribution, buildGoogleAttribution,
  costDataFromStoredRows, resolveMonthRange, UNATTRIBUTED_MODEL,
};
