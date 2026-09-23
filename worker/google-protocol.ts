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
