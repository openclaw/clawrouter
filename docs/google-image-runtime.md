# Native Google image runtime

The shared selection chain consumes the source-owned
`prepareNativeGoogleImage(selection)` wrapper for `google.image_generate` to
`google.image`. The frozen models are `gemini-3.1-flash-image` and
`gemini-3-pro-image`, with capability `image.generate` and a matching upstream
model path. The finite compiler contract is documented in
[google-image-schema.md](google-image-schema.md).

Overlapping native GenerateContent paths use the registered model's declared
endpoint capability. Manifest callers use the explicit image endpoint. Ordinary
text routes remain distinct; generic GenerateContent and SSE cannot bypass the
image classifier or borrow a text tariff. Ambiguous native operations, router
aliases on overlapping paths, unowned files and query overrides stay closed.

The existing pipeline owns caller policy, selected original environment or grant
credentials, the approved Google origin, manual redirects, budget reservation
and dispatch acknowledgment. The wrapper acquires its existing 64 MiB capacity
lease before fetch, validates complete HTTP200 UTF-8 JSON and all image siblings,
then publishes the bounded response. The lease remains held through downstream
consumption. Thought output is removed; native image bytes and usage metadata
remain intact. No asset URL is fetched and no failed POST is replayed.

Upstream-dollar hard budgets reject the unqualified whole-request image cost
before egress. Explicit policy-fixed charging remains a distinct basis. Native
usage metadata does not become text tokens, an image invoice or a refund. A
known-unsent capacity or acknowledgment failure returns the reservation;
dispatched rejection, partial output, timeout or cancellation conservatively
retains the fixed charge and settles once.

The runtime test suite composes the actual compiler, wrapper, Worker, scoped
original grant, SQLite reservations and usage ledger. Its 26 cases cover both
models and route forms, both credential sources, declaration order, zero-egress
admission and invalid input, refreshed model policy, capacity/acknowledgment,
complete output, invalid siblings, upstream rejection, deadline and cancellation.
The image fixture is offline; no live provider call or synthesis is claimed.

This PR changes shared runtime and tests only. Source3 owns provider YAML and
source6 owns generated snapshots and actual-client qualification. Runtime proof
must pass before declaration activation; a wrapper or compiler test alone does
not establish provider parity.
