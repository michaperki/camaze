async function rest(path, options = {}) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Insights storage is not configured");
  const response = await fetch(`${url}/rest/v1${path}`, { ...options, signal: AbortSignal.timeout(15000), headers: {
    apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...options.headers,
      ...require("../context").headers(),
  } });
  if (!response.ok) throw new Error(`Insights storage HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function getUsage(userId, period, request = rest) {
  require("../context").assertOwner(userId);
  // Paginate explicitly; PostgREST commonly caps responses at 1,000 rows.
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = await request(`/daily_costs?user_id=eq.${encodeURIComponent(userId)}&date=gte.${period.start}&date=lt.${period.end}&select=date,provider,model,amount_usd,is_subscription,updated_at,input_tokens,output_tokens&order=date,provider,model,is_subscription&limit=500&offset=${offset}`);
    rows.push(...page);
    if (page.length < 500) return rows;
    if (offset >= 99500) throw new Error("Usage exceeds supported review size");
  }
}
function selectSource(stored, bundled = require('./snapshot.json'), models = require('./catalog').models, now = new Date()) {
  const { coverage } = require('./evidence');
  const { fresh } = require('./rules');
  const usable = snapshot => coverage(snapshot, models).complete && fresh(snapshot?.fetchedAt, now, 7);
  // A reviewed public snapshot ships with a catalog change. It retains its real
  // fetch date, expires normally, and never causes page-load network scraping.
  if (usable(bundled) && (!usable(stored?.snapshot) || Date.parse(bundled.fetchedAt) > Date.parse(stored.snapshot.fetchedAt))) {
    return { ...stored, status: stored?.status || 'pending', snapshot: bundled, origin: 'bundled',
      storedCoverage: coverage(stored?.snapshot, models) };
  }
  return { ...stored, origin: 'shared', snapshot: stored?.snapshot || null };
}
async function getSource() {
  if (require('../context').current()) return { status: 'ok', origin: 'simulation', snapshot: require('./snapshot.json') };
  let stored;
  try { stored = (await rest("/insight_sources?id=eq.artificial-analysis&select=snapshot,last_attempt_at,status,error"))[0]; }
  catch { stored = { status: 'unavailable' }; }
  return selectSource(stored);
}
async function refreshSource({ getSnapshot = require("./source").fetchPublicSnapshot, request = rest, clock = () => new Date(), now = clock() } = {}) {
  const claims = await request("/insight_sources?id=eq.artificial-analysis&next_attempt_at=lte." + encodeURIComponent(now.toISOString()), {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ next_attempt_at: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(), last_attempt_at: now.toISOString(), status: "refreshing" }),
  });
  if (!claims?.length) return { status: "skipped" };
  let result;
  try {
    const models = require('./catalog').models;
    const snapshot = await getSnapshot(models);
    const coverage = require('./evidence').coverage(snapshot, models);
    // fetchedAt is recorded after the HTTP request; validate against completion
    // time, not the earlier claim time (which would reject every live refresh).
    if (!coverage.complete || !require('./rules').fresh(snapshot.fetchedAt, clock(), 7)) throw new Error(`Incomplete or stale benchmark snapshot (${coverage.matched}/${coverage.expected})`);
    result = { snapshot, status: "ok", error: null };
  }
  catch (error) { result = { status: "error", error: error.message.slice(0, 200) }; }
  // Failed extraction deliberately omits snapshot, preserving the last success.
  await request("/insight_sources?id=eq.artificial-analysis", { method: "PATCH", body: JSON.stringify(result) });
  return { status: result.status, error: result.error, records: result.snapshot?.records.length };
}
module.exports = { getUsage, getSource, refreshSource, selectSource };
