# Insights: first implementation

## Product behavior

An authenticated, read-only page compares exact model IDs in the customer's last
30 complete UTC days of recorded usage. It does not fetch provider usage, change
models, calculate personal savings, or write customer records. Existing cost sync
continues to populate `daily_costs`. General comparisons require a higher published
AA Intelligence Index score and input/output rates that are both no higher, with
at least one strictly lower. Discounts, caching and completed-task costs are not
estimated. Context, input/output modalities and tool support must not regress;
billing records cannot establish application requirements or reasoning settings.

The initial reviewed pairs are GPT-4o (2024-11-20) to GPT-4.1 (2025-04-14), and
Claude Opus 4.1 to Opus 4.5. Aliases, other snapshots and other providers are
unsupported, not guessed. Opus 4.1 is retired; retained historical records are
still identifiable, but normally fall outside the recent usage window.

## Live extraction verified 2026-09-11

Ordinary public access to https://artificialanalysis.ai/models/gpt-4-1 returned
embedded structured JSON containing all four reviewed AA identities and scores,
and the page's Intelligence Index version 4.3. No authentication or access-control
bypass was used. The live Node adapter was also executed successfully.

All four reviewed records currently have `intelligenceIndexIsEstimated: true`.
Published scores remain eligible, including estimates. Each estimated score is
labeled "Estimated by Artificial Analysis" in the comparison; unknown measurement
status is labeled separately. Missing or nonnumeric scores remain ineligible.
This is not evidence that a customer's model is optimal. AA evaluation observation
dates were not available: `observedAt` stays null, distinct from `fetchedAt`.
Public HTML is not a stable API contract; layout/schema changes fail closed.

Provider rate/capability sources are stored with each catalog entry:
- https://developers.openai.com/api/docs/models/gpt-4o
- https://developers.openai.com/api/docs/models/gpt-4.1
- https://platform.claude.com/docs/en/about-claude/pricing
- Availability: https://platform.claude.com/docs/en/about-claude/model-deprecations

## Boundaries and operations

- `lib/insights/source.js`: public extraction, then normalization; replaceable by
  an API/import adapter returning the same snapshot shape. No customer data.
- `lib/insights/catalog.js`: code-reviewed exact IDs, eligible pairs, provider
  published prices/capabilities/availability. Review expires after 30 days.
- `lib/insights/rules.js`: deterministic, side-effect-free recommendation rules.
- `lib/insights/store.js`: shared snapshot and explicitly tenant-filtered usage.
- `api/insights.js`: existing Supabase token verification; no shared HTTP caching.
  Sample responses require sign-in but never read or persist customer usage.
- `api/cron/insights.js`: existing `CRON_SECRET` authentication, central daily
  refresh at 06:00 UTC. A database claim limits attempts to once per 24 hours;
  scheduler jitter may skip a day. One request, 20-second timeout, 8 MB limit,
  at most one retry after one second on transient failures. No retries for 4xx
  or parsing failures; redirects are not followed. No page-load scraping.
- Failed refreshes preserve the last snapshot and record attempt time/status/error.
  Snapshots older than seven days (or future-dated) cannot generate suggestions.
  An interrupted refresh can remain `refreshing` until the next daily attempt.

## Setup for a future preview/staging deployment

1. Review and apply `migrations/20260911_insight_sources.sql` to the chosen test
   Supabase project. It creates shared metadata only, with RLS and no browser role
   permissions. The user applied this migration to the configured Supabase project on 2026-09-14 UTC,
   and the initial refresh successfully stored four benchmark records.
2. Use the existing server-only `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
   `CRON_SECRET`, and the existing browser Supabase configuration. Never expose
   service-role or cron credentials to the client.
3. Invoke authenticated `GET /api/cron/insights` once in staging. Cron schedules
   generally run on production Vercel deployments, not local previews; manually
   trigger staging refresh with the server-held secret. Check response status and
   the singleton's status/last_attempt_at/snapshot.fetchedAt. A failed extraction
   returns `status: error` without discarding its last successful snapshot.
4. Sign in to staging and open `/insights.html`. Verify usage belongs to that
   account, then test a second account. No paid model calls are required.

## Local preview and checks

`npm ci`, `npx playwright install chromium`, `npm test`, and
`npm run test:insights-ui` run unit/API tests and desktop/mobile browser checks.
Browser tests use a local mock sign-in and simulated usage, never `.env` or a DB.
`npm run dev:insights` starts the same isolated preview at http://127.0.0.1:3017.
Optionally set `INSIGHTS_PREVIEW_HTML` to a saved public HTML file; its filesystem
modification time is treated as fetch time, never the benchmark observation date.
`npm run inspect:insights-source` fetches/prints public normalized evidence without
database writes; supply a saved HTML pathname after `--` for offline inspection.

Founder checks: switch between Your usage and Sample examples; expand evidence;
check the period and unsupported-model explanation; resize to mobile; ensure each
sample is marked fictional. Samples use invented model names, scores and prices
for both providers and never affect totals, budgets or forecasts. Browser checks
also exercise loading, missing usage, stale/source failures and request failures.

Local visual verification uses real public benchmark data with simulated usage,
not a real signed-in customer account. Production migration/RLS enforcement and
deployment behavior still require staging verification. No production deployment,
customer-data modifications or paid API traffic are part of this change.
