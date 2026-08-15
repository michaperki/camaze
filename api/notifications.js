// Per-user notification settings CRUD, stored in user_notification_settings.
// Same JWT auth pattern as api/keys.js and api/budget.js. Only the daily
// digest lives here for now — a future Slack section would add its own
// fields (e.g. slackEnabled/slackWebhookUrl) alongside these.
const { verifyUser, getNotificationSettings, upsertNotificationSettings } = require("../lib/supabase");

const DEFAULT_DIGEST_HOUR = 9;

async function handleGet(user, res) {
  const settings = await getNotificationSettings(user.id);
  res.status(200).json({
    digestEnabled: settings?.digest_enabled ?? false,
    digestHour: settings?.digest_hour ?? DEFAULT_DIGEST_HOUR,
  });
}

async function handlePost(req, res, user) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const digestEnabled = !!body.digestEnabled;
  const digestHour = Number(body.digestHour);
  if (!Number.isInteger(digestHour) || digestHour < 0 || digestHour > 23) {
    res.status(400).json({ error: "digestHour must be an integer between 0 and 23 (UTC)" });
    return;
  }
  await upsertNotificationSettings(user.id, digestEnabled, digestHour);
  res.status(200).json({ ok: true, digestEnabled, digestHour });
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
    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
