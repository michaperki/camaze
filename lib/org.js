// Org structure — departments, people, and the mapping from attribution
// entities (Anthropic keys/workspaces, OpenAI/Google projects) to them.
// CRUD against departments/people/entity_assignments, plus the resolution
// that turns a raw attribution row into one with department/person
// attached. Same local rest()/config() pattern as lib/fixedCosts.js: uses
// the service role key, which bypasses RLS, so every query below is
// manually scoped to a caller-supplied user_id.
const { getMonthlyAttributionRows } = require("./costSync");

function config() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return { url, serviceRoleKey };
}

async function rest(path, options = {}) {
  const { url, serviceRoleKey } = config();
  const res = await fetch(`${url}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message || `HTTP ${res.status} from Supabase`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---- Departments ----------------------------------------------------

const DEPARTMENT_SELECT = "id,name,headcount,monthly_budget_usd,created_at";

async function listDepartments(userId) {
  return rest(`/departments?user_id=eq.${encodeURIComponent(userId)}&select=${DEPARTMENT_SELECT}&order=name.asc`);
}

async function createDepartment(userId, fields) {
  const rows = await rest(`/departments`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ user_id: userId, ...fields }]),
  });
  return rows[0];
}

async function updateDepartment(userId, id, fields) {
  const rows = await rest(
    `/departments?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(id)}`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(fields) }
  );
  return rows[0] || null;
}

async function deleteDepartment(userId, id) {
  await rest(
    `/departments?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

// ---- People -----------------------------------------------------------

const PEOPLE_SELECT = "id,name,email,department_id,created_at";

async function listPeople(userId) {
  return rest(`/people?user_id=eq.${encodeURIComponent(userId)}&select=${PEOPLE_SELECT}&order=name.asc`);
}

async function createPerson(userId, fields) {
  const rows = await rest(`/people`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ user_id: userId, ...fields }]),
  });
  return rows[0];
}

async function updatePerson(userId, id, fields) {
  const rows = await rest(
    `/people?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(id)}`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(fields) }
  );
  return rows[0] || null;
}

async function deletePerson(userId, id) {
  await rest(
    `/people?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

// ---- Entity assignments -------------------------------------------------

const ASSIGNMENT_SELECT = "id,provider,scope,entity_id,department_id,person_id,effective_from,effective_to,created_at";

async function listEntityAssignments(userId) {
  return rest(
    `/entity_assignments?user_id=eq.${encodeURIComponent(userId)}&select=${ASSIGNMENT_SELECT}&order=created_at.desc`
  );
}

async function deleteEntityAssignment(userId, id) {
  await rest(
    `/entity_assignments?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

function currentMonthStart() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// Assigns one attribution entity to a department and/or person. There is no
// updateEntityAssignment: an assignment is a dated fact, not a mutable
// setting — reassigning always *adds* a new row rather than editing history,
// so a change made today can never rewrite what an earlier month resolved
// to (see resolveAttribution below). The first-ever assignment for an
// entity is backdated to the epoch so it also covers whatever history that
// entity already has; every later reassignment only takes effect from the
// start of the current month forward.
async function assignEntity(userId, { provider, scope, entity_id: entityId, department_id: departmentId, person_id: personId }) {
  const existing = await rest(
    `/entity_assignments?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(provider)}` +
    `&scope=eq.${encodeURIComponent(scope)}&entity_id=eq.${encodeURIComponent(entityId)}&select=id&limit=1`
  );
  const effectiveFrom = existing.length > 0 ? currentMonthStart() : "1970-01-01";

  const rows = await rest(`/entity_assignments`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{
      user_id: userId, provider, scope, entity_id: entityId,
      department_id: departmentId || null, person_id: personId || null,
      effective_from: effectiveFrom,
    }]),
  });
  return rows[0];
}

// ---- Resolution ---------------------------------------------------------

// Rows that resolve to no department land here rather than being dropped —
// spend from an unmapped entity must stay visible, not vanish. `id: null`
// is what every consumer checks to tell this apart from a real department.
const UNASSIGNED = { id: null, name: "Unassigned" };

// "YYYY-MM" -> the calendar month's first/last day as ISO date strings,
// comparable lexicographically against effective_from/effective_to (plain
// dates, no time component). Same recipe as lib/fixedCosts.js's monthBounds.
function monthBounds(monthStr) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr);
  if (!m) throw new Error(`Invalid month: ${monthStr}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${monthStr}-01`, end: `${monthStr}-${String(daysInMonth).padStart(2, "0")}` };
}

// The assignment for (provider, scope, entityId) whose [effective_from,
// effective_to] range overlaps this month — an open-ended effective_to
// (null) covers "forever from effective_from on". Reassigning a key in June
// must not rewrite January: a later reassignment always has a later
// effective_from, so it simply doesn't overlap earlier months and the old
// row keeps resolving them. When more than one assignment does overlap
// (the month a reassignment took effect), the one with the latest
// effective_from wins.
function matchAssignment(assignments, provider, scope, entityId, monthStart, monthEnd) {
  let best = null;
  for (const a of assignments) {
    if (a.provider !== provider || a.scope !== scope || a.entity_id !== entityId) continue;
    if (a.effective_from > monthEnd) continue;
    if (a.effective_to && a.effective_to < monthStart) continue;
    if (!best || a.effective_from > best.effective_from) best = a;
  }
  return best;
}

// department_id on the assignment wins when set; otherwise it falls back to
// the assigned person's home department. Either way, no match (or a match
// with neither department_id nor person_id — an explicit "clear") resolves
// to UNASSIGNED, never null. headcount/monthly_budget_usd ride along on the
// resolved department so a consumer (the dashboard's "By department" tab)
// can compute cost-per-employee and budget status without a second fetch —
// both are already sitting in `departments` from loadOrgData, just not
// projected through before now.
function resolveDeptAndPerson(match, deptById, personById) {
  if (!match) return { department: UNASSIGNED, person: null };
  const person = match.person_id ? (personById.get(match.person_id) || null) : null;
  const department = match.department_id
    ? (deptById.get(match.department_id) || null)
    : (person?.department_id ? (deptById.get(person.department_id) || null) : null);
  return {
    department: department
      ? { id: department.id, name: department.name, headcount: department.headcount, monthly_budget_usd: department.monthly_budget_usd }
      : UNASSIGNED,
    person: person ? { id: person.id, name: person.name } : null,
  };
}

// Fetches this user's departments/people/assignments in one shot, so a
// caller that already has attribution rows in hand (api/costs.js) can fetch
// this in parallel with the provider work instead of adding a serial step.
async function loadOrgData(userId) {
  const [assignments, departments, people] = await Promise.all([
    listEntityAssignments(userId),
    listDepartments(userId),
    listPeople(userId),
  ]);
  return { assignments, departments, people };
}

// Pure merge — no I/O. `rows` must each have { provider, scope, id }
// (the shape both fetchProviderAttribution/buildGoogleAttribution and
// getMonthlyAttributionRows already produce). Returns new row objects with
// `department`/`person` attached; never drops or reorders rows.
function resolveAttribution(rows, monthStr, orgData) {
  const { assignments, departments, people } = orgData;
  const deptById = new Map(departments.map(d => [d.id, d]));
  const personById = new Map(people.map(p => [p.id, p]));
  const { start, end } = monthBounds(monthStr);

  return rows.map((row) => {
    const match = matchAssignment(assignments, row.provider, row.scope, row.id, start, end);
    const { department, person } = resolveDeptAndPerson(match, deptById, personById);
    return { ...row, department, person };
  });
}

// Convenience wrapper for callers that don't already have attribution rows
// in hand (the assignments.html summary, the "with assignments" demo) —
// fetches monthly_attribution and the org tables in parallel, then resolves.
async function attributionForMonth(userId, monthStr) {
  const [rows, orgData] = await Promise.all([
    getMonthlyAttributionRows(userId, monthStr),
    loadOrgData(userId),
  ]);
  return resolveAttribution(rows, monthStr, orgData);
}

// Every attribution entity ever seen in monthly_attribution for this user —
// not just this month's — so an entity that has gone quiet can still be
// found and assigned. Each gets its spend for `monthStr` (0 if it had none)
// and its assignment resolved for that same month. Unassigned entities sort
// first, then by spend descending, so the finance person triaging this
// screen sees what needs attention before what's already handled.
async function listDiscoveredEntities(userId, monthStr) {
  const [history, orgData] = await Promise.all([
    rest(`/monthly_attribution?user_id=eq.${encodeURIComponent(userId)}&select=provider,scope,entity_id,name,amount_usd,month&order=month.desc`),
    loadOrgData(userId),
  ]);

  const byKey = new Map();
  for (const row of history) {
    const key = `${row.provider}|${row.scope}|${row.entity_id}`;
    let entity = byKey.get(key);
    if (!entity) {
      // `history` is newest-month-first, so the first row seen per key
      // carries the most recent name — kept even if a later (older) row
      // for the same key has a stale/renamed value.
      entity = { provider: row.provider, scope: row.scope, id: row.entity_id, name: row.name, amount_usd: 0 };
      byKey.set(key, entity);
    }
    if (row.month === monthStr) entity.amount_usd = row.amount_usd;
  }

  const entities = resolveAttribution([...byKey.values()], monthStr, orgData);
  return entities.sort((a, b) => {
    if ((a.department.id === null) !== (b.department.id === null)) {
      return a.department.id === null ? -1 : 1;
    }
    return b.amount_usd - a.amount_usd;
  });
}

module.exports = {
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
  listPeople, createPerson, updatePerson, deletePerson,
  listEntityAssignments, assignEntity, deleteEntityAssignment,
  loadOrgData, resolveAttribution, attributionForMonth, listDiscoveredEntities,
  UNASSIGNED,
};
