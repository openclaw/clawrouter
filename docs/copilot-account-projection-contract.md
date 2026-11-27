# Inactive Copilot account projection

`createCopilotAccountProjection()` returns a frozen pair of methods:

```ts
push(bytes: Uint8Array): void;
finish(): Readonly<{ endpoints?: Readonly<{ api?: string | null }> }>;
```

`push` consumes borrowed bytes synchronously and retains no input views. `finish`
returns a recursively frozen projection only after complete, valid EOF. Failure
poisons the instance. A second finish or any push after finish fails with the
same content-free `invalid_copilot_account_projection` error. The API does not
fetch, read a Response, authorize an owner, validate an origin or install tokens.

## Local operational policy

| Bound | Maximum |
| --- | ---: |
| Complete wire, including BOM and whitespace | 16 MiB |
| Container depth, root object at 1 | 64 |
| Containers | 512 |
| Object members, including duplicate keys | 2,048 |
| Aggregate array entries | 2,048 |
| Values, containers plus primitives, excluding keys | 4,097 |
| Projected API string, decoded UTF-16 units | 4,096 |

Every occurrence counts, including ignored metadata, unknown duplicate fields
and authority keys. Aggregate decoded key/string units and number scanning are
bounded by wire bytes; counters cannot exceed safe integer precision. The value
limit is reachable: 2,048 members plus 2,048 entries plus the root. Exceeding it
also exceeds a member or entry bound. These are local admission decisions, not
documented upstream maxima or claims about observed account payload sizes.

The root and any `endpoints` value must be objects. Missing `endpoints`, missing
`api`, `api: null` and `api: ""` remain distinct. An API string is neither trimmed
nor normalized. Root `endpoints` and its immediate `api` key may occur only once,
including escaped spellings. Unknown duplicate fields remain legal, and their
entire values are validated and counted. Authority duplicates are an explicit
local policy stricter than JSON's duplicate-last-value semantics.

The account-only scanner preserves JSON string escapes, including escaped lone
UTF-16 surrogates, and validates JSON number syntax without collecting or
interpreting numbers. UTF-8 must be well formed; overlong encodings, encoded
surrogates, truncation and out-of-range code points fail. One initial UTF-8 BOM
is stripped, consistent with native Response text decoding. BOMs elsewhere are
ordinary JSON data inside strings and invalid whitespace outside them.

## Declared retained representations

The parser allocates one 192-unit Uint16 stack (384 bytes) and one 4,096-unit
Uint16 projection buffer (8,192 bytes). Stack frames hold only grammar state,
authority scope and pending key role. UTF-8 state, escape/number/literal state,
key matching and resource counters are scalars. Matching uses only the fixed
`endpoints` and `api` strings. Ignored strings and numbers never accumulate.
There is no token vector, JSON AST, whole-wire copy or decoded text archive.

At successful finish, one bounded typed view and native argument vector produce
the final string of at most 4,096 UTF-16 units. The fixed buffers are cleared;
the closure retains their fixed backing storage. The returned projection adds
at most two frozen objects. No output is available before EOF, so a malformed
tail cannot release an earlier valid API string.

Tests verify these declared representations and behavior. They do not establish
engine object/header/string costs, total heap, cumulative transport allocation,
concurrency or a capacity charge. Empty pushes are permitted; this pure API is
not a transport read-count or deadline guard.

## Remaining internal integration

The existing `qualifyCopilotIdentity` in `worker/provider-copilot.ts` remains
authoritative for selected-domain fallback and approved URL/base-path handling.
This projection preserves its input distinctions, but does not call it or
confer credential, domain, account, entitlement or billing authority.

Account transport remains closed. Source1 still needs qualified Response I/O,
canonicalization allocation, original domain/account/token/generation checks,
and retention through fresh policy checks and publication, with an accepted
resource ledger and capacity charge. The catalog/device raw reader, identity
helpers, common runtime, manifests and actual client are unchanged.
