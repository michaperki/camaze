// Per-user manual fixed-cost entries (consumer subscriptions, per-seat
// licenses) CRUD, stored in user_fixed_costs. Every request must carry a
// valid Supabase JWT in the Authorization header — verified server-side
// before anything else, same pattern as api/keys.js and api/budget.js.
const {
  listFixedCosts,
  createFixedCost,
  updateFixedCost,
  deleteFixedCost,
} = require("../lib/fixedCosts");
const { verifyUser } = require("../lib/supabase");

const BILLING_PERIODS = new Set(["monthly", "annual"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = ["vendor", "label", "unit_cost_usd", "seats", "billing_period", "started_on", "ended_on"];

// Validates whichever of FIELDS are present in `body`. `requireAll` demands
// every field (create); otherwise only the fields actually present are
// checked (partial update). Returns an error string, or null if valid.
function validateFields(body, requireAll) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (requireAll || has("vendor")) {
    if (typeof body.vendor !== "string" || !body.vendor.trim()) return "vendor is required";
  }
  if (requireAll || has("label")) {
    if (typeof body.label !== "string" || !body.label.trim()) return "label is required";
  }
  if (requireAll || has("unit_cost_usd")) {
    const n = Number(body.unit_cost_usd);
    if (!Number.isFinite(n) || n < 0) return "unit_cost_usd must be a non-negative number";
  }
  if (requireAll || has("seats")) {
    const n = Number(body.seats);
    if (!Number.isInteger(n) || n < 1) return "seats must be a positive integer";
  }
  if (requireAll || has("billing_period")) {
    if (!BILLING_PERIODS.has(body.billing_period)) return "billing_period must be 'monthly' or 'annual'";
  }
  if (requireAll || has("started_on")) {
    if (typeof body.started_on !== "string" || !DATE_RE.test(body.started_on)) return "started_on must be a YYYY-MM-DD date";
  }
  if (has("ended_on") && body.ended_on !== null) {
    if (typeof body.ended_on !== "string" || !DATE_RE.test(body.ended_on)) return "ended_on must be a YYYY-MM-DD date or null";
  }
  return null;
}

function pickFields(body) {
  const fields = {};
  for (const k of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
    fields[k] = k === "unit_cost_usd" || k === "seats" ? Number(body[k]) : body[k];
  }
  return fields;
}

async function handleGet(user, res) {
  const rows = await listFixedCosts(user.id);
  res.status(200).json({ fixedCosts: rows });
}

async function handlePost(req, res, user) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const error = validateFields(body, true);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const row = await createFixedCost(user.id, pickFields(body));
  res.status(200).json({ ok: true, fixedCost: row });
}

async function handlePatch(req, res, user) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { id } = body;
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }
  const error = validateFields(body, false);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const fields = pickFields(body);
  if (Object.keys(fields).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  const row = await updateFixedCost(user.id, id, fields);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(200).json({ ok: true, fixedCost: row });
}

async function handleDelete(req, res, user) {
  const id = req.query?.id;
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }
  await deleteFixedCost(user.id, id);
  res.status(200).json({ ok: true });
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
    if (req.method === "PATCH") return await handlePatch(req, res, user);
    if (req.method === "DELETE") return await handleDelete(req, res, user);
    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
