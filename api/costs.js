// camaze — minimal AI spend tracker.
// Vercel serverless function: proxies each provider's cost API so keys stay server-side.
const { verifyUser } = require("../lib/supabase");
const { resolveOverrides, fetchAllCosts, buildSummary, resolveBudget, resolveFixedCosts, fetchProviderAttribution, buildGoogleAttribution } = require("../lib/costs");
const timing = require("../lib/timing");
const { performance } = require("node:perf_hooks");

const CACHE_TTL_MS = 5 * 60 * 1000;
// Keyed per user+month (or "env" for anonymous/env-var requests) — a shared
// cache would otherwise serve one user's provider totals to another, and a
// shared key across months would serve one month's numbers for another.
const cache = new Map(); // cacheKey -> { data, fetchedAt }

const MONTH_RE = /^\d{4}-\d{2}$/;

function currentMonthStr(now) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// True on this container's very first invocation, false on every later one
// — the standard cold-start tell for a serverless module that stays warm
// (and keeps `cache` above populated) between requests.
let warmedUp = false;

module.exports = async (req, res) => {
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
    // Local dev without a service role key can't look up per-user keys at
    // all, so it keeps behaving like the pre-auth env-var-only setup.
    const localDevFallback = !process.env.SUPABASE_SERVICE_ROLE_KEY;
    const user = await timing.mark("verify_user", () => verifyUser(req.headers.authorization).catch(() => null));

    const now = Date.now();
    const requestedMonth = typeof req.query?.month === "string" && MONTH_RE.test(req.query.month) ? req.query.month : null;
    const month = requestedMonth || currentMonthStr(new Date(now));

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
        month,
        cached: false,
        cachedAt: new Date(now).toISOString(),
      }, false);
      return;
    }

    // Anthropic/OpenAI attribution doesn't depend on fetchAllCosts()'s
    // result (only Google's does, via `projects` below), so it starts
    // immediately here instead of waiting for the chart fetch to finish —
    // all three overlap. fixedCosts (manually-entered subscriptions/seats,
    // see lib/fixedCosts.js) is user-scoped only, so it overlaps too.
    const [rawCostData, budget, providerAttribution, fixedCosts] = await Promise.all([
      timing.mark("fetchAllCosts", () => fetchAllCosts(overrides, localDevFallback, month)),
      timing.mark("budget", () => resolveBudget(user?.id)),
      timing.mark("attribution", () => fetchProviderAttribution(overrides, localDevFallback, month).catch((e) => {
        console.warn(`Could not load attribution: ${e.message}`);
        return [];
      })),
      timing.mark("fixedCosts", () => resolveFixedCosts(user?.id, month)),
    ]);
    // dayModels is only needed for the email digest — not sent to the browser.
    // projects (Google-only, from the same query) feeds into attribution
    // below instead of going out under its own key. isCurrentMonth/
    // daysInMonth feed buildSummary but aren't useful to the browser, which
    // already knows which month it asked for.
    const { dayModels, projects, isCurrentMonth, daysInMonth, ...costData } = rawCostData;
    // Same combined sort fetchAttribution() used to apply itself — anthropic
    // rows, then openai, then google, all re-sorted by amount descending.
    const attribution = [...providerAttribution, ...buildGoogleAttribution(projects)].sort((a, b) => b.amount_usd - a.amount_usd);
    // Fixed costs fold into the month total and the subscriptions list —
    // never into `days` (they aren't daily spend, and inventing a per-day
    // slice for a flat subscription would be a lie the chart tells).
    const data = {
      ...costData,
      totals: {
        ...costData.totals,
        subscriptions: costData.totals.subscriptions + fixedCosts.total,
        combined: costData.totals.combined + fixedCosts.total,
      },
      subscriptions: [
        ...costData.subscriptions,
        ...fixedCosts.rows.map(r => ({
          provider: null,
          name: r.seats > 1 ? `${r.label} (×${r.seats})` : r.label,
          amount_usd: r.amount_usd,
          manual: true,
        })),
      ].sort((a, b) => b.amount_usd - a.amount_usd),
      summary: buildSummary(costData.days, budget, isCurrentMonth, daysInMonth, fixedCosts.total),
      attribution,
    };
    cache.set(cacheKey, { data, fetchedAt: now });
    finish(200, { ...data, cached: false, cachedAt: new Date(now).toISOString() }, false);
  } catch (err) {
    finish(500, { error: err.message }, false);
  }
}
