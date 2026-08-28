# ClawRouter 🦞 — One key, many upstreams.

[![CI](https://img.shields.io/github/actions/workflow/status/openclaw/clawrouter/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/openclaw/clawrouter/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/openclaw/clawrouter?style=flat-square)](https://github.com/openclaw/clawrouter/releases/latest)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?style=flat-square&logo=nodedotjs)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/openclaw/clawrouter?style=flat-square)](LICENSE)

ClawRouter is a provider-neutral API gateway for OpenClaw deployments. It routes policy-scoped credentials across model and tool providers while enforcing access, revocation, budgets, request retention, and metered usage.

## Install

ClawRouter is distributed from source. Local development requires Node.js 24 or newer and the pnpm version declared in `package.json`.

```sh
git clone https://github.com/openclaw/clawrouter.git
cd clawrouter
corepack enable
pnpm install --frozen-lockfile
```

For a complete service without a Cloudflare account, use the [Docker self-hosting profile](docs/self-hosting.md). It requires Docker with Compose and OpenSSL.

## Quick start

Run the local end-to-end Worker smoke:

```sh
pnpm worker:e2e
```

The smoke starts a local Worker and fixture upstream, exercises discovery, authentication, routing, budgets, failover, retention, usage, and admin paths, then removes its temporary state.

## Routing

Clients authenticate with one policy-scoped `clawrouter-` credential. The selected policy controls which providers and models are visible, how upstream grants are chosen, what budget applies, and whether request content is retained.

| Surface | Path |
| --- | --- |
| OpenAI-compatible chat, responses, and embeddings | `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings` |
| Anthropic messages | `/v1/messages`, `/v1/messages/count_tokens` |
| Manifest-defined APIs | `/v1/proxy/<provider>/<endpoint>` |
| Provider-native APIs | `/v1/native/<provider>/<provider-native-path>` |
| Credential-scoped discovery | `/v1/models`, `/v1/catalog` |
| Usage and key status | `/v1/usage`, `/v1/key/inspect` |

Models use provider-qualified IDs such as `openai/gpt-4.1-mini`. `GET /v1/catalog` reports only the providers, models, and transports the caller can execute. See the [API reference](docs/api-reference.md) for the complete route inventory and authentication boundaries.

The opt-in [private alias facade](docs/private-codex.md) is a separate, Responses-only contract for an isolated owner-only runtime, not a model in the shared catalog or per-user protection for a shared Gateway. It requires separately provisioned secret-store bindings and has no generic billing or retention.

## Provider catalog

Provider support starts with one manifest:

```text
providers/<service>.provider.yaml
```

The compiler validates auth schemes, routes, request and response formats, capabilities, models, pricing, and billing meters, then emits the snapshot shared by the Worker and admin console. Add a focused TypeScript adapter only when a manifest cannot express the provider safely. See [Service providers](providers/README.md) for the schema and mapping rules.

Amazon Bedrock uses native SigV4-signed `InvokeModel` routes rather than OpenAI normalization; its IAM and request contract are documented separately in [Amazon Bedrock](docs/aws-bedrock.md). The optional `clawrouter/fusion` model combines several adviser calls with one synthesizer through the normal policy and accounting path; see [Fusion routing](docs/fusion-router.md).

## Policy and accounting

Revocation-critical policy and credential state lives in serialized Durable Object authority. Budget reservations happen before upstream work, successful responses settle to actual metered cost, and failed settlement or audit delivery retries independently without hiding the provider response.

Usage ledgers retain bounded request metadata, not prompts or completions. Policies can enable request-content retention in a separate R2 archive. The [architecture](docs/architecture.md), [content-retention contract](docs/content-retention.md), and [agent spend-control guide](docs/agent-spend-control.md) describe those boundaries.

## Deployment

| Target | Guide |
| --- | --- |
| Docker and local workerd persistence | [Self-hosting](docs/self-hosting.md) |
| Cloudflare Workers, Durable Objects, KV, queues, R2, and Access | [Deploy on Cloudflare](docs/deploy-cloudflare.md) |
| OpenClaw client configuration and quota checks | [Use with OpenClaw](docs/openclaw.md) |
| Isolated non-production Cloudflare profile | [FakeCo staging](docs/fakeco.md) |

The Docker profile exposes port 8787 on host loopback and persists Durable Objects, KV, and R2 under a named volume. The Cloudflare profile adds distributed queues, managed storage, and an Access-protected browser console.

## Development

```sh
pnpm build
pnpm check
```

`pnpm build` compiles the provider snapshot and admin UI, then typechecks the Worker. `pnpm check` runs Worker, admin, and script tests.

## License

MIT. See [LICENSE](LICENSE).
