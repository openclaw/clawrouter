# Changelog

## Unreleased

- Keep failed console refreshes visible after successful edits, label stale usage with its snapshot time, and show unavailable spend and balances as unknown.

- Restrict personal usage audit events to the authenticated principal, or unattributed events for the authenticated service key, while preserving shared policy totals and administrator audit access.

- Deny proxy requests and subsequent WebSocket turns for explicitly disabled key owners, and show their credentials as owner-disabled without changing unowned service keys or retained policy bindings.
- Add collision-safe proxy-key creation and active-key-only rotation. Serialize credential authorization, current-policy checks, and revocation in the authority so concurrent writes cannot restore an old secret or owner; preserve existing PUT and CLI upserts.

- Preserve local administrator roles during user, policy-assignment, and automatic-assignment edits, including profile saves that race with an explicit role change.

- Publish a revision-bound provider snapshot from CI so code-only contributors can regenerate the catalog without a local dependency install.

- Match catalog models to their declared endpoints and reject incompatible native selections. Route opaque model IDs through explicit endpoint passthrough contracts without borrowing the first model's capabilities or pricing, while preserving the local provider's zero API charge.

- Validate every provider manifest against its canonical JSON Schema before compilation, including ordinary pricing cards, safe integer rates, calendar dates, and unknown fields; retain semantic route and pricing checks.
- Account for Gemini native thinking and cached tokens, honor native output and candidate limits, and reserve the full input bound for cached content and media references.

- Prevent duplicate playground requests, cancel pending requests when starting a new chat, and preserve new drafts when earlier replies arrive.
- Allow OpenRouter API-key-only setup without a site URL; omit unset optional attribution headers consistently in readiness, requests, and grant maintenance while keeping required templates strict.
- Keep upstream grant lifecycle changes authoritative in their credential owner. Stale requests cannot undo disablement or revocation; secretless revocation tombstones require fresh credentials to reconnect, and grant metadata and pool updates are serialized with owner mutations. Publish each materialization's final state once to respect KV write limits.
- Route grant CLI imports and revocations through the authenticated admin API, including explicit loopback `--local` targets. Preserve whole-grant replacement, clear omitted old credentials, and migrate legacy KV disablement or revocation before credential-owner maintenance can use secrets.

- Match Cloudflare Access applications by exact destination instead of display name, reject ambiguous or name-only collisions before writes, and inspect all application and policy pages during provisioning.

- Preserve dispatched budget charges through reservation expiry and delayed recovery, release abandoned pre-dispatch work to zero, and require confirmed idempotent settlement receipts before acknowledging retries.
- Retain qualified estimates or fixed tariffs when dispatched HTTP requests fail before response headers, while keeping pre-dispatch failures at zero and preserving error and cancellation outcomes.
- Isolate policy, principal, and provider budget charges when their identifiers share a ledger address, preserving existing balances and ambiguous legacy debt without resetting budgets or orphaning settlement receipts.
- Apply concrete Chat model eligibility to Fusion discovery, including selected-policy pricing, provider limits, and grant availability, while preserving fail-open advisers.
- Reject hosted web search before dispatch under measured budgets without a fixed policy tariff; keep unmetered forwarding and report its price as unavailable instead of token-only spend.
- Record failed streaming response and delivery outcomes independently from HTTP status and billed usage, with bounded SSE inspection that retains late terminal facts on long streams.
- Settle HTTP accounting on ingress cancellation through the Worker request signal, including external socket disconnects, without losing already reported terminal usage.

- Recover rejected usage-queue publication through the existing policy usage ledger, retaining event IDs to deduplicate redelivery without masking budget-settlement failures.

- Export authorized native Codex model catalogs while preserving official agent metadata, add sourced Sol/Terra/Luna routes and tier prices, and document API-key and desktop hybrid setup.

- Bridge qualified native Responses WebSockets with per-create authorization, pinned grants, bounded queues, retention, and shared budget settlement.

- Add Azure OpenAI and OpenRouter native HTTP/SSE Responses routes. Share discovery and runtime grant endpoint eligibility, honor provider budgets, and preserve native upstream model namespaces.

- Account for OpenAI Standard, Fast/priority, and supported Flex tiers using dated per-model prices, conservative admission, and actual served-tier settlement. Preserve unmetered forwarding for undeclared tiers, show unavailable prices in usage totals, retain estimates when metered usage is incomplete, and refresh the GPT-5.6 Sol alias prices.
- Add GPT-6 Astra to the OpenAI catalog with its reasoning efforts, standard token and cache-write pricing, long-context rates, and Chat Completions token-limit mapping.

- Select smoke-test models from the chosen endpoint's declared capabilities, preserving native model names and configured Azure deployments instead of stale or synthetic defaults.

## 0.4.0 - 2026-09-22

**Highlights:** Lanseq joins the provider catalog, with more reliable Fusion accounting, safer route parsing, and corrected Bedrock request signing.

### Changes

- Add Lanseq's Qwen3.8-27B INT4 model with OpenAI-compatible chat, SSE streaming, and dated token pricing; thanks @CHYYX for #153.
- Cancel discarded Fusion adviser responses, including late arrivals after a deadline, so failed calls release budget reservations and deliver their usage events without delaying the synthesizer.
- Contain rejected Fusion adviser invocations and body reads when their deadline has already elapsed, avoiding unhandled promise rejections while the synthesizer continues.
- Reject malformed percent-encoded proxy, native, admin, and pool-submission route identifiers with HTTP 400 instead of HTTP 500, without performing the requested mutation or upstream call.
- Correct Bedrock SigV4 query signing for mixed-case and percent-encoded parameters by sorting encoded names and values in byte order.
- Remove unsupported OpenAI subscription browser Connect and explain Platform API-key setup, direct Codex login, and the private facade's limits; thanks @imrane for the report in #141.
- Exclude repository documentation, review tooling, and tests from the self-host Docker image and build context.
- Refresh Worker/admin dependencies and pnpm, pin CI actions to reviewed releases, and remove stale install exceptions while preserving Node.js 24 and the 48-hour dependency release-age policy.

## 0.3.0 - 2026-09-11

### Highlights

Claude subscription pools add protected credential intake and quota-aware routing. The private Responses facade gains an isolated Worker entrypoint, explicit API transport, and bounded fallback that preserves conversation continuity.

### Changes

- Add Claude subscription pools with protected contributor tickets, durable credential ownership, quota-aware routing, configurable keep-warm requests, and access-only setup-token support; shared subscription pooling still requires separate Anthropic authorization; thanks @fuller-stack-dev for #122.
- Add Claude Fable 5.1 with current input, output, and cache pricing, and update the Claude subscription transport identity to the minimum compatible client version; thanks @fuller-stack-dev for #123 and #124.
- Add an isolated private Worker entrypoint and explicitly configured OpenAI API transport alongside the existing private subscription transport; deployment isolation, upstream entitlement, and native-client compatibility remain provisioning requirements.
- Add opt-in, single-attempt private fallback for explicit availability failures while pinning continuation state to its original target, including mixed-case and singleton-array turn-state headers in JSON and SSE responses.
- Increase the private request-body limit from 1 MiB to the shared 8 MiB JSON limit while keeping request validation bounded.
- Recheck private workload revocation after uploads and binding reads, and prevent case-variant upstream identities from leaking through private responses.
- Preserve administrative user changes during automatic assignment reconciliation, and keep canonical authority records authoritative during legacy migration races.
- Preserve binary proxy response backpressure and consolidate response inspection, delivery, usage aggregation, and reservation-owned settlement without changing public contracts.
- Add content-free server-side predicates and exact consumed-byte counts for authenticated private requests rejected locally with HTTP 400.
- Report the application version in health and service discovery responses so deployments can verify the serving release.
- Refresh Worker and admin dependencies and pnpm, including patched local Worker image codecs, while preserving Node.js 24 support and the 48-hour dependency release-age policy.

## 0.2.2 - 2026-08-31

- Bound stalled session avatar, Cloudflare Access, and local-console sign-in requests with the existing fetch timeouts; thanks @SebTardif for #121.

## 0.2.1 - 2026-08-28

### Highlights

Anthropic budget settlement now accounts for cached tokens correctly and releases token-priced reservations for refusals that produce no output.

### Changes

- Correct Anthropic cache-token costs and budget settlement, preserve cumulative streaming usage, and retain reservations for incomplete Anthropic and OpenAI streams.
- Release token-priced reservations for Anthropic refusals before any output while preserving reported usage.
- Add Claude Fable 5, Opus 5, and Sonnet 5 with input, output, and cache pricing; document Fable 5's mandatory upstream retention without changing the Anthropic default model.
- Add an opt-in private Responses alias facade with verified owner or isolated opaque-workload authentication, broker-only OAuth, explicit reasoning capabilities, and bounded native Lite protocol and model containment; it has no shared catalog, grant, retention, or billing integration, subscription output limits remain unenforced, and full client and isolation proof remain deployment prerequisites.
- Prevent control-plane runtime details from reaching client errors while preserving explicit validation failures.
- Validate deployed Access redirects from parsed URL origins and paths.
- Refresh Worker and admin dependencies, pnpm, and GitHub Actions while preserving the dependency release-age policy.
- Refresh the bundled autoreview skill from its canonical source and clarify synthetic detector fixtures.

## 0.2.0 - 2026-08-16

- Add opt-in self-hosted console sessions with trusted TLS reverse-proxy origin checks and race-free sign-in throttling; thanks @b3nw for the contribution in #106.
- Add tenant-global monthly provider budgets with preflight enforcement, dual-ledger settlement, retry-safe accounting, and console spend controls.
- Fix console pages loading scrolled past the header; view changes now reset scroll and the Access tab strip scrolls only itself.

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
