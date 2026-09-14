Build an internal, interactive HTML tool called **Camaze Capability Lab**.

This is not a marketing page and should not be deployed publicly. It is a technical product reference for Camaze’s founders and engineers. Its purpose is to make the product’s current capabilities, provider data, terminology, attribution limits, architecture, and future options understandable through rich visuals and interactive exploration.

## Working rules

Before implementation:

1. Reinspect the relevant code so the tool reflects the current repository.
2. Treat the codebase as the source of truth for implemented behavior.
3. Distinguish clearly between:

   * Implemented now
   * Partially implemented
   * Available from a provider but not integrated
   * Proposed future capability
   * Not possible without instrumentation or a gateway
4. Do not change the existing Camaze application behavior.
5. Do not add provider integrations, telemetry ingestion, or a gateway.
6. Do not expose credentials, real customer data, environment values, or secrets.
7. Use only sanitized or synthetic example payloads that accurately match verified schemas.
8. Do not present recommendations as existing functionality.

## Location and architecture

Create the tool outside the deployed `public/` application, preferably:

```text
docs/capability-lab/
  index.html
  styles.css
  data.js
  app.js
  README.md
```

Use plain HTML, CSS, and JavaScript unless the repository already contains a clearly better internal tooling convention.

Use `data.js` rather than runtime-fetched JSON so the tool can work when `index.html` is opened directly from the filesystem without a local server.

Keep content separate from rendering logic. `data.js` should contain structured objects for providers, dimensions, terminology, raw examples, claims, architecture stages, and roadmap items.

Do not add external frameworks or a build step merely for this tool. Avoid CDN dependencies.

## Visual direction

The tool should feel like a polished technical product rather than a Markdown document placed inside a browser.

Use:

* Strong information hierarchy
* Generous whitespace
* Clear typography
* Camaze’s existing visual identity where appropriate
* Restrained color
* Cards, tables, badges, filters, diagrams, and code viewers
* Sticky navigation or a persistent section index
* Responsive layouts
* Smooth but subtle interactions
* Accessible contrast and keyboard behavior

Avoid:

* Marketing-style exaggeration
* Excessive gradients
* Decorative graphics without informational value
* Giant hero sections
* Dense walls of text
* Treating every item as an identical card

Status styling must remain consistent:

* Green: implemented
* Amber: partial, mapped, allocated, or estimated
* Blue: provider-supported but not yet integrated
* Purple: proposed
* Gray: unavailable
* Red: unsupported claim or important limitation

Include a visible legend explaining these meanings.

## Core experience

The opening section should answer:

> What can Camaze know, where does that information come from, and what must a customer configure to obtain it?

Show a concise current-state summary:

* Camaze currently imports provider billing data.
* It supports Anthropic, OpenAI, and Google billing sources.
* It maps provider entities to customer-created departments and people.
* It does not currently ingest telemetry.
* It does not currently operate as an LLM gateway.
* Workflow, session, repository, agent, and true request-level engineer attribution are not currently available.

Do not bury these distinctions.

## 1. Attribution Explorer

Create an interactive explorer centered on these desired dimensions:

* Provider
* Model
* Provider project
* Anthropic workspace
* API key
* Department
* Team
* Engineer
* Application/service
* Environment
* Repository
* Agent
* Session
* Trace
* Workflow
* Customer
* Cost center

When a user selects a dimension, display:

* Whether Camaze supports it today
* Which providers support it
* Where the value originates
* Whether it is provider-reported, mapped, allocated, estimated, customer-supplied, or unavailable
* Required credential or customer configuration
* Reliability/confidence level
* Relevant storage location
* Whether the dimension appears in the current UI
* What would be required to improve it

Include filters for:

* Provider
* Connection method
* Implementation status
* Attribution confidence

Provide a compact comparison-table view and a detailed view.

## 2. “Can Camaze Attribute This?” simulator

Build a small interactive decision tool.

Inputs should include:

* Desired attribution: team, engineer, workflow, repository, application, session, customer, etc.
* Provider: Anthropic, OpenAI, Google, Bedrock, or provider-neutral
* Available customer setup:

  * Admin/billing credentials only
  * Separate provider projects/workspaces
  * Separate API keys
  * Manual Camaze mappings
  * Claude Code or Codex telemetry
  * Generic OpenTelemetry
  * Camaze SDK
  * Gateway

The result should explain:

* Fully feasible
* Feasible with mapping
* Feasible with customer instrumentation
* Only approximate
* Not currently supported
* Gateway required for enforcement, but not necessarily for observation

Provide a short plain-English explanation and the recommended least-invasive method.

The logic must reflect these principles:

* Provider billing APIs provide billing truth but limited business context.
* Project/workspace/key separation can produce coarse attribution.
* Manual mapping can associate provider entities with departments or people.
* Telemetry can add application, engineer, repository, session, trace, agent, and workflow context.
* A gateway is not inherently required for rich attribution.
* A gateway becomes useful for mandatory capture, routing, policy, blocking, and inline budget enforcement.

## 3. Data Source Explorer

Create provider tabs or a provider selector for:

* Anthropic
* OpenAI
* Google Cloud
* AWS Bedrock

Mark Bedrock clearly as not currently implemented.

For each provider, show:

* Current Camaze support level
* Required credential type
* Warning when an Admin API key is required
* Endpoints currently called
* Time granularity
* Expected reporting delay
* Pagination method
* Backfill behavior
* Incremental synchronization behavior
* Monetary-cost source
* Whether values represent billing truth, allocation, calculation, or estimation
* Native attribution dimensions
* Current Camaze limitations
* Relevant implementation files

Use the repository findings, including:

### Anthropic

* Admin API key required
* Cost report
* Messages usage report
* API-key listing
* Workspace listing
* Daily billing ingestion
* Workspace and API-key dimensions
* API-key dollar attribution may involve allocation
* Current-day fallback may be estimated

### OpenAI

* Admin API key required
* Organization Costs API
* Projects API
* Daily billing buckets
* Current Camaze attribution is primarily project-level
* API-key attribution was removed from the existing implementation
* No native workflow/session/repository information in the current ingestion

### Google Cloud

* Service-account JSON, billing project, and BigQuery billing export
* Daily billing aggregation
* Project and SKU/model-derived dimensions
* AI-versus-non-AI classification contains heuristic behavior
* No workflow or individual-user identity in the current implementation

### AWS Bedrock

Show two separate conceptual data sources:

* Billing truth through AWS billing exports/CUR
* Invocation detail through model invocation logging/telemetry

Clearly label the entire Bedrock integration as proposed rather than implemented.

## 4. Raw Response Laboratory

For each implemented provider, include sanitized representative raw responses derived from:

* Provider parser code
* Existing tests
* Existing fixtures
* Verified provider schemas

Present three toggles:

1. Raw provider response
2. Camaze-normalized representation
3. Fields Camaze actually retains

Provide:

* Syntax highlighting implemented locally
* Copy button
* Expand/collapse
* Field annotations
* A toggle to highlight attribution-relevant fields
* A toggle to highlight fields discarded by the current pipeline

Never use real keys, organization identifiers, emails, or billing data.

If the repository does not contain enough evidence for a field, omit it or mark it as an illustrative proposed field.

## 5. Billing versus telemetry versus gateway

Create an interactive comparison covering:

| Method                     | Role                                                     |
| -------------------------- | -------------------------------------------------------- |
| Provider billing/admin API | Financial truth and coarse provider dimensions           |
| Native tool telemetry      | Developer, session, tool, and workflow context           |
| Customer-side SDK          | Application-defined business dimensions                  |
| Gateway                    | Mandatory interception, routing, policy, and enforcement |

Compare:

* Attribution detail
* Reporting speed
* Customer effort
* Security exposure
* Reliability impact
* Provider coverage
* Enforcement capability
* Camaze implementation status

Include a visual data-flow selector. When the user chooses a method, update the diagram and explanation.

The diagrams should show:

### Billing-only

```text
Customer → LLM provider
Provider billing API → Camaze
```

### Telemetry

```text
Customer → LLM provider
Customer tool/agent → telemetry → Camaze
Provider billing API → Camaze reconciliation
```

### Gateway

```text
Customer → Camaze gateway → LLM provider
Provider billing API → Camaze reconciliation
```

Use HTML/CSS/SVG rather than Mermaid so the diagrams render without dependencies.

## 6. Current and target architecture

Create two clearly labeled architecture views:

### Current Camaze

* Static HTML frontend
* Supabase authentication
* Vercel serverless functions
* Anthropic/OpenAI/Google provider modules
* Supabase cost storage
* Resend alerts
* Scheduled sync and reconciliation

### Potential future architecture

* Existing billing ingestion
* OTLP-compatible collector
* Ingestion credentials
* Normalized telemetry events
* Trace/session/workflow dimensions
* Billing-to-telemetry reconciliation
* Optional SDK
* Optional gateway at a later stage

The future view must not imply these components already exist.

Allow users to switch between current and future views or overlay the differences.

## 7. Terminology guide

Create a searchable glossary for:

* Billing data
* Usage data
* Billing truth
* Estimated cost
* Allocated cost
* Provider project
* Anthropic workspace
* API key
* Service account
* Department
* Team
* Engineer
* Application/service
* Agent
* Session
* Trace
* Span
* Workflow
* Telemetry
* OpenTelemetry
* OTLP
* SDK instrumentation
* Gateway
* Reconciliation
* Attribution
* Attribution confidence
* Cost center
* Fixed cost
* Run-rate forecast
* Anomaly
* Spike alert

Each definition should include:

* A plain-English definition
* A concrete Camaze example
* Commonly confused terms
* Whether Camaze currently supports the concept

## 8. Attribution confidence model

Explain and visualize these confidence categories:

1. Provider-billed
2. Provider-reported
3. Reconciled
4. Allocated
5. Customer-mapped
6. Customer-supplied through telemetry
7. Camaze-estimated
8. Inferred
9. Unavailable

Do not reduce confidence to a single misleading percentage.

Show which current Camaze values belong to each category.

## 9. Current product claim audit

Include an internal claim-audit section for:

* Real-time spend
* Spend by provider
* Spend by model
* Spend by department
* Spend by team
* Spend by engineer
* Spend by workflow
* Forecasting
* Spike/anomaly detection
* Alerts
* Budgets
* Optimization recommendations
* AWS Bedrock support
* Multi-provider support

For each claim, display:

* Current support
* Required setup
* Important qualification
* Evidence from the codebase
* Accurate wording
* What would need to be built to support the strongest version of the claim

This section should be visibly marked **Internal—Not Marketing Copy**.

## 10. Roadmap view

Provide a compact, dependency-aware roadmap:

### Foundation

* Complete database migrations and RLS policies
* Expand tests
* Improve sync-status visibility
* Improve credential health and error handling

### Attribution

* First-class ingestion tokens
* Telemetry event schema
* OTLP-compatible HTTP collector
* Claude Code telemetry
* Codex telemetry
* Generic SDK/instrumentation
* Billing-to-telemetry reconciliation

### Later capabilities

* Rich workflow and repository attribution
* Optimization recommendations
* Optional gateway
* Inline policy and budget enforcement

Every item must show:

* Current status
* Why it matters
* Approximate complexity
* Dependencies
* Which product claim it enables

## 11. Data provenance

Every meaningful claim in the tool should contain a compact source reference such as:

* `providers/anthropic.js`
* `providers/openai.js`
* `providers/google.js`
* `lib/costs.js`
* `lib/costSync.js`
* `lib/org.js`
* `lib/reconcile.js`
* `lib/alerts.js`
* Relevant API route
* Relevant test
* Official provider documentation, when externally verified

Implement a reusable source-reference component. Internal file references should be visually distinct from external documentation links.

Do not create fake line numbers. Use file paths and relevant symbol names where practical.

## Interaction and usability requirements

Implement:

* Persistent section navigation
* Global search
* Provider filters
* Status filters
* Keyboard-accessible controls
* Shareable URL hashes for major sections
* Collapsible technical details
* Copyable code samples
* Useful empty states
* Responsive behavior
* Print-friendly styling
* “Reset filters” control
* Current-versus-future status legend

Persist non-sensitive UI preferences such as the selected provider or display mode in `localStorage`.

## Accuracy requirements

The following must be unambiguous throughout the tool:

* Camaze does not currently support workflows.
* Camaze does not currently ingest telemetry.
* Camaze does not currently include a gateway.
* Current engineer attribution is manual ownership mapping, not request-level identity.
* Current team attribution is effectively department mapping.
* Current spend is refreshed frequently, but provider billing data itself is generally daily or delayed; “15-minute synchronization” is not the same as true real-time spend.
* Anthropic and OpenAI billing integrations require administrative credentials.
* AWS Bedrock is not currently implemented.
* The current forecast is a simple run-rate forecast.
* Current spike detection is rules-based and should not be described as a general anomaly-detection engine.

## Validation

After implementation:

1. Validate that every structured-data object renders.
2. Check that filters and search work together.
3. Verify all raw examples remain sanitized.
4. Confirm no secrets or environment values were included.
5. Verify the tool works without network access.
6. Verify it can open locally without a build step.
7. Test at desktop, tablet, and mobile widths.
8. Run existing repository tests.
9. Add a lightweight validation test for `data.js` if appropriate.
10. Review the final page visually and correct overflow, spacing, contrast, and hierarchy problems.

## Final response

Return:

* A concise description of what you built
* Files created or changed
* How to open the tool
* Validation performed
* Any information that could not be verified
* Any decisions where the codebase contradicted the earlier research report

Do not implement telemetry, a gateway, new provider ingestion, or marketing-site changes as part of this task.
