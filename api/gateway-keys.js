// Per-user gateway key CRUD. Every request must carry a valid Supabase JWT
// in the Authorization header — verified server-side before anything else.
// Mirrors api/keys.js: the secret is hashed and stored, never the key itself.
const crypto = require("node:crypto");
const {
  verifyUser,
  listGatewayKeys,
  createGatewayKey,
  deleteGatewayKey,
} = require("../lib/supabase");

const PROVIDERS = new Set(["anthropic", "openai"]);

function generateKey() {
  return "cz-live-" + crypto.randomBytes(16).toString("hex");
}

function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

async function handleGet(user, res) {
  const rows = await listGatewayKeys(user.id);
  res.status(200).json({
    keys: rows.map((r) => ({
      id: r.id,
      label: r.label,
      provider: r.provider,
      createdAt: r.created_at,
      hint: r.key_hint,
    })),
  });
}

async function handlePost(req, res, user) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const { provider } = body;

  if (!label) {
    res.status(400).json({ error: "Label is required" });
    return;
  }
  if (!PROVIDERS.has(provider)) {
    res.status(400).json({ error: `Unknown provider: ${provider}` });
    return;
  }

  const key = generateKey();
  const hint = key.slice(-4);
  const row = await createGatewayKey(user.id, label, provider, hashKey(key), hint);

  // The only point in this key's lifetime it's ever sent back in full.
  res.status(200).json({
    key,
    id: row.id,
    label: row.label,
    provider: row.provider,
    createdAt: row.created_at,
    hint,
  });
}

async function handleDelete(req, res, user) {
  const id = req.query?.id;
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }
  await deleteGatewayKey(user.id, id);
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
