// Thin wrapper around supabase.logAudit for the API routes that need to
// record a security-relevant action. Pulls actor identity from the
// already-verified JWT user and the client IP from Vercel's forwarded
// header, so call sites don't repeat that boilerplate. Never throws — a
// failed audit write must not block the request it's describing; the
// failure is still visible in server logs.
const { logAudit: insertAuditRow } = require("./supabase");

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (!fwd) return null;
  return fwd.split(",")[0].trim();
}

async function logAudit(req, user, action, detail, route) {
  try {
    await insertAuditRow({
      userId: user.id,
      email: user.email,
      action,
      detail: detail || {},
      ip: clientIp(req),
      route,
    });
  } catch (err) {
    console.error(`[audit] failed to log "${action}" for user ${user.id}:`, err.message);
  }
}

module.exports = { logAudit };
