// Reviewed 2026-09-11. Exact billing snapshots only; aliases are deliberately absent.
const reviewedAt = "2026-09-11T00:00:00Z";
const model = (provider, id, name, benchmarkId, slug, input, output, context, available, source) => ({
  provider, id, name, benchmarkId, slug, input, output, context,
  inputModalities: ["text", "image"], outputModalities: ["text"], tools: true,
  available, reviewedAt, pricingSource: source, compatibilitySource: source,
});
const models = [
  model("openai", "gpt-4o-2024-11-20", "GPT-4o (November 2024)",
    "c1045dc0-4fd3-4adb-9548-18763e0d051f", "gpt-4o", 2.5, 10, 128000, true,
    "https://developers.openai.com/api/docs/models/gpt-4o"),
  model("openai", "gpt-4.1-2025-04-14", "GPT-4.1",
    "3b608b70-6434-4baa-99ad-45d499703c67", "gpt-4-1", 2, 8, 1047576, true,
    "https://developers.openai.com/api/docs/models/gpt-4.1"),
  model("anthropic", "claude-opus-4-1-20250805", "Claude Opus 4.1",
    "f2f60e3a-e5f5-4471-acd2-9f2f29c76007", "claude-4-1-opus", 15, 75, 200000, false,
    "https://platform.claude.com/docs/en/about-claude/pricing"),
  model("anthropic", "claude-opus-4-5-20251101", "Claude Opus 4.5",
    "4077490a-bbfb-404e-979a-a97a20e3b5de", "claude-opus-4-5", 5, 25, 200000, true,
    "https://platform.claude.com/docs/en/about-claude/pricing"),
];
// Availability reviewed against https://platform.claude.com/docs/en/about-claude/model-deprecations.
// Anthropic benchmarks here represent non-reasoning mode; billing cannot establish mode.
const replacements = [
  ["openai", "gpt-4o-2024-11-20", "gpt-4.1-2025-04-14"],
  ["anthropic", "claude-opus-4-1-20250805", "claude-opus-4-5-20251101"],
];
module.exports = { models, replacements };
