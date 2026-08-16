// Shared flat price map, USD per million tokens as [input, output]. Used by
// the gateway proxy (api/gateway.js) to price a live request, and by the
// Anthropic per-API-key attribution (providers/anthropic.js) to turn token
// counts into an estimated dollar figure — Anthropic's cost_report endpoint
// has no per-key breakdown, only usage_report/messages does, and that one
// only reports tokens. Unlisted models price at 0 rather than guessing.
const PRICE_PER_MILLION = {
  anthropic: {
    "claude-sonnet-4-6": [3.00, 15.00],
    "claude-opus-4-5": [15.00, 75.00],
    "claude-haiku-4-5": [0.80, 4.00],
  },
  openai: {
    "gpt-4o": [2.50, 10.00],
    "gpt-4o-mini": [0.15, 0.60],
    "o3": [10.00, 40.00],
  },
};

function estimateCost(provider, model, inputTokens, outputTokens) {
  const prices = PRICE_PER_MILLION[provider]?.[model];
  if (!prices) return 0;
  const [inPrice, outPrice] = prices;
  return (inputTokens / 1_000_000) * inPrice + (outputTokens / 1_000_000) * outPrice;
}

module.exports = { PRICE_PER_MILLION, estimateCost };
