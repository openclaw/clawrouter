import { HttpError } from "./utils.ts";

const denials = new WeakSet<object>();
export function accessDenial(kind: "limit" | "transport" | "cleanup" | "deadline"): HttpError {
  const error = new HttpError(kind === "limit" ? 400 : kind === "deadline" ? 401 : 503,
    `access_${kind}`, "Access authentication could not complete within its operational profile");
  denials.add(error); return error;
}
export function isAccessDenial(value: unknown): value is HttpError {
  return typeof value === "object" && value !== null && denials.has(value);
}
const invalid = (): never => { throw new SyntaxError("invalid Access JSON or encoding"); };
const limit = (): never => { throw accessDenial("limit"); };
export const accessLimits = Object.freeze({ jwt: 16384, header: 2048, payload: 8192, signature: 1024,
  jwks: 262144, jwk: 8192, keys: 32, backing: 16384, reads: 8192, headers: 32, headerBytes: 4096 });

// PRESENT assertions are bounded before split, normalization or configuration
// fallback. Malformed bounded credentials retain ordinary invalid-JWT behavior.
export function accessJwtParts(token: string): readonly [number, number] | null {
  if (token.length > accessLimits.jwt) limit();
  let first = -1, second = -1, dots = 0;
  for (let i = 0; i < token.length; i++) {
    if (token.charCodeAt(i) > 127) limit();
    if (token.charCodeAt(i) === 46) { if (!dots++) first = i; else if (dots === 2) second = i; }
  }
  return dots === 2 ? [first, second] : null;
}
export function admitAccessBase64(value: string, maximum: number): number {
  // Resource admission precedes grammar rejection, including malformed padding.
  if (value.length > Math.ceil(maximum / 3) * 4) limit();
  let padding = 0;
  for (let i = value.length - 1; i >= 0 && value[i] === "="; i--) padding++;
  const data = value.length - padding;
  const size = Math.floor(data * 3 / 4);
  if (size > maximum) limit();
  return padding;
}
export function accessBase64Size(value: string, maximum: number): number {
  const padding = admitAccessBase64(value, maximum), data = value.length - padding;
  if (padding > 2 || (padding && value.length % 4) || data % 4 === 1) invalid();
  for (let i = 0; i < data; i++) {
    const n = value.charCodeAt(i);
    if (!(n >= 65 && n <= 90 || n >= 97 && n <= 122 || n >= 48 && n <= 57 || n === 45 || n === 95 || n === 43 || n === 47)) invalid();
  }
  return Math.floor(data * 3 / 4);
}
export function accessBase64Bytes(value: string, maximum: number): Uint8Array<ArrayBuffer> {
  const size = accessBase64Size(value, maximum);
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(normalized);
  if (decoded.length !== size) invalid();
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

type Profile = "header" | "payload" | "jwks";
const profiles = {
  header: { wire: 2048, depth: 4, values: 64, containers: 8, members: 32, entries: 16, units: 2048, string: 2048 },
  payload: { wire: 8192, depth: 8, values: 512, containers: 64, members: 256, entries: 128, units: 8192, string: 8192 },
  jwks: { wire: 262144, depth: 8, values: 4096, containers: 256, members: 2048, entries: 1024, units: 65536, string: 4096 },
} as const;

function utf8Length(text: string, start = 0, end = text.length): number {
  let bytes = 0;
  for (let i = start; i < end; i++) {
    const n = text.charCodeAt(i);
    if (n < 128) bytes++; else if (n < 2048) bytes += 2;
    else if (n >= 0xd800 && n <= 0xdbff && i + 1 < end && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

// Bounded recursive states (maximum depth eight), not a token vector. All raw
// occurrences, including duplicate/discarded members, count before JSON.parse.
export function parseAccessJson(text: string, profile: Profile): unknown {
  const p = profiles[profile];
  if (text.length > p.wire || utf8Length(text) > p.wire) limit();
  let at = 0, values = 0, containers = 0, members = 0, entries = 0, units = 0, rows = 0, audiences = 0;
  const space = () => { while (at < text.length) { const c = text.charCodeAt(at); if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break; at++; } };
  const string = (maximum: number, retain: boolean, binaryMaximum?: number): string => {
    if (text[at++] !== '"') invalid();
    let length = 0, padding = 0, key = "";
    while (at < text.length) {
      let n = text.charCodeAt(at++);
      if (n === 34) {
        if (binaryMaximum !== undefined && Math.floor((length - padding) * 3 / 4) > binaryMaximum) limit();
        return key;
      }
      if (n < 32) invalid();
      if (n === 92) {
        const escaped = text[at++];
        if (escaped === "u") {
          if (at + 4 > text.length) invalid();
          n = 0;
          for (let i = 0; i < 4; i++) {
            const c = text.charCodeAt(at++), digit = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
            if (digit < 0) invalid(); n = n * 16 + digit;
          }
        } else {
          const index = '"\\/bfnrt'.indexOf(escaped ?? "\0");
          if (index < 0) invalid(); n = escapeCodes[index];
        }
      }
      if (++length > maximum || ++units > p.units) limit();
      if (binaryMaximum !== undefined && length > Math.ceil(binaryMaximum / 3) * 4) limit();
      padding = n === 61 ? padding + 1 : 0;
      if (retain) key += String.fromCharCode(n);
    }
    return invalid();
  };
  const value = (depth: number, key = "", rootMember = false, jwkRow = false, insideJwk = false): void => {
    space(); const start = at;
    if (++values > p.values) limit();
    const c = text[at];
    if (c === "{" || c === "[") {
      if (depth >= p.depth || ++containers > p.containers) limit();
      at++; space();
      const object = c === "{", close = object ? "}" : "]";
      if (text[at] !== close) for (;;) {
        if (object) {
          if (++members > p.members) limit();
          space(); const child = string(64, true); space(); if (text[at++] !== ":") invalid();
          value(depth + 1, child, depth === 0, false, insideJwk || jwkRow);
        } else {
          if (++entries > p.entries) limit();
          const row = profile === "jwks" && rootMember && key === "keys";
          if (row && ++rows > accessLimits.keys || profile === "payload" && rootMember && key === "aud" && ++audiences > 32) limit();
          value(depth + 1, key, false, row, insideJwk || jwkRow);
        }
        space(); if (text[at] === close) break;
        if (text[at++] !== ",") invalid();
      }
      at++;
    } else if (c === '"') {
      const maximum = key === "kid" ? 256 : profile === "payload" && (key === "iss" || key === "sub" || key === "aud") ? 1024
        : profile === "payload" && key === "email" ? 320 : p.string;
      // Every n/e occurrence counts before JSON.parse can discard duplicates.
      string(maximum, false, insideJwk && key === "n" ? 1024 : insideJwk && key === "e" ? 8 : undefined);
    } else if (c === "t" || c === "f" || c === "n") {
      const literal = c === "t" ? "true" : c === "f" ? "false" : "null";
      if (!text.startsWith(literal, at)) invalid(); at += literal.length;
    } else {
      if (c === "-") at++;
      if (text[at] === "0") at++;
      else { if (!(text[at] >= "1" && text[at] <= "9")) invalid(); while (text[at] >= "0" && text[at] <= "9") { if (at - start >= 64) limit(); at++; } }
      if (text[at] === ".") { at++; const from = at; while (text[at] >= "0" && text[at] <= "9") { if (at - start >= 64) limit(); at++; } if (at === from) invalid(); }
      if (text[at] === "e" || text[at] === "E") { at++; if (text[at] === "+" || text[at] === "-") at++;
        const from = at; while (text[at] >= "0" && text[at] <= "9") { if (at - start >= 64) limit(); at++; } if (at === from) invalid(); }
      if (at - start > 64) limit();
    }
    if (jwkRow && utf8Length(text, start, at) > accessLimits.jwk) limit();
  };
  value(0); space(); if (at !== text.length) invalid();
  return JSON.parse(text); // Normal parsed duplicate-member (last wins) semantics.
}
const escapeCodes = [34, 92, 47, 8, 12, 10, 13, 9] as const;
