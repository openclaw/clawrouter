# Frozen MiniMax M3 model facts

The E01 frozen model inventory includes `MiniMax-M3`. The existing MiniMax
manifest now declares its unchanged `minimax/MiniMax-M3` identity on the existing
OpenAI-compatible Chat endpoint. No new provider, transport, model generation,
default model, credential flow or account entitlement is introduced.

Primary evidence checked 2026-11-04:

- [OpenAI compatibility](https://platform.minimax.io/docs/api-reference/text-openai-api)
  names `MiniMax-M3`, a decimal 1,000,000-token context window, text/image/video
  Chat input and the existing `https://api.minimax.io/v1` service. This is not
  1,048,576 tokens. No numeric output ceiling is qualified by that page.
- [Current pricing](https://platform.minimax.io/docs/pricing/overview) publishes
  distinct M3 standard/priority and long-input rates. `priority` is a supported
  service tier, with separate charges; it is not a free performance flag.

The native facts preserve context and input modalities with their provenance.
The compiler requires qualified price cards before advertising supported tiers,
so the vendor tier evidence above is documentation only; explicit request values
remain unchanged. Missing output limits and whole-request reservation bounds
stay unknown. No published unit rate is converted into a usable price card
without those bounds. Both caller and provider upstream-dollar hard budgets
remain denied; explicit `policy_fixed` accounting stays separately labeled.
Facts do not authorize remote asset fetching or prove live multimodal delivery.

The existing M2.7 row is unchanged. Its dated PAYG retirement/account-cohort
notice and separate plan alias require their own disposition; neither is inferred
from this M3 addition. The distinct M3.1 Flash preview identity is also not
silently replaced with M3.1 Flash. Other MiniMax regional, Anthropic and OAuth
contracts retain their owners and activation prerequisites.

Four focused cases cover exact compiled facts, selected-key Chat preparation,
tier preservation, both hard-budget levels, explicit fixed charges and unchanged
legacy/default/passthrough behavior. Snapshot generation and actual-client proof
remain with the serialized integration owner; static facts alone do not certify
runtime or account parity.

## Local integration and authored consumer proof

The local composition carries source
`5ed3b3a0b3e482cace970054cb49b9cc7776e387` onto qualified router base
`274a9ac7193a06438aa3d6d20402e2acb4aaf8ae`, preserving the provider YAML and
four source tests byte-for-byte. All manifests compile; the generated inventory
adds only the M3 row. M2.7, its prices and ordering are unchanged.

Local validation passes: all four source cases, 1,035 existing manifest-driven
Chat matrix and consumer-selection cases, and Worker TypeScript. The matrix
selects each endpoint's offered model; it is not a substitute for the M3
actual-client assertions below.

`test/openclaw-minimax-m3.test.mjs` and its companion client fixture author
11 cases against actual public OpenClaw source
`d8bb939408aa4d2be7df0161748edb52ebf3b1fb`. The registered MiniMax plugin,
model definitions, catalog, host replay policy and Chat message serializer match
the frozen `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7` source. The tests import
those implementations; they do not copy their parsers or patch requests.

The intended composition uses the real Worker and SQLite, the registered
static M3 card, both stream hooks, explicit Chat configuration, original managed
credentials and a synthetic fragmented upstream. Assertions cover tool replay,
the registered policy's deliberate removal of thinking history, exact inline
PNG bytes, invalid keys, foreign/model restrictions, unknown caller/provider
hard budgets with zero egress, terminal usage, embedded errors and cancellation
after partial delivery. Paid outcomes retain one explicit seven-micro
`policy_fixed` receipt and null tokens when usage is absent. Client tariff and
output-limit hints never become router reservation facts.

These 11 actual-client cases are enrolled in the existing hosted consumer
matrix at the exact public source above. They remain **authored, unrun** until
the composed candidate passes that job; local preparation does not establish
actual-client or live proof. No new SDK report or live call is required.
The client defaults to Anthropic; this fixture explicitly selects its existing
Chat option. It does not prove default Anthropic, OAuth/portal, CN, dynamic
discovery, ClawRouter manifest-client selection, video, account entitlement or
physical pre-header cancellation. Final composed client execution and native
gates remain required before landing.
