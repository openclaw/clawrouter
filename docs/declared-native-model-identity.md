# Declared native model identity

Native selection keeps existing exact public-ID and physical-upstream lookup.
Before opaque passthrough, it also checks the provider's finite registered cards:
the public ID must exactly equal one declared model prefix plus the supplied
native identity. Multiple matching cards fail closed. No caller prefix stripping,
suffix matching, case folding, whitespace normalization or URL decoding is added.
Both the public ID and physical upstream alias must be literal: configured
`${model}` / `${deployment}` templates retain their existing native passthrough
identity and do not grant that placeholder's public-card metadata or policy ID.

For Particle, native `particle-ai/particle-1` therefore selects public policy ID
`particle/particle-ai/particle-1` and physical upstream `particle-1`. The selected
card still controls endpoint eligibility, pricing and policy admission; only its
declared physical alias is serialized. Original credential and destination
selection are unchanged.

An unmatched native ID follows the existing endpoint passthrough contract. It
retains its literal identity and receives no registered metadata, price or
allowlist authority. An allowlist containing only the registered public ID cannot
authorize an undeclared, foreign or malformed variant. This change adds no model
cards, aliases, provider declarations or actual-client qualification.
