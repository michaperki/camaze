// Google Cloud billing export (BigQuery) -> normalized [{ date, provider, amount_usd }]
//
// There is no cost API: billing data lands in a BigQuery table
// (gcp_billing_export_v1_<BILLING_ACCOUNT_ID>) via billing export, and we
// query it over the BigQuery REST API. Auth is a service-account JWT signed
// with Node's crypto, exchanged for an OAuth access token.
const crypto = require("node:crypto");
const fs = require("node:fs");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";
const SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";

// In-memory token cache — re-auth only when within 60s of expiry.
let cachedToken = null; // { token, expiresAt }

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) throw new Error("GOOGLE_APPLICATION_CREDENTIALS is not set in .env");
  let key;
  try {
    key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  } catch (e) {
    throw new Error(`Could not read service account key file (${keyPath}): ${e.message}`);
  }
  if (!key.client_email || !key.private_key) {
    throw new Error("Service account key file is missing client_email/private_key");
  }

  const now = Math.floor(Date.now() / 1000);
  const b64url = (s) => Buffer.from(s).toString("base64url");
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64url(JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600, // max lifetime is 1 hour
    }));
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(unsigned), key.private_key)
    .toString("base64url");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Google auth failed: ${body?.error_description || body?.error || `HTTP ${res.status}`}`);
  }
  cachedToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.token;
}

async function bq(pathOrUrl, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${BQ_BASE}${pathOrUrl}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error?.message || `HTTP ${res.status} from BigQuery`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Discover the export table by listing the dataset — its name embeds the
// billing account ID, so it can't be hardcoded.
async function findBillingTable(project, dataset) {
  let body;
  try {
    body = await bq(`/projects/${project}/datasets/${dataset}/tables?maxResults=100`);
  } catch (e) {
    if (e.status === 404) {
      throw new Error(`BigQuery dataset "${dataset}" not found in project "${project}" — check GOOGLE_BILLING_DATASET, or enable billing export first`);
    }
    throw e;
  }
  const table = (body.tables || [])
    .map(t => t.tableReference?.tableId)
    .find(id => id && id.startsWith("gcp_billing_export_v1_"));
  if (!table) {
    throw new Error(`No billing export table (gcp_billing_export_v1_*) in ${project}.${dataset} yet — if export was just enabled, the table can take a few hours to appear`);
  }
  return table;
}

// `start`: Date (UTC midnight). Throws on config/auth/query errors.
async function fetchCosts(start) {
  const project = process.env.GOOGLE_BILLING_PROJECT;
  if (!project) throw new Error("GOOGLE_BILLING_PROJECT is not set in .env");
  const dataset = process.env.GOOGLE_BILLING_DATASET || "billing_export";

  const table = await findBillingTable(project, dataset);

  // Daily total = cost + credits, converted to USD via the export's own
  // conversion rate (1 for USD-billed accounts). All services for now.
  const sql = `
    SELECT
      DATE(usage_start_time, 'UTC') AS day,
      SUM(
        (cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0))
        / IFNULL(currency_conversion_rate, 1)
      ) AS amount_usd
    FROM \`${project}.${dataset}.${table}\`
    WHERE usage_start_time >= TIMESTAMP('${start.toISOString()}')
    GROUP BY day
    ORDER BY day`;

  const result = await bq(`/projects/${project}/queries`, {
    method: "POST",
    body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30_000 }),
  });
  if (!result.jobComplete) {
    throw new Error("BigQuery query did not complete within 30s — try again");
  }

  // Rows arrive as { f: [{ v: "2026-08-01" }, { v: "12.34" }] } — values are
  // strings; coerce at the boundary.
  return (result.rows || []).map(row => {
    const date = row.f[0].v;
    const amount = Number(row.f[1].v ?? 0);
    if (!Number.isFinite(amount)) {
      throw new Error(`Google returned a non-numeric amount for ${date}: ${JSON.stringify(row.f[1].v)}`);
    }
    return { date, provider: "google", amount_usd: amount };
  });
}

module.exports = { name: "google", label: "Google", fetchCosts };
