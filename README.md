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
one line in `api/costs.js`. No database, no auth, no settings. If one or two
providers' credentials are missing or their API errors, the rest still
render, with a note saying which ones failed.

Deploys as static + serverless on [Vercel](https://vercel.com): `public/index.html`
is the static frontend, `api/costs.js` is the one serverless function.

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
