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

The local declaration candidate consumes the actual composed runtime in
[PR775](https://github.com/openclaw/clawrouter/pull/775), source
`2eb17306a39d1c70df31066afece7d37b760e1f4`. Publication and generated discovery
activation require its qualified landing. No snapshot is generated here.

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

Prepared tests compile the actual declaration, preserve the text endpoints,
exercise the published registry's unbound-ID denial, and check real Worker
catalog qualification against the exact policy and owner-retention contract.
The common runtime's original-job upload/create/control and capacity proofs
remain PR775's responsibility; test source alone is not executed acceptance.
