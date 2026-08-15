// Sends the daily digest email for the requesting user immediately — used
// by the "Send test email now" button. Same JWT auth pattern as
// api/keys.js and api/budget.js. The scheduled path is api/cron/digest.js,
// which calls the same lib/digest.js helper without a user session.
const { verifyUser } = require("../lib/supabase");
const { sendDigestForUser } = require("../lib/digest");

module.exports = async (req, res) => {
  const user = await verifyUser(req.headers.authorization).catch(() => null);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    await sendDigestForUser(user.id);
    res.status(200).json({ ok: true });
  } catch (err) {
    // Missing keys, unconfigured Resend, etc. are the caller's to fix.
    res.status(400).json({ error: err.message });
  }
};
