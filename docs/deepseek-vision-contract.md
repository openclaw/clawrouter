# DeepSeek vision and Chat contract

The four frozen identities are `deepseek-v4-pro`, `deepseek-v4-flash`,
`deepseek-flash` and `deepseek-v4-flash-vision-exp`. Router keeps Pro first and
retains every existing display name, price and native endpoint. The three Flash
identities declare text/image input; Pro declares text only. Unknown names gain
neither endpoint facts nor a price.

## Dated facts and reservations

The manifest records the 2026-11-03 Chat/vision contract and the existing
2026-09-23 peak-price upper bounds. Flash input/cache/output rates are
$0.30/$0.006/$1.20 per million tokens; Pro rates are $1.32/$0.044/$3.96.
They are conservative published upper bounds, not claims of the current price
charged to every account. Unknown image input reserves the full 1,048,576 input
token bound. The 393,216 output bound is the manifest's dated declaration;
SDK catalog defaults are separate facts.

Canonical Router efforts are `none`, `low`, `high`, `max`, default `high`.
Temperature is declared only with disabled reasoning. No blanket top-p support
or Search tariff/cancellation claim is added.

## Pinned registered-client configuration

The consumer pins OpenClaw `d8bb939408aa4d2be7df0161748edb52ebf3b1fb` and uses
its real registered DeepSeek static catalog, public Chat stream and registered
thinking wrapper. It sets the selected proxy key and custom provider base URL:

```json
{
  "models": {
    "providers": {
      "deepseek": {
        "api": "openai-completions",
        "baseUrl": "https://router.example/v1/native/deepseek",
        "models": [
          { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "input": ["text", "image"] }
        ]
      }
    }
  }
}
```

Use the selected Router credential through the client's supported credential
configuration. Router separately selects its upstream grant; neither SDK ambient
`DEEPSEEK_API_KEY` nor Router environment fallback may substitute for it.

This pin's default V4 Flash catalog row is **text only**. Its Flash alias and
experimental vision row already declare images. V4 Flash image transport is
therefore tested with an explicit model-input override; it does not change the
default-catalog difference at this pin. The pinned SDK declares 1,000,000 context / 384,000 output
and different catalog costs. None replace the Router's dated facts or pricing.

The registered wrapper maps `off` to `thinking.type=disabled` and removes
`reasoning_effort` and replay reasoning. It maps `max`/`xhigh` to wire `max`;
`low`, `high` and omitted effort produce wire `high`. The supported configured
route does **not** establish native `low` wire parity for D8.

Newer OpenClaw `cd2ae192` source already declares V4 Flash text/image input and
uses a provider-specific mapping: `minimal`/`low` to `low`,
`medium`/`high`/`xhigh` to `high`, and `max` to `max`. Pro remains the default
and text-only. These are source observations, not native results from this
D8-pinned consumer. No new client fix is implied; default-config qualification
at that newer pin and migration of persisted text-only overrides are separate.

## Proof boundary

The dedicated consumer keeps all 23 cases bound to the actual registered provider,
selected credentials, exact native/upstream path, model and single attempt.
Real sanitizer replay runs inside a case-owned captured-provider registry scope.
Synthetic thinking/tool history checks preservation through the actual sanitizer,
converter and SDK serializer; it is not live-vendor tool capability evidence.

Known models settle cached/uncached/output usage at the retained upper-bound
rates. Unknown models under strict dollar budgets, invalid/foreign credentials,
depleted budgets and excluded models must produce no upstream call. Authenticated
attempts require their own usage receipt and zero cost when denied.

Controlled API error and real post-content caller abort retain original
acquisition, read, closed, handler, release and source outcomes. Source cancellation
must return and join without expiry or pending work. Worker read disposition binds
the original reader and first logical caller-cancellation outcome; it does not
claim a physical native error cause. Independent failures, including falsey
rejections, remain fatal. This does not qualify physical pre-header disconnect
propagation or the separate DeepSeek Search route.

No live provider request, account activation or manual deployment is included.
