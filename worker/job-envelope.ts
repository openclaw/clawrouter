export function isJobRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createJobEnvelopeParser(limit: number, tooLarge: string, invalid: string) {
  return (text: string): Record<string, unknown> => {
    if (text.length > limit || new TextEncoder().encode(text).byteLength > limit) {
      throw new Error(tooLarge);
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error(invalid); }
    if (!isJobRecord(value)) throw new Error(invalid);
    return value;
  };
}
