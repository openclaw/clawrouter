# BytePlus PAYG frozen inventory

This source completes the six nonmedia identities in the frozen
[OpenClaw BytePlus declaration](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/byteplus/openclaw.plugin.json).
The existing Dola seed is preserved. No later vendor generation is added.

| Native identity | Source disposition |
| --- | --- |
| `dola-seed-2-1-turbo-260628` | Chat, text/image |
| `seed-2-0-code-preview-260328` | Chat, text/image; preview label does not infer retirement |
| `glm-5-2-260617` | Chat, text |
| `deepseek-v4-pro-260425` | Chat, text |
| `deepseek-v4-flash-260425` | Chat, text |
| `glm-4-7-251222` | Frozen deprecated; known non-executable row |

The deprecated GLM identity has no executable capability, native facts or price.
Its frozen replacement suggestion does not authorize an alias, and its label
does not establish a shutdown date or current account access. Known-model
selection rejects it even when opaque model passthrough remains available.
Prices, context/output limits and reasoning defaults are not copied from the
frozen declaration. Input modalities retain that exact source provenance.

The previously qualified [standard streaming contract](https://docs.byteplus.com/en/docs/modelark/streaming-output?redirect=1),
checked 2026-11-03, fixes `https://ark.ap-southeast.bytepluses.com/api/v3`,
`/chat/completions` and Bearer authentication. Only `BYTEPLUS_API_KEY` or the
original selected BytePlus grant configures this product. Volcengine Beijing,
`ARK_API_KEY` and both Coding Plan credentials are not fallback sources.
No API key is inferred to grant an account entitlement from its syntax.

`/api/coding/v3` and its console-managed `ark-code-latest` are distinct from
PAYG. Plan-specific Kimi deprecation or GLM alias notices do not change dated
PAYG identities. The fixture tariff is an explicit caller-policy fixed charge;
unknown upstream rates still fail hard dollar admission and are never zero.

`worker/test/byteplus-payg-runtime.test.mjs` compiles the actual source and uses
the real Worker with synthetic authority, credential-owner and SQLite budget
stores. It covers all five active models through native/manifest JSON/SSE,
tools/reasoning replay, cache-inclusive usage, selected identity, original grants,
wrong-product isolation, errors, unknown usage, cancellation and closed GLM
passthrough rejection. Its KV fixture honors requested byte-stream reads.

The pinned OpenClaw consumer has 19 authored cases using the registered
ClawRouter catalog and both actual stream entrypoints. Client inference uses
only `/v1/chat/completions`; native and manifest coverage above is Worker-only,
not client route parity. Catalog access uses the genuine SSRF guard with an
exact local fixture-origin allowance and the original runtime dispatcher.
Observers join original releases, reads, cancellations and Worker request work
before fixture disposal. They never close the shared Chat dispatcher pool.
Hosted execution must qualify these assertions; authored cases are not proof.

The shared cadence fixture retains the parent request-owner, preparation-drain
and socket-close observers. Its additional RPC durations use one isolate-local
clock; the unchanged 250 ms enforcement assertion uses host authority ACK to
client close, captured before the statistics RPC. The historical 372 ms failure
remains unexplained; a later passing sample does not establish its cause.

No live call, account change, shared production runtime/schema edit or deployment
is included. All other compiled provider records remain unchanged.
