(function () {
  const data = window.CAMAZE_LAB_DATA;
  const byId = (id) => document.getElementById(id);
  const statusById = new Map(data.statuses.map((s) => [s.id, s]));
  const providerById = new Map(data.providers.map((p) => [p.id, p]));

  const state = {
    search: "",
    provider: localStorage.getItem("camaze-lab-provider") || "all",
    status: localStorage.getItem("camaze-lab-status") || "all",
    confidence: localStorage.getItem("camaze-lab-confidence") || "all",
    connection: localStorage.getItem("camaze-lab-connection") || "all",
    activeProvider: localStorage.getItem("camaze-lab-active-provider") || "anthropic",
    activeMethod: localStorage.getItem("camaze-lab-method") || "billing",
    archMode: localStorage.getItem("camaze-lab-arch") || "current",
    simDimension: localStorage.getItem("camaze-lab-sim-dimension") || "engineer",
    simProvider: localStorage.getItem("camaze-lab-sim-provider") || "provider-neutral",
    simSetup: new Set(JSON.parse(localStorage.getItem("camaze-lab-sim-setup") || '["billing"]'))
  };

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function statusBadge(statusId) {
    const s = statusById.get(statusId) || statusById.get("unavailable");
    return `<span class="badge tone-${s.tone}">${esc(s.label)}</span>`;
  }

  function sources(items) {
    if (!items || items.length === 0) return "";
    return `<div class="source-list">${items.map((s) =>
      `<span class="source" title="${esc(s.detail || "")}">${esc(s.label)}${s.detail ? ` · ${esc(s.detail)}` : ""}</span>`
    ).join("")}</div>`;
  }

  function textBlob(obj) {
    return JSON.stringify(obj).toLowerCase();
  }

  function matchesText(obj) {
    return !state.search || textBlob(obj).includes(state.search.toLowerCase());
  }

  function matchesStatus(obj) {
    return state.status === "all" || obj.status === state.status;
  }

  function matchesConfidence(obj) {
    return state.confidence === "all" || String(obj.confidence || "").toLowerCase().includes(state.confidence);
  }

  function matchesConnection(obj) {
    return state.connection === "all" || obj.connection === state.connection;
  }

  function matchesProviderForDimension(dim) {
    return state.provider === "all" || dim.providers.includes(state.provider) || dim.id === "provider";
  }

  function renderSummary() {
    byId("summary-list").innerHTML = data.meta.summary.map((item) => `<li>${esc(item)}</li>`).join("");
  }

  function renderLegend() {
    byId("status-legend").innerHTML = data.statuses.map((s) => `
      <div class="legend-item">
        <span class="dot tone-${s.tone}"></span>
        <span><strong>${esc(s.label)}</strong><span>${esc(s.meaning)}</span></span>
      </div>
    `).join("");
  }

  function populateFilters() {
    const providerOptions = data.providers.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("");
    byId("provider-filter").innerHTML = `<option value="all">All providers</option>${providerOptions}`;
    byId("status-filter").innerHTML =
      `<option value="all">All statuses</option>${data.statuses.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("")}`;
    byId("confidence-filter").innerHTML = [
      ["all", "All confidence"],
      ["provider", "Provider-billed/reported"],
      ["allocated", "Allocated"],
      ["estimated", "Estimated"],
      ["mapped", "Customer-mapped"],
      ["unavailable", "Unavailable"]
    ].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
    byId("connection-filter").innerHTML = [
      ["all", "All methods"],
      ["billing", "Billing/admin API"],
      ["mapping", "Manual mapping"],
      ["telemetry", "Telemetry / SDK"],
      ["gateway", "Gateway"]
    ].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
    byId("provider-filter").value = state.provider;
    byId("status-filter").value = state.status;
    byId("confidence-filter").value = state.confidence;
    byId("connection-filter").value = state.connection;
  }

  function providerFields(provider) {
    const rows = [
      ["Credential", provider.credential],
      ["Granularity", provider.granularity],
      ["Reporting delay", provider.reportingDelay],
      ["Pagination", provider.pagination],
      ["Backfill", provider.backfill],
      ["Incremental sync", provider.incremental],
      ["Cost source", provider.costSource]
    ];
    return rows.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("");
  }

  function renderProviderTabs() {
    const providers = data.providers.filter((p) => matchesStatus(p) && matchesText(p));
    if (!providers.some((p) => p.id === state.activeProvider)) {
      state.activeProvider = providers[0]?.id || "anthropic";
    }
    byId("provider-tabs").innerHTML = providers.map((p) =>
      `<button type="button" role="tab" data-provider-tab="${p.id}" aria-selected="${p.id === state.activeProvider}">${esc(p.label)}</button>`
    ).join("");
    renderProviderDetail();
  }

  function renderProviderDetail() {
    const provider = providerById.get(state.activeProvider);
    const target = byId("provider-detail");
    if (!provider || !matchesStatus(provider) || !matchesText(provider)) {
      target.innerHTML = `<div class="empty">No provider matches the current filters.</div>`;
      return;
    }
    target.innerHTML = `
      <article class="provider-card">
        <div class="provider-top">
          <div>
            <h3>${esc(provider.label)}</h3>
            <p>${esc(provider.support)}</p>
          </div>
          ${statusBadge(provider.status)}
        </div>
        <div class="provider-body">
          <div>
            ${providerFields(provider)}
          </div>
          <div>
            <h3>Endpoints currently called</h3>
            ${provider.endpoints.length ? `<ul>${provider.endpoints.map((e) => `<li><code>${esc(e)}</code></li>`).join("")}</ul>` : `<p class="empty">No current integration endpoints.</p>`}
            <h3>Current limitations</h3>
            <ul>${provider.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
            ${sources(provider.sources)}
          </div>
        </div>
      </article>
    `;
  }

  function renderDimensions() {
    const rows = data.dimensions
      .filter((d) => matchesText(d) && matchesStatus(d) && matchesProviderForDimension(d) && matchesConfidence(d) && matchesConnection(d));
    byId("dimension-table").innerHTML = rows.length ? rows.map((d) => `
      <tr data-dimension="${d.id}" tabindex="0">
        <td><strong>${esc(d.label)}</strong></td>
        <td>${statusBadge(d.status)}</td>
        <td>${esc(d.origin)}</td>
        <td>${esc(connectionLabel(d.connection))}</td>
        <td>${esc(d.confidence)}</td>
        <td><code>${esc(d.storage)}</code></td>
        <td>${esc(d.ui)}</td>
      </tr>
    `).join("") : `<tr><td colspan="7"><div class="empty">No dimensions match the current filters.</div></td></tr>`;
  }

  function connectionLabel(value) {
    return ({
      billing: "Billing/admin API",
      mapping: "Manual mapping",
      telemetry: "Telemetry / SDK",
      gateway: "Gateway"
    })[value] || "n/a";
  }

  function renderDimensionDetail(id) {
    const d = data.dimensions.find((item) => item.id === id);
    const drawer = byId("dimension-detail");
    if (!d) {
      drawer.hidden = true;
      return;
    }
    const providers = d.providers.length
      ? d.providers.map((p) => providerById.get(p)?.label || p).join(", ")
      : "None in current Camaze";
    drawer.hidden = false;
    drawer.innerHTML = `
      <h3>${esc(d.label)}</h3>
      <p>${statusBadge(d.status)}</p>
      <div class="provider-body">
        <div>
          <div class="kv"><span>Providers</span><span>${esc(providers)}</span></div>
          <div class="kv"><span>Method</span><span>${esc(d.method)}</span></div>
          <div class="kv"><span>Connection</span><span>${esc(connectionLabel(d.connection))}</span></div>
          <div class="kv"><span>Required setup</span><span>${esc(d.setup)}</span></div>
        </div>
        <div>
          <div class="kv"><span>Storage</span><span><code>${esc(d.storage)}</code></span></div>
          <div class="kv"><span>Current UI</span><span>${esc(d.ui)}</span></div>
          <div class="kv"><span>Improve it</span><span>${esc(d.improve)}</span></div>
        </div>
      </div>
    `;
  }

  function highlightJson(json, example, mode) {
    let out = esc(JSON.stringify(json, null, 2));
    const showAttr = localStorage.getItem(`camaze-lab-highlight-attr-${example.provider}`) !== "0";
    const showDrop = localStorage.getItem(`camaze-lab-highlight-drop-${example.provider}`) !== "0";
    const attr = mode === "raw" && showAttr ? example.attributionFields : [];
    const drop = mode === "raw" && showDrop ? example.discardedFields : [];
    for (const field of attr) {
      const re = new RegExp(`(&quot;${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}&quot;)`, "g");
      out = out.replace(re, `<span class="hl-attr">$1</span>`);
    }
    for (const field of drop) {
      const key = field.replace(/`/g, "").split(" ")[0];
      const re = new RegExp(`(&quot;${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}&quot;)`, "g");
      out = out.replace(re, `<span class="hl-drop">$1</span>`);
    }
    return out;
  }

  function rawCard(example) {
    const provider = providerById.get(example.provider);
    const mode = localStorage.getItem(`camaze-lab-raw-${example.provider}`) || "raw";
    const collapsed = localStorage.getItem(`camaze-lab-raw-collapsed-${example.provider}`) === "1";
    const showAttr = localStorage.getItem(`camaze-lab-highlight-attr-${example.provider}`) !== "0";
    const showDrop = localStorage.getItem(`camaze-lab-highlight-drop-${example.provider}`) !== "0";
    return `
      <article class="raw-card" data-raw-card="${example.provider}" data-mode="${mode}">
        <header>
          <h3>${esc(example.label)}</h3>
          <p>${esc(provider?.label || example.provider)} · attribution fields are green; discarded raw fields are red.</p>
          ${sources(example.sources)}
        </header>
        <div class="raw-controls">
          ${["raw", "normalized", "retained"].map((m) => `<button type="button" data-raw-mode="${m}" aria-selected="${m === mode}">${m}</button>`).join("")}
          <button type="button" data-toggle-attr aria-selected="${showAttr}">Attribution fields</button>
          <button type="button" data-toggle-drop aria-selected="${showDrop}">Discarded fields</button>
          <button type="button" data-collapse-raw>${collapsed ? "Expand" : "Collapse"}</button>
          <button type="button" data-copy-raw>Copy</button>
        </div>
        ${example.fieldNotes?.length ? `<div class="field-notes">${example.fieldNotes.map((n) => `<span><strong>${esc(n.field)}</strong> ${esc(n.note)}</span>`).join("")}</div>` : ""}
        <pre ${collapsed ? 'hidden' : ""}><code>${highlightJson(example.modes[mode], example, mode)}</code></pre>
      </article>
    `;
  }

  function renderRaw() {
    const examples = data.rawExamples.filter((ex) =>
      (state.provider === "all" || ex.provider === state.provider) && matchesText(ex)
    );
    byId("raw-list").innerHTML = examples.length ? examples.map(rawCard).join("") : `<div class="empty">No raw examples match the current filters.</div>`;
  }

  function renderClaims() {
    const claims = data.claims.filter((c) => matchesText(c) && matchesStatus(c));
    byId("claim-list").innerHTML = claims.length ? claims.map((c) => `
      <article class="claim-card">
        <h3>${esc(c.claim)} ${statusBadge(c.status)}</h3>
        <p><strong>Current support:</strong> ${esc(c.support)}</p>
        <p><strong>Accurate wording:</strong> ${esc(c.accurate)}</p>
        ${sources(c.source)}
      </article>
    `).join("") : `<div class="empty">No claims match the current filters.</div>`;
  }

  function populateSimulator() {
    byId("sim-dimension").innerHTML = data.simulator.dimensions.map((d) =>
      `<option value="${d.id}">${esc(d.label)}</option>`
    ).join("");
    byId("sim-provider").innerHTML = data.simulator.providers.map((p) =>
      `<option value="${p.id}">${esc(p.label)}</option>`
    ).join("");
    byId("sim-dimension").value = state.simDimension;
    byId("sim-provider").value = state.simProvider;
    byId("sim-setup").innerHTML = data.simulator.setupOptions.map((o) => `
      <label class="check-row">
        <input type="checkbox" value="${o.id}" ${state.simSetup.has(o.id) ? "checked" : ""}>
        ${esc(o.label)}
      </label>
    `).join("");
  }

  function simulatorResult() {
    const setup = state.simSetup;
    const dim = state.simDimension;
    const provider = state.simProvider;
    if (provider === "bedrock") {
      return {
        status: "proposed",
        title: "Not currently supported",
        method: "Build Bedrock billing ingestion first.",
        body: "Bedrock has no current Camaze provider module. Billing truth would likely come from AWS billing exports/CUR, while invocation detail would require logging or telemetry."
      };
    }
    if (["workflow", "repository", "session", "application", "customer"].includes(dim)) {
      if (setup.has("otel") || setup.has("sdk") || setup.has("toolTelemetry")) {
        return {
          status: "proposed",
          title: "Feasible with customer instrumentation",
          method: setup.has("sdk") ? "Use a customer-side SDK or event API." : "Use telemetry from tools or OpenTelemetry.",
          body: "Provider billing APIs provide billing truth, but these dimensions need context emitted by the customer's tool or application. A gateway is optional unless capture/enforcement must be mandatory."
        };
      }
      if (setup.has("gateway")) {
        return {
          status: "proposed",
          title: "Gateway can capture it for routed traffic",
          method: "Gateway is useful for mandatory capture and enforcement.",
          body: "This is heavier than telemetry and only covers routed calls. It is not implemented in the current repository."
        };
      }
      return {
        status: "unavailable",
        title: "Not supported from billing credentials alone",
        method: "Add telemetry or SDK instrumentation first.",
        body: "Current provider billing ingestion does not include workflow, repository, application, customer, session, trace, or agent context."
      };
    }
    if (dim === "team") {
      if (setup.has("mapping") && (setup.has("projects") || setup.has("keys") || provider === "anthropic")) {
        return {
          status: "partial",
          title: "Feasible with mapping",
          method: "Map provider entities to Camaze departments.",
          body: "This is current Camaze behavior. It is reliable only as far as the provider entity separation and manual mapping are accurate."
        };
      }
      return {
        status: "partial",
        title: "Only coarse attribution is possible",
        method: "Separate projects/workspaces/API keys and map them.",
        body: "Billing credentials alone can identify provider entities, but cannot know the customer's team model."
      };
    }
    if (dim === "engineer") {
      if (setup.has("mapping") && (setup.has("keys") || setup.has("projects"))) {
        return {
          status: "partial",
          title: "Feasible as owner mapping",
          method: "Map keys/projects/workspaces to people.",
          body: "This is not request-level engineer identity. It works when each person or owner has clearly separated provider entities."
        };
      }
      if (setup.has("toolTelemetry") || setup.has("otel") || setup.has("sdk")) {
        return {
          status: "proposed",
          title: "Feasible with instrumentation",
          method: "Emit authenticated user identity in telemetry.",
          body: "This would improve from manual ownership mapping to request/session-level attribution, but it is future work."
        };
      }
      return {
        status: "partial",
        title: "Approximate at best",
        method: "Add manual mappings or telemetry.",
        body: "Provider billing APIs alone do not identify the individual engineer behind each request."
      };
    }
    return {
      status: "unavailable",
      title: "No rule defined yet",
      method: "Expand simulator data.",
      body: "This simulator covers the main attribution paths from the seed prompt; this particular combination needs a more specific rule."
    };
  }

  function renderSimulator() {
    const result = simulatorResult();
    byId("sim-result").innerHTML = `
      <div class="result-title">${statusBadge(result.status)}<h3>${esc(result.title)}</h3></div>
      <p><strong>Least-invasive method:</strong> ${esc(result.method)}</p>
      <p>${esc(result.body)}</p>
    `;
  }

  function renderMethods() {
    const methods = data.methods.filter((m) => matchesText(m) && matchesStatus(m));
    if (!methods.some((m) => m.id === state.activeMethod)) state.activeMethod = methods[0]?.id || "billing";
    byId("method-tabs").innerHTML = methods.map((m) =>
      `<button type="button" data-method="${m.id}" aria-selected="${m.id === state.activeMethod}">${esc(m.label)}</button>`
    ).join("");
    const method = data.methods.find((m) => m.id === state.activeMethod);
    if (!method || !matchesText(method) || !matchesStatus(method)) {
      byId("method-detail").innerHTML = `<div class="empty">No method matches the current filters.</div>`;
      byId("method-flow").innerHTML = "";
      return;
    }
    byId("method-detail").innerHTML = `
      <article class="method-card">
        <h3>${esc(method.label)} ${statusBadge(method.status)}</h3>
        <p>${esc(method.role)}</p>
        <p>${esc(method.detail)}</p>
        <div class="tradeoff-grid">
          ${Object.entries(method.tradeoffs).map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("")}
        </div>
        ${sources(method.sources)}
      </article>
    `;
    byId("method-flow").innerHTML = `
      <h3>Data flow</h3>
      <div class="flow-line">
        ${method.flow.map((node, i) => `<span class="flow-node">${esc(node)}</span>${i < method.flow.length - 1 ? '<span class="flow-arrow">→</span>' : ""}`).join("")}
      </div>
    `;
  }

  function renderArchitecture() {
    const current = data.architecture.current;
    const future = state.archMode === "future" ? data.architecture.future : [];
    byId("architecture-view").innerHTML = `
      <div class="arch-stack">
        <div class="arch-diagram" aria-label="Current architecture diagram">
          <h3>Current Camaze</h3>
          <div class="diagram-lanes">
            <div class="lane">
              ${archNode(current.find((n) => n.id === "frontend"))}
            </div>
            <div class="lane split">
              ${archNode(current.find((n) => n.id === "auth"))}
              ${archNode(current.find((n) => n.id === "api"))}
              ${archNode(current.find((n) => n.id === "cron"))}
            </div>
            <div class="lane split">
              ${archNode(current.find((n) => n.id === "providers"))}
              ${archNode(current.find((n) => n.id === "storage"))}
              ${archNode(current.find((n) => n.id === "email"))}
            </div>
          </div>
          <div class="diagram-caption">Static app → authenticated serverless APIs → provider billing APIs, Supabase storage, and Resend email.</div>
        </div>
        <div class="arch-diagram future-diagram">
          <h3>${state.archMode === "future" ? "Potential future additions" : "Future additions hidden"}</h3>
          ${future.length ? `
            <div class="diagram-lanes">
              <div class="lane split">
                ${archNode(future.find((n) => n.id === "sdk"))}
                ${archNode(future.find((n) => n.id === "collector"))}
              </div>
              <div class="lane split">
                ${archNode(future.find((n) => n.id === "ingestionAuth"))}
                ${archNode(future.find((n) => n.id === "events"))}
                ${archNode(future.find((n) => n.id === "reconcile"))}
              </div>
              <div class="lane">
                ${archNode(future.find((n) => n.id === "gateway"))}
              </div>
            </div>
            <div class="diagram-caption">Future telemetry adds context outside the request path; gateway remains optional for enforcement.</div>
          ` : `<div class="empty">Switch to future overlay to show proposed telemetry, SDK, reconciliation, and optional gateway components.</div>`}
        </div>
      </div>
    `;
  }

  function archNode(node) {
    if (!node) return "";
    return `
      <div class="arch-node">
        ${statusBadge(node.status)}
        <strong>${esc(node.label)}</strong>
        <span>${esc(node.note)}</span>
      </div>
    `;
  }

  function renderGlossary() {
    const rows = data.glossary.filter((g) => matchesText(g) && matchesStatus(g));
    byId("glossary-list").innerHTML = rows.length ? rows.map((g) => `
      <article class="glossary-card">
        <h3>${esc(g.term)} ${statusBadge(g.status)}</h3>
        <p>${esc(g.definition)}</p>
        <p><strong>Camaze example:</strong> ${esc(g.example)}</p>
        <p><strong>Often confused with:</strong> ${esc(g.confusedWith)}</p>
      </article>
    `).join("") : `<div class="empty">No glossary terms match the current filters.</div>`;
  }

  function renderConfidence() {
    const rows = data.confidence.filter((c) => matchesText(c) && matchesStatus(c));
    byId("confidence-list").innerHTML = rows.length ? rows.map((c, i) => `
      <article class="confidence-row">
        <div class="confidence-index">${i + 1}</div>
        <div>
          <h3>${esc(c.label)} ${statusBadge(c.status)}</h3>
          <p>${esc(c.meaning)}</p>
          <div class="chip-row">${c.currentValues.map((v) => `<span class="chip">${esc(v)}</span>`).join("")}</div>
        </div>
      </article>
    `).join("") : `<div class="empty">No confidence categories match the current filters.</div>`;
  }

  function renderRoadmap() {
    const groups = data.roadmap.map((group) => ({
      ...group,
      items: group.items.filter((item) => matchesText(item) && matchesStatus(item))
    })).filter((group) => group.items.length);
    byId("roadmap-list").innerHTML = groups.length ? groups.map((group) => `
      <article class="roadmap-group">
        <h3>${esc(group.group)}</h3>
        <div class="roadmap-items">
          ${group.items.map((item) => `
            <div class="roadmap-item">
              <div class="result-title">${statusBadge(item.status)}<strong>${esc(item.title)}</strong></div>
              <p>${esc(item.why)}</p>
              <p><strong>Complexity:</strong> ${esc(item.complexity)} · <strong>Dependencies:</strong> ${esc(item.dependencies)}</p>
              <p><strong>Enables:</strong> ${esc(item.enables)}</p>
            </div>
          `).join("")}
        </div>
      </article>
    `).join("") : `<div class="empty">No roadmap items match the current filters.</div>`;
  }

  function renderAll() {
    renderProviderTabs();
    renderDimensions();
    renderSimulator();
    renderRaw();
    renderMethods();
    renderArchitecture();
    renderGlossary();
    renderConfidence();
    renderClaims();
    renderRoadmap();
  }

  function bindEvents() {
    byId("search").addEventListener("input", (event) => {
      state.search = event.target.value.trim();
      renderAll();
    });
    byId("provider-filter").addEventListener("change", (event) => {
      state.provider = event.target.value;
      localStorage.setItem("camaze-lab-provider", state.provider);
      renderAll();
    });
    byId("status-filter").addEventListener("change", (event) => {
      state.status = event.target.value;
      localStorage.setItem("camaze-lab-status", state.status);
      renderAll();
    });
    byId("confidence-filter").addEventListener("change", (event) => {
      state.confidence = event.target.value;
      localStorage.setItem("camaze-lab-confidence", state.confidence);
      renderDimensions();
    });
    byId("connection-filter").addEventListener("change", (event) => {
      state.connection = event.target.value;
      localStorage.setItem("camaze-lab-connection", state.connection);
      renderDimensions();
    });
    byId("reset-filters").addEventListener("click", () => {
      state.search = "";
      state.provider = "all";
      state.status = "all";
      state.confidence = "all";
      state.connection = "all";
      byId("search").value = "";
      byId("provider-filter").value = "all";
      byId("status-filter").value = "all";
      byId("confidence-filter").value = "all";
      byId("connection-filter").value = "all";
      localStorage.removeItem("camaze-lab-provider");
      localStorage.removeItem("camaze-lab-status");
      localStorage.removeItem("camaze-lab-confidence");
      localStorage.removeItem("camaze-lab-connection");
      renderAll();
    });
    byId("sim-dimension").addEventListener("change", (event) => {
      state.simDimension = event.target.value;
      localStorage.setItem("camaze-lab-sim-dimension", state.simDimension);
      renderSimulator();
    });
    byId("sim-provider").addEventListener("change", (event) => {
      state.simProvider = event.target.value;
      localStorage.setItem("camaze-lab-sim-provider", state.simProvider);
      renderSimulator();
    });
    byId("sim-setup").addEventListener("change", (event) => {
      if (!event.target.matches("input[type='checkbox']")) return;
      if (event.target.checked) state.simSetup.add(event.target.value);
      else state.simSetup.delete(event.target.value);
      localStorage.setItem("camaze-lab-sim-setup", JSON.stringify([...state.simSetup]));
      renderSimulator();
    });
    byId("provider-tabs").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-provider-tab]");
      if (!btn) return;
      state.activeProvider = btn.dataset.providerTab;
      localStorage.setItem("camaze-lab-active-provider", state.activeProvider);
      renderProviderTabs();
    });
    byId("dimension-table").addEventListener("click", (event) => {
      const row = event.target.closest("[data-dimension]");
      if (row) renderDimensionDetail(row.dataset.dimension);
    });
    byId("dimension-table").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest("[data-dimension]");
      if (row) {
        event.preventDefault();
        renderDimensionDetail(row.dataset.dimension);
      }
    });
    byId("raw-list").addEventListener("click", async (event) => {
      const modeBtn = event.target.closest("[data-raw-mode]");
      const card = event.target.closest("[data-raw-card]");
      if (!card) return;
      const example = data.rawExamples.find((ex) => ex.provider === card.dataset.rawCard);
      if (!example) return;
      if (modeBtn) {
        localStorage.setItem(`camaze-lab-raw-${example.provider}`, modeBtn.dataset.rawMode);
        renderRaw();
        return;
      }
      if (event.target.closest("[data-toggle-attr]")) {
        const key = `camaze-lab-highlight-attr-${example.provider}`;
        localStorage.setItem(key, localStorage.getItem(key) === "0" ? "1" : "0");
        renderRaw();
        return;
      }
      if (event.target.closest("[data-toggle-drop]")) {
        const key = `camaze-lab-highlight-drop-${example.provider}`;
        localStorage.setItem(key, localStorage.getItem(key) === "0" ? "1" : "0");
        renderRaw();
        return;
      }
      if (event.target.closest("[data-collapse-raw]")) {
        const key = `camaze-lab-raw-collapsed-${example.provider}`;
        localStorage.setItem(key, localStorage.getItem(key) === "1" ? "0" : "1");
        renderRaw();
        return;
      }
      if (event.target.closest("[data-copy-raw]")) {
        const mode = localStorage.getItem(`camaze-lab-raw-${example.provider}`) || "raw";
        await navigator.clipboard?.writeText(JSON.stringify(example.modes[mode], null, 2)).catch(() => {});
      }
    });
    byId("method-tabs").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-method]");
      if (!btn) return;
      state.activeMethod = btn.dataset.method;
      localStorage.setItem("camaze-lab-method", state.activeMethod);
      renderMethods();
    });
    document.querySelectorAll("[data-arch-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.archMode = btn.dataset.archMode;
        localStorage.setItem("camaze-lab-arch", state.archMode);
        document.querySelectorAll("[data-arch-mode]").forEach((b) =>
          b.setAttribute("aria-selected", String(b.dataset.archMode === state.archMode))
        );
        renderArchitecture();
      });
    });
  }

  function initNavState() {
    const links = [...document.querySelectorAll(".side-nav nav a")];
    const sections = links.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${entry.target.id}`));
      }
    }, { rootMargin: "-35% 0px -60% 0px" });
    sections.forEach((section) => observer.observe(section));
  }

  renderSummary();
  renderLegend();
  populateFilters();
  populateSimulator();
  bindEvents();
  initNavState();
  renderAll();
})();
