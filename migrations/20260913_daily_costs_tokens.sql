-- Per-model token counts alongside amount_usd, so lib/insights/rules.js can
-- compute an exact estimated cost on a candidate model from a user's actual
-- usage instead of a blended dollar total. Nullable: historical rows, the
-- __unattributed__ sentinel (see lib/costs.js), and any provider gap never
-- get a token breakdown. Two columns only (not separate cache columns) to
-- match the existing collapsing convention in providers/anthropic.js's
-- estimateDayFromUsage() — cache/uncached input already gets summed into
-- one number there, since lib/insights/catalog.js has no separate cache
-- price to apply anyway.
--
-- daily_costs itself predates tracked migrations (hand-provisioned, no
-- create-table migration exists in this repo) — this is an alter, not a
-- create.
alter table public.daily_costs
  add column if not exists input_tokens bigint,
  add column if not exists output_tokens bigint;
