import { departmentSchema, personSchema, validationError } from '../../shared/org-schema.mjs';
import { createEntityTable } from '../components/entity-table.js';
import * as supabase from '@supabase/supabase-js';
import '../header.js';
const PROVIDER_META = {
  anthropic: { label: "Anthropic", swatch: "var(--series-1)" },
  openai: { label: "OpenAI", swatch: "var(--series-2)" },
  google: { label: "Google", swatch: "var(--series-3)" },
};
const SCOPE_LABEL = { api_key: "API key", workspace: "Workspace", project: "Project" };

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtUSD = (v) => Number(v).toLocaleString("en-US", { style: "currency", currency: "USD" });

let authHeaders = null;
let state = { departments: [], people: [], entities: [], month: null };

function departmentOptionsHtml(selectedId) {
  let html = `<option value=""${selectedId ? "" : " selected"}>— Unassigned —</option>`;
  for (const d of state.departments) {
    html += `<option value="${esc(d.id)}"${d.id === selectedId ? " selected" : ""}>${esc(d.name)}</option>`;
  }
  return html;
}

function personOptionsHtml(selectedId) {
  let html = `<option value=""${selectedId ? "" : " selected"}>— None —</option>`;
  for (const p of state.people) {
    html += `<option value="${esc(p.id)}"${p.id === selectedId ? " selected" : ""}>${esc(p.name)}</option>`;
  }
  return html;
}

// Mirrors lib/org.js's resolveDeptAndPerson for the one entity a dropdown
// change just applied to — department_id wins when set, else it falls back
// to the chosen person's home department. Lets saveAssignment update
// state.entities immediately from the response it already has, instead of
// refetching just to learn what it already knows.
function resolveLocalDeptPerson(departmentId, personId) {
  const person = personId ? state.people.find((p) => p.id === personId) || null : null;
  let department = departmentId ? state.departments.find((d) => d.id === departmentId) || null : null;
  if (!department && person && person.department_id) {
    department = state.departments.find((d) => d.id === person.department_id) || null;
  }
  return {
    department: department ? { id: department.id, name: department.name } : { id: null, name: "Unassigned" },
    person: person ? { id: person.id, name: person.name } : null,
  };
}

function departmentsTableHtml() {
  if (state.departments.length === 0) {
    return '<div class="message">No departments yet — add one below.</div>';
  }
  const rows = state.departments.map((d) => `
    <tr data-id="${esc(d.id)}">
      <td><input class="inline-input" data-role="name" type="text" value="${esc(d.name)}"></td>
      <td class="col-num"><input class="inline-input" data-role="headcount" type="number" min="0" step="1" value="${d.headcount}"></td>
      <td class="col-budget"><input class="inline-input" data-role="budget" type="number" min="0" step="1" placeholder="No limit" value="${d.monthly_budget_usd ?? ""}"></td>
      <td class="col-actions">
        <span class="row-status" data-role="status"></span>
        <button class="btn-text" type="button" data-action="delete-department" data-id="${esc(d.id)}">Remove</button>
      </td>
    </tr>`).join("");
  return `
    <table class="data-table">
      <thead><tr><th>Name</th><th>Headcount</th><th>Monthly budget</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function peopleTableHtml() {
  if (state.people.length === 0) {
    return '<div class="message">No people yet — add one below.</div>';
  }
  const rows = state.people.map((p) => `
    <tr data-id="${esc(p.id)}">
      <td><input class="inline-input" data-role="name" type="text" value="${esc(p.name)}"></td>
      <td><input class="inline-input" data-role="email" type="email" placeholder="—" value="${esc(p.email || "")}"></td>
      <td><select class="inline-input" data-role="department_id">${departmentOptionsHtml(p.department_id)}</select></td>
      <td class="col-actions">
        <span class="row-status" data-role="status"></span>
        <button class="btn-text" type="button" data-action="delete-person" data-id="${esc(p.id)}">Remove</button>
      </td>
    </tr>`).join("");
  return `
    <table class="data-table">
      <thead><tr><th>Name</th><th>Email</th><th>Department</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

let entityTable;
function renderEntities() {
  if (entityTable) entityTable.update().catch(error => { document.querySelector('[data-status]').textContent = error.message; });
  else entityTable = createEntityTable(document.getElementById('entities-table'), () => state, persistAssignment);
}
function renderDepartments() {
  document.getElementById("departments-table").innerHTML = departmentsTableHtml();
}
function renderPeople() {
  document.getElementById("people-table").innerHTML = peopleTableHtml();
}

// The add-person form's department <select> isn't tied to any row, so
// nothing else re-renders it as a side effect — it needs its own refresh.
// Preserves the in-progress choice if it's still a valid department.
function renderPersonFormDepartmentOptions() {
  const select = document.querySelector('#person-form select[name="department_id"]');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">— None —</option>' +
    state.departments.map((d) => `<option value="${esc(d.id)}"${d.id === current ? " selected" : ""}>${esc(d.name)}</option>`).join("");
}

// Every place a department's id/name feeds another section's dropdown:
// entity rows' department select, people rows' department select, and the
// add-person form's department select. Called after any create/update/
// delete of a department so those options — and any label text drawn from
// a department's name — never go stale without a page reload.
function refreshDepartmentDropdowns() {
  renderEntities();
  renderPeople();
  renderPersonFormDepartmentOptions();
}

// Every place a person's id/name feeds another section's dropdown: entity
// rows' owner select. Called after any create/update/delete of a person.
function refreshPeopleDropdowns() {
  renderEntities();
}

function showRowStatus(row, text, cls) {
  const status = row.querySelector('[data-role="status"]');
  if (!status) return;
  status.textContent = text;
  status.className = `row-status ${cls || ""}`;
  if (cls === "ok") setTimeout(() => { status.textContent = ""; status.className = "row-status"; }, 1500);
}

async function persistAssignment(entity, departmentId, personId) {
  const res = await window.camazeFetch('/api/org?resource=assignments', {
    method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: entity.provider, scope: entity.scope, entity_id: entity.id, department_id: departmentId, person_id: personId }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Assignment could not be saved');
  const stored = state.entities.find(e => e.provider === entity.provider && e.scope === entity.scope && e.id === entity.id);
  if (stored) Object.assign(stored, resolveLocalDeptPerson(departmentId, personId));
}

async function saveDepartment(row) {
  const id = row.dataset.id;
  const name = row.querySelector('[data-role="name"]').value.trim();
  const headcount = row.querySelector('[data-role="headcount"]').value;
  const budgetRaw = row.querySelector('[data-role="budget"]').value;
  const error = validationError(departmentSchema, { name, headcount, monthly_budget_usd: budgetRaw === '' ? null : budgetRaw });
  if (error) { showRowStatus(row, error, 'error'); return; }

  showRowStatus(row, "Saving…");
  try {
    const res = await window.camazeFetch("/api/org?resource=departments", {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        id, name,
        headcount: Number(headcount) || 0,
        monthly_budget_usd: budgetRaw === "" ? null : Number(budgetRaw),
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const idx = state.departments.findIndex((d) => d.id === id);
    if (idx !== -1) state.departments[idx] = data.department;
    // Not renderDepartments() itself — this row's own inputs already show
    // what was just typed, and rebuilding the table would drop focus.
    refreshDepartmentDropdowns();
    showRowStatus(row, "Saved", "ok");
  } catch (err) {
    showRowStatus(row, err.message, "error");
  }
}

async function savePerson(row) {
  const id = row.dataset.id;
  const name = row.querySelector('[data-role="name"]').value.trim();
  const email = row.querySelector('[data-role="email"]').value.trim();
  const departmentId = row.querySelector('[data-role="department_id"]').value || null;
  const error = validationError(personSchema, { name, email: email || null, department_id: departmentId });
  if (error) { showRowStatus(row, error, 'error'); return; }

  showRowStatus(row, "Saving…");
  try {
    const res = await window.camazeFetch("/api/org?resource=people", {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, email: email || null, department_id: departmentId }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const idx = state.people.findIndex((p) => p.id === id);
    if (idx !== -1) state.people[idx] = data.person;
    // Not renderPeople() itself — this row's own inputs already show what
    // was just chosen, and rebuilding the table would drop focus.
    refreshPeopleDropdowns();
    showRowStatus(row, "Saved", "ok");
  } catch (err) {
    showRowStatus(row, err.message, "error");
  }
}

async function reloadEntities() {
  const res = await window.camazeFetch(`/api/org?resource=entities&month=${encodeURIComponent(state.month)}`, { headers: authHeaders });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  state.entities = data.entities;
}

function wireDepartments() {
  const table = document.getElementById("departments-table");
  table.addEventListener("change", (e) => {
    const row = e.target.closest("tr[data-id]");
    if (row) saveDepartment(row);
  });
  table.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="delete-department"]');
    if (!btn) return;
    if (!confirm("Remove this department? People and assignments pointed at it will fall back to Unassigned.")) return;
    btn.disabled = true;
    window.camazeFetch(`/api/org?resource=departments&id=${encodeURIComponent(btn.dataset.id)}`, { method: "DELETE", headers: authHeaders })
      .then(async (res) => {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const deletedId = btn.dataset.id;
        state.departments = state.departments.filter((d) => d.id !== deletedId);
        // Defensive local fallback for anything still pointing at the id we
        // just removed, so it can't render as a ghost option — the entities
        // refetch below supplies the authoritative resolution right after.
        state.people = state.people.map((p) => (p.department_id === deletedId ? { ...p, department_id: null } : p));
        state.entities = state.entities.map((e) =>
          e.department.id === deletedId ? { ...e, department: { id: null, name: "Unassigned" } } : e);
        renderDepartments();
        refreshDepartmentDropdowns();
        await reloadEntities();
        renderEntities();
      })
      .catch((err) => {
        btn.disabled = false;
        alert(`Could not remove: ${err.message}`);
      });
  });

  const toggleBtn = document.getElementById("toggle-department-form");
  const form = document.getElementById("department-form");
  toggleBtn.addEventListener("click", () => {
    form.style.display = form.style.display === "none" ? "flex" : "none";
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const errorEl = form.querySelector('[data-role="error"]');
    errorEl.textContent = "";
    const formData = new FormData(form);
    const budgetRaw = formData.get("monthly_budget_usd");
    const body = {
      name: formData.get("name"),
      headcount: formData.get("headcount"),
      monthly_budget_usd: budgetRaw || null,
    };
    const error = validationError(departmentSchema, body);
    if (error) { errorEl.textContent = error; return; }
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    window.camazeFetch("/api/org?resource=departments", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        state.departments.push(data.department);
        state.departments.sort((a, b) => a.name.localeCompare(b.name));
        renderDepartments();
        refreshDepartmentDropdowns();
        form.reset();
        form.style.display = "none";
      })
      .catch((err) => { errorEl.textContent = err.message; })
      .finally(() => { submitBtn.disabled = false; });
  });
}

function wirePeople() {
  const table = document.getElementById("people-table");
  table.addEventListener("change", (e) => {
    const row = e.target.closest("tr[data-id]");
    if (row) savePerson(row);
  });
  table.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="delete-person"]');
    if (!btn) return;
    if (!confirm("Remove this person? Assignments pointed at them will fall back to Unassigned.")) return;
    btn.disabled = true;
    window.camazeFetch(`/api/org?resource=people&id=${encodeURIComponent(btn.dataset.id)}`, { method: "DELETE", headers: authHeaders })
      .then(async (res) => {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const deletedId = btn.dataset.id;
        state.people = state.people.filter((p) => p.id !== deletedId);
        // Defensive local fallback so no row keeps showing a person who no
        // longer exists — the entities refetch below supplies the
        // authoritative resolution (a department set only via this
        // person's fallback needs the server to re-derive it).
        state.entities = state.entities.map((e) => (e.person && e.person.id === deletedId ? { ...e, person: null } : e));
        renderPeople();
        refreshPeopleDropdowns();
        await reloadEntities();
        renderEntities();
      })
      .catch((err) => {
        btn.disabled = false;
        alert(`Could not remove: ${err.message}`);
      });
  });

  const toggleBtn = document.getElementById("toggle-person-form");
  const form = document.getElementById("person-form");
  toggleBtn.addEventListener("click", () => {
    form.style.display = form.style.display === "none" ? "flex" : "none";
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const errorEl = form.querySelector('[data-role="error"]');
    errorEl.textContent = "";
    const formData = new FormData(form);
    const body = {
      name: formData.get("name"),
      email: formData.get("email") || null,
      department_id: formData.get("department_id") || null,
    };
    const error = validationError(personSchema, body);
    if (error) { errorEl.textContent = error; return; }
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    window.camazeFetch("/api/org?resource=people", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        state.people.push(data.person);
        state.people.sort((a, b) => a.name.localeCompare(b.name));
        renderPeople();
        refreshPeopleDropdowns();
        form.reset();
        form.style.display = "none";
      })
      .catch((err) => { errorEl.textContent = err.message; })
      .finally(() => { submitBtn.disabled = false; });
  });
}

async function main() {
  const cfgRes = await window.camazeFetch("/api/config");
  const cfg = await cfgRes.json();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    document.getElementById("content").innerHTML =
      '<div class="message">Auth is not configured (missing SUPABASE_URL/SUPABASE_ANON_KEY).</div>';
    return;
  }

  const client = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data: { session } } = await client.auth.getSession();
  if (!session) {
    window.location.replace("/login.html");
    return;
  }

  await window.initializeSimulation(session);
  document.getElementById("user-email").textContent = session.user.email ?? "";
  document.getElementById("header-right").style.visibility = "visible";
  document.getElementById("signout-btn").addEventListener("click", async () => {
    await client.auth.signOut();
    window.location.replace("/login.html");
  });

  authHeaders = { Authorization: `Bearer ${session.access_token}` };

  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="card" id="entities-section">
      <div class="panel-header">
        <div>
          <div class="panel-title">Attribution entities</div>
          <div class="panel-description">Every key, workspace, and project spend has been seen from — unassigned ones are highlighted and sorted first.</div>
        </div>
      </div>
      <div class="panel-body">
        <div id="entities-table"><div class="message">Loading&hellip;</div></div>
      </div>
    </div>
    <div class="card" id="departments-section">
      <div class="panel-header">
        <div>
          <div class="panel-title">Departments</div>
          <div class="panel-description">Cost centers spend rolls up to. Edit any field in place — changes save on blur.</div>
        </div>
        <div class="panel-action"><button class="btn btn-sm" type="button" id="toggle-department-form">Add department</button></div>
      </div>
      <div class="panel-body">
        <div id="departments-table"><div class="message">Loading&hellip;</div></div>
        <form class="create-form" id="department-form" style="display:none">
          <div class="form-row">
            <div>
              <div class="field-label">Name</div>
              <input type="text" name="name" placeholder="e.g. Engineering" required>
            </div>
            <div>
              <div class="field-label">Headcount</div>
              <input type="number" name="headcount" min="0" step="1" value="0">
            </div>
            <div>
              <div class="field-label">Monthly budget (optional)</div>
              <input type="number" name="monthly_budget_usd" min="0" step="1" placeholder="No limit">
            </div>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">Add</button>
            <span class="form-error" data-role="error"></span>
          </div>
        </form>
      </div>
    </div>
    <div class="card" id="people-section">
      <div class="panel-header">
        <div>
          <div class="panel-title">People</div>
          <div class="panel-description">Individual owners spend can be assigned to. Edit any field in place — changes save on blur.</div>
        </div>
        <div class="panel-action"><button class="btn btn-sm" type="button" id="toggle-person-form">Add person</button></div>
      </div>
      <div class="panel-body">
        <div id="people-table"><div class="message">Loading&hellip;</div></div>
        <form class="create-form" id="person-form" style="display:none">
          <div class="form-row">
            <div>
              <div class="field-label">Name</div>
              <input type="text" name="name" placeholder="e.g. Priya Shah" required>
            </div>
            <div>
              <div class="field-label">Email (optional)</div>
              <input type="email" name="email" placeholder="priya@company.com">
            </div>
            <div>
              <div class="field-label">Department (optional)</div>
              <select name="department_id"><option value="">— None —</option></select>
            </div>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">Add</button>
            <span class="form-error" data-role="error"></span>
          </div>
        </form>
      </div>
    </div>`;

  const now = window.camazeNow();
  state.month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  const [deptRes, peopleRes, entitiesRes] = await Promise.all([
    window.camazeFetch("/api/org?resource=departments", { headers: authHeaders }),
    window.camazeFetch("/api/org?resource=people", { headers: authHeaders }),
    window.camazeFetch(`/api/org?resource=entities&month=${encodeURIComponent(state.month)}`, { headers: authHeaders }),
  ]);
  const [deptData, peopleData, entitiesData] = await Promise.all([deptRes.json(), peopleRes.json(), entitiesRes.json()]);
  if (deptData.error) throw new Error(deptData.error);
  if (peopleData.error) throw new Error(peopleData.error);
  if (entitiesData.error) throw new Error(entitiesData.error);

  state.departments = deptData.departments;
  state.people = peopleData.people;
  state.entities = entitiesData.entities;

  renderEntities();
  renderDepartments();
  renderPeople();
  renderPersonFormDepartmentOptions();

  wireDepartments();
  wirePeople();
}

main().catch((err) => {
  document.getElementById("content").innerHTML =
    '<div class="message">Could not load assignments: ' + esc(err.message) + "</div>";
});
