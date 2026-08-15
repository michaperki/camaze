// Thin Resend wrapper shared by lib/digest.js and lib/alertEmail.js so
// there's exactly one place that talks to the email provider.
const RESEND_URL = "https://api.resend.com/emails";

async function sendEmail(toEmail, subject, html, text) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  const from = process.env.RESEND_FROM_EMAIL || "camaze <onboarding@resend.dev>";

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [toEmail], subject, html, text }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.message || `HTTP ${res.status} from Resend`);
  }
}

module.exports = { sendEmail };
