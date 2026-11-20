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
evidence retains the conservative reservation. Missing cache counts receive no
cache discount; complete input/output counts with an observed default tier use
the full input tariff. Token counts cannot invent a selected tier.

The focused tests exercise model remapping, default preservation, cache billing,
service-tier admission and unknown model isolation. They do not establish live
provider entitlement, authenticated request success or native client parity.

The registered-client contract pins OpenClaw `d8bb939408aa4d2be7df0161748edb52ebf3b1fb`.
Its frozen Fireworks catalog has a 256,000-token context and output limit; the
Router card's 1,048,576-token reservation ceiling is a separate conservative
accounting fact, not a claim about the SDK catalog or a provider output limit.
The fixture preserves that catalog and uses its supported custom Worker base URL.
The official-origin-only Fireworks header-cache wrapper correctly returns no
wrapper for this URL; its execution is not claimed. Cache evidence comes from
the actual SSE usage fields, and explicit tiers use the public payload hook.

The dedicated consumer checks registered selection, captured-provider scoped
tool-history sanitation, exact final model/credential/wire, complete cache/tier
receipts, denied priority/unknown tiers, and independent original SDK, Worker,
reader, source and accounting retirement. Its cancellation begins after actual
partial output; it does not qualify physical pre-header disconnect propagation.
