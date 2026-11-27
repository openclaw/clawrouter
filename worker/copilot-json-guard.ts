import { createJsonTokenizer } from "./json-tokens.ts";

const profiles = {
  catalog: { utf8Bytes: 2 * 1024 * 1024, depth: 64, containers: 32770, members: 131072, arrayEntries: 131072, values: 262146, decodedStringUnits: 2 * 1024 * 1024 },
  device: { utf8Bytes: 8192, depth: 4096, containers: 4096, members: 4096, arrayEntries: 4096, values: 8192, decodedStringUnits: 8192 },
} as const;

type CopilotJsonStats = Readonly<{
  utf8Bytes: number;
  depth: number;
  values: number;
  containers: number;
  members: number;
  arrayEntries: number;
  decodedStringUnits: number;
}>;

// Match TextEncoder's UTF-8 sizing, including replacement of an unpaired raw
// surrogate, without allocating a second whole encoded representation.
function width(text: string, offset: number): number {
  const code = text.charCodeAt(offset), next = text.charCodeAt(offset + 1);
  return code < 0x80 ? 1 : code < 0x800 ? 2
    : code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 4 : 3;
}

// Operational admission statistics, not parsed-graph heap or authority proof.
export function inspectCopilotJsonText(text: string, profile: "catalog" | "device"): CopilotJsonStats {
  const limit = profile === "catalog" ? profiles.catalog : profile === "device" ? profiles.device : undefined;
  const exceeded = new RangeError("copilot_json_limit");
  if (!limit || typeof text !== "string" || text.length > limit.utf8Bytes) throw exceeded;
  const stats = { utf8Bytes: 0, depth: 1, values: 0, containers: 0, members: 0, arrayEntries: 0, decodedStringUnits: 0 };
  // Preserve byte-limit precedence even when an oversized document is malformed.
  for (let offset = 0; offset < text.length;) {
    const bytes = width(text, offset);
    stats.utf8Bytes += bytes;
    if (stats.utf8Bytes > limit.utf8Bytes) throw exceeded;
    offset += bytes === 4 ? 2 : 1;
  }
  const stack = new Uint8Array(limit.depth);
  let depth = 0;
  const add = (key: "values" | "containers" | "members" | "arrayEntries" | "decodedStringUnits", amount = 1) => {
    stats[key] += amount;
    if (stats[key] > limit[key]) throw exceeded;
  };
  const value = () => {
    add("values");
    if (depth > 0 && stack[depth - 1] === 2) add("arrayEntries");
  };
  try {
    const tokenizer = createJsonTokenizer(token => {
      switch (token.name) {
        case "startObject": case "startArray":
          value(); add("containers");
          if (depth === limit.depth) throw exceeded;
          stack[depth++] = token.name === "startArray" ? 2 : 1;
          stats.depth = Math.max(stats.depth, depth);
          break;
        case "endObject": case "endArray": depth--; break;
        case "startKey": add("members"); break;
        case "stringChunk": add("decodedStringUnits", token.value.length); break;
        case "startString": case "startNumber": case "nullValue": case "trueValue": case "falseValue": value(); break;
        case "endKey": case "endString": case "endNumber": case "numberChunk": break;
      }
    });
    // The tokenizer materializes a feed's token vector before callbacks. Bound
    // each feed by UTF-8 BYTES and never split a raw surrogate pair.
    let start = 0, feedBytes = 0;
    for (let offset = 0; offset < text.length;) {
      const bytes = width(text, offset);
      if (feedBytes + bytes > 1024) { tokenizer.push(text.slice(start, offset)); start = offset; feedBytes = 0; }
      feedBytes += bytes;
      offset += bytes === 4 ? 2 : 1;
    }
    if (start < text.length) tokenizer.push(text.slice(start));
    tokenizer.end();
    if (stats.values === 0 || depth !== 0) throw new SyntaxError("invalid_copilot_json");
  } catch (error) {
    if (error === exceeded) throw error;
    throw new SyntaxError("invalid_copilot_json");
  }
  return Object.freeze(stats);
}
