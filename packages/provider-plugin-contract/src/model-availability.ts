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
