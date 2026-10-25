# Changelog

## Unreleased

- Accept pnpm's forwarded argument separator in the documented health-report and budget-mode script invocations.
- Index usage snapshot attribution by normalized principal and credential, with bounded resumable backfill and correct historical results throughout migration; avoid repeated JSON parsing once backfill finishes.
- Overlap the credential-owner round trip with a cold admission: on a hot-cache miss the isolate starts loading the grant it last selected for that key (same version only, never for a mismatched secret) while admission runs, so a miss costs roughly the slower call instead of both. `Server-Timing` adds `cr-credential` with the credential cache state and owner wait.
- Make the production deploy train tolerate Cloudflare's read-after-upload lag: re-read the version history while the candidate is absent and retry a 404 from the candidate's version endpoint, each for up to 15 s; a different newer upload or any other error still stops the train.
- Reuse committed same-socket continuation ownership and pricing witnesses to remove the warm chained WebSocket authority round trip, with bounded witnesses and authoritative fallback.
- Forward non-terminal WebSocket frames while continuation bindings commit; hold terminal delivery and same-lane dispatch until publication finishes.

- Add `pnpm cf:health-report` for hourly Worker outcomes per deployed version (client disconnects, exceptions, CPU/memory limits, load shedding), marking version changes and flagging disconnect or failure spikes.
- Add `pnpm cf:budget-mode` to preview and switch existing policies between soft and reserve budgets, writing back every other field unchanged. Repair legacy routing projections automatically: a proxy-key request that falls back to the legacy read-and-select path asks the grant's owner to republish its projection (at most once per grant per 10 minutes per isolate) so later requests use the local hot path.
- Coalesce per-grant quota feedback with selection counters into one background flush per 250 ms window, cutting global-authority writes under load from one per request to a few per grant (written per response when the hot cache is disabled). Reuse a proxy key's catalog and model-list inventory within the hot-cache bounds, and bound background work so a hung backend call cannot keep extending later requests.
- Authenticate each Responses WebSocket create before reporting model or route selection errors, preserving credential revocation and expiry errors without extra successful-admission round trips.
- Keep Responses WebSocket settlement waits local to their lane so other lanes can admit and send while a prior turn settles.
- Select Responses WebSocket grants from the shared hot admission snapshot, preserving pinned owners and transport eligibility; warm soft creates need only continuation resolution, while reserve creates retain authoritative budget admission.

- Combine budget reservation and dispatch marking for ordinary HTTP requests and Responses WebSocket turns without required retention, saving a ledger round trip; older ledgers retain two-step dispatch, and unsent crash outcomes conservatively retain reservations.
- Honor soft budgets on Responses WebSocket turns with local pre-dispatch denials, parallel status checks and observed charges; exhausted scopes deny the next turn without aborting active lanes.
- Admit the next same-lane Responses WebSocket turn after terminal publication while the previous turn settles; gate upstream dispatch on successful settlement and retain conservative active limits and exactly-once accounting.
- Reduce Responses WebSocket turn latency by overlapping pinned continuation and grant preparation with budget reservation; reserve hard-budget legs concurrently with ordered errors and full rollback, and return a continuation restart error for cross-grant turns.
- Serve warm proxy-key HTTP inference with zero foreground backend calls before the upstream fetch: admission, grant selection and materialized credentials come from isolate-local caches (fresh 10 s, stale-while-revalidate to a 60 s max age), selection counters and quota feedback are recorded in the background, and an upstream 401/403 evicts the cached credential. Revocation, policy, owner and pool changes reach every isolate within the max age (immediately in the isolate that served the mutation); set `CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS=0` to restore per-request authority checks. `Server-Timing` adds `cr-cache;desc=hit|stale|miss|off`.
- Write retained request content to R2 in the background after dispatch; a failed archive write is logged and no longer fails the request with `503 content_retention_unavailable` (background Responses jobs and Claude bodies above 8 MiB keep the fail-closed write).
- Soft budgets deny a scope observed exhausted in the last 10 s before dispatch, without a ledger round trip; concurrent requests can overspend a soft cap by in-flight work. New policies created through the admin API or console default to `budgetMode: "soft"`; stored policies keep their mode, and an omitted mode still means reserve.
- Report caller-owned request, token, and spend totals as `usage.personal` on personal usage reads and a per-principal breakdown as `usage.principals` on admin usage, alongside the unchanged shared policy totals. Show both in the console.

## 0.5.0 - 2026-10-22

- Reject redirected Responses retrieve/cancel controls with a nonbillable 502 and prevent grant-owner transport replay; preserve pending-generation accounting and report only the numeric HTTP status for OAuth redirects.
- Add grant-scoped OpenAI/Anthropic native and manifest model list/retrieve with policy-filtered metadata, bounded same-grant pagination and zero router settlement. Keep the aggregate inference catalog separate, require stored API-key grants, and never let metadata permission/rate-limit responses cool shared inference grants.

- Add Claude Sonnet 5.5 and Haiku 5.5 model cards with native endpoint facts, cache pricing, and Haiku's full-request long-context rates above 100,000 input tokens.

- Accept Claude Messages/count_tokens bodies up to 32 MB (32,000,000 bytes), preserving the existing JSON parser through 8 MiB and applying bounded structural parsing only above it. Authenticate before expanded parsing; admit at most two expanded requests per isolate through response completion, with nonbillable `503 overloaded_error` and `Retry-After` for excess requests. Stream large upstream/R2 bodies with known lengths, preserve image/PDF budget bounds, and disclose full-document retention when enabled.

- Settle Claude server web search from authoritative JSON/SSE usage at $0.01 per search plus tokens on soft-budget and unmetered keys; web fetch costs tokens only. Hard-budget keys still need an explicit fixed policy request price because `max_uses` does not bound cumulative server-loop token costs. Preserve OpenAI hosted-search accounting and report missing or invalid search usage as incomplete.
- Preserve native OpenAI/Claude error envelopes and HTTP-200 SSE bytes, while first-event pre-output errors remain nonbillable. Preserve upstream request IDs and move router correlation to `x-clawrouter-request-id`; expose native IDs/rate limits via CORS and keep router error codes in a separate header. Strip pooled upstream organization/project/workspace response identifiers. Native expired-key errors omit management-only expiry fields, which remain on `/v1/key/inspect`.

- Add free OpenAI omni moderation through unified, native and manifest routes with API-key-only grants and normal auth/policy/quota enforcement. Policies allowing OpenAI without a model allowlist also allow moderation; these zero-cost requests consume the selected account's rate limits but are not count-limited by a positive monetary budget. Use explicit model allowlists to exclude them. Reserve the free moderation request format for OpenAI in the manifest compiler.

- Preserve repeated caller query parameters and unified/Fusion create queries without binding Responses ownership to incidental query data. Query-bearing creates support later continuation/retrieve/cancel without repeating their query; credential and configured-route changes still reject. Reject collisions with credential/operator upstream query keys. Previously created native owners containing caller query require one full-input restart after deployment.
- Forward OpenAI `X-Client-Request-Id` across supported native operations, including controls, multipart and WebSockets, without changing ownership. Reject caller-selected Anthropic workspace and user-profile headers with native 403 and zero-charge audit receipts until explicit operator bindings exist; profiles can carry trust grants and abuse attribution. Keep caller `Idempotency-Key` blocked without owner-bound replay authority.

- Refuse upstream HTTP redirects on initial and alternate-grant proxy requests: cancel the response body and return a nonbillable `502 provider_unavailable` without `Location`, rather than replaying credentials or request content at a redirect-selected destination.
- Bound alternate-grant preparation by the existing HTTP deadline and observed caller cancellation. Interrupted selection returns a nonbillable `502 provider_unavailable`; late admission cannot dispatch, while ordinary selection failure preserves the original provider rejection and `Retry-After`.

- Account for Anthropic fast mode (2×) and US inference (1.1×), including cache categories and JSON/SSE response usage. Omitted geography on supported models reserves 10% above global rates; null/unavailable usage settles at the admitted rate rather than failing or recording zero. Preserve native omitted/auto service-tier admission; unknown response tariffs fail with `pricing_required` under hard budgets (including late SSE errors) and retain the reservation without inventing Priority prices.

- Return HTTP 429 with `Retry-After` (exposed to browser clients) from the earliest grant recovery when a configured pool is only rate-limit cooling or awaiting published quota resets; failed-credential cooldowns and other unavailable pools keep HTTP 503 and the same error body.

- Reserve Claude base64 PNG/JPEG/GIF/WebP images in user content or user tool results at their documented visual-token bound from strictly parsed header dimensions instead of the full input window; image-shaped objects elsewhere, undocumented block keys, ambiguous PNG/JPEG headers and other media keep the full bound, and settlement still uses reported usage.

- Add OpenAI Decisions for GPT-6 Luna through unified, native, and manifest routes. Bill all input tokens, including cached and cache-written input, at the Decisions input rate with no output charge; preserve normal policy/budget enforcement and unchanged typed answers. Keep Chat/Responses prices and subscription transport limits unchanged.

- Add opt-in soft HTTP budgets with parallel fail-open checks, asynchronous idempotent charges and retry delivery, request timing headers, administrator-managed member caps, and GitHub team provisioning; keep reserve behavior as the default and preserve durable recovery ownership.

- Enforce independent ISO-week policy/principal budgets, show configured allowance windows, and provision members with $5,000/week by default; add a dry-run, field-preserving Ultrafast patch for existing team and Stable policies on GPT-6.1 Sol only.
- Repair authentication browser tests for expiry row labels and credential renewal, preserving auth-loss/no-replay assertions; refresh dashboard baselines for the intended member controls using platform-native rendering.

- Add OpenAI GPT-6.1 Sol with versioned Standard, Fast/Priority, Flex, and Ultrafast prices, cache and long-context rates, reasoning controls, and Chat token-limit normalization.
- Expire new proxy keys by default, support renewal of expired enabled keys, and let administrators stamp legacy expiries.
- Enforce independent UTC daily policy/principal budgets across keys with multi-leg reservation rollback and daily status.
- Allow Default/Flex/Fast by default and deny Ultrafast/unknown OpenAI tiers even without budgets; add policy/model/key tier controls and explicitly request Default for omitted/auto OpenAI API tiers so reservations use Default rates.
- Include policy steering hints in budget, tier and model refusals and session entitlements.
- Add console validity/performance choices, expiry warnings, renewal, daily allowances and administrator limit controls.
- Add dry-run-first `cf:members` provisioning for member policies and GitHub organization assignments.

- Verify the enabled prefix and 30-day expiration of the request-content lifecycle rule before reporting content provisioning success; reject conflicting existing rules without replacing them.

- Add verified, signed-tag GitHub source releases with a no-publish rehearsal; keep service deployment separately dispatched.

- Select scoped inference grants in the admission transaction using fenced, secretless authority projections; keep credential-owner materialization authoritative for revocation and retain legacy projection fallback.

- Collapse proxy-key admission into one canonical authority read and preserve atomic grant selection, migration fences and revocation checks; reuse compiled discovery metadata and instrument local authority RPC counts.

- Add a dependency-free load generator and synthetic local subscription-pool stress harness with latency, disconnect and accounting diagnostics; avoid deep-copying prompts and tools during top-level request-field renames.

- Add optional policy model allowlists across discovery and inference, Claude Opus 5.5 pricing, and opt-in policy-scoped pool status with shared subscription eligibility and seven-day usage.

- Make Claude subscription pools model-aware, retain scoped weekly quota and account facts, add an included-quota reserve and explicit paid environment fallback, and use the Claude Code 2.1.288 identity.

- Attribute usage to the final upstream grant and lane with additive ledger storage, a bounded admin daily-model aggregation API, and a Subscriptions page for account headroom, extra usage and traffic.

- Refresh the streaming parser, Cloudflare toolchain, admin icons and Vite, and pnpm within their current major versions; preserve Node.js 24 and the two-day dependency cooldown.

- Use one shared autoreview installation from `openclaw/agent-skills`; repository entrypoints now receive upstream fixes without copied helpers or test suites. Install once with `python3 scripts/install-skills autoreview` from agent-skills, then run `python3 "$HOME/.agents/skills/autoreview/scripts/autoreview"` from this repository. Refresh copy installations with `--mode copy --force`. Canonical autoreview disables Kimi until it supports private prompt transport; use Codex or another supported engine instead.

- Upload an optional Lanseq API key through the production deployment workflow using `CLAWROUTER_PROVIDER_LANSEQ_API_KEY`; leave unconfigured Lanseq unavailable without blocking other providers.

- Add background Responses creation, retrieval, streamed resumption and cancellation for declared OpenAI API routes. Keep controls on the original authorized credential route without new reservations; recheck queued caller authority before dispatch. Add bounded usage collection, durable financial recovery and authenticated operator inspection/replay. Preserve creation-only transport admission and request-bound accounting; select durable recovery only for the actual full-capable transport. Keep pending-response polling separate from financial retry backoff. Recovery locators remain distinct from authentication and settlement receipts; unresolved durable obligations require a recovery-aware runtime, not a pre-recovery rollback.

- Return the same full-input restart guidance for HTTP and WebSocket continuations when their recorded upstream account becomes unavailable during request preparation. Preserve unrelated authorization errors and zero-charge rejection accounting.

- Correct the architecture and API reference to describe retained-tool pricing enforcement for HTTP/SSE and WebSocket response-ID continuations, including fixed tariffs, unmetered requests, and rollout limits.

- Add an operator-run account-inventory read using credentials injected from the operator secret manager. Print versioned API-visible counts and digests without account identities, credentials or raw server errors; keep raw credentials out of GitHub Actions and the operation independent of account-readiness APIs.

- Require a reviewed `expected_sha` input for production and FakeCo deployment workflows. Reject a different dispatch source before checkout and verify actual `HEAD` before setup, installation, or preflight writes. Existing dispatch callers must supply the new field.

- Require durable parent tool-pricing evidence before measured Responses continuations. Retained hosted fees/work and unknown response-ID ancestry now return `pricing_required` before HTTP or WebSocket dispatch, including when a provider budget is enabled mid-chain. Preserve explicit fixed tariffs, unmetered requests, clean continuations, and routing errors; deploy the proof producer first without assuming old writers have drained.

- Validate usage ingestion receipts before acknowledging queue delivery or direct fallback. Reject unrelated or malformed success responses while preserving independent budget settlement and retention-expiry outcomes. Deploy the receipt producer before this consumer; prolonged version skew or rollback can send messages to the existing dead-letter queue.

- Add OpenAI GPT-6 Sol and Luna with published Standard, Fast/Priority, and Flex prices, cache and long-context rates, reasoning controls, and Chat token-limit normalization.

- Add OpenAI `tts-1` speech through unified, native, and manifest routes. Reserve UTF-8 input bytes at the published character rate, settle completed binary audio from Unicode code points as a request estimate, and retain conservative reservations for incomplete or unqualified delivery. Request retention can include speech text; generated audio is never archived.

- Read session usage from the policy's accounting tenant, including the default for policies without a tenant, so changing a user's tenant does not hide their charged requests.

- Update DeepSeek's dated peak-price cards, add canonical Flash and the documented vision alias, and retain exact upstream spellings and Pro. Label measured costs as published-rate upper bounds rather than invoice amounts; higher reservations can require a lower native `max_tokens` under unchanged budgets. Preserve fixed tariffs, missing-usage reservations, and prior ledger debt.

- Reserve DeepSeek's full declared output bound unless a valid native `max_tokens` lowers it, including Fusion readiness. Existing measured requests can newly return HTTP 402 under unchanged budgets; lower the native cap within the remaining balance. Preserve prior spend and outstanding reservations, and normalize inclusive Chat cache hits without double-counting input or discounting conflicting counters.

- Price Gemini native Standard, Flex, and Priority tiers using their published cards, preserve Flex's lower reservation, and settle Priority downgrades from consistent returned tier evidence.

- Keep retained-request inspection on the latest selection, cancel replaced or closed reads, and prevent late replies from reopening or overwriting the panel.
- Record known no-charge outcomes with an explicit usage basis across HTTP and WebSockets, while preserving fixed tariffs, retained estimates, unavailable prices, and all budget amounts.
- Qualify Codex catalog models with the issued key's exact native HTTP Responses offers, and enable provider-wide WebSockets only when every exported model has a matching eligible offer. Preserve the selected model and previous configuration when eligibility changes.

- Add explicit Codex Desktop root setup with coherent restoration of prior routing settings, preserved authentication and user preferences, and clear API-key Fast and environment-loading limits.

- Keep policy selection separate from existing binding edits, while new bindings still default to the selected policy.
- Preserve unsaved policy drafts across refreshes and completed saves, provide explicit discard, and keep missing selections visible. Keep explicit disablement and later edits intact, attach edits made during creation to the created policy for the next save, and wait for the initial policy list before enabling saves. Keep newer action outcomes visible when an older console refresh completes.
- Reconcile pending policy saves by field after reselection or discard, preserving explicit field, template, and provider edits without rolling back untouched disabled state or budget on the next save.
- Preserve policy field intent through reporting refreshes and lost save responses, including equal-value reads. Apply untouched server fields and retire only edits covered by the matching Save or Disable acknowledgment.
- Separate proxy-key creation from rotation in the console, serialize key actions across admin and personal screens, and keep one-time secrets, drafts, and action status owned by the operation's identity. Show uncertain outcomes and clipboard failures without replaying dismissed secrets, and preserve table action contrast in both themes.
- Assess Fusion sampling, reasoning, and tool intent from source-linked model/endpoint facts. Reject documented synthesizer conflicts before adviser spend, preserve caller fields, and omit unqualified adviser temperature and local reasoning defaults.
- Qualify Groq GPT-OSS 120B and Fireworks GPT-OSS 120B/GLM 5.2 Chat reasoning values, including Groq logprob field restrictions, before Fusion adviser spend. Preserve accepted effort aliases and native passthrough without inferring sampling, tool support, or prices.

- Preserve the initiating cause when Responses WebSockets close. Client disconnects record `client_error` without an invented HTTP status; unsent requests release reservations, while sent requests without final usage retain their estimate.

- Keep failed console refreshes visible after successful edits, label stale usage with its snapshot time, and show unavailable spend and balances as unknown.
- Show readable server error messages in console actions while preserving HTTP failure status and authentication codes; success-looking error text no longer appears connected. Keep Playground response bodies intact.
- Expose Catalog service-kind filters as a labeled button group with an explicit pressed choice, preserving keyboard operation, search, and result counts.
- Make Access resource tabs keyboard navigable with manual activation, associated panels, and visible focus at narrow widths. Preserve one-time secrets during focus-only movement and editor drafts across resource changes.
- Keep Fusion flow connectors between their model stages on narrow screens by rotating only the arrow glyphs.
- Open loaded policies from Catalog and Users only after accepting any unsaved-draft discard; keep informational access rows and unavailable policy references noninteractive.
- Open the Policies tab when adding a Catalog service to the current or New policy draft, preserving unsaved edits and avoiding duplicate service selections.

- Keep a grant's previous provider attachment until replacement credentials commit. Reserve active capacity as unselectable pending membership, allow paused imports into full active pools, retain inactive attachments, and recover partial publication through committed admission receipts and generation-checked owner reconciliation. Repeated revocation clears failed reconnect reservations. This storage upgrade requires forward recovery; environment-fallback activation and legacy attachment backfill remain separate work.
- Recover corrupt or oversized legacy upstream grants through explicit authenticated replacement or revocation. Preserve owner identity and pool generation fences, discard old secret bytes, and keep ordinary edits, OAuth and contribution imports strict. A missing KV value cannot erase retained legacy attachments during account creation.

- Reject incomplete prices for Sonar Pro mandatory request fees, hosted tools, remote MCP, multi-agent work, Claude compaction, and opaque prompt/cache configurations under measured budgets; cover Responses Lite and tool-search declarations, align catalog and Fusion preflight admission, preserve fixed tariffs and client tools, and mark unmetered costs unavailable.

- Correct Together GLM-5.2 input reservations to its published 1,048,575-token ceiling, preserving token rates and measured settlement while rejecting underfunded large requests before dispatch.
- Verify durable usage visibility after each successful deployment smoke request with the same caller key and a bounded read-only poll. Preserve provider health and report ingestion visibility failures without repeating paid requests.
- Allow the Cloudflare deploy workflow to select an OpenAI smoke model, including Astra, while an empty selection preserves the existing catalog default and single-request smoke.

- Restrict personal usage audit events to the authenticated principal, or unattributed events for the authenticated service key, while preserving shared policy totals and administrator audit access.
- Distinguish accounted cost estimates, fixed tariffs, unavailable prices, and budget reservations throughout the console; show zero amounts, budget scopes, and UTC monthly limits explicitly.
- Keep public HTTP Responses continuations on the original credential owner across token refresh. Register response and Codex turn identities before publication, preserve ordinary pool failover, and require a visible restart when ownership changes or expires.
- Preserve Codex turn state and response ownership across WebSocket reconnects and WebSocket-to-HTTP fallback. Register metadata before forwarding, retain per-create authorization, and bound pending publication without changing cancellation accounting.
- Record bounded retained-tool evidence on Responses identities across HTTP and WebSockets, reject conflicting producers, and preserve unknown history without changing pricing or budget admission. Strict inherited-tool enforcement remains a separate rollout after producer deployment.

- Preserve provider kill switches and budgets during concurrent connection edits, and show per-provider pending state in the console.

- Deny proxy requests and subsequent WebSocket turns for explicitly disabled key owners, and show their credentials as owner-disabled without changing unowned service keys or retained policy bindings.
- Clear protected console data and drafts when browser authentication expires or identity changes. Keep sign-in gated until the session is verified, preserve in-flight key ownership, and distinguish authentication loss from permission, CSRF, and reporting failures.
- Add collision-safe proxy-key creation and active-key-only rotation. Serialize credential authorization, current-policy checks, and revocation in the authority so concurrent writes cannot restore an old secret or owner; preserve existing PUT and CLI upserts.

- Preserve local administrator roles during user, policy-assignment, and automatic-assignment edits, including profile saves that race with an explicit role change.

- Scope client model/operation offers to actual credentials and ordered session policies, preserving the authenticated caller when no active policies remain, with principal/provider budget observations, explicit unavailable reasons, and separate HTTP playground versus key-only native/WebSocket access. Match Access policy selection to the existing default dispatch tenant and reuse canonical runtime pricing and grant checks. Preserve saved provider probe diagnostics independently of operation eligibility. Keep v1 native base URLs as route-location metadata; scoped offers, not those strings, describe caller eligibility.
- Emit a concrete HTTP Fusion catalog offer with the synthesizer's selected policy and generation, shared catalog types, and synthesis-first compound affordability while preserving fail-open advisers.
- Reassess Fusion's final request against the retained budget limits and settle its current estimate without changing the original reservation receipts or held amount.

- Publish a revision-bound provider snapshot from CI so code-only contributors can regenerate the catalog without a local dependency install.

- Match catalog models to their declared endpoints and reject incompatible native selections. Route opaque model IDs through explicit endpoint passthrough contracts without borrowing the first model's capabilities or pricing, while preserving the local provider's zero API charge.

- Validate every provider manifest against its canonical JSON Schema before compilation, including ordinary pricing cards, safe integer rates, calendar dates, and unknown fields; retain semantic route and pricing checks.
- Account for Gemini native thinking and cached tokens, honor native output and candidate limits, and reserve the full input bound for cached content and media references.

- Add a Codex CLI profile workflow to connect an issued key, verify catalog access, refresh official native metadata, and remove unchanged owned settings while preserving user configuration and credentials.

- Prevent duplicate playground requests, cancel pending requests when starting a new chat, and preserve new drafts when earlier replies arrive.
- Allow OpenRouter API-key-only setup without a site URL; omit unset optional attribution headers consistently in readiness, requests, and grant maintenance while keeping required templates strict.
- Keep upstream grant lifecycle changes authoritative in their credential owner. Stale requests cannot undo disablement or revocation; secretless revocation tombstones require fresh credentials to reconnect, and grant metadata and pool updates are serialized with owner mutations. Publish each materialization's final state once to respect KV write limits.
- Distinguish paused upstream grants from revoked credentials, allow paused grants to be revoked, and require fresh credentials to reconnect revoked grants in the demo.
- Show confirmed upstream account saves, revocations, credential refreshes, and quota results immediately. Keep later edits and selections intact, release write controls before metadata refresh, and prevent older reads from undoing the acknowledged result.
- Route grant CLI imports and revocations through the authenticated admin API, including explicit loopback `--local` targets. Preserve whole-grant replacement, clear omitted old credentials, and migrate legacy KV disablement or revocation before credential-owner maintenance can use secrets.
- Deny expired or invalid retained-content reads with a content-free, non-cacheable not-found response, independently of physical archive deletion.
- Sweep expired self-host archive objects after startup and on bounded periodic ticks, persist cleanup progress across restarts, and cap legacy archive retention by upload age without changing managed R2 lifecycle ownership.
- Keep standalone smoke readiness alive through stalled health requests and response bodies, cancel each expired attempt, and preserve existing self-host and deployed readiness limits.

- Match Cloudflare Access applications by exact destination instead of display name, reject ambiguous or name-only collisions before writes, and inspect all application and policy pages during provisioning.
- Fix production Cloudflare KV provisioning by using the same exact-title API creation as FakeCo, and require account credentials before changing resources.

- Preserve dispatched budget charges through reservation expiry and delayed recovery, release abandoned pre-dispatch work to zero, and require confirmed idempotent settlement receipts before acknowledging retries.
- Retain qualified estimates or fixed tariffs when dispatched HTTP requests fail before response headers, while keeping pre-dispatch failures at zero and preserving error and cancellation outcomes.
- Cancel discarded grant-rejection bodies before HTTP failover, and retain one conservative budget charge when an alternate request fails without response headers. Preserve the original rejection when no alternate can be selected.
- Isolate policy, principal, and provider budget charges when their identifiers share a ledger address, preserving existing balances and ambiguous legacy debt without resetting budgets or orphaning settlement receipts.
- Use the shared Access-aware admin transport for pool-ticket issuance, preserving protected ticket output while bounding admin responses and keeping raw response bodies out of error messages.
- Acknowledge completed key and grant mutations without reading unused success payloads, preserving successful CLI outcomes for large accepted grant metadata while keeping ticket and error reads bounded.

- Apply concrete Chat model eligibility to Fusion discovery, including selected-policy pricing, provider limits, and grant availability, while preserving fail-open advisers.
- Reject hosted web search before dispatch under measured budgets without a fixed policy tariff; keep unmetered forwarding and report its price as unavailable instead of token-only spend.
- Record failed streaming response and delivery outcomes independently from HTTP status and billed usage, with bounded SSE inspection that retains late terminal facts on long streams.
- Meter declared Responses JSON and SSE bodies with bounded scalar inspection, including usage after large output or inside a large terminal event, while preserving stream delivery, cancellation, and conservative charges when metadata cannot be verified.
- Settle HTTP accounting when the Worker runtime reports ingress cancellation, without losing already reported terminal usage. Document the unresolved idle-disconnect notification limit and its explicit strict diagnostic.
- Preserve the first HTTP cancellation or failure cause through response delivery without extending endpoint deadlines beyond response normalization. Keep accepted rejection statuses when error details cannot be read. Internal Fusion deadlines no longer appear as caller cancellations.

- Recover rejected usage-queue publication through the existing policy usage ledger, retaining event IDs to deduplicate redelivery without masking budget-settlement failures.
- Return explicit stored, duplicate, and retention-expired usage-ingest receipts, preserving the first retained event and its timestamp without hiding storage failures. Existing usage consumers remain status-based for producer-first rollout.

- Export authorized native Codex model catalogs while preserving official agent metadata, add sourced Sol/Terra/Luna routes and tier prices, and document API-key and desktop hybrid setup.

- Bridge qualified native Responses WebSockets with per-create authorization, pinned grants, bounded queues, retention, and shared budget settlement.

- Add Azure OpenAI and OpenRouter native HTTP/SSE Responses routes. Share discovery and runtime grant endpoint eligibility, honor provider budgets, and preserve native upstream model namespaces.

- Account for OpenAI Standard, Fast/priority, and supported Flex tiers using dated per-model prices, conservative admission, and actual served-tier settlement. Preserve unmetered forwarding for undeclared tiers, show unavailable prices in usage totals, retain estimates when metered usage is incomplete, and refresh the GPT-5.6 Sol alias prices.
- Add GPT-6 Astra to the OpenAI catalog with its reasoning efforts, standard token and cache-write pricing, long-context rates, and Chat Completions token-limit mapping.

- Select smoke-test models from the chosen endpoint's declared capabilities, preserving native model names and configured Azure deployments instead of stale or synthetic defaults.
- Build smoke requests from declared formats and capabilities, preserving renamed provider and endpoint support. Keep unresolved request templates visible without dispatching or claiming provider verification, and scope inline AWS/Cloudflare smoke overrides to their bundled providers.
- Accept declared Cloudflare AI Gateway universal array bodies through manifest and native routes, preserve upstream fallback order and request content, and omit per-entry transport credentials from retained content while enforcing existing budgets.

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
