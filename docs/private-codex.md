# Private alias inference facade

This opt-in, bounded Responses facade is for a **separately isolated, owner-only
OpenClaw Gateway or Codex runtime**. It is not per-user security for a shared
Gateway. Production Team must not receive these bindings or credentials. Shared
agents must have no access to the private ingress credential, process, workspace,
session namespace, or upstream subscription. Use a separate deployment and
administrative trust boundary; a deployment operator can change its code or
bindings and is necessarily trusted. Include owner-authenticated browser profiles
and remote-node/tool capabilities in that boundary: shared agents must not be able
to drive a browser carrying the owner's session or administer the private cell.

Nothing in this implementation provisions that isolation. Local synthetic tests
do not prove live subscription entitlement, client compatibility, owner-only
ingress, or OS/process isolation. In particular, `/responses` support does not
establish native Codex integration.

## Runtime configuration

Two separate, owner-controlled secret-store object bindings are required. Each
implements `get(): Promise<string>` returning one JSON document. These are not
ordinary string environment credentials, `POLICY_KV` records, manifest values,
generic grants, or admin configuration. No generic admin read/mutation endpoint
exposes or changes them. Never place the upstream document in source, fixtures,
deployment vars, reports, or client configuration. The manifest compiler and
admin bundle have no private model entry.

`PRIVATE_CODEX_POLICY` has this exact shape (unknown fields are rejected):

```json
{
  "version": 1,
  "enabled": true,
  "alias": { "id": "codex-latest", "name": "Codex (Latest)" },
  "auth": {
    "mode": "access",
    "issuer": "https://synthetic-owner.cloudflareaccess.com",
    "audience": "SYNTHETIC-PRIVATE-APPLICATION-AUDIENCE",
    "githubAccountId": 123456,
    "identityProviderId": "SYNTHETIC-APPROVED-GITHUB-IDP"
  }
}
```

`alias` may also contain `supportedReasoningEfforts`, using the existing client
catalog field name. When supplied, it must be a nonempty array of 1–7 unique,
case-sensitive values from `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
and `max`. Null, empty, duplicate, unknown or oversized lists fail closed.
The approved list is preserved in authenticated private `/models` and `/catalog`
model rows only; it is not added to inference requests or public discovery.
An id/name-only alias remains valid and omits this descriptor. The facade never
infers reasoning from the alias, provider or upstream identifier, and does not
assume every private model supports reasoning.

Source the configured capabilities from the actual entitled model's metadata
through trusted owner provisioning. Publish only its verified intersection with
the supported public effort enum; do not guess, invent or relabel an unsupported
upstream level. This is a capability descriptor, not entitlement or a native
JSON ModelInfo artifact. The parent must continue supplying full alias-only
native ModelInfo separately. The field does not advertise pricing, token limits,
context capacity or full context support; those contracts are unchanged.

The example contains synthetic identity values. Replace them through the parent's
approved provisioning flow. The issuer must be a lowercase HTTPS
`*.cloudflareaccess.com` origin without a path. Audience and identity-provider ID
are exact, case-sensitive, non-whitespace ASCII strings of 1–256 characters.
`githubAccountId` must be a positive safe integer (at most 9007199254740991).
Both GitHub account and approved IdP pins are required. The earlier unshipped
`subject`-only configuration is rejected; there is no fallback.

The facade first uses the existing RSA Access JWT verifier for signature,
audience, issuer and time validation and requires the exact configured issuer.
Only then does it request that exact assertion's identity from the pinned
issuer's `/cdn-cgi/access/get-identity`, using `Cookie: CF_Authorization=<assertion>`.
It never chooses a destination from unverified claims, follows redirects, or
forwards caller cookies. The lookup uses `cache: "no-store"`, has no application
cache, and has no stale-identity or management-API fallback. HTTP failure,
malformed/oversized data, unsupported encoding, timeout or cancellation denies
access with generic not-found before private upstream secret resolution.

The response must contain `idp.type: "github"`, the exact configured `idp.id`,
and a numeric positive safe-integer `id` matching `githubAccountId`. Its `email`
must match the verified JWT's email after trimming and lowercasing; both are
nonempty strings limited to 1024 characters. Email only correlates the lookup
with the assertion; it does not authorize. An unchanged email or Access subject
cannot authorize a different GitHub account. A changed email or subject can be
accepted when token/identity correlate and the GitHub account and IdP pins match.
Names, login handles, groups, admin roles, local sessions and caller identity
headers never substitute for those pins.

[Cloudflare documents Access `sub`](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
as unique to an email address within a Cloudflare account, not as an immutable
GitHub account identifier. The old subject-only path proved only its configured
Access subject; no email-transfer exploit is asserted. The replacement binds
authorization to the numeric GitHub identity and approved IdP reported for the
verified assertion. Synthetic signed-JWT tests prove the local enforcement, not
Cloudflare's real GitHub-specific response shape: the parent must prove that
shape using a real human assertion before enabling Access mode.

Policy and token validity are checked again after awaited lookup/binding work;
inference repeats verification and identity lookup after upload, then rechecks
policy and the fixed upstream binding before egress. Each lookup shares a
ten-second deadline with JWT verification and accepts at most 64 KiB of UTF-8
JSON. Cancellation propagates through fetch and body reads. The verifier's
existing clock tolerances remain (30 seconds for `nbf`, 300 for `iat`); expiration
must remain in the future. No token or identity body enters logs or discovery.

Disable the private policy to revoke subsequent requests. Generic user/admin
policy changes do not revoke this independent authority. A token-specific
Cloudflare lookup is not proof of an active GitHub browser session, an immediate
GitHub revocation check, or ongoing delegated human authority. Cloudflare's
identity/revocation propagation and the secret store's consistency remain
external limits. Requests already streaming are not continuously reauthorized
or terminated by later policy changes. Owner-only ingress and process/browser
isolation, real identity proof, and the other deployment gates remain required.

Alternatively, replace `auth` with exactly:

```json
{
  "mode": "workload",
  "credentialSha256": "LOWERCASE-SHA256-HEX-DIGEST"
}
```

The digest is exactly 64 lowercase hex characters. The separately provisioned
credential has the form `private-workload-` followed by 32–128 URL-safe ASCII
characters (`A–Z`, `a–z`, `0–9`, `_`, `-`). Provision at least 256 random bits;
do not derive it from a user/session or reuse any admin, proxy, or upstream secret.
Only its SHA-256 digest is stored in policy. Requests use the exact header
`Authorization: Bearer <private-workload-credential>`. This bearer authenticates
the dedicated workload, **not the human**, is transferable if stolen, and is not
delegated human authority. Owner-only ingress and OS/process isolation are
mandatory. There is no signature/TTL/attribution scheme claiming otherwise.

These are the only two supported authentication modes and are mutually exclusive.
Workload mode rejects Access JWT authentication; Access mode rejects Authorization.
Conflicting authentication headers are rejected even when their values are empty.
Alternate API-key headers, proxy auth, and Access service-token headers are
rejected. Cookies and caller identity headers
cannot authenticate. Configuration and authentication are read on each request,
and rechecked after the request upload immediately before egress.

OAuth credentials must stay **broker-only**. Neither native Codex nor OpenClaw,
their tools, nor other client processes may receive the upstream token, account
binding, or access to the broker's secret store, files or process memory. Giving
a tool-bearing client OAuth would let it bypass the facade and query the raw
upstream catalogue directly. Inference workloads receive only the independent
opaque workload credential, which cannot authenticate to the upstream provider. The facade
serves only alias-safe discovery; it offers no raw catalogue, OAuth, arbitrary
proxy or account-selection endpoint. Caller `ChatGPT-Account-ID` and custom
account headers are rejected in both modes. Only the broker constructs the
upstream account header from its fixed authenticated binding.

`PRIVATE_CODEX_UPSTREAM` has exactly these fields:

| Field | Contract |
| --- | --- |
| `version` | Number `1` |
| `target` | Runtime-only upstream binding; 8–128 ASCII letters/digits/`.`/`_`/`-`, beginning with a letter/digit |
| `accountId` | Exact subscription account; 8–128 ASCII letters/digits/`_`/`-` |
| `accessToken` | Separately held subscription access token; 16–8192 ASCII letters/digits/`.`/`_`/`~`/`-` |
| `expiresAt` | Integer Unix **milliseconds**, at least 30 seconds in the future |

The alias ID is 3–64 lowercase ASCII letters/digits/hyphens, beginning with a
letter. Its display name is 1–80 printable ASCII characters. Use the safe values
shown above. Neither may contain the target, account ID, or upstream token.
Both binding documents are limited to 16 KiB of text. Missing, disabled, malformed,
expired, inaccessible, or mid-request changed configuration fails closed.

The upstream binding is read **only after authentication**, including on private
discovery. The adapter sends exactly that account and token to the fixed
subscription Responses URL already declared by the OpenAI provider manifest.
No caller can change the provider, account, origin, or target. There are no
redirects, retries, alternate accounts, API-key fallbacks, generic grant lookups,
Fusion paths, or arbitrary-model/native routing inside this facade.

Automatic OAuth refresh is intentionally absent. The existing shared refresh
helper writes shared grant state and does not provide this boundary's required
revocation/rotation transaction. The parent must provide an owner-only lifecycle
that atomically replaces this private token/account/expiry document, or accept
fail-closed expiry. Token/account correspondence and subscription eligibility
still require trusted provisioning and upstream proof. No refresh tokens are
accepted here. Binding read freshness depends on the deployed secret store;
there is no extra application cache or promise of instantaneous revocation of
already transmitted requests/streams.

Broker token rotation does not require changing the independent client workload
credential or exposing the new token to clients. Changes during a request's
upload still fail closed. Binding expiry must reflect the real token lifetime;
provider expiry/revocation denials remain denials.

## Endpoints and client contract

| Method | Exact path | Result |
| --- | --- | --- |
| GET | `/private/v1/models` | One OpenAI-style model: safe ID, `display_name`, `llm.responses` capability |
| GET | `/private/v1/catalog` | Client catalog v1 with a private Responses provider; model `upstream` equals the alias because the catalog contract requires it |
| POST | `/private/v1/responses` | Bounded JSON or SSE Responses transport |

The catalog intentionally retains the existing V1 consumer shape:
`nativeBaseUrl: "/v1/native/private"`, route `path: "/v1/responses"`, and
`openaiCompatible: true`, with only `llm.responses` advertised. The native base
is a catalog schema field, not an enabled transport. Only the private unified
Responses endpoint executes; private and public native/proxy routes do not gain
access to this binding.

OpenClaw reads `supportedReasoningEfforts` from each catalog model row to enable
reasoning and construct its compatible effort mapping without depending on an
opaque alias's spelling. Configure this descriptor for a reasoning-capable model;
omitting it can change the consumer's request semantics, including whether its
Responses system prompt uses a developer role. The descriptor does not change
review requirements, provenance, sandbox settings or the private auth boundary.

Unauthorized callers receive the same generic 404 body and private no-store
headers as unknown private routes. No private alias appears in public discovery,
service indexes, provider snapshots, routes, or generic admin metadata. No CORS
or public correlation/header reflection is added to private responses.

Only the configured alias is accepted in the top-level `model`. `store: false`
is required, and background execution is rejected. The adapter rewrites `model`
only when constructing the upstream body. Input, tool schemas, instructions,
reasoning, encrypted content, and accepted client metadata are not rewritten.
Top-level request fields are limited to `model`, `input`, `instructions`, `stream`,
`store`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `text`,
`include`, `max_output_tokens`, `temperature`, `top_p`, `truncation`, `metadata`,
`previous_response_id`, `prompt_cache_key`, `prompt_cache_retention`,
`safety_identifier`, `service_tier`, `background` (absent or false),
`client_metadata`, `stream_options`, and `access_programs`.
Unknown top-level fields fail closed. Nested tool schemas/data and metadata are
opaque input, never routing configuration.

The fixed subscription adapter accepts optional `max_output_tokens` only as a
positive safe integer (1–9,007,199,254,740,991) for client compatibility. It omits
**only that top-level field** when building the upstream body, without mutating
the original request or nested data. The subscription backend does not support
this generation option. All other accepted fields, including `service_tier`,
review/approval metadata, attestation and genuine client facts, remain unchanged.
Requests without the field retain their existing semantics apart from the
alias and routing-hint translation. No client configuration knob is required.

After adapting an authenticated inference request that supplied a valid value,
the facade generates `x-clawrouter-ignored-parameters: max_output_tokens` on its
JSON/SSE response, including provider denials and transport failures. The header
contains only the field name, never the caller's value. It is absent for discovery,
unauthorized or locally invalid requests, and requests that did not supply the
option. Caller/upstream copies of that header are not trusted or reflected.
The disclosure remains subject to private identity containment; if it cannot be
emitted safely, the request fails without leaking the identity.

**This is not an enforced output limit or budget.** Subscription generation is
provider-controlled; using this endpoint cannot promise a caller token cap.
The existing byte, queue and time limits still apply, and private accounting
remains deliberately unmetered. Native subscription transports already omit
this option, but that does not justify stripping their broader legacy parameter
list here or claiming that a discarded limit was honored.

The additional body fields follow the inspected native Codex HTTP wire contract.
`client_metadata` is a bounded string map containing only `x-codex-installation-id`,
`session_id`, `thread_id`, `turn_id`, `parent_turn_id`, `root_turn_id`,
`x-codex-window-id`, `x-codex-parent-thread-id`, `x-openai-subagent`, and
`x-codex-turn-metadata`. The last field is a JSON object encoded as a string;
its sandbox, review, workspace and tool-inventory facts remain unchanged.
`stream_options` permits exactly `reasoning_summary_delivery: "sequential_cutoff"`
on streaming requests. `access_programs` permits exactly one `cyber` wire token
(1–64 lowercase letters/digits/underscores, starting with a letter). It is an
upstream access selection, not entitlement granted by this facade. These optional
fields may be absent or null. No program, review flag, attestation, or fallback is
fabricated. Unknown fields and malformed values are rejected.

Forwarded headers are limited to genuine caller `version`, `session-id`, `thread-id`,
`session_id`, `x-client-request-id`, `user-agent`, `originator`, `openai-beta`,
`x-openai-internal-codex-responses-lite`, `x-codex-beta-features`,
`x-codex-turn-state`, `x-codex-turn-metadata`, `x-codex-parent-thread-id`,
`x-codex-window-id`, `x-oai-attestation`, `x-openai-subagent`,
`x-openai-memgen-request`, `x-responsesapi-include-timing-metrics`, `traceparent`,
and `tracestate`. Lite negotiation and attestation are forwarded only when
present; OpenClaw must retain its truthful originator and user agent. Relaying
an attestation envelope neither verifies it nor changes the upstream's authority
to reject it. Caller identity/session facts do not participate in facade auth.

The separately supported `x-codex-routing-hint` must be exactly `model=<alias>`
or `model=<alias>;tier=<tier>`. Its optional tier must match body `service_tier`.
After authorization and the final config recheck, only its model is translated
to the runtime target at egress. No arbitrary model, provider, account or URL
selector passes. Unknown semantic Codex/review/approval/attestation headers still
fail closed. The opaque turn-state affinity token is relayed unchanged only
after bounded inspection of literal, JSON, percent-encoded and base64/JWT text
for sensitive values and unknown structured model selectors; it is never
rewritten into invalid signed/ciphertext state.

These contracts were checked against native `core/src/client.rs`,
`core/src/responses_metadata.rs`, and `codex-api/src/{common.rs,sse/responses.rs,
rate_limits.rs,safety_buffering.rs}`. Additional protocol requires source review.

Queries, encoded route spellings, trailing slashes, alternate methods,
compression, non-UTF-8 content, the legacy unary `/responses/compact` endpoint,
websocket, upload, usage, and every other endpoint are unsupported. Upstream redirects and errors do not trigger another
provider call. At ingress, enforce rejection of raw dot segments/backslashes
before URL normalization: the Worker cannot recover path spellings already
normalized by the HTTP runtime. Normalized routes never select an alternative
private endpoint/provider/target.

For the separately isolated OpenClaw consumer, the parent's base URL is
`https://PRIVATE-ORIGIN/private` (plugin appends `/v1`). For a Codex consumer it is
`https://PRIVATE-ORIGIN/private/v1`. The catalog alone does not prove that a consumer
honors its Responses-only capabilities, display name, `store: false`, or lack of usage.
The consumer needs its full, alias-safe native model metadata, including genuine
Lite, compaction, and safety requirements; a reduced facade discovery row is not
a substitute. Configured on-request/manual review with a workspace-write sandbox
is a valid distinct control mode when the selected model does not require
automatic review. Omitted optional auto-review fields are not a requirement to
invent or enable automatic review. This does not claim Guardian equivalence and
does not change trusted-endpoint checks for automatic review.
The native Codex CLI uses its built-in OpenAI provider with the broker workload
credential supplied as an API-key credential and full alias-only model metadata.
It does not receive OAuth or acquire a native ChatGPT account identity through
the facade. Genuine client metadata, originator, version, review and sandbox
facts are retained; OpenClaw must not impersonate Codex. This configured mode
does not claim automatic Guardian or subscription-auth/refresh parity. Native
Codex and OpenClaw compatibility still require the parent's private proof for
their respective request shapes and configured control modes. Upstream rejection
is not a reason to spoof identity or bypass restrictions.
Native remote compaction v2 is distinct from the unsupported unary endpoint:
it sends `compaction_trigger` input and consumes a completed compaction item on
the ordinary Responses stream. The default/manual v2 path in Codex
`0.150.0-alpha.13`, followed by a tool turn, has been live-verified in the isolated
workload-authenticated profile described above. Direct OpenClaw manual compaction
and its subsequent tool turn were also verified. This does not establish automatic
threshold behavior, full-context capacity, other client versions, or auxiliary
endpoint support. Required additional or safety protocol remains a deployment
blocker until implemented and verified; do not bypass it or disable requirements.

## Output, retention and limits

Response headers are generated locally: content type, private no-store,
`nosniff`, retention `off`, and accounting `private-unmetered`. Cookies, locations,
request IDs and unknown transport headers do not pass through. Known Codex quota
families, credit/promo/limit labels, and model catalog etags are stripped without
rejecting success; labels may name private models. `codex.rate_limits` SSE events
are also omitted because this facade does not expose quota reporting.
The source-defined optional timing observation is likewise stripped; accepting
that observation does not enable the unsupported WebSocket endpoint.
Discarded quota/timing observations may not carry response or safety envelopes,
or retained semantic headers. Those combinations fail closed rather than hiding
model identity, safety or attestation protocol. Ordinary observations, including
headers containing only discarded quota/transport data, remain discardable.

The exact `OpenAI-Model`/`x-openai-model` identity maps to the alias only when its
value equals the configured target or alias; a different model fails closed.
The same projection applies to top-level SSE `headers` and `response.headers`.
Safe `x-codex-turn-state` affinity and `x-reasoning-included` presence are
preserved. The known `x-codex-safety-buffering-enabled` flag is preserved,
including false; the faster-model header and structured `retry_model` may only
refer to the expected target/alias and are projected to the alias. Null retry
recommendations remain null. An unknown or different safety reroute fails,
rather than being relabeled as primary-model success. Moderation and verification
metadata are preserved, never manufactured. Unknown semantic safety/attestation
response headers still cause sanitized failure.

HTTP provider denials keep their 4xx status and use `private_upstream_error`,
without the provider's body. In particular, an upstream HTTP 400 is distinguishable
from a local 400 `invalid_request`; local request rejection is not evidence of
upstream incompatibility. Transport/server/protocol errors
return generic failure; late SSE failures emit a generic `error` event and cancel
upstream. Source-recognized policy/quota/context denial codes instead retain a
sanitized `response.failed` envelope and their exact allowlisted code so native
clients do not lose denial classification. Messages and arbitrary error details
never pass through. Refusal content and incomplete status remain intact when safe.

Reporting model projection belongs only to the JSON Response root `model` and
SSE event `response.model`. These reporting fields map to the alias even when
the backend reports a name different from the requested target. Native Codex's
`ResponsesStreamEvent::response_model()` reads only `response.headers` and event
`headers`; its explicit `process_sse_ignores_response_model_field_in_payload`
test confirms that body `response.model` does not produce a ServerModel event.
Reporting projection therefore does not authorize or conceal a model-header
reroute. The configured target remains the separate, immutable authority for
all model headers and typed safety selectors.

The shared JSON/SSE projection owner learns at most one additional reporting
name per response, before inspecting sibling data and before releasing any body
frame or accumulating logical-delta history. The name must be 1–128 printable
ASCII characters and not blank. It becomes another sensitive value alongside
the configured target, account ID and token, including in encoded tool JSON,
opaque affinity and split logical deltas. Repeating it, the target or the alias
is allowed; changing it or first declaring a new name after output/history
fails closed. A rejected additional candidate is retained only while sanitizing
the terminal failure, not added to routing authority. Matcher tables grow only
before history exists; no held prefix is discarded to accommodate a new name.
SSE primes one bounded output chunk and reinspects HTTP headers against the
learned name before releasing them. This may delay the initial HTTP response;
existing limits, transport deadline and cancellation still apply. There is no
promise of identifying an undeclared reporting name retroactively.

Only typed protocol envelopes interpret `headers`, Response `error`, and safety
selectors: SSE `safety_buffering`, or `response.metadata` with metadata
`type: "safety_buffering"`. Tool schemas, arguments, code, user objects and other
arbitrary data may contain properties named `model`, `error`, `headers` or
`retry_model`; their names alone never trigger projection or rejection.
All retained decoded strings and keys are still inspected for known sensitive
values. Tool argument JSON is also inspected after decoding. Arbitrary text and
encrypted/tool data are never redacted into a different successful payload:
an unrepresentable leak is a sanitized failure. If even the fixed local failure
text contains a learned name, the facade ends without that text rather than
echoing it; it never emits a successful completion in that case.

For supported text/refusal/reasoning deltas, the stream holds events containing
a possible sensitive suffix until that logical stream disambiguates it. This
survives network chunks, event boundaries and interleaving, and also checks the
combined text consumed by native Codex's item-independent text-delta event.
Source-supported missing output indexes and anonymous text/summary events work
with conservative identity tracking; ambiguous identity changes still fail.
Function argument events are held until a matching done event or completed
output item supplies identical, valid JSON. Custom-tool input deltas use the
same bounded holdback but preserve freeform input, rather than requiring JSON.
Standalone tool done events are inspected without inventing earlier deltas.
Encrypted tool/reasoning data is preserved. This can delay tools. A bounded queue preserves original
event order and metadata. Completed/incomplete events are held until `[DONE]`
or clean EOF; source-supported completion objects need not contain a status
field, but an explicit conflicting status fails. Malformed/truncated streams
fail. `response.metadata` and `codex.response.metadata` remain supported.
Event types are explicitly allowlisted; an unknown safety/protocol event cannot
be passed through into an apparently successful stream that ignores it.
Native SSE may omit Content-Type; a supplied Content-Type must still identify
UTF-8 SSE and every frame is validated. No unbounded buffering is used.

Limits: 1 MiB request, 4 MiB JSON response, 256 KiB SSE frame, 1 MiB holdback or
individual network chunk, 1024 held events, 128 logical streams/items, 64 MiB
total SSE bytes, 48 JSON nesting levels, and 50,000 inspected nodes. Request
upload has a 30-second deadline; each Access verification plus identity lookup
has a shared ten-second deadline and a 64 KiB identity response limit;
upstream transport has a ten-minute deadline and
propagates client cancellation. Unsupported delta families or missing/changed
unresolvable logical identities fail closed. Header values remain limited to
8 KiB each and 64 KiB total; response headers also have a 128-field limit.
Client metadata has at most 32 fields, 8 KiB ordinary strings, a 256 KiB turn
metadata string, and 32 levels/10,000 nodes within decoded turn metadata.
Oversize or unsupported content is never
silently truncated into success.

This detects exact decoded values and supported logical delta reconstruction;
it is not a guarantee against arbitrary encodings, ciphertext, semantic model
identification, or a malicious upstream's covert channels. Operators must also
disable external request/body/header tracing and restrict logs, crash dumps,
secret-store access, and the upstream runtime itself.

The private facade never writes to `CONTENT_ARCHIVE`, generic usage queues,
budget ledgers, admin state, or application logs. There is **no billing, budget
enforcement, quota reporting, or usage persistence** in this scope. Numeric usage
may remain in a safe provider response, but is not a billing calculation. Generic
policy changes cannot enable retention here. The alias facade does not isolate
the upstream account's own sessions; use only the separately owned account and
execution cell, with no shared session namespace.
