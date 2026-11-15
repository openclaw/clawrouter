# LiteLLM configured model discovery

The original `models_list` declaration remains bodyless, query-free `GET /models`,
exposed through `/v1/native/litellm/models` and
`/v1/proxy/litellm/models_list`. The additional native `/v1/models` alias maps to
that same upstream `/models` suffix. The native `/v1/chat/completions` alias maps
to the original upstream `/chat/completions` suffix. Original endpoints and first
capability bindings remain unchanged; unified routing still selects them.

Configure `LITELLM_BASE_URL` with the gateway's API base, including deployment
prefixes and `/v1` when used. The router appends the original upstream suffix;
it does not invent a default host, credentials, or another version segment.

Only the selected managed API-key grant authorizes discovery. Caller headers,
environment credentials and unrelated grants cannot replace that owner. The
original caller, credential lineage and destination are checked before egress
and after complete parsing. Returned IDs intersect both admitted and current
model policies. Permissions broadened during parsing cannot widen that result.

The response must be `{object: "list", data: [{id: "..."}]}`. Empty inventory
stays empty. IDs are opaque gateway aliases; additional row fields are upstream
observations, not router prices, limits, entitlements or vendor model identity.
The discovery policy identity is `litellm/<returned-id>`. Arbitrary gateway
inference aliases require an unrestricted model policy: the existing native
opaque-model fallback refuses a restricted policy that cannot prove a registered
model. Discovery permission alone does not grant inference permission.

Metadata has zero router reservation and cost. Inference still requires explicit
financial admission. The fixtures use a seven-micro-unit fixed policy, separately
from unknown vendor pricing. A hard-dollar budget without qualified pricing or
that explicit fixed policy refuses inference before a paid POST. Observed token
usage remains distinct from absent counters.

## Pinned client proof

The authored consumer pins OpenClaw
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb`. Its registered LiteLLM catalog selects
strict live discovery, preserves the configured base and resolves auth once.
A base ending in `/v1` requests `models`; other bases request `v1/models`.
The fixture calls that real catalog and public `stream`/`streamSimple`, using the
native aliases above. It does not claim registered-client manifest support.
Manifest metadata is covered separately by real Worker requests.

The local tests compile the entire provider inventory and use real HTTP,
Workerd, original managed grants and SQLite. The configuration-race test alone
is labelled fault injection: it changes the fixture environment during an
original credential inspection. It is not a claim about deployed hot reload.

The SDK consumer executes only in the existing ephemeral Node 24 workflow with
its own pinned checkout and dependencies. Local syntax, source and Worker tests
are not SDK execution proof. Four genuine EOF, pre-abort, partial caller-abort
and provider-error controls precede the other SDK cases. Original acquisition,
read, closed, cancel, release and dispatcher promises remain strict; no native
cancellation disposition from another provider is imported. Inference releases
its original request lease without closing the process-owned dispatcher pool.
A cached discovery waiter abort is not shared transport cancellation.

The local 30-second metadata deadline control has a separate Worker-only
disposition. It retains the original rejected read and its same-reason derived
observer after the bound, branded deadline fires with the caller still active.
The cancellation operand must be the deadline reason; the read reason can
differ. Original cancellation, closed, unlock, handler, background work and
upstream producer retirement must still succeed without fixture expiry. The
single GET must return the sanitized 502 and its correlated zero-cost metadata
receipt with absent token counters. This does not establish that the deadline
caused the read rejection: a concurrent data failure can meet the same contract.

The two earlier local caller-abort controls failed: the direct HTTP/1 ingress
did not deliver an abort signal to the Worker, and the fixture upstream expired.
Those failures remain open; deadline qualification does not waive them or
qualify SDK cancellation.

Hosted SDK execution, its actual compiled observer attachment and complete
physical retirement remain unqualified until that candidate's consumer passes.
No deployment or native OpenClaw readiness is implied.

The standalone metadata disconnect fixture uses one owned, nonpooled HTTP/1
`ClientRequest` and its original socket's `resetAndDestroy()`. After upstream
arrival, the existing router readiness control must observe one live request,
transport and reader with a pending read and un-aborted ingress/effective
signals. Only then does the caller request a reset before response headers.
Local reset return and close events are not remote cancellation proof: the
original Worker ingress signal, strict operation drain, unlocked reader,
nonexpired canceled producer with joined originals and observers, and zero-cost
SQLite receipt must independently pass. This contract does not qualify generic
Undici fetch abort; the earlier failures remain recorded above. The SDK consumer
uses its unchanged caller and assertions. New native execution remains required
for each candidate; source and inert tests alone do not qualify disconnection.
