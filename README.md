# camaze

"How much is that?!" — the simplest possible AI spend tracker.

One page: a stacked bar chart of daily API spend for the last 30 days
(Anthropic + OpenAI + Google), with a combined total and per-provider totals.
Data is fetched fresh on every page load from each provider's cost API:

- Anthropic: `GET /v1/organizations/cost_report` (Admin API)
- OpenAI: `GET /v1/organization/costs` (Costs API)
- Google: BigQuery billing export table (`gcp_billing_export_v1_*`), queried
  via the BigQuery REST API with a service-account JWT (no client libraries;
  access token cached in memory until expiry)

Each provider lives in its own module under `providers/`, normalizing to
`{ date, provider, amount_usd }` — adding a provider means adding one file and
one line in `api/costs.js`. If one or two providers' credentials are missing
or their API errors, the rest still render, with a note saying which ones
failed.

Flat recurring charges (currently only Google's "Gemini Code Assist monthly
subscription" — identified by provider metadata, the BigQuery export's SKU
description, not by looking for repeating dollar amounts) are split out
from usage everywhere: the bars are usage only since a fixed cost can't
spike, `api/costs.js` returns `totals.usage`/`totals.subscriptions` and a
`subscriptions` breakdown alongside `totals.combined` (the full bill), and
the dashboard shows all three ("$33.30 total — $18.60 usage, $14.70
subscriptions") rather than hiding the recurring cost. Neither Anthropic's
nor OpenAI's cost APIs expose anything like it, so their spend is always
classified as usage. See `lib/costs.js`'s `isSubscriptionLine`.

Above the chart, a month-to-date summary shows spend so far this month, a
forecast for month-end, and (once a budget is set on the dashboard) how
much of it's been used — the forecast is colored red/yellow/green against
the budget. The forecast projects usage and subscriptions separately, then
sums them (`buildSummary` in `lib/costs.js`): usage is extrapolated from
the run-rate so far since it can spike, while a subscription's daily rate
is close to constant, so linearly projecting it from partial-month data
lands on its true monthly total rather than treating a fixed cost as if it
could vary the way usage does.

Deploys as static + serverless on [Vercel](https://vercel.com):
`public/index.html` is a public landing page, `public/dashboard.html` is the
app itself, `api/costs.js` is the one serverless function behind it.

Login is required ([Supabase](https://supabase.com) auth — Google OAuth or a
magic link, no passwords) to reach the dashboard; `/` shows the landing page
to signed-out visitors and redirects straight to `/dashboard.html` for a
visitor with an existing session. Once signed in, the **Integrations** page
(`public/integrations.html`) lets each user connect their own provider keys
instead of relying on the server's `.env`: keys are validated against the
provider's API before saving, encrypted at rest (AES-256-GCM, `lib/crypto.js`)
in a `user_provider_keys` table, and never sent back to the browser in full —
only a last-4 hint. `api/costs.js` uses a signed-in user's own keys when
present, falling back to the server's env vars otherwise (which is what keeps
local development working without connecting anything).

The **Notifications** page (`public/notifications.html`) lets a user turn on
a daily email digest — yesterday's spend, month-to-date, forecast, budget
usage, and top models — sent via [Resend](https://resend.com)
(`lib/digest.js`, `api/digest.js`). A Vercel Cron job hits
`GET /api/cron/digest` once a day at a fixed hour (`vercel.json`) and sends
to every user with the digest enabled in `user_notification_settings`,
authenticated by `CRON_SECRET` rather than a user session. The settings page
still has a delivery-time picker and stores it (`digest_hour`), but the cron
doesn't act on it yet — Vercel Hobby plans cap cron jobs at once per day, so
per-user delivery times need a Pro plan (hourly cron) to actually take
effect.

The same cron run also checks for **spike and budget alerts** (`lib/alerts.js`,
`lib/alertRunner.js`, `lib/alertEmail.js`) — a separate pass over a separate
user list (`spike_alerts_enabled`/`budget_alerts_enabled`), independent of
whether the digest itself is on. Both operate on usage only (see above) —
a subscription can't spike and is never folded into either number.

Spike detection is two-mode, computed from the trailing 7-day median of
usage (excluding yesterday):

- **ratio mode**, when that median is at least `MIN_BASELINE` ($0.50):
  fires when yesterday's usage is at least `SPIKE_MULTIPLIER` (3x) the
  median *and* at least `ABSOLUTE_FLOOR` ($1) — the absolute floor keeps a
  20¢-vs-5¢ day from counting as a "spike."
- **absolute mode**, when the median is below `MIN_BASELINE` (including
  exactly zero, e.g. a quiet week): a ratio against a near-zero baseline is
  meaningless, so it instead fires on any usage at or above
  `WAKE_THRESHOLD` ($1) — spend resuming after a quiet stretch is exactly
  the case worth flagging, not one to suppress for lack of a baseline.

All four constants live at the top of `lib/alerts.js`. A budget alert
fires when the month-end forecast (the full bill — budgets cover the whole
invoice, not just usage) crosses a user-configurable percentage of their
budget (default 80%). Each alert type is sent as its own email, not folded
into the digest, and each fires at most once (per day for spikes, per
threshold per month for budgets) via an insert-with-conflict-ignore into
`alert_state`. `GET /api/alerts/dryrun` replays spike detection against the
last 30 real days without sending anything, returning each day's
usage/subscription split, baseline, ratio, mode, and whether it would have
fired — and accepts `?multiplier=`/`?floor=`/`?minBaseline=`/`?wake=` to
try different constants against real history without a redeploy (never
persisted).

## Setup

1. Copy the env file and fill in whichever providers you use — any subset is
   fine, missing ones just show a note instead of a series:

   - **Anthropic**: `ANTHROPIC_ADMIN_KEY`, an Admin key (`sk-ant-admin...`)
     from Console → Settings → Organization → Admin keys.
   - **OpenAI**: `OPENAI_ADMIN_KEY`, an Admin key (`sk-admin-...`) from
     platform.openai.com → Settings → Organization → Admin keys. Regular API
     keys don't work for either provider above.
   - **Google**: there's no cost API — billing data comes from the
     [BigQuery billing export](https://cloud.google.com/billing/docs/how-to/export-data-bigquery).
     Enable standard usage cost export to a dataset (default name
     `billing_export`) in a GCP project, then create a service account with
     **BigQuery Data Viewer** and **BigQuery Job User** on that project and
     download its JSON key. Set:
     - `GOOGLE_APPLICATION_CREDENTIALS` — path to the key file
     - `GOOGLE_BILLING_PROJECT` — the project ID containing the dataset
     - `GOOGLE_BILLING_DATASET` — the dataset name (defaults to
       `billing_export` if unset)

     The actual table (`gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`) is
     discovered by listing the dataset, not hardcoded. If export was just
     enabled, the table can take a few hours to appear — camaze shows that as
     a plain note rather than an error.

   ```sh
   cp .env.example .env
   ```

2. Run it locally with the [Vercel CLI](https://vercel.com/docs/cli) (no
   dependencies to install):

   ```sh
   npm run dev
   ```

3. Open http://localhost:3000

Keys never leave the server — the page calls a local `/api/costs` proxy.
API errors and empty periods are shown plainly on the page.

## Auth + per-user keys setup

Requires a [Supabase](https://supabase.com) project (already created if
you're reading this after the initial deploy).

1. **Enable sign-in methods** — Authentication → Providers:
   - Google: turn it on and fill in your Google OAuth client ID/secret.
   - Email: on by default (used for the magic link).
2. **Allow the redirect URLs** — Authentication → URL Configuration →
   Redirect URLs: add `http://localhost:3000/dashboard.html` and
   `https://<your-vercel-domain>/dashboard.html`.
3. **Create the `user_provider_keys` and `user_settings` tables** — SQL
   Editor, run:

   ```sql
   create table public.user_provider_keys (
     id uuid primary key default gen_random_uuid(),
     user_id uuid not null references auth.users(id) on delete cascade,
     provider text not null check (provider in ('anthropic', 'openai', 'google')),
     encrypted_data text not null,
     key_hint text,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now(),
     unique (user_id, provider)
   );

   alter table public.user_provider_keys enable row level security;

   create policy "Users can view their own provider keys"
     on public.user_provider_keys for select
     using (auth.uid() = user_id);

   create policy "Users can insert their own provider keys"
     on public.user_provider_keys for insert
     with check (auth.uid() = user_id);

   create policy "Users can update their own provider keys"
     on public.user_provider_keys for update
     using (auth.uid() = user_id);

   create policy "Users can delete their own provider keys"
     on public.user_provider_keys for delete
     using (auth.uid() = user_id);

   create table public.user_settings (
     user_id uuid primary key references auth.users(id) on delete cascade,
     monthly_budget numeric,
     alert_threshold numeric not null default 80,
     updated_at timestamptz not null default now()
   );

   alter table public.user_settings enable row level security;

   create policy "Users can manage their own settings"
     on public.user_settings for all
     using (auth.uid() = user_id)
     with check (auth.uid() = user_id);

   create table public.user_notification_settings (
     user_id uuid primary key references auth.users(id) on delete cascade,
     digest_enabled boolean not null default false,
     digest_hour integer not null default 9,
     spike_alerts_enabled boolean not null default true,
     budget_alerts_enabled boolean not null default true,
     updated_at timestamptz not null default now()
   );

   alter table public.user_notification_settings enable row level security;

   create policy "Users can manage their own settings"
     on public.user_notification_settings for all
     using (auth.uid() = user_id)
     with check (auth.uid() = user_id);

   create table public.alert_state (
     user_id uuid not null references auth.users(id) on delete cascade,
     alert_key text not null,
     fired_at timestamptz not null default now(),
     primary key (user_id, alert_key)
   );

   alter table public.alert_state enable row level security;

   create policy "Users manage own alert state"
     on public.alert_state for all
     using (auth.uid() = user_id) with check (auth.uid() = user_id);
   ```

   `api/keys.js`, `api/budget.js`, `api/costs.js`, `api/notifications.js`,
   `api/digest.js`, and `api/alerts/*` use the service role key server-side,
   which bypasses RLS — every query is manually scoped to the caller's
   `user_id` first. The policies above are still worth having as a second
   line of defense against a future bug or a stray client-side query.

4. **Add the remaining env vars** (see `.env.example` for details):
   - `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → `service_role`.
     This one's a real secret (bypasses RLS) — never send it to the browser.
   - `CAMAZE_ENCRYPTION_KEY` — a random 32-byte hex string, generate with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
     Use a different one per environment (local vs. deployed); losing it
     makes stored keys undecryptable, so back it up somewhere.
   - `RESEND_API_KEY`, `CAMAZE_APP_URL`, `CRON_SECRET` — needed for the
     daily email digest (Notifications page). See `.env.example` for details
     on each.

Once connected on the Integrations page, a user's own keys are used instead
of the server's env vars for that user's dashboard requests.
