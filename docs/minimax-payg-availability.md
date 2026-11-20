# Existing MiniMax M2.7 PAYG availability

The [primary model notice](https://platform.minimax.io/docs/faq/models), checked
2026-11-04, restricts M2.7 access for new users from 2026-10-19. Existing PAYG
users may continue until the published 2026-11-18 retirement. The dated schedule
controls this declaration even though the page's summary table already groups
M2.7 under retired models.

The existing `minimax/MiniMax-M2.7` row records `availability.status: deprecated`
with the effective restriction date. It preserves the default, upstream wire
identity, Chat route and existing dated price card. This availability change
does not requalify that tariff, infer account access or stop existing users
before the dated retirement. There is no new model, request rewrite or live call.

The notice's separate M Plan/Token Plan migration to M3.1 Flash is not a PAYG
alias. It does not authorize copying replacement prices or changing the selected
model. Future retirement needs a dated stopped disposition; availability dates
are provenance, not an invented runtime timer.

Shared availability validation and catalog/selection tests own the generic
behavior. All-manifest validation and source6 serialized snapshot integration
must qualify this concrete declaration; metadata alone is not account or
runtime parity proof. The highspeed E01 row remains the separate source in
[PR717](https://github.com/openclaw/clawrouter/pull/717).
