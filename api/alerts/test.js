// Sends a real spike-alert email immediately, using yesterday's actual
// numbers — used by the "Send test alert" button on the Notifications page.
// Mirrors api/digest.js's "Send test email now": sends regardless of
// whether the alert toggles are on or whether detection would actually
// fire, and never touches alert_state (so it can be clicked repeatedly).
const { verifyUser, getUserById } = require("../../lib/supabase");
const { resolveOverrides, fetchAllCosts } = require("../../lib/costs");
const { evaluateSpike, dailyTotals, topDriver } = require("../../lib/alerts");
const { renderSpikeAlert, sendAlertEmail } = require("../../lib/alertEmail");

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
    const overrides = await resolveOverrides(user.id);
    if (Object.keys(overrides).length === 0) {
      throw new Error("No providers connected — nothing to send. Connect one on the Integrations page first.");
    }

    const costData = await fetchAllCosts(overrides, false);
    const providerNames = costData.providers.map(p => p.name);
    const totals = dailyTotals(costData.days, providerNames);

    const now = new Date();
    const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    const dateStr = yesterday.toISOString().slice(0, 10);

    const spike = evaluateSpike(totals, dateStr);
    const driver = topDriver(costData, dateStr);
    const fullUser = await getUserById(user.id);
    if (!fullUser?.email) throw new Error("Could not resolve the user's email address");

    const email = renderSpikeAlert({
      dateStr, total: spike.total, baseline: spike.baseline, ratio: spike.ratio, driver,
    });
    await sendAlertEmail(fullUser.email, email);

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
