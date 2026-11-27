# Configured Copilot Proxy transport

`copilot-proxy` routes Chat Completions to an operator-configured HTTP server.
Set `COPILOT_PROXY_BASE_URL` to its reachable API base including `/v1`, and
`COPILOT_PROXY_MODEL` to a model accepted by that server. There is no default
host, port or model. The bundled alias is `copilot-proxy/configured`; opaque
provider-prefixed model IDs remain unpriced.

Router callers still authenticate with their ClawRouter credential. The optional
`COPILOT_PROXY_API_KEY` supplies upstream Bearer authentication only when the
configured server requires it. Leave it unset for an unauthenticated proxy;
do not configure a placeholder key. GitHub login tokens, direct Copilot identity
and router caller credentials are separate contracts and are never substituted.
Stored grants follow the existing scoped selection rules. Environment fallback
from an unavailable configured grant pool requires explicit policy opt-in.

No model price, context window, vision, tool or reasoning capability is inferred
from a model name or a subscription. Responses retain native Chat fields and SSE
bytes; token evidence and a router's fixed-request charge remain distinct from
the unknown upstream cost. A hard budget without a qualified price or explicit
fixed policy charge fails before upstream I/O.

The frozen primary integration contract is [OpenClaw's Copilot Proxy plugin](https://github.com/openclaw/openclaw/tree/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/copilot-proxy).
It requires a running VS Code extension. This transport does not install or start
VS Code, authenticate a GitHub account, create a network route, or prove that the
Worker can reach an operator's host. Upstream model discovery is not declared:
the frozen contract configures model IDs and the native discovery credential
contract must be qualified separately. The caller-scoped router catalog exposes
the configured model and route.

`worker/test/copilot-proxy-transport.test.mjs` compiles this manifest and exercises
the real Worker, proxy authentication, optional upstream credentials, fragmented
SSE, unknown-price denial and SQL fixed-policy settlement using synthetic
upstream responses. It is deterministic transport proof, not live VS Code or
actual OpenClaw consumer proof.
