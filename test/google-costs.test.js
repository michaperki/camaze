// Tests for providers/google.js's fetchCosts() — the BigQuery-billing-export
// query, now scoped to generative-AI services only (previously read the
// entire GCP billing account) and extended to bucket usage.amount into a
// per-model input/output token breakdown.
const test = require("node:test");
const assert = require("node:assert/strict");

const google = require("../providers/google");
const { fetchCosts } = google;

// Throwaway keypair generated for this test file only — never used against
// a real Google endpoint (the token exchange itself is stubbed below).
const TEST_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDJ8N/wgAljikoy\n9NyQK1HgAxsjvFo7OUZxL+2vdL82O+Md5umj9UV7aIevUo3mBMjGtQrI5XLkVzsT\nBGW4nSFS4KPbVNWadh2FKl6u6gl+4cPApEwFvQ14vED8SGoGQnG5H99ZRaUjlCFJ\nMsLaFRPiOEaCDitHpcuLnyyKs61LgZEcMZiEf0egSsQgszF8ELmB/9icxgn8ws+N\nKHzDhFtpMspunmRloJSvQIYXSNWTPrpfS+B0kLTgq3eq1mCh9Lkc+sHwtqTXNUFx\n9FgGQ46lIYf3gFCdXQ0NmfMgClC79TYWxqwh4As/N9QU8PhYAHsB8ocP9ZEpB/Lv\n18fmz1cTAgMBAAECggEAK9tFNz0HTPfmn2RwVlsiH+1swnkQe5Y3xzMqgpVvRX8C\nFydkDHijC2crOJdMO+1EEWuWGQVDy3VqXfnxgYOWjiI9U8/7x9zpEleeUox/XW/4\njGjiHcjuGQ+BaYjshcl+Wz8hyYiHkc+E3xnIGYbEV7fzECG1oozORNdf3AujkicB\nqTGs3a9QE/tb087x7GpuIQaObIQ5zpCuYvUqoDM+xy5nlh+OGoEYOQ3wKBs7bs6g\nIoHOZB9DBCEAM5B+xoRiZvecq0mreYV+vO8q+yy5N1GyJvSMwu5iyT3mCOC7ZNAk\n26XPRBuMDX+y3MsU8dkZFbVQaDIOPMGEA71iRV/h6QKBgQDp6Jqa4BkfS1omXcbN\nI0YukipAGdr9tSk1hfSF04mDXaeh9T2ePkZYIuEkyJQlFucNTsA6OfUspNHOzNsm\nC5nFiY4PC2q1MOSZRCH5U2n+6biz8jKhM0TOYwrSczDPC9ill1OQFYTMSceMFLXq\ngZqdKkrioSzhvxqhhtJbZBT67QKBgQDdA1y/9d/EhSdMWiOPnZUq2HCTgodcl7PY\nO0N58YwHwVi15DbqacXILICY3dWYQeK/aIkv4UHr7NqSLRdDdFJ7OQZc55fAwXmb\ndHS3ZrgHH/RyqrGIW3y0KO/fEJ/NKrukTfmhlJ/hCHj/hmRbABJSMyBYxd2Yd3Bx\nWXSv9sFZ/wKBgQCO4OaPdBPkacLHbMDizYkxKVdlkGWUU/S4HPsgQ/bbp3meFI9u\n+ds+OxALx/m2Lic0mcYRyxVYD9WY3MmAk9V6NGvyBKdJxnPcqyGVir5UV6/bOzZy\nAT8mUplps7M8xZ+whp8khAB6SRb7GiuE82XeWtcjWBByVKmPwSr9aETogQKBgAKc\nNY420yu4/tvR/LWHgOl+oOW9FugrCn61RHi+N48n42pShauDEEjq7aHgjNM9g/YK\nwAQGvwaQR4yOZ8XuK8M0yzRxr8MhBdSmLXK1DdtXr0VjarFXk0N1cE/MHHcJ2Cl6\nmkYkQTchKHysE6dXet/ppqolvBY+4t8T1WL2oRX1AoGARu/WI6IHVpNPkHmstk4C\nP+afA0kllhPnjCqjY9vY2OME/I+Xj9llaZwp6XYfBQ6l29yoAkufS2jmoQxqNGY2\nZrfAPaxUEYxppy8HcR/JIF1GKZYKdl3obW+dEOAoMhY6fdy+8WF0aHnASns/hNhU\nxMPX5m26y0zKqk1F3mlM6IU=\n-----END PRIVATE KEY-----\n";
const SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "test@example.iam.gserviceaccount.com", private_key: TEST_PRIVATE_KEY });

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Stubs the three network calls fetchCosts makes in sequence: the OAuth
// token exchange, the dataset table listing (to discover the export table
// name), and the BigQuery query itself. `queryRows` is returned verbatim as
// the query's `rows`; `onQuery` (optional) receives the query body so a test
// can assert on the generated SQL.
function stubFetch({ queryRows, onQuery }) {
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href === "https://oauth2.googleapis.com/token") {
      return jsonResponse({ access_token: "test-token", expires_in: 3600 });
    }
    if (href.includes("/datasets/billing_export/tables")) {
      return jsonResponse({ tables: [{ tableReference: { tableId: "gcp_billing_export_v1_ABC123" } }] });
    }
    if (href.includes("/queries")) {
      if (onQuery) onQuery(JSON.parse(options.body).query);
      return jsonResponse({ jobComplete: true, rows: queryRows });
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return () => { global.fetch = original; };
}

function bqRow(...values) {
  return { f: values.map(v => ({ v: String(v) })) };
}

const start = new Date("2026-09-01T00:00:00Z");
const end = new Date("2026-09-02T00:00:00Z");
const overrides = { serviceAccountJson: SERVICE_ACCOUNT_JSON, project: "test-project" };

test("query is scoped to generative-AI services only", async (t) => {
  let capturedQuery = "";
  const restore = stubFetch({ queryRows: [], onQuery: q => { capturedQuery = q; } });
  t.after(restore);

  await fetchCosts(start, end, overrides);
  assert.match(capturedQuery, /service\.description IN \('Vertex AI', 'Generative Language API'\)/);
});

test("populates input/output tokens from usage.amount when the row has a matching label", async (t) => {
  const restore = stubFetch({
    queryRows: [bqRow("2026-09-01", "gemini25flashlite", "proj-1", "My Project", "1.50", "10000", "2000")],
  });
  t.after(restore);

  const result = await fetchCosts(start, end, overrides);
  assert.equal(result.dayModels.length, 1);
  assert.deepEqual(result.dayModels[0], {
    date: "2026-09-01", model: "gemini25flashlite", amount_usd: 1.5, input_tokens: 10000, output_tokens: 2000,
  });
});

test("treats a zero/zero token result on a real-spend row as unavailable, not truly zero", async (t) => {
  const restore = stubFetch({
    queryRows: [bqRow("2026-09-01", "Cloud Storage", "proj-1", "My Project", "0.05", "0", "0")],
  });
  t.after(restore);

  const result = await fetchCosts(start, end, overrides);
  assert.equal(result.dayModels[0].input_tokens, null);
  assert.equal(result.dayModels[0].output_tokens, null);
  assert.equal(result.dayModels[0].amount_usd, 0.05);
});

test("sums amount and tokens across multiple project rows for the same day/model", async (t) => {
  const restore = stubFetch({
    queryRows: [
      bqRow("2026-09-01", "gemini25flashlite", "proj-1", "Project One", "1.00", "5000", "1000"),
      bqRow("2026-09-01", "gemini25flashlite", "proj-2", "Project Two", "0.50", "2500", "500"),
    ],
  });
  t.after(restore);

  const result = await fetchCosts(start, end, overrides);
  assert.equal(result.dayModels.length, 1);
  assert.deepEqual(result.dayModels[0], {
    date: "2026-09-01", model: "gemini25flashlite", amount_usd: 1.5, input_tokens: 7500, output_tokens: 1500,
  });
});
