// Anthropic Admin API cost report -> normalized [{ date, provider, amount_usd }]
const crypto = require("node:crypto");
const { resolvePrice, warnUnknownModel, ensurePricesLoaded } = require("../lib/pricing");
const timing = require("../lib/timing");

const ORG_BASE = "https://api.anthropic.com/v1/organizations";
const API_URL = `${ORG_BASE}/cost_report`;

// `start`/`end`: Date objects, end exclusive. `keyOverride`: use this key
// instead of the env var (per-user keys). Throws on missing key or API
// error. Returns { days, models } — both derived from the same request.
async function fetchCosts(start, end, keyOverride) {
  const key = keyOverride || process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) throw new Error("ANTHROPIC_ADMIN_KEY is not set in .env");

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

  const dayModels = [];
  for (const [date, dayMap] of centsByDayModel) {
    for (const [model, cents] of dayMap) {
      dayModels.push({ date, model, amount_usd: cents / 100 });
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

// Estimated dollars per API key, derived from usage_report/messages — the
// only Anthropic endpoint that breaks usage down by api_key_id. It reports
// tokens, not cost, so this multiplies through the same flat price map used
// everywhere else, ignoring prompt-cache discount tiers. Grouping by
// workspace_id and model too (alongside api_key_id) costs nothing extra —
// one request either way — but only api_key_id is used here; the real,
// non-estimated workspace total comes from fetchWorkspaceCosts above.
//
// A model with no price-map entry never drops its usage — it's folded into
// the key's `unpriced` bucket (raw token counts, no dollar figure) instead
// of being silently priced at $0 and vanishing. See lib/pricing.js.
//
// Awaits the LiteLLM price load once, up front — unlike the gateway's
// request-time estimateCost, this call is already making several sequential
// admin-API round trips, so paying for one more (Supabase, or occasionally
// a GitHub fetch) here is cheap, and it means the very first dashboard load
// on a cold container gets current prices instead of overrides-only.
async function fetchApiKeyUsageEstimate(start, end, key) {
  await ensurePricesLoaded();

  const byApiKey = new Map(); // id -> { amountUsd, unpriced, unpricedModels: Set, unpricedInputTokens, unpricedOutputTokens }
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
    if (page) params.set("page", page);

    const res = await timing.mark("anthropic:usage_report_request", () => fetch(`${ORG_BASE}/usage_report/messages?${params}`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }));
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error?.message || `HTTP ${res.status} from Anthropic API (usage_report)`);
    }

    for (const bucket of body.data || []) {
      for (const item of bucket.results || []) {
        // Workbench usage has no api_key_id — nothing to attribute it to.
        if (!item.api_key_id) continue;
        const inputTokens =
          (item.uncached_input_tokens || 0) +
          (item.cache_read_input_tokens || 0) +
          (item.cache_creation?.ephemeral_1h_input_tokens || 0) +
          (item.cache_creation?.ephemeral_5m_input_tokens || 0);
        const outputTokens = item.output_tokens || 0;

        const entry = byApiKey.get(item.api_key_id) || {
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
        byApiKey.set(item.api_key_id, entry);
      }
    }
    page = body.has_more ? body.next_page : null;
  } while (page);

  return byApiKey;
}

// [{ provider, scope, id, name, amount_usd, estimated, unpriced, unpricedModels, unpricedTokens }]
// — workspace rows are real dollars (cost_report), api_key rows are
// token-derived estimates (usage_report/messages has no dollar figure).
// `start`/`end`: Date objects.
async function fetchAttribution(start, end, keyOverride) {
  const key = keyOverride || process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) throw new Error("ANTHROPIC_ADMIN_KEY is not set in .env");

  const [byWorkspace, byApiKey] = await Promise.all([
    fetchWorkspaceCosts(start, end, key),
    fetchApiKeyUsageEstimate(start, end, key),
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
        estimated: true,
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

module.exports = { name: "anthropic", label: "Anthropic", fetchCosts, validateKey, fetchAttribution };
