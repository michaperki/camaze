// OpenAI organization Costs API -> normalized [{ date, provider, amount_usd }]
const API_URL = "https://api.openai.com/v1/organization/costs";

// `start`: Date (UTC midnight). `keyOverride`: use this key instead of the
// env var (per-user keys). Throws on missing key or API error. Returns
// { days, models } — both derived from the same request.
async function fetchCosts(start, keyOverride) {
  const key = keyOverride || process.env.OPENAI_ADMIN_KEY;
  if (!key) throw new Error("OPENAI_ADMIN_KEY is not set in .env");

  const usdByDay = new Map();
  const usdByModel = new Map();
  let page = null;
  do {
    const params = new URLSearchParams({
      start_time: String(Math.floor(start.getTime() / 1000)), // unix seconds
      bucket_width: "1d",
      limit: "31",
    });
    // There's no `model` field on this endpoint — grouping by line_item is
    // what breaks costs down per model, as strings like
    // "gpt-4o-mini-2024-07-18, cached input".
    params.append("group_by[]", "line_item");
    if (page) params.set("page", page);

    const res = await fetch(`${API_URL}?${params}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error?.message || `HTTP ${res.status} from OpenAI API`);
    }

    for (const bucket of body.data || []) {
      const day = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
      let usd = usdByDay.get(day) || 0;
      for (const item of bucket.results || []) {
        // Coerce at the boundary — the API may send numbers or numeric strings.
        const value = Number(item.amount?.value ?? 0); // in dollars
        if (!Number.isFinite(value)) {
          throw new Error(`OpenAI returned a non-numeric amount for ${day}: ${JSON.stringify(item.amount)}`);
        }
        usd += value;
        // line_item is "<model>, input" / "<model>, cached input" / "<model>, output".
        const model = item.line_item?.split(",")[0]?.trim();
        if (model) {
          usdByModel.set(model, (usdByModel.get(model) || 0) + value);
        }
      }
      usdByDay.set(day, usd);
    }
    page = body.has_more ? body.next_page : null;
  } while (page);

  return {
    days: [...usdByDay].map(([date, usd]) => ({
      date,
      provider: "openai",
      amount_usd: usd,
    })),
    models: [...usdByModel].map(([model, usd]) => ({
      model,
      amount_usd: usd,
    })),
  };
}

// Minimal authenticated request — confirms a key works before it's saved,
// without pulling a full cost report. Throws with the API's error message.
async function validateKey(key) {
  // start_time must be day-aligned (bucket_width=1d), same constraint as
  // fetchCosts, to avoid an inverted-range error unrelated to the key itself.
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const params = new URLSearchParams({
    start_time: String(Math.floor(yesterday.getTime() / 1000)),
    bucket_width: "1d",
    limit: "1",
  });
  const res = await fetch(`${API_URL}?${params}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.ok) return;
  const body = await res.json().catch(() => null);
  throw new Error(body?.error?.message || `HTTP ${res.status} from OpenAI API`);
}

module.exports = { name: "openai", label: "OpenAI", fetchCosts, validateKey };
