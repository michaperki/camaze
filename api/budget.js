// Per-user monthly budget CRUD, stored in user_settings. Every request must
// carry a valid Supabase JWT — verified server-side before anything else,
// same pattern as api/keys.js.
const { verifyUser, getUserSettings, upsertUserSettings } = require("../lib/supabase");

async function handleGet(user, res) {
  const settings = await getUserSettings(user.id);
  res.status(200).json({ budget: settings?.monthly_budget ?? null });
}

async function handlePost(req, res, user) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const budget = Number(body.budget);
  if (!Number.isFinite(budget) || budget < 0) {
    res.status(400).json({ error: "budget must be a non-negative number" });
    return;
  }
  await upsertUserSettings(user.id, budget);
  res.status(200).json({ ok: true, budget });
}

async function handleDelete(user, res) {
  await upsertUserSettings(user.id, null);
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
    if (req.method === "DELETE") return await handleDelete(user, res);
    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
