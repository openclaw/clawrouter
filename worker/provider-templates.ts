import type { CompiledProvider, Env } from "./types.ts";
import { envValue, HttpError } from "./utils.ts";
import { providerConfigurationList } from "./provider-connections.ts";

const preparationFailures = new WeakSet<object>();
export function isPreparationLimit(error: unknown): error is HttpError {
  return typeof error === "object" && error !== null && preparationFailures.has(error);
}

// Explicit operation token. Never retain Env, an accessor or an Env-reading closure.
export class PreparationAdmission {
  #facts: Array<readonly [string, unknown]> = [];
  #factBytes = 0;
  #csvBytes = 0;
  #retainedCsvBytes = 0;
  #csvEntries = 0;
  #substitutions = 0;
  #parameters = 0;
  #segments = 0;
  #pathBytes = 0;
  #encodedPathBytes = 0;
  #queryPairs = 0;
  #queryBytes = 0;
  #headerWrites = 0;
  #headerBytes = 0;

  fail(): never {
    const error = new HttpError(503, "provider_preparation_unavailable", "provider request preparation capacity is unavailable");
    preparationFailures.add(error); throw error;
  }
  text(value: string, limit: number): number {
    if (typeof value !== "string" || value.length > limit) this.fail();
    const bytes = preparationBytes(value);
    if (bytes > limit) this.fail();
    return bytes;
  }
  primitive(name: string, value: unknown, csv = false): string | null {
    this.text(name, 256);
    if (value !== null && value !== undefined && !["string", "number", "boolean"].includes(typeof value)) this.fail();
    const bytes = typeof value === "string" ? this.text(value, csv ? 32768 : 16384) : 0;
    if (!this.#facts.some(([key, old]) => key === name && Object.is(old, value))) {
      if (this.#facts.length === 128) this.fail();
      const factBytes = preparationBytes(name) + (csv ? 0 : bytes);
      if (this.#factBytes + factBytes > 65536 || csv && this.#retainedCsvBytes + bytes > 32768) this.fail();
      this.#factBytes += factBytes; if (csv) this.#retainedCsvBytes += bytes;
      this.#facts.push([name, value]);
    }
    return typeof value === "string" && value.trim() ? value : null;
  }
  read(env: Env, name: string, csv = false): string | null {
    this.text(name, 256); return this.primitive(name, env[name], csv);
  }
  csv(value: string): void {
    const bytes = this.text(value, 32768);
    let entries = 1;
    for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) === 44) entries++;
    if (this.#csvBytes + bytes > 32768 || this.#csvEntries + entries > 1024) this.fail();
    this.#csvBytes += bytes; this.#csvEntries += entries;
  }
  substitute(count: number): void {
    if (this.#substitutions + count > 256) this.fail();
    this.#substitutions += count;
  }
  paths(values: Record<string, string>, styles: Readonly<Record<string, string>> = {}, replacement?: string, replaceKeys: readonly string[] = []): void {
    let count = 0, bytes = 0, encoded = 0, segments = 0;
    const visit = (name: string, original: string) => {
      this.text(name, 256); const value = replacement && replaceKeys.includes(name) ? replacement : original;
      const relative = styles[name] === "relative_path", aws = relative || styles[name] === "opaque_segment";
      bytes += this.text(value, 4096); let parts = 1;
      if (relative) for (const character of value) if (character === "/") parts++;
      segments += parts; encoded += preparationEncodedBytes(value, aws ? "aws" : "component") - (relative ? (parts - 1) * 2 : 0);
      if (++count > 32 || bytes > 4096 || encoded > 8192 || segments > 64) this.fail();
    };
    for (const name in values) if (Object.hasOwn(values, name)) visit(name, values[name]);
    if (replacement) for (const name of replaceKeys) if (!Object.hasOwn(values, name)) visit(name, replacement);
  }
  path(value: string, relative = false, aws = false): number {
    const bytes = this.text(value, 4096);
    let segments = 1;
    if (relative) for (const character of value) if (character === "/") segments++;
    const encoded = preparationEncodedBytes(value, aws ? "aws" : "component") - (relative ? (segments - 1) * 2 : 0);
    if (this.#parameters + 1 > 32 || this.#segments + segments > 64 || this.#pathBytes + bytes > 4096 || this.#encodedPathBytes + encoded > 8192) this.fail();
    this.#parameters++; this.#segments += segments; this.#pathBytes += bytes; this.#encodedPathBytes += encoded;
    return encoded;
  }
  joined(parts: readonly string[], limit: number, separator = ""): void {
    let bytes = 0, units = 0;
    for (let index = 0; index < parts.length; index++) {
      const value = parts[index]; this.text(value, limit);
      bytes += preparationBytes(value) + (index ? preparationBytes(separator) : 0);
      units += value.length + (index ? separator.length : 0);
      if (bytes > limit || units > limit) this.fail();
    }
  }
  url(base: string, path = ""): void {
    this.text(base, 4096);
    if (base.length + path.length > 16384 || preparationBytes(base) + preparationBytes(path) > 16384) this.fail();
  }
  query(name: string, value: string): void {
    this.text(name, 256); this.text(value, 4096);
    const bytes = preparationEncodedBytes(name, "form") + preparationEncodedBytes(value, "form") + 1 + (this.#queryPairs ? 1 : 0);
    if (this.#queryPairs + 1 > 128 || this.#queryBytes + bytes > 8192) this.fail();
    this.#queryPairs++; this.#queryBytes += bytes;
  }
  queryInput(input: URLSearchParams | Record<string, unknown>): void {
    if (input instanceof URLSearchParams) { input.forEach((value, name) => this.query(name, value)); return; }
    for (const name in input) if (Object.hasOwn(input, name)) {
      this.text(name, 256); const value = input[name];
      if (value == null) continue;
      const admit = (item: unknown) => {
        if (!["string", "number", "boolean"].includes(typeof item)) throw new HttpError(400, "invalid_request_body", "manifest query values must be scalars or arrays of scalars");
        if (typeof item === "string") this.text(item, 4096);
        this.query(name, String(item));
      };
      if (Array.isArray(value)) { if (value.length > 128) this.fail(); for (const item of value) admit(item); }
      else admit(value);
    }
  }
  proxyQuery(url: URL, input: URLSearchParams | Record<string, unknown>): void {
    this.queryInput(input);
    let bytes = 0, pairs = 0;
    const add = (name: string, value: string) => {
      bytes += preparationEncodedBytes(name, "form") + preparationEncodedBytes(value, "form") + 1 + (pairs++ ? 1 : 0);
    };
    url.searchParams.forEach((value, name) => {
      const supplied = input instanceof URLSearchParams ? input.has(name) : Object.hasOwn(input, name) && input[name] != null
        && (!Array.isArray(input[name]) || (input[name] as unknown[]).length > 0);
      if (!supplied) add(name, value);
    });
    if (input instanceof URLSearchParams) input.forEach((value, name) => add(name, value));
    else for (const name in input) if (Object.hasOwn(input, name) && input[name] != null) {
      const value = input[name];
      if (Array.isArray(value)) for (const item of value) add(name, String(item));
      else add(name, String(value));
    }
    const added = bytes + (pairs ? 1 : 0);
    if (url.href.length - url.search.length + added > 16384 || preparationBytes(url.href) - preparationBytes(url.search) + added > 16384) this.fail();
  }
  urlQuery(url: URL, name: string, value: string, append = false, charge = true): void {
    if (charge) this.query(name, value);
    let bytes = 0, count = 0;
    url.searchParams.forEach((old, key) => {
      if (!append && key === name) return;
      bytes += preparationEncodedBytes(key, "form") + preparationEncodedBytes(old, "form") + 1 + (count++ ? 1 : 0);
    });
    bytes += preparationEncodedBytes(name, "form") + preparationEncodedBytes(value, "form") + 1 + (count ? 1 : 0);
    const baseUnits = url.href.length - url.search.length, baseBytes = preparationBytes(url.href) - preparationBytes(url.search);
    if (baseUnits + bytes + 1 > 16384 || baseBytes + bytes + 1 > 16384) this.fail();
  }
  mergeHeader(headers: Headers, name: string, appended: string): void {
    const current = headers.get(name) ?? ""; this.text(current, 8192); this.text(appended, 8192);
    let units = 0, bytes = 0, count = 0;
    const scan = (source: string, visit: (lo: number, hi: number) => void) => {
      let start = 0;
      for (let i = 0; i <= source.length; i++) if (i === source.length || source[i] === ",") {
        let lo = start, hi = i; start = i + 1;
        while (lo < hi && /\s/u.test(source[lo])) lo++;
        while (hi > lo && /\s/u.test(source[hi - 1])) hi--;
        if (hi > lo) visit(lo, hi);
      }
    };
    const visit = (source: string, second: boolean) => scan(source, (lo, hi) => {
      let duplicate = false;
      const compare = (old: string, a: number, b: number) => {
        if (b - a !== hi - lo) return;
        for (let i = 0; i < hi - lo; i++) if (old[a + i] !== source[lo + i]) return;
        duplicate = true;
      };
      if (second) scan(current, (a, b) => compare(current, a, b));
      scan(source, (a, b) => { if (a < lo) compare(source, a, b); });
      if (duplicate) return;
      units += hi - lo + (count ? 1 : 0); bytes += count++ ? 1 : 0;
      for (let i = lo; i < hi; i++) {
        const code = source.charCodeAt(i);
        if (code < 128) bytes++; else if (code < 2048) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < hi && source.charCodeAt(i + 1) >= 0xdc00 && source.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
        else bytes += 3;
      }
      if (units > 8192 || bytes > 8192) this.fail();
    });
    visit(current, false); visit(appended, true);
    this.#headerLength(headers, name, bytes);
  }
  headers(headers: Headers, copy = false): void {
    let count = 0, bytes = 0;
    headers.forEach((value, name) => { bytes += this.text(name, 128) + this.text(value, 8192); if (++count > 64 || bytes > 32768) this.fail(); });
    if (copy) this.#writes(count, bytes);
  }
  #writes(count: number, bytes: number): void {
    if (this.#headerWrites + count > 256 || this.#headerBytes + bytes > 65536) this.fail();
    this.#headerWrites += count; this.#headerBytes += bytes;
  }
  headerPlan(headers: Headers, writes: ReadonlyArray<readonly [string, string]>, commit = true): void {
    let bytes = 0, count = 0, finalBytes = 0;
    for (const [name, value] of writes) bytes += this.text(name, 128) + this.text(value, 8192);
    headers.forEach((value, name) => {
      if (!writes.some(([key]) => key.toLowerCase() === name)) { count++; finalBytes += preparationBytes(name) + preparationBytes(value); }
    });
    for (let i = 0; i < writes.length; i++) {
      const [name, value] = writes[i];
      if (writes.some(([key], index) => index > i && key.toLowerCase() === name.toLowerCase())) continue;
      count++; finalBytes += preparationBytes(name.toLowerCase()) + preparationBytes(value.trim());
    }
    if (count > 64 || finalBytes > 32768 || this.#headerWrites + writes.length > 256 || this.#headerBytes + bytes > 65536) this.fail();
    if (commit) this.#writes(writes.length, bytes);
  }
  header(headers: Headers, name: string, value: string): void {
    this.text(value, 8192);
    this.#headerLength(headers, name, preparationBytes(value), preparationBytes(value.trim()));
  }
  #headerLength(headers: Headers, name: string, valueBytes: number, trimmedBytes = valueBytes): void {
    const bytes = this.text(name, 128) + valueBytes;
    const lower = name.toLowerCase(); let count = 1, finalBytes = preparationBytes(lower) + trimmedBytes;
    headers.forEach((old, key) => { if (key !== lower) { count++; finalBytes += preparationBytes(key) + preparationBytes(old); } });
    if (count > 64 || finalBytes > 32768) this.fail();
    this.#writes(1, bytes);
  }
}

export function preparationBytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 128) bytes++; else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

export function preparationEncodedBytes(value: string, mode: "component" | "form" | "aws"): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const safe = /[A-Za-z0-9_.-]/.test(character) || mode === "form" && character === "*"
      || mode !== "form" && character === "~" || mode === "component" && "!'()*".includes(character);
    bytes += safe || mode === "form" && character === " " ? 1 : (code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4) * 3;
  }
  return bytes;
}

export function preparationValue(env: Env, name: string, owner?: PreparationAdmission, csv = false): string | null {
  return owner ? owner.read(env, name, csv) : envValue(env, name);
}
export function preparationHeader(headers: Headers, name: string, value: string, owner?: PreparationAdmission): void {
  owner?.header(headers, name, value); headers.set(name, value);
}

// Complete expansion admission precedes replace; the callback retains no Env.
export function preparationReplace(value: string, pattern: RegExp | string, resolve: (name: string) => string, owner?: PreparationAdmission, limit = 16384): string {
  if (!owner) return typeof pattern === "string" ? value.replace(pattern, resolve(pattern)) : value.replace(pattern, (_, name: string) => resolve(name));
  owner.text(value, limit);
  const replacements: string[] = []; let units = value.length, bytes = preparationBytes(value);
  if (typeof pattern === "string") {
    const replacement = resolve(pattern); owner.text(replacement, limit);
    if (!value.includes(pattern)) return value;
    owner.substitute(1);
    const at = value.indexOf(pattern); let replacementUnits = 0, replacementBytes = 0;
    for (let i = 0; i < replacement.length;) {
      let part: string;
      if (replacement[i] === "$" && i + 1 < replacement.length && "$&`'".includes(replacement[i + 1])) {
        const code = replacement[i + 1]; i += 2;
        part = code === "$" ? "$" : code === "&" ? pattern : code === "`" ? value.slice(0, at) : value.slice(at + pattern.length);
      } else { const code = replacement.codePointAt(i)!; part = String.fromCodePoint(code); i += part.length; }
      replacementUnits += part.length; replacementBytes += preparationBytes(part);
      if (replacementUnits > limit || replacementBytes > limit) owner.fail();
    }
    units += replacementUnits - pattern.length; bytes += replacementBytes - preparationBytes(pattern);
    if (units > limit || bytes > limit) owner.fail();
    return value.replace(pattern, replacement);
  }
  pattern.lastIndex = 0;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    owner.substitute(1); const replacement = resolve(match[1]); owner.text(replacement, limit);
    units += replacement.length - match[0].length; bytes += preparationBytes(replacement) - preparationBytes(match[0]); replacements.push(replacement);
    if (!pattern.global) break;
  }
  if (units > limit || bytes > limit) owner.fail();
  let index = 0; return value.replace(pattern, () => replacements[index++]);
}

export function optionalConfigKeys(provider: CompiledProvider, env: Env, owner?: PreparationAdmission): Set<string> {
  const csv = preparationValue(env, "CLAWROUTER_OPTIONAL_CONFIG_KEYS", owner, true) ?? "";
  return new Set([...provider.optional_config_keys, ...providerConfigurationList(csv, owner)]);
}

export function templateCandidates(provider: CompiledProvider, name: string, owner?: PreparationAdmission): string[] {
  owner?.text(name, 256);
  const normalized = name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  if (!owner) return provider.config_keys.filter(key => key === normalized || key.endsWith(`_${normalized}`));
  const candidates: string[] = [];
  for (const key of provider.config_keys) if (key === normalized || key.endsWith(`_${normalized}`)) {
    owner.text(key, 256); if (candidates.length === 128) owner.fail(); candidates.push(key);
  }
  return candidates;
}

export function resolveTemplate(provider: CompiledProvider, value: string, env: Env, owner?: PreparationAdmission, limit = 16384): string {
  return renderTemplate(provider, value, env, undefined, owner, limit)!;
}

export function resolveHeaderTemplate(provider: CompiledProvider, value: string, env: Env, owner?: PreparationAdmission): string | null {
  return renderTemplate(provider, value, env, optionalConfigKeys(provider, env, owner), owner, 8192);
}

export function applyTemplateHeaders(provider: CompiledProvider, values: Record<string, string>, env: Env, headers: Headers, owner?: PreparationAdmission): void {
  for (const [name, value] of Object.entries(values)) {
    const resolved = resolveHeaderTemplate(provider, value, env, owner);
    if (resolved !== null) preparationHeader(headers, name, resolved, owner);
  }
}

function renderTemplate(provider: CompiledProvider, value: string, env: Env, optional?: ReadonlySet<string>, owner?: PreparationAdmission, limit = 16384): string | null {
  let omit = false;
  const resolved = preparationReplace(value, /\$\{([^}]+)\}/g, (name: string) => {
    const candidates = templateCandidates(provider, name, owner);
    let selected: string | null = null;
    const key = candidates.find((candidate) => (selected = preparationValue(env, candidate, owner)));
    if (key) return selected!;
    if (candidates.length && candidates.every((candidate) => optional?.has(candidate))) {
      omit = true;
      return "";
    }
    throw new HttpError(503, "provider_not_configured", `missing Cloudflare config value ${name} for provider ${provider.id}`);
  }, owner, limit);
  // Resolve every binding before omitting a header: an optional field must not
  // hide a missing required field in the same template.
  return omit ? null : resolved;
}
