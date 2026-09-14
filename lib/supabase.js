// Server-side Supabase access: JWT verification and the user_provider_keys
// table, both over plain fetch (Auth + PostgREST REST APIs) so no npm
// client is needed. Uses the service role key, which bypasses RLS — every
// query below is manually scoped to a caller-supplied user_id.
function config() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return { url, serviceRoleKey };
}

// Verifies a bearer token against Supabase Auth. Returns the user object
// ({ id, email, ... }) or null if the header is missing/malformed or the
// token is invalid/expired — never throws on a bad token.
async function verifyUser(authHeader) {
  const ctx = require("./context").current();
  if (ctx) return { ...ctx.actor, id: require("./context").OWNER };
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  const { url, serviceRoleKey } = config();

  const res = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user.id === require("./context").OWNER ? null : user;
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
      ...require("./context").headers(),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message || `HTTP ${res.status} from Supabase`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// { provider, key_hint, updated_at }[] — never includes encrypted_data.
async function listProviderKeys(userId) {
  require("./context").assertOwner(userId);
  return rest(`/user_provider_keys?user_id=eq.${encodeURIComponent(userId)}&select=provider,key_hint,updated_at`);
}

// { provider, encrypted_data }[] — for actually using the stored keys.
async function getAllProviderKeys(userId) {
  if (userId === require("./context").OWNER) throw new Error("Simulation has no credentials");
  require("./context").assertOwner(userId);
  return rest(`/user_provider_keys?user_id=eq.${encodeURIComponent(userId)}&select=provider,encrypted_data`);
}

async function upsertProviderKey(userId, provider, encryptedData, keyHint) {
  require("./context").assertOwner(userId);
  return rest(`/user_provider_keys?on_conflict=user_id,provider`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{
      user_id: userId,
      provider,
      encrypted_data: encryptedData,
      key_hint: keyHint,
      updated_at: new Date().toISOString(),
    }]),
  });
}

async function deleteProviderKey(userId, provider) {
  require("./context").assertOwner(userId);
  await rest(
    `/user_provider_keys?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(provider)}`,
    { method: "DELETE" }
  );
}

// { monthly_budget, alert_threshold }, or null if the user has no settings row yet.
async function getUserSettings(userId) {
  require("./context").assertOwner(userId);
  const rows = await rest(`/user_settings?user_id=eq.${encodeURIComponent(userId)}&select=monthly_budget,alert_threshold`);
  return rows[0] || null;
}

// `monthlyBudget`: number to set, or null to clear it (keeps the row, in
// case other settings live alongside it later). `alertThreshold`: percent
// (e.g. 80), or undefined to leave it untouched — callers that only manage
// the budget shouldn't clobber a threshold saved from the notifications page.
async function upsertUserSettings(userId, monthlyBudget, alertThreshold) {
  require("./context").assertOwner(userId);
  const row = {
    user_id: userId,
    monthly_budget: monthlyBudget,
    updated_at: new Date().toISOString(),
  };
  if (alertThreshold !== undefined) row.alert_threshold = alertThreshold;
  return rest(`/user_settings?on_conflict=user_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([row]),
  });
}

// { digest_enabled, digest_hour, spike_alerts_enabled, budget_alerts_enabled },
// or null if the user has no settings row yet.
async function getNotificationSettings(userId) {
  require("./context").assertOwner(userId);
  const rows = await rest(
    `/user_notification_settings?user_id=eq.${encodeURIComponent(userId)}` +
    `&select=digest_enabled,digest_hour,spike_alerts_enabled,budget_alerts_enabled`
  );
  return rows[0] || null;
}

async function upsertNotificationSettings(userId, digestEnabled, digestHour, spikeAlertsEnabled, budgetAlertsEnabled) {
  require("./context").assertOwner(userId);
  return rest(`/user_notification_settings?on_conflict=user_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{
      user_id: userId,
      digest_enabled: digestEnabled,
      digest_hour: digestHour,
      spike_alerts_enabled: spikeAlertsEnabled,
      budget_alerts_enabled: budgetAlertsEnabled,
      updated_at: new Date().toISOString(),
    }]),
  });
}

// [{ user_id }] — everyone with the daily digest turned on. Vercel Hobby
// cron jobs can only run once/day, so there's no per-user hour matching
// yet — digest_hour is stored (and shown in the UI) for when a paid plan
// allows checking it hourly again.
async function listEnabledDigestUsers() {
  return rest(`/user_notification_settings?user_id=neq.ca0a2e00-0000-4000-8000-000000000001&digest_enabled=eq.true&select=user_id`);
}

// [{ user_id, spike_alerts_enabled, budget_alerts_enabled }] — everyone with
// at least one alert type turned on. Independent of digest_enabled: a user
// can turn off the daily summary but keep budget/spike alerts on. Checked in
// the same cron run as the digest (see api/cron/digest.js) since Vercel
// Hobby only allows one cron/day.
async function listAlertEnabledUsers() {
  return rest(
    `/user_notification_settings?user_id=neq.ca0a2e00-0000-4000-8000-000000000001&or=(spike_alerts_enabled.eq.true,budget_alerts_enabled.eq.true)` +
    `&select=user_id,spike_alerts_enabled,budget_alerts_enabled`
  );
}

// Attempts to claim an alert slot for (userId, alertKey) so it can only ever
// fire once. Returns true if this call created the row (i.e. the caller
// should send the alert); false if a row already existed (already sent, or
// a concurrent/retried run beat us to it).
async function claimAlert(userId, alertKey) {
  require("./context").assertOwner(userId);
  const rows = await rest(`/alert_state?on_conflict=user_id,alert_key`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify([{ user_id: userId, alert_key: alertKey }]),
  });
  return Array.isArray(rows) && rows.length > 0;
}

// Admin lookup by user id, for the cron path — which has no per-user JWT to
// verify, only a user_id from user_notification_settings. Returns the full
// Supabase auth user object (includes email), or null if not found.
async function getUserById(userId) {
  if (require("./context").current() && userId === require("./context").OWNER) return { id: userId, email: "company@camaze-simulation.invalid" };
  require("./context").assertOwner(userId);
  const { url, serviceRoleKey } = config();
  const res = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

// Distinct user_ids with at least one connected provider — the cron sync
// (api/cron/sync-costs.js) processes exactly this set. De-duped in JS since
// PostgREST has no DISTINCT.
async function listUsersWithProviderKeys() {
  const rows = await rest(`/user_provider_keys?user_id=neq.ca0a2e00-0000-4000-8000-000000000001&select=user_id`);
  return [...new Set(rows.map(r => r.user_id))];
}

// { data, fetched_at }, or null if no row exists yet for this cache id
// (e.g. "litellm"). `data` is whatever JSON blob was stored — the caller
// knows how to interpret it.
async function getPriceCache(id) {
  const rows = await rest(`/price_cache?id=eq.${encodeURIComponent(id)}&select=data,fetched_at`);
  return rows[0] || null;
}

async function upsertPriceCache(id, data) {
  return rest(`/price_cache?on_conflict=id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{ id, data, fetched_at: new Date().toISOString() }]),
  });
}

// Inserts one row into the append-only audit_log table — no update/delete
// counterpart exists here or anywhere else in the codebase, and the table
// itself rejects both at the database level (see the audit_log migration
// SQL). Never call with encrypted_data or any other key material in
// `detail` — audit entries must be safe to read even by someone who
// shouldn't see a customer's provider credentials.
async function logAudit({ userId, email, action, detail, ip, route }) {
  await rest(`/audit_log`, {
    method: "POST",
    body: JSON.stringify([{
      actor_user_id: userId,
      actor_email: email,
      action,
      detail: detail || {},
      ip_address: ip || null,
      created_by_route: route || null,
    }]),
  });
}

module.exports = {
  verifyUser,
  listProviderKeys,
  getAllProviderKeys,
  upsertProviderKey,
  deleteProviderKey,
  getUserSettings,
  upsertUserSettings,
  getNotificationSettings,
  upsertNotificationSettings,
  listEnabledDigestUsers,
  listAlertEnabledUsers,
  claimAlert,
  getUserById,
  listUsersWithProviderKeys,
  getPriceCache,
  upsertPriceCache,
  logAudit,
};
