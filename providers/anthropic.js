// Anthropic Admin API cost report -> normalized [{ date, provider, amount_usd }]
const API_URL = "https://api.anthropic.com/v1/organizations/cost_report";

// `start`: Date (UTC midnight). `keyOverride`: use this key instead of the
// env var (per-user keys). Throws on missing key or API error.
async function fetchCosts(start, keyOverride) {
  const key = keyOverride || process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) throw new Error("ANTHROPIC_ADMIN_KEY is not set in .env");

  const centsByDay = new Map();
  let page = null;
  do {
    const params = new URLSearchParams({
      starting_at: start.toISOString(),
      bucket_width: "1d",
      limit: "31",
    });
    if (page) params.set("page", page);

    const res = await fetch(`${API_URL}?${params}`, {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error?.message || `HTTP ${res.status} from Anthropic API`);
    }

    for (const bucket of body.data || []) {
      const day = bucket.starting_at.slice(0, 10);
      let cents = centsByDay.get(day) || 0;
      for (const item of bucket.results || []) {
        // Coerce at the boundary — amount is a decimal string in cents.
        const value = Number(item.amount ?? 0);
        if (!Number.isFinite(value)) {
          throw new Error(`Anthropic returned a non-numeric amount for ${day}: ${JSON.stringify(item.amount)}`);
        }
        cents += value;
      }
      centsByDay.set(day, cents);
    }
    page = body.has_more ? body.next_page : null;
  } while (page);

  return [...centsByDay].map(([date, cents]) => ({
    date,
    provider: "anthropic",
    amount_usd: cents / 100,
  }));
}

// Minimal authenticated request — confirms a key works before it's saved,
// without pulling a full cost report. Throws with the API's error message.
async function validateKey(key) {
  // starting_at must be day-aligned (bucket_width=1d), or the API rejects
  // the implied [starting_at, now] range as inverted.
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const params = new URLSearchParams({
    starting_at: yesterday.toISOString(),
    bucket_width: "1d",
    limit: "1",
  });
  const res = await fetch(`${API_URL}?${params}`, {
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
  });
  if (res.ok) return;
  const body = await res.json().catch(() => null);
  throw new Error(body?.error?.message || `HTTP ${res.status} from Anthropic API`);
}

module.exports = { name: "anthropic", label: "Anthropic", fetchCosts, validateKey };
