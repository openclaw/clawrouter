# Codex through ClawRouter

Use a policy-scoped ClawRouter key and an OpenAI Platform API grant. The shared
router supports native Responses HTTP, SSE, and explicitly qualified WebSocket
routes. This setup keeps normal Codex tools, approval settings, and model prompts.

## Export native model metadata

Codex needs its complete model descriptor, including instructions and service
tiers. A model name alone can select fallback metadata. Export the official
bundled descriptors through the authorized ClawRouter catalog:

```sh
export CLAWROUTER_API_KEY="<issued ClawRouter credential>"
node scripts/codex-catalog.mjs \
  --router-url https://router.example.com \
  --provider openai \
  --codex /path/to/codex \
  --output ./clawrouter-models.json
```

Use a Codex producer whose `codex debug models --bundled` contains the requested
models. Codex 0.155.0 includes Astra; the 0.153.0 bundle does not. Both engines
can consume the exported Astra descriptor. The helper preserves the producer's
instructions, context limits, and internal model metadata, changes only the
public model slug, and narrows paid tiers to the router's priced contract.
Missing descriptors are reported on stderr; the helper never invents prompts.
Stderr also records the producer version, input hashes, route mappings, and base URL.

The OpenAI export uses upstream slugs such as `gpt-6-astra` and
`gpt-5.6-luna`. This lets native internal model requests use the same provider
base. The documented `gpt-5.6` API alias uses Sol's descriptor. Refresh the file
after changes to the authorized router catalog or the producer's bundled models.

## Configure the client

Merge these settings into the user's Codex configuration. Keep existing sandbox,
approval, workspace, and tool settings. Set `model_catalog_json` to the absolute
path of the exported file on that machine, or a relative path beside the
configuration file. TOML does not expand shell variables in that path.

```toml
model = "gpt-6-astra"
model_provider = "clawrouter"
model_catalog_json = "/absolute/path/to/clawrouter-models.json"
model_reasoning_effort = "high"
service_tier = "priority"
web_search = "disabled"

[model_providers.clawrouter]
name = "ClawRouter"
base_url = "https://router.example.com/v1/native/openai/v1"
wire_api = "responses"
env_key = "CLAWROUTER_API_KEY"
requires_openai_auth = false
supports_websockets = true
```

Enable `supports_websockets` only when the authenticated catalog's Responses
route reports `websocket: "openai.responses"`. Alternate subscription transports
are not qualified for this bridge. HTTP/SSE remains available with the flag set
to false. The provider-native base also supports bare internal Sol, Terra, and
Luna requests; a unified, namespaced-only catalog does not cover those lookups.

`priority` requests Fast routing. In Codex 0.153.0 and 0.155.0, `default` disables
the Fast override but is omitted from the wire; upstream project defaults can
still apply. Direct API clients can send `service_tier: "default"` explicitly.
The upstream may serve a different tier; usage records contain both requested
and served values. Admission reserves a conservative priced envelope, and complete
terminal usage settles at the actual served tier. Missing tier or cache counters
retain the estimate. The monthly allowance is ClawRouter list-price accounting,
not a guarantee about the provider invoice. See [spend control](agent-spend-control.md).

For the macOS app, load the downloaded key file from the interactive shell that
its launcher reads. Add a loader to `.zshrc`, using the actual saved file path:

```sh
if [ -r "$HOME/.config/clawrouter/client-key.txt" ]; then
  export CLAWROUTER_API_KEY="$(cat "$HOME/.config/clawrouter/client-key.txt")"
fi
```

Fully quit and restart the app, then start a new thread. A Terminal export alone
does not change an already-running GUI process. `launchctl setenv` is an optional
session-only alternative that must be reapplied after login or reboot. Never put
an admin, upstream provider, or ChatGPT token in `CLAWROUTER_API_KEY`.

## Desktop account features and voice

The desktop frontend has account-dependent controls. A custom-key-only provider
does not establish a ChatGPT account for those controls. An optional hybrid
configuration sets `requires_openai_auth = true` while retaining the explicit
router `base_url` and `env_key`, and uses a genuine ChatGPT login in the app.
The router key still authenticates inference; a missing router key fails rather
than sending the ChatGPT token to ClawRouter.

The installed 0.153.0 app engine and 0.155.0 CLI are covered by isolated native
fixtures for account state, catalog loading, Lite payloads, priority forwarding,
and bearer ownership. Those fixtures do not prove the graphical Fast control,
microphone permission, or a particular account's entitlement. Desktop dictation
continues to use the app's OpenAI service and genuine ChatGPT account. ClawRouter
does not proxy dictation, speech, or the Realtime API through Responses WebSockets.

## WebSocket contract

Send authenticated upgrades to `/v1/responses` or
`/v1/native/openai/v1/responses`. Unified upgrades select their model on the first
`response.create`, so an HTTP 101 alone does not prove model access or upstream
readiness. Every create rechecks credential, policy, provider, grant, retention,
and budget before dispatch. The connection pins its provider route and grant
revision; changing either requires a new connection.

The bridge forwards native response IDs, errors, metadata, tool results,
`previous_response_id`, and `stream_options`. Prewarm `generate: false` requests
receive normal admission and accounting. It never replays requests or switches
grants after dispatch. A terminal response with usable usage settles once;
disconnects and deadlines without final usage retain the reservation.

Limits per connection are 16 active responses, 32 named lanes plus the default
lane, 48 buffered creates, 4 MiB per incoming frame, 8 MiB total buffered create
bytes, and 16 MiB cumulative downstream output. The output limit bounds a slow
reader because Workers' WebSocket API has no supported drain/queue metric.
Connections last at most 60 minutes; each response uses its endpoint deadline,
capped at 600 seconds. Clients must reconnect after a limit or deadline closes
the connection. Binary frames, steering events, and background execution are
rejected visibly. This contract runs on the Worker deployment; other hosts must
qualify native upgrade forwarding before advertising it.

## Other Responses providers

Azure OpenAI supports `/v1/native/azure-openai/openai/v1/responses` with an
explicit deployment model and `api-key` authentication. This v1 route does not
inherit the dated `api-version` used by legacy chat and embedding routes.
OpenRouter supports `/v1/native/openrouter/v1/responses`, preserving upstream
namespaced models such as `openai/gpt-6-astra`. These endpoints support HTTP/SSE;
they do not inherit OpenAI's WebSocket qualification or Codex metadata.

Unknown deployments and routing aliases have no invented prices or model
descriptors. A policy or provider budget requires declared pricing or an explicit
fixed policy tariff. For concrete provider models, both `/v1/models` and `/v1/catalog` apply the same selected
policy, provider budget, and eligible grant transport. Verify the chosen upstream
account and model before use.

Follow-ups: Fusion discovery budget eligibility still uses the existing compound
readiness path; this change does not extend the concrete-model projection to it.
OpenAI hosted-tool admission and fee accounting remains separate.
The setup disables hosted web search because token rates do not cover its tool
fees or provider-added search input. The existing 15-minute reservation lease
also remains a boundary for long-running HTTP streams.

Sources: [Codex custom providers](https://developers.openai.com/codex/config-reference),
[Responses WebSockets](https://developers.openai.com/api/docs/guides/websocket-mode),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing), and the official
[Codex 0.153.0](https://github.com/openai/codex/tree/rust-v0.153.0) and
[0.155.0](https://github.com/openai/codex/tree/rust-v0.155.0) source contracts.
