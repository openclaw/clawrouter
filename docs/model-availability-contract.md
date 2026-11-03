# Model availability contract

`models.entries[].availability` records a dated disposition for that exact
provider product and selected model identity. The compiler preserves it on both
`providers[].models[]` and `model_index`. It does not create a serving-model row,
rewrite `id` or `upstream`, copy a tariff, or grant account access.

```ts
type ModelAvailability = {
  version: "clawrouter.model-availability.v1";
  effectiveAt: string; // YYYY-MM-DD, effective by checkedAt
  checkedAt: string;   // YYYY-MM-DD
  sources: string[];   // 1–8 unique public HTTPS primary evidence URLs
} & (
  | { status: "stopped"; servingModel?: never }
  | { status: "deprecated"; servingModel?: never }
  | { status: "upstream_alias"; servingModel: string }
);
```

Unknown versions, states and fields are rejected. Dates must be real calendar
dates; future scheduled changes need a separate contract. Source URLs cannot
contain credentials. An explicit alias names a bounded, distinct native serving
model, never a URL. The provider's `upstream` remains the selected wire identity.
The metadata does not follow alias chains or infer dynamic console-managed
targets such as `ark-code-latest`.

## State semantics

- `stopped`: the selected identity no longer provides service. Its row must have
  no capabilities, model/endpoint pricing, Codex mapping, reasoning efforts or
  native/request facts. Keep the row rather than dropping it: known-model
  selection rejects it before dispatch, including on endpoints that permit
  unknown model passthrough. Historical facts belong in disposition records.
  Another executable row cannot expose the same stopped native identity.
- `deprecated`: a published deprecation is not proof that every existing
  account has lost access. Existing capabilities require their own evidence.
  Account eligibility, model access and current route admission remain separate.
- `upstream_alias`: primary evidence explicitly states the serving replacement.
  Preserve the caller's selected identity. Native codecs must independently
  qualify returned-model validation, defaults and accounting. Never inherit the
  replacement's tariff or capabilities merely because its name is known.

Absent metadata means no disposition has been declared, not proof of current
availability. Dates are evidence dates, not runtime timers or live checks.
Unknown costs remain denied under upstream-dollar hard budgets; explicit
`policy_fixed` accounting retains its distinct basis.

## Frozen plan handoff

The [Volcengine notice](https://docs.volcengine.com/docs/ark/coding-plan-personal-model-deprecation?lang=zh)
qualifies `doubao-seed-2.1-turbo` as stopped on 2026-10-09 and `glm-5.2` as an
upstream alias of `glm-5.3` from 2026-08-31. Both published cutoffs are 14:00
UTC+8. The notice also restricts new model users; previous purchase alone does
not establish prior use or account eligibility.

The [BytePlus notice](https://docs.byteplus.com/en/docs/modelark/coding-plan-personal-model-deprecation)
is the evidence source for the frozen `kimi-k2.5` deprecation disposition dated
2026-09-23. Do not turn a deprecation or an older setup-page listing into a
universal availability or retirement claim. These product-specific facts do not
apply automatically to another provider carrying the same model slug.

## Integration boundary

This change publishes schema/compiler validation and executable selection tests;
it does not add provider rows or regenerate the snapshot. Plan manifest owners
retain their finite inventories. Before exposing dependent cards, shared model
types and discovery must preserve this versioned field and hide stopped rows
from live offers. In particular, the legacy `openaiCompatible.models` route
projection currently lists rows without checking their capabilities; it needs
the shared owner's correction before stopped rows enter bundled declarations.
The existing scoped offer projection already requires an eligible capability.

Any deprecated or alias row still needs qualified model facts, original product
credentials, account access and current policy admission. This metadata is not
`hostedToolAdmission`, an execution entitlement or evidence of runtime parity.
