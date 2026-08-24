// Records one "signed in" audit entry per real sign-in. The server never
// sees the sign-in itself — Supabase Auth handles OAuth/magic-link entirely
// client-side — so the client calls this exactly once, from its
// onAuthStateChange listener's SIGNED_IN event (fired only on an actual new
// sign-in, never on session restore from local storage on a page reload).
// See public/dashboard.html.
const { verifyUser } = require("../lib/supabase");
const { logAudit } = require("../lib/audit");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const user = await verifyUser(req.headers.authorization).catch(() => null);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  await logAudit(req, user, "auth.signed_in", { provider: user.app_metadata?.provider || null }, "api/audit-signin.js");
  res.status(200).json({ ok: true });
};
