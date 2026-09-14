// Reviewed 2026-09-11. Exact billing snapshots only; aliases are deliberately absent.
const reviewedAt = "2026-09-11T00:00:00Z";
// Added 2026-09-13 to cover smaller/cheaper models actually seen in usage
// (gpt-4o-mini, claude-haiku-4-5) plus gpt-4.1-nano as its reviewed
// replacement candidate. Pricing cross-checked against
// developers.openai.com/api/docs/pricing and platform.claude.com's pricing
// table; benchmark ids/slugs pulled from the same public AA snapshot
// lib/insights/source.js fetches in production.
const reviewedAt2 = "2026-09-13T00:00:00Z";
const model = (provider, id, name, benchmarkId, slug, input, output, context, available, source, reviewed = reviewedAt) => ({
  provider, id, name, benchmarkId, slug, input, output, context,
  inputModalities: ["text", "image"], outputModalities: ["text"], tools: true,
  available, reviewedAt: reviewed, pricingSource: source, compatibilitySource: source,
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
  model("openai", "gpt-4o-mini-2024-07-18", "GPT-4o mini",
    "b5c1c91a-7474-4409-9a9c-9c2ac45d9eb6", "gpt-4o-mini", 0.15, 0.6, 128000, true,
    "https://developers.openai.com/api/docs/pricing", reviewedAt2),
  model("openai", "gpt-4.1-nano-2025-04-14", "GPT-4.1 nano",
    "72c358fd-7d45-4d68-89aa-699743710924", "gpt-4-1-nano", 0.1, 0.4, 1047576, true,
    "https://developers.openai.com/api/docs/pricing", reviewedAt2),
  model("anthropic", "claude-haiku-4-5-20251001", "Claude Haiku 4.5",
    "c2b1e769-7aee-4669-8076-73918bdebf6c", "claude-4-5-haiku", 1, 5, 200000, true,
    "https://platform.claude.com/docs/en/about-claude/pricing", reviewedAt2),
];
// Availability reviewed against https://platform.claude.com/docs/en/about-claude/model-deprecations.
// Anthropic benchmarks here represent non-reasoning mode; billing cannot establish mode.
//
// No replacement is listed for claude-haiku-4-5-20251001: it's Anthropic's
// current small model, and nothing reviewed here beats it on both price and
// score. It still gets a real "no reviewed replacement" comparison instead
// of showing as an unrecognized model.
const replacements = [
  ["openai", "gpt-4o-2024-11-20", "gpt-4.1-2025-04-14"],
  ["anthropic", "claude-opus-4-1-20250805", "claude-opus-4-5-20251101"],
  ["openai", "gpt-4o-mini-2024-07-18", "gpt-4.1-nano-2025-04-14"],
];
module.exports = { models, replacements };
