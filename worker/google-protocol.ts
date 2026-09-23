// GenerateContent uses ProtoJSON: camelCase/proto-name aliases are last-wins,
// and int32 fields accept decimal strings, including exponent notation.
export function googleField(value: unknown, camel: string, proto: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  let found: unknown;
  for (const [key, field] of Object.entries(value)) if (key === camel || key === proto) found = field;
  return found;
}

export function googleInt32(value: unknown): number | null {
  if (typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) value = Number(value);
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
}

export function googleServiceTier(value: unknown): string | null {
  if (value === "unspecified") return "standard";
  return value === "standard" || value === "flex" || value === "priority" ? value : null;
}

export function googleRequestServiceTier(body: unknown): string | null {
  const value = googleField(body, "serviceTier", "service_tier");
  return value == null ? "standard" : googleServiceTier(value);
}

export function googleResponseServiceTier(requested: string | null, usageTier: string | null | undefined, header: string | null): string | null {
  const metadataTier = usageTier === undefined ? undefined : googleServiceTier(usageTier);
  const headerTier = header === null ? undefined : googleServiceTier(header);
  // Neither response source has documented precedence. Explicit bad or
  // conflicting evidence must not fall back to the requested tier.
  if (metadataTier === null || headerTier === null) return null;
  if (metadataTier !== undefined && headerTier !== undefined && metadataTier !== headerTier) return null;
  // Flex never upgrades; omitted/Standard requests use Standard. Priority
  // can downgrade, so its missing served tier cannot establish an exact price.
  return headerTier ?? metadataTier ?? (requested === "standard" || requested === "flex" ? requested : null);
}
