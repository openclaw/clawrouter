# OpenRouter text-only music declaration

This declaration adds only the frozen OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7` identities
`google/lyria-3-pro-preview` and `google/lyria-3-clip-preview` for explicit
`music.generate`. Neither card inherits Chat or Responses. Existing OpenRouter
cards, prices, auth, adapters and inference endpoints are unchanged.

The existing `music_generate` runtime contract uses POST
`/v1/chat/completions`, paired `openai.chat_completions` formats and SSE under
`https://openrouter.ai/api`. Native callers select the literal upstream model;
manifest callers select endpoint `music_generate` and the registered router
model. The runtime selects the model's capability, not endpoint order. The
600,000 ms endpoint ceiling matches the existing OpenRouter transport; it is
not a generation duration or monetary bound.

Model metadata declares text input only, using the existing versioned native
capability field. It adds no context/output-token limits, prices, aliases or
new format. Price omission compiles to unknown, not zero. Unknown upstream-dollar
budgets must deny before egress; an authorized `policy_fixed` charge is separate.
Native audio, usage tokens and reported cost do not become a qualified tariff.

This is **partial text-only server support**, not registered ClawRouter-client
parity. The qualified output continuation accepts MP3/WAV requests and restores
the original bounded 32 MiB SSE / 16 MiB audio profile. Those implementation
bounds are documented in the actual leaf contract, not model facts or a
guarantee that the frozen client's default duration fits. Every reference image,
remote URL and uploaded ID remains closed until original asset authority exists.

## Qualified source and remaining integration

- Codec [PR566](https://github.com/openclaw/clawrouter/pull/566), squash
  `ca2642341b4e95a2309fb91ead646f6a59d6f00f`, supplies the two exact IDs and wire.
- Initial leaf [PR778](https://github.com/openclaw/clawrouter/pull/778), squash
  `5f769272ead99ef66c27ae37eceb8d251928ee96`, supplies text-only complete SSE delivery.
- Runtime [PR784](https://github.com/openclaw/clawrouter/pull/784), squash
  `b8b33d5bdd771bfa0904ac493b2fc6129b2768db`, supplies selected-model dispatch,
  original credential accounting and fail-closed unknown costs.
- Output continuation [PR795](https://github.com/openclaw/clawrouter/pull/795),
  squash `e47ecdedd4da93bb665431b81f698668468dc8ea`, restores the original output
  profile with qualified workerd capacity/delivery proof. This declaration
  starts from that actual squash and includes the common runtime above.

The OpenRouter music consumer handoff has reached the actual-client owner;
registered ClawRouter-client integration and composed consumer proof remain
separate. The declaration tests use the actual compiled YAML, existing
Worker/SQLite fixture and native music wire fixture. They are authored and unrun
locally because this checkout has no qualified dependencies. Generated snapshots
remain in the existing serialized integration queue after PR789. No live call,
reference-image authority or full-client parity is claimed by this declaration.
