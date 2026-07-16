# Changelog

## Unreleased

## 0.1.0 - 2026-07-16

First tagged release: a provider-neutral API gateway and router for OpenClaw services — TypeScript Worker data plane, Durable Object budget and usage ledgers, policy-driven access control with Cloudflare Access/GitHub identity, a management console, and a Docker self-hosting profile.

### Routing and data plane

- Replace the Rust/Wasm data plane and provider compiler with a modular TypeScript Worker while preserving Durable Object storage and public API contracts.
- Add policy-configurable priority, round-robin, least-used, quota-aware, and weighted grant routing with optional identity/session stickiness, per-provider eligibility, stale-state gates, and failover controls; thanks @Avg8888 for the proposal in #59.
- Add policy- and tenant-scoped same-provider grant pools with deterministic priority selection, provider-reported quota and auth-state tracking, console cooldowns, and one safe same-provider retry after 401, 403, or 429 responses.
- Normalize pre-stream upstream failures on OpenAI-compatible streaming routes to real HTTP 4xx/5xx JSON errors while keeping SSE error events after stream commitment.
- Resolve native path models for pricing and omit unpriced catalog models for budgeted proxy keys without fixed request pricing.
- Add canonical request, W3C trace, and session correlation across OpenAI-compatible responses, CORS, metadata-only usage/status events, bounded error logs, and session-stable grant selection.
- Make accounting finalization independently retryable, shard usage ledgers by tenant and policy, and collapse provider-readiness checks into one authority lookup.
- Merge overlapping model and manifest routes into one catalog entry per provider.

### Access, quotas, and credentials

- Gate the console behind Cloudflare Access with verified GitHub organization membership, and bind organization/team assignment rules automatically from the verified sign-in identity.
- Add opt-in per-maintainer budget quotas with principal-scoped ledgers, usage status, and admin breakdowns while preserving policy-wide defaults.
- Add self-service proxy-key creation, rotation, listing, and revocation for signed-in maintainers, constrained to caller-owned credentials and effective policies.
- Add default-on, policy-controlled 30-day request-content retention with visible user disclosure, per-user exemptions, and admin inspection.
- Add role-aware user and admin dashboards with service readiness, shared quota pools, and privacy-safe Access-session usage totals.

### Providers and models

- Add SigV4-signed Amazon Bedrock `InvokeModel` and `InvokeModelWithResponseStream` proxying with scoped credentials, model-native request bodies, and guarded header forwarding.
- Add current flagship model catalogs with dated list pricing — GPT-5.6 and GPT-5.5, Claude Opus 4.8, Gemini 3.5 Flash, GLM-5.2 — and refresh Google, Groq, xAI, Hugging Face, Together, DeepSeek, MiniMax, and Mistral defaults, including the Mistral embedding model.
- Add an on-demand `clawrouter/fusion` chat model with parallel local or hosted advisers, a policy-native final synthesizer, OpenAI-compatible Ollama/LM Studio routing, per-policy readiness preflight, and grouped usage lineage with aggregate cost and latency.

### Console

- Redesign the console with the Patchboard visual system: copper-on-graphite dark and blueprint-paper light themes, bundled variable fonts, a full-bleed racked frame, a persistent theme toggle, and higher-contrast status, focus, and selection states.
- Rebuild the Playground as a multi-turn chat with a provider-first model picker, per-turn request/response inspection, model-alias resolution, and route-specific service requests.
- Add accessible 30-day request and provider analytics to Dashboard and Usage, 30-second auto-refresh that never overwrites unsaved admin edits, and proxied Gravatar thumbnails that expose no email hashes or user network metadata.
- Add desktop and mobile visual regression, automated WCAG AA checks, visible-keyboard-focus proof, and restrictive browser security headers.

### Deployment and self-hosting

- Add a supported Docker self-hosting profile with local workerd persistence, admin API bootstrap, end-to-end smoke coverage, and no Cloudflare account requirement.
- Add a locked Cloudflare FakeCo staging profile and deploy workflow with fail-closed first deploys, environment-scoped credentials, service-token automation identity, and a confirmation-gated teardown that retains KV, R2, and zone state.
- Document first-party OpenClaw setup, credential-scoped dynamic model discovery, supported transports, multi-provider smoke testing, and quota reporting on a standalone integration page.

### Hardening and fixes

- Validate and canonicalize every admin control-plane payload before persistence: proxy credentials, provider connections, access users, policy grants and bindings, policy shapes, and assignment rules.
- Reject non-object proxy request bodies, malformed admin mutation roots, ungranted or empty upstream credential bundles, and malformed provider request paths before routing or budget reservation.
- Honor manifest-declared optional provider bindings in readiness, preserve stored multi-field credential bundles when editing grant metadata, and accept bearer authentication schemes case-insensitively.
- Fix the Anthropic token-count live smoke, Mistral embedding model selection, stale Playground bodies and path values on provider switches, stale provider IDs blocking policy edits, obsolete OpenAI reasoning-model token limits, and repeated content-retention provisioning.
