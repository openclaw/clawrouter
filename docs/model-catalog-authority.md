# Original-owner model catalog authority

OpenAI-shaped `models.list` requests keep their selected managed API-key owner,
configured destination and caller identity. They accept only bodyless, query-free
GET caller operations. Existing fixed server metadata queries remain bound to
the configured destination; mapped paths remain qualified by the path validator. No catalog retry selects another key or falls back to an environment
credential after an owner failure.

After budget and retention waits, dispatch reads current caller policy and the
original credential owner's generation, lineage, account, status and expiry.
The complete bounded response is parsed before the same checks run again. The
published rows intersect the admitted model policy with the current policy.
Broader permissions acquired while reading cannot widen this request. An empty
filtered list is authoritative; missing price and limit facts stay unknown.

The existing GMI binding continues to own its optional organization header.
Generic catalog authority does not copy caller organization headers or replace
that binding. Public catalogs, keyed provider-specific scans and Anthropic
pagination keep their separate protocols.

The existing operation owns cancellation and the endpoint deadline. A 16 MiB
response lease charges 32 MiB before physical fetch and remains held through
bounded metadata parsing and response producer EOF/cancellation. Rejections and
metadata requests remain nonbillable. Fresh checks establish authority at those
checks; they do not promise instantaneous revocation after a check completes.
