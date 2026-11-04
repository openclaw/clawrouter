# Public model catalog dispatch

The Worker selects an original owner-backed API-key grant for caller authority,
then uses the public catalog factories without passing that key or any prepared
inference headers. Environment credentials, legacy grants and alternate grant
transports cannot substitute for this original owner.

| Format | Caller route | Result |
| --- | --- | --- |
| `cerebras.public_catalog` | Manifest only | `{ providerId: "cerebras", catalog }` |
| `nvidia.public_catalog` | Manifest only | `{ providerId: "nvidia", catalog }` |
| `chutes.models` | Native or manifest when declared | Native Chutes list envelope |
| `venice.models` | Native or manifest when declared | Native Venice text-list envelope |

The aggregate formats are router metadata, not vendor-native endpoints. The
runtime and caller catalog enforce manifest-only exposure independently of a
snapshot's `native_proxy` flag. The compiler owns the finite declarations; this
runtime change adds no provider manifest or generated snapshot.

Each operation is bodyless GET with no caller query, path parameters, auth
override or mapped upstream path. Public factories own all physical URLs and
headers. NVIDIA makes exactly two requests under the same operation deadline.
Other public catalogs make one. Fresh empty NVIDIA inventory stays empty;
cached or featured metadata cannot revive it.

Before every physical request and after parsing, the Worker checks the verified
caller, current policy and the original credential owner without admission or
credential-cache substitution. The owner generation, lineage, account, provider
and kind must match the originally selected grant; disabled, revoked, expired or
unavailable owners deny the operation. Checks establish authority at that check,
not instantaneous revocation after the check and before network dispatch.

Published rows intersect the initially permitted compiled upstream IDs with the
current caller policy after the final check. A policy update can narrow this set
but cannot add models during the operation. Public observations preserve their
native units and unknown values. They do not establish account entitlement,
inference availability or a tariff. Metadata accounting retains the original
grant and a zero-cost metadata operation, never an inference charge.

The runtime tests exercise actual Worker routing, SQLite settlement, credential
exclusion, final policy tightening, original-owner revocation between NVIDIA's
requests, cancellation, fixed destinations and manifest-only catalog offers.
Featherless numeric pagination remains a separate keyed discovery contract.
