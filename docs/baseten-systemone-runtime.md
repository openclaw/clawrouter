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
this integration adds no tariff.

Focused Worker tests cover all three models on native/manifest routes with both
environment and pooled credentials, persisted dispatch acknowledgment, observed
usage, complete output, zero-egress input/configuration denial, cancellation and
reservation release when capacity prevents dispatch. Provider declarations,
snapshot activation and the actual native DecisionV2 consumer remain separately
qualified source/integration work.
