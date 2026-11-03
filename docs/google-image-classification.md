# Google image admission classification

`worker/google-image-classification.ts` exports:

```ts
googleImageRequest(
  selectedUpstreamModel: string | null | undefined,
  body: unknown,
  requestFormat: string,
): boolean
```

The model argument is the selected upstream identity from routing, not
`body.model`, a router alias, a function name or prompt content. The classifier
recognizes the explicit `google.image_generate` format; the two frozen
`gemini-3.1-flash-image` / `gemini-3-pro-image` selected identities on
`google.generate_content`; and IMAGE output modalities on that generic format.
It reuses `googleField` for last-wins camelCase/proto field aliases at both
generation-config and modality levels. A later null unsets a field. Inline image
input and text-only output remain distinct from image generation.

Google's [GenerationConfig proto](https://github.com/googleapis/googleapis/blob/master/google/ai/generativelanguage/v1beta/generative_service.proto)
defines IMAGE as enum value 2. [ProtoJSON](https://protobuf.dev/programming-guides/json/)
accepts numeric enum values as well as names. The classifier recognizes `IMAGE`
and numeric 2, and conservatively treats the quoted integer `"2"` as image
intent. It is not a full request validator, an availability declaration or a
tariff. It does not normalize the request or add model aliases.

Shared selection denies image intent through generic GenerateContent unary/SSE
routes on both native and manifest entry points. Explicit image format also
requires an actual prepared native response wrapper. Policy-fixed charging does
not authorize bypassing response qualification. Source5 owns the separate
`prepareNativeGoogleImage` wrapper; this classifier slice does not wire or copy it.

Shared admission consumes source3's explicit image `requestPricingGap` guard for
classified intent, without changing the actual wire format or borrowing text
rates. Fixed policy charges are handled first and retain `policy_fixed`.
Accounting freezes the boolean classification before dispatch. Token-shaped
usage cannot erase it or create a token tariff during hard, soft or unmetered
settlement. Dispatched unknown image cost remains `unpriced_usage`; known-unsent
work remains zero. Image bytes/counts are not converted to tokens or dollars.

For source3's pricing continuation, shared `estimateModelCost` calls now receive
an endpoint projection containing `selectedUpstreamModel: model.upstream ?? null`.
Source3 owns admitting that optional property in `PricingEndpoint` and consuming
the same exported classifier in direct pricing helpers. No second classifier or
common-file edit by source3 is needed. The shared admission guard already uses
the selected context independently, including generic GenerateContent requests.

No provider YAML, snapshot, live image offer or additional model is activated by
this slice. Source3 retains schema/pricing ownership and source5 retains wrapper
ownership. Native image activation requires their qualified endpoint contract,
the actual wrapper and final Worker/native proof.
