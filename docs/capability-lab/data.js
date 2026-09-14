window.CAMAZE_LAB_DATA = {
  meta: {
    title: "Camaze Capability Lab",
    updated: "2026-08-26",
    summary: [
      "Camaze imports provider billing data from Anthropic, OpenAI, and Google Cloud.",
      "Camaze maps provider entities to customer-created departments and people.",
      "Camaze does not currently ingest telemetry.",
      "Camaze does not currently include an LLM gateway.",
      "Workflow, session, repository, agent, and true request-level engineer attribution are not currently available."
    ]
  },
  statuses: [
    { id: "implemented", label: "Implemented", tone: "green", meaning: "Built in the current repository." },
    { id: "partial", label: "Partial / mapped / estimated", tone: "amber", meaning: "Works with caveats, manual mapping, allocation, or estimation." },
    { id: "provider", label: "Provider-supported, not integrated", tone: "blue", meaning: "The provider/source can expose it, but Camaze does not use it yet." },
    { id: "proposed", label: "Proposed future", tone: "purple", meaning: "A plausible future Camaze capability, not current behavior." },
    { id: "unavailable", label: "Unavailable", tone: "gray", meaning: "Not available from the current code path." },
    { id: "limitation", label: "Unsupported claim / limitation", tone: "red", meaning: "Important boundary that should not be marketed as working." }
  ],
  providers: [
    {
      id: "anthropic",
      label: "Anthropic",
      status: "implemented",
      credential: "Anthropic Admin API key (`sk-ant-admin...`). Ordinary Anthropic API keys are not sufficient.",
      support: "Daily billing ingestion, model spend, workspace spend, and API-key attribution with allocation/estimation caveats.",
      endpoints: [
        "GET /v1/organizations/cost_report",
        "GET /v1/organizations/usage_report/messages",
        "GET /v1/organizations/api_keys",
        "GET /v1/organizations/workspaces"
      ],
      granularity: "Daily buckets (`bucket_width=1d`).",
      reportingDelay: "Cost report data can lag current-day usage; current-day API-key cost may be estimated from usage_report token counts.",
      pagination: "`has_more` / `next_page` for reports; `after_id` / `last_id` for key and workspace listings.",
      backfill: "User-triggered `POST /api/costs` syncs the last six months; cron sync covers the current month and recent previous month.",
      incremental: "15-minute Vercel cron syncs the current month into Supabase.",
      costSource: "Cost report amounts are treated as billing truth. API-key rows are allocated from cost lines when possible, and estimated for days with usage but no cost lines.",
      dimensions: ["provider", "model", "workspace", "api_key", "department", "engineer"],
      limitations: [
        "Admin key requires an Anthropic organization.",
        "Workbench usage without `api_key_id` cannot be assigned to an API key.",
        "Unknown models can be flagged unpriced.",
        "Cached monthly attribution currently drops Anthropic unpriced metadata."
      ],
      sources: [
        { type: "file", label: "providers/anthropic.js", detail: "fetchCosts, fetchAttribution, fetchApiKeyAllocation" },
        { type: "file", label: "lib/pricing.js", detail: "estimate fallback price map" },
        { type: "file", label: "test/anthropic-attribution.test.js", detail: "allocation fixtures" }
      ]
    },
    {
      id: "openai",
      label: "OpenAI",
      status: "implemented",
      credential: "OpenAI organization Admin key (`sk-admin-...`). Ordinary project API keys are not sufficient.",
      support: "Daily billing ingestion, model spend from line items, and project-level attribution.",
      endpoints: [
        "GET /v1/organization/costs",
        "GET /v1/organization/projects"
      ],
      granularity: "Daily buckets (`bucket_width=1d`).",
      reportingDelay: "Billing API data is daily/provider-reported, not request-real-time.",
      pagination: "`has_more` / `next_page` for costs; `has_more` / `last_id` for projects.",
      backfill: "Same Camaze six-month backfill path as other providers.",
      incremental: "15-minute Vercel cron syncs the current month into Supabase.",
      costSource: "Organization Costs API values are treated as billing truth.",
      dimensions: ["provider", "model", "project", "department", "engineer"],
      limitations: [
        "Current Camaze attribution is project-level only.",
        "API-key attribution was removed after an unused name-resolution fan-out hit OpenAI admin API rate limits.",
        "No workflow, session, repository, or engineer identity is available from the current ingestion path."
      ],
      sources: [
        { type: "file", label: "providers/openai.js", detail: "fetchCosts, fetchAttribution" },
        { type: "file", label: "lib/costs.js", detail: "PROVIDER_SCOPE_PREFERENCE" }
      ]
    },
    {
      id: "google",
      label: "Google Cloud",
      status: "implemented",
      credential: "Service-account JSON plus billing project and BigQuery billing-export dataset.",
      support: "Daily spend from BigQuery billing export, project attribution, and SKU/model-derived breakdowns.",
      endpoints: [
        "POST https://oauth2.googleapis.com/token",
        "GET /bigquery/v2/projects/{project}/datasets/{dataset}/tables",
        "POST /bigquery/v2/projects/{project}/queries"
      ],
      granularity: "Daily aggregation using `DATE(usage_start_time, 'UTC')`.",
      reportingDelay: "Depends on Google Cloud Billing export latency.",
      pagination: "Billing table discovery lists up to 100 tables; query path expects `jobComplete` and does not poll.",
      backfill: "Same Camaze six-month backfill path as other providers, if the export contains history.",
      incremental: "15-minute Vercel cron syncs the current month into Supabase.",
      costSource: "BigQuery export sums `cost + credits`, divided by `currency_conversion_rate`.",
      dimensions: ["provider", "model", "project", "department", "engineer"],
      limitations: [
        "Google export includes all GCP SKUs in the billing project.",
        "AI-versus-non-AI classification is heuristic.",
        "No workflow, repository, session, or individual-user identity is read by the current query."
      ],
      sources: [
        { type: "file", label: "providers/google.js", detail: "fetchCosts SQL and BigQuery REST calls" },
        { type: "file", label: "lib/costs.js", detail: "Google model/non-model classification" }
      ]
    },
    {
      id: "bedrock",
      label: "AWS Bedrock",
      status: "proposed",
      credential: "Not implemented. Future support would likely need AWS billing export/CUR access and optional invocation logging or telemetry.",
      support: "No current Camaze provider integration.",
      endpoints: [],
      granularity: "Not applicable in the current repository.",
      reportingDelay: "Not applicable in the current repository.",
      pagination: "Not applicable in the current repository.",
      backfill: "Not implemented.",
      incremental: "Not implemented.",
      costSource: "Conceptually AWS billing exports for billing truth; invocation logging/telemetry for request detail.",
      dimensions: [],
      limitations: [
        "No `providers/bedrock.js` exists.",
        "Bedrock appears only as an excluded LiteLLM pricing variant in `lib/pricing.js`."
      ],
      sources: [
        { type: "file", label: "lib/pricing.js", detail: "Bedrock pricing variants explicitly excluded" }
      ]
    }
  ],
  dimensions: [
    {
      id: "provider",
      label: "Provider",
      status: "implemented",
      providers: ["anthropic", "openai", "google"],
      connection: "billing",
      origin: "Provider module identity in `providers/*.js`.",
      method: "provider-reported + Camaze-normalized",
      setup: "Connect at least one supported provider.",
      confidence: "Provider-reported",
      storage: "`daily_costs.provider`, `monthly_attribution.provider`",
      ui: "Dashboard chart, legend, attribution sections.",
      improve: "No major gap for supported providers."
    },
    {
      id: "model",
      label: "Model",
      status: "implemented",
      providers: ["anthropic", "openai", "google"],
      connection: "billing",
      origin: "Anthropic model field, OpenAI line item parsing, Google model label or SKU description.",
      method: "provider-reported / parsed",
      setup: "Provider billing/admin credentials.",
      confidence: "Provider-reported for Anthropic/OpenAI; heuristic for Google model-like SKUs.",
      storage: "`daily_costs.model`",
      ui: "Dashboard `By model` tab.",
      improve: "Store richer Google SKU/service classification."
    },
    {
      id: "provider_project",
      label: "Provider project",
      status: "implemented",
      providers: ["openai", "google"],
      connection: "billing",
      origin: "OpenAI `project_id`; Google billing export `project.id` and `project.name`.",
      method: "provider-reported",
      setup: "Admin key for OpenAI; BigQuery export for Google.",
      confidence: "Provider-reported",
      storage: "`monthly_attribution` with `scope='project'`",
      ui: "Dashboard attribution tab and Assignments page.",
      improve: "Add health/status display for projects that stop reporting."
    },
    {
      id: "api_key",
      label: "API key",
      status: "partial",
      providers: ["anthropic"],
      connection: "billing",
      origin: "Anthropic usage report `api_key_id`; names from Anthropic API key listing.",
      method: "allocated / estimated",
      setup: "Anthropic Admin API key.",
      confidence: "Allocated from billing lines when possible; estimated for days without cost lines.",
      storage: "`monthly_attribution` with `scope='api_key'`",
      ui: "Dashboard attribution tab and Assignments page.",
      improve: "Persist unpriced metadata and add request telemetry for exact caller context."
    },
    {
      id: "department",
      label: "Department",
      status: "partial",
      providers: ["anthropic", "openai", "google"],
      connection: "mapping",
      origin: "Customer-created department mapped to provider attribution entities.",
      method: "customer-mapped",
      setup: "Create departments and map keys/projects/workspaces on Assignments page.",
      confidence: "Depends on mapping quality and provider-entity granularity.",
      storage: "`departments`, `entity_assignments`",
      ui: "Dashboard `By department`, Assignments page.",
      improve: "Add import/SCIM/org integration or telemetry cost-center attributes."
    },
    {
      id: "engineer",
      label: "Engineer",
      status: "partial",
      providers: ["anthropic", "openai", "google"],
      connection: "mapping",
      origin: "Customer-created person mapped to provider entity ownership.",
      method: "customer-mapped",
      setup: "Create people and map provider entities to owners.",
      confidence: "Ownership mapping only, not request-level identity.",
      storage: "`people`, `entity_assignments`",
      ui: "Dashboard `Top spenders` only when person-level assignments exist.",
      improve: "Telemetry/SDK/agent events with authenticated user identity."
    },
    {
      id: "workflow",
      label: "Workflow",
      status: "unavailable",
      providers: [],
      connection: "telemetry",
      origin: "Not present in provider billing APIs used by Camaze.",
      method: "unavailable",
      setup: "Would require telemetry, SDK instrumentation, or gateway metadata.",
      confidence: "Unavailable today.",
      storage: "No current table.",
      ui: "No current UI.",
      improve: "Add telemetry schema and collector for workflow/session metadata."
    },
    {
      id: "repository",
      label: "Repository",
      status: "unavailable",
      providers: [],
      connection: "telemetry",
      origin: "Not present in current provider billing ingestion.",
      method: "unavailable",
      setup: "Would require developer-tool telemetry such as Codex/Claude Code events or customer SDK.",
      confidence: "Unavailable today.",
      storage: "No current table.",
      ui: "No current UI.",
      improve: "Add telemetry ingestion with repo attributes and privacy controls."
    },
    {
      id: "session",
      label: "Session / trace",
      status: "unavailable",
      providers: [],
      connection: "telemetry",
      origin: "No OTLP, trace, or agent-event collector exists.",
      method: "unavailable",
      setup: "Would require OpenTelemetry, SDK, native tool telemetry, or gateway.",
      confidence: "Unavailable today.",
      storage: "No current table.",
      ui: "No current UI.",
      improve: "Add ingestion tokens, event schema, and trace/session storage."
    },
    {
      id: "anthropic_workspace",
      label: "Anthropic workspace",
      status: "partial",
      providers: ["anthropic"],
      connection: "billing",
      origin: "Anthropic `workspace_id` from cost_report grouped by workspace.",
      method: "provider-reported",
      setup: "Anthropic Admin API key.",
      confidence: "Provider-reported, but Camaze prefers API-key scope when API-key rows exist to avoid double-counting.",
      storage: "`monthly_attribution` with `scope='workspace'` when selected",
      ui: "Dashboard attribution tab only when workspace is the selected provider scope.",
      improve: "Expose hierarchy-aware drilldown instead of choosing one scope per provider."
    },
    {
      id: "service_account",
      label: "Service account",
      status: "partial",
      providers: ["google"],
      connection: "billing",
      origin: "Customer-supplied Google service-account JSON used for BigQuery access.",
      method: "customer-supplied credential",
      setup: "Paste service-account JSON, billing project, and dataset on Integrations.",
      confidence: "Credential identity only; not a spend attribution dimension.",
      storage: "`user_provider_keys.encrypted_data`",
      ui: "Integrations shows billing project hint, not service-account identity.",
      improve: "Show non-sensitive credential health metadata without exposing service-account secrets."
    },
    {
      id: "team",
      label: "Team",
      status: "partial",
      providers: ["anthropic", "openai", "google"],
      connection: "mapping",
      origin: "No team table exists; teams are effectively represented as departments.",
      method: "customer-mapped",
      setup: "Model teams as departments and map provider entities to them.",
      confidence: "Depends on customer taxonomy and mapping granularity.",
      storage: "`departments`",
      ui: "Dashboard `By department`.",
      improve: "Add explicit teams or org-directory integration if team and department need to differ."
    },
    {
      id: "application",
      label: "Application / service",
      status: "unavailable",
      providers: [],
      connection: "telemetry",
      origin: "No current billing parser stores application/service names.",
      method: "unavailable",
      setup: "Would require SDK, OpenTelemetry resource attributes, or gateway metadata.",
      confidence: "Unavailable today.",
      storage: "No current table.",
      ui: "No current UI.",
      improve: "Add telemetry event schema with service.name/application fields."
    },
    {
      id: "environment",
      label: "Environment",
      status: "unavailable",
      providers: [],
      connection: "telemetry",
      origin: "No current billing parser stores deployment environment.",
      method: "unavailable",
      setup: "Would require telemetry, SDK instrumentation, or naming conventions in provider projects.",
      confidence: "Unavailable today.",
      storage: "No current table.",
      ui: "No current UI.",
      improve: "Add telemetry attributes such as deployment.environment."
    },
    {
      id: "agent",
      label: "Agent",
      status: "unavailable",
      providers: [],
      connection: "telemetry",
      origin: "No agent-event ingestion exists.",
      method: "unavailable",
      setup: "Would require Codex/Claude Code/native agent telemetry or SDK events.",
      confidence: "Unavailable today.",
      storage: "No current table.",
      ui: "No current UI.",
      improve: "Add agent event ingestion with agent name/version and session IDs."
    },
    {
      id: "customer",
      label: "Customer / cost center",
      status: "partial",
      providers: ["anthropic", "openai", "google"],
      connection: "mapping",
      origin: "Can be approximated with departments or future telemetry attributes; no dedicated customer table exists.",
      method: "customer-mapped / unavailable for true customer attribution",
      setup: "Use departments as cost centers today, or add SDK telemetry later.",
      confidence: "Customer-mapped for cost centers; unavailable for per-end-customer request attribution.",
      storage: "`departments` today; no customer-event table.",
      ui: "Department rollup only.",
      improve: "Add customer/cost_center telemetry attributes and privacy controls."
    }
  ],
  rawExamples: [
    {
      provider: "anthropic",
      label: "Anthropic cost report bucket",
      modes: {
        raw: {
          data: [
            {
              starting_at: "2024-01-15T00:00:00Z",
              ending_at: "2024-01-16T00:00:00Z",
              results: [
                {
                  amount: "1000",
                  model: "claude-haiku-4-5-20251001",
                  token_type: "uncached_input_tokens",
                  service_tier: "standard",
                  context_window: "0-200k",
                  workspace_id: "wrk_example",
                  api_key_id: "key_example"
                }
              ]
            }
          ],
          has_more: false,
          next_page: null
        },
        normalized: {
          days: [{ date: "2024-01-15", provider: "anthropic", amount_usd: 10 }],
          models: [{ model: "claude-haiku-4-5-20251001", amount_usd: 10 }]
        },
        retained: {
          daily_costs: [{ date: "2024-01-15", provider: "anthropic", model: "claude-haiku-4-5-20251001", amount_usd: 10 }],
          monthly_attribution: [{ provider: "anthropic", scope: "api_key", entity_id: "key_example", amount_usd: 10, estimated: false }]
        }
      },
      attributionFields: ["model", "workspace_id", "api_key_id"],
      discardedFields: ["ending_at", "token_type", "service_tier", "context_window"],
      fieldNotes: [
        { field: "amount", note: "Decimal cents from cost_report; converted to USD by Camaze." },
        { field: "api_key_id", note: "Attribution-relevant for Anthropic API-key allocation." },
        { field: "token_type", note: "Used during allocation but not stored in daily_costs." }
      ],
      sources: [{ type: "file", label: "test/anthropic-attribution.test.js", detail: "sanitized fixture shape" }]
    },
    {
      provider: "openai",
      label: "OpenAI organization costs bucket",
      modes: {
        raw: {
          data: [
            {
              start_time: 1705276800,
              results: [
                {
                  amount: { value: "12.34", currency: "usd" },
                  line_item: "gpt-4o-mini-2024-07-18, input",
                  project_id: "proj_example"
                }
              ]
            }
          ],
          has_more: false,
          next_page: null
        },
        normalized: {
          days: [{ date: "2024-01-15", provider: "openai", amount_usd: 12.34 }],
          models: [{ model: "gpt-4o-mini-2024-07-18", amount_usd: 12.34 }]
        },
        retained: {
          daily_costs: [{ date: "2024-01-15", provider: "openai", model: "gpt-4o-mini-2024-07-18", amount_usd: 12.34 }],
          monthly_attribution: [{ provider: "openai", scope: "project", entity_id: "proj_example", amount_usd: 12.34, estimated: false }]
        }
      },
      attributionFields: ["line_item", "project_id"],
      discardedFields: ["currency"],
      fieldNotes: [
        { field: "amount.value", note: "Dollar value used as cost truth." },
        { field: "line_item", note: "Parsed to derive model labels." },
        { field: "project_id", note: "Used for current OpenAI attribution." }
      ],
      sources: [{ type: "file", label: "providers/openai.js", detail: "cost and attribution parsing" }]
    },
    {
      provider: "google",
      label: "Google BigQuery billing row",
      modes: {
        raw: {
          rows: [
            { f: [{ v: "2026-08-01" }, { v: "gemini25flash" }, { v: "gcp-project-example" }, { v: "Example Project" }, { v: "8.75" }] }
          ]
        },
        normalized: {
          days: [{ date: "2026-08-01", provider: "google", amount_usd: 8.75 }],
          models: [{ model: "gemini25flash", amount_usd: 8.75 }],
          projects: [{ id: "gcp-project-example", name: "Example Project", amount_usd: 8.75 }]
        },
        retained: {
          daily_costs: [{ date: "2026-08-01", provider: "google", model: "gemini25flash", amount_usd: 8.75 }],
          monthly_attribution: [{ provider: "google", scope: "project", entity_id: "gcp-project-example", amount_usd: 8.75, estimated: false }]
        }
      },
      attributionFields: ["project_id", "project_name", "model"],
      discardedFields: ["raw BigQuery row wrapper `f`"],
      fieldNotes: [
        { field: "model", note: "Derived from Google label or SKU description." },
        { field: "project_id", note: "Used for Google project attribution." },
        { field: "amount_usd", note: "Query result of cost plus credits, currency-adjusted." }
      ],
      sources: [{ type: "file", label: "providers/google.js", detail: "BigQuery row coercion" }]
    }
  ],
  claims: [
    {
      claim: "Real-time spend",
      status: "limitation",
      support: "Not true real time. Camaze syncs frequently, but provider billing data is daily or delayed.",
      accurate: "Synced provider billing data, refreshed about every 15 minutes.",
      source: [{ type: "file", label: "vercel.json", detail: "cost-sync cron" }, { type: "file", label: "api/costs.js", detail: "SYNC_FRESH_MS" }]
    },
    {
      claim: "Spend by engineer",
      status: "partial",
      support: "Manual ownership mapping from provider entities to people, not request-level identity.",
      accurate: "Owner-level spend for mapped keys/projects/workspaces.",
      source: [{ type: "file", label: "lib/org.js", detail: "resolveAttribution" }, { type: "file", label: "public/dashboard.html", detail: "renderTopSpenders" }]
    },
    {
      claim: "Spend by workflow",
      status: "unavailable",
      support: "No workflow dimension exists in current billing ingestion or storage.",
      accurate: "Workflow attribution requires future telemetry, SDK, or gateway metadata.",
      source: [{ type: "file", label: "api/", detail: "no telemetry collector route" }]
    },
    {
      claim: "Spend by provider",
      status: "implemented",
      support: "Implemented for Anthropic, OpenAI, and Google when connected.",
      accurate: "Spend by supported provider.",
      source: [{ type: "file", label: "lib/costs.js", detail: "aggregateProviderResults" }]
    },
    {
      claim: "Spend by model",
      status: "implemented",
      support: "Implemented with provider-specific caveats; Google model classification is partly heuristic.",
      accurate: "Spend by provider-reported or parsed model/SKU for supported providers.",
      source: [{ type: "file", label: "providers/*.js", detail: "models/dayModels" }]
    },
    {
      claim: "Spend by department",
      status: "partial",
      support: "Works when provider entities are mapped to customer-created departments.",
      accurate: "Spend by mapped department.",
      source: [{ type: "file", label: "lib/org.js", detail: "resolveAttribution" }]
    },
    {
      claim: "Spend by team",
      status: "partial",
      support: "No team model exists; teams can be represented as departments.",
      accurate: "Team-like rollups if modeled as departments.",
      source: [{ type: "file", label: "public/assignments.html", detail: "department mapping UI" }]
    },
    {
      claim: "Forecasting",
      status: "implemented",
      support: "Simple current-month run-rate forecast over usage/subscriptions/fixed costs.",
      accurate: "Run-rate month-end forecast.",
      source: [{ type: "file", label: "lib/costs.js", detail: "buildSummary" }]
    },
    {
      claim: "Spike/anomaly detection",
      status: "partial",
      support: "Rules-based daily spike detection, not a general anomaly engine.",
      accurate: "Rules-based spike alerts.",
      source: [{ type: "file", label: "lib/alerts.js", detail: "evaluateSpike" }]
    },
    {
      claim: "Alerts",
      status: "implemented",
      support: "Email digest, spike alerts, and budget threshold alerts through Resend.",
      accurate: "Daily email digest and threshold/spike email alerts.",
      source: [{ type: "file", label: "api/cron/alerts.js", detail: "scheduled alert checks" }, { type: "file", label: "lib/alertRunner.js", detail: "runAlertChecksForUser" }]
    },
    {
      claim: "Budgets",
      status: "implemented",
      support: "Account monthly budget and department budgets are stored/displayed; budget alerts use account forecast threshold.",
      accurate: "Monthly budget tracking and threshold alerts.",
      source: [{ type: "file", label: "api/budget.js", detail: "monthly budget CRUD" }, { type: "file", label: "api/org.js", detail: "department monthly_budget_usd" }]
    },
    {
      claim: "Optimization recommendations",
      status: "unavailable",
      support: "No recommendation engine exists.",
      accurate: "Optimization recommendations are future work.",
      source: [{ type: "file", label: "lib/", detail: "no optimization module" }]
    },
    {
      claim: "AWS Bedrock support",
      status: "unavailable",
      support: "No Bedrock provider integration exists.",
      accurate: "Bedrock is proposed, not currently supported.",
      source: [{ type: "file", label: "providers/", detail: "no providers/bedrock.js" }]
    },
    {
      claim: "Multi-provider support",
      status: "implemented",
      support: "Implemented for Anthropic, OpenAI, and Google Cloud billing export.",
      accurate: "Multi-provider support for Anthropic, OpenAI, and Google Cloud.",
      source: [{ type: "file", label: "providers/anthropic.js", detail: "implemented" }, { type: "file", label: "providers/openai.js", detail: "implemented" }, { type: "file", label: "providers/google.js", detail: "implemented" }]
    }
  ],
  simulator: {
    dimensions: [
      { id: "team", label: "Team / department" },
      { id: "engineer", label: "Engineer" },
      { id: "workflow", label: "Workflow" },
      { id: "repository", label: "Repository" },
      { id: "application", label: "Application / service" },
      { id: "session", label: "Session / trace" },
      { id: "customer", label: "Customer / cost center" }
    ],
    providers: [
      { id: "provider-neutral", label: "Provider-neutral" },
      { id: "anthropic", label: "Anthropic" },
      { id: "openai", label: "OpenAI" },
      { id: "google", label: "Google" },
      { id: "bedrock", label: "Bedrock" }
    ],
    setupOptions: [
      { id: "billing", label: "Admin/billing credentials only" },
      { id: "projects", label: "Separate provider projects/workspaces" },
      { id: "keys", label: "Separate API keys" },
      { id: "mapping", label: "Manual Camaze mappings" },
      { id: "toolTelemetry", label: "Claude Code or Codex telemetry" },
      { id: "otel", label: "Generic OpenTelemetry" },
      { id: "sdk", label: "Camaze SDK" },
      { id: "gateway", label: "Gateway" }
    ]
  },
  methods: [
    {
      id: "billing",
      label: "Provider billing/admin API",
      status: "implemented",
      role: "Financial truth and coarse provider dimensions.",
      detail: "The current Camaze product is built around this method. It imports provider-reported daily cost data and stores normalized cost rows.",
      tradeoffs: {
        attribution: "Provider, model, project/workspace/API-key where exposed.",
        speed: "Provider-delayed; Camaze syncs frequently but cannot make billing APIs real time.",
        effort: "Low after credentials are connected.",
        security: "Requires powerful admin/billing credentials.",
        reliability: "Does not sit in the request path.",
        coverage: "Only supported providers and provider-exposed dimensions.",
        enforcement: "No inline enforcement."
      },
      flow: ["Customer", "LLM provider", "Provider billing API", "Camaze"],
      sources: [{ type: "file", label: "providers/*.js", detail: "billing fetchers" }, { type: "file", label: "lib/costSync.js", detail: "stored sync" }]
    },
    {
      id: "telemetry",
      label: "Native tool telemetry",
      status: "proposed",
      role: "Developer, session, tool, repository, and workflow context.",
      detail: "Not implemented today. This would let developer tools send context that provider billing APIs cannot know.",
      tradeoffs: {
        attribution: "Engineer, repo, agent, session, workflow, and trace when emitted.",
        speed: "Near real time if collected directly.",
        effort: "Medium; users must configure tools or collectors.",
        security: "Requires clear redaction and event-auth boundaries.",
        reliability: "Out-of-band, so it does not block LLM calls.",
        coverage: "Only instrumented tools and workflows.",
        enforcement: "Observation only unless combined with policy or gateway."
      },
      flow: ["Customer tool/agent", "Telemetry event", "Camaze collector", "Billing reconciliation"],
      sources: [{ type: "file", label: "api/", detail: "no collector route exists today" }]
    },
    {
      id: "sdk",
      label: "Customer-side SDK",
      status: "proposed",
      role: "Application-defined business dimensions.",
      detail: "A lightweight SDK could attach environment, application, customer, cost center, workflow, and user identity without forcing traffic through Camaze.",
      tradeoffs: {
        attribution: "Best for app/customer/business dimensions chosen by the customer.",
        speed: "Near real time.",
        effort: "Medium; customer code changes required.",
        security: "Customer keeps provider traffic direct; SDK still needs ingestion auth.",
        reliability: "Out-of-band if designed as non-blocking.",
        coverage: "Provider-neutral for instrumented code paths.",
        enforcement: "Observation only unless paired with controls."
      },
      flow: ["Customer application", "LLM provider", "SDK event", "Camaze collector"],
      sources: [{ type: "file", label: "prompts/devTool.md", detail: "proposed future capability" }]
    },
    {
      id: "gateway",
      label: "Gateway",
      status: "proposed",
      role: "Mandatory interception, routing, policy, and enforcement.",
      detail: "No gateway exists now; it was removed from the repository. A gateway is useful for mandatory capture and inline control, not required for all observation.",
      tradeoffs: {
        attribution: "High request detail for routed traffic.",
        speed: "Real time.",
        effort: "High; customers must route LLM traffic through Camaze.",
        security: "Highest exposure because Camaze sits in the request path.",
        reliability: "Can affect LLM availability and latency.",
        coverage: "Only traffic routed through it.",
        enforcement: "Strong: blocking, routing, policy, budget controls."
      },
      flow: ["Customer", "Camaze gateway", "LLM provider", "Billing reconciliation"],
      sources: [{ type: "file", label: "git history 3e6ce56", detail: "gateway files removed" }]
    }
  ],
  architecture: {
    current: [
      { id: "frontend", label: "Static HTML frontend", note: "public/*.html", status: "implemented" },
      { id: "auth", label: "Supabase authentication", note: "Google OAuth + magic link", status: "implemented" },
      { id: "api", label: "Vercel serverless functions", note: "api/*.js", status: "implemented" },
      { id: "providers", label: "Provider billing modules", note: "Anthropic, OpenAI, Google", status: "implemented" },
      { id: "storage", label: "Supabase cost storage", note: "daily_costs, monthly_attribution", status: "implemented" },
      { id: "email", label: "Resend email", note: "digest and alerts", status: "implemented" },
      { id: "cron", label: "Scheduled sync + reconciliation", note: "vercel.json crons", status: "implemented" }
    ],
    future: [
      { id: "collector", label: "OTLP-compatible collector", note: "not implemented", status: "proposed" },
      { id: "ingestionAuth", label: "Ingestion credentials", note: "not implemented", status: "proposed" },
      { id: "events", label: "Normalized telemetry events", note: "workflow/session/repo attributes", status: "proposed" },
      { id: "reconcile", label: "Billing-to-telemetry reconciliation", note: "future matching layer", status: "proposed" },
      { id: "sdk", label: "Optional SDK", note: "customer-side instrumentation", status: "proposed" },
      { id: "gateway", label: "Optional gateway later", note: "policy/enforcement", status: "proposed" }
    ]
  },
  glossary: [
    {
      term: "Billing truth",
      status: "implemented",
      definition: "A cost number from the system that ultimately bills the customer.",
      example: "OpenAI organization Costs API amount, Anthropic cost_report amount, Google BigQuery billing export cost.",
      confusedWith: "Estimated cost, allocated cost"
    },
    {
      term: "Allocated cost",
      status: "partial",
      definition: "A billed amount split across lower-level entities because the provider does not directly report dollars at that level.",
      example: "Anthropic API-key dollars allocated by joining cost_report lines to usage_report token rows.",
      confusedWith: "Provider-billed cost"
    },
    {
      term: "Department",
      status: "partial",
      definition: "A customer-created rollup target for spend.",
      example: "Engineering mapped to a set of OpenAI projects and Anthropic API keys.",
      confusedWith: "Provider project, team"
    },
    {
      term: "Workflow",
      status: "unavailable",
      definition: "A customer-defined task or process that generated LLM usage.",
      example: "Code review automation or support-ticket summarization.",
      confusedWith: "Model, provider project"
    },
    {
      term: "Telemetry",
      status: "proposed",
      definition: "Events emitted by tools or applications describing usage context beyond provider billing fields.",
      example: "A Codex session event carrying repo, user, agent, and workflow identifiers.",
      confusedWith: "Billing API"
    },
    {
      term: "Gateway",
      status: "proposed",
      definition: "A proxy in the LLM request path that can observe, route, and enforce policy inline.",
      example: "Customer -> Camaze gateway -> provider.",
      confusedWith: "SDK instrumentation"
    },
    {
      term: "Run-rate forecast",
      status: "implemented",
      definition: "A simple projection from current month spend to expected month-end spend.",
      example: "`buildSummary` projects usage and subscriptions separately.",
      confusedWith: "Predictive optimization model"
    },
    {
      term: "Spike alert",
      status: "implemented",
      definition: "A rules-based daily alert comparing yesterday's usage to a trailing median or quiet-baseline threshold.",
      example: "`evaluateSpike` in `lib/alerts.js`.",
      confusedWith: "General anomaly detection"
    },
    {
      term: "Billing data",
      status: "implemented",
      definition: "Provider-reported records about monetary charges.",
      example: "OpenAI organization costs buckets or Google billing export rows.",
      confusedWith: "Telemetry, usage data"
    },
    {
      term: "Usage data",
      status: "partial",
      definition: "Provider or customer data describing token/request usage, sometimes without exact billed dollars.",
      example: "Anthropic usage_report/messages rows used for API-key allocation.",
      confusedWith: "Billing truth"
    },
    {
      term: "Estimated cost",
      status: "partial",
      definition: "A cost Camaze calculates from token counts and a price map when billed dollars are not yet available at that dimension.",
      example: "Anthropic current-day API-key fallback.",
      confusedWith: "Allocated cost"
    },
    {
      term: "Provider project",
      status: "implemented",
      definition: "A provider-native project identifier used to group spend.",
      example: "OpenAI project_id or Google Cloud project.id.",
      confusedWith: "Customer project, repository"
    },
    {
      term: "Anthropic workspace",
      status: "partial",
      definition: "An Anthropic organization workspace that can be used as a billing attribution scope.",
      example: "cost_report grouped by workspace_id.",
      confusedWith: "API key"
    },
    {
      term: "API key",
      status: "partial",
      definition: "A provider credential or credential identifier that may be usable as an attribution entity.",
      example: "Anthropic api_key_id from usage_report/messages.",
      confusedWith: "Admin API key"
    },
    {
      term: "Service account",
      status: "partial",
      definition: "A cloud identity used by Camaze to access Google BigQuery billing export.",
      example: "Google service-account JSON pasted on Integrations.",
      confusedWith: "Spend attribution entity"
    },
    {
      term: "Team",
      status: "partial",
      definition: "A business grouping of people; Camaze currently models this only through departments.",
      example: "Using a Department named Platform as a team rollup.",
      confusedWith: "Department"
    },
    {
      term: "Engineer",
      status: "partial",
      definition: "A person who owns or generates usage. Current Camaze support is manual ownership mapping, not request identity.",
      example: "A person assigned to an OpenAI project on Assignments.",
      confusedWith: "Provider API key owner"
    },
    {
      term: "Application/service",
      status: "unavailable",
      definition: "The software component that generated LLM usage.",
      example: "support-bot or ci-code-reviewer.",
      confusedWith: "Provider project"
    },
    {
      term: "Agent",
      status: "unavailable",
      definition: "An automated coding/tooling agent or workflow participant.",
      example: "Codex or Claude Code session metadata, if ingested in the future.",
      confusedWith: "Model"
    },
    {
      term: "Session",
      status: "unavailable",
      definition: "A bounded interaction period or run associated with one or more LLM calls.",
      example: "A single coding-agent work session.",
      confusedWith: "Trace"
    },
    {
      term: "Trace",
      status: "unavailable",
      definition: "A correlated set of spans/events describing an execution path.",
      example: "An OpenTelemetry trace for a request that calls an LLM.",
      confusedWith: "Session"
    },
    {
      term: "Span",
      status: "unavailable",
      definition: "One timed operation within a trace.",
      example: "An LLM call span with model and token attributes.",
      confusedWith: "Trace"
    },
    {
      term: "OpenTelemetry",
      status: "proposed",
      definition: "A standard framework for application telemetry.",
      example: "Future OTLP-compatible Camaze collector.",
      confusedWith: "Provider billing API"
    },
    {
      term: "OTLP",
      status: "proposed",
      definition: "OpenTelemetry Protocol for sending telemetry data.",
      example: "Future HTTP collector endpoint accepting telemetry payloads.",
      confusedWith: "OAuth"
    },
    {
      term: "SDK instrumentation",
      status: "proposed",
      definition: "Customer code that emits usage context directly to Camaze.",
      example: "A future Camaze SDK attaching customer_id and workflow.",
      confusedWith: "Gateway"
    },
    {
      term: "Reconciliation",
      status: "implemented",
      definition: "Comparing stored Camaze cost rows against a fresh provider fetch.",
      example: "`reconcileUserMonth` writes `reconciliation_runs`.",
      confusedWith: "Backfill"
    },
    {
      term: "Attribution",
      status: "partial",
      definition: "Assigning spend to the entity that should be accountable for it.",
      example: "Mapping an Anthropic API key to a department and person.",
      confusedWith: "Billing truth"
    },
    {
      term: "Attribution confidence",
      status: "implemented",
      definition: "The qualitative basis for trusting a value, such as provider-billed, allocated, mapped, or unavailable.",
      example: "Anthropic API-key spend is allocated/estimated, while OpenAI project spend is provider-reported.",
      confusedWith: "A single percentage score"
    },
    {
      term: "Cost center",
      status: "partial",
      definition: "A business accounting target for spend.",
      example: "A Camaze department with monthly_budget_usd.",
      confusedWith: "Customer"
    },
    {
      term: "Fixed cost",
      status: "implemented",
      definition: "A manually entered subscription or seat cost not reported by provider APIs.",
      example: "Claude Pro or Cursor seats entered on Integrations.",
      confusedWith: "Provider-billed subscription line"
    },
    {
      term: "Anomaly",
      status: "unavailable",
      definition: "A broad unexpected-pattern detection concept.",
      example: "Not currently implemented beyond rules-based spike alerts.",
      confusedWith: "Spike alert"
    }
  ],
  confidence: [
    {
      label: "Provider-billed",
      status: "implemented",
      meaning: "Dollars from provider billing or export systems.",
      currentValues: ["OpenAI Costs API amount", "Anthropic cost_report amount", "Google BigQuery billing export amount"]
    },
    {
      label: "Provider-reported",
      status: "implemented",
      meaning: "Provider dimension values attached to billing data.",
      currentValues: ["provider", "model", "OpenAI project", "Google project", "Anthropic workspace"]
    },
    {
      label: "Reconciled",
      status: "implemented",
      meaning: "Stored values compared against a fresh provider fetch.",
      currentValues: ["reconciliation_runs status and drift banners"]
    },
    {
      label: "Allocated",
      status: "partial",
      meaning: "Billed dollars assigned to a lower-level entity using supporting usage data.",
      currentValues: ["Anthropic API-key attribution"]
    },
    {
      label: "Customer-mapped",
      status: "partial",
      meaning: "A customer assigns provider entities to business entities.",
      currentValues: ["departments", "people", "entity_assignments"]
    },
    {
      label: "Customer-supplied through telemetry",
      status: "proposed",
      meaning: "Identity/context emitted by customer tools or applications.",
      currentValues: ["not implemented today"]
    },
    {
      label: "Camaze-estimated",
      status: "partial",
      meaning: "Camaze calculates a dollar estimate from token counts and pricing.",
      currentValues: ["Anthropic current-day API-key fallback"]
    },
    {
      label: "Unavailable",
      status: "unavailable",
      meaning: "No value exists in the current ingestion path.",
      currentValues: ["workflow", "repository", "session", "trace", "agent"]
    }
  ],
  roadmap: [
    {
      group: "Foundation",
      items: [
        { title: "Complete database migrations and RLS policies", status: "proposed", complexity: "Medium", why: "The full current schema is not reproducible from checked-in migrations.", dependencies: "Schema inventory", enables: "Production readiness" },
        { title: "Expand parser and aggregation tests", status: "proposed", complexity: "Medium", why: "Only Anthropic attribution has tests today.", dependencies: "Provider fixtures", enables: "Reliable multi-provider claims" },
        { title: "Improve sync-status visibility", status: "proposed", complexity: "Small", why: "Users need clear provider health and last-sync context.", dependencies: "cost_sync_state UI", enables: "Trust in dashboard numbers" }
      ]
    },
    {
      group: "Attribution",
      items: [
        { title: "First-class ingestion tokens", status: "proposed", complexity: "Medium", why: "Telemetry needs scoped, revocable credentials.", dependencies: "Security model", enables: "Telemetry ingestion" },
        { title: "Telemetry event schema", status: "proposed", complexity: "Medium", why: "Workflow/session/repo dimensions need durable structure.", dependencies: "Schema design", enables: "Workflow and repository attribution" },
        { title: "OTLP-compatible HTTP collector", status: "proposed", complexity: "Large", why: "Lets customers send standardized metrics/traces/events.", dependencies: "Ingestion auth and storage", enables: "Provider-neutral instrumentation" },
        { title: "Billing-to-telemetry reconciliation", status: "proposed", complexity: "Large", why: "Connects fast telemetry context to slower billing truth.", dependencies: "Telemetry storage + billing sync", enables: "High-confidence request attribution" }
      ]
    },
    {
      group: "Later capabilities",
      items: [
        { title: "Optimization recommendations", status: "proposed", complexity: "Large", why: "Requires enough context to identify inefficient usage safely.", dependencies: "Telemetry + model metadata", enables: "Optimization claims" },
        { title: "Optional gateway", status: "proposed", complexity: "Large", why: "Useful for mandatory capture, routing, blocking, and inline budgets.", dependencies: "Policy model and customer adoption path", enables: "Enforcement claims" }
      ]
    }
  ]
};
