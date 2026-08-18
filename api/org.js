// Authenticated CRUD for org structure — departments, people, and the
// entity-assignment mapping between attribution entities and them — plus
// the discovered-entities listing assignments.html renders. Every request
// must carry a valid Supabase JWT, same pattern as api/fixed-costs.js.
// A separate route rather than folding into api/costs.js: we're on Vercel
// Pro now, which lifts Hobby's 12-function deployment cap.
const {
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
  listPeople, createPerson, updatePerson, deletePerson,
  assignEntity, deleteEntityAssignment, listDiscoveredEntities,
} = require("../lib/org");
const { verifyUser } = require("../lib/supabase");

const MONTH_RE = /^\d{4}-\d{2}$/;

function currentMonthStr() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---- departments ----------------------------------------------------

function validateDepartmentFields(body, requireAll) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (requireAll || has("name")) {
    if (typeof body.name !== "string" || !body.name.trim()) return "name is required";
  }
  if (has("headcount")) {
    const n = Number(body.headcount);
    if (!Number.isInteger(n) || n < 0) return "headcount must be a non-negative integer";
  }
  if (has("monthly_budget_usd") && body.monthly_budget_usd !== null) {
    const n = Number(body.monthly_budget_usd);
    if (!Number.isFinite(n) || n < 0) return "monthly_budget_usd must be a non-negative number or null";
  }
  return null;
}

function pickDepartmentFields(body) {
  const fields = {};
  if (Object.prototype.hasOwnProperty.call(body, "name")) fields.name = body.name.trim();
  if (Object.prototype.hasOwnProperty.call(body, "headcount")) fields.headcount = Number(body.headcount);
  if (Object.prototype.hasOwnProperty.call(body, "monthly_budget_usd")) {
    fields.monthly_budget_usd = body.monthly_budget_usd === null ? null : Number(body.monthly_budget_usd);
  }
  return fields;
}

async function handleDepartments(req, res, user, body) {
  if (req.method === "GET") {
    res.status(200).json({ departments: await listDepartments(user.id) });
    return;
  }
  if (req.method === "POST") {
    const error = validateDepartmentFields(body, true);
    if (error) return res.status(400).json({ error });
    res.status(200).json({ ok: true, department: await createDepartment(user.id, pickDepartmentFields(body)) });
    return;
  }
  if (req.method === "PATCH") {
    if (!body.id) return res.status(400).json({ error: "id is required" });
    const error = validateDepartmentFields(body, false);
    if (error) return res.status(400).json({ error });
    const fields = pickDepartmentFields(body);
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: "No fields to update" });
    const row = await updateDepartment(user.id, body.id, fields);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.status(200).json({ ok: true, department: row });
    return;
  }
  if (req.method === "DELETE") {
    const id = req.query?.id;
    if (!id) return res.status(400).json({ error: "id is required" });
    await deleteDepartment(user.id, id);
    res.status(200).json({ ok: true });
    return;
  }
  res.status(405).json({ error: "Method not allowed" });
}

// ---- people -----------------------------------------------------------

function validatePersonFields(body, requireAll) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (requireAll || has("name")) {
    if (typeof body.name !== "string" || !body.name.trim()) return "name is required";
  }
  if (has("email") && body.email !== null) {
    if (typeof body.email !== "string") return "email must be a string or null";
  }
  if (has("department_id") && body.department_id !== null) {
    if (typeof body.department_id !== "string") return "department_id must be a string or null";
  }
  return null;
}

function pickPersonFields(body) {
  const fields = {};
  if (Object.prototype.hasOwnProperty.call(body, "name")) fields.name = body.name.trim();
  if (Object.prototype.hasOwnProperty.call(body, "email")) fields.email = body.email === null ? null : body.email.trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "department_id")) fields.department_id = body.department_id || null;
  return fields;
}

async function handlePeople(req, res, user, body) {
  if (req.method === "GET") {
    res.status(200).json({ people: await listPeople(user.id) });
    return;
  }
  if (req.method === "POST") {
    const error = validatePersonFields(body, true);
    if (error) return res.status(400).json({ error });
    res.status(200).json({ ok: true, person: await createPerson(user.id, pickPersonFields(body)) });
    return;
  }
  if (req.method === "PATCH") {
    if (!body.id) return res.status(400).json({ error: "id is required" });
    const error = validatePersonFields(body, false);
    if (error) return res.status(400).json({ error });
    const fields = pickPersonFields(body);
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: "No fields to update" });
    const row = await updatePerson(user.id, body.id, fields);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.status(200).json({ ok: true, person: row });
    return;
  }
  if (req.method === "DELETE") {
    const id = req.query?.id;
    if (!id) return res.status(400).json({ error: "id is required" });
    await deletePerson(user.id, id);
    res.status(200).json({ ok: true });
    return;
  }
  res.status(405).json({ error: "Method not allowed" });
}

// ---- entity assignments -------------------------------------------------

async function handleAssignments(req, res, user, body) {
  if (req.method === "POST") {
    const { provider, scope, entity_id: entityId } = body;
    if (typeof provider !== "string" || !provider) return res.status(400).json({ error: "provider is required" });
    if (typeof scope !== "string" || !scope) return res.status(400).json({ error: "scope is required" });
    if (typeof entityId !== "string" || !entityId) return res.status(400).json({ error: "entity_id is required" });
    const assignment = await assignEntity(user.id, {
      provider, scope, entity_id: entityId,
      department_id: body.department_id || null,
      person_id: body.person_id || null,
    });
    res.status(200).json({ ok: true, assignment });
    return;
  }
  if (req.method === "DELETE") {
    const id = req.query?.id;
    if (!id) return res.status(400).json({ error: "id is required" });
    await deleteEntityAssignment(user.id, id);
    res.status(200).json({ ok: true });
    return;
  }
  res.status(405).json({ error: "Method not allowed" });
}

// ---- discovered entities --------------------------------------------

async function handleEntities(req, res, user) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const month = typeof req.query?.month === "string" && MONTH_RE.test(req.query.month) ? req.query.month : currentMonthStr();
  const entities = await listDiscoveredEntities(user.id, month);
  res.status(200).json({ month, entities });
}

module.exports = async (req, res) => {
  const user = await verifyUser(req.headers.authorization).catch(() => null);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const resource = req.query?.resource;
  const body = req.body && typeof req.body === "object" ? req.body : {};

  try {
    if (resource === "departments") return await handleDepartments(req, res, user, body);
    if (resource === "people") return await handlePeople(req, res, user, body);
    if (resource === "assignments") return await handleAssignments(req, res, user, body);
    if (resource === "entities") return await handleEntities(req, res, user);
    res.status(400).json({ error: "?resource must be one of: departments, people, assignments, entities" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
