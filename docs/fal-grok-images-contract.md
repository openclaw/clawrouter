# fal Grok image contract

Frozen OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`,
`extensions/fal/image-generation-provider.ts`, defines the fal Grok image family.
This codec qualifies three exact, currently documented routes:
`xai/grok-imagine-image`, `xai/grok-imagine-image/edit` and
`xai/grok-imagine-image/quality/edit`.

`xai/grok-imagine-image/quality` generation stays closed. Its public schema
returned HTTP 404 on 2026-11-03. That observation does not establish native
endpoint retirement or a serving-model alias. A published fal contract for that
exact path is the unblock; there is no need to probe a paid generation request.

All qualified requests use JSON POST `https://fal.run/<selected model>` with
`Authorization: Key <selected server FAL_KEY>`. Direct xAI's credential,
November 2 image-quality alias and low-quality tariff do not qualify fal's
separate product. Quality/edit keeps its selected path; no quality value,
serving-model rewrite, inherited tariff or model 2.0 fallback is inserted.

`worker/fal-grok-images.ts` exports `falGrokImageModels`, `prepareFalGrokImage`,
`assertFalGrokImageDispatch`, `observeFalGrokImage` and `readFalGrokImage`.
Observation/reading reuse the native image-result contract from
[PR588](https://github.com/openclaw/clawrouter/pull/588), retaining partial batches,
safety flags and secret-free URL descriptors. A foreign returned model is
rejected until a fal-specific identity contract is qualified.

The frozen surface allows 1–4 outputs, PNG/JPEG, thirteen native ratios and
lowercase 1k/2k resolution. Omitted edit geometry preserves upstream auto;
explicit auto, WebP output, 4k, quality fields and image_size are outside this
frozen consumer contract. Prompts contain at most 8000 Unicode code points.
Edits require 1–3 ordered PNG/JPEG/WebP inline references, with canonical base64,
8 MiB per image and 16 MiB aggregate decoded bytes. Generation never switches
to edit automatically. Remote image URLs/uploads require separate original
caller/credential asset ownership qualification.

Sanitized `providers/_fixtures/fal/grok-images.json` contains native request
and result shapes plus the exact unqualified-path disposition. Its tiny inline
signature bytes are transport fixtures, not successful image decoding proof.
Complete HTTP 200 JSON is required. Local abort, partial outputs, flags and
result-download failures do not prove free work or authorize POST replay.
Upstream dollar cost remains unknown, denied under hard budgets separately
from policy_fixed charging; no live generation or billing proof is claimed.

Source3 handshake: proposed `fal.grok_image_create` / `fal.images` at the three
qualified synchronous paths. Source1 owns actual Worker admission, dispatch,
original credentials, reservation and settlement. Source2 owns native consumer
selection and safe output delivery; source6 owns snapshots/E2E. Source5 retains
new fal declaration additions. Shared types/runtime/schema and manifests are
unchanged here, so this slice alone does not activate full provider parity.

Primary schemas:
[generate](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=xai/grok-imagine-image),
[edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=xai/grok-imagine-image/edit),
[quality edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=xai/grok-imagine-image/quality/edit).
The [quality-edit API page](https://fal.ai/models/xai/grok-imagine-image/quality/edit/api)
names the fal product but does not supply a qualified direct-xAI alias mapping.
The [synchronous run contract](https://fal.ai/docs/api-reference/inference-api/sync/run)
qualifies the origin and Key authentication. No deployment, secret or account
changes were used.
