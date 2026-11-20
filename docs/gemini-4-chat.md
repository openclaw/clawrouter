# Gemini 4 on Google GenerateContent

ClawRouter declares three stable text-generation models on the Google
provider's existing JSON and SSE routes. Google's [release schedule](https://aistudio.google.com/docs/deprecations#gemini-4-models)
lists no shutdown date for any of them as of 2026-11-20. Eligibility for an
individual account is separate. The default model is unchanged.

| Model | GA (2026) | Single REST hop: JSON / SSE output tokens |
| --- | --- | --- |
| [Neon](https://aistudio.google.com/docs/models/gemini-4-neon) | Nov 18 | 65,536 / 65,536 |
| [Carbon](https://aistudio.google.com/docs/models/gemini-4-carbon) | Nov 10 | 32,768 / 65,536 |
| [Hydrogen](https://aistudio.google.com/docs/models/gemini-4-hydrogen) | Nov 12 | 65,536 / 65,536 |

[Argon](https://aistudio.google.com/docs/models/gemini-4-argon) is **not offered or priced**. The actual client stops at a completed `CONTINUATION` without exposing a token for a second hop. Activation requires [proof of an intentional continuation with the original session, model and credential](google-continuation-pricing.md). Existing passthrough policy is unchanged.

The 1,048,576-token context window is shared by input, thinking and output.
The [GenerateContent long-decode guide](https://aistudio.google.com/docs/long-decode?generate-content=true)
distinguishes direct non-streaming REST from SDK calls: Carbon has a 32K unary boundary. Longer output needs client-driven, separately billed hops;
no route promises a single 1M-token response. The shared model-level budget
card reserves the larger per-hop ceiling when no output limit is supplied.

ClawRouter records continuation ownership only after a fully delivered hop
ending in `CONTINUATION`. The next hop must use the same caller, credential,
model, endpoint and original request settings. A checkpoint from a dropped
stream is not a replay credential here. Retrying `MAX_TOKENS` with a higher output
limit is also unsupported. Both are rejected before dispatch; ClawRouter does
not retry on your behalf. Starting a new request is a separate billable run.

Google does not charge for a dropped unary response or a stream interrupted
before its first checkpoint. After a streaming checkpoint, only the usage
committed at that checkpoint is billable, not later uncommitted output. The
router uses the last complete checkpoint's cumulative usage; it does not infer
counts from text length. If a checkpoint lacks usable counters, the existing
hard-budget fallback retains the labeled reservation rather than claiming a
measured provider charge. Explicit fixed-price policies are independent of Google's
per-token billing.

All three take text, image, video, audio and PDF inputs and return text. The
router has no separate PDF modality. Google's model pages list function calling,
structured output and thinking. Carbon supports low/medium/high
(default medium); Neon and Hydrogen also support xhigh (default high). These
are native Google settings, not OpenAI wire parameters or hosted-tool offers.

## Paid token rates

[Google's pricing](https://aistudio.google.com/docs/pricing), checked 2026-11-20.
Each cell is USD per million **input / implicit-cache hit / output** tokens;
output includes thinking. No separate audio or long-context premium is listed.

| Model and period | Standard | Flex | Priority |
| --- | --- | --- | --- |
| Neon | 3 / 0.15 / 15 | 1.50 / 0.075 / 7.50 | 5.40 / 0.27 / 27 |
| Hydrogen | 1.50 / 0.075 / 7.50 | 0.75 / 0.0375 / 3.75 | 2.70 / 0.135 / 13.50 |
| Carbon through Nov 30 | 2 / 0.10 / 10 | 1 / 0.05 / 5 | 3.60 / 0.18 / 18 |
| Carbon from Dec 1 | 4 / 0.20 / 20 | 2 / 0.10 / 10 | 7.20 / 0.36 / 36 |

For Carbon the manifest reserves and settles at the higher published
rates, labeled `manifest_rate_upper_bound`, **not** the November promotional
price. This follows the router's [existing promotional-price policy](gemini-38-frozen-price-bound.md):
it does not infer a billing period from a request clock. Neon and Hydrogen use
the published rates for the served tier. Hydrogen's free tier is not the basis
for a paid key. Batch, invite-only Contributor pricing, explicit cache storage,
hosted-tool fees and media generation are not priced by these cards.
