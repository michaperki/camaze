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

// { monthly_budget }, or null if the user has no settings row yet.
async function getUserSettings(userId) {
  const rows = await rest(`/user_settings?user_id=eq.${encodeURIComponent(userId)}&select=monthly_budget`);
  return rows[0] || null;
}

// `monthlyBudget`: number to set, or null to clear it (keeps the row, in
// case other settings live alongside it later).
async function upsertUserSettings(userId, monthlyBudget) {
  return rest(`/user_settings?on_conflict=user_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{
      user_id: userId,
      monthly_budget: monthlyBudget,
      updated_at: new Date().toISOString(),
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
};
