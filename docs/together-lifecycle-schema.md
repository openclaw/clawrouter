# Together video lifecycle declaration

The closed `together.video` discriminator requires one scoped `retrieve` link.
It qualifies the actual `togetherVideoManagedAdapter` contract and frozen native
fixtures without activating a provider endpoint, model or generated snapshot.

| Action | Method and path | Request format | Response format |
| --- | --- | --- | --- |
| Create | POST `/v2/videos` | `together.video_create` | `together.video` |
| Retrieve | GET `/v2/videos/${video_id}` | `together.video_get` | `together.video` |

The existing Together manifest keeps its origin-only base and Chat endpoints.
Frozen native clients use `https://api.together.xyz`; current
[Together reference examples](https://docs.together.ai/reference/create-videos)
use `https://api.together.ai`. The compiler admits these two origins, but runtime
must retain the originally selected origin without alias fallback or redirects.
Every create/control uses the original Together Bearer API credential. Direct
Wan/DashScope and MiniMax credentials are different products. Endpoint overrides,
grant/header/query injection, raw controls, standalone read capabilities,
streaming, model passthrough and unbound video formats are rejected.

The frozen models are `Wan-AI/wan2.7-t2v`, `Wan-AI/wan2.7-i2v` and
`minimax/hailuo-02`. The source codec retains native string seconds and distinct
Wan resolution/ratio versus Hailuo width/height fields. Only Wan I2V accepts a
first-frame reference in this slice. The local ten-second ceiling is deliberately
narrower than the current [Wan2.7 API](https://docs.together.ai/docs/wan2.7-quickstart).
Parsing bounds do not establish every model/duration/resolution entitlement.

No result or cancellation endpoint is qualified. Missing/unknown observations
and uncertain creates retain conservative accounting; they never authorize
replay or a refund. Native output cost hints do not qualify a dollar tariff.
Completed output URLs remain opaque data. The guarded downloader must enforce
public-network, redirect, byte and content checks without sending the Together
credential to an asset origin. Neither the codec nor this compiler fetches media.

The shared protocol union already includes `together.video`; registry wiring
must bind the actual source adapter before existing YAML activation. Reuse the
same scoped durable controller and original caller/policy/job/model/credential
ownership, deadlines, reservations, uncertainty and exactly-once settlement.
Worker/client acceptance and serialized snapshot integration remain required.
The compiler tests consume all three native fixtures, preserve existing Chat
discovery/pricing, and reject mismatched job/model identities. They establish
the declaration contract, not end-to-end or live-account parity. See the
[source contract](together-video-contract.md) for exact exports and timing bounds.
