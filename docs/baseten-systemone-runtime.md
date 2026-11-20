# Baseten SystemOne runtime

The shared native-response hook consumes `prepareNativeBasetenSystemOne` from
[the source-owned wrapper](../worker/native-baseten-systemone.ts). It does not
implement a second DecisionV2 encoder. Native POST `/systemone` is composed with
`https://inference.baseten.co/v1`; the selected original Baseten Bearer credential
is used under the existing admission, destination, deadline and accounting path.

Only the three schema-qualified frozen decision IDs are accepted. Native Noul,
choice and score answers preserve their provider-defined confidence/probability
semantics. The backend model in the response remains distinct from the selected
catalog model recorded in accounting. Complete native usage must report one
output token per question; metadata never fills a missing receipt.

The wrapper reserves an 8 MiB shared lease before dispatch for its 1 MiB bounded
JSON response and decoded projections. Invalid responses, redirects, ranges,
truncation, interruption and timeout publish no provisional answers and do not
replay generation. Policy-fixed charges settle once and remain conservative on
uncertain outcomes. Unknown upstream-dollar budgets stay denied before egress;
this integration adds no tariff. This denial applies when a dollar budget is
enforced. Unmetered policies retain the existing `flat_fallback` accounting;
its one-micro record is not a published Baseten price.

Focused Worker tests cover all three models on native/manifest routes with both
environment and pooled credentials, persisted dispatch acknowledgment, observed
usage, complete output, zero-egress input/configuration denial, cancellation and
reservation release when capacity prevents dispatch. The bundled manifest and
snapshot now activate the three finite DecisionV2 rows without changing Chat.

## Registered client qualification

`test/openclaw-baseten-decisions.test.mjs` binds the actual OpenClaw source
`761748e1824e2ee43e886fcce4376c3b20055015` to a separate native consumer. This is an
explicit client revision, not a claim about an OpenClaw release or default main.
The harness loads the registered ClawRouter DecisionV2 provider and prepares a
live model catalog. Successful offers come from the compiled Worker and its
actual selected credential, rather than manufactured fixture rows. The client
selects `clawrouter/baseten/decision-models/<model>` and the advertised native
`/v1/native/baseten/systemone` route. Independent Worker checks cover the manifest
`/v1/proxy/baseten/systemone` route; these are not a second SDK routing claim.

The controlled upstream verifies the selected Bearer credential, model and
encoded text/JSON state, boolean instructions, choice criteria and score legend.
Synthetic fixed-policy prices are explicitly separate from unknown vendor
tariffs. The tests retain backend-served model identity separately from the
selected model in SQLite accounting. Malformed answers, wrong output-token
counts and oversized responses keep conservative settlement and emit no valid
DecisionV2 result. An HTTP rejection is independently distinct from invalid
HTTP-200 output.

Two source-pinned callsite observations run before native client compilation:
catalog acquisition and Decision transport acquisition. They preserve the
original callee, operands, promise, returned response, readers and detached
release callback. Every case requires nonzero observed acquisition/read/release
and joined originals; falsey observer or cleanup failures remain fatal. Worker
handler, waitUntil, fetched-reader and source callback lifetimes are independently
joined. Transport output alone does not prove retirement.

Predispatch abort is covered. Physical client disconnect before the buffered
SystemOne response remains separately unqualified on the pinned local runtime;
the harness does not inject a Worker abort, substitute body cancellation, or
claim that this boundary is closed. No live vendor credentials or deployment
are exercised by these deterministic fixtures.
