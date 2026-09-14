async function rest(path, options = {}) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Insights storage is not configured");
  const response = await fetch(`${url}/rest/v1${path}`, { ...options, signal: AbortSignal.timeout(15000), headers: {
    apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...options.headers,
  } });
  if (!response.ok) throw new Error(`Insights storage HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function getUsage(userId, period, request = rest) {
  // Paginate explicitly; PostgREST commonly caps responses at 1,000 rows.
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = await request(`/daily_costs?user_id=eq.${encodeURIComponent(userId)}&date=gte.${period.start}&date=lt.${period.end}&select=date,provider,model,amount_usd,is_subscription,updated_at,input_tokens,output_tokens&order=date,provider,model,is_subscription&limit=500&offset=${offset}`);
    rows.push(...page);
    if (page.length < 500) return rows;
    if (offset >= 99500) throw new Error("Usage exceeds supported review size");
  }
}
async function getSource() { return (await rest("/insight_sources?id=eq.artificial-analysis&select=snapshot,last_attempt_at,status,error"))[0] || null; }
async function refreshSource({ getSnapshot = require("./source").fetchPublicSnapshot, request = rest, now = new Date() } = {}) {
  const claims = await request("/insight_sources?id=eq.artificial-analysis&next_attempt_at=lte." + encodeURIComponent(now.toISOString()), {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ next_attempt_at: new Date(+now + 86400000).toISOString(), last_attempt_at: now.toISOString(), status: "refreshing" }),
  });
  if (!claims?.length) return { status: "skipped" };
  let result;
  try { result = { snapshot: await getSnapshot(require("./catalog").models), status: "ok", error: null }; }
  catch (error) { result = { status: "error", error: error.message.slice(0, 200) }; }
  // Failed extraction deliberately omits snapshot, preserving the last success.
  await request("/insight_sources?id=eq.artificial-analysis", { method: "PATCH", body: JSON.stringify(result) });
  return { status: result.status, error: result.error, records: result.snapshot?.records.length };
}
module.exports = { getUsage, getSource, refreshSource };
