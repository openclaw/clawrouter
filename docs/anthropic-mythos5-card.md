# Claude Mythos 5 card

This adds only `claude-mythos-5` from OpenClaw's frozen
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7` catalog. It does not substitute Mythos
5.1 or change the existing Anthropic default.

Checked 2026-11-03. The [official model overview](https://platform.claude.com/docs/en/models/mythos-5/overview)
qualifies native Messages, text/image input, a 1M context and 128K output. The
frozen client supplies the corresponding decimal limits: 1000000 and 128000.
[Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)
remains a separate non-generation operation. Adaptive thinking is always on;
this card does not rewrite client thinking/replay fields or claim native-client
acceptance from static facts.

The model overview and [price list](https://platform.claude.com/docs/en/about-claude/pricing)
qualify input/output at $10/$50 per million tokens, cache reads at $1, five-minute
writes at $12.50 and one-hour writes at $20. These are Mythos 5 rates, not the
lower Mythos 5.1 cache-read rate. US-only inference adds the published 1.1×
multiplier to every token category. Missing geography retains the existing
runtime's conservative US reservation. No Fast tariff is declared, and private
Priority/Batch evidence remains unqualified by this synchronous card.

The model is active but requires upstream account verification. A manifest row
neither grants that entitlement nor validates a subscription account. No login,
consent, commercial-account change or live provider request is performed here.
Existing native refusal/fallback delivery and client quarantine requirements are
unchanged; this price/metadata change does not certify them.

Tests exercise native payload preservation, separate token counting, all cache
categories, geography scaling and preflight rejection of unqualified modifiers.
Snapshot integration and real native-client/Worker acceptance remain separate.
