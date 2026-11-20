// Local observation limits, not a schema for the ledger's optional reply facts.
export const softStatusLimits = Object.freeze({ wire: 16384, reads: 8192, backing: 16384,
  headers: 32, headerBytes: 4096, depth: 4, values: 128, containers: 32,
  members: 64, entries: 64, units: 4096, scalar: 1024, key: 64, number: 64 });

export function softStatusError(): Error { return new Error("soft budget observation failed"); }
const fail = (): never => { throw softStatusError(); };

// Count before URLSearchParams encoding or idFromName. Form encoding replaces
// lone surrogates; its three UTF-8 bytes each occupy a percent-encoded triplet.
function formLength(value: string): number {
  let size = 0;
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n === 32 || n >= 48 && n <= 57 || n >= 65 && n <= 90 || n >= 97 && n <= 122 || n === 42 || n === 45 || n === 46 || n === 95) size++;
    else if (n < 128) size += 3;
    else if (n < 2048) size += 6;
    else if (n >= 0xd800 && n <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { size += 12; i++; }
    else size += 9;
  }
  return size;
}

export function admitSoftStatusRequest(objectName: string, policyId: string, windowKey: string, scopeKey: string, limit: string): void {
  let units = 0, encoded = "https://clawrouter.internal/status?policy_id=&window_key=&scope_key=&limit_micros=".length;
  for (const value of [objectName, policyId, windowKey, scopeKey, limit]) {
    if (typeof value !== "string" || value.length > 1024 || (units += value.length) > 4096) fail();
  }
  for (const value of [policyId, windowKey, scopeKey, limit]) encoded += formLength(value);
  if (encoded > 16384) fail();
}

// A fixed, bounded recursive scanner; no token vector or decoded-string archive.
// Every occurrence counts before JSON.parse applies ordinary last-member wins.
export function parseSoftStatus(text: string): unknown {
  if (text.length > softStatusLimits.wire) fail();
  let at = 0, values = 0, containers = 0, members = 0, entries = 0, units = 0;
  const space = () => { while (at < text.length && (text[at] === " " || text[at] === "\t" || text[at] === "\r" || text[at] === "\n")) at++; };
  const string = (maximum: number) => {
    if (text[at++] !== '"') fail();
    let length = 0;
    while (at < text.length) {
      const c = text.charCodeAt(at++);
      if (c === 34) return;
      if (c < 32) fail();
      if (c === 92) {
        const escaped = text[at++];
        if (escaped === "u") {
          for (let i = 0; i < 4; i++) {
            const n = text.charCodeAt(at++);
            if (!(n >= 48 && n <= 57 || n >= 65 && n <= 70 || n >= 97 && n <= 102)) fail();
          }
        } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) fail();
      }
      if (++length > maximum || ++units > softStatusLimits.units) fail();
    }
    fail();
  };
  const value = (depth: number): void => {
    space(); const start = at, c = text[at];
    if (++values > softStatusLimits.values) fail();
    if (c === "{" || c === "[") {
      if (depth >= softStatusLimits.depth || ++containers > softStatusLimits.containers) fail();
      const object = c === "{", close = object ? "}" : "]";
      at++; space();
      if (text[at] !== close) for (;;) {
        if (object) {
          if (++members > softStatusLimits.members) fail();
          space(); string(softStatusLimits.key); space(); if (text[at++] !== ":") fail();
        } else if (++entries > softStatusLimits.entries) fail();
        value(depth + 1); space(); if (text[at] === close) break;
        if (text[at++] !== ",") fail();
      }
      at++;
    } else if (c === '"') string(softStatusLimits.scalar);
    else if (c === "t" || c === "f" || c === "n") {
      const literal = c === "t" ? "true" : c === "f" ? "false" : "null";
      if (!text.startsWith(literal, at)) fail(); at += literal.length;
    } else {
      const digits = () => { const from = at; while (text[at] >= "0" && text[at] <= "9") { if (at - start >= softStatusLimits.number) fail(); at++; } return at !== from; };
      if (c === "-") at++;
      if (text[at] === "0") at++; else if (!(text[at] >= "1" && text[at] <= "9") || !digits()) fail();
      if (text[at] === ".") { at++; if (!digits()) fail(); }
      if (text[at] === "e" || text[at] === "E") { at++; if (text[at] === "+" || text[at] === "-") at++; if (!digits()) fail(); }
      if (at - start > softStatusLimits.number) fail();
    }
  };
  value(0); space(); if (at !== text.length) fail();
  return JSON.parse(text);
}
