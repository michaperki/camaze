// Per-user notification settings CRUD, stored in user_notification_settings
// (digest + alert toggles) and user_settings (the alert threshold, which
// lives alongside monthly_budget). Same JWT auth pattern as api/keys.js and
// api/budget.js. Each control on the Notifications page self-saves
// independently (see public/notifications.html), so POST accepts any subset
// of fields and merges over the current row rather than requiring all of
// them every time.
const {
  verifyUser, getNotificationSettings, upsertNotificationSettings,
  getUserSettings, upsertUserSettings,
} = require("../lib/supabase");
const { BUDGET_DEFAULT_THRESHOLD_PCT } = require("../lib/alerts");

const DEFAULT_DIGEST_HOUR = 9;

async function handleGet(user, res) {
  const [settings, userSettings] = await Promise.all([
    getNotificationSettings(user.id),
    getUserSettings(user.id),
  ]);
  res.status(200).json({
    digestEnabled: settings?.digest_enabled ?? false,
    digestHour: settings?.digest_hour ?? DEFAULT_DIGEST_HOUR,
    spikeAlertsEnabled: settings?.spike_alerts_enabled ?? true,
    budgetAlertsEnabled: settings?.budget_alerts_enabled ?? true,
    alertThreshold: userSettings?.alert_threshold ?? BUDGET_DEFAULT_THRESHOLD_PCT,
    hasBudget: (userSettings?.monthly_budget ?? 0) > 0,
  });
}

async function handlePost(req, res, user) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const current = await getNotificationSettings(user.id);

  const digestEnabled = body.digestEnabled !== undefined ? !!body.digestEnabled : (current?.digest_enabled ?? false);
  const digestHour = body.digestHour !== undefined ? Number(body.digestHour) : (current?.digest_hour ?? DEFAULT_DIGEST_HOUR);
  if (!Number.isInteger(digestHour) || digestHour < 0 || digestHour > 23) {
    res.status(400).json({ error: "digestHour must be an integer between 0 and 23 (UTC)" });
    return;
  }
  const spikeAlertsEnabled = body.spikeAlertsEnabled !== undefined ? !!body.spikeAlertsEnabled : (current?.spike_alerts_enabled ?? true);
  const budgetAlertsEnabled = body.budgetAlertsEnabled !== undefined ? !!body.budgetAlertsEnabled : (current?.budget_alerts_enabled ?? true);

  await upsertNotificationSettings(user.id, digestEnabled, digestHour, spikeAlertsEnabled, budgetAlertsEnabled);

  const responseBody = { ok: true, digestEnabled, digestHour, spikeAlertsEnabled, budgetAlertsEnabled };

  if (body.alertThreshold !== undefined) {
    const alertThreshold = Number(body.alertThreshold);
    if (!Number.isFinite(alertThreshold) || alertThreshold <= 0 || alertThreshold > 1000) {
      res.status(400).json({ error: "alertThreshold must be a positive number" });
      return;
    }
    const userSettings = await getUserSettings(user.id);
    await upsertUserSettings(user.id, userSettings?.monthly_budget ?? null, alertThreshold);
    responseBody.alertThreshold = alertThreshold;
  }

  res.status(200).json(responseBody);
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
