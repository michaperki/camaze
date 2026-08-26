// Tests for the cost-allocation path in providers/anthropic.js: real
// per-API-key dollars joined from cost_report + usage_report, falling back
// to the pricing-table estimate only for days cost_report has no data for.
//
// global.fetch is stubbed per test — no real network calls, no Supabase/
// LiteLLM dependency. SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are
// deliberately left unset (see beforeEach), so lib/pricing.js's
// ensurePricesLoaded() falls straight to its "overrides-only" path without
// ever making a network call, which is why the fallback tests below use
// "claude-haiku-4-5-20251001" — it strips to "claude-haiku-4-5", which is
// in lib/pricing.js's hand-maintained PRICE_PER_MILLION overrides.
const test = require("node:test");
const assert = require("node:assert/strict");

const anthropic = require("../providers/anthropic");
const { splitByShare, fetchApiKeyAllocation } = anthropic._internal;

const ORG_BASE = "https://api.anthropic.com/v1/organizations";
const LITELLM_URL_FRAGMENT = "litellm";

function dayBucket(date, results) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    starting_at: `${date}T00:00:00Z`,
    ending_at: next.toISOString(),
    results,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// Routes a test's canned cost_report/usage_report bodies by URL; any
// LiteLLM fetch (triggered by ensurePricesLoaded when a fallback day needs
// resolvePrice) is made to fail immediately, so pricing falls back to
// overrides-only without a real network round trip or a 3s timeout wait.
function stubFetch({ costReport, usageReport }) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes(LITELLM_URL_FRAGMENT)) {
      throw new Error("network disabled in tests");
    }
    if (href.startsWith(`${ORG_BASE}/cost_report`)) {
      return jsonResponse(costReport);
    }
    if (href.startsWith(`${ORG_BASE}/usage_report/messages`)) {
      return jsonResponse(usageReport);
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return () => {
    global.fetch = original;
  };
}

test.beforeEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test("splits a cost line across two keys by that line's own token share, not a blended count", async (t) => {
  const date = "2024-01-15";
  const costReport = {
    data: [
      dayBucket(date, [
        { amount: "1000", model: "test-model", token_type: "uncached_input_tokens", service_tier: "standard", context_window: "0-200k" }, // $10.00
        { amount: "500", model: "test-model", token_type: "output_tokens", service_tier: "standard", context_window: "0-200k" }, // $5.00
      ]),
    ],
    has_more: false,
    next_page: null,
  };
  const usageReport = {
    data: [
      dayBucket(date, [
        {
          api_key_id: "key_A", model: "test-model", service_tier: "standard", context_window: "0-200k",
          uncached_input_tokens: 25, output_tokens: 10, cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
        {
          api_key_id: "key_B", model: "test-model", service_tier: "standard", context_window: "0-200k",
          uncached_input_tokens: 75, output_tokens: 90, cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      ]),
    ],
    has_more: false,
    next_page: null,
  };

  const restore = stubFetch({ costReport, usageReport });
  t.after(restore);

  const result = await fetchApiKeyAllocation(new Date("2024-01-15T00:00:00Z"), new Date("2024-01-16T00:00:00Z"), "fake-key");

  // Input line (25%/75% split): key_A=$2.50, key_B=$7.50.
  // Output line (10%/90% split, priced 5x higher per real Anthropic rates,
  // but that doesn't matter here — the split is per line, not blended):
  // key_A=$0.50, key_B=$4.50.
  // A blended-token-count split (35/165 total tokens) would have put key_A
  // at 35/200*15 = $2.625, not the correct $3.00 — this is the case that
  // distinguishes "split by combined tokens" (wrong) from "split per line"
  // (right).
  assert.equal(result.get("key_A").amountUsd, 3.0);
  assert.equal(result.get("key_B").amountUsd, 12.0);
  assert.equal(result.get("key_A").estimated, false);
  assert.equal(result.get("key_B").estimated, false);

  const total = result.get("key_A").amountUsd + result.get("key_B").amountUsd;
  assert.equal(total, 15.0);
});

test("allocates cache read and cache write lines correctly", async (t) => {
  const date = "2024-01-16";
  const costReport = {
    data: [
      dayBucket(date, [
        { amount: "400", model: "cache-model", token_type: "cache_read_input_tokens", service_tier: "standard", context_window: "0-200k" }, // $4.00
        { amount: "200", model: "cache-model", token_type: "cache_creation.ephemeral_5m_input_tokens", service_tier: "standard", context_window: "0-200k" }, // $2.00
      ]),
    ],
    has_more: false,
    next_page: null,
  };
  const usageReport = {
    data: [
      dayBucket(date, [
        {
          api_key_id: "key_A", model: "cache-model", service_tier: "standard", context_window: "0-200k",
          uncached_input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 30,
          cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 },
        },
        {
          api_key_id: "key_B", model: "cache-model", service_tier: "standard", context_window: "0-200k",
          uncached_input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 70,
          cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 },
        },
      ]),
    ],
    has_more: false,
    next_page: null,
  };

  const restore = stubFetch({ costReport, usageReport });
  t.after(restore);

  const result = await fetchApiKeyAllocation(new Date("2024-01-16T00:00:00Z"), new Date("2024-01-17T00:00:00Z"), "fake-key");

  // Cache read ($4.00, 30/70 split): key_A=$1.20, key_B=$2.80.
  // Cache write ($2.00, 50/50 split): key_A=$1.00, key_B=$1.00.
  assert.equal(result.get("key_A").amountUsd, 2.2);
  assert.equal(result.get("key_B").amountUsd, 3.8);
  assert.equal(result.get("key_A").estimated, false);
  assert.equal(result.get("key_B").estimated, false);
});

test("falls back to the pricing-table estimate on a day cost_report has no data for", async (t) => {
  const date = "2024-01-17";
  // cost_report returns a bucket for the day, but with no line items —
  // exactly what a not-yet-billed (or genuinely $0) day looks like.
  const costReport = {
    data: [dayBucket(date, [])],
    has_more: false,
    next_page: null,
  };
  const usageReport = {
    data: [
      dayBucket(date, [
        {
          api_key_id: "key_A", model: "claude-haiku-4-5-20251001", service_tier: "standard", context_window: "0-200k",
          uncached_input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      ]),
    ],
    has_more: false,
    next_page: null,
  };

  const restore = stubFetch({ costReport, usageReport });
  t.after(restore);

  const result = await fetchApiKeyAllocation(new Date("2024-01-17T00:00:00Z"), new Date("2024-01-18T00:00:00Z"), "fake-key");

  // haiku-4-5 override price: $1.00/$5.00 per million tokens.
  const expected = (1000 / 1_000_000) * 1.0 + (200 / 1_000_000) * 5.0;
  assert.ok(Math.abs(result.get("key_A").amountUsd - expected) < 1e-12);
  assert.equal(result.get("key_A").estimated, true);
});

test("a row is marked estimated if any day in the range fell back, even when most days are real", async (t) => {
  const realDay = "2024-01-18";
  const fallbackDay = "2024-01-19";
  const costReport = {
    data: [
      dayBucket(realDay, [
        { amount: "300", model: "test-model", token_type: "uncached_input_tokens", service_tier: "standard", context_window: "0-200k" },
      ]),
      dayBucket(fallbackDay, []),
    ],
    has_more: false,
    next_page: null,
  };
  const usageReport = {
    data: [
      dayBucket(realDay, [
        {
          api_key_id: "key_A", model: "test-model", service_tier: "standard", context_window: "0-200k",
          uncached_input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      ]),
      dayBucket(fallbackDay, [
        {
          api_key_id: "key_A", model: "claude-haiku-4-5-20251001", service_tier: "standard", context_window: "0-200k",
          uncached_input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      ]),
    ],
    has_more: false,
    next_page: null,
  };

  const restore = stubFetch({ costReport, usageReport });
  t.after(restore);

  const result = await fetchApiKeyAllocation(new Date("2024-01-18T00:00:00Z"), new Date("2024-01-20T00:00:00Z"), "fake-key");

  const realShare = 3.0; // $3.00, 100% of the one key's usage on the real day
  const fallbackShare = (100 / 1_000_000) * 1.0; // haiku-4-5 input rate
  assert.ok(Math.abs(result.get("key_A").amountUsd - (realShare + fallbackShare)) < 1e-12);
  assert.equal(result.get("key_A").estimated, true);
});

test("splitByShare: rounding — per-key shares sum exactly to the line amount even where independent per-share rounding would not", () => {
  // Empirically found: independently computing amount*(weight/total) for
  // every key and summing the results lands 5.68e-14 short of the original
  // amount for this exact (amount, weights) pair — a real floating-point
  // drift, not a hypothetical one. splitByShare avoids it by construction:
  // only the smaller shares are computed independently; the largest share
  // is amount minus the sum of the others, not an independent computation
  // of its own.
  const amountUsd = 485.002223;
  const weights = [754, 387, 442, 803];
  const weightedKeys = weights.map((weight, i) => ({ key: `k${i}`, weight }));

  const naiveTotal = weights.reduce((a, b) => a + b, 0);
  const naiveShares = weights.map((w) => amountUsd * (w / naiveTotal));
  const naiveSum = naiveShares.reduce((a, b) => a + b, 0);
  assert.notEqual(naiveSum, amountUsd, "test setup assumption broke: naive split should NOT sum exactly here");

  const shares = splitByShare(amountUsd, weightedKeys);
  const sum = [...shares.values()].reduce((a, b) => a + b, 0);
  assert.equal(sum, amountUsd);
});

test("splitByShare: a single key gets the whole amount, no split needed", () => {
  const shares = splitByShare(42.5, [{ key: "only", weight: 999 }]);
  assert.equal(shares.get("only"), 42.5);
  assert.equal(shares.size, 1);
});
