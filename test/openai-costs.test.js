// Tests for providers/openai.js's fetchCosts() — the Costs-API-driven
// function that feeds daily_costs, now also merging in a best-effort
// per-model token breakdown from the separate Usage API.
const test = require("node:test");
const assert = require("node:assert/strict");

const openai = require("../providers/openai");
const { fetchCosts } = openai;

const ORG_BASE = "https://api.openai.com/v1/organization";

function dayBucket(startTime, results) {
  return { start_time: startTime, results };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stubFetch({ costs, usage, usageError }) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith(`${ORG_BASE}/costs`)) return jsonResponse(costs);
    if (href.startsWith(`${ORG_BASE}/usage/completions`)) {
      if (usageError) throw new Error(usageError);
      return jsonResponse(usage);
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return () => { global.fetch = original; };
}

const DAY_START = Math.floor(new Date("2026-09-01T00:00:00Z").getTime() / 1000);
const start = new Date("2026-09-01T00:00:00Z");
const end = new Date("2026-09-02T00:00:00Z");

test("merges usage token counts into dayModels by (date, model)", async (t) => {
  const restore = stubFetch({
    costs: { data: [dayBucket(DAY_START, [{ amount: { value: 1.5 }, line_item: "gpt-4o-mini-2024-07-18, input" }])] },
    usage: { data: [dayBucket(DAY_START, [{ model: "gpt-4o-mini-2024-07-18", input_tokens: 10000, output_tokens: 2000 }])] },
  });
  t.after(restore);

  const result = await fetchCosts(start, end, "test-key");
  assert.equal(result.dayModels.length, 1);
  assert.deepEqual(result.dayModels[0], {
    date: "2026-09-01", model: "gpt-4o-mini-2024-07-18", amount_usd: 1.5,
    input_tokens: 10000, output_tokens: 2000,
  });
});

test("sums multiple usage rows for the same model on the same day", async (t) => {
  const restore = stubFetch({
    costs: { data: [dayBucket(DAY_START, [{ amount: { value: 2 }, line_item: "gpt-4o-mini-2024-07-18, input" }])] },
    usage: { data: [dayBucket(DAY_START, [
      { model: "gpt-4o-mini-2024-07-18", input_tokens: 1000, output_tokens: 100 },
      { model: "gpt-4o-mini-2024-07-18", input_tokens: 500, output_tokens: 50 },
    ])] },
  });
  t.after(restore);

  const result = await fetchCosts(start, end, "test-key");
  assert.equal(result.dayModels[0].input_tokens, 1500);
  assert.equal(result.dayModels[0].output_tokens, 150);
});

test("leaves tokens null for a model with no matching usage row", async (t) => {
  const restore = stubFetch({
    costs: { data: [dayBucket(DAY_START, [{ amount: { value: 1 }, line_item: "gpt-4.1-2025-04-14, output" }])] },
    usage: { data: [dayBucket(DAY_START, [])] },
  });
  t.after(restore);

  const result = await fetchCosts(start, end, "test-key");
  assert.equal(result.dayModels[0].input_tokens, null);
  assert.equal(result.dayModels[0].output_tokens, null);
  assert.equal(result.dayModels[0].amount_usd, 1);
});

test("a usage endpoint failure degrades to null tokens without breaking the dollar sync", async (t) => {
  const restore = stubFetch({
    costs: { data: [dayBucket(DAY_START, [{ amount: { value: 1 }, line_item: "gpt-4o, input" }])] },
    usageError: "network disabled in tests",
  });
  t.after(restore);

  const result = await fetchCosts(start, end, "test-key");
  assert.equal(result.dayModels.length, 1);
  assert.equal(result.dayModels[0].amount_usd, 1);
  assert.equal(result.dayModels[0].input_tokens, null);
  assert.equal(result.dayModels[0].output_tokens, null);
});
