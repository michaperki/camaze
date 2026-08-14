// Per-user provider key CRUD. Every request must carry a valid Supabase JWT
// in the Authorization header — verified server-side before anything else.
const cryptoLib = require("../lib/crypto");
const {
  verifyUser,
  listProviderKeys,
  upsertProviderKey,
  deleteProviderKey,
} = require("../lib/supabase");

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

  try {
    if (provider === "google") {
      const { serviceAccountJson, project, dataset } = body;
      if (!serviceAccountJson || !project) {
        res.status(400).json({ error: "Service account JSON and billing project are required" });
        return;
      }
      await providers.google.validateConfig({ serviceAccountJson, project, dataset });
      const payload = JSON.stringify({ serviceAccountJson, project, dataset: dataset || "billing_export" });
      await upsertProviderKey(user.id, "google", cryptoLib.encrypt(payload), project);
    } else {
      const { key } = body;
      if (!key) {
        res.status(400).json({ error: "Key is required" });
        return;
      }
      await providers[provider].validateKey(key);
      await upsertProviderKey(user.id, provider, cryptoLib.encrypt(key), keyHint(key));
    }
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
  res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
  const user = await verifyUser(req.headers.authorization).catch(() => null);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
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
