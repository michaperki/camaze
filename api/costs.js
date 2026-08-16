// camaze — minimal AI spend tracker.
// Vercel serverless function: proxies each provider's cost API so keys stay server-side.
const { verifyUser } = require("../lib/supabase");
const { resolveOverrides, fetchAllCosts, buildSummary, resolveBudget, fetchAttribution } = require("../lib/costs");

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
        totals: { combined: 0, usage: 0, subscriptions: 0 },
        errors: {},
        models: [],
        subscriptions: [],
        summary: null,
        attribution: [],
        cached: false,
        cachedAt: new Date(now).toISOString(),
      });
      return;
    }

    const [rawCostData, budget] = await Promise.all([
      fetchAllCosts(overrides, localDevFallback),
      resolveBudget(user?.id),
    ]);
    // dayModels is only needed for the email digest — not sent to the browser.
    // projects (Google-only, from the same query) feeds into attribution
    // below instead of going out under its own key.
    const { dayModels, projects, ...costData } = rawCostData;
    const attribution = await fetchAttribution(overrides, localDevFallback, projects).catch((e) => {
      console.warn(`Could not load attribution: ${e.message}`);
      return [];
    });
    const data = { ...costData, summary: buildSummary(costData.days, budget), attribution };
    cache.set(cacheKey, { data, fetchedAt: now });
    res.status(200).json({ ...data, cached: false, cachedAt: new Date(now).toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
