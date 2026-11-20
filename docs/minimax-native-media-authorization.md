# MiniMax global speech authorization

Native MiniMax speech needs a global native-media API key for
`https://api.minimax.io/v1/t2a_v2`. An existing MiniMax Chat grant, an Anthropic
OAuth login, a Token Plan subscription, or a CN account does not establish that
permission. The router cannot determine the product from a key prefix.

This foundation wires the bounded native speech response reader and credential
check. It does not add a provider declaration, generated snapshot, live grant,
or account permission. The eight existing codec models remain the finite input
contract. Their native-media dollar tariff is unknown: hard upstream-dollar
budgets deny dispatch. An explicit `policy_fixed` charge remains separately
labeled; native character counts and audio duration are diagnostics, not invoices.

## Authorize a stored credential

An administrator must verify the account's global native speech product before
using the existing authenticated grant API:

`PUT /v1/admin/upstream-grants/policies/<policy>/<grant>`

Include `nativeMediaAuthorization: "minimax-global-speech"` with the actual
`kind: "api_key"` scalar `credential`. The owner records the product, global
region, exact origin, speech operation and credential slot. This first slice
rejects credential bundles, access/refresh tokens and subscription records,
even when the generic provider credential selector could use one of them.
The API returns the secret-free `nativeMediaBinding` or `null`.

- Omission preserves authorization only for the same owner credential, account,
  provider and kind. A label-only edit preserves that identity.
- `nativeMediaAuthorization: null` removes authorization.
- Changing the credential or account clears authorization unless the same
  explicit administrator operation renews it.
- `?mode=replace` always requires renewed authorization, including same-key
  replacement. OAuth completion and pool replacement do not inherit it.
- Raw `nativeMediaBinding` or `nativeMediaIntent` fields are rejected by the
  public admin mutation. Legacy import and arbitrary metadata cannot attest.

There is no migration or automatic backfill. Existing grants remain closed.
Use the normal administrator authentication; a caller proxy key cannot perform
this mutation. No credential should appear in logs, screenshots or support data.

## Explicit server environment binding

Environment dispatch is separately opt-in. The selected source must be exactly
`MINIMAX_API_KEY`; another key, an earlier configured alias, or a selected stored
grant cannot borrow its permission. Server configuration may provide
`CLAWROUTER_MINIMAX_NATIVE_MEDIA_BINDING` as this exact JSON object:

```json
{
  "version": "clawrouter.native-media.v1",
  "product": "native-media",
  "region": "global",
  "origin": "https://api.minimax.io",
  "operation": "minimax.speech",
  "credentialKind": "api_key",
  "credentialSource": "MINIMAX_API_KEY",
  "credentialSha256": "<64 lowercase hex characters for the selected credential>"
}
```

The fingerprint is SHA-256 of the exact UTF-8 API-key bytes. An operator must
renew this configuration when rotating the key. Unknown fields, versions,
regions, origins or mismatched fingerprints deny dispatch and public offer eligibility.
The same fingerprint qualification also partitions isolate and colo discovery
caches, so a rotated key cannot reuse an old eligible environment offer. This documentation
does not authorize changing live secrets or granting account permissions.

## Final dispatch check

The selected stored credential is pinned before reservation. After body,
retention and budget dispatch acknowledgements, the Worker reads its credential
owner directly under the request deadline. It compares enabled/revoked state,
product binding, generation, lineage and account to the already-selected
credential. Admission caches, shared colo snapshots and credential caches are
not authority for this final check. `materialize.expectedGeneration` is not used
as an equality guarantee. Owner unavailability or mismatch denies egress without
refresh, reselection or an environment fallback. Environment dispatch similarly
rechecks the selected source, binding and credential fingerprint.

No asynchronous work occurs between completion of this check and provider
fetch. This is **fresh at the check**, not globally instantaneous revocation
across the owner-reply-to-fetch interval. The implementation does not introduce
owner-serialized dispatch. It intentionally adds a foreground owner read only
for this qualified native-media operation; unrelated providers retain their
existing cache and credential behavior.

Known-unsent failures settle as unsent. Once provider dispatch starts, invalid,
partial, canceled or failed responses retain conservative accounting and never
replay. The source-owned reader admits complete bounded native JSON/hex audio;
its 32 MiB response lease charges 64 MiB of the existing capacity budget.
