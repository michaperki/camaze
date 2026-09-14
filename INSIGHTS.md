# Model candidates worth evaluating

Insights compares the authenticated customer's models from the last 182 complete
UTC days of positive, non-subscription `daily_costs`. It does not change models or
fetch provider usage on page load. Cost sync supplies model IDs and optional token
counts; all usage reads remain tenant-filtered and paginated.

## Reviewed coverage (2026-09-14)

`lib/insights/catalog.json` contains 19 reviewed model identities across OpenAI,
Anthropic and Google, including GPT-5.6 Luna/Terra/Sol, GPT-6 Astra, Sonnet 4.6/5,
Opus 5, Fable 5.1, Haiku 4.5, Gemini 2.5 Flash, 3.5 Flash/Flash-Lite and 3.8 Flash,
plus the earlier GPT-4o/4.1 and Opus entries used in historical records.

Every available same-provider catalog entry is considered; there are no fixed
replacement pairs. A comparison requires a higher AA Intelligence Index score,
neither published input/output rate higher, at least one strictly lower, and no
reduction in reviewed context, input/output modalities or tool support. Among
qualifying alternatives, options superseded by another option with at least the
same score/capabilities and lower rates (or higher score at no higher rates) are
removed. Remaining alternatives are sorted by score, then input price and ID.
This is a reviewed subset of the market, not a claim to exhaustive optimization.
Equal-price upgrades do not qualify under this cost-saving rule.

A recognized model with sufficient current evidence is **evaluated**, including
when no candidate qualifies. Each alternative's result is available in coverage
details. Unknown identifiers and missing/stale current-model evidence are listed
separately as **not evaluated**. No string similarity, date stripping or guessed
alias resolution is performed. Anthropic's dateless 4.6+ IDs are canonical pinned
snapshots, per its model-ID documentation; they are explicitly included.

## Identity, pricing and configuration evidence

Each entry links its reviewed provider pricing and capability sources and pins
an AA UUID, provider, slug, full configuration name and reasoning flag. The AA
adapter validates these together. Configuration labels are visible on comparison
cards; customer reasoning/effort settings remain unknown. These are general
comparisons of the stated configurations, not measured scores for customer usage.
AA estimated scores are eligible and labeled per score. Observation dates remain
unknown and distinct from fetch timestamps. AA lifecycle flags are preserved and
shown, not interpreted as provider API retirement.

Provider metadata sources reviewed for this update:
- https://developers.openai.com/api/docs/models/gpt-5.6-luna
- https://developers.openai.com/api/docs/models/gpt-5.6-terra
- https://developers.openai.com/api/docs/models/gpt-5.6-sol
- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://platform.claude.com/docs/en/models/overview
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
- https://platform.claude.com/docs/en/about-claude/model-deprecations
- https://ai.google.dev/gemini-api/docs/models (individual model pages linked in catalog)
- https://cloud.google.com/vertex-ai/generative-ai/pricing

Sonnet 5's $2/$10 rate is now standard; the formerly announced September price
increase was canceled. Google comparisons use standard global Cloud text rates;
regional endpoints and other modalities may differ. GPT-5.6/6 base rates apply
up to 272K input tokens, with higher long-context rates. Pricing notes appear on
cards; explicit promotional end dates are enforced in addition to the 30-day
metadata review lifetime. Updating a benchmark snapshot never renews provider
metadata review dates. Camaze's separate LiteLLM attribution price map is not used
for Insights.

## Snapshots, completeness and recovery

`lib/insights/source.js` extracts public structured JSON from
https://artificialanalysis.ai/models/gpt-4-1. On 2026-09-14 the page contained 650
records; all 19 reviewed identities had numeric AA v4.3 scores. Normalization
retains only reviewed identities and reports missing/changed records. A content
fingerprint binds snapshots to the complete reviewed catalog, including pricing
and configuration metadata. Coverage is recomputed at read time rather than
trusted from a stored success flag.

The central cron fetches once per UTC day (06:00 schedule), with an atomic DB
claim expiring at next UTC midnight, avoiding rolling-24-hour scheduler jitter.
It makes one public request, 20-second timeout, 8MB limit, at most one transient
retry, no redirects/access-denial retries. Incomplete coverage, nonnumeric scores,
identity changes or stale evidence fail the refresh and preserve the prior
snapshot. Status and a bounded error message are recorded. No DB schema change
is required; existing `insight_sources` permissions/RLS remain in place.

`lib/insights/snapshot.json` is a checked-in, complete public snapshot bound to the
catalog. `getSource()` selects it when shared storage is absent, incomplete or
older, and identifies this fallback in the API/UI. It retains the actual fetch
time and expires after seven days, exactly like shared evidence. Page loads never
scrape AA. Fresh, complete newer shared snapshots supersede the bundled snapshot.
The API reports selected origin/coverage and, when falling back, stored coverage.

After manually reviewing catalog edits, run `npm run refresh:insights-evidence`.
It fetches/validates public evidence, updates the bundled snapshot and simulation
as-of metadata, and performs no database writes. Commit those files together.
New model discovery and provider metadata review still require human review;
missing coverage is made visible rather than silently guessed.

## Simulation

`/sim/insights.html` uses the same catalog and bundled snapshot as the product.
`lib/simulation/knowledge.json` records only its version and fixed evidence date,
avoiding a second divergent catalog or partial snapshot. Business time can advance
while evidence remains frozen for reproducibility. The UI explicitly displays
that frozen date. A shared production refresh does not refresh simulation.

## Dollar estimates

Where allowed, all contributing usage rows must have nonnegative, finite input
and output counts. One missing breakdown suppresses the aggregate estimate.
Candidate standard rates are applied to those same token counts and compared
with recorded spend; only a positive difference is labeled savings. This is a
same-token scenario, not a prediction of task completion cost or future bills.

Estimates are disabled for the newly tiered OpenAI models, Anthropic (unknown
reasoning/cache settings), and Google (mixed billing modalities/regions). General
published-rate comparisons remain available. Original OpenAI comparisons can
still show estimates with full token counts and the stated standard-rate caveats.
Discounts, caching, batch, service tiers, tools, taxes and changed token usage are
not reconstructed. The UI no longer claims every omitted estimate means token
counts are missing.

## Verification and operations

- `npm test`: unit/API/provider regression tests, including coverage, exact
  configuration matching, daily refresh claims, fallback expiry and the reported
  five-model scenario against checked-in evidence.
- `npm run test:insights-ui`: desktop/mobile UI, evaluated-versus-unsupported
  coverage, configuration labels, partial-source warnings and frozen evidence.
- `npm run inspect:insights-source`: read-only public extraction; optional saved
  HTML pathname for offline normalization/coverage diagnosis.
- `npm run dev:insights`: isolated UI preview with mock auth and usage; no DB.

The existing `migrations/20260911_insight_sources.sql` is still required for shared
storage. Deploying code ships complete evidence immediately; the next successful
cron refresh populates the expanded shared snapshot. No customer-data migration,
provider calls for paid inference, or automatic model switches are involved.
