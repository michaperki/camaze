const { verifyUser } = require("../lib/supabase");
const { getUsage, getSource } = require("../lib/insights/store");
const { recommend, recentWindow } = require("../lib/insights/rules");
function createHandler(deps = { verifyUser, getUsage, getSource }, now = () => new Date()) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
    const user = await deps.verifyUser(req.headers.authorization).catch(() => null);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const date = now();
    try {
      const [rows, source] = await Promise.all([
        deps.getUsage(user.id, recentWindow(date)),
        deps.getSource().catch(() => ({ status: "unavailable", snapshot: null })),
      ]);
      const result = recommend(rows, source?.snapshot, date);
      const age = source?.snapshot?.fetchedAt ? +date - Date.parse(source.snapshot.fetchedAt) : null;
      return res.status(200).json({ ...result, source: { status: source?.status || "pending", fetchedAt: source?.snapshot?.fetchedAt || null,
        ageDays: Number.isFinite(age) ? Math.max(0, age / 86400000) : null, lastAttemptAt: source?.last_attempt_at || null },
        usageSyncedAt: rows.map(r => r.updated_at).filter(Boolean).sort().at(-1) || null });
    } catch { return res.status(503).json({ error: "Recorded usage could not be loaded. Try again later." }); }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
