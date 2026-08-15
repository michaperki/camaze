// Builds and sends the daily spend digest email. Shared by api/digest.js
// (the "Send test email now" button, and manual sends) and
// api/cron/digest.js (the hourly scheduler) — both just need a user_id.
const { resolveOverrides, fetchAllCosts, buildSummary, resolveBudget } = require("./costs");
const { getUserById } = require("./supabase");
const { sendEmail } = require("./email");

// Same reformatting rules as public/index.html's prettifyModel — duplicated
// here since there's no shared module between the client script and this
// server-side code. Google's `model` is already display text from GCP.
function prettifyModel(provider, model) {
  if (provider === "anthropic") {
    const parts = model.replace(/-\d{8}$/, "").split("-");
    if (parts[0] !== "claude" || parts.length < 2) return model;
    const family = parts[1][0].toUpperCase() + parts[1].slice(1);
    const versionParts = parts.slice(2);
    if (versionParts.length === 0) return `Claude ${family}`;
    const version = versionParts.every(p => /^\d+$/.test(p))
      ? versionParts.join(".")
      : versionParts.join(" ");
    return `Claude ${family} ${version}`;
  }
  if (provider === "openai") {
    const stripped = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
    const m = stripped.match(/^gpt-([0-9.]+[a-z]*)(-(.+))?$/i);
    if (!m) return stripped;
    return `GPT-${m[1]}${m[3] ? " " + m[3].replace(/-/g, " ") : ""}`;
  }
  return model;
}

const fmtUSD = (v) => v.toLocaleString("en-US", { style: "currency", currency: "USD" });

// Gathers everything the email needs for one user: yesterday's total,
// month-to-date, forecast, budget (if set), and yesterday's top models.
async function buildDigestData(userId) {
  const user = await getUserById(userId);
  if (!user?.email) throw new Error("Could not resolve the user's email address");

  const [overrides, budget] = await Promise.all([
    resolveOverrides(userId),
    resolveBudget(userId),
  ]);
  if (Object.keys(overrides).length === 0) {
    throw new Error("No providers connected — nothing to send. Connect one on the Integrations page first.");
  }

  const costData = await fetchAllCosts(overrides, false);
  const summary = buildSummary(costData.days, budget);

  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const dateStr = yesterday.toISOString().slice(0, 10);

  const providerNames = costData.providers.map(p => p.name);
  const yesterdayEntry = costData.days.find(d => d.date === dateStr);
  const yesterdayTotal = yesterdayEntry
    ? providerNames.reduce((sum, name) => sum + (yesterdayEntry[name] || 0), 0)
    : 0;

  const topModels = costData.dayModels
    .filter(m => m.date === dateStr && m.amount_usd > 0)
    .sort((a, b) => b.amount_usd - a.amount_usd)
    .slice(0, 5)
    .map(m => ({ label: prettifyModel(m.provider, m.model), amount_usd: m.amount_usd }));

  return {
    email: user.email,
    dateStr,
    yesterdayTotal,
    mtd: summary.mtd,
    forecast: summary.forecast,
    budget,
    topModels,
  };
}

// Dark background, white text, monospace numbers, no images — kept simple
// on purpose since this renders in email clients, not a browser.
function renderEmail(data) {
  const dateLabel = new Date(data.dateStr + "T00:00:00Z").toLocaleDateString("en-US", {
    month: "long", day: "numeric", timeZone: "UTC",
  });
  const appUrl = (process.env.CAMAZE_APP_URL || "").replace(/\/$/, "");
  const dashboardUrl = appUrl ? `${appUrl}/index.html` : "#";
  const unsubscribeUrl = appUrl ? `${appUrl}/notifications.html` : "#";

  const row = (label, value) =>
    `<tr>` +
    `<td style="padding:4px 0;color:#a3a3a3;font-size:14px;">${label}</td>` +
    `<td style="padding:4px 0;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;">${value}</td>` +
    `</tr>`;

  let summaryRows =
    row("Yesterday", fmtUSD(data.yesterdayTotal)) +
    row("Month to date", fmtUSD(data.mtd)) +
    row("Forecast", `${fmtUSD(data.forecast)} (est. month-end)`);
  if (data.budget != null && data.budget > 0) {
    const pct = Math.round((data.mtd / data.budget) * 100);
    summaryRows += row("Budget", `${fmtUSD(data.budget)} (${pct}% used)`);
  }

  const modelsHtml = data.topModels.length
    ? `<p style="margin:24px 0 6px;color:#a3a3a3;font-size:13px;">Top models yesterday:</p>` +
      `<table style="width:100%;border-collapse:collapse;">${data.topModels.map(m => row(m.label, fmtUSD(m.amount_usd))).join("")}</table>`
    : "";

  const html = `<!doctype html>
<html>
<body style="margin:0;background:#0d0d0d;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
  <div style="max-width:420px;margin:0 auto;padding:32px 20px;color:#ffffff;">
    <p style="margin:0 0 4px;font-size:15px;">Good morning,</p>
    <p style="margin:0 0 20px;color:#a3a3a3;font-size:14px;">Here's your AI spend summary for ${dateLabel}.</p>
    <table style="width:100%;border-collapse:collapse;">${summaryRows}</table>
    ${modelsHtml}
    <p style="margin:28px 0 0;font-size:14px;"><a href="${dashboardUrl}" style="color:#3987e5;text-decoration:none;">View dashboard &rarr;</a></p>
    <p style="margin:24px 0 0;font-size:12px;color:#606060;">camaze &middot; <a href="${unsubscribeUrl}" style="color:#606060;">Unsubscribe</a></p>
  </div>
</body>
</html>`;

  // A plain-text alternative alongside the HTML — some spam filters treat
  // HTML-only mail as a mild signal, and it's what text-only clients render.
  let text = `Good morning,\n\nHere's your AI spend summary for ${dateLabel}.\n\n` +
    `Yesterday       ${fmtUSD(data.yesterdayTotal)}\n` +
    `Month to date   ${fmtUSD(data.mtd)}\n` +
    `Forecast        ${fmtUSD(data.forecast)} (est. month-end)\n`;
  if (data.budget != null && data.budget > 0) {
    const pct = Math.round((data.mtd / data.budget) * 100);
    text += `Budget          ${fmtUSD(data.budget)} (${pct}% used)\n`;
  }
  if (data.topModels.length) {
    text += `\nTop models yesterday:\n`;
    text += data.topModels.map(m => `${m.label}    ${fmtUSD(m.amount_usd)}`).join("\n") + "\n";
  }
  text += `\nView dashboard: ${dashboardUrl}\n\ncamaze - Unsubscribe: ${unsubscribeUrl}\n`;

  return { subject: "camaze — your daily spend digest", html, text };
}

async function sendDigestForUser(userId) {
  const data = await buildDigestData(userId);
  const { subject, html, text } = renderEmail(data);
  await sendEmail(data.email, subject, html, text);
  return { email: data.email };
}

module.exports = { buildDigestData, renderEmail, sendDigestForUser };
