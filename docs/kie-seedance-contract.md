# Frozen Kie Seedance 1.5 qualification boundary

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/kie/video-generation-provider.ts`, sends the exact Kie model
`bytedance/seedance-1.5-pro` for both text and single-image generation.
`prepareKieSeedanceFrozenWire` preserves that consumer contract: numeric integer
duration 4–12, six frozen aspect ratios, lowercase 480p/720p/1080p, explicit
generate_audio boolean, and an optional single input_urls image. It rejects
rounding, string duration, multiple images and extra options. Prompt bounds
match the frozen client's 3–20000 UTF-16 code units and reject malformed Unicode.

This is compatibility evidence, not current native protocol qualification.
On 2026-11-03 the unlocalized [Kie product URL](https://kie.ai/seedance-1-5-pro)
redirected to Seedance 2.5. The current
[documentation inventory](https://docs.kie.ai/llms.txt) and
[sitemap](https://docs.kie.ai/sitemap.xml) omit the 1.5 contract. The corresponding
`/market/bytedance/seedance-1-5-pro.md` returned 404. Older indexed playground
content is inconsistent about prompt bounds. These observations establish
neither an upstream API shutdown nor an explicit model alias. Newer product
parameters, availability and pricing must not be assigned to the frozen ID.

The real registered Kie preparation path therefore rejects new creates with
`kie_seedance_native_contract_unqualified`. It does not rewrite identity or
dispatch a replacement model. Already scoped jobs retain their existing GET
retrieval and terminal handling; the create-only denial introduces no new job
index, cancellation, refund assumption or POST replay. This is a deliberate
execution guard, not a production integration or parity-completion claim.

`providers/_fixtures/kie/seedance-frozen-video.json` contains synthetic frozen
text/image requests and original-job observations. Unknown upstream cost stays
unknown; historical credits, resolution, duration and audio flags do not prove
whole-job dollars. policy_fixed charging remains separate from native cost.
Image URL wire validation grants no upload, fetch or ownership authority, even
after the native protocol is qualified. Original caller/model/credential asset
binding and content limits still belong to the shared runtime.

Unblock requires primary Kie evidence for this exact native model and its input,
output and lifecycle semantics, then source5 preparation qualification and
source3 catalog/pricing disposition. Do not mark it retired based only on a
marketing redirect. Source1 retains shared runtime/accounting/asset ownership,
source2 actual clients, and source6 final integration proof. No newer Seedance
model or API is added by this bounded frozen-contract work.
