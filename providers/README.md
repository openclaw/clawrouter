# Service Providers

ClawRouter providers are single-file manifests. A maintainer should be able to add
most API platforms by adding `providers/<id>.provider.yaml`, fixtures when useful,
and no Worker code.

Use a focused TypeScript adapter only when the platform cannot be represented as:

- an OpenAI-compatible model API
- an Anthropic-compatible model API
- a REST JSON/Form API
- an OAuth-backed REST API
- a gateway wrapper around one of the above

## Required Shape

```yaml
schema: clawrouter.service-provider.v1
id: example
displayName: Example
class: rest_json
service:
  platform: example
  kind: api_provider
  configKeys: [EXAMPLE_API_KEY, EXAMPLE_SITE_URL]
  optionalConfigKeys: [EXAMPLE_SITE_URL]
auth:
  schemes:
    - type: bearer
      header: Authorization
      format: "Bearer ${secret}"
      secretKind: api_key
baseUrls:
  default: https://api.example.com
routing:
  nativePrefixes: [clawrouter-example]
  modelPrefixes: [example/]
adapter:
  request: rest_json
  response: rest_json
capabilities:
  - id: tool.invoke
    endpoint: rest
    methods: [GET, POST]
endpoints:
  rest:
    path: /v1/${path}
    pathParams: [path]
    pathParamStyles:
      path: relative_path
    requestFormat: example.rest
    responseFormat: example.rest
billing:
  meter: clawrouter.requests
  dimensions: [provider, service, key, subject]
```

## Mapping Rules

- The compiler validates the complete manifest against
  `_schema/service-provider.schema.json` before applying defaults. Errors identify
  the provider and JSON pointer; rates and token counts must be safe integers.
  Cross-field references and pricing relationships are checked separately.
- `service.platform` is the stable service id used by admin, billing, OAuth, and
  policy grants.
- `routing.nativePrefixes` lets OpenClaw route native keys such as
  `clawrouter-openai-*` to a provider without users setting `base_url`.
- `routing.modelPrefixes` maps model names like `openai/gpt-4.1-mini` to the
  provider snapshot.
- A model's `capabilities` map it to endpoints through the provider's capability
  declarations. Native route catalogs include only models for that endpoint;
  known models are rejected on incompatible endpoints before dispatch.
- `endpoints.*.modelPassthrough: {}` permits caller-supplied model identifiers
  for that operation. It does not advertise those models or attest upstream
  availability. Opaque models inherit no reasoning, client metadata, or prices.
  An optional `pricingRef` must name exactly one priced, endpoint-compatible
  model in this provider. Use it only when that price applies to every opaque
  model, as with the local provider's zero API charge. Requests without a model
  do not acquire metadata or prices from the first catalog entry.
- `auth.schemes` declares how ClawRouter injects the upstream credential.
- Bearer credentials are required by default. Set `required: false` when an
  upstream offers keyless access and an API key only raises limits; ClawRouter
  omits the header until a configured key or scoped upstream grant is present.
- `auth.authorization` declares a provider-approved browser OAuth flow,
  including its trusted endpoints, client configuration, scopes, grant kind,
  and optional account metadata mappings.
- `auth.grantTransports` can replace authentication, append required headers,
  prepend trusted system blocks, and declare alarm-driven quota or keep-warm
  maintenance for one grant kind. Contributors cannot override these values.
  `allowedEndpoints` optionally restricts that transport to named endpoints;
  `endpointPaths` alone only overrides paths. Compatibility is checked before
  grant priority and selection, without reopening environment credentials.
- `service.optionalConfigKeys` allows absent bindings without blocking readiness.
  Injected adapter and endpoint headers are omitted when a missing template binding
  is optional; missing required bindings still fail, including mixed templates.
  Base URLs, paths, and query templates always require their bindings.
- `adapter` declares the request/response family. Use `custom_adapter` only after
  the declarative format cannot express the provider.
- `billing.meter` and `billing.counters` produce OpenMeter/Lago/Meteroid style
  event dimensions without hard-coding provider logic.
- `quota.responseHeaders` maps provider response headers into named quota
  windows. `quota.probes` declares bounded, admin-triggered reads for providers
  that expose per-grant quota outside normal responses; probes never run in the
  request hot path.
- `models.entries[].pricing` supplies a dated, source-linked list-price snapshot
  for hard budget reservation and settlement. Rates are integer micro-US-dollars
  per million tokens. Change `pricingRef` whenever rates or effective dates
  change. Declare `longContext` when a model changes rates above an input-token
  threshold; omit `pricing` when a model cannot be priced safely.
- `pricing.serviceTiers` declares complete rate cards with unique wire `id`s,
  optional `aliases`, optional `longContext`, and an optional `maxInputTokens`
  price-applicability limit. Include a `default` card identical to the root
  pricing; the compiler rejects drift. Omitted/auto requests reserve all known
  possible rates, while settlement requires the served tier. Unpublished tiers
  or contexts never silently use Standard rates.
  Models without this contract retain their provider's existing pricing behavior;
  the Worker does not reinterpret another provider's tier parameter as OpenAI's.
- `models.entries[].supportedReasoningEfforts` advertises the model's exact
  provider-native OpenAI-compatible wire efforts. Values are unique and limited
  to `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- `models.entries[].codexModel` names an explicitly sourced native Codex model
  descriptor for a documented upstream alias. The export helper preserves that
  descriptor's prompts and context contract; it does not generate metadata.
- `endpoints.*.websocket: openai.responses` explicitly qualifies a native
  POST Responses/SSE endpoint for the Worker WebSocket bridge. Other endpoints
  and alternate grant transports do not gain WebSocket support implicitly.

## Upgrading custom manifests

Known model entries keep their declared endpoints and prices. Opaque model
requests now require an explicit declaration on each intended endpoint. Add
`modelPassthrough: {}` to the existing endpoint mapping, then regenerate the
provider snapshot:

```yaml
endpoints:
  chat_completions:
    modelPassthrough: {}
    # Keep the endpoint's existing path and protocol fields.
```

Without this declaration, a native request for an unknown model returns
`model_capability_unsupported`. The declaration restores opaque routing without
copying another model's price or metadata. Budgeted opaque requests still need
a fixed policy tariff or an applicable endpoint `pricingRef`.

## Edge Support Rules

Every valid manifest is listed in `GET /v1/providers` and compiled into the
admin/provider snapshot. The live Worker executes a manifest endpoint when the
edge can resolve its deployment-specific placeholders from `service.configKeys`
or from request path params:

- `baseUrls.default`, `adapter.injectHeaders`, `adapter.injectQuery`,
  `endpoint.headers`, and `endpoint.query` may contain `${name}` placeholders
  when `service.configKeys` declares a matching binding such as
  `EXAMPLE_NAME`, `EXAMPLE_SITE_URL`, or `EXAMPLE_API_VERSION`.
- `endpoint.path` may contain `${name}` placeholders when the endpoint declares
  matching `pathParams`; callers pass those as single safe path segments by
  default.
- `pathParamStyles.<name>: opaque_segment` keeps a value in one encoded segment
  while permitting reserved characters such as `/` inside an opaque resource
  identifier.
- `pathParamStyles.<name>: relative_path` allows slash-delimited REST paths and
  still rejects absolute paths, empty segments, `.`, `..`, query strings, and
  fragments.
- OpenAI-compatible providers may use one endpoint path param, such as Azure
  OpenAI’s deployment name; ClawRouter fills it from the routed model suffix.
- The bundled `local-openai` provider maps arbitrary `local/<model>` ids to an
  operator-hosted OpenAI-compatible endpoint. Set `LOCAL_OPENAI_BASE_URL` to
  the server root, without `/v1`; `LOCAL_OPENAI_API_KEY` is optional.
- bearer, header API key, query API key, and Cloudflare binding auth are
  executable today.
- OAuth-backed REST providers are executable when `POLICY_KV` has a grant at
  `oauth/<kid>/<tokenRef>` or `oauth/tenants/<tenant>/<tokenRef>`.
- SigV4 providers are executable with an access/secret key credential bundle in
  a scoped upstream grant plus the manifest-declared region binding. Worker
  access/secret key bindings remain a fallback; session tokens are optional.
- Declare runtime bindings that do not gate executability in
  `service.optionalConfigKeys`; every optional key must also appear in
  `service.configKeys`.
- Browser OAuth is available only when the manifest declares
  `auth.authorization`, and the provider OAuth client must allow ClawRouter's
  `/v1/oauth/callback` URI.
- Refresh requests default to form encoding. Set `auth.refresh.requestFormat`
  to `json` only when the provider's token endpoint requires a JSON body.

## Compile and retrieve the snapshot

After changing manifests, regenerate `worker/generated/provider-snapshot.json`
with a qualified dependency install:

```sh
pnpm install --frozen-lockfile
pnpm provider:compile -- --output worker/generated/provider-snapshot.json
```

For a code-only checkout, push the source change to a draft PR and use the
existing CI `worker-package` job. It compiles immediately after the frozen
install and uploads only `provider-snapshot.json`, retained for three days.
Compilation failures stop the job; a later test failure does not remove a
successfully uploaded snapshot. The artifact is compiler output, not a passing
test verdict.

Select the run for the exact PR head and record its URL and attempt:

```sh
ghx run view RUN_ID --repo openclaw/clawrouter --json headSha,event,attempt,url
ghx run view RUN_ID --repo openclaw/clawrouter --log
ghx run download RUN_ID --repo openclaw/clawrouter \
  --name provider-snapshot-CHECKOUT_SHA-ATTEMPT --dir /path/to/task-scratch
shasum -a 256 /path/to/task-scratch/provider-snapshot.json
```

Use the checkout SHA and file SHA-256 printed by `Compile provider snapshot`.
For `pull_request`, the checkout SHA is GitHub's test merge commit, while the
run's `headSha` identifies the PR revision. Confirm that revision is still the
intended PR head. Before copying the JSON into the branch, compare the checkout's
`scripts/compile-providers.mjs`, `providers/`, `package.json`, `pnpm-lock.yaml`,
and `pnpm-workspace.yaml` with the branch's current inputs, including uncommitted
changes. Stop if they differ. Verify the downloaded file's checksum against the
compile log, inspect its diff, commit it, and rerun CI for the new head. Do not
reuse an older run after changing compiler inputs. A qualified checkout of the
recorded SHA can reproduce the artifact with the same compile command above.

## Smoke Coverage

Run this after adding or changing providers:

```sh
pnpm provider:smoke-plan
```

The smoke planner compiles `providers/*.provider.yaml`, derives one route
candidate per provider, and fails if any provider lacks a route plan. Request
templates and preferred operations follow the endpoint's request format and
capabilities, so renamed provider and endpoint IDs keep the same request shape.
Anthropic token counting omits the output limit required by Messages generation.

A planned target is not upstream verification. Unknown formats and resource-bound
requests without a fixture remain visible with `target.unresolved`; live smoke
execution fails before dispatch and does not update provider health. Replicate
prediction lookup still needs support for an operator-selected existing prediction
ID. This remains a separate fixture follow-up, not a verified smoke target.

Planning does not call upstream APIs; deployed live calls are opt-in through
`CLAWROUTER_SMOKE_LIVE_PROVIDERS`. The bundled AWS body override and Cloudflare
inline credential/model overrides apply only to their named bundled providers;
renamed manifests do not inherit those values.

## Lanseq

The bundled Lanseq manifest exposes `lanseq/qwen3.8-27b-int4` through
OpenAI-compatible Chat Completions, including SSE streaming. Configure
`LANSEQ_API_KEY` or a scoped API-key grant before enabling it for a policy.
The dated prices and token limits come from [Lanseq's public documentation](https://api.lanseq.cloud/docs).
