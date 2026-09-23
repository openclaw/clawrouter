# Codex through ClawRouter

Use a policy-scoped ClawRouter key and an OpenAI Platform API grant. The shared
router supports native Responses HTTP, SSE, and explicitly qualified WebSocket
routes. This setup keeps normal Codex tools, approval settings, and model prompts.

## Connect the CLI

From a ClawRouter checkout with its dependencies installed, create a separate
Codex CLI profile. Export the issued client key in the shell that will launch
Codex; the setup command does not store it or edit shell startup files.

```sh
export CLAWROUTER_API_KEY="$(cat /path/to/client-key.txt)"
pnpm codex:connect connect \
  --router-url https://router.example.com \
  --provider openai --model gpt-6-astra --service-tier priority \
  --codex /path/to/codex --dry-run
# Repeat without --dry-run to apply the displayed field changes.
# Run the returned launch command; it preserves --codex and --codex-home.
/path/to/codex --profile clawrouter
```

This creates `$CODEX_HOME/clawrouter.config.toml` and a complete native catalog
beside it. The default home is `~/.codex`. Use `--profile NAME` or
`--codex-home DIR` to choose another installation. Codex 0.153.0 and 0.155.0 load
separate `<name>.config.toml` profile files over the base configuration;
`[profiles.NAME]` is not the supported format. Existing profiles are never
adopted or overwritten by `connect`. The base `config.toml`, `auth.json`, sandbox
and approval settings, and key file stay unchanged. This command configures the
CLI; Desktop uses the shared root configuration described below.

The profile selects the requested upstream model and the router's native
provider URL. It disables hosted web search and enables WebSockets only when
the authorized catalog qualifies that route. `--service-tier` defaults to
`default`; request `priority` explicitly for Fast. A missing native descriptor
or unqualified priority tier fails before installation. Use a producer that
contains the selected model, such as Codex 0.155.0 for Astra.

```sh
pnpm codex:connect verify --codex /path/to/codex
pnpm codex:connect update --codex /path/to/codex --dry-run
pnpm codex:connect update --codex /path/to/codex
pnpm codex:connect remove --dry-run
pnpm codex:connect remove
```

Pass the same profile/home options on each command when using non-default
paths. `verify` checks catalog access with the issued key, native metadata
freshness, and owned profile settings. It makes no inference requests and does
not prove that an upstream account can serve the model. Managed requirements,
project settings, and command-line overrides still apply when Codex starts.
`--key-file PATH` can supply the key to a setup command without changing that
file; subsequent Codex processes still need `CLAWROUTER_API_KEY` exported.

`update` writes a complete nonempty catalog generation before atomically
switching the profile and its ownership receipt. Failed preparation leaves
the previous profile and catalog usable. Earlier catalog generations stay
available until `remove`, so a concurrently starting client can finish loading
the profile it already read. Restart Codex after an update; running
clients do not reload the static catalog. Changes and dry-run summaries list
field names and catalog hashes, never keys or model instructions.

The profile's first comment is an ownership receipt; keep it intact. Updates
preserve user-added fields and comments and refuse changed owned fields.
To change connection settings, remove and reconnect. `remove` deletes only
unchanged owned fields and catalog files; modified fields/files remain and
are reported. If the user changes the catalog pointer, all published catalog
generations remain available for that retained reference. It keeps unrelated
additions and does not revoke the key. An empty generated provider table is
removed; user-added provider settings retain the required provider name.
Credential revocation is a separate operator action through the admin UI or
`pnpm cf:key:revoke -- --kid <credential-id>`. If an interrupted process leaves
a profile lock directory, check that no setup command is still running before
removing that named lock.

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

Merge these settings into the shared user configuration, `$CODEX_HOME/config.toml`
(default `~/.codex/config.toml`). CLI and Desktop instances using the same directory
share this base; profiles can override it. Project configuration cannot select a
different provider. Keep existing
sandbox, approval, workspace, and tool settings. Set `model_catalog_json` to the absolute
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

HTTP/SSE and WebSockets bind returned response IDs and Codex turn state to their original
credential owner. A 409 `continuation_restart_required` requires a fresh request
with full input and no continuation fields; another account cannot resume that
state. Unknown or expired identities, including state created before this router
upgrade, are rejected before upstream dispatch. Owner-controlled refresh keeps
the binding, while explicit credential replacement requires a restart. Stateless
requests and known environment/API-key continuations remain supported. See
[Responses continuation limits](api-reference.md#responses-continuation-contract).

`priority` requests Fast routing. In Codex 0.153.0 and 0.155.0, `default` disables
the Fast override but is omitted from the wire; upstream project defaults can
still apply. Direct API clients can send `service_tier: "default"` explicitly.
The upstream may serve a different tier; usage records contain both requested
and served values. Admission reserves a conservative priced envelope, and complete
terminal usage settles at the actual served tier. Missing tier or cache counters
retain the estimate. With both budgets disabled, undeclared request tiers can
forward; unknown final prices are marked unavailable rather than reported as free.
The monthly allowance is ClawRouter list-price accounting,
not a guarantee about the provider invoice. See [spend control](agent-spend-control.md).

For the macOS app, load the downloaded key file from the interactive shell that
its launcher reads. Add a loader to `.zshrc`, using the actual saved file path:

```sh
if [ -r "$HOME/.config/clawrouter/client-key.txt" ]; then
  export CLAWROUTER_API_KEY="$(cat "$HOME/.config/clawrouter/client-key.txt")"
fi
```

After regenerating the catalog or changing providers, fully quit and restart the
app, then start a new thread. A Terminal export alone
does not change an already-running GUI process. `launchctl setenv` is an optional
session-only alternative that must be reapplied after login or reboot. Never put
an admin, upstream provider, or ChatGPT token in `CLAWROUTER_API_KEY`.

## Desktop account features and voice

CLI and engine priority forwarding is separate from the Desktop Fast control.
The installed Desktop clears Fast in custom-key-only mode
([upstream report](https://github.com/openai/codex/issues/43635)). Desktop Fast requires
a genuine ChatGPT login, a catalog model advertising priority, and permission
from any managed `fast_mode` requirements. An optional hybrid
configuration sets `requires_openai_auth = true` while retaining the explicit
router `base_url` and `env_key`, and uses a genuine ChatGPT login in the app.
The router key still authenticates inference; a missing router key fails rather
than sending the ChatGPT token to ClawRouter.

The installed 0.153.0 app engine and 0.155.0 CLI are covered by isolated native
fixtures for account state, catalog loading, Lite payloads, priority forwarding,
and bearer ownership. Graphical validation was blocked by the Computer Use native
pipe, so those fixtures do not prove the graphical Fast control, microphone
permission, or a particular account's entitlement. Desktop dictation
continues to use the app's OpenAI service and genuine ChatGPT account. ClawRouter
does not proxy dictation, speech, or the Realtime API through Responses WebSockets.

The isolated native fixture also exercises synchronous Guardian approval with
the official catalog, a key-only loopback provider, and a prompt-approved
synthetic MCP echo. On both 0.153.0 and 0.155.0, the native reviewer selected
`gpt-6-astra`: an allow decision invoked the tool once; a deny decision invoked
it zero times. Review notifications matched the target call, thread, and turn.
These cases emitted no Luna classifier traffic and do not qualify asynchronous
Guardian scoring, genuine upstream review decisions, or the Desktop UI.
No ChatGPT login or user approval RPC is fabricated for these tests.

To run the opt-in fixtures, set `CLAWROUTER_CODEX_BINARY` to the official binary
and `CLAWROUTER_CODEX_CATALOG_BINARY` to a 0.155.0 catalog producer, then run
`node --test test/codex-native.test.mjs`. Ordinary script tests skip native cases when
the binary is absent. Each case removes its temporary home and loopback server.

`node --test test/codex-router.test.mjs` also runs those engines through the actual
Worker, authority, and SQL budget/usage ledgers with an isolated synthetic
upstream. It covers credential-scoped metadata discovery, HTTP and WebSocket
priority requests, a tool continuation, two turns, cancellation during active response
delivery, upstream shutdown, and settlement in both ledgers. It also verifies a
fresh turn after interruption, same-ID proxy-key rotation across native processes,
and revocation before the next turn. CI downloads checksum-pinned official Linux
engines for 0.153.0 and 0.155.0; neither case needs an account or paid upstream call. This qualifies
native engine routing, not macOS Desktop UI behavior or live model quality.
The cancellation case requires upstream shutdown before the native idle timeout.
It does not qualify stalled HTTP/1 streams: ordinary socket closure and native
interruption with no further upstream output left the fixture reservation
unsettled at five seconds. An explicit TCP reset did propagate an ingress abort
and cancellation receipt. Codex 0.153 also waits for the next recognized SSE
event to notice a dropped consumer. Stalled-stream shutdown and deployed protocol
behavior, including HTTP/2, still require qualification.

## WebSocket contract

See the [Responses WebSocket contract](api-reference.md#websocket-contract) for
per-create authorization, accounting, continuation, and connection limits.

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

Fusion discovery applies the same Chat model eligibility to its configured
synthesizer and advisers; unavailable advisers remain optional.
Hosted search is rejected before dispatch under measured policy or provider
budgets unless a fixed policy tariff is configured. Full hosted-tool fee metering
remains separate. Keep this setup's hosted web search disabled: token rates do not
cover its tool fees or repeated search input. Dispatched requests retain their
budget charge across the 15-minute admission lease; late settlement uses the
original ledger receipt within its 45-day retention period.

Sources: [Codex custom providers](https://developers.openai.com/codex/config-reference),
[Responses WebSockets](https://developers.openai.com/api/docs/guides/websocket-mode),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing), and the official
[Codex 0.153.0](https://github.com/openai/codex/tree/rust-v0.153.0) and
[0.155.0](https://github.com/openai/codex/tree/rust-v0.155.0) source contracts.
