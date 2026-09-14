import * as supabase from '@supabase/supabase-js';
import '../header.js';
const README_URL = "https://github.com/michaperki/camaze/blob/main/README.md#setup";

const PROVIDERS = [
  {
    name: "anthropic",
    label: "Anthropic",
    swatch: "var(--series-1)",
    time: "~2 min",
    instructions: `
      <p>This lets camaze read your Anthropic spend — it can't send messages or spend your credits.</p>
      <ol>
        <li>First, make sure your Anthropic account has an organization. Go to <a href="https://console.anthropic.com/settings/organization" target="_blank" rel="noopener">Settings &rarr; Organization</a> in the Anthropic Console and create one if you haven't already. Admin keys aren't available on personal accounts.</li>
        <li>Go to <a href="https://console.anthropic.com/settings/admin-keys" target="_blank" rel="noopener">console.anthropic.com</a> and sign in.</li>
        <li>In the left sidebar, click <strong>Settings</strong>, then <strong>Admin keys</strong>.</li>
        <li>Click <strong>Create Key</strong>, give it any name, and copy the key (starts with <code>sk-ant-admin...</code>). You won't be able to see it again after this.</li>
        <li>Paste it below.</li>
      </ol>`,
  },
  {
    name: "openai",
    label: "OpenAI",
    swatch: "var(--series-2)",
    time: "~2 min",
    instructions: `
      <p>This lets camaze read your OpenAI spend — it can't use your credits.</p>
      <ol>
        <li>Go to <a href="https://platform.openai.com/settings/organization/admin-keys" target="_blank" rel="noopener">platform.openai.com</a> and sign in.</li>
        <li>Click <strong>Settings</strong>, then <strong>Organization</strong>, then <strong>Admin keys</strong>.</li>
        <li>Click <strong>Create</strong>, give it any name, and copy the key (starts with <code>sk-admin-...</code>). You won't be able to see it again after this.</li>
        <li>Paste it below.</li>
      </ol>`,
  },
  {
    name: "google",
    label: "Google",
    swatch: "var(--series-3)",
    time: "~10 min · Advanced",
    google: true,
    instructions: `
      <p>Google doesn't have a simple spend page like the others — billing has to already be
      exported to a BigQuery table, and connecting it needs a small credentials file from that
      setup (a "service account key"), plus the project and dataset it lives in. This one's more
      involved and is meant for whoever manages your Google Cloud billing.
      Full walkthrough in the <a href="${README_URL}" target="_blank" rel="noopener">README</a>.</p>`,
  },
];

const esc = (s) => String(s).replace(/</g, "&lt;");

function fieldsHtml(provider) {
  if (provider.google) {
    return `
      <div>
        <div class="field-label">Service account JSON (paste the entire file contents)</div>
        <textarea name="serviceAccountJson" placeholder='{"type": "service_account", ...}' required></textarea>
      </div>
      <div>
        <div class="field-label">Billing project ID</div>
        <input type="text" name="project" placeholder="my-gcp-project" required>
      </div>
      <div>
        <div class="field-label">Billing dataset (optional — defaults to billing_export)</div>
        <input type="text" name="dataset" placeholder="billing_export">
      </div>`;
  }
  return `
    <div>
      <div class="field-label">Admin key</div>
      <input type="password" name="key" placeholder="${provider.name === "anthropic" ? "sk-ant-admin-..." : "sk-admin-..."}" required autocomplete="off">
    </div>`;
}

function cardHtml(provider, state) {
  const connected = !!state?.connected;
  const statusHtml = connected
    ? `<span class="badge badge-success">Connected</span>`
    : `<span class="badge badge-secondary">Not connected</span>`;

  // Collapsed by default once connected (the card's job then is showing
  // status, not onboarding) but always present — previously the whole
  // <div class="instructions"> block only rendered in the disconnected
  // branch below, so there was no way to get back to setup instructions
  // (e.g. to re-check a URL or scope) without disconnecting first.
  const instructionsHtml = `
    <details class="instructions-details"${connected ? "" : " open"}>
      <summary>Setup instructions</summary>
      <div class="instructions">${provider.instructions}</div>
    </details>`;

  let body;
  if (connected) {
    const hint = provider.google
      ? `Billing project <span class="key-hint">${esc(state.hint || "")}</span>`
      : `<span class="key-hint">${provider.name === "anthropic" ? "sk-ant-admin" : "sk-admin"}...${esc(state.hint || "")}</span>`;
    body = `
      <div class="row">
        <span>${hint}</span>
        <button class="btn-text" type="button" data-action="disconnect" data-provider="${provider.name}">Disconnect</button>
      </div>
      ${instructionsHtml}`;
  } else {
    body = `
      ${instructionsHtml}
      <button class="btn" type="button" data-action="toggle-form" data-provider="${provider.name}">Connect</button>
      <form class="connect-form" data-provider="${provider.name}" style="display:none">
        <input type="hidden" name="provider" value="${esc(provider.name)}">
        ${fieldsHtml(provider)}
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">Connect</button>
          <span class="form-error" data-role="error"></span>
        </div>
      </form>`;
  }

  // No real last-sync timestamp exists on the backend — the key record's
  // updatedAt is set once, when the credential is saved, and never again.
  // Showing it as "Connected Xh ago" would look like a live signal but
  // never change, so once connected there's nothing honest to show here.
  const meta = connected ? "" : esc(provider.time);

  return `
    <div class="card" data-card="${provider.name}">
      <div class="panel-header">
        <div>
          <div class="panel-title provider-title"><span class="provider-swatch" style="background:${provider.swatch}"></span>${esc(provider.label)}</div>
          ${meta ? `<div class="panel-description">${meta}</div>` : ""}
        </div>
        <div class="panel-action">${statusHtml}</div>
      </div>
      <div class="panel-body">${body}</div>
    </div>`;
}

function render(providerStates) {
  const content = document.getElementById("content");
  content.innerHTML = PROVIDERS.map(p => cardHtml(p, providerStates[p.name])).join("");
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

  const authHeaders = { Authorization: `Bearer ${session.access_token}` };

  async function loadKeys() {
    const res = await window.camazeFetch("/api/keys", { headers: authHeaders });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    render(data.providers || {});
  }

  const content = document.getElementById("content");

  content.addEventListener("click", (e) => {
    const toggleBtn = e.target.closest('[data-action="toggle-form"]');
    if (toggleBtn) {
      const card = toggleBtn.closest("[data-card]");
      const form = card.querySelector("form.connect-form");
      form.style.display = form.style.display === "none" ? "flex" : "none";
      return;
    }

    const disconnectBtn = e.target.closest('[data-action="disconnect"]');
    if (disconnectBtn) {
      const provider = disconnectBtn.dataset.provider;
      if (!confirm(`Disconnect ${provider}? camaze will stop tracking its spend until you reconnect.`)) return;
      disconnectBtn.disabled = true;
      window.camazeFetch(`/api/keys?provider=${encodeURIComponent(provider)}`, { method: "DELETE", headers: authHeaders })
        .then(async (res) => {
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          sessionStorage.setItem("camaze_keys_changed", "1");
          return loadKeys();
        })
        .catch((err) => {
          disconnectBtn.disabled = false;
          alert(`Could not disconnect: ${err.message}`);
        });
    }
  });

  content.addEventListener("submit", (e) => {
    const form = e.target.closest("form.connect-form");
    if (!form) return;
    e.preventDefault();

    const errorEl = form.querySelector('[data-role="error"]');
    errorEl.textContent = "";

    const formData = new FormData(form);
    const body = {};
    for (const [k, v] of formData.entries()) {
      if (v) body[k] = v;
    }

    if (!body.provider) {
      errorEl.textContent = "Something went wrong reading the form — please refresh and try again.";
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Connecting…";

    window.camazeFetch("/api/keys", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        sessionStorage.setItem("camaze_keys_changed", "1");
        return loadKeys();
      })
      .catch((err) => {
        errorEl.textContent = err.message;
        submitBtn.disabled = false;
        submitBtn.textContent = "Connect";
      });
  });

  // --- Subscriptions & seats (manual fixed costs) ---

  const fmtUSD = (v) => v.toLocaleString("en-US", { style: "currency", currency: "USD" });
  let lastFixedCosts = [];

  // "Still active?" is a nudge, not an auto-expiry — nothing here ever
  // changes ended_on on its own. Dismissal is in-memory only (not saved
  // anywhere), so it reappears next visit; that's deliberate; this prompt
  // only ever shows on Integrations, never on the dashboard.
  const dismissedStalePrompts = new Set();
  const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

  function isStaleFixedCost(row) {
    if (row.ended_on) return false;
    return Date.now() - new Date(row.started_on + "T00:00:00Z").getTime() > SIX_MONTHS_MS;
  }

  function fixedCostRowHtml(row) {
    const period = row.billing_period === "annual" ? "/yr" : "/mo";
    const seatsLabel = row.seats > 1 ? ` × ${row.seats} seats` : "";
    const endLabel = row.ended_on ? ` · ended ${esc(row.ended_on)}` : "";
    const stalePrompt = (isStaleFixedCost(row) && !dismissedStalePrompts.has(row.id))
      ? `<div class="fixed-cost-stale-prompt">
           Still active? No end date, and it started ${esc(row.started_on)}.
           <button class="btn-text" type="button" data-action="confirm-active" data-id="${esc(row.id)}">Yes, still active</button>
           <button class="btn-text" type="button" data-action="set-end-date" data-id="${esc(row.id)}">Set end date</button>
         </div>`
      : "";
    return `
      <div class="row" data-fixed-cost-row="${esc(row.id)}">
        <span>
          <strong>${esc(row.vendor)}</strong> — ${esc(row.label)}
          <span class="fixed-cost-row-meta">${fmtUSD(row.unit_cost_usd)}${period}${seatsLabel} · since ${esc(row.started_on)}${endLabel}</span>
          ${stalePrompt}
        </span>
        <span>
          <button class="btn-text" type="button" data-action="edit-fixed-cost" data-id="${esc(row.id)}">Edit</button>
          <button class="btn-text" type="button" data-action="delete-fixed-cost" data-id="${esc(row.id)}">Remove</button>
        </span>
      </div>`;
  }

  function renderFixedCosts(rows) {
    lastFixedCosts = rows;
    document.getElementById("fixed-costs-list").innerHTML = rows.length
      ? rows.map(fixedCostRowHtml).join("")
      : '<p class="message" style="padding:8px 0;">No subscriptions added yet.</p>';
  }

  async function loadFixedCosts() {
    const res = await window.camazeFetch("/api/fixed-costs", { headers: authHeaders });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderFixedCosts(data.fixedCosts || []);
  }

  const fixedCostForm = document.getElementById("fixed-cost-form");

  function resetFixedCostForm() {
    fixedCostForm.reset();
    fixedCostForm.elements.id.value = "";
    fixedCostForm.querySelector('[data-role="fixed-cost-error"]').textContent = "";
    fixedCostForm.style.display = "none";
  }

  function openFixedCostForm(row) {
    fixedCostForm.reset();
    fixedCostForm.elements.id.value = row?.id || "";
    fixedCostForm.elements.vendor.value = row?.vendor || "";
    fixedCostForm.elements.label.value = row?.label || "";
    fixedCostForm.elements.unit_cost_usd.value = row?.unit_cost_usd ?? "";
    fixedCostForm.elements.seats.value = row?.seats ?? 1;
    fixedCostForm.elements.billing_period.value = row?.billing_period || "monthly";
    fixedCostForm.elements.started_on.value = row?.started_on || "";
    fixedCostForm.elements.ended_on.value = row?.ended_on || "";
    fixedCostForm.style.display = "flex";
  }

  document.getElementById("add-fixed-cost-btn").addEventListener("click", () => openFixedCostForm(null));
  document.getElementById("cancel-fixed-cost-btn").addEventListener("click", () => resetFixedCostForm());

  document.getElementById("fixed-costs-list").addEventListener("click", (e) => {
    const editBtn = e.target.closest('[data-action="edit-fixed-cost"]');
    if (editBtn) {
      const row = lastFixedCosts.find(r => String(r.id) === editBtn.dataset.id);
      if (row) openFixedCostForm(row);
      return;
    }

    // Neither of these touches the row's data — "confirm-active" only
    // dismisses the prompt in this browser tab; "set end date" just opens
    // the existing edit form so the user fills it in themselves.
    const confirmBtn = e.target.closest('[data-action="confirm-active"]');
    if (confirmBtn) {
      dismissedStalePrompts.add(confirmBtn.dataset.id);
      renderFixedCosts(lastFixedCosts);
      return;
    }

    const setEndDateBtn = e.target.closest('[data-action="set-end-date"]');
    if (setEndDateBtn) {
      const row = lastFixedCosts.find(r => String(r.id) === setEndDateBtn.dataset.id);
      if (row) openFixedCostForm(row);
      return;
    }

    const deleteBtn = e.target.closest('[data-action="delete-fixed-cost"]');
    if (deleteBtn) {
      if (!confirm("Remove this subscription?")) return;
      deleteBtn.disabled = true;
      window.camazeFetch(`/api/fixed-costs?id=${encodeURIComponent(deleteBtn.dataset.id)}`, { method: "DELETE", headers: authHeaders })
        .then(async (res) => {
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          sessionStorage.setItem("camaze_keys_changed", "1");
          return loadFixedCosts();
        })
        .catch((err) => {
          deleteBtn.disabled = false;
          alert(`Could not remove: ${err.message}`);
        });
    }
  });

  fixedCostForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const errorEl = fixedCostForm.querySelector('[data-role="fixed-cost-error"]');
    errorEl.textContent = "";

    const formData = new FormData(fixedCostForm);
    const id = formData.get("id");
    const body = {
      vendor: formData.get("vendor"),
      label: formData.get("label"),
      unit_cost_usd: Number(formData.get("unit_cost_usd")),
      seats: Number(formData.get("seats")),
      billing_period: formData.get("billing_period"),
      started_on: formData.get("started_on"),
      ended_on: formData.get("ended_on") || null,
    };

    const submitBtn = fixedCostForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    const req = id
      ? window.camazeFetch("/api/fixed-costs", { method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ id, ...body }) })
      : window.camazeFetch("/api/fixed-costs", { method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify(body) });

    req
      .then(async (res) => {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        sessionStorage.setItem("camaze_keys_changed", "1");
        resetFixedCostForm();
        return loadFixedCosts();
      })
      .catch((err) => {
        errorEl.textContent = err.message;
      })
      .finally(() => {
        submitBtn.disabled = false;
      });
  });

  await loadKeys();
  await loadFixedCosts();
}

main().catch((err) => {
  document.getElementById("content").innerHTML =
    '<div class="message">Could not load integrations: ' + esc(err.message) + "</div>";
});
