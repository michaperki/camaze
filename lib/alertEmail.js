// Builds the spike / budget-threshold alert emails. Separate from
// lib/digest.js on purpose — an alert has to read as its own thing, not a
// section buried in the routine daily digest, so it gets its own subject
// line and a visually distinct (amber/red accent) template. HTML + plain
// text alternative, matching lib/digest.js's pattern.
const { sendEmail } = require("./email");

const fmtUSD = (v) => v.toLocaleString("en-US", { style: "currency", currency: "USD" });

function appUrls() {
  const appUrl = (process.env.CAMAZE_APP_URL || "").replace(/\/$/, "");
  return {
    dashboardUrl: appUrl ? `${appUrl}/index.html` : "#",
    unsubscribeUrl: appUrl ? `${appUrl}/notifications.html` : "#",
  };
}

function row(label, value) {
  return `<tr>` +
    `<td style="padding:4px 0;color:#a3a3a3;font-size:14px;">${label}</td>` +
    `<td style="padding:4px 0;text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;">${value}</td>` +
    `</tr>`;
}

// Shared shell: amber "ALERT" eyebrow + left accent border mark this as
// distinct from the digest's plain layout, while keeping the same dark
// background and font stack so it still reads as camaze mail.
function shell({ eyebrow, headline, bodyHtml, dashboardUrl, unsubscribeUrl }) {
  return `<!doctype html>
<html>
<body style="margin:0;background:#0d0d0d;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
  <div style="max-width:420px;margin:0 auto;padding:32px 20px;color:#ffffff;border-left:3px solid #e0655a;">
    <p style="margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:0.08em;color:#e0655a;text-transform:uppercase;">Alert</p>
    <p style="margin:0 0 20px;font-size:16px;font-weight:600;">${headline}</p>
    ${bodyHtml}
    <p style="margin:28px 0 0;font-size:14px;"><a href="${dashboardUrl}" style="color:#3987e5;text-decoration:none;">View dashboard &rarr;</a></p>
    <p style="margin:24px 0 0;font-size:12px;color:#606060;">camaze &middot; <a href="${unsubscribeUrl}" style="color:#606060;">Unsubscribe</a></p>
  </div>
</body>
</html>`;
}

function shellText({ headline, bodyText, dashboardUrl, unsubscribeUrl }) {
  return `ALERT\n\n${headline}\n\n${bodyText}\nView dashboard: ${dashboardUrl}\n\ncamaze - Unsubscribe: ${unsubscribeUrl}\n`;
}

// `driver`: { providerLabel, amount, modelLabel } | null, from lib/alerts.js's topDriver().
function renderSpikeAlert({ dateStr, total, baseline, ratio, driver }) {
  const dateLabel = new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-US", {
    month: "long", day: "numeric", timeZone: "UTC",
  });
  const ratioLabel = ratio != null ? `${ratio.toFixed(1)}x` : "—";
  const baselineLabel = baseline != null ? fmtUSD(baseline) : "n/a (not enough history yet)";
  const { dashboardUrl, unsubscribeUrl } = appUrls();

  const driverHtml = driver
    ? `<p style="margin:16px 0 0;font-size:14px;color:#c3c2b7;">${driver.providerLabel} accounted for ${fmtUSD(driver.amount)} of it${driver.modelLabel ? ` (mostly ${driver.modelLabel})` : ""}.</p>`
    : "";
  const driverText = driver
    ? `${driver.providerLabel} accounted for ${fmtUSD(driver.amount)} of it${driver.modelLabel ? ` (mostly ${driver.modelLabel})` : ""}.\n`
    : "";

  const bodyRows = row("Yesterday", fmtUSD(total)) + row("Typical (7-day median)", baselineLabel) + row("Ratio", ratioLabel);
  const bodyHtml = `<table style="width:100%;border-collapse:collapse;">${bodyRows}</table>${driverHtml}`;
  const bodyText =
    `Yesterday                ${fmtUSD(total)}\n` +
    `Typical (7-day median)   ${baselineLabel}\n` +
    `Ratio                    ${ratioLabel}\n\n${driverText}\n`;

  const headline = `Yesterday's spend was ${ratioLabel} normal.`;

  return {
    subject: `camaze alert — yesterday's spend was ${ratioLabel} normal`,
    html: shell({ headline, bodyHtml, dashboardUrl, unsubscribeUrl }),
    text: shellText({ headline, bodyText, dashboardUrl, unsubscribeUrl }),
  };
}

function renderBudgetAlert({ forecast, budget, pct, thresholdPct }) {
  const { dashboardUrl, unsubscribeUrl } = appUrls();
  const pctLabel = `${Math.round(pct)}%`;

  const bodyRows =
    row("Forecast (est. month-end)", fmtUSD(forecast)) +
    row("Monthly budget", fmtUSD(budget)) +
    row("% of budget", pctLabel);
  const bodyHtml = `<table style="width:100%;border-collapse:collapse;">${bodyRows}</table>`;
  const bodyText =
    `Forecast (est. month-end)   ${fmtUSD(forecast)}\n` +
    `Monthly budget               ${fmtUSD(budget)}\n` +
    `% of budget                  ${pctLabel}\n\n`;

  const headline = `Forecast is at ${pctLabel} of your ${fmtUSD(budget)} budget.`;

  return {
    subject: `camaze alert — forecast is at ${pctLabel} of your budget`,
    html: shell({ headline, bodyHtml, dashboardUrl, unsubscribeUrl }),
    text: shellText({ headline, bodyText, dashboardUrl, unsubscribeUrl }),
  };
}

async function sendAlertEmail(toEmail, { subject, html, text }) {
  await sendEmail(toEmail, subject, html, text);
}

module.exports = { renderSpikeAlert, renderBudgetAlert, sendAlertEmail };
