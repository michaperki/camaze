// Manual fixed-cost entries — consumer subscriptions and per-seat licenses
// (Claude Pro, ChatGPT Plus, Copilot seats, Cursor, ...) that no provider
// API reports. CRUD against user_fixed_costs over plain fetch (PostgREST),
// same pattern as lib/supabase.js: uses the service role key, which
// bypasses RLS, so every query below is manually scoped to a caller-
// supplied user_id.
function config() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return { url, serviceRoleKey };
}

async function rest(path, options = {}) {
  const { url, serviceRoleKey } = config();
  const res = await fetch(`${url}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message || `HTTP ${res.status} from Supabase`);
  }
  if (res.status === 204) return null;
  return res.json();
}

const SELECT = "id,vendor,label,unit_cost_usd,seats,billing_period,started_on,ended_on,created_at";

// All fixed-cost rows for one user, newest first.
async function listFixedCosts(userId) {
  return rest(`/user_fixed_costs?user_id=eq.${encodeURIComponent(userId)}&select=${SELECT}&order=created_at.desc`);
}

async function createFixedCost(userId, fields) {
  const rows = await rest(`/user_fixed_costs`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ user_id: userId, ...fields }]),
  });
  return rows[0];
}

// Scoped by user_id AND id so one user's request can never touch another
// user's row, even with a guessed/leaked id.
async function updateFixedCost(userId, id, fields) {
  const rows = await rest(
    `/user_fixed_costs?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(id)}`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(fields) }
  );
  return rows[0] || null;
}

async function deleteFixedCost(userId, id) {
  await rest(
    `/user_fixed_costs?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

// "YYYY-MM" -> the calendar month's first/last day as ISO date strings —
// comparable lexicographically against started_on/ended_on (plain dates,
// no time component, so string comparison sorts the same as date order).
function monthBounds(monthStr) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr);
  if (!m) throw new Error(`Invalid month: ${monthStr}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${monthStr}-01`, end: `${monthStr}-${String(daysInMonth).padStart(2, "0")}` };
}

function isActiveInMonth(row, start, end) {
  if (row.started_on > end) return false;
  if (row.ended_on && row.ended_on < start) return false;
  return true;
}

// A row counts in full for any month it was active on at least one day —
// no proration by days elapsed. Annual rows contribute 1/12th of
// unit_cost_usd for that month; monthly rows contribute the full
// unit_cost_usd. Either way, the result is then multiplied by seats.
function rowContribution(row) {
  const base = row.billing_period === "annual" ? row.unit_cost_usd / 12 : row.unit_cost_usd;
  return base * row.seats;
}

// This user's fixed-cost rows active during the given month, each with its
// monthly contribution attached as amount_usd.
async function activeFixedCostsForMonth(userId, monthStr) {
  const { start, end } = monthBounds(monthStr);
  const rows = await listFixedCosts(userId);
  return rows
    .filter(r => isActiveInMonth(r, start, end))
    .map(r => ({ ...r, amount_usd: rowContribution(r) }));
}

module.exports = {
  listFixedCosts,
  createFixedCost,
  updateFixedCost,
  deleteFixedCost,
  activeFixedCostsForMonth,
};
