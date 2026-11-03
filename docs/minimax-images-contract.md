# MiniMax frozen image-01 generation and reference images

Frozen source: OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/minimax/image-generation-provider.ts`. The finite model is
`image-01`; no image-01-live or later model is added.

`worker/minimax-images.ts` exports `miniMaxImageModel`, `miniMaxImagePath`,
`prepareMiniMaxImage(region, body)`, `observeMiniMaxImage(body, request, complete)`
and `readMiniMaxImage(response, request, signal)`.

## Native request

POST `/v1/image_generation` with a selected native Bearer credential.
Explicit regions are global `https://api.minimax.io` and CN
`https://api.minimaxi.com`. Prepare emits only JSON and non-secret headers;
the runtime selects and admits the original regional product grant.

The frozen body uses `model:image-01`, prompt, `n` from 1–9,
`response_format:base64`, optional aspect ratio and at most one
`subject_reference` of type `character`. Eight frozen ratios are accepted.
The local prompt limit is 1500 UTF-16 units, a conservative interpretation of
the primary character limit. Reference PNG/JPEG/JPG data URLs are bounded to
8MiB; HTTPS references remain opaque native input, never router fetch targets.
The current primary reference contract does not qualify WebP for image-01.
Raw file IDs, width/height extensions and URL-output downloads stay closed.

## Result and partial delivery

Only complete HTTP 200 JSON with `base_resp.status_code:0` is accepted.
The native `data.image_base64` array and `metadata.success_count/failed_count`
must agree, and their total must equal the original requested count. The schema
documents integer counts while examples use decimal strings; canonical single
digits are accepted in either form. Malformed counts, partial transports,
foreign model metadata and nonempty URL output cannot become image success.

`delivery` distinguishes `complete`, `partial` and `filtered`. Partial responses
preserve their successful images and safety-failure count. Fully filtered
responses carry no deliverable image. Consumers must preserve those outcomes,
not silently label them complete or retry a paid generation. All bytes are
validated before any image is exposed. Limits are 8MiB/image, 16MiB total
decoded output and 24MiB JSON. Reader cancellation covers stalled bodies,
invalid UTF-8 and mismatched declared lengths.

## Billing and integration

The public pay-as-you-go card checked 2026-11-03 lists image-01 at $0.0035 per
image. This does not establish plan eligibility, which generated/safety-filtered
units were debited, or an account's actual settlement. The codec calculates no
charge and always returns unknown upstream cost. Unknown upstream-dollar hard
budgets remain closed; `policy_fixed` stays separate. Interrupted or filtered
delivery is not evidence of a refund or authorization for a new POST.

Plan and pay-as-you-go credentials are separate product contracts; an E09
Anthropic OAuth resource does not automatically authorize native images. Source
11.4/11.1 own that entitlement qualification and original regional credential
selection. No refresh, cross-region/account fallback or client secret forwarding.

Proposed exact native request/response format `minimax.images`, capability
`image.generate`, existing provider `minimax`. Source 11.3 owns existing
YAML/schema/prices; source 11.1 native dispatch/admission; source 11.2 the actual
image consumer and partial-result presentation; source 11.6 integrated proof.
Fixture `providers/_fixtures/minimax/images.json` uses three synthetic bytes
per image: encoding proof only, not playable PNG or paid generation. Five tests
cover regional wire identity, reference bounds, complete/partial/filtered
outcomes, mismatched counts and byte-reader cancellation. No live activation.

Primary evidence checked 2026-11-03:
- [Text-to-image HTTP schema](https://platform.minimax.io/docs/api-reference/image-generation-t2i)
- [Reference-image HTTP schema](https://platform.minimax.io/docs/api-reference/image-generation-i2i)
- [Public pricing](https://platform.minimax.io/docs/pricing/overview)
- [Separate plan/API-key products](https://platform.minimax.io/protocol/paid-agreement)
