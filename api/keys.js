// Per-user provider key CRUD. Every request must carry a valid Supabase JWT
// in the Authorization header — verified server-side before anything else.
const cryptoLib = require("../lib/crypto");
const {
  verifyUser,
  listProviderKeys,
  upsertProviderKey,
  deleteProviderKey,
} = require("../lib/supabase");
const { logAudit } = require("../lib/audit");

const providers = {
  anthropic: require("../providers/anthropic"),
  openai: require("../providers/openai"),
  google: require("../providers/google"),
};

function keyHint(key) {
  return key.length > 4 ? key.slice(-4) : key;
}

async function handleGet(user, res) {
  const rows = await listProviderKeys(user.id);
  const connected = {};
  for (const row of rows) {
    connected[row.provider] = { connected: true, hint: row.key_hint, updatedAt: row.updated_at };
  }
  res.status(200).json({ providers: connected });
}

async function handlePost(req, res, user) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { provider } = body;
  if (!providers[provider]) {
    res.status(400).json({ error: `Unknown provider: ${provider}` });
    return;
  }

  // Checked before the write so the audit entry can distinguish a first
  // connection from a credential rotation on an already-connected provider.
  const existing = await listProviderKeys(user.id);
  const wasConnected = existing.some((r) => r.provider === provider);

  try {
    let hint;
    if (provider === "google") {
      const { serviceAccountJson, project, dataset } = body;
      if (!serviceAccountJson || !project) {
        res.status(400).json({ error: "Service account JSON and billing project are required" });
        return;
      }
      await providers.google.validateConfig({ serviceAccountJson, project, dataset });
      const payload = JSON.stringify({ serviceAccountJson, project, dataset: dataset || "billing_export" });
      hint = project;
      await upsertProviderKey(user.id, "google", cryptoLib.encrypt(payload), hint);
    } else {
      const { key } = body;
      if (!key) {
        res.status(400).json({ error: "Key is required" });
        return;
      }
      await providers[provider].validateKey(key);
      hint = keyHint(key);
      await upsertProviderKey(user.id, provider, cryptoLib.encrypt(key), hint);
    }
    await logAudit(
      req, user,
      wasConnected ? "provider_key.updated" : "provider_key.connected",
      { provider, hint },
      "api/keys.js"
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    // Validation failures and malformed input are the caller's to fix.
    res.status(400).json({ error: err.message });
  }
}

async function handleDelete(req, res, user) {
  const provider = req.query?.provider;
  if (!providers[provider]) {
    res.status(400).json({ error: `Unknown provider: ${provider}` });
    return;
  }
  await deleteProviderKey(user.id, provider);
  await logAudit(req, user, "provider_key.removed", { provider }, "api/keys.js");
  res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
  const user = await verifyUser(req.headers.authorization).catch(() => null);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (require('../lib/context').current()) {
    if (req.method !== 'GET') return res.status(403).json({ error: 'Simulation connections are controlled by the scenario; real credentials are not accepted.' });
    const providers = Object.fromEntries(['anthropic','openai','google'].map(p => [p, { connected: true, simulated: true, hint: 'SIMULATED' }]));
    return res.status(200).json({ providers });
  }
  try {
    if (req.method === "GET") return await handleGet(user, res);
    if (req.method === "POST") return await handlePost(req, res, user);
    if (req.method === "DELETE") return await handleDelete(req, res, user);
    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
