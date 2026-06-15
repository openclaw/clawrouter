# ClawRouter Spec

The living design source is currently maintained at:

```text
~/.spec/2026-06-05-clawrouter-rust-wasm-cloudflare-spec.md
```

The implementation in this repository follows that RFC:

- Rust/Wasm edge data plane
- TypeScript admin frontend
- Durable Object budget ledgers
- Durable Object policy-binding authority
- declarative `providers/*.provider.yaml` service provider manifests
- OpenMeter-compatible usage events
- OpenClaw-native `clawrouter-` key detection

## Service Provider Contract

`providers/*.provider.yaml` is the extension point. Each file maps one upstream
service provider into ClawRouter:

- `service`: stable platform id, provider kind, OAuth provider id, and config keys
- `auth`: bearer/header/query API keys, OAuth grants, Cloudflare bindings, or SigV4
- `baseUrls`: default and named upstream base URLs
- `routing`: native prefixes like `clawrouter-openai`, model prefixes like
  `openai/`, and optional base URL/service selector params
- `adapter`: request, response, stream, and error normalization family
- `capabilities`: normalized actions such as `llm.chat`, `web.search`, or
  `tool.invoke`
- `endpoints`: path templates, methods, path params, timeout, and wire formats
- `models`: public ClawRouter model ids to upstream model/deployment ids
- `billing`: meter name, dimensions, and usage counters

The intended add-provider path is:

1. Add `providers/<id>.provider.yaml`.
2. Add request/response fixtures if the adapter is new or risky.
3. Run `cargo run -p clawrouter -- provider compile providers/*.provider.yaml`.
4. Add a Rust/Wasm adapter only if the declarative families cannot represent the
   upstream contract.

The provider catalog is broader than the live executable edge path. Cataloged
providers are available to admin, policy, OAuth mapping, and billing metadata.
The Worker executes an endpoint when deployment templates are backed by declared
`service.configKeys`, endpoint path placeholders are backed by request
`pathParams`, and auth can be resolved from Worker secrets/config or `POLICY_KV`.

Bearer, header API key, query API key, Cloudflare binding auth, KV-backed OAuth
grants, and AWS SigV4 signing are supported in the edge path today.
