// OpenAI organization Costs API -> normalized [{ date, provider, amount_usd }]
const API_URL = "https://api.openai.com/v1/organization/costs";

// `start`: Date (UTC midnight). Throws on missing key or API error.
async function fetchCosts(start) {
  const key = process.env.OPENAI_ADMIN_KEY;
  if (!key) throw new Error("OPENAI_ADMIN_KEY is not set in .env");

  const usdByDay = new Map();
  let page = null;
  do {
    const params = new URLSearchParams({
      start_time: String(Math.floor(start.getTime() / 1000)), // unix seconds
      bucket_width: "1d",
      limit: "31",
    });
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
      }
      usdByDay.set(day, usd);
    }
    page = body.has_more ? body.next_page : null;
  } while (page);

  return [...usdByDay].map(([date, usd]) => ({
    date,
    provider: "openai",
    amount_usd: usd,
  }));
}

module.exports = { name: "openai", label: "OpenAI", fetchCosts };
