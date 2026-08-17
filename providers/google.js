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

// In-memory token cache, keyed by service account email — one process can
// serve multiple users, each with their own service account, so a single
// global slot would hand one user's token to another.
const tokenCache = new Map(); // client_email -> { token, expiresAt }

// Resolves the service account key object: an inline JSON string (per-user
// key, passed by the caller) takes priority, then GOOGLE_SERVICE_ACCOUNT_JSON,
// then the file at GOOGLE_APPLICATION_CREDENTIALS.
function loadServiceAccountKey(inlineJson) {
  const raw = inlineJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`Could not parse service account JSON: ${e.message}`);
    }
  }
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) {
    throw new Error("No service account credentials: set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS");
  }
  try {
    return JSON.parse(fs.readFileSync(keyPath, "utf8"));
  } catch (e) {
    throw new Error(`Could not read service account key file (${keyPath}): ${e.message}`);
  }
}

// `inlineJson`: per-user service account JSON string, or undefined to use
// the env-configured credentials.
async function getAccessToken(inlineJson) {
  const key = loadServiceAccountKey(inlineJson);
  if (!key.client_email || !key.private_key) {
    throw new Error("Service account key is missing client_email/private_key");
  }

  const cached = tokenCache.get(key.client_email);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.token;
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
  const token = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  tokenCache.set(key.client_email, token);
  return token.token;
}

async function bq(pathOrUrl, accessToken, options = {}) {
  const res = await fetch(`${BQ_BASE}${pathOrUrl}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
async function findBillingTable(project, dataset, accessToken) {
  let body;
  try {
    body = await bq(`/projects/${project}/datasets/${dataset}/tables?maxResults=100`, accessToken);
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

// `start`/`end`: Date objects, end exclusive. `overrides`: per-user
// { serviceAccountJson, project, dataset }, each falling back to its env
// var when absent. Throws on config/auth/query errors. Returns
// { days, models } — both derived from the same query.
async function fetchCosts(start, end, overrides = {}) {
  const project = overrides.project || process.env.GOOGLE_BILLING_PROJECT;
  if (!project) throw new Error("GOOGLE_BILLING_PROJECT is not set in .env");
  const dataset = overrides.dataset || process.env.GOOGLE_BILLING_DATASET || "billing_export";

  const accessToken = await getAccessToken(overrides.serviceAccountJson);
  const table = await findBillingTable(project, dataset, accessToken);

  // Daily total = cost + credits, converted to USD via the export's own
  // conversion rate (1 for USD-billed accounts). All services for now.
  // Grouped by model too (the closest thing to a "model" in billing export —
  // e.g. specific Vertex AI/Gemini line items) so spend can be broken down
  // per model alongside the daily totals, from the one query. Also grouped
  // by project (id + display name) so the same query yields a per-project
  // breakdown — this fans rows out further, but day/model totals below are
  // summed across whatever rows come back, so they're unaffected.
  //
  // "model" prefers the goog-generativelanguage-model label over sku.description:
  // the Gemini API's input/output token SKUs each have their own description
  // ("Generate content input token count gemini 3.5 flash text" vs "...output..."),
  // which would otherwise fan a single model out into two unreadable rows. The
  // label carries the same value on both, and is a compact slug (e.g.
  // "gemini35flash") rather than free text — prettifyModel() on the dashboard
  // reformats it. Falls back to sku.description when the label is absent
  // (subscriptions, storage, and any other non-generative-API line item).
  const sql = `
    SELECT
      DATE(usage_start_time, 'UTC') AS day,
      COALESCE(
        (SELECT value FROM UNNEST(labels) WHERE key = 'goog-generativelanguage-model' LIMIT 1),
        sku.description
      ) AS model,
      project.id AS project_id,
      project.name AS project_name,
      SUM(
        (cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0))
        / IFNULL(currency_conversion_rate, 1)
      ) AS amount_usd
    FROM \`${project}.${dataset}.${table}\`
    WHERE usage_start_time >= TIMESTAMP('${start.toISOString()}')
      AND usage_start_time < TIMESTAMP('${end.toISOString()}')
    GROUP BY day, model, project_id, project_name
    ORDER BY day`;

  const result = await bq(`/projects/${project}/queries`, accessToken, {
    method: "POST",
    body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30_000 }),
  });
  if (!result.jobComplete) {
    throw new Error("BigQuery query did not complete within 30s — try again");
  }

  // Rows arrive as { f: [{ v: "2026-08-01" }, { v: "Gemini ..." }, { v: "my-project" },
  // { v: "My Project" }, { v: "12.34" }] } — values are strings; coerce at the boundary.
  const byDay = new Map();
  const byModel = new Map();
  const byProject = new Map(); // project_id -> { name, amount_usd }
  const byDayModel = new Map(); // "date|model" -> amount_usd, since project fans day+model out
  for (const row of result.rows || []) {
    const date = row.f[0].v;
    const model = row.f[1].v;
    const projectId = row.f[2].v;
    const projectName = row.f[3].v;
    const amount = Number(row.f[4].v ?? 0);
    if (!Number.isFinite(amount)) {
      throw new Error(`Google returned a non-numeric amount for ${date}: ${JSON.stringify(row.f[4].v)}`);
    }
    byDay.set(date, (byDay.get(date) || 0) + amount);
    if (model) {
      byModel.set(model, (byModel.get(model) || 0) + amount);
      const dayModelKey = `${date}|${model}`;
      byDayModel.set(dayModelKey, (byDayModel.get(dayModelKey) || 0) + amount);
    }
    if (projectId) {
      const entry = byProject.get(projectId) || { name: projectName || projectId, amount_usd: 0 };
      entry.amount_usd += amount;
      byProject.set(projectId, entry);
    }
  }

  return {
    days: [...byDay].map(([date, amount_usd]) => ({ date, provider: "google", amount_usd })),
    models: [...byModel].map(([model, amount_usd]) => ({ model, amount_usd })),
    dayModels: [...byDayModel].map(([key, amount_usd]) => {
      const sep = key.indexOf("|");
      return { date: key.slice(0, sep), model: key.slice(sep + 1), amount_usd };
    }),
    projects: [...byProject].map(([id, { name, amount_usd }]) => ({ id, name, amount_usd })),
  };
}

// Confirms a { serviceAccountJson, project, dataset } combination can
// authenticate and see the billing export dataset, before it's saved.
// Doesn't run the full cost query — this alone catches the common
// mistakes (bad key, wrong project, missing/not-yet-ready export).
async function validateConfig({ serviceAccountJson, project, dataset } = {}) {
  if (!project) throw new Error("Billing project is required");
  const accessToken = await getAccessToken(serviceAccountJson);
  await findBillingTable(project, dataset || "billing_export", accessToken);
}

module.exports = { name: "google", label: "Google", fetchCosts, validateConfig };
