// Exact model/location support facts, checked 2026-11-04 UTC against:
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/sonnet-4-6
// Inactive until catalog and dispatch consume it; this never establishes IAM,
// original-owner authority, quota or pricing.
export function isQualifiedVertexModelLocation(upstream: string, location: string): boolean {
  return upstream === "claude-sonnet-4-6"
    && (location === "global" || location === "us-east5" || location === "europe-west1" || location === "asia-southeast1");
}
