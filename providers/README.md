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
