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

The 11 actual-client cases passed against that source in run `41824408691`
on router head `a4d6bf3272db222c623e5670aafb0285392d74da`. The outer Worker
checks passed cancellation, six single-dispatch outcomes, credential isolation,
replay, image bytes and their accounting before finding a fixture mismatch in
the provider-only denial's caller balance: an uncapped caller returns an
`unmetered` ledger with null balances, not zero. The corrected assertion retains
zero egress and zero charged denial events. Final-head composed execution remains
required; this prior receipt is not final qualification or live proof. No new
SDK report or live call is required.
The client defaults to Anthropic; this fixture explicitly selects its existing
Chat option. It does not prove default Anthropic, OAuth/portal, CN, dynamic
discovery, ClawRouter manifest-client selection, video, account entitlement or
physical pre-header cancellation. Final composed client execution and native
gates remain required before landing.


## Flash on the explicit Chat route

The frozen 2026-11-03 Flash card appends `MiniMax-M3.1-Flash` after the
existing M2.7, M3 and M2.7-highspeed rows. It uses the same Bearer-authenticated
Chat endpoint. Input, cached-input and output prices are respectively $0.15,
$0.015 and $0.60 per million tokens. Its declared text/image/video inputs and
million-token context do not establish native SDK video support: the pinned
SDK accepts text and image only. Temperature, top-p and M3 service-tier facts
are not inherited.

The pinned OpenClaw MiniMax provider defaults to Anthropic/M3. Its Flash
adaptive-thinking rewrite runs only for Anthropic. The explicit Chat fixture
keeps the registered provider, public stream entrypoint and captured replay
provider, and configures Flash's supported Chat effort domain using the SDK's
existing model compatibility setting:

```json
{
  "id": "MiniMax-M3.1-Flash",
  "compat": {
    "supportsReasoningEffort": true,
    "supportedReasoningEfforts": ["low", "medium", "high", "xhigh", "max"]
  }
}
```

Without that explicit Chat domain, the pinned generic Chat client clamps
`xhigh` and `max` to `high`. The fixture retains separate cases for
that limitation; it does not claim the unmodified Anthropic catalog is a
complete Chat configuration. An omitted effort stays absent on the wire,
leaving the documented provider default of max to the upstream. A synthetic
upstream can prove omission, not actual vendor execution of that default.

Flash settlement checks use its own tariff and cached-token counters, separate
from M3's seven-micro fixed-policy cases and unpriced hard-budget denials.
Incomplete paid errors and cancellation retain their reservation without
inventing terminal token usage. A full-context media reservation with 16 output
tokens costs 150,010 micro; missing output limits reserve one million output
tokens and cost 750,000 micro. These are conservative accounting ceilings,
not advertised output capabilities.

Both model groups use actual original SDK acquisition/reader/release observation
and independent Worker/source retirement. The source producer remains owned by
its request context; bounded yielding pulls do not count as producer completion.
A canceled Worker read may retain its rejection only when the exact original
operation first committed caller cancellation, all independent work joined,
source cancellation returned without expiry, and accounting is client_error.
Controlled provider errors use their own actual SDK callback/result witness.
No physical pre-header cancellation, default Anthropic, OAuth, video or live
vendor/account entitlement claim follows from these fixtures. Fresh hosted
qualification of the composed head is required.
