# Camaze Capability Lab

Internal static reference tool for Camaze capabilities, provider data sources, attribution limits, raw response shapes, and claim boundaries.

Open `docs/capability-lab/index.html` directly in a browser. It has no build step, no external dependencies, and no runtime network fetches.

Included now:

- Current-state summary and status legend
- Provider data source explorer for Anthropic, OpenAI, Google Cloud, and proposed Bedrock
- Attribution dimension table and detail drawer
- “Can Camaze Attribute This?” simulator
- Sanitized raw response examples with raw / normalized / retained views
- Billing versus telemetry versus gateway comparison
- Current/future architecture view
- Terminology guide covering the seed prompt's core vocabulary
- Attribution confidence model
- Internal claim-audit section for the core product claims
- Dependency-aware roadmap

Still intentionally light:

- The simulator uses compact hand-coded rules rather than an exhaustive rules engine.
- The architecture view uses static HTML cards rather than a full SVG diagram.
- The claim audit covers the core product claims from the seed, but it is still a compact internal audit rather than a full evidence dossier.
