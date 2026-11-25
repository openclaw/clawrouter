# Radius native transport

Radius uses Pi messages. OpenRouter backing does not make its wire format Chat
Completions. The API-key product uses `RADIUS_API_KEY` with Bearer authentication;
OAuth device login and refresh are a separate identity lifecycle.

`worker/provider-radius.ts` supplies the focused runtime contract:

- `prepareRadiusRequest(body, selectedModel)` binds the scoped model and preserves
  Pi context, native tool results and options. Disabled reasoning is omitted.
- `createRadiusEventInspector()` receives complete JSON data events from the
  shared SSE framer via `accept(value)`. Call `unavailable()` on malformed JSON,
  incomplete nonempty data, framing limits or unsupported framing; call `result()`
  at delivery completion/cancellation. EOF never synthesizes a native terminal.
- Forward the original SSE bytes. The inspector retains only bounded block
  identities, never tool arguments, output, reasoning or signatures. It checks
  tool start/end identity, terminal reasons and cumulative counters. Its bound is
  4,096 blocks and 1,024 characters per tool ID/name; exceeding it invalidates
  accounting evidence rather than altering the upstream response.
- Pi input excludes cache reads/writes; normalized router input includes both.
  Require the reported total to agree. Native cost fields are not a router tariff
  and must not override policy pricing or a hard-budget preflight.
- `filterRadiusCatalog(document, trustedBaseUrl, allowedModelPredicate)` preserves
  the scoped native model metadata, excludes disabled models and rejects a
  catalog-selected credential origin. Operator qualification must precede any
  change to the trusted service origin.

The frozen OpenClaw client uses `GET https://radius.pi.dev/v1/config` and
`POST <qualified-base>/messages`. Integration should use `radius.messages` and
`radius.config` format IDs. The shared runtime owns framing, discovery policy,
credential materialization, byte forwarding and caller settlement; the registered Pi client bridge is exercised separately below. Synthetic
transport proof does not establish live service entitlement.

Sources: [Radius documentation](https://radius.earendil.com/docs) identifies the
API-key and account contracts. The wire and fixture comparison is pinned to
[OpenClaw's Radius stream](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/radius/stream.ts),
[catalog](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/radius/catalog.ts) and
[usage fixture](https://github.com/openclaw/openclaw/blob/31ad71a8addc1d42fbc5478f7e114860f5cbf6c7/extensions/radius/test-support.ts).
No login, account change, live call or secret provisioning is performed.

Run the focused codec and route checks with `node --test
worker/test/provider-radius.test.mjs worker/test/radius-provider.test.mjs
worker/test/radius-discovery.test.mjs`.

## Bundled provider declaration

`radius` declares native `messages` and `config` endpoints. `RADIUS_API_KEY` is
its organization API key; `RADIUS_MODEL` selects the configured model alias.
Native model passthrough remains unpriced. No OpenRouter key, direct Copilot
identity, static model capability or radius-reported dollar cost is substituted.

The Worker treats `radius.config` as metadata before usage delivery. Its existing
bounded reader accepts at most 2 MiB and 8,192 reads with fatal UTF-8/JSON parsing.
The original selected API-key grant, destination, caller and policy generation
are checked before dispatch and again after the complete read. Later policy may
narrow the original model set but cannot widen it. Disabled, hidden and duplicate
identities cannot escape the filter. Malformed catalogs fail closed; the response
is private/no-store and metadata never reserves or charges inference.

The catalog projection contains only `baseUrl` and `models`. Each model may retain
`id`, `name`, `enabled`, `reasoning`, `input`, `contextWindow`, `maxTokens`,
`thinkingLevelMap` and `cost`. Cost keeps the four native rates and
`tiers[].inputTokensAbove` plus those rates, not the client's derived
`tieredPricing`. Unknown root/model fields, embedded keys, headers and route
configuration are removed. Catalog rates remain informational, never Router
billing authority.

## Configured registered client proof

`test/openclaw-radius.test.mjs` runs the actual registered Radius `createStreamFn`
on pinned OpenClaw `d8bb939408aa4d2be7df0161748edb52ebf3b1fb`. Configure its
`pi-messages` model base as `<router>/v1/native/radius` and pass the selected Router
credential. The registered hook invokes the native guarded Pi adapter at
`<base>/messages`; it is not an OpenAI Chat adapter. Actual sanitization runs with
the captured Radius provider in a case-owned generation registry. Synthetic
signed thinking/tool history, fragmented text/thinking/tool output, terminal
cache counters, controlled errors and post-content caller cancellation are
checked with original acquisition, reader, closed, release, handler and source
completion joins. Independent failures remain fatal.

The explicit tenant model is opaque passthrough, not a fabricated bundled model
or entitlement. Its unknown tariff is denied under a strict dollar budget.
Separate transport cases explicitly use a synthetic seven-micro-dollar fixed
policy, prove one attempt-bound SQLite settlement, and ignore native monetary
hints. Model, credential and endpoint denials retain zero upstream egress and
zero charge; authenticated attempts retain bound receipts.

Automatic Radius catalog discovery and OAuth are not qualified by this configured
route. The pinned client still fetches upstream `/config` and uses its returned
base with its local Radius credential. Exposing that config through the Router
does not automatically select the Router for subsequent inference. A future
automatic route needs a trusted advertised Router base and client credential
binding; never derive that base from untrusted Host/forwarded headers or send a
Router credential to an upstream catalog base. No physical pre-header disconnect
or live-provider acceptance claim is made.

## Compatibility and deployment

The change adds metadata format admission and a closed response projection; it
adds no persistent schema, credential format, callback protocol or native payload
change. Existing grant lineage/generation and policy owners remain authoritative.
Tests cover original grants, rotation/revocation during reads, narrowing and
recovery by subsequent fresh requests. In-flight reads keep their original owner
and retire independently. No deployment, login, account activation or manual
release step is included.
