// camaze — minimal AI spend tracker.
// Serves one page and proxies each provider's cost API so keys stay server-side.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || 3000;

const providers = [
  require("./providers/anthropic"),
  require("./providers/openai"),
  require("./providers/google"),
];

async function fetchAllCosts() {
  // Last 30 full days plus today, snapped to midnight UTC.
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));

  const settled = await Promise.allSettled(providers.map(p => p.fetchCosts(start)));

  const errors = {};
  const byDay = new Map(); // date -> { anthropic: usd, openai: usd, ... }
  const totals = { combined: 0 };
  for (const p of providers) totals[p.name] = 0;

  settled.forEach((result, i) => {
    const p = providers[i];
    if (result.status === "rejected") {
      errors[p.name] = result.reason.message;
      return;
    }
    for (const { date, amount_usd } of result.value) {
      if (!Number.isFinite(amount_usd)) {
        console.warn(`Ignoring non-finite amount from ${p.name} on ${date}: ${amount_usd}`);
        continue;
      }
      if (!byDay.has(date)) byDay.set(date, {});
      byDay.get(date)[p.name] = (byDay.get(date)[p.name] || 0) + amount_usd;
      totals[p.name] += amount_usd;
      totals.combined += amount_usd;
    }
  });

  // Continuous 31-day axis, zero-filled per provider.
  const days = [];
  for (let d = new Date(start); d <= now; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const entry = { date };
    for (const p of providers) entry[p.name] = byDay.get(date)?.[p.name] || 0;
    days.push(entry);
  }

  return {
    providers: providers.map(p => ({ name: p.name, label: p.label, failed: p.name in errors })),
    days,
    totals,
    errors,
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/costs") {
    try {
      const data = await fetchAllCosts();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`camaze running at http://localhost:${PORT}`);
});
