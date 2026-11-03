# Runway bundled route qualification

The experimental `runway` declaration exposes native text/image creation and
the shared GET/DELETE task path. It reuses `runway.tasks` scoped BackgroundStore
ownership, original credentials, reservation/idempotency/outbox and conservative
observation-loss settlement. No replacement job store is introduced.

The registry selects a create adapter by both protocol and request format.
Shared controls use the same native UUID/version parser; the runtime from PR509
resolves the original create endpoint from scoped durable ownership before
dispatch. Declaration order does not choose the original job. Actual combined
text/image Worker tests and consumer proof remain required.

Canonical server configuration is `RUNWAYML_API_SECRET`, matching the frozen
OpenClaw authentication method at
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7:extensions/runway/index.ts`.
The frozen plugin also advertises `RUNWAY_API_KEY`; no automatic server alias
or caller-secret fallback is introduced. The selected native Bearer grant and
stable `X-Runway-Version: 2024-11-06` must survive every control.

## Finite model boundary

Current primary Runway model/API docs checked 2026-11-03 still name these frozen
models:

| Model | Qualified create modes | Frozen duration subset |
| --- | --- | --- |
| gen4.5 | text, image | integer 2–10 seconds |
| gen4_turbo | image | integer 2–10 seconds |
| veo3.1 | text, image | 4, 6 or 8 seconds |
| veo3.1_fast | text, image | 4, 6 or 8 seconds |

The source adapters enforce mode, duration and ratio combinations before egress.
A model's generic media capability does not make it valid on every create path.
Historical `gen3a_turbo`, `gen4_aleph` and `veo3` codecs remain available as
frozen compatibility evidence, but have no bundled model rows. The video-edit
route is therefore unavailable. No new vendor models or silent aliases are added.
Runway's own Veo product contract is distinct from retired Google API preview IDs.

All four rows are explicitly unpriced. Public credits-per-second tables do not
supply a qualified actual task debit/refund witness or shared video-dollar
admission contract. Unknown upstream-dollar hard budgets stay closed;
`policy_fixed` charges remain distinct. Duration hints, success, missing metrics
and a DELETE acknowledgment cannot invent a vendor cost.

HTTPS references remain opaque inputs, not router fetch destinations. Raw
`runway://` upload IDs and upload endpoints remain unavailable until durable
original-credential asset binding exists. DELETE 204 stops automatic continuation
as `canceled_or_deleted`, without claiming stopped generation or a refund.

The frozen client needs model-specific Veo duration defaults; its generic five
seconds is rejected. Source 11.2 owns that correction and actual native consumer.
Source 11.1 owns shared original-route/runtime controls, and source 11.6 owns
combined Worker proof and serialized snapshot regeneration. This PR must not
land with a stale generated snapshot or claim deployed/live parity.

Verification: two new registry tests plus seven native lifecycle tests; two new
manifest compiler tests run in qualified CI together with all bundled manifests.
No local dependency install, live generation or deployment.

Primary evidence:
- [Available models](https://docs.dev.runwayml.com/guides/models/)
- [Native model-specific API](https://docs.dev.runwayml.com/api.md)
- [Public credit pricing](https://docs.dev.runwayml.com/guides/pricing/)

See [the native lifecycle contract](runway-lifecycle-contract.md) and
[typed schema links](runway-lifecycle-schema.md).

