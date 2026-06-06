# ClawRouter

ClawRouter is a high-throughput API gateway and provider router for OpenClaw services.

It brokers proxy keys, service identities, provider credentials, OAuth grants, budgets, and metered usage across model providers, search APIs, tool APIs, and future service providers.

Current implementation target:

- Rust/Wasm data plane on Cloudflare Workers
- Durable Object budget ledgers
- TypeScript admin/control UI
- declarative service provider manifests
- OpenClaw-native `clawrouter-` key routing
- Cloudflare KV-backed key policy and revocation

## Provider Registry

Provider support is data-driven. Most integrations are added by creating one file:

```text
providers/<service>.provider.yaml
```

That file declares the service id, auth scheme, OAuth platform mapping when needed,
base URLs, route templates, adapter family, model/capability mapping, and billing
meters. The Rust compiler turns those files into a provider snapshot consumed by
the edge runtime and admin UI.

Built-in starter coverage:

- model APIs: OpenAI, Anthropic, Google Gemini, Azure OpenAI, AWS Bedrock,
  MiniMax, Mistral, Cohere, xAI, Groq, Perplexity, DeepSeek, Together, Fireworks,
  Hugging Face, Replicate
- gateway APIs: OpenRouter, Cloudflare AI Gateway
- tool/API platforms: Tavily, GitHub, Slack, Linear, Notion

Validate the catalog with:

```sh
cargo run -p clawrouter -- provider compile providers/*.provider.yaml
```

Before a real Cloudflare deploy, run:

```sh
pnpm cf:doctor
```

It checks Wrangler auth, required GitHub Actions secret names, local deploy env,
provider binding coverage, and the all-provider smoke plan without printing
secret values.

## Edge Proxy

The Worker currently exposes:

- `GET /v1/health`
- `GET /v1/providers`
- `GET /v1/key/inspect`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`
- `POST /v1/proxy/<provider>/<endpoint>`
- `GET /v1/admin/keys`
- `PUT /v1/admin/keys/<kid>`
- `POST /v1/admin/keys/<kid>/revoke`

OpenAI-compatible proxy requests route by the request body `model` field, for
example `openai/gpt-5.5-mini`. Before an upstream provider secret is used, the
Worker checks `POLICY_KV` at `keys/<kid>` for:

```json
{
  "enabled": true,
  "secretSha256": "<sha256 of key secret>",
  "providers": ["openai"],
  "tenantId": "team_docs",
  "monthlyBudgetMicros": 100000000
}
```

Flip `enabled` to `false` to revoke a key without rotating upstream provider
credentials. See `docs/deploy-cloudflare.md` for Cloudflare provisioning,
deployment, key registration, and smoke commands.

Admin endpoints accept a verified Cloudflare Access admin session or
`Authorization: Bearer <admin-token>` against `CLAWROUTER_ADMIN_TOKEN_SHA256`.
The TypeScript admin UI hashes generated proxy key secrets in-browser before
storing policy in `POLICY_KV`.

Generic REST/tool proxy requests are manifest-driven:

```sh
curl "$CLAWROUTER_BASE_URL/v1/proxy/tavily/search" \
  -H "authorization: Bearer $CLAWROUTER_KEY" \
  -H "content-type: application/json" \
  --data '{"body":{"query":"openclaw"},"query":{"topic":"news"}}'
```

The Worker resolves `provider` and `endpoint` from the compiled provider
snapshot, applies manifest path/query/header/auth mapping, forwards the request,
and emits a usage event to `USAGE_QUEUE` when the binding is available.
OAuth, SigV4, and deployment-templated providers are still cataloged, but the
edge path rejects them until the required token/signing/runtime mapping exists.
