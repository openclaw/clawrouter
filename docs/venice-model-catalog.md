# Venice native text model catalog

This focused leaf covers the refreshable text catalog from frozen OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`. It adds no provider endpoint, model
card, shared runtime/compiler/client wiring, media registry or generated snapshot.

## Frozen and primary contract

Frozen `extensions/venice/models.ts` selects strict discovery with no upstream
authentication. `openclaw.plugin.json` has 19 finite Chat identities. The fixtures
preserve every exact ID; no newer generation, compatibility alias or trait is
added. Frozen inferred name-based reasoning, synthetic 128000/4096 limits and
zero cache-price defaults are deliberately not treated as native facts.

Primary evidence checked on 2026-11-03:

- [List Models](https://docs.venice.ai/api-reference/endpoint/models/list)
  documents text-filtered GET `/models`, the native envelope and nested metadata.
- The official [OpenAPI source](https://github.com/veniceai/api-docs/blob/main/swagger.yaml),
  observed blob `37c318af208e3c2e9e46330e7cdde7ab4abfd4c0`, explicitly declares
  `/models` security alternatives `{}` and `BearerAuth`. This primary operation
  establishes anonymous access despite rendered examples showing Bearer headers.
- The same source describes independent USD/DIEM input, output and cache rates,
  plus extended rates above a context-token threshold for the entire request.
- [Deprecations](https://docs.venice.ai/overview/deprecations) distinguishes
  scheduled retirement from later upstream routing or HTTP 410 outcomes.

One anonymous, bounded GET `/models?type=text` returned HTTP 200, 172646 bytes,
`{data,object,type}` and 139 text rows. All 19 frozen IDs were present. No sampled
frozen row had a deprecation object or `offline:true`. Inventory presence does
not prove access, independent continued service or a selected account's price.
No credentials, paid inference, billing or account endpoint was used.

## Published exports

`worker/venice-model-catalog.ts` exports:

- `VENICE_MODELS_FORMAT = "venice.models"`.
- `veniceCatalogRequest(base, signal): Request`, with **no credential argument**.
- `filterVeniceModels(payload, allows): VeniceModelCatalog`.
- `readVeniceModels(response, signal, allows)`.

The request fixes canonical `https://api.venice.ai/api/v1/models?type=text`, GET,
Accept JSON, credential omission, redirect rejection and the supplied abort
signal. Alternate bases, paths, ports, userinfo, query overrides and fragments
are rejected. It never attaches an inference key, wallet signature or caller key.

The parser requires a native text-list envelope with at most 4096 unique bounded
IDs. Explicit non-text rows are excluded, including image, video, decision,
embedding and speech. Invalid roots, pagination, model markers or identities
fail closed. Exact original-policy filtering remains a caller-supplied predicate.
Empty results do not restore seeds, substitute providers or resolve traits.

Only named observations survive: positive integer context/output limits, explicit
boolean Chat capability flags, offline state, vendor-declared private/anonymized
classification, canonical dated deprecation and selected price fields. Explicit
`offline:true` is excluded. Optional unsupported metadata remains unknown; no
reasoning-effort enumeration, TEE/E2EE attestation or account eligibility is inferred.
The two limit fields remain independent without frozen caps or fallback clamping.

Rates retain their native independent currency fields. No unit arithmetic, DIEM
conversion, account discount, cache default or executable tariff is generated.
Extended observations retain their threshold and their own partial cache fields;
missing rates never borrow from the base. A malformed extended threshold removes
the entire pricing observation, so base rates cannot appear to cover long context.

Deprecation is preserved as a dated observation. An elapsed date alone does not
identify the replacement or distinguish upstream aliasing from HTTP 410. This
codec does not make either claim, revive stopped IDs or authorize a route.
Model-source URLs, traits, reseller discounts and unknown fields are omitted.

The reader reuses the existing complete 2 MiB native JSON guard: only HTTP 200,
JSON MIME, valid UTF-8, correct length and EOF produce a result. Ranges, redirects,
truncation, malformed responses and abort fail closed without credential retry
or raw upstream text. Native `.ts` runtime imports have a real Node load regression.

## Concrete owner handoffs

Source1 owns private caller authorization, original-grant selection/filtering,
stopped/alias eligibility, scan/byte/deadline limits and cache scope. Public
upstream access does not make router discovery public. The dispatcher must call
the no-credential request helper. Past deprecation dates require the existing
qualified model availability/serving-identity path before executable offers;
metadata alone must not advertise an unqualified replacement or bypass a stop.

Source3 owns paired `venice.models` validation for explicit bodyless GET `/models`
on the canonical base. Keep provider Bearer configuration for original local
grant selection; no endpoint auth override or public caller flag. The fixed
`type=text` query belongs to the helper, not caller-controlled query forwarding.
Actual published compiler/runtime work and Worker proof precede source4's later
discovery endpoint declaration and the finite card slice.

Source2 owns actual client catalog/native replay, including model-specific tool
compatibility, without inferred zero prices or native limit fallbacks. Source6
owns later snapshot and composed client/Worker acceptance. Source4 has no snapshot
lease. Media/decision registry work remains with its existing owners. No helper-only
activation, native parity, account entitlement, cryptographic badge or live
inference/billing/cancellation proof is claimed.

The frozen Chat continuation also preserves native effort options/defaults under
`model_spec.capabilities`: explicit support, 1–7 unique recognized options,
and an optional default that belongs to that same list. Boolean support alone
never creates a menu. See [the finite inventory](venice-native-chat.md).
