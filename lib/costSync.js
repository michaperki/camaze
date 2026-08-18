// Syncs one user's provider costs into Supabase (daily_costs,
// monthly_attribution, cost_sync_state) so api/costs.js can read from
// Postgres instead of hitting every provider API on every dashboard load.
// Same local rest()/config() pattern as lib/fixedCosts.js — uses the
// service role key, which bypasses RLS, so every query below is manually
// scoped to a caller-supplied user_id.
//
// Two rules matter more than anything else here:
//   - A provider that errors must not cause a write for that provider.
//     Its existing rows are left completely untouched; the failure is only
//     recorded in cost_sync_state.
//   - Writes are always upserts, never delete-then-insert. A row that
//     disappears from a provider's response is updated to zero, not left
//     stale and not dropped mid-write.
const {
  resolveOverrides, fetchAllCosts, fetchProviderAttribution, buildGoogleAttribution,
  isSubscriptionLine, resolveMonthRange, UNATTRIBUTED_MODEL,
} = require("./costs");

function config() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return { url, serviceRoleKey };
}

async function rest(path, options = {}) {
  const { url, serviceRoleKey } = config();
  const res = await fetch(`${url}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    throw new Error(parsed?.message || `HTTP ${res.status} from Supabase`);
  }
  // A POST without `Prefer: return=representation` (every upsert below,
  // which only needs the write to happen) comes back 201 with an empty
  // body, not 204 — PostgREST's "204 means no body" isn't reliable here.
  return parsed;
}

// "YYYY-MM" -> the calendar month's first/last day as ISO date strings,
// via the same Date-object math resolveMonthRange already does — reused
// here rather than duplicated, just projected down to plain date strings
// for PostgREST's date=gte./lte. filters.
function monthDateBounds(monthStr) {
  const { start, daysInMonth } = resolveMonthRange(monthStr, new Date());
  return {
    start: start.toISOString().slice(0, 10),
    end: `${monthStr}-${String(daysInMonth).padStart(2, "0")}`,
  };
}

// Real spend per day/provider often includes line items with no model at
// all (see UNATTRIBUTED_MODEL in lib/costs.js) — a day's dayModels rows
// alone can undercount the true day total. This computes, per date, the
// gap between the day's real total (from `days`, already net of that
// provider's own subscription lines) and what the modeled (non-subscription)
// dayModels rows for that provider/date add up to, so daily_costs can store
// a row that closes it. Dropping this gap would silently under-report.
function computeUnattributedRows(days, dayModels, providerName) {
  const modeledUsageByDate = new Map();
  for (const { date, provider, model, amount_usd } of dayModels) {
    if (provider !== providerName || isSubscriptionLine(model)) continue;
    modeledUsageByDate.set(date, (modeledUsageByDate.get(date) || 0) + amount_usd);
  }
  const rows = [];
  for (const day of days) {
    const usageAmt = day[providerName] || 0;
    const modeled = modeledUsageByDate.get(day.date) || 0;
    const residual = usageAmt - modeled;
    if (Math.abs(residual) >= 0.005) {
      rows.push({ date: day.date, model: UNATTRIBUTED_MODEL, amount_usd: Math.max(0, residual) });
    }
  }
  return rows;
}

// Upserts one successful provider's daily_costs rows for the month, and
// zeroes out any previously-stored row for that provider/month that no
// longer appears in the new fetch (a model that had spend before but has
// none now, or was dropped by the provider) — never deleted, so a reader
// never sees a row just vanish mid-write.
async function syncDailyCostsForProvider(userId, monthStr, providerName, days, dayModels) {
  const { start, end } = monthDateBounds(monthStr);
  const now = new Date().toISOString();

  const modelRows = dayModels
    .filter(r => r.provider === providerName && Number.isFinite(r.amount_usd))
    .map(r => ({ date: r.date, model: r.model, amount_usd: r.amount_usd }));
  const unattributedRows = computeUnattributedRows(days, dayModels, providerName);

  const newRows = [...modelRows, ...unattributedRows].map(r => ({
    user_id: userId,
    date: r.date,
    provider: providerName,
    model: r.model,
    is_subscription: isSubscriptionLine(r.model),
    amount_usd: r.amount_usd,
    estimated: false,
    updated_at: now,
  }));

  const existing = await rest(
    `/daily_costs?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(providerName)}` +
    `&date=gte.${start}&date=lte.${end}&select=date,model,is_subscription`
  );

  const newKeys = new Set(newRows.map(r => `${r.date}|${r.model}|${r.is_subscription}`));
  const zeroRows = existing
    .filter(r => !newKeys.has(`${r.date}|${r.model}|${r.is_subscription}`))
    .map(r => ({
      user_id: userId, date: r.date, provider: providerName, model: r.model,
      is_subscription: r.is_subscription, amount_usd: 0, estimated: false, updated_at: now,
    }));

  const rows = [...newRows, ...zeroRows];
  if (rows.length === 0) return;
  await rest(`/daily_costs?on_conflict=user_id,date,provider,model,is_subscription`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
}

// Same upsert-and-zero-out pattern as daily_costs above, but for the
// per-project/workspace/api-key attribution rows — only for providers whose
// attribution succeeded this run.
//
// Known gap: Anthropic's api_key-scoped rows (providers/anthropic.js
// fetchAttribution) carry `unpriced`/`unpricedModels`/`unpricedTokens` —
// the dashboard's "spend on X isn't priced yet" badge/footnote — which
// monthly_attribution has no columns for (schema is fixed, no migrations
// this pass). amount_usd itself is unaffected; a cache-served month for
// that scope just won't show the unpriced badge a live fetch would.
async function syncMonthlyAttribution(userId, monthStr, attribution, successfulProviders) {
  if (successfulProviders.length === 0) return;
  const now = new Date().toISOString();

  const relevant = attribution.filter(a => successfulProviders.includes(a.provider));
  const newRows = relevant.map(a => ({
    user_id: userId, month: monthStr, provider: a.provider, scope: a.scope,
    entity_id: a.id, name: a.name, amount_usd: a.amount_usd, estimated: !!a.estimated,
    updated_at: now,
  }));

  const existing = await rest(
    `/monthly_attribution?user_id=eq.${encodeURIComponent(userId)}&month=eq.${encodeURIComponent(monthStr)}` +
    `&provider=in.(${successfulProviders.map(encodeURIComponent).join(",")})&select=provider,scope,entity_id,name`
  );

  const newKeys = new Set(newRows.map(r => `${r.provider}|${r.scope}|${r.entity_id}`));
  const zeroRows = existing
    .filter(r => !newKeys.has(`${r.provider}|${r.scope}|${r.entity_id}`))
    .map(r => ({
      user_id: userId, month: monthStr, provider: r.provider, scope: r.scope, entity_id: r.entity_id,
      name: r.name, amount_usd: 0, estimated: false, updated_at: now,
    }));

  const rows = [...newRows, ...zeroRows];
  if (rows.length === 0) return;
  await rest(`/monthly_attribution?on_conflict=user_id,month,provider,scope,entity_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
}

async function upsertSyncState(userId, monthStr, status, detail) {
  await rest(`/cost_sync_state?on_conflict=user_id,month`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{
      user_id: userId, month: monthStr, synced_at: new Date().toISOString(),
      status, error: detail ? JSON.stringify(detail) : null,
    }]),
  });
}

// { synced_at, status, providersSucceeded, providersFailed, messages }, or
// null if this user+month has never been synced. `error` is stored as a
// JSON blob (see upsertSyncState) — parsed here so callers never touch the
// raw column.
async function getSyncState(userId, monthStr) {
  const rows = await rest(
    `/cost_sync_state?user_id=eq.${encodeURIComponent(userId)}&month=eq.${encodeURIComponent(monthStr)}` +
    `&select=synced_at,status,error`
  );
  const row = rows[0];
  if (!row) return null;
  let detail = {};
  try {
    detail = row.error ? JSON.parse(row.error) : {};
  } catch {
    detail = {};
  }
  return {
    synced_at: row.synced_at,
    status: row.status,
    providersSucceeded: detail.providersSucceeded || [],
    providersFailed: detail.providersFailed || [],
    messages: detail.messages || {},
  };
}

// daily_costs rows for one user+month, across whichever providers had a
// successful sync — shaped for lib/costs.js's costDataFromStoredRows().
async function getDailyCostRows(userId, monthStr) {
  const { start, end } = monthDateBounds(monthStr);
  return rest(
    `/daily_costs?user_id=eq.${encodeURIComponent(userId)}&date=gte.${start}&date=lte.${end}` +
    `&select=date,provider,model,amount_usd,is_subscription`
  );
}

// monthly_attribution rows for one user+month, reshaped into the same row
// format fetchProviderAttribution()/buildGoogleAttribution() produce
// (`id` instead of `entity_id`) — zero-valued rows (a project that
// disappeared from a provider's response, see syncMonthlyAttribution) are
// dropped, same as a live fetch would never have surfaced them at all.
async function getMonthlyAttributionRows(userId, monthStr) {
  const rows = await rest(
    `/monthly_attribution?user_id=eq.${encodeURIComponent(userId)}&month=eq.${encodeURIComponent(monthStr)}` +
    `&select=provider,scope,entity_id,name,amount_usd,estimated`
  );
  return rows
    .filter(r => r.amount_usd > 0)
    .map(({ provider, scope, entity_id, name, amount_usd, estimated }) => ({
      provider, scope, id: entity_id, name, amount_usd, estimated,
    }));
}

// Writes the results of one already-fetched sync attempt (see syncUserMonth
// below) — split out so api/costs.js's live-fetch fallback paths can store
// data they already pulled from providers, without fetching it a second
// time just to sync it.
async function storeSyncResult(userId, monthStr, { configuredProviders, rawCostData, attribution, attributionErrors }) {
  const costErrors = rawCostData.errors || {};
  const successfulCostProviders = configuredProviders.filter(name => !(name in costErrors));
  const failedCostProviders = configuredProviders.filter(name => name in costErrors);

  await Promise.all(successfulCostProviders.map(name =>
    syncDailyCostsForProvider(userId, monthStr, name, rawCostData.days, rawCostData.dayModels)
  ));

  // Google's attribution rides on its cost fetch (buildGoogleAttribution just
  // reshapes rawCostData.projects) — it has no separate error channel, so its
  // attribution "succeeded" iff its cost fetch did.
  const failedAttributionProviders = Object.keys(attributionErrors || {});
  const successfulAttributionProviders = configuredProviders.filter(name => {
    if (name === "google") return !costErrors.google;
    return !failedAttributionProviders.includes(name);
  });
  await syncMonthlyAttribution(userId, monthStr, attribution, successfulAttributionProviders);

  const errors = {};
  for (const p of failedCostProviders) errors[p] = costErrors[p];
  for (const p of failedAttributionProviders) {
    if (!configuredProviders.includes(p)) continue;
    errors[p] = errors[p] ? `${errors[p]} (cost); attribution: ${attributionErrors[p]}` : `attribution: ${attributionErrors[p]}`;
  }

  const failedProviderSet = new Set([...failedCostProviders, ...failedAttributionProviders.filter(p => configuredProviders.includes(p))]);
  const status = failedProviderSet.size === 0 ? "ok" : (failedProviderSet.size >= configuredProviders.length ? "error" : "partial");

  await upsertSyncState(userId, monthStr, status, Object.keys(errors).length
    ? { providersSucceeded: successfulCostProviders, providersFailed: failedCostProviders, messages: errors }
    : { providersSucceeded: successfulCostProviders, providersFailed: [] });

  return { status, errors, providersSucceeded: successfulCostProviders, providersFailed: failedCostProviders };
}

// Fetches this user's costs + attribution for one month from the providers
// and stores the result. Used by the cron (api/cron/sync-costs.js) and the
// backfill endpoint (api/backfill.js). Reuses fetchAllCosts and
// fetchProviderAttribution/buildGoogleAttribution — no provider logic is
// reimplemented here.
async function syncUserMonth(userId, monthStr) {
  const overrides = await resolveOverrides(userId);
  const configuredProviders = Object.keys(overrides);
  if (configuredProviders.length === 0) {
    return { status: "no_keys" };
  }

  const [rawCostData, providerAttributionResult] = await Promise.all([
    fetchAllCosts(overrides, false, monthStr),
    fetchProviderAttribution(overrides, false, monthStr),
  ]);
  const attribution = [...providerAttributionResult.attribution, ...buildGoogleAttribution(rawCostData.projects)];

  return storeSyncResult(userId, monthStr, {
    configuredProviders,
    rawCostData,
    attribution,
    attributionErrors: providerAttributionResult.errors,
  });
}

module.exports = {
  syncUserMonth, storeSyncResult, getSyncState,
  getDailyCostRows, getMonthlyAttributionRows,
};
