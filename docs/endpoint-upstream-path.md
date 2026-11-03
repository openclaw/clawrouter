# Endpoint dispatch paths

The optional YAML field `endpoints.<id>.upstreamPath` compiles unchanged to
`CompiledEndpoint.upstreamPath?: string`. `path` remains the caller's native
route and authorization identity. Manifest endpoint IDs, unified routes,
capabilities, selected model, policy and original credential do not change.

The first runtime slice accepts `openai.chat_completions`, `anthropic.messages`,
`openai.models` and `anthropic.models`. Request and response formats must match;
Chat/Messages use POST and metadata uses GET. WebSockets, lifecycle endpoints,
path parameters and other native formats are not qualified by this field.
Mapping does not translate request or response formats.

The value is a literal path of at most 2,048 characters. Each nonempty segment
contains only ASCII letters, digits, `.`, `_`, `~` or `-`; `.` and `..` segments
are forbidden. URLs, double slashes, trailing slashes, percent escapes,
backslashes, query strings, fragments and templates are rejected. No caller
input supplies or substitutes this value. A configured grant transport may omit
its endpoint override or repeat exactly the same path; a conflicting override
fails before egress.

Composition retains existing base semantics: remove one trailing slash from the
selected configured base, then append the literal path. The resulting URL must
retain that base's origin and exact path prefix. A base containing credentials,
query or fragment is rejected. This adds no origin selection or credential
fallback. Inference query parameters are rejected; model discovery retains its
existing bounded, policy-filtered pagination fields only.

For a provider configured at `https://api.synthetic.new`, public Chat
`path: /v1/chat/completions` can dispatch with
`upstreamPath: /openai/v1/chat/completions`; public Messages `/v1/messages` can
dispatch to `/anthropic/v1/messages`, and `/v1/models` to `/openai/v1/models`.
These are the [documented API prefixes](https://dev.synthetic.new/docs/api/overview).
The same configured original server credential owns all three operations.

The runtime tests use a synthetic provider through native and manifest routes,
both environment and pooled credentials, actual policy admission and SQLite
accounting. They cover unchanged caller paths and wire bodies, metadata
filtering, revoked grants, malformed mappings and conflicting transport paths.
Metadata still requires a scoped API-key grant; mapping does not turn an
environment inference key into discovery permission.
Central schema/compiler validation belongs to its existing owner; Synthetic
YAML and activation belong to the provider owner. This PR changes neither.
