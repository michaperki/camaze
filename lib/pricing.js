// Hybrid price map, USD per million tokens as [input, output]. Two layers:
//
//   OVERRIDES (below) — hand-verified, wins on exact conflicts
//   LiteLLM index — community-maintained base layer, covers everything we
//     haven't hand-verified (github.com/BerriAI/litellm)
//
// Used by the gateway proxy (api/gateway.js) to price a live request, and
// by the Anthropic per-API-key attribution (providers/anthropic.js) to turn
// token counts into an estimated dollar figure — Anthropic's cost_report
// endpoint has no per-key breakdown, only usage_report/messages does, and
// that one only reports tokens.
const { getPriceCache, upsertPriceCache } = require("./supabase");

// OVERRIDES exist for two reasons: (1) a correction where our own
// verification disagreed with LiteLLM at the time, or (2) a model LiteLLM
// hadn't indexed yet. They always win over the LiteLLM index on an exact
// (or stripped-suffix) match — see resolvePrice below. Re-verified against
// a live usage_report/messages probe and current public pricing on
// 2026-08-16. Known past mistakes, now fixed: "claude-haiku-4-5" was priced
// at the Haiku 4.0-era rate ($0.80/$4.00) instead of Haiku 4.5's actual
// $1.00/$5.00, and "claude-opus-4-5" carried the older Opus 4.1-era rate
// ($15.00/$75.00) — Opus pricing actually dropped to $5.00/$25.00 starting
// with 4.5, not 4.6.
const PRICE_PER_MILLION = {
  anthropic: {
    "claude-sonnet-4": [3.00, 15.00],
    "claude-sonnet-4-6": [3.00, 15.00],
    // Standard rate. Sonnet 5 also has an introductory $2.00/$10.00 rate
    // through 2026-08-31 — not used here since this map has no notion of a
    // time-limited rate; estimates during the intro window run slightly high.
    "claude-sonnet-5": [3.00, 15.00],
    "claude-haiku-4-5": [1.00, 5.00],
    "claude-opus-4-1": [15.00, 75.00],
    "claude-opus-4-5": [5.00, 25.00],
    "claude-opus-4-6": [5.00, 25.00],
    "claude-opus-4-7": [5.00, 25.00],
    "claude-opus-4-8": [5.00, 25.00],
    "claude-opus-5": [5.00, 25.00],
  },
  openai: {
    "gpt-4o": [2.50, 10.00],
    "gpt-4o-mini": [0.15, 0.60],
    "gpt-4.1": [2.00, 8.00],
    "gpt-4.1-mini": [0.40, 1.60],
    "gpt-5": [1.25, 10.00],
    "o3": [10.00, 40.00],
  },
};

// Anthropic and OpenAI both suffix some model IDs with a dated snapshot
// (claude-haiku-4-5-20251001, gpt-4.1-2025-04-14) that won't exact-match a
// bare alias. Strip one trailing -YYYYMMDD or -YYYY-MM-DD segment.
function stripDateSuffix(model) {
  return model.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICE_CACHE_ID = "litellm";
const PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// LiteLLM tracks the same model under many resale/hosting variants
// (bedrock, vertex_ai-anthropic_models, azure, openrouter, ...) with
// different — often marked-up or discounted — pricing. Only map the
// litellm_provider values for the first-party APIs our stored admin keys
// actually call; a Bedrock or Vertex rate would misrepresent what this
// account is billed.
const LITELLM_PROVIDER_MAP = {
  anthropic: "anthropic",
  openai: "openai",
};

// provider -> model -> [input, output] per million tokens, built from
// LiteLLM's raw (per-token) data. null = never attempted this process;
// {} = attempted and came up empty (fetch failed, no cache row either).
let litellmIndex = null;
let litellmLoadPromise = null; // in-flight load, shared by concurrent callers

function buildLitellmIndex(rawData) {
  const index = {};
  let count = 0;
  for (const [model, entry] of Object.entries(rawData || {})) {
    const provider = LITELLM_PROVIDER_MAP[entry?.litellm_provider];
    if (!provider) continue;
    if (typeof entry.input_cost_per_token !== "number" || typeof entry.output_cost_per_token !== "number") continue;
    if (!index[provider]) index[provider] = {};
    index[provider][model] = [entry.input_cost_per_token * 1_000_000, entry.output_cost_per_token * 1_000_000];
    count++;
  }
  return { index, count };
}

// Loads (or refreshes) the LiteLLM index: module memory -> a fresh
// price_cache row (<24h old) -> fetch from LiteLLM (writing the raw JSON
// back to price_cache) -> a stale price_cache row if the fetch failed ->
// overrides-only if nothing is available at all. Never throws — every
// branch resolves to *some* litellmIndex ({} in the worst case), so
// resolvePrice always has a table to look in.
//
// This is the only place that does real I/O for pricing. Call sites that
// can afford to wait for accurate data (the attribution fetch) should
// `await` it directly; the request-time gateway path never does — see
// resolvePrice, which only ever triggers this in the background.
async function loadLitellmIndex() {
  if (litellmIndex) return litellmIndex;
  if (litellmLoadPromise) return litellmLoadPromise;

  litellmLoadPromise = (async () => {
    let cached = null;
    try {
      cached = await getPriceCache(PRICE_CACHE_ID);
    } catch (e) {
      console.warn(`[pricing] Could not read price_cache: ${e.message}`);
    }

    const isFresh = cached && Date.now() - new Date(cached.fetched_at).getTime() < PRICE_CACHE_TTL_MS;
    if (isFresh) {
      const { index, count } = buildLitellmIndex(cached.data);
      litellmIndex = index;
      console.log(`[pricing] Loaded LiteLLM price data from cache (${count} models indexed, fetched ${cached.fetched_at})`);
      return litellmIndex;
    }

    try {
      const res = await fetch(LITELLM_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching LiteLLM price data`);
      const raw = await res.json();
      const { index, count } = buildLitellmIndex(raw);
      litellmIndex = index;
      console.log(`[pricing] Fetched fresh LiteLLM price data (${count} models indexed)`);
      // Fire-and-forget: the fetch already succeeded, so a failed cache
      // write just means the next cold start fetches again — not worth
      // blocking the caller over.
      upsertPriceCache(PRICE_CACHE_ID, raw).catch((e) =>
        console.warn(`[pricing] Could not write price_cache: ${e.message}`)
      );
      return litellmIndex;
    } catch (e) {
      if (cached) {
        const { index, count } = buildLitellmIndex(cached.data);
        litellmIndex = index;
        console.warn(
          `[pricing] LiteLLM fetch failed (${e.message}) — using stale cache from ` +
          `${cached.fetched_at} (${count} models indexed). Stale prices beat no prices.`
        );
        return litellmIndex;
      }
      console.warn(
        `[pricing] LiteLLM fetch failed (${e.message}) and no price_cache row exists — ` +
        `falling back to hand-maintained overrides only.`
      );
      litellmIndex = {};
      return litellmIndex;
    }
  })();

  try {
    return await litellmLoadPromise;
  } finally {
    litellmLoadPromise = null;
  }
}

// Explicit await point for callers that can tolerate the latency (the
// attribution fetch, not the gateway's request path) and want current
// LiteLLM data available before they start calling resolvePrice/estimateCost
// in a loop. A no-op once the index is already loaded this process.
function ensurePricesLoaded() {
  return loadLitellmIndex();
}

// Returns [inputPrice, outputPrice] per million tokens, or null if the
// model isn't priced anywhere — "unpriced", not "free". Callers should
// treat null as "can't compute a dollar figure", never silently as $0.
//
// Lookup order: exact-match override, exact-match LiteLLM, then both again
// with one trailing dated-snapshot suffix stripped. Exact matches (either
// source) are preferred over a fuzzy stripped match — e.g. LiteLLM's own
// dated entry for "claude-opus-4-5-20251101" is more precise than falling
// back to an override written for the bare "claude-opus-4-5" alias.
//
// Never awaits I/O — if the LiteLLM index hasn't been loaded this process,
// this kicks off a background load (for later calls to benefit from) and
// falls back to overrides alone for the current call. That's what keeps
// the gateway's request-time estimateCost from gaining latency on a cold
// cache; see ensurePricesLoaded for callers that can afford to wait.
function resolvePrice(provider, model) {
  if (!model) return null;

  if (litellmIndex === null) {
    loadLitellmIndex().catch(() => {}); // loadLitellmIndex itself never rejects; defensive only
  }

  const overrideTable = PRICE_PER_MILLION[provider];
  const litellmTable = litellmIndex?.[provider];

  if (overrideTable?.[model]) return overrideTable[model];
  if (litellmTable?.[model]) return litellmTable[model];

  const stripped = stripDateSuffix(model);
  if (stripped !== model) {
    if (overrideTable?.[stripped]) return overrideTable[stripped];
    if (litellmTable?.[stripped]) return litellmTable[stripped];
  }

  return null;
}

// Logs once per (provider, model) per process — so a pricing gap shows up
// in logs the first time it's hit, wherever it's hit (the gateway's
// request-time cost estimate, or the dashboard's attribution fetch),
// instead of just silently costing $0 or vanishing from a report downstream.
const warnedModels = new Set();
function warnUnknownModel(provider, model) {
  if (!model) return;
  const key = `${provider}:${model}`;
  if (warnedModels.has(key)) return;
  warnedModels.add(key);
  console.warn(
    `[pricing] Unknown ${provider} model "${model}" — not in overrides or the LiteLLM index ` +
    `(checked exact match and stripped dated-snapshot suffixes). Spend involving it will ` +
    `read as $0 or be flagged unpriced until the price map picks it up.`
  );
}

function estimateCost(provider, model, inputTokens, outputTokens) {
  const prices = resolvePrice(provider, model);
  if (!prices) {
    warnUnknownModel(provider, model);
    return 0;
  }
  const [inPrice, outPrice] = prices;
  return (inputTokens / 1_000_000) * inPrice + (outputTokens / 1_000_000) * outPrice;
}

module.exports = { PRICE_PER_MILLION, estimateCost, resolvePrice, warnUnknownModel, ensurePricesLoaded };
