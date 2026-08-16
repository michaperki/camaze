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
  return res.json();
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

// { provider, key_hint, updated_at }[] — never includes encrypted_data.
async function listProviderKeys(userId) {
  return rest(`/user_provider_keys?user_id=eq.${encodeURIComponent(userId)}&select=provider,key_hint,updated_at`);
}

// { provider, encrypted_data }[] — for actually using the stored keys.
async function getAllProviderKeys(userId) {
  return rest(`/user_provider_keys?user_id=eq.${encodeURIComponent(userId)}&select=provider,encrypted_data`);
}

async function upsertProviderKey(userId, provider, encryptedData, keyHint) {
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
  await rest(
    `/user_provider_keys?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(provider)}`,
    { method: "DELETE" }
  );
}

// { monthly_budget, alert_threshold }, or null if the user has no settings row yet.
async function getUserSettings(userId) {
  const rows = await rest(`/user_settings?user_id=eq.${encodeURIComponent(userId)}&select=monthly_budget,alert_threshold`);
  return rows[0] || null;
}

// `monthlyBudget`: number to set, or null to clear it (keeps the row, in
// case other settings live alongside it later). `alertThreshold`: percent
// (e.g. 80), or undefined to leave it untouched — callers that only manage
// the budget shouldn't clobber a threshold saved from the notifications page.
async function upsertUserSettings(userId, monthlyBudget, alertThreshold) {
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
  const rows = await rest(
    `/user_notification_settings?user_id=eq.${encodeURIComponent(userId)}` +
    `&select=digest_enabled,digest_hour,spike_alerts_enabled,budget_alerts_enabled`
  );
  return rows[0] || null;
}

async function upsertNotificationSettings(userId, digestEnabled, digestHour, spikeAlertsEnabled, budgetAlertsEnabled) {
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
  return rest(`/user_notification_settings?digest_enabled=eq.true&select=user_id`);
}

// [{ user_id, spike_alerts_enabled, budget_alerts_enabled }] — everyone with
// at least one alert type turned on. Independent of digest_enabled: a user
// can turn off the daily summary but keep budget/spike alerts on. Checked in
// the same cron run as the digest (see api/cron/digest.js) since Vercel
// Hobby only allows one cron/day.
async function listAlertEnabledUsers() {
  return rest(
    `/user_notification_settings?or=(spike_alerts_enabled.eq.true,budget_alerts_enabled.eq.true)` +
    `&select=user_id,spike_alerts_enabled,budget_alerts_enabled`
  );
}

// Attempts to claim an alert slot for (userId, alertKey) so it can only ever
// fire once. Returns true if this call created the row (i.e. the caller
// should send the alert); false if a row already existed (already sent, or
// a concurrent/retried run beat us to it).
async function claimAlert(userId, alertKey) {
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

// { id, label, provider, created_at, key_hint }[], newest first.
async function listGatewayKeys(userId) {
  return rest(
    `/gateway_keys?user_id=eq.${encodeURIComponent(userId)}` +
    `&select=id,label,provider,created_at,key_hint&order=created_at.desc`
  );
}

async function createGatewayKey(userId, label, provider, keyHash, keyHint) {
  const rows = await rest(`/gateway_keys`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{
      user_id: userId,
      label,
      provider,
      key_hash: keyHash,
      key_hint: keyHint,
    }]),
  });
  return rows[0];
}

async function deleteGatewayKey(userId, id) {
  await rest(
    `/gateway_keys?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

// { user_id, provider } for a live gateway key, or null if the hash doesn't
// match any row (revoked or never existed).
async function lookupGatewayKey(keyHash) {
  const rows = await rest(`/gateway_keys?key_hash=eq.${encodeURIComponent(keyHash)}&select=user_id,provider`);
  return rows[0] || null;
}

// Encrypted provider credential for one user+provider (still needs
// lib/crypto.decrypt), or null if that provider isn't connected.
async function getProviderKey(userId, provider) {
  const rows = await rest(
    `/user_provider_keys?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(provider)}&select=encrypted_data`
  );
  return rows[0]?.encrypted_data || null;
}

// Logs one proxied gateway call for cost attribution. Never called with
// auth.uid()-scoped RLS in mind — the insert is scoped to userId explicitly
// since this always runs server-side under the service role key.
async function logGatewayRequest({ userId, provider, model, workflow, inputTokens, outputTokens, costUsd, durationMs }) {
  await rest(`/gateway_requests`, {
    method: "POST",
    body: JSON.stringify([{
      user_id: userId,
      provider,
      model: model || null,
      workflow: workflow || null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      duration_ms: durationMs,
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
  listGatewayKeys,
  createGatewayKey,
  deleteGatewayKey,
  lookupGatewayKey,
  getProviderKey,
  logGatewayRequest,
};
