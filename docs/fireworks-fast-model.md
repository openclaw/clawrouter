# Fireworks GLM 5.3 Fast

The frozen OpenClaw catalog at `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/fireworks/openclaw.plugin.json`, names
`accounts/fireworks/routers/glm-5p3-fast`. ClawRouter exposes that exact upstream
as `fireworks/glm-5.3-fast`; existing model ordering and defaults are unchanged.

Checked 2026-11-03:

- [Serverless modes](https://docs.fireworks.ai/serverless/serverless-modes) specifies the exact Fast router ID. Fast is selected by model name, not by inventing a `fast` service-tier value.
- [Serverless pricing](https://docs.fireworks.ai/serverless/pricing) lists Fast input/cached-input/output at $2.10/$0.39/$6.60 per million tokens. Ordinary GLM 5.3 standard and priority rates do not price this router. No priority-on-Fast tariff is published.
- [The GLM 5.3 model specification](https://app.fireworks.ai/models/fireworks/glm-5p3) exposes `contextLength: 1048576`, text input and function calling, with no image input. The modes guide identifies Fast as the same model. No provider output maximum is inferred from the UI sample.
- [Chat Completions](https://docs.fireworks.ai/api-reference/post-chatcompletions) documents `auto`, `default`, `flex` and `priority`; only priority changes the tier, while the other enum values use default processing. Output is bounded by the context window, including when the requested token cap is lowered to fit.

The card therefore qualifies omitted/default/auto/flex at the Fast rate and
rejects priority or unknown tiers under hard budgets. With no caller output cap,
it reserves the full context as the output ceiling. This conservative reservation
is distinct from model facts and can exceed eventual usage. Missing served-tier
or complete cache evidence retains the conservative reservation; a token count
alone cannot invent a selected tier or another router's rate.

The focused tests exercise model remapping, default preservation, cache billing,
service-tier admission and unknown model isolation. They do not establish live
provider entitlement, authenticated request success or native client parity.
Generated snapshot integration is serialized separately.
