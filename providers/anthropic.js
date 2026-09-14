// Anthropic Admin API cost report -> normalized [{ date, provider, amount_usd }]
const crypto = require("node:crypto");
const { resolvePrice, warnUnknownModel, ensurePricesLoaded } = require("../lib/pricing");
const timing = require("../lib/timing");

const ORG_BASE = "https://api.anthropic.com/v1/organizations";
const API_URL = `${ORG_BASE}/cost_report`;

// Same reduction estimateDayFromUsage() applies per key — collapsed here
// into a shared helper since fetchUsageTotalsByDay needs the identical
// arithmetic at the (date, model) level instead of (date, api_key). Cache
// read/write and uncached input are folded into one inputTokens number
// because lib/insights/catalog.js has no separate cache price to apply to
// them anyway — same simplification estimateDayFromUsage already made.
function sumTokens(item) {
  const inputTokens =
    (item.uncached_input_tokens || 0) +
    (item.cache_read_input_tokens || 0) +
    (item.cache_creation?.ephemeral_1h_input_tokens || 0) +
    (item.cache_creation?.ephemeral_5m_input_tokens || 0);
  const outputTokens = item.output_tokens || 0;
  return { inputTokens, outputTokens };
}

// The cost_report pagination loop that used to live directly in fetchCosts,
// extracted so fetchCosts can run it alongside fetchUsageTotalsByDay instead
// of sequentially.
async function fetchCostReportTotals(start, end, key) {
  const centsByDay = new Map();
  const centsByModel = new Map();
  const centsByDayModel = new Map(); // day -> Map(model -> cents)
  let page = null;
  do {
    const params = new URLSearchParams({
      starting_at: start.toISOString(),
      ending_at: end.toISOString(),
      bucket_width: "1d",
      limit: "31",
    });
    // "model" isn't a valid group_by on its own, but grouping by description
    // is what makes the API populate per-line-item fields (model included) —
    // without any group_by, results come back as one pre-aggregated row per
    // day with everything (including model) null.
    params.append("group_by[]", "description");
    if (page) params.set("page", page);

    const res = await timing.mark("anthropic:cost_report_request", () => fetch(`${API_URL}?${params}`, {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    }));
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error?.message || `HTTP ${res.status} from Anthropic API`);
    }

    for (const bucket of body.data || []) {
      const day = bucket.starting_at.slice(0, 10);
      let cents = centsByDay.get(day) || 0;
      for (const item of bucket.results || []) {
        // Coerce at the boundary — amount is a decimal string in cents.
        const value = Number(item.amount ?? 0);
        if (!Number.isFinite(value)) {
          throw new Error(`Anthropic returned a non-numeric amount for ${day}: ${JSON.stringify(item.amount)}`);
        }
        cents += value;
        if (item.model) {
          centsByModel.set(item.model, (centsByModel.get(item.model) || 0) + value);
          if (!centsByDayModel.has(day)) centsByDayModel.set(day, new Map());
          const dayMap = centsByDayModel.get(day);
          dayMap.set(item.model, (dayMap.get(item.model) || 0) + value);
        }
      }
      centsByDay.set(day, cents);
    }
    page = body.has_more ? body.next_page : null;
  } while (page);

  return { centsByDay, centsByModel, centsByDayModel };
}

// usage_report/messages, grouped by model/service_tier/context_window only
// (no api_key_id) — daily_costs is keyed by model, not by API key, so
// fetchUsageByDay's per-key breakdown (used for attribution) isn't reusable
// here without a bigger refactor of how fetchCosts/fetchAttribution share
// data. One extra paginated call per sync. Best-effort: a failure here must
// never take down the dollar sync fetchCosts exists for, so callers treat
// a thrown error as "no token data this sync" rather than propagating it.
async function fetchUsageTotalsByDay(start, end, key) {
  const byDay = new Map(); // date -> Map(model -> { inputTokens, outputTokens })
  let page = null;
  do {
    const params = new URLSearchParams({
      starting_at: start.toISOString(),
      ending_at: end.toISOString(),
      bucket_width: "1d",
      limit: "31",
    });
    params.append("group_by[]", "model");
    params.append("group_by[]", "service_tier");
    params.append("group_by[]", "context_window");
    if (page) params.set("page", page);

    const res = await timing.mark("anthropic:usage_report_totals_request", () => fetch(`${ORG_BASE}/usage_report/messages?${params}`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }));
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error?.message || `HTTP ${res.status} from Anthropic API (usage_report)`);
    }

    for (const bucket of body.data || []) {
      const date = bucket.starting_at.slice(0, 10);
      const dayMap = byDay.get(date) || new Map();
      for (const item of bucket.results || []) {
        if (!item.model) continue;
        const { inputTokens, outputTokens } = sumTokens(item);
        const entry = dayMap.get(item.model) || { inputTokens: 0, outputTokens: 0 };
        entry.inputTokens += inputTokens;
        entry.outputTokens += outputTokens;
        dayMap.set(item.model, entry);
      }
      byDay.set(date, dayMap);
    }
    page = body.has_more ? body.next_page : null;
  } while (page);

  return byDay;
}

// `start`/`end`: Date objects, end exclusive. `keyOverride`: use this key
// instead of the env var (per-user keys). Throws on missing key or API
// error. Returns { days, models, dayModels } — all derived from the same
// cost_report request, plus a best-effort token breakdown per dayModels
// entry (null/null if the usage_report side failed or had no matching row).
async function fetchCosts(start, end, keyOverride) {
  const key = keyOverride || process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) throw new Error("ANTHROPIC_ADMIN_KEY is not set in .env");

  const [{ centsByDay, centsByModel, centsByDayModel }, usageTotalsByDay] = await Promise.all([
    fetchCostReportTotals(start, end, key),
    fetchUsageTotalsByDay(start, end, key).catch(error => {
      console.error(`[anthropic] usage_report token fetch failed, dayModels will have no token counts: ${error.message}`);
      return new Map();
    }),
  ]);

  const dayModels = [];
  for (const [date, dayMap] of centsByDayModel) {
    const usageForDay = usageTotalsByDay.get(date);
    for (const [model, cents] of dayMap) {
      const tokens = usageForDay?.get(model);
      dayModels.push({
        date, model, amount_usd: cents / 100,
        input_tokens: tokens?.inputTokens ?? null,
        output_tokens: tokens?.outputTokens ?? null,
      });
    }
  }

  return {
    days: [...centsByDay].map(([date, cents]) => ({
      date,
      provider: "anthropic",
      amount_usd: cents / 100,
    })),
    models: [...centsByModel].map(([model, cents]) => ({
      model,
      amount_usd: cents / 100,
    })),
    dayModels,
  };
}

// The Admin API (and thus admin keys) doesn't exist for personal Anthropic
// accounts — only for accounts that have set up an organization. Anthropic
// reports that as a permission/not-found style error, not anything that
// names "organization" itself, so callers would otherwise see a confusing
// raw API message with no indication of the actual fix.
function isOrgRequiredError(status, body) {
  const type = body?.error?.type;
  const message = body?.error?.message || "";
  if (type === "permission_error" || status === 403) return true;
  if (status === 404 && /organization/i.test(message)) return true;
  return false;
}

const ORG_REQUIRED_MESSAGE =
  "This key doesn't have access to the Admin API. Admin keys require your Anthropic account to have an organization — go to Settings → Organization in the Anthropic Console, create one if you haven't already, then generate a new admin key.";

// Minimal authenticated request — confirms a key works before it's saved,
// without pulling a full cost report. Throws with the API's error message.
async function validateKey(key) {
  // starting_at must be day-aligned (bucket_width=1d), or the API rejects
  // the implied [starting_at, now] range as inverted.
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const params = new URLSearchParams({
    starting_at: yesterday.toISOString(),
    bucket_width: "1d",
    limit: "1",
  });
  const res = await fetch(`${API_URL}?${params}`, {
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
  });
  if (res.ok) return;
  const body = await res.json().catch(() => null);
  if (isOrgRequiredError(res.status, body)) throw new Error(ORG_REQUIRED_MESSAGE);
  throw new Error(body?.error?.message || `HTTP ${res.status} from Anthropic API`);
}

// In-memory name caches for API keys and workspaces, keyed by a hash of the
// admin key (different users/orgs have disjoint ID spaces). They "change
// rarely" per the product requirement, so there's no TTL — a rename just
// won't show up until the next cold start.
const apiKeyNameCache = new Map(); // hashedKey -> Map(id -> name)
const workspaceNameCache = new Map(); // hashedKey -> Map(id -> name)

function cacheKeyFor(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

// Paginates GET /v1/organizations/api_keys (or /workspaces) via after_id/
// has_more/last_id into an id -> name Map.
async function listNames(path, key) {
  const names = new Map();
  let afterId = null;
  do {
    const params = new URLSearchParams({ limit: "1000" });
    if (afterId) params.set("after_id", afterId);
    const res = await timing.mark(`anthropic:${path}_names_request`, () => fetch(`${ORG_BASE}/${path}?${params}`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }));
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error?.message || `HTTP ${res.status} from Anthropic API (${path})`);
    }
    for (const row of body.data || []) names.set(row.id, row.name);
    afterId = body.has_more ? body.last_id : null;
  } while (afterId);
  return names;
}

async function resolveApiKeyNames(key) {
  const cacheKey = cacheKeyFor(key);
  if (!apiKeyNameCache.has(cacheKey)) apiKeyNameCache.set(cacheKey, await listNames("api_keys", key));
  return apiKeyNameCache.get(cacheKey);
}

async function resolveWorkspaceNames(key) {
  const cacheKey = cacheKeyFor(key);
  if (!workspaceNameCache.has(cacheKey)) workspaceNameCache.set(cacheKey, await listNames("workspaces", key));
  return workspaceNameCache.get(cacheKey);
}

// Real dollars per workspace, from cost_report grouped by workspace_id alone
// (a dimension cost_report actually supports). Separate call from fetchCosts
// above so the existing day/model chart query is untouched.
async function fetchWorkspaceCosts(start, end, key) {
  const byWorkspace = new Map(); // id ("default" for null) -> cents
  let page = null;
  do {
    const params = new URLSearchParams({
      starting_at: start.toISOString(),
      ending_at: end.toISOString(),
      bucket_width: "1d",
      limit: "31",
    });
    params.append("group_by[]", "workspace_id");
    if (page) params.set("page", page);

    const res = await timing.mark("anthropic:workspace_cost_request", () => fetch(`${API_URL}?${params}`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }));
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error?.message || `HTTP ${res.status} from Anthropic API (cost_report)`);
    }

    for (const bucket of body.data || []) {
      for (const item of bucket.results || []) {
        const cents = Number(item.amount ?? 0);
        if (!Number.isFinite(cents)) continue;
        const id = item.workspace_id || "default";
        byWorkspace.set(id, (byWorkspace.get(id) || 0) + cents);
      }
    }
    page = body.has_more ? body.next_page : null;
  } while (page);

  return byWorkspace;
}

// cost_report's `token_type` (a string on each line item) doesn't share a
// name with any single usage_report field — usage_report spreads the same
// concept across parallel numeric fields (one of them nested, under
// cache_creation). This is the map between the two vocabularies: given a
// cost line's token_type, which usage_report field on a row measures "how
// many of that exact kind of token did this row account for" — i.e. the
// weight to split that line's dollars by.
const TOKEN_TYPE_TO_USAGE_FIELD = {
  uncached_input_tokens: (r) => r.uncached_input_tokens || 0,
  output_tokens: (r) => r.output_tokens || 0,
  cache_read_input_tokens: (r) => r.cache_read_input_tokens || 0,
  "cache_creation.ephemeral_5m_input_tokens": (r) => r.cache_creation?.ephemeral_5m_input_tokens || 0,
  "cache_creation.ephemeral_1h_input_tokens": (r) => r.cache_creation?.ephemeral_1h_input_tokens || 0,
};

// Splits `amountUsd` across `weightedKeys` ([{ key, weight }], weight > 0)
// proportionally to weight, guaranteed BY CONSTRUCTION — not by floating-
// point luck — to sum back to exactly `amountUsd`: every share except the
// largest is computed independently (amountUsd * weight/totalWeight); the
// largest share absorbs whatever's left (amountUsd - sum of the others)
// instead of being computed the same way and risking a lost or duplicated
// fraction of a cent. This is the "carry the residual to the largest share"
// approach — simpler than largest-remainder-in-cents and a better fit for a
// codebase that keeps dollar amounts as plain floats everywhere else (see
// fetchCosts above), never as integer cents.
function splitByShare(amountUsd, weightedKeys) {
  const totalWeight = weightedKeys.reduce((sum, w) => sum + w.weight, 0);
  const sorted = [...weightedKeys].sort((a, b) => b.weight - a.weight);
  const [largest, ...rest] = sorted;
  const shares = new Map();
  let sumOfRest = 0;
  for (const { key, weight } of rest) {
    const amt = amountUsd * (weight / totalWeight);
    shares.set(key, (shares.get(key) || 0) + amt);
    sumOfRest += amt;
  }
  shares.set(largest.key, (shares.get(largest.key) || 0) + (amountUsd - sumOfRest));
  return shares;
}

// Real per-key dollars for one day, joining cost_report's line items to
// usage_report's rows on (model, service_tier, context_window) — the fields
// both endpoints expose in the same shape — and splitting each line's
// dollars across the api_key_id rows that share that (model, tier, window)
// by their share of the specific token_type the line refers to. Never a
// blended/combined-token split: output tokens price ~5x input, so weighting
// two keys' shares by e.g. total token count would move real dollars
// between keys relative to their actual usage.
//
// Logs loudly (never throws — a malformed or surprising provider response
// here shouldn't take down the whole attribution fetch) in two situations:
// a cost line has no matching usage_report tokens to split by (nothing to
// attribute it to — most likely Workbench usage, which has no api_key_id,
// or an unrecognized token_type), and the day's per-key sum doesn't
// reconcile to the day's cost_report total. The latter should be
// mathematically impossible given splitByShare's construction UNLESS a line
// hit the first case and got skipped — but it's asserted independently
// rather than assumed, so a future bug here can't fail silently.
function allocateDayFromCostReport(date, costLines, usageRows) {
  let dayTotalUsd = 0;
  const dayByKey = new Map();

  for (const line of costLines) {
    dayTotalUsd += line.amountUsd;
    const field = TOKEN_TYPE_TO_USAGE_FIELD[line.token_type];
    if (!field) {
      console.error(
        `[anthropic attribution] ${date}: unrecognized token_type "${line.token_type}" on a ` +
        `cost_report line for model "${line.model}" ($${line.amountUsd}) — cannot attribute, skipping.`
      );
      continue;
    }

    const weightedKeys = usageRows
      .filter(r => r.api_key_id && r.model === line.model && r.service_tier === line.service_tier && r.context_window === line.context_window)
      .map(r => ({ key: r.api_key_id, weight: field(r) }))
      .filter(w => w.weight > 0);

    if (weightedKeys.length === 0) {
      console.error(
        `[anthropic attribution] ${date}: no matching usage_report tokens for cost_report line ` +
        `(model="${line.model}" token_type="${line.token_type}" service_tier="${line.service_tier}" ` +
        `context_window="${line.context_window}") — $${line.amountUsd} could not be attributed to any key.`
      );
      continue;
    }

    for (const [apiKeyId, amt] of splitByShare(line.amountUsd, weightedKeys)) {
      dayByKey.set(apiKeyId, (dayByKey.get(apiKeyId) || 0) + amt);
    }
  }

  const daySum = [...dayByKey.values()].reduce((sum, v) => sum + v, 0);
  if (Math.abs(daySum - dayTotalUsd) > 1e-9) {
    console.error(
      `[anthropic attribution] ${date}: reconciliation mismatch — per-key sum $${daySum} vs ` +
      `cost_report total $${dayTotalUsd} (diff $${(daySum - dayTotalUsd).toFixed(6)}).`
    );
  }

  return dayByKey;
}

// Estimated per-key dollars for one day, derived from usage_report/messages
// token counts through the same flat price map used everywhere else —
// ignoring prompt-cache discount tiers. This is the fallback for a day
// cost_report has no data for yet (see fetchCostReportLinesByDay below):
// today, always (cost_report rejects any range ending inside the current
// UTC day — see there), and any other day whose billing hasn't landed yet.
//
// A model with no price-map entry never drops its usage — it's folded into
// the key's `unpriced` bucket (raw token counts, no dollar figure) instead
// of being silently priced at $0 and vanishing. See lib/pricing.js.
function estimateDayFromUsage(usageRows) {
  const byKey = new Map(); // id -> { amountUsd, unpriced, unpricedModels: Set, unpricedInputTokens, unpricedOutputTokens }
  for (const item of usageRows) {
    // Workbench usage has no api_key_id — nothing to attribute it to.
    if (!item.api_key_id) continue;
    const { inputTokens, outputTokens } = sumTokens(item);

    const entry = byKey.get(item.api_key_id) || {
      amountUsd: 0,
      unpriced: false,
      unpricedModels: new Set(),
      unpricedInputTokens: 0,
      unpricedOutputTokens: 0,
    };

    const prices = resolvePrice("anthropic", item.model);
    if (prices) {
      const [inPrice, outPrice] = prices;
      entry.amountUsd += (inputTokens / 1_000_000) * inPrice + (outputTokens / 1_000_000) * outPrice;
    } else {
      warnUnknownModel("anthropic", item.model);
      entry.unpriced = true;
      if (item.model) entry.unpricedModels.add(item.model);
      entry.unpricedInputTokens += inputTokens;
      entry.unpricedOutputTokens += outputTokens;
    }
    byKey.set(item.api_key_id, entry);
  }
  return byKey;
}

// cost_report's line items (grouped by description, the only group_by that
// populates model/token_type/service_tier/context_window — see fetchCosts
// above), bucketed by day, for the allocation join in allocateDayFromCostReport.
//
// cost_report rejects (400 "ending date must be after starting date") any
// query where the requested range contains zero complete UTC days — in
// particular a range that starts on or after the start of today. A range
// that merely *extends into* today (the common case: "this month so far")
// is fine — verified empirically, it just never returns a bucket for
// today, silently stopping at the last complete day. So the only guard
// needed is: don't call this at all when there's no complete day to ask
// for; today (and any day past it) simply won't have an entry in the
// returned Map, which is exactly the "no cost data for this day" signal
// fetchApiKeyAllocation uses to fall back to estimateDayFromUsage.
async function fetchCostReportLinesByDay(start, end, key) {
  const byDay = new Map(); // date -> [{ amountUsd, model, token_type, service_tier, context_window }]

  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (start >= startOfToday) return byDay;

  let page = null;
  do {
    const params = new URLSearchParams({
      starting_at: start.toISOString(),
      ending_at: end.toISOString(),
      bucket_width: "1d",
      limit: "31",
    });
    params.append("group_by[]", "description");
    if (page) params.set("page", page);

    const res = await timing.mark("anthropic:cost_report_lines_request", () => fetch(`${API_URL}?${params}`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }));
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error?.message || `HTTP ${res.status} from Anthropic API (cost_report)`);
    }

    for (const bucket of body.data || []) {
      const date = bucket.starting_at.slice(0, 10);
      const lines = byDay.get(date) || [];
      for (const item of bucket.results || []) {
        // Coerce at the boundary — amount is a decimal-cents string.
        const value = Number(item.amount ?? 0);
        if (!Number.isFinite(value)) {
          throw new Error(`Anthropic returned a non-numeric cost_report amount for ${date}: ${JSON.stringify(item.amount)}`);
        }
        lines.push({
          amountUsd: value / 100,
          model: item.model,
          token_type: item.token_type,
          service_tier: item.service_tier,
          context_window: item.context_window,
        });
      }
      byDay.set(date, lines);
    }
    page = body.has_more ? body.next_page : null;
  } while (page);

  return byDay;
}

// usage_report/messages rows, bucketed by day, grouped by all four of
// api_key_id/model/service_tier/context_window in a single request — the
// last two come back null on every row otherwise (see fetchWorkspaceCosts'
// group_by[]=workspace_id-only call for the same effect in miniature), which
// would break the join in allocateDayFromCostReport. One request either way.
async function fetchUsageByDay(start, end, key) {
  const byDay = new Map(); // date -> [usage_report result row]
  let page = null;
  do {
    const params = new URLSearchParams({
      starting_at: start.toISOString(),
      ending_at: end.toISOString(),
      bucket_width: "1d",
      limit: "31",
    });
    params.append("group_by[]", "api_key_id");
    params.append("group_by[]", "model");
    params.append("group_by[]", "service_tier");
    params.append("group_by[]", "context_window");
    if (page) params.set("page", page);

    const res = await timing.mark("anthropic:usage_report_request", () => fetch(`${ORG_BASE}/usage_report/messages?${params}`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }));
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error?.message || `HTTP ${res.status} from Anthropic API (usage_report)`);
    }

    for (const bucket of body.data || []) {
      const date = bucket.starting_at.slice(0, 10);
      const rows = byDay.get(date) || [];
      for (const item of bucket.results || []) rows.push(item);
      byDay.set(date, rows);
    }
    page = body.has_more ? body.next_page : null;
  } while (page);

  return byDay;
}

function newAllocationEntry() {
  return {
    amountUsd: 0,
    estimated: false,
    unpriced: false,
    unpricedModels: new Set(),
    unpricedInputTokens: 0,
    unpricedOutputTokens: 0,
  };
}

// Per-key dollars for [start, end) — real, cost_report-allocated dollars for
// any day cost_report has data for; the pricing-table estimate (see
// estimateDayFromUsage) for any day it doesn't (today, always, plus any
// other day whose billing hasn't landed yet). A row's `estimated` flag is
// true iff *any* day in the range contributed via the fallback — the
// monthly_attribution schema has one estimated flag per key per month, not
// per day, so a row that's 29 real days and 1 fallback day still reads as
// "est." rather than silently passing off a partly-estimated figure as
// exact. amount_usd itself is the real sum either way: mostly real dollars,
// plus whatever the fallback contributed for the days it covered.
//
// Awaits the LiteLLM price load once, up front — this call already makes
// several sequential admin-API round trips, so paying for one more
// (Supabase, or occasionally a GitHub fetch) here is cheap, and it means
// the very first dashboard load on a cold container gets current prices
// instead of overrides-only for whichever days need the fallback.
async function fetchApiKeyAllocation(start, end, key) {
  await ensurePricesLoaded();

  const [costLinesByDay, usageByDay] = await Promise.all([
    fetchCostReportLinesByDay(start, end, key),
    fetchUsageByDay(start, end, key),
  ]);

  const byApiKey = new Map();
  const allDates = new Set([...costLinesByDay.keys(), ...usageByDay.keys()]);

  for (const date of allDates) {
    const costLines = costLinesByDay.get(date) || [];
    const usageRows = usageByDay.get(date) || [];

    if (costLines.length > 0) {
      for (const [id, amountUsd] of allocateDayFromCostReport(date, costLines, usageRows)) {
        const entry = byApiKey.get(id) || newAllocationEntry();
        entry.amountUsd += amountUsd;
        byApiKey.set(id, entry);
      }
    } else {
      for (const [id, dayEntry] of estimateDayFromUsage(usageRows)) {
        const entry = byApiKey.get(id) || newAllocationEntry();
        entry.amountUsd += dayEntry.amountUsd;
        entry.estimated = true;
        if (dayEntry.unpriced) {
          entry.unpriced = true;
          for (const m of dayEntry.unpricedModels) entry.unpricedModels.add(m);
          entry.unpricedInputTokens += dayEntry.unpricedInputTokens;
          entry.unpricedOutputTokens += dayEntry.unpricedOutputTokens;
        }
        byApiKey.set(id, entry);
      }
    }
  }

  return byApiKey;
}

// [{ provider, scope, id, name, amount_usd, estimated, unpriced, unpricedModels, unpricedTokens }]
// — workspace rows are always real dollars (cost_report, grouped by
// workspace_id). api_key rows are real dollars too for any day cost_report
// has data for (allocated from the actual bill — see fetchApiKeyAllocation),
// falling back to a token-derived estimate only for days it doesn't yet
// (today, always). `start`/`end`: Date objects.
async function fetchAttribution(start, end, keyOverride) {
  const key = keyOverride || process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) throw new Error("ANTHROPIC_ADMIN_KEY is not set in .env");

  const [byWorkspace, byApiKey] = await Promise.all([
    fetchWorkspaceCosts(start, end, key),
    fetchApiKeyAllocation(start, end, key),
  ]);

  const rows = [];
  if (byApiKey.size > 0) {
    const apiKeyNames = await resolveApiKeyNames(key);
    for (const [id, entry] of byApiKey) {
      rows.push({
        provider: "anthropic",
        scope: "api_key",
        id,
        name: apiKeyNames.get(id) || id,
        amount_usd: entry.amountUsd,
        estimated: entry.estimated,
        unpriced: entry.unpriced,
        unpricedModels: [...entry.unpricedModels],
        unpricedTokens: { input: entry.unpricedInputTokens, output: entry.unpricedOutputTokens },
      });
    }
  }
  if (byWorkspace.size > 0) {
    const workspaceNames = await resolveWorkspaceNames(key);
    for (const [id, cents] of byWorkspace) {
      const name = id === "default" ? "Default workspace" : (workspaceNames.get(id) || id);
      rows.push({ provider: "anthropic", scope: "workspace", id, name, amount_usd: cents / 100, estimated: false });
    }
  }
  return rows;
}

module.exports = {
  name: "anthropic", label: "Anthropic", fetchCosts, validateKey, fetchAttribution,
  // Exported additionally for tests only — not part of the provider
  // interface other modules should call.
  _internal: { splitByShare, allocateDayFromCostReport, estimateDayFromUsage, fetchApiKeyAllocation, sumTokens, fetchUsageTotalsByDay },
};
