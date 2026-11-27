# PixVerse composed-image input profile metadata

The optional literal is identical at each boundary:

```yaml
inputProfile: clawrouter.pixverse-image-input.v1
```

It belongs to the endpoint, compiled endpoint and qualified native catalog
offer. There is no snake-case alias, arbitrary string, model-level flag or
implicit multipart inference. The common type is
`CompiledEndpoint.inputProfile?: "clawrouter.pixverse-image-input.v1"`.
This declaration leaves that common file untouched.

The declaration is restricted to PixVerse POST
`/openapi/v2/video/img/generate`, request `pixverse.image_video`, response
`pixverse.video`, explicit `video.generate` and registered `pixverse/v6` or
`pixverse/c1` identities. The endpoint declares its existing `pixverse.video`
retrieve link. It cannot override origin/path/auth, inject query/headers, enable
streaming, borrow a text capability or introduce unqualified prices.

This metadata describes the composed byte-intake contract. It does not grant
upload authority, select a credential, authorize retention or certify a tariff.
The public path must authenticate before intake, validate the complete plan and
image, reserve both operations and preserve original-owner/job binding through
upload and create. The reviewed binary composition uses separate 40/56 MiB
charges with enforced parsing/window bounds and complete consumption lifetimes;
those runtime guarantees are not implemented or proved by this declaration.

This declaration consumes the qualified composed runtime from
[PR775](https://github.com/openclaw/clawrouter/pull/775), landed as
`15f01e6c94613baba072c15c67f2a16b98b14d38` from final source
`970f68b17bf0ba1add63d980370bd4b6e6ba918f`. This integration regenerates the
bundled snapshot and advertises the finite image offers through the existing
native catalog. Eligibility still requires the selected credential owner, both
operation prices and the current retention binding; declaration alone does not
activate a usable offer.

The existing text endpoint keeps `media.predict`; only the separate image
endpoint receives `video.generate`. Both frozen model identities explicitly
support both operations without an inferred price. A single text/image pair
may link the same GET declaration in either order. The runtime selects the
original job's create route; sharing a path grants no cross-job control rights.
Raw upload routes, caller image IDs, cancellation and output-download authority
remain closed.

The runtime, not YAML, requires separate explicit `policy_fixed` prices for
`pixverse.image_upload` and `video.generate`, plus the original owner-backed
credential and current retention binding. A global policy fee, an environment
credential or one operation's price does not satisfy the other requirements.
Unknown vendor-dollar costs stay closed. Generic manifest JSON cannot enter the
native multipart profile.

Focused tests compile all bundled manifests and preserve the text endpoints.
The local Workerd/SQLite fixture creates real credential owners, persists their
lineages and binds the catalog to the resulting route digests. It verifies
separate upload/create receipts, original-key GET controls, foreign-control and
pricing/retention denials. An ambiguous create keeps the original durable
reservation and recovery row, without a repeated POST, invented job ID or
terminal usage receipt. These results do not transfer PR775's other capacity
or cancellation proofs.

The new registered OpenClaw consumer is pinned to
`b0d33f09ba5d8d0e6db804f01cbf79dcf269a351`. It selects
`clawrouter/pixverse/v6` or `clawrouter/pixverse/c1` through the actual catalog
and submits one multipart request to the Router. This differs from the native
PixVerse provider's separate upload and JSON-create sequence. The existing text
consumer retains its independent pin and coverage.

The registered SDK contract exercises both models, explicit pricing/retention
denials, original job polling and ambiguous-create no-replay. Exact-head hosted
results are recorded on [PR777](https://github.com/openclaw/clawrouter/pull/777).
The fixture observes the original guarded
responses, body and reader cancellation, closed/read promises and releases;
transport output alone is not retirement proof. The client returns an exact
terminal URL and MIME type; the generic runner does not download that URL. The
fixture rejects unexpected foreign-origin fetches rather than claiming a
download that the registered provider never performs. The original owner may
collect concurrently with SDK polling: all GETs must retain the same job ID,
credential and destination and reconcile to caller requests or observed owned
collector calls. Collection never authorizes another create or another charge. Synthetic policy-fixed prices
are fixture inputs, not vendor tariffs. No paid vendor execution, deployment,
automatic catalog entitlement or caller-signal/physical pre-header cancellation
qualification is claimed.
