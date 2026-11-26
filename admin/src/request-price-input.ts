const maximumMicros = BigInt(Number.MAX_SAFE_INTEGER);

type AmountError = "invalid" | "precision" | "overflow";

/** Parse the decimal text itself: floating-point dollars can lose a microdollar. */
function exactDollarMicros(amount: string): number | AmountError {
  const match = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(amount);
  if (!match) return "invalid";
  const fraction = match[2] ?? match[3] ?? "";
  const digits = ((match[1] ?? "0") + fraction).replace(/^0+/, "");
  if (!digits) return 0;
  let end = digits.length;
  while (digits[end - 1] === "0") end--;
  const significant = digits.slice(0, end);
  const shift = 6 + Number(match[4] ?? 0) - fraction.length + digits.length - significant.length;
  if (shift < 0) return "precision";
  if (!Number.isSafeInteger(shift) || significant.length + shift > 16) return "overflow";
  const micros = BigInt(significant) * 10n ** BigInt(shift);
  return micros > maximumMicros ? "overflow" : Number(micros);
}

export function optionalRequestPriceMicros(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const micros = exactDollarMicros(value.trim().replace(/^\$\s*/, ""));
  if (micros === "invalid") throw new Error("Request prices must be non-negative dollar amounts.");
  if (micros === "precision") throw new Error("Request prices support at most six decimal places ($0.000001).");
  if (micros === "overflow") throw new Error("Request price exceeds the supported amount.");
  return micros;
}

export type PolicyBudgetPeriod = "Daily" | "Weekly" | "Monthly";

export function parsePolicyBudget(value: string, period: PolicyBudgetPeriod): { micros: number | null } | { error: string } {
  const text = value.trim();
  if (!text) return { micros: null };
  // Strip only complete thousands groups in the integer part, never punctuation in a fraction.
  const amount = text.replace(/^(?:\$\s*\+?|\+\s*\$?)/, "").trimStart()
    .replace(/^\d{1,3}([, \u00a0\u202f])\d{3}(?:\1\d{3})*(?=[.eE]|$)/, group => group.replace(/\D/g, ""));
  const micros = exactDollarMicros(amount);
  if (micros === "invalid") return { error: `${period} budget: enter a non-negative dollar amount, or leave blank for unlimited.` };
  if (micros === "precision") return { error: `${period} budget: use increments of $0.000001 (up to six decimal places).` };
  if (micros === "overflow") return { error: `${period} budget: enter $9,007,199,254.740991 or less.` };
  return { micros };
}

export function policyBudgetMicros(value: string, period: PolicyBudgetPeriod): number | null {
  const result = parsePolicyBudget(value, period);
  if ("error" in result) throw new Error(result.error);
  return result.micros;
}

export function dollarInputFromMicros(micros: number | null | undefined): string {
  if (micros == null) return "";
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error("Invalid amount in microdollars.");
  const value = BigInt(micros);
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export function requestPricesInput(prices: Record<string, number> | null | undefined): string {
  if (prices == null) return "";
  const entries = Object.entries(prices).map(([capability, micros]) => `  ${JSON.stringify(capability)}: ${dollarInputFromMicros(micros)}`);
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
