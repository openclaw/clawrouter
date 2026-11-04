# Google native image declaration

This finite contract consumes the actual `prepareNativeGoogleImage(selection)`
wrapper in [PR661](https://github.com/openclaw/clawrouter/pull/661), source
`e2203e7ff4a18b1a2bbf95d8d57c0f9b64113d75`, landed as
`4cb7ba420622183cc2c1fa44961f55d45d2346b9`, and the landed `prepareGoogleImage`
codec. It qualifies only `gemini-3.1-flash-image` and `gemini-3-pro-image` from
OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`. The existing Google YAML now
declares that exact endpoint and both image-only model rows. Generated discovery
and actual-client integration still require the serialized snapshot proof. No
live image call is made.

## Exact declaration

Provider `google-gemini` uses only `https://generativelanguage.googleapis.com`
with its original required `x-goog-api-key` API-key scheme. The endpoint is:

```yaml
image_generate:
  method: POST
  path: /v1beta/models/${model}:generateContent
  pathParams: [model]
  requestFormat: google.image_generate
  responseFormat: google.image
  timeoutMs: 600000
```

Associate exactly one `image.generate` capability with methods `[POST]`.
Native proxy remains enabled. Model rows use exact IDs
`google/gemini-3.1-flash-image` and `google/gemini-3-pro-image`, their unchanged
upstream IDs and only `image.generate`. No alias, text/token/image price card,
endpoint tariff, model passthrough or request-parameter rewrite qualifies.
No alternate origin, grant transport, dispatch path, query, caller header,
credential override, stream, lifecycle or WebSocket is admitted by this contract.
Optional fixed JSON accept/content-type headers and the existing segment model
path style remain compatible with the actual wrapper.

The wrapper requires `pathParams.model === selected model.upstream`; compiled
schema does not establish ownership of a caller-selected path. Both this endpoint
and ordinary GenerateContent use the same public path. Source1 owns capability-
and selected-model-aware matching plus ambiguity rejection. YAML ordering is
**not** a routing contract, and this compiler never reorders routes as a workaround.
The shared image classifier in [PR662](https://github.com/openclaw/clawrouter/pull/662)
handles generic GenerateContent/stream intent; it is not a replacement for the
actual qualified image wrapper or model matcher.

## Bounds, costs and evidence

The wrapper enforces 8 MiB request/response JSON, at most four images sharing
4 MiB decoded output, explicit PNG/JPEG/WebP MIME with matching bounded signatures,
complete HTTP200 UTF-8 EOF and terminal valid siblings. It uses the existing
64 MiB response reservation. Missing MIME, remote assets, file ownership,
continuation tokens and partial output remain outside this declaration.
See [the actual wrapper contract](google-image-contract.md) for delivery details;
schema tests are not complete Worker or actual-client delivery proof.

The landed [PR660](https://github.com/openclaw/clawrouter/pull/660) guard keeps
upstream-dollar hard budgets closed and explicit `policy_fixed` separate.
Preserved native counters are not a text-token invoice, image tariff, refund or
free-generation receipt. This contract does not derive rates from image sizes,
byte bounds, output count or another provider's card.

Current unlocalized primary [image documentation](https://ai.google.dev/gemini-api/docs/image-generation)
and [deprecation schedule](https://ai.google.dev/gemini-api/docs/deprecations),
checked 2026-11-04, list both frozen non-preview identities without an announced
shutdown. Their preview IDs are separate retired identities and are rejected.
Current examples prefer Interactions; they do not prove live GenerateContent
compatibility. This slice preserves the actual frozen codec/wrapper wire and
makes no newer-model alias or live backwards-compatibility claim.

Seven focused cases compose compiler output with actual codec/wrapper selection,
matched model paths, conservative admission, unchanged existing routes, rejected
origins/formats/prices and strict request preparation. Source1 owns common matching,
auth, classification, dispatch and accounting; source5 owns the wrapper; source2
owns actual-client image consumption; source6 owns serialized snapshot and composed
Worker proof. The bundled declaration follows landed matcher
[PR672](https://github.com/openclaw/clawrouter/pull/672)
(`0777fa1cde38d9ed48fb664afb9eddfae55c6b71`), actual image runtime
[PR675](https://github.com/openclaw/clawrouter/pull/675)
(`cd75e6962b1c5656e4ea1aade84f39c1a622a9ba`) and shared-context pricing
[PR681](https://github.com/openclaw/clawrouter/pull/681)
(`9c21b70de2755b3353d1fc633d344beb8cf62db0`). Four declaration cases exercise
actual bundled identities, native matching/preparation, order independence,
manifest offers, ambiguity rejection and conservative admission. They do not
replace source2/source6 actual-client and serialized snapshot proof. Source1
retains the real Worker fixture and dispatch ownership. Its exact duplicate-row
fixture correction [PR692](https://github.com/openclaw/clawrouter/pull/692) is
consumed from landed `ed1b1318d8d0e9a2f31c235d1473c8b77dc861ba`, without copying
or modifying its assertions. No snapshot is regenerated
in this source slice, and model availability does not establish account entitlement.

## Local declaration integration

Source PR698 `21c17f5928c34cdc8f0865f76e86fb7d5b42b01c` is composed on
landed `81da9416c6e45f5b1ce2114288dc541ede81ce99`, retaining the previous
local packet `d580436179cda5aa51c417f35c8a96e7182a47e9`. Its declaration commit
`d17a72f66e76fdade623c3b7297c50b44b193957` adds only the two original image
cards, image endpoint and capability. Every prior Google row/endpoint and the
current Vercel fixture are preserved; the already-landed Vercel correction is
not reapplied over newer accepted proof.

All 85 manifests compile. Snapshot SHA256 is
`90b6ab7352b58188df4044b98ce70da7fe3c911ff5d7203e7f2616aeee7de8ff`.
Refreshed local proof covers 107 focused image/compiler/real-Worker/admission/
pricing cases, including the existing music-compiler isolation regression,
Worker types and 1,035 Chat matrix/consumer-selection cases. Frozen dependency
inputs match; no installation or actual-client execution occurred.
One music negative fixture originally failed because its inherited image
endpoint rejected the mutated origin before music validation. The integration
fixture removes only the unrelated image endpoint/capability/rows; all music
assertions remain intact, and the changed music fixture file passes.

Fourteen actual image-host cases are AUTHORED/UNRUN against published OpenClaw
`9ce99ae1521b2d23e85c27688d9db45a31dbe472`: registered ClawRouter selection,
both exact models, text/edit, native and a separate manifest-only Worker
isolate, original key binding, byte-exact PNG delivery, unknown-dollar/invalid
key denial, already-aborted requests and incomplete paid output without replay.
The tests import the real `generateImage` host and registered provider; no client
parser is copied and no request is patched. The proposed receipt remains one
explicit seven-micro policy charge with null token counters.

No SDK execution, hosted CI, publication or live inference occurred. The actual
client pin is not newly qualified here, and the fixtures are not yet enrolled
in the hosted matrix. Native runtime tests do not substitute for this pending
actual-client composition or imply account entitlement.
