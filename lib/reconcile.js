// Reconciliation: detects drift between what's stored in daily_costs and
// what a provider actually reports right now — the guard on the whole sync
// layer (lib/costSync.js). Strictly read-and-compare: this never writes
// cost data, only reads daily_costs, live-fetches the same month, and
// records the comparison in reconciliation_runs. Same local rest()/config()
// pattern as lib/costSync.js/lib/fixedCosts.js — service role key, so every
// query is manually scoped to a caller-supplied user_id.
const { resolveOverrides, fetchAllCosts } = require("./costs");
const { getDailyCostRows } = require("./costSync");

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
  // A plain POST (no `Prefer: return=representation`, which nothing here
  // needs) comes back 201 with an empty body, not 204 — this bit
  // lib/costSync.js before, so it's handled generically from the start here.
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
  return parsed;
}

// Absolute, not a percentage: a percentage hides small absolute drift on
// large months and fires constantly on tiny ones. Float summation noise is
// real (observed ~$0.000001 on a single model line during verification) —
// this threshold exists to absorb that and nothing more.
const DRIFT_THRESHOLD_USD = 0.01;

// Sums stored daily_costs rows for the month, per provider — every row
// (usage, subscription, and the unattributed-remainder sentinel, see
// lib/costSync.js's UNATTRIBUTED_MODEL), because that's exactly what a
// provider's true day total includes. Compared below against
// aggregateProviderResults' providerRawUsd (lib/costs.js) — the same raw
// total, not the dashboard's usage-only totals, which would flag false
// drift on every provider with any subscription/unattributed spend.
function sumStoredByProvider(rows) {
  const totals = {};
  for (const r of rows) {
    if (!Number.isFinite(r.amount_usd)) continue;
    totals[r.provider] = (totals[r.provider] || 0) + r.amount_usd;
  }
  return totals;
}

// Compares stored vs. live for one user+month, per configured provider, and
// writes one reconciliation_runs row per provider. A provider whose live
// fetch fails is recorded as 'unchecked' — never 'ok' (a failed check must
// never look like a clean one), and never numerically compared (there's no
// live number to diff against). `error` is only in the returned rows for
// the caller to log/surface — reconciliation_runs has no column for it.
//
// live_usd/diff_usd are NOT NULL columns, so an 'unchecked' row can't
// actually leave them null — it writes live_usd = stored_usd, diff_usd = 0
// as an explicit placeholder ("assume no drift" is the only non-fabricated
// choice available), not a real comparison. Every consumer of this data
// (getReconciliationStatus's `unverifiable`, the dashboard) keys off
// `status`, never these two, for exactly that reason — status is what's
// authoritative here.
async function reconcileUserMonth(userId, monthStr) {
  const overrides = await resolveOverrides(userId);
  const configuredProviders = Object.keys(overrides);
  if (configuredProviders.length === 0) return { month: monthStr, checked: [] };

  const [storedRows, rawLive] = await Promise.all([
    getDailyCostRows(userId, monthStr),
    fetchAllCosts(overrides, false, monthStr),
  ]);
  const storedByProvider = sumStoredByProvider(storedRows);
  const checkedAt = new Date().toISOString();

  const checked = configuredProviders.map(providerName => {
    const stored = storedByProvider[providerName] || 0;
    if (providerName in rawLive.errors) {
      return {
        provider: providerName, stored_usd: stored, live_usd: stored, diff_usd: 0,
        status: "unchecked", checked_at: checkedAt, error: rawLive.errors[providerName],
      };
    }
    const live = rawLive.providerRawUsd[providerName] || 0;
    const diff = live - stored;
    const status = Math.abs(diff) < DRIFT_THRESHOLD_USD ? "ok" : "drift";
    return { provider: providerName, stored_usd: stored, live_usd: live, diff_usd: diff, status, checked_at: checkedAt };
  });

  await rest(`/reconciliation_runs`, {
    method: "POST",
    body: JSON.stringify(checked.map(({ error, ...row }) => ({ user_id: userId, month: monthStr, ...row }))),
  });

  return { month: monthStr, checked };
}

// Reconciliation checks land at most one row per provider per cron run (see
// api/cron/digest.js's rotation), so "consecutive runs" for a provider just
// means "most recent rows for that provider" — this many is comfortably
// more than the 3 needed to detect the "unchecked 3 times in a row" case
// below, even accounting for a provider occasionally being skipped by the
// per-run user cap.
const RUNS_PER_PROVIDER = 5;

// For api/costs.js to surface both a drift banner and an "unverifiable"
// one, without the dashboard having to know which months were even checked:
//   - `latest`: the single most recent row per provider, across any month.
//   - `unverifiable`: providers whose last 3 consecutive runs were all
//     'unchecked' — a live fetch that fails every single time looks
//     identical to a healthy one if only the latest row is surfaced, so
//     this is deliberately a different signal than `latest`'s status.
// One query (`order=checked_at.desc`, capped), grouped in JS since
// PostgREST has no DISTINCT ON / per-group LIMIT.
async function getReconciliationStatus(userId, fetchLimit = 60) {
  const rows = await rest(
    `/reconciliation_runs?user_id=eq.${encodeURIComponent(userId)}` +
    `&select=month,provider,stored_usd,live_usd,diff_usd,status,checked_at` +
    `&order=checked_at.desc&limit=${fetchLimit}`
  );

  const byProvider = new Map(); // provider -> most-recent-first rows, capped at RUNS_PER_PROVIDER
  for (const r of rows || []) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
    const arr = byProvider.get(r.provider);
    if (arr.length < RUNS_PER_PROVIDER) arr.push(r);
  }

  const latest = [];
  const unverifiable = [];
  for (const [provider, runs] of byProvider) {
    if (runs.length === 0) continue;
    latest.push(runs[0]);
    const last3 = runs.slice(0, 3);
    if (last3.length === 3 && last3.every(r => r.status === "unchecked")) {
      unverifiable.push({ provider, month: runs[0].month, checked_at: runs[0].checked_at });
    }
  }
  return { latest, unverifiable };
}

module.exports = { reconcileUserMonth, getReconciliationStatus, DRIFT_THRESHOLD_USD };
