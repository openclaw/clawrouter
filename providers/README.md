# Service Providers

ClawRouter providers are single-file manifests. A maintainer should be able to add
most API platforms by adding `providers/<id>.provider.yaml`, fixtures when useful,
and no Rust code.

Use a custom Rust/Wasm adapter only when the platform cannot be represented as:

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

- `service.platform` is the stable service id used by admin, billing, OAuth, and
  policy grants.
- `routing.nativePrefixes` lets OpenClaw route native keys such as
  `clawrouter-openai-*` to a provider without users setting `base_url`.
- `routing.modelPrefixes` maps model names like `openai/gpt-5.5-mini` to the
  provider snapshot.
- `auth.schemes` declares how ClawRouter injects the upstream credential.
- `adapter` declares the request/response family. Use `custom_adapter` only after
  the declarative format cannot express the provider.
- `billing.meter` and `billing.counters` produce OpenMeter/Lago/Meteroid style
  event dimensions without hard-coding provider logic.

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
- `pathParamStyles.<name>: relative_path` allows slash-delimited REST paths and
  still rejects absolute paths, empty segments, `.`, `..`, query strings, and
  fragments.
- OpenAI-compatible providers may use one endpoint path param, such as Azure
  OpenAI’s deployment name; ClawRouter fills it from the routed model suffix.
- bearer, header API key, query API key, and Cloudflare binding auth are
  executable today.
- OAuth-backed REST providers are executable when `POLICY_KV` has a grant at
  `oauth/<kid>/<tokenRef>` or `oauth/tenants/<tenant>/<tokenRef>`.
- SigV4 providers are executable when `service.configKeys` declares access key,
  secret key, and region bindings. Session tokens are optional.
