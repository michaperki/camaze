// Tests for providers/anthropic.js's fetchCosts() — the cost_report-driven
// function that feeds daily_costs (via lib/costSync.js), now also merging in
// a best-effort per-model token breakdown from usage_report/messages.
const test = require("node:test");
const assert = require("node:assert/strict");

const anthropic = require("../providers/anthropic");
const { fetchCosts } = anthropic;

const ORG_BASE = "https://api.anthropic.com/v1/organizations";

function dayBucket(date, results) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { starting_at: `${date}T00:00:00Z`, ending_at: next.toISOString(), results };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stubFetch({ costReport, usageReport, usageReportError }) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith(`${ORG_BASE}/cost_report`)) return jsonResponse(costReport);
    if (href.startsWith(`${ORG_BASE}/usage_report/messages`)) {
      if (usageReportError) throw new Error(usageReportError);
      return jsonResponse(usageReport);
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return () => { global.fetch = original; };
}

const start = new Date("2026-09-01T00:00:00Z");
const end = new Date("2026-09-02T00:00:00Z");

test("merges usage_report token counts into dayModels by (date, model)", async (t) => {
  const restore = stubFetch({
    costReport: { data: [dayBucket("2026-09-01", [{ amount: "250", model: "claude-haiku-4-5-20251001" }])] },
    usageReport: { data: [dayBucket("2026-09-01", [{
      model: "claude-haiku-4-5-20251001", service_tier: "standard", context_window: "200000",
      uncached_input_tokens: 1000, cache_read_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 },
      output_tokens: 400,
    }])] },
  });
  t.after(restore);

  const result = await fetchCosts(start, end, "test-key");
  assert.equal(result.dayModels.length, 1);
  assert.deepEqual(result.dayModels[0], {
    date: "2026-09-01", model: "claude-haiku-4-5-20251001", amount_usd: 2.5,
    input_tokens: 1250, output_tokens: 400,
  });
});

test("leaves tokens null for a model with no matching usage_report row", async (t) => {
  const restore = stubFetch({
    costReport: { data: [dayBucket("2026-09-01", [{ amount: "100", model: "claude-opus-4-5-20251101" }])] },
    usageReport: { data: [dayBucket("2026-09-01", [])] },
  });
  t.after(restore);

  const result = await fetchCosts(start, end, "test-key");
  assert.equal(result.dayModels[0].input_tokens, null);
  assert.equal(result.dayModels[0].output_tokens, null);
  assert.equal(result.dayModels[0].amount_usd, 1);
});

test("a usage_report failure degrades to null tokens without breaking the dollar sync", async (t) => {
  const restore = stubFetch({
    costReport: { data: [dayBucket("2026-09-01", [{ amount: "100", model: "gpt-4o" }])] },
    usageReportError: "network disabled in tests",
  });
  t.after(restore);

  const result = await fetchCosts(start, end, "test-key");
  assert.equal(result.dayModels.length, 1);
  assert.equal(result.dayModels[0].amount_usd, 1);
  assert.equal(result.dayModels[0].input_tokens, null);
  assert.equal(result.dayModels[0].output_tokens, null);
});

test("keeps separate models on the same day independent", async (t) => {
  const restore = stubFetch({
    costReport: { data: [dayBucket("2026-09-01", [
      { amount: "100", model: "model-a" },
      { amount: "200", model: "model-b" },
    ])] },
    usageReport: { data: [dayBucket("2026-09-01", [
      { model: "model-a", service_tier: "standard", context_window: "200000", uncached_input_tokens: 10, output_tokens: 5 },
      { model: "model-b", service_tier: "standard", context_window: "200000", uncached_input_tokens: 20, output_tokens: 15 },
    ])] },
  });
  t.after(restore);

  const result = await fetchCosts(start, end, "test-key");
  const byModel = Object.fromEntries(result.dayModels.map(r => [r.model, r]));
  assert.deepEqual(byModel["model-a"], { date: "2026-09-01", model: "model-a", amount_usd: 1, input_tokens: 10, output_tokens: 5 });
  assert.deepEqual(byModel["model-b"], { date: "2026-09-01", model: "model-b", amount_usd: 2, input_tokens: 20, output_tokens: 15 });
});
