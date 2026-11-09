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
export const accessEvidenceLimits = Object.freeze({ wire: 262144, text: 65536, cookie: 32768, url: 16384, orgs: 128, teams: 256 });

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

type Profile = "identity_record" | "identity_complete" | "header" | "payload" | "jwks" | "evidence" | "authority_user" | "user_record" | "user_query" | "user_init" | "assignment_source" | "policy_collection" | "policy_principals" | "policy_bindings" | "policy_ids" | "policy_seeds" | "policy_binding_reply" | "policy_binding_record" | "policy_reply";
export const authorityUserJsonLimits = Object.freeze({ wire: 1048576, text: 1048576 });
export type UserSourceCounts = { values: number; containers: number; members: number; entries: number; units: number };
const userSourceProfile = { wire: 2097152, depth: 16, values: 16384, containers: 4096, members: 8192, entries: 8192, units: 2097152, string: 2097152 } as const;
const assignmentSourceProfile = { wire: 2097152, depth: 16, values: 65536, containers: 16384, members: 32768, entries: 32768, units: 2097152, string: 1048576 } as const;
export const identityJsonProfiles = Object.freeze({
  record: Object.freeze({ wire: 1048576, depth: 16, values: 65536, containers: 16384, members: 32768, entries: 16384, combined: 49152, units: 1048576, string: 1048576 }),
  complete: Object.freeze({ wire: 2097152, depth: 24, values: 131072, containers: 32768, members: 65536, entries: 32768, combined: 98304, units: 2097152, string: 1048576 }),
});
const profiles = {
  identity_record: identityJsonProfiles.record, identity_complete: identityJsonProfiles.complete,
  policy_collection: assignmentSourceProfile, policy_principals: assignmentSourceProfile, policy_bindings: assignmentSourceProfile,
  policy_ids: assignmentSourceProfile, policy_seeds: assignmentSourceProfile, policy_binding_reply: assignmentSourceProfile, policy_binding_record: assignmentSourceProfile, policy_reply: assignmentSourceProfile,
  assignment_source: assignmentSourceProfile,
  user_record: userSourceProfile, user_query: userSourceProfile, user_init: userSourceProfile,
  header: { wire: 2048, depth: 4, values: 64, containers: 8, members: 32, entries: 16, units: 2048, string: 2048 },
  payload: { wire: 8192, depth: 8, values: 512, containers: 64, members: 256, entries: 128, units: 8192, string: 8192 },
  jwks: { wire: 262144, depth: 8, values: 4096, containers: 256, members: 2048, entries: 1024, units: 65536, string: 4096 },
  evidence: { wire: 262144, depth: 8, values: 4096, containers: 256, members: 2048, entries: 1024, units: 65536, string: 1024 },
  authority_user: { wire: 1048576, depth: 16, values: 8192, containers: 2048, members: 4096, entries: 4096, units: 1048576, string: 1048576 },
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

// Closed recursive states (profile-specific bounded depth), not a token vector. All raw
// occurrences, including duplicate/discarded members, count before JSON.parse.
export function parseAccessJson(text: string, profile: Profile, source?: UserSourceCounts): unknown {
  const identity = profile === "identity_record" || profile === "identity_complete";
  const policy = profile === "policy_collection" || profile === "policy_principals" || profile === "policy_bindings" || profile === "policy_ids" || profile === "policy_seeds" || profile === "policy_binding_reply" || profile === "policy_binding_record" || profile === "policy_reply";
  const p = profiles[profile], user = identity || policy || profile === "authority_user" || profile === "user_record" || profile === "user_query" || profile === "user_init" || profile === "assignment_source";
  if (source && !identity && profile !== "user_record" && profile !== "assignment_source" && profile !== "policy_collection" && profile !== "policy_binding_record") invalid();
  if (profile === "evidence" && text.length > accessEvidenceLimits.text) limit();
  // The user-reply owner counts ORIGINAL bytes before replacement decoding.
  // Re-encoding its decoded text would incorrectly charge replacement expansion.
  if (text.length > p.wire || !user && utf8Length(text) > p.wire) limit();
  let at = 0, values = identity ? 0 : source?.values ?? 0, containers = identity ? 0 : source?.containers ?? 0, members = identity ? 0 : source?.members ?? 0,
    entries = identity ? 0 : source?.entries ?? 0, units = identity ? 0 : source?.units ?? 0, rows = 0, audiences = 0, orgs = 0, teams = 0, occurrences = 0, principals = 0, bindings = 0;
  const identityCounts = () => {
    if (!identity) return;
    const maximum = profile === "identity_record" ? identityJsonProfiles.record : identityJsonProfiles.complete;
    if (members + entries > maximum.combined) limit();
    if (source) {
      const p = identityJsonProfiles.complete;
      if (source.values + values > p.values || source.containers + containers > p.containers
        || source.members + members > p.members || source.entries + entries > p.entries
        || source.members + source.entries + members + entries > p.combined || source.units + units > p.units) limit();
    }
  };
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
      if (++length > maximum || ++units > p.units) limit(); identityCounts();
      if (binaryMaximum !== undefined && length > Math.ceil(binaryMaximum / 3) * 4) limit();
      padding = n === 61 ? padding + 1 : 0;
      if (retain) key += String.fromCharCode(n);
    }
    return invalid();
  };
  const value = (depth: number, key = "", rootMember = false, jwkRow = false, insideJwk = false, requestRow = false, rawEmail = false, position = ""): void => {
    space(); const start = at;
    if (++values > p.values) limit(); identityCounts();
    const c = text[at];
    if (c === "{" || c === "[") {
      if (depth >= p.depth || ++containers > p.containers) limit(); identityCounts();
      at++; space();
      const object = c === "{", close = object ? "}" : "]";
      if (text[at] !== close) for (;;) {
        if (object) {
          if (++members > p.members || (profile === "assignment_source" || policy) && members + entries > 32768) limit(); identityCounts();
          space(); const child = string(user ? 1024 : 64, true); space(); if (text[at++] !== ":") invalid();
          const next = position === "principals-query" && child === "principals" || position === "binding-reply" && child === "missingPrincipals" ? "principals"
            : position === "binding-reply" && child === "bindings" || position === "seed" && child === "bindings" ? "bindings"
            : position === "seed" && child === "principal" ? "principal"
            : position === "policies-query" && child === "policyIds" || position === "policy-reply" && child === "missingPolicyIds" ? "ids"
            : position === "policy-init" && child === "entries" || position === "policy-reply" && child === "policies" ? "policy-entries"
            : (position === "principal" || position === "binding") && child === "principalId" || (position === "binding" || position === "policy-entry") && child === "policyId" ? "id" : "";
          value(depth + 1, child, depth === 0, false, insideJwk || jwkRow, false, requestRow && child === "email", next);
        } else {
          if (++entries > p.entries || (profile === "assignment_source" || policy) && members + entries > 32768) limit(); identityCounts();
          if ((position === "principals" || position === "seeds") && ++principals > 1024) limit();
          if (position === "bindings" && ++bindings > 4096) limit();
          const row = profile === "jwks" && rootMember && key === "keys";
          if (row && ++rows > accessLimits.keys || profile === "payload" && rootMember && key === "aud" && ++audiences > 32) limit();
          if (profile === "evidence" && rootMember && (key === "orgs" && ++orgs > accessEvidenceLimits.orgs
            || key === "teams" && ++teams > accessEvidenceLimits.teams)) limit();
          const queryEmail = profile === "user_query" && rootMember && key === "emails";
          const initRow = profile === "user_init" && depth === 0;
          if ((queryEmail || initRow) && ++occurrences > 4096) limit();
          const next = position === "principals" ? "principal" : position === "seeds" ? "seed" : position === "bindings" ? "binding"
            : position === "ids" ? "id" : position === "policy-entries" || position === "policy-init" ? "policy-entry" : "";
          value(depth + 1, key, false, row, insideJwk || jwkRow, initRow, queryEmail, next);
        }
        space(); if (text[at] === close) break;
        if (text[at++] !== ",") invalid();
      }
      at++;
    } else if (c === '"') {
      const maximum = rawEmail || position === "id" ? 1024 : profile !== "evidence" && !user && key === "kid" ? 256 : profile === "payload" && (key === "iss" || key === "sub" || key === "aud") ? 1024
        : (profile === "payload" || profile === "evidence") && key === "email" ? 320 : p.string;
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
  const rootPosition = profile === "policy_principals" ? "principals-query" : profile === "policy_bindings" ? "seeds" : profile === "policy_ids" ? "policies-query"
    : profile === "policy_seeds" ? "policy-init" : profile === "policy_binding_reply" ? "binding-reply" : profile === "policy_binding_record" ? "binding" : profile === "policy_reply" ? "policy-reply" : "";
  try {
    value(0, "", false, false, false, false, false, rootPosition); space(); if (at !== text.length) invalid();
    if (source && !identity) Object.assign(source, { values, containers, members, entries, units });
    return JSON.parse(text); // Normal parsed duplicate-member (last wins) semantics.
  } finally {
    // An ordinary malformed cache record can be followed by an authority read.
    // Its already-processed occurrences still consume the same source budget.
    if (source && identity) { source.values += values; source.containers += containers; source.members += members; source.entries += entries; source.units += units; }
  }
}
const escapeCodes = [34, 92, 47, 8, 12, 10, 13, 9] as const;
