// camaze — minimal AI spend tracker.
// Vercel serverless function: proxies each provider's cost API so keys stay server-side.
const { verifyUser } = require("../lib/supabase");
const { resolveOverrides, fetchAllCosts, buildSummary, resolveBudget, fetchAttribution } = require("../lib/costs");

const CACHE_TTL_MS = 5 * 60 * 1000;
// Keyed per user+month (or "env" for anonymous/env-var requests) — a shared
// cache would otherwise serve one user's provider totals to another, and a
// shared key across months would serve one month's numbers for another.
const cache = new Map(); // cacheKey -> { data, fetchedAt }

const MONTH_RE = /^\d{4}-\d{2}$/;

function currentMonthStr(now) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

module.exports = async (req, res) => {
  try {
    // Local dev without a service role key can't look up per-user keys at
    // all, so it keeps behaving like the pre-auth env-var-only setup.
    const localDevFallback = !process.env.SUPABASE_SERVICE_ROLE_KEY;
    const user = await verifyUser(req.headers.authorization).catch(() => null);

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
        month,
        cached: false,
        cachedAt: new Date(now).toISOString(),
      });
      return;
    }

    const [rawCostData, budget] = await Promise.all([
      fetchAllCosts(overrides, localDevFallback, month),
      resolveBudget(user?.id),
    ]);
    // dayModels is only needed for the email digest — not sent to the browser.
    // projects (Google-only, from the same query) feeds into attribution
    // below instead of going out under its own key. isCurrentMonth/
    // daysInMonth feed buildSummary but aren't useful to the browser, which
    // already knows which month it asked for.
    const { dayModels, projects, isCurrentMonth, daysInMonth, ...costData } = rawCostData;
    const attribution = await fetchAttribution(overrides, localDevFallback, projects, month).catch((e) => {
      console.warn(`Could not load attribution: ${e.message}`);
      return [];
    });
    const data = { ...costData, summary: buildSummary(costData.days, budget, isCurrentMonth, daysInMonth), attribution };
    cache.set(cacheKey, { data, fetchedAt: now });
    res.status(200).json({ ...data, cached: false, cachedAt: new Date(now).toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
