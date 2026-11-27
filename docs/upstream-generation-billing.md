# Qualified upstream generation errors

Novita's [LLM billing contract](https://docs.novita.ai/guides/llm-billing)
identifies HTTP499 as a potentially charged generation outcome, including
streaming requests. That status does not supply a qualified usage or dollar
receipt. An upstream error therefore cannot automatically return the reserved
generation amount.

`upstreamGenerationMayBeCharged` recognizes only an actual response from the
selected `novita` POST Chat operation: `llm.chat`, `openai.chat_completions`, a
selected model and exactly
`https://api.novita.ai/openai/v1/chat/completions`. Metadata GETs, other providers,
alternate destinations, query overrides and other statuses do not qualify.

The shared dispatch path records the response before native error normalization
or body observation. Accounting freezes the original selection and keeps this
outcome through failed reads and caller cancellation. It prevents automatic
credential failover after that evidence. The existing settlement/outbox path
retains conservative reserved cost with null token counters and unknown usage;
an explicit `policy_fixed` charge remains separately labeled. An error payload
with zero-valued counters does not prove free generation.

This does not admit unpriced requests. Unknown preflight cost still denies
upstream-dollar hard budgets before egress. A local already-aborted/known-unsent
request remains zero; a dispatched local abort without response headers retains
its existing uncertainty behavior without becoming an HTTP499 receipt.
Other providers' error semantics and Novita's other rejection statuses remain
unchanged. No provider prices, grants, account configuration or manifests change.

Two pure route/status tests and 27 Worker/accounting cases cover original
credentials, native/manifest/unified Chat, streaming and nonstreaming requests,
zero-looking error counters, body loss, local aborts, known-unsent denial,
metadata GETs and conservative settlement. Fixtures use synthetic credentials
and errors; no live request or violation/charge probe is needed. The reservation
unit test supplies an existing unknown reservation rather than inventing a
Novita tariff. Catalog activation remains separate owner work.
