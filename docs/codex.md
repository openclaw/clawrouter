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
CLI; Desktop uses the explicit root target described below.

The profile selects the requested upstream model and the router's native
provider URL. Each exported model needs an eligible native HTTP Responses offer
in the issued key's catalog. Provider readiness, session access, and model-less
operation forms do not qualify a model. Use a router version that publishes
operation offers; older catalogs fail setup before any files change.

By default the profile disables web search and enables WebSockets only when every
exported model has a matching WebSocket offer for the same endpoint, route,
policy, and generation. Codex applies that flag to the whole provider, including
internal models. Catalog observations do not reserve budget or probe upstream;
token-priced offers remain request-dependent, and dispatch checks access and
budget again. `--service-tier` defaults to
`default`; request `priority` explicitly for Fast. A missing native descriptor
or unqualified priority tier fails before installation. Use a producer that
contains the selected model, such as Codex 0.155.0 for Astra.

## Opt in to built-in CLI web search

With Codex CLI 0.163.0 or newer, add `--web-search live` or `--web-search cached`
to `connect`. Qualification covers the models below, HTTP and WebSocket
inference, and text search/navigation (`search_query`, `open`, `click`, `find`). The helper
enables `supports_standalone_web_search` and narrows the
exported catalog to eligible standalone-search models. WebSockets follow the
authorized inference offers; search uses unary HTTP in either case. Search stays disabled
without this option. Desktop, media commands, feeds, and account-pool failover
are outside this qualification.

Qualification against the public API with Codex CLI 0.163.0 on 2026-10-22
passed search, open,
click, find, a cited answer, and resume opening the exact original search
reference for each model. The matrix includes cached search with WebSocket
inference:

- `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`.
- `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.

Enablement is declared per model; forwarding, session ownership and accounting
share one implementation. The helper also requires the native Codex descriptor
to use Responses Lite. Models outside this list, including `gpt-5.5`, remain
unqualified for this standalone integration.

```sh
pnpm codex:connect connect --profile clawrouter-search \
  --router-url https://router.example.com --provider openai \
  --model gpt-6-astra --web-search live
```

The key's policy must declare a fixed search tariff, and the route must resolve
to one public OpenAI API account without fallback. Prefer a capability tariff:

```json
{"requestCostMicros":null,"requestCostsMicros":{"search.web":1000}}
```

This example charges 1,000 microUSD per standalone search request while inference
uses model token rates. Configure it through the policy API, the admin policy
form, or `cf:key:put --request-costs-micros '{"search.web":1000}'`. Capability
prices override the legacy policy-wide `requestCostMicros`, including explicit
zero; unspecified capabilities retain the legacy tariff or manifest pricing.
Omitted capability maps survive policy API updates; `null` clears the map. Free
counting/discovery/moderation operations remain free.

These are configured router charges, not measured upstream bills. Standalone
responses currently lack qualified usage data. Ordinary model token rates and
hosted Responses search fees do not price this endpoint. A legacy policy-wide
fixed tariff still works, but applies to inference too.

Codex sends search commands to `/v1/alpha/search` relative to its provider base.
ClawRouter forwards them through `/v1/native/openai/v1/alpha/search`, isolates
session IDs by caller, and stores one metadata owner binding per session.
Results, references, ciphertext, and citations pass through unchanged. Search
state stays upstream. Owner changes require a fresh Codex session; resuming an
old session cannot migrate its references to another account. Local bindings
use the existing bounded 30-day continuation store; this does not promise an
upstream reference lifetime. Invalid upstream references can return HTTP 200
with a tool error in the output. Domain filters restrict search results and
must not be treated as an egress allowlist for explicit page opens.

`verify` and `update` retain the selected search mode and refuse a lost eligible
offer. Remove and reconnect to change modes. Workspace and managed Codex search
restrictions still apply. Standalone search remains under development upstream;
see the [official search documentation](https://learn.chatgpt.com/docs/web-search).

The live qualification harness runs an isolated local workerd instance and real
Codex CLI sessions. Inject `OPENAI_API_KEY` through the credential helper, then run:

```sh
CLAWROUTER_SEARCH_LIVE=1 node scripts/smoke-codex-search.mjs \
  --model gpt-6.1-sol --switch-model gpt-6-astra \
  --web-search cached --transport websocket --compact
```

It checks the selected upstream models, search/open/click/find, a cited answer,
and resume opening the exact original reference. `--compact` lowers Codex's
automatic threshold and requires a completed native compaction record followed
by reuse of the reference. For this custom provider, native automatic compaction
uses inference by default; this test does not enable remote `/responses/compact`.
Model changes between Astra and Sol preserved references in both directions.

`--origin-check` additionally starts an ephemeral public synthetic page through
`cloudflared`, counts page and robots requests, and asks native search
to retrieve a marker that was never given to the model. Readiness uses a separate
URL and verifies public DNS and HTTPS. No production deployment or account
configuration changes are made. The tunnel and server close at teardown.

Defaults are `gpt-6-astra`, live search, and HTTP inference. Each invocation makes
at most 32 upstream operations and caps each inference output at 4096 tokens.
WebSocket qualification rejects silent HTTP fallback. Logs contain protocol
metadata only; temporary Codex homes are removed. Cached mode forwards
`external_web_access=false`.

Controlled-origin checks on 2026-10-22 remain **unqualified**: with Sol, both
cached and live mode returned upstream HTTP 200 with an `Internal Error` in the
tool output, made no page or robots requests, and failed to return the hidden
marker. The public origin had passed DNS and HTTPS readiness, including an
explicit robots allow rule. Since the live control also failed, this does not
establish whether cached mode forbids origin fetches. Treat it as a preference,
not a strict cache-only guarantee. `--origin-only` isolates this check and exits
nonzero when retrieval cannot be qualified; a normal workflow's `qualified`
result does not qualify its optional `originCheck`.

Direct-API reproductions, unresolved billing terms, deterministic regressions,
and the proposed canary/rollback checks are recorded in the
[search rollout candidate](codex-search-rollout.md). `--origin-only --direct-replay`
compares the native forwarded request with direct API requests; these bypass
router billing. The native harness separately verifies usage receipts and both
policy/provider SQL budget ledgers for routed operations.

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

## Connect Desktop

Fully quit Desktop before `connect`, `update`, or `remove`. These commands edit
`$CODEX_HOME/config.toml`, which also supplies defaults to CLI sessions without
a named profile. They preserve authentication files, sandbox and approval
settings, reasoning effort, existing tier preferences, and unrelated config.

```sh
pnpm codex:connect connect --target desktop \
  --router-url https://router.example.com \
  --provider openai --model gpt-6-astra \
  --codex /path/to/codex-0.155 --dry-run
# Review the field changes, then repeat without --dry-run.
pnpm codex:connect verify --target desktop --codex /path/to/codex-0.155
pnpm codex:connect update --target desktop --codex /path/to/codex-0.155
pnpm codex:connect remove --target desktop
```

Use `--codex-home DIR` consistently if Desktop uses another home. `--codex`
selects the metadata producer; it does not replace the app's embedded engine.
Desktop does not accept `--profile` or `--service-tier`. The installed app's
API-key mode clears Fast even when an existing root preference requests priority.
Use the CLI profile workflow when you need to request priority through ClawRouter.

The root file's first comment records the original value or absence of each
owned routing setting. Keep that receipt intact. A dedicated provider collision
or active legacy profile selector fails explicitly. Existing unrelated providers
and profiles remain; ordinary and inline provider tables are supported.
`update` refuses changed owned fields. `remove` restores model, provider, catalog,
and hosted-search settings together only when all still match the installation.
On a conflict it preserves the whole connection and reports the field names.
User-added provider settings survive with their required name; an edited inline
provider stays intact with its catalog generations. Removal does not revoke keys.

One root lock coordinates setup commands. Rereading before replacement detects
observed edits; it cannot lock out an unrelated editor or running app. Keep the
app closed during changes. Catalogs are installed before the atomic root-config
switch, and failed preparation keeps the previous configuration usable.

Export the key from the actual interactive login shell that the macOS launcher
reads. For zsh, add a loader to `.zshrc` using the saved key file's real path:

```sh
if [ -r "$HOME/.config/clawrouter/client-key.txt" ]; then
  export CLAWROUTER_API_KEY="$(cat "$HOME/.config/clawrouter/client-key.txt")"
fi
```

The setup command does not edit shell startup or `launchctl` state. A Terminal
export does not change an already-running app. Fully quit and restart Desktop,
then start a new thread. Never put an admin, upstream provider, or ChatGPT token
in `CLAWROUTER_API_KEY`; use only the issued router client key.

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

## Configure the CLI manually

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

## Desktop account features and voice

CLI and engine priority forwarding is separate from the Desktop Fast control.
The inspected macOS build 26.901.22334 (7746), with embedded Codex 0.153.0,
clears Fast in API-key mode ([upstream report](https://github.com/openai/codex/issues/43635)).
Its account gate sends `serviceTier: null`; changing the root priority preference
does not bypass that gate. Setup keeps `requires_openai_auth = false` and the
explicit router `env_key`. It does not fabricate a ChatGPT account or change the
provider's authentication requirement to expose an account-only control.

The installed 0.153.0 app engine and 0.155.0 CLI are covered by isolated native
fixtures for account state, catalog loading, Lite payloads, priority forwarding,
and bearer ownership. Root setup fixtures separately check config/account reads
and connect/update/remove through synthetic native turns, including the GUI's
null-tier request shape. Native fixtures do not prove the graphical controls,
microphone permission, or an account's entitlement. Desktop dictation uses a
separate authenticated OpenAI `/transcribe` request. Dictation and Realtime remain
unqualified by this setup; Responses WebSockets do not proxy those voice services.

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
