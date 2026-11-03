export type ModelAvailability = {
  version: "clawrouter.model-availability.v1";
  effectiveAt: string;
  checkedAt: string;
  sources: string[];
} & (
  | { status: "stopped"; servingModel?: never }
  | { status: "deprecated"; servingModel?: never }
  | { status: "upstream_alias"; servingModel: string }
);

interface ModelIdentity { id: string; upstream?: string; availability?: ModelAvailability }

// Dispositions apply to this product's selected identity, not other providers
// or the alias target. Missing metadata does not assert live availability.
export function modelExecutable(provider: { models: readonly ModelIdentity[] }, model: ModelIdentity): boolean {
  const availability = model.availability;
  if (availability && (availability.version !== "clawrouter.model-availability.v1"
    || !["deprecated", "upstream_alias"].includes(availability.status))) return false;
  return !provider.models.some(row => row.availability?.status === "stopped"
    && (row.id === model.id || !!row.upstream && row.upstream === model.upstream));
}
