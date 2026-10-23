const maximumMicros = BigInt(Number.MAX_SAFE_INTEGER);

/** Dollar text at the form boundary; integer microdollars on the wire. */
export function optionalRequestPriceMicros(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const match = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value.trim().replace(/^\$\s*/, ""));
  if (!match) throw new Error("Request prices must be non-negative dollar amounts.");
  const fraction = match[2] ?? match[3] ?? "";
  const digits = ((match[1] ?? "0") + fraction).replace(/^0+/, "");
  if (!digits) return 0;
  const significant = digits.replace(/0+$/, "");
  const shift = 6 + Number(match[4] ?? 0) - fraction.length + digits.length - significant.length;
  if (shift < 0) throw new Error("Request prices support at most six decimal places ($0.000001).");
  if (!Number.isSafeInteger(shift) || significant.length + shift > 16) throw new Error("Request price exceeds the supported amount.");
  const micros = BigInt(significant) * 10n ** BigInt(shift);
  if (micros > maximumMicros) throw new Error("Request price exceeds the supported amount.");
  return Number(micros);
}

export function requestPriceInput(micros: number | null | undefined): string {
  if (micros == null) return "";
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error("Invalid request price in microdollars.");
  const value = BigInt(micros);
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export function requestPricesInput(prices: Record<string, number> | null | undefined): string {
  if (prices == null) return "";
  const entries = Object.entries(prices).map(([capability, micros]) => `  ${JSON.stringify(capability)}: ${requestPriceInput(micros)}`);
  return entries.length ? `{\n${entries.join(",\n")}\n}` : "{}";
}

export function requestPricesMicros(value: string): Record<string, number> | null {
  if (!value.trim()) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Capability prices must be a JSON object of dollar amounts."); }
  if (parsed == null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 64 || Object.values(parsed).some(price => typeof price !== "number" || !Number.isFinite(price) || price < 0)) {
    throw new Error("Capability prices must map at most 64 capabilities to non-negative dollar amounts.");
  }
  // Preserve numeric lexemes before JSON.parse can round large decimal prices.
  // Complete quoted tokens keep digits in capability names and escapes intact.
  const exact = JSON.parse(value.replace(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => token.startsWith('"') ? token : JSON.stringify(token))) as Record<string, string>;
  return Object.fromEntries(Object.entries(exact).map(([capability, price]) => [capability, optionalRequestPriceMicros(price)!]));
}
