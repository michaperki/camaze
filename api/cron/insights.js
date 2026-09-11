const { refreshSource } = require("../../lib/insights/store");
module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  try { return res.status(200).json(await refreshSource()); }
  catch { return res.status(503).json({ error: "Benchmark refresh storage unavailable" }); }
};
