# Availability in runtime discovery

The runtime consumes the compiled `clawrouter.model-availability.v1` contract.
`stopped` rows remain in the compiled inventory so exact/native/passthrough
selection can recognize and reject them. They are omitted from executable route
catalogs, scoped client catalogs/offers, model lists and native model discovery.
A second router ID cannot revive the same stopped upstream identity within the
same provider product. Other providers carrying that slug are unaffected.

`deprecated` and `upstream_alias` rows retain their own selected ID, upstream,
capabilities and tariff. Scoped catalogs and router model lists preserve the
versioned disposition, evidence dates, primary URLs and explicit serving model.
An alias never copies its target's tariff or switches the request wire identity.
These facts neither grant account access nor assert a live service check.

Native discovery still uses the original selected credential and policy filter.
Even unrestricted callers cannot see a known stopped row. Anthropic pagination
skips stopped-only pages within the existing deadline/page bounds and emits only
visible cursors. Direct lookup of a known stopped identity is rejected before
egress. An empty native inventory does not retire declared models, and an
unlisted upstream row does not gain an inferred tariff or availability claim.

The schema/compiler and provider declarations remain source-owned. This runtime
slice adds no model cards or snapshots. The shared helper only evaluates compiled
states; it does not duplicate provenance validation or poll upstream metadata.
`worker/test/model-availability-runtime.test.mjs` exercises actual Worker
catalogs, native/manifest denial and original-grant discovery, in addition to
legacy route projection and product-scope checks.
