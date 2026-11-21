# Copilot JSON preparse admission

`inspectCopilotJsonText(text, profile)` accepts only `catalog` or `device` and
returns frozen scalar statistics: `utf8Bytes`, `depth`, `values`, `containers`,
`members`, `arrayEntries`, and `decodedStringUnits`. It finishes whole-envelope
tokenization and resource validation before the caller can invoke `JSON.parse`.
It does not construct an AST, project facts, authorize a credential, or acquire or
release capacity. There is no account profile.

| Operational bound | Catalog | Device |
| --- | ---: | ---: |
| UTF-8 bytes | 2,097,152 | 8,192 |
| Maximum container depth, root 1 | 64 | 4,096 |
| Containers | 32,770 | 4,096 |
| Members | 131,072 | 4,096 |
| Array entries | 131,072 | 4,096 |
| Values | 262,146 | 8,192 |
| Aggregate decoded key/string UTF-16 units | 2,097,152 | 8,192 |

Values count containers and primitive values, excluding keys. Members and array
entries count every occurrence across the complete envelope. Decoded string units
include keys, escaped text, overwritten duplicate values, excluded rows and all
discarded metadata. Primitive roots have depth 1; container nesting retains the
catalog decoder's existing depth convention.

The byte pass uses scalar UTF-8 sizing without a whole encoded copy. The existing
tokenizer receives at most 1,024 UTF-8 bytes per feed, preserving raw surrogate
pairs. It uses `packValues: false`; the guard retains only numeric counters and a
bounded container stack. It does not archive tokens or collect string values.
Each tokenizer feed still materializes a bounded token vector before callbacks.

These limits apply together. Some individual ceilings cannot be reached by valid
JSON before another bound rejects it: catalog members plus array entries permit
at most 262,145 values; the device byte cap prevents reaching several larger
structural ceilings. Tests cover reachable exact/+1 boundaries and these combined
constraints without a test-only override. Limits are operational policy, not
documented provider maxima or evidence of retirement or entitlement.

The device profile deliberately allows deep earlier values overwritten by later
scalar fields. It does not replace JSON duplicate-last-value semantics with a
flat-object rule. Final field/scalar validation remains in the existing device
codec. Byte-limit precedence, HTTP-status precedence and existing decoder error
messages remain unchanged. The guard itself emits content-free `RangeError`
(`copilot_json_limit`) or `SyntaxError` (`invalid_copilot_json`).

Catalog normalization, 19 frozen model-format fixtures, ID bounds, authoritative
empty results, visibility filtering and unknown facts retain their existing
contracts. The raw response reader and identity helpers are unchanged.

## Capacity remains separate

Statistics and preparse rejection are not AST-heap qualification. The caller
still owns admission and retirement through source text, tokenizer scratch,
parsed objects/strings, projection, fresh authority/policy checks and publication
or discard. No charge, pool limit, account transport or activation is added here.
The guard cannot authorize dropping a lease at tokenization or upstream EOF, or
assume that discarded allocations have already been reclaimed.
