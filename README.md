# ClawRouter

ClawRouter is a high-throughput API gateway and provider router for OpenClaw services.

It brokers proxy keys, service identities, provider credentials, OAuth grants, budgets, and metered usage across model providers, search APIs, tool APIs, and future service providers.

Current implementation target:

- Rust/Wasm data plane on Cloudflare Workers
- Durable Object budget ledgers
- TypeScript admin/control UI
- declarative service provider manifests
- OpenClaw-native `clawrouter-` key routing

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
