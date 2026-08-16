// Shared flat price map, USD per million tokens as [input, output]. Used by
// the gateway proxy (api/gateway.js) to price a live request, and by the
// Anthropic per-API-key attribution (providers/anthropic.js) to turn token
// counts into an estimated dollar figure — Anthropic's cost_report endpoint
// has no per-key breakdown, only usage_report/messages does, and that one
// only reports tokens.
//
// Model strings verified against a live usage_report/messages probe (and,
// for Anthropic, current public pricing) on 2026-08-16 — not guessed.
// Two prior entries were wrong: "claude-haiku-4-5" was priced at the Haiku
// 4.0-era rate ($0.80/$4.00) instead of Haiku 4.5's actual $1.00/$5.00, and
// "claude-opus-4-5" carried the older Opus 4.1-era rate ($15.00/$75.00) —
// Opus pricing actually dropped to $5.00/$25.00 starting with 4.5, not 4.6.
//
// Deliberately NOT priced here: several OpenAI models seen in the same
// probe (gpt-5.2, gpt-5.3-chat-latest, gpt-5.4, gpt-5.4-mini, gpt-5.5,
// gpt-5.6-luna, gpt-5.6-sol, dall-e-2, gpt-4o-mini-tts) — some use tiered
// pricing past a token breakpoint that this flat per-model schema can't
// represent, and for the newest/least-documented ones (gpt-5.6-luna,
// gpt-5.6-sol) no source available here could be cross-verified against
// OpenAI's own pricing page. Guessing a number would be worse than the
// unpriced-row fallback below (see resolvePrice/warnUnknownModel) — add
// them once verified against an authoritative source.
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
// (claude-haiku-4-5-20251001, gpt-4.1-2025-04-14) that won't exact-match the
// bare alias in the table above. Try the exact string first, then
// progressively strip one trailing -YYYYMMDD or -YYYY-MM-DD segment and
// retry — handles both without needing every dated snapshot listed.
function stripDateSuffix(model) {
  return model.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
}

// Returns [inputPrice, outputPrice] per million tokens, or null if the model
// (even after stripping a date suffix) isn't in the table — "unpriced", not
// "free". Callers should treat null as "can't compute a dollar figure",
// never silently as $0.
function resolvePrice(provider, model) {
  const table = PRICE_PER_MILLION[provider];
  if (!table || !model) return null;
  let candidate = model;
  for (;;) {
    if (table[candidate]) return table[candidate];
    const stripped = stripDateSuffix(candidate);
    if (stripped === candidate) return null;
    candidate = stripped;
  }
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
    `[pricing] Unknown ${provider} model "${model}" — not in PRICE_PER_MILLION ` +
    `(checked exact match and stripped dated-snapshot suffixes). Spend involving ` +
    `it will read as $0 or be flagged unpriced until the price map is updated.`
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

module.exports = { PRICE_PER_MILLION, estimateCost, resolvePrice, warnUnknownModel };
