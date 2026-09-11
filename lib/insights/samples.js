const { recommend, recentWindow } = require("./rules");
// Wholly fictional models, prices and scores. Never written to customer tables.
function sampleInsights(now = new Date()) {
  const models = [], replacements = [], records = [], rows = [];
  for (const [provider, label, input, output] of [["openai", "OpenAI", 2.5, 10], ["anthropic", "Anthropic", 15, 75]]) {
    for (const [suffix, score, multiplier] of [["A", 32, 1], ["B", 40, 0.6]]) {
      const id = `sample-${provider}-${suffix}`;
      models.push({ provider, id, name: `${label} example ${suffix}`, benchmarkId: id, input: input * multiplier,
        output: output * multiplier, context: 200000, tools: true, inputModalities: ["text"], outputModalities: ["text"],
        available: true, reviewedAt: now.toISOString(), pricingSource: null, compatibilitySource: null });
      records.push({ id, provider, score, estimated: false, version: "sample-1", source: null, observedAt: null });
    }
    replacements.push([provider, `sample-${provider}-A`, `sample-${provider}-B`]);
    rows.push({ provider, model: `sample-${provider}-A`, date: new Date(+now - 2 * 86400000).toISOString().slice(0, 10), amount_usd: 10 });
  }
  return { ...recommend(rows, { records, fetchedAt: now.toISOString(), version: "sample-1" }, now, { models, replacements }),
    sample: true, source: { status: "sample", fetchedAt: null, ageDays: null }, usageSyncedAt: null, period: recentWindow(now) };
}
module.exports = { sampleInsights };
