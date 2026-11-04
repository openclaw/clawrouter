# Published music support metadata

`NativeEndpointCapabilities.publishedInput` describes the existing publication
protocol for `openrouter/google/lyria-3-pro-preview` and
`openrouter/google/lyria-3-clip-preview`, scoped to `music_generate`. It is separate
from inline `referenceImage`; that record retains `https: false` and
`assetHandles: false` unchanged.

The closed `PublishedMusicInputSupport` record is:

```json
{
  "version": "clawrouter.published-input.v1",
  "publication": {
    "method": "POST",
    "path": "/v1/input-assets/openrouter/music",
    "query": false,
    "body": "native_plan",
    "idempotencyKey": {
      "header": "Idempotency-Key",
      "pattern": "^[A-Za-z0-9._:-]{1,128}$"
    }
  },
  "slot": "messages[0].content[1].image_url.url",
  "count": 1,
  "encoding": "base64_data_url",
  "mimeTypes": ["image/png", "image/jpeg", "image/webp"],
  "maxDecodedBytes": 8388608,
  "maxJsonBytes": 12582912,
  "maxForwardJsonBytes": 262144,
  "maxLifetimeSeconds": 900,
  "renewable": false,
  "destinationAttempts": 1
}
```

All fields are required and fixed, including nested objects. Unknown fields,
versions, changed limits or routes are rejected. Compiler validation binds this
record to the two original model IDs and the registered POST/SSE music route at
`https://openrouter.ai/api/v1/chat/completions`. It cannot move to a global endpoint,
another model/provider, or generic Chat. Published and inline support can coexist
without changing text behavior, pricing or defaults.

An eligible native or manifest catalog offer may additionally carry
`publishedInputOrigin: { version: "clawrouter.published-input.v1", origin: string }`.
This fact comes only from the deployment's `CLAWROUTER_PUBLIC_ORIGIN`, checked by
the same exported `readPublishedInputOrigin` helper used for publication receipts.
It requires exact canonical HTTPS origin equality and no userinfo; it does not
trim, repair or infer an origin. The API base can have a different origin.
Missing or invalid configuration omits this field without removing text or inline
offers. YAML, request/forwarded headers and returned URLs cannot provide it.

Discovery freezes the validated origin for both rendering and cache identity,
including the shared colo cache. Changing or removing the origin cannot reuse a
body carrying the previous value. Catalog responses remain `no-store`, without
an ETag or conditional 304 response.

The authenticated publication POST returns HTTP 201 with `{url, expiresAt,
receiptId}`. Clients must validate the returned URL against the origin pinned
from the fresh authenticated catalog and the existing canonical receipt path:
`/v1/input-assets/<64 lowercase hex>/<asset_32 lowercase hex>/<64 lowercase hex>`.
Only the indicated image URL slot changes before submitting the original plan
through the selected native route or manifest `{body: plan}` envelope. The
forwarding bound applies to the native JSON plan. No URL logging, persistence,
attachment or prefetch is permitted. Lost acknowledgment permits no retry, new
key/verifier, alternate route or inline fallback.

Support is not permission, a grant, reservation or automatic mode selection.
Publication still requires the server's explicit `inputPublication` permissions,
original issuer, grant lineage and destination-bound receipt checks. A client
must explicitly choose publication; discovering support or supplying an image
does not select it. This foundation changes no bundled YAML, generated snapshot,
client request API or provider activation.
