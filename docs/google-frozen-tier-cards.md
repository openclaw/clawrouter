# Frozen Gemini tier cards

The frozen OpenClaw revision `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`
names `gemini-3.5-flash-lite` and `gemini-3.1-pro-preview` in
`extensions/google/openclaw.plugin.json`. This bounded slice adds those exact
identities and preserves the existing default and native generate/stream routes.

Checked 2026-11-03 against Google's [pricing](https://ai.google.dev/gemini-api/docs/pricing),
[Flash-Lite facts](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
and [Pro Preview facts](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview).
Both accept text, image, video and audio, with 1,048,576 input tokens and 65,536
output tokens. PDF support is documented upstream but is not relabeled as a
separate router modality. These are source facts, not client acceptance proof.

Prices below are USD per million input / cached input / output tokens:

| Model | Standard | Flex | Priority |
| --- | --- | --- | --- |
| 3.5 Flash-Lite | 0.30 / 0.03 / 2.50 | 0.15 / 0.02 / 1.25 | 0.54 / 0.05 / 4.50 |
| 3.1 Pro Preview, input ≤200,000 | 2 / 0.20 / 12 | 1 / 0.20 / 6 | 3.60 / 0.36 / 21.60 |
| 3.1 Pro Preview, input >200,000 | 4 / 0.40 / 18 | 2 / 0.40 / 9 | 7.20 / 0.72 / 32.40 |

Use published cache rates, including Flash-Lite's rounded Flex/Priority rates;
do not derive them from a generic discount. Native output bounds cover thoughts
and visible candidates. Media reserves the full input ceiling. Only an observed
served tier selects settlement prices; unknown tiers remain unpriced.

The existing generic request classifier still denies unqualified hosted tools
and explicit cached-content references under upstream-dollar hard budgets.
Storage fees, search allowances, private contributor tiers, Batch, Live and
Interactions are not priced by these generation cards. Ordinary caller function
declarations do not imply hosted execution. Explicit policy-fixed tariffs remain
a separate policy choice. Native-client replay/thought-signature acceptance and
live-account entitlement require their actual consumers and tests.

Native tier discovery metadata remains limited to its currently qualified wire
formats. These cards use the existing Gemini runtime tier contract; they do not
extend the client catalog tier-advertisement contract.
