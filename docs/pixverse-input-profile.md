# PixVerse composed-image input profile metadata

The optional literal is identical at each boundary:

```yaml
inputProfile: clawrouter.pixverse-image-input.v1
```

It belongs to the endpoint, compiled endpoint and future native/manifest catalog
carriers. There is no snake-case alias, arbitrary string, model-level flag or
implicit multipart inference. The exact common type hunk for the runtime owner
is `CompiledEndpoint.inputProfile?: "clawrouter.pixverse-image-input.v1"`.
This change leaves that common file untouched.

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

This is type/schema propagation only. Existing compiler lifecycle guards remain
text-create-only and reject activating the image route. Catalog carrier types
accept the optional literal, but neither route-catalog output nor caller-specific
discovery projects it. No YAML or generated snapshot changes are made.

After the actual composed runtime qualifies, a separate bounded integration must
qualify image-create/`video.generate`, shared retrieval selected by the original
create owner, and runtime-qualified native/manifest profile projection. Tests
here distinguish schema metadata acceptance from that still-closed compilation
and discovery boundary; they do not claim a usable multipart provider route.
