# Native keyed model discovery

The Worker recognizes `baseten.models`, `arcee.models` and `novita.models`
as metadata operations. Each uses its published request constructor and bounded
reader. The OpenAI list decoder is unchanged.

| Format | Fixed upstream request |
| --- | --- |
| `baseten.models` | `GET https://inference.baseten.co/v1/models` |
| `arcee.models` | `GET https://api.arcee.ai/api/v1/models` |
| `novita.models` | `GET https://api.novita.ai/openai/v1/models` |

The compiled endpoint is a bodyless GET `/models` with matching request and
response formats, no path parameters, mapping, query or credential override.
The original selected owner-backed API-key grant supplies its scalar credential.
OAuth, subscription, environment fallback, bundle/access-token substitution and
alternate service origins do not qualify this native contract. No key is sent
to public catalogs by this path.

Immediately before fetch, after other preflight awaits, the Worker rechecks the
authenticated caller and policy against authority, then inspects the selected
credential owner. Provider, generation, lineage, account, kind, enabled state
and expiry must still match. This check bypasses admission and credential caches;
it does not refresh, switch accounts or materialize a replacement. It is fresh
at the check, not instantaneous revocation across the final reply-to-fetch gap.

The existing operation signal/deadline owns fetch and complete response reading.
Redirects, partial/oversized JSON and interrupted reads cannot publish a partial
inventory. Provider errors are sanitized. Readers retain their native data-only
envelopes and observed units; absent prices and limits stay absent. The existing
caller model filter and stopped-model exclusion apply to every returned ID.
Baseten's entire `decision-models/` namespace remains excluded by its reader.

Metadata requests use the existing zero-inference-cost discovery accounting and
private, no-store responses. They do not grant inference access, establish
serving limits, convert a price observation or populate an inference tariff.
Provider YAML, snapshot activation and actual client proof remain separately
qualified. Public catalogs and numeric pagination are separate runtime slices.
