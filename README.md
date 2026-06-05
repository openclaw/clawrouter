# ClawRouter

ClawRouter is a high-throughput API gateway and provider router for OpenClaw services.

It brokers proxy keys, service identities, provider credentials, OAuth grants, budgets, and metered usage across model providers, search APIs, tool APIs, and future service providers.

Current implementation target:

- Rust/Wasm data plane on Cloudflare Workers
- Durable Object budget ledgers
- TypeScript admin/control UI
- declarative service provider manifests
- OpenClaw-native `clawrouter-` key routing

