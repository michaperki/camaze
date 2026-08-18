// camaze — minimal AI spend tracker.
// Vercel serverless function: proxies each provider's cost API so keys stay server-side.
const { verifyUser } = require("../lib/supabase");
const {
  resolveOverrides, fetchAllCosts, buildSummary, resolveBudget, resolveFixedCosts,
  fetchProviderAttribution, buildGoogleAttribution, costDataFromStoredRows,
} = require("../lib/costs");
const { getSyncState, getDailyCostRows, getMonthlyAttributionRows, storeSyncResult, syncUserMonth } = require("../lib/costSync");
const { reconcileUserMonth, getReconciliationStatus } = require("../lib/reconcile");
const timing = require("../lib/timing");
const { performance } = require("node:perf_hooks");

const CACHE_TTL_MS = 5 * 60 * 1000;
// Keyed per user+month (or "env" for anonymous/env-var requests) — a shared
// cache would otherwise serve one user's provider totals to another, and a
// shared key across months would serve one month's numbers for another.
const cache = new Map(); // cacheKey -> { data, fetchedAt }

// How stale cost_sync_state's synced_at can be for the *current* month
// (still accruing spend) before this falls through to a live fetch. Closed
// months never re-check this — they're final, so any successful sync at all
// is good enough forever.
const SYNC_FRESH_MS = 60 * 60 * 1000;

const MONTH_RE = /^\d{4}-\d{2}$/;

function currentMonthStr(now) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// True on this container's very first invocation, false on every later one
// — the standard cold-start tell for a serverless module that stays warm
// (and keeps `cache` above populated) between requests.
let warmedUp = false;

module.exports = async (req, res) => {
  // POST /api/costs?action=reconcile&month=YYYY-MM checks stored data
  // against a live fetch for one month and records the result (see
  // lib/reconcile.js) — same reasoning as backfill below for why this isn't
  // its own route: Hobby caps a deployment at 12 serverless functions and
  // this project was already at that limit. Plain POST (no action, or
  // action=backfill) keeps its original meaning.
  if (req.method === "POST" && req.query?.action === "reconcile") return reconcileNow(req, res);
  // POST /api/costs?action=sync&month=YYYY-MM re-syncs just that one month
  // (see lib/costSync.js) — used by the dashboard's "Re-sync this month"
  // button on a drift banner, where a full 6-month backfill would be
  // needless work and needlessly more provider traffic.
  if (req.method === "POST" && req.query?.action === "sync") return syncOneMonth(req, res);
  // POST /api/costs syncs the calling user's last 6 months into Supabase —
  // this used to be its own api/backfill.js route, folded in here for the
  // same reason above.
  if (req.method === "POST") return backfill(req, res);

  const handlerStart = performance.now();
  const coldStart = !warmedUp;
  warmedUp = true;
  // Opt-in only — ?debug=timing on one request, or TIMING_DEBUG for every
  // request on this deployment. timing.mark() is a cheap no-op everywhere
  // it's called (lib/costs.js, providers/*.js, lib/pricing.js) unless it's
  // running inside the run() scope opened here, so leaving those marks in
  // place costs nothing when debug timing isn't requested.
  const debugTiming = req.query?.debug === "timing" || !!process.env.TIMING_DEBUG;

  if (!debugTiming) return handle(req, res, handlerStart, coldStart, false);

  const timingStore = timing.newStore();
  return timing.run(timingStore, () => handle(req, res, handlerStart, coldStart, true));
};

function monthsBack(now, count) {
  const months = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

// Syncs the calling user's last 6 months of provider costs into Supabase
// (see lib/costSync.js), so an existing account gets history without
// waiting for 6 cron cycles. Idempotent — sync is always an upsert, so
// calling this again just re-syncs the same months harmlessly.
async function backfill(req, res) {
  const user = await verifyUser(req.headers.authorization).catch(() => null);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const months = monthsBack(new Date(), 6);
    // Sequential, not parallel — each month already fans out to 3 provider
    // calls concurrently inside syncUserMonth; running all 6 months at once
    // would multiply that to ~18 concurrent provider requests, which is how
    // OpenAI's per-key name-resolution fan-out tripped a rate limit before
    // (see lib/costs.js's PROVIDER_SCOPE_PREFERENCE comment).
    const results = [];
    for (const month of months) {
      try {
        const result = await syncUserMonth(user.id, month);
        results.push({ month, ...result });
      } catch (err) {
        results.push({ month, status: "error", error: err.message });
      }
    }
    res.status(200).json({ ok: true, months: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Re-syncs one month for the calling user (see lib/costSync.js). Same
// upsert/zero-out contract as the cron sync and the 6-month backfill above
// — calling this again just re-syncs the same month harmlessly.
async function syncOneMonth(req, res) {
  const user = await verifyUser(req.headers.authorization).catch(() => null);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const month = typeof req.query?.month === "string" && MONTH_RE.test(req.query.month) ? req.query.month : null;
  if (!month) {
    res.status(400).json({ error: "?month=YYYY-MM is required" });
    return;
  }

  try {
    const result = await syncUserMonth(user.id, month);
    res.status(200).json({ ok: true, month, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// On-demand version of the cron's reconciliation phase (see
// api/cron/digest.js's runReconciliation) for one month, for the calling
// user — e.g. right after noticing drift, without waiting for the next
// rotation. Same read-only contract as lib/reconcile.js: never touches
// daily_costs, only compares and records.
async function reconcileNow(req, res) {
  const user = await verifyUser(req.headers.authorization).catch(() => null);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const month = typeof req.query?.month === "string" && MONTH_RE.test(req.query.month) ? req.query.month : null;
  if (!month) {
    res.status(400).json({ error: "?month=YYYY-MM is required" });
    return;
  }

  try {
    const result = await reconcileUserMonth(user.id, month);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Folds fixed costs (lib/fixedCosts.js — manual subscriptions/seats, never
// cached in daily_costs/monthly_attribution, always computed fresh here) and
// the budget into a cost-data object, whether that cost data came from a
// live provider fetch or from costDataFromStoredRows(). `syncedAt`/
// `fromSyncCache` tell the dashboard whether this response came from the
// Supabase cache (so it can show "as of <time>") or a live fetch.
function composeResponseData(costData, isCurrentMonth, daysInMonth, attribution, budget, fixedCosts, syncedAt, fromSyncCache, reconciliation, unverifiable) {
  return {
    ...costData,
    totals: {
      ...costData.totals,
      subscriptions: costData.totals.subscriptions + fixedCosts.total,
      combined: costData.totals.combined + fixedCosts.total,
    },
    // Fixed costs fold into the month total and the subscriptions list —
    // never into `days` (they aren't daily spend, and inventing a per-day
    // slice for a flat subscription would be a lie the chart tells).
    // Annual rows are shown here already divided by 12 (see lib/fixedCosts.js's
    // rowContribution) — that math doesn't change, but `amortized`/
    // `annual_usd`/`bills_on` let the dashboard mark the row so it doesn't
    // read as a monthly charge the customer's card statement won't match.
    subscriptions: [
      ...costData.subscriptions,
      ...fixedCosts.rows.map(r => ({
        provider: null,
        name: r.seats > 1 ? `${r.label} (×${r.seats})` : r.label,
        amount_usd: r.amount_usd,
        manual: true,
        amortized: r.billing_period === "annual",
        annual_usd: r.billing_period === "annual" ? r.unit_cost_usd * r.seats : null,
        bills_on: r.billing_period === "annual" ? r.started_on : null,
      })),
    ].sort((a, b) => b.amount_usd - a.amount_usd),
    summary: buildSummary(costData.days, budget, isCurrentMonth, daysInMonth, fixedCosts.total),
    attribution,
    synced_at: syncedAt,
    from_sync_cache: fromSyncCache,
    // Most recent known reconciliation status per provider (see
    // lib/reconcile.js), independent of which month is being viewed — the
    // dashboard shows a drift banner if any entry is 'drift'. Compact: just
    // enough to name the month/provider/amount, not the full stored/live
    // numbers (that's what the on-demand action is for).
    reconciliation,
    // Providers whose last 3 consecutive reconciliation runs were all
    // 'unchecked' — a live fetch that fails every time looks identical to a
    // healthy one if only `reconciliation`'s latest-status is surfaced, so
    // this is a separate, deliberately different signal: unknown, not wrong.
    unverifiable,
  };
}

// Reconstructs this month's cost data entirely from daily_costs/
// monthly_attribution — no provider call. Only used once the caller has
// already confirmed cost_sync_state is usable (see handle() below).
async function buildDataFromStore(userId, month, configuredProviders, syncState, budget, fixedCosts, reconciliation, unverifiable) {
  const [dailyRows, attributionRows] = await Promise.all([
    timing.mark("store:daily_costs", () => getDailyCostRows(userId, month)),
    timing.mark("store:monthly_attribution", () => getMonthlyAttributionRows(userId, month)),
  ]);

  const rawCostData = costDataFromStoredRows(dailyRows, month, new Date(), configuredProviders, syncState.providersSucceeded);
  const { dayModels, projects, isCurrentMonth, daysInMonth, providerRawUsd, ...costData } = rawCostData;
  const attribution = attributionRows.sort((a, b) => b.amount_usd - a.amount_usd);

  return composeResponseData(costData, isCurrentMonth, daysInMonth, attribution, budget, fixedCosts, syncState.synced_at, true, reconciliation, unverifiable);
}

async function handle(req, res, handlerStart, coldStart, debugTiming) {
  // Logged as structured JSON (for tailing `vercel logs`) and also handed
  // back under `_timing` in the response body so it shows up in the browser
  // — only when debug timing was requested for this call.
  function finish(status, body, cacheHit) {
    if (!debugTiming) {
      res.status(status).json(body);
      return;
    }
    const totalMs = performance.now() - handlerStart;
    const _timing = {
      coldStart,
      cacheHit,
      totalMs: Math.round(totalMs * 100) / 100,
      marks: timing.snapshot(),
    };
    console.log(JSON.stringify({ event: "costs_handler", status, ..._timing }));
    res.status(status).json({ ...body, _timing });
  }

  try {
    // Local dev without a service role key can't look up per-user keys (or
    // the sync tables) at all, so it keeps behaving like the pre-auth
    // env-var-only setup: always a live fetch, never Supabase.
    const localDevFallback = !process.env.SUPABASE_SERVICE_ROLE_KEY;
    const user = await timing.mark("verify_user", () => verifyUser(req.headers.authorization).catch(() => null));

    const now = Date.now();
    const nowMonth = currentMonthStr(new Date(now));
    const requestedMonth = typeof req.query?.month === "string" && MONTH_RE.test(req.query.month) ? req.query.month : null;
    const month = requestedMonth || nowMonth;
    const isClosedMonth = month < nowMonth;

    const cacheKey = `${user?.id || "env"}:${month}`;
    // Set by the dashboard right after a key was connected/disconnected on
    // Integrations, so that change shows up immediately instead of waiting
    // out a cached response computed from the old set of keys.
    const forceRefresh = req.query?.refresh === "1";

    const cached = cache.get(cacheKey);
    if (!forceRefresh && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      finish(200, { ...cached.data, cached: true, cachedAt: new Date(cached.fetchedAt).toISOString() }, true);
      return;
    }

    const overrides = localDevFallback ? {} : await timing.mark("overrides", () => resolveOverrides(user?.id));

    if (!localDevFallback && Object.keys(overrides).length === 0) {
      // Nothing connected, nothing to fetch — and deliberately not cached,
      // so connecting a key on Integrations shows up on the next load
      // instead of waiting out a stale "no keys" response.
      finish(200, {
        no_keys: true,
        providers: [],
        days: [],
        totals: { combined: 0, usage: 0, subscriptions: 0 },
        errors: {},
        models: [],
        subscriptions: [],
        summary: null,
        attribution: [],
        reconciliation: [],
        unverifiable: [],
        month,
        cached: false,
        cachedAt: new Date(now).toISOString(),
      }, false);
      return;
    }

    const configuredProviders = Object.keys(overrides);

    // Budget/fixed-costs/reconciliation are all user-scoped only (not
    // month-source-dependent), so they're resolved once up front and reused
    // by whichever cost-data path below actually runs. Reconciliation status
    // is independent of which month is being viewed — it's "the last thing
    // the nightly check found," not scoped to `month` — so it's skipped
    // entirely for local dev/anonymous requests, same as the tables it reads.
    const [budget, fixedCosts, reconciliationStatus] = await Promise.all([
      timing.mark("budget", () => resolveBudget(user?.id)),
      timing.mark("fixedCosts", () => resolveFixedCosts(user?.id, month)),
      timing.mark("reconciliation", () => (!localDevFallback && user?.id
        ? getReconciliationStatus(user.id).catch((e) => {
          console.warn(`Could not load reconciliation status: ${e.message}`);
          return { latest: [], unverifiable: [] };
        })
        : Promise.resolve({ latest: [], unverifiable: [] }))),
    ]);
    const reconciliationCompact = reconciliationStatus.latest.map(r => ({
      month: r.month, provider: r.provider, status: r.status, diff_usd: r.diff_usd, checked_at: r.checked_at,
    }));
    const unverifiable = reconciliationStatus.unverifiable;

    // Supabase-backed read path: a closed month never calls a provider once
    // it has ANY usable sync (it's final, so staleness doesn't matter); the
    // current month only reads from the cache when the last sync is recent
    // enough that "as of" is still a meaningful thing to show. A forced
    // refresh (right after connecting/disconnecting a key) and local dev
    // always skip this and go straight to the live fetch below.
    let syncState = null;
    if (!localDevFallback && user?.id && !forceRefresh) {
      syncState = await timing.mark("sync_state", () => getSyncState(user.id, month).catch(() => null));
    }
    const syncIsUsable = !!syncState && syncState.status !== "error";
    const syncIsFresh = syncIsUsable && (now - new Date(syncState.synced_at).getTime()) < SYNC_FRESH_MS;

    if (syncIsUsable && (isClosedMonth || syncIsFresh)) {
      const data = await buildDataFromStore(user.id, month, configuredProviders, syncState, budget, fixedCosts, reconciliationCompact, unverifiable);
      cache.set(cacheKey, { data, fetchedAt: now });
      finish(200, { ...data, cached: false, cachedAt: new Date(now).toISOString() }, false);
      return;
    }

    // Live fetch — current month with no recent-enough sync, a closed month
    // with nothing stored yet (or whose last sync fully failed), local dev,
    // or a forced refresh. A missing closed month must never render as $0,
    // so this is the fallback for exactly that case too.
    //
    // Anthropic/OpenAI attribution doesn't depend on fetchAllCosts()'s
    // result (only Google's does, via `projects` below), so it starts
    // immediately here instead of waiting for the chart fetch to finish.
    const [rawCostData, providerAttributionResult] = await Promise.all([
      timing.mark("fetchAllCosts", () => fetchAllCosts(overrides, localDevFallback, month)),
      timing.mark("attribution", () => fetchProviderAttribution(overrides, localDevFallback, month).catch((e) => {
        console.warn(`Could not load attribution: ${e.message}`);
        return { attribution: [], errors: {} };
      })),
    ]);
    // dayModels is only needed to sync into daily_costs below — not sent to
    // the browser. projects (Google-only) feeds into attribution below
    // instead of going out under its own key. isCurrentMonth/daysInMonth
    // feed buildSummary but aren't useful to the browser, which already
    // knows which month it asked for.
    const { dayModels, projects, isCurrentMonth, daysInMonth, providerRawUsd, ...costData } = rawCostData;
    // Same combined sort fetchAttribution() used to apply itself — anthropic
    // rows, then openai, then google, all re-sorted by amount descending.
    const googleAttribution = buildGoogleAttribution(projects);
    const attribution = [...providerAttributionResult.attribution, ...googleAttribution].sort((a, b) => b.amount_usd - a.amount_usd);

    const data = composeResponseData(costData, isCurrentMonth, daysInMonth, attribution, budget, fixedCosts, new Date(now).toISOString(), false, reconciliationCompact, unverifiable);
    cache.set(cacheKey, { data, fetchedAt: now });
    finish(200, { ...data, cached: false, cachedAt: new Date(now).toISOString() }, false);

    // Store what was just fetched — never for local dev (no Supabase) or an
    // anonymous request (nothing to scope the write to). Runs after the
    // response is already sent (the dashboard doesn't wait on this), but the
    // handler stays alive until it finishes rather than racing a frozen
    // function instance; this is what makes a closed month with nothing
    // stored yet self-heal into the fast cache-read path on its next load,
    // and what keeps the current month's sync warm for the next request.
    if (!localDevFallback && user?.id) {
      await storeSyncResult(user.id, month, {
        configuredProviders, rawCostData,
        attribution: [...providerAttributionResult.attribution, ...googleAttribution],
        attributionErrors: providerAttributionResult.errors,
      }).catch((err) => console.warn(`Could not sync costs for ${user.id} ${month}: ${err.message}`));
    }
  } catch (err) {
    finish(500, { error: err.message }, false);
  }
}
