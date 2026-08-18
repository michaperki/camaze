// Syncs the calling user's last 6 months of provider costs into Supabase
// (see lib/costSync.js), so an existing account gets history without
// waiting for 6 cron cycles. Idempotent — sync is always an upsert, so
// running this again just re-syncs the same months harmlessly.
const { verifyUser } = require("../lib/supabase");
const { syncUserMonth } = require("../lib/costSync");

function monthsBack(now, count) {
  const months = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

module.exports = async (req, res) => {
  const user = await verifyUser(req.headers.authorization).catch(() => null);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const months = monthsBack(new Date(), 6);
    // Sequential, not parallel — each month already fans out to 3 provider
    // calls concurrently inside syncUserMonth; running all 6 months at once
    // would multiply that to ~18 concurrent provider requests, which is how
    // OpenAI's per-key name-resolution fan-out tripped a rate limit before
    // (see lib/costs.js's PROVIDER_SCOPE_PREFERENCE comment).
    const results = [];
    for (const month of months) {
      try {
        const result = await syncUserMonth(user.id, month);
        results.push({ month, ...result });
      } catch (err) {
        results.push({ month, status: "error", error: err.message });
      }
    }
    res.status(200).json({ ok: true, months: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
