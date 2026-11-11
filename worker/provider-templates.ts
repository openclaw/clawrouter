import { ownedHttpRequestReceiver } from "./proxy-completion.ts";
import type { OwnedHttpRequest } from "./http-identity-owner.ts";
import { identityFailure } from "./identity-admission.ts";
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
    // CSV is a processing allowance, never a retained oversized primitive.
    if (csv) {
      if (typeof value !== "string") return null;
      this.csv(value);
      return /\S/u.test(value) ? value : null;
    }
    const bytes = typeof value === "string" ? this.text(value, 16384) : 0;
    if (!this.#facts.some(([key, old]) => key === name && Object.is(old, value))) {
      if (this.#facts.length === 128) this.fail();
      const factBytes = preparationBytes(name) + bytes;
      if (this.#factBytes + factBytes > 65536) this.fail();
      this.#factBytes += factBytes;
      this.#facts.push([name, value]);
    }
    return typeof value === "string" && /\S/u.test(value) ? value : null;
  }
  read(env: Env, name: string, csv = false): string | null {
    if (isPrivateConfiguration(this)) {
      this.text(name, 256);
      let value: unknown;
      // Only the actual getter is opaque. Name/primitive/admission failures
      // remain outside this catch, including a reentrant terminal refusal.
      try { value = env[name]; }
      catch { throw privateProviderConfigurationFailure(this); }
      return this.primitive(name, value, csv);
    }
    this.text(name, 256); return this.primitive(name, env[name], csv);
  }
  csv(value: string): void {
    const bytes = this.text(value, 32768);
    let entries = 1;
    for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) === 44) entries++;
    if (this.#csvBytes + bytes > 32768 || this.#csvEntries + entries > 1024) this.fail();
    this.#csvBytes += bytes; this.#csvEntries += entries;
  }
  csvToken(name: string, source: string, lo: number, hi: number): string {
    this.text(name, 256);
    const bytes = preparationBytes(source, lo, hi);
    if (hi - lo > 16384 || bytes > 16384) this.fail();
    for (const [key, value] of this.#facts) if (key === name && typeof value === "string" && value.length === hi - lo && source.startsWith(value, lo)) return value;
    const factBytes = preparationBytes(name) + bytes;
    if (this.#facts.length === 128 || this.#factBytes + factBytes > 65536) this.fail();
    const token = source.slice(lo, hi);
    this.#factBytes += factBytes; this.#facts.push([name, token]);
    return token;
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
  queryInput(input: URLSearchParams | Record<string, unknown>): URLSearchParams {
    if (input instanceof URLSearchParams) { input.forEach((value, name) => this.query(name, value)); return input; }
    // Keep only admitted pairs. Null entries never reach the bulk record converter.
    const pairs: Array<[string, string]> = [];
    for (const name in input) if (Object.hasOwn(input, name)) {
      const value = input[name];
      if (value == null) continue;
      this.text(name, 256);
      const admit = (item: unknown) => {
        if (!["string", "number", "boolean"].includes(typeof item)) throw new HttpError(400, "invalid_request_body", "manifest query values must be scalars or arrays of scalars");
        if (typeof item === "string") this.text(item, 4096);
        const text = String(item); this.query(name, text); pairs.push([name, text]);
      };
      if (Array.isArray(value)) { if (value.length > 128) this.fail(); for (const item of value) admit(item); }
      else admit(value);
    }
    return new URLSearchParams(pairs);
  }
  rawQuery(input: string): URLSearchParams {
    this.text(input, 8192);
    let start = input.startsWith("?") ? 1 : 0, count = 0, bytes = 0, pairs = 0;
    for (let end = start; end <= input.length; end++) if (end === input.length || input.charCodeAt(end) === 38) {
      if (++count + this.#queryPairs > 128) this.fail();
      if (end > start) {
        let equal = start; while (equal < end && input.charCodeAt(equal) !== 61) equal++;
        const name = formRange(input, start, equal, 256, this);
        const value = formRange(input, equal < end ? equal + 1 : end, end, 4096, this);
        bytes += name + value + 1 + (this.#queryPairs + pairs ? 1 : 0); pairs++;
        if (this.#queryBytes + bytes > 8192) this.fail();
      }
      start = end + 1;
    }
    this.#queryPairs += count; this.#queryBytes += bytes;
    return new URLSearchParams(input);
  }
  proxyQuery(url: URL, input: URLSearchParams | Record<string, unknown>): URLSearchParams {
    const query = this.queryInput(input);
    let bytes = 0, pairs = 0;
    const add = (name: string, value: string) => {
      bytes += preparationEncodedBytes(name, "form") + preparationEncodedBytes(value, "form") + 1 + (pairs++ ? 1 : 0);
    };
    url.searchParams.forEach((value, name) => { if (!query.has(name)) add(name, value); });
    query.forEach((value, name) => add(name, value));
    const added = bytes + (pairs ? 1 : 0);
    if (url.href.length - url.search.length + added > 16384 || preparationBytes(url.href) - preparationBytes(url.search) + added > 16384) this.fail();
    return query;
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
      count++; finalBytes += preparationBytes(name.toLowerCase()) + preparationBytes(value);
    }
    if (count > 64 || finalBytes > 32768 || this.#headerWrites + writes.length > 256 || this.#headerBytes + bytes > 65536) this.fail();
    if (commit) this.#writes(writes.length, bytes);
  }
  header(headers: Headers, name: string, value: string): void {
    this.text(value, 8192);
    this.#headerLength(headers, name, preparationBytes(value));
  }
  #headerLength(headers: Headers, name: string, valueBytes: number): void {
    const bytes = this.text(name, 128) + valueBytes;
    const lower = name.toLowerCase(); let count = 1, finalBytes = preparationBytes(lower) + valueBytes;
    headers.forEach((old, key) => { if (key !== lower) { count++; finalBytes += preparationBytes(key) + preparationBytes(old); } });
    if (count > 64 || finalBytes > 32768) this.fail();
    this.#writes(1, bytes);
  }
}

export function preparationBytes(value: string, start = 0, end = value.length): number {
  let bytes = 0;
  for (let index = start; index < end; index++) {
    const code = value.charCodeAt(index);
    if (code < 128) bytes++; else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < end && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

// WHATWG form percent decoding + UTF-8 replacement, measured without a decoded copy.
function formRange(source: string, start: number, end: number, limit: number, owner: PreparationAdmission): number {
  let units = 0, bytes = 0, encoded = 0, needed = 0, seen = 0, point = 0, lower = 128, upper = 191;
  const emit = (code: number) => {
    units += code > 0xffff ? 2 : 1;
    const width = code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
    bytes += width;
    encoded += code === 32 || code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 42 || code === 45 || code === 46 || code === 95 ? 1 : width * 3;
    if (units > limit || bytes > limit) owner.fail();
  };
  const feed = (byte: number) => {
    if (needed && (byte < lower || byte > upper)) { needed = seen = point = 0; lower = 128; upper = 191; emit(0xfffd); }
    if (!needed) {
      if (byte < 128) { emit(byte); return; }
      if (byte >= 194 && byte <= 223) { needed = 1; point = byte & 31; }
      else if (byte >= 224 && byte <= 239) { needed = 2; point = byte & 15; if (byte === 224) lower = 160; if (byte === 237) upper = 159; }
      else if (byte >= 240 && byte <= 244) { needed = 3; point = byte & 7; if (byte === 240) lower = 144; if (byte === 244) upper = 143; }
      else emit(0xfffd);
      return;
    }
    lower = 128; upper = 191; point = (point << 6) | (byte & 63);
    if (++seen === needed) { emit(point); needed = seen = point = 0; }
  };
  const hex = (code: number) => code >= 48 && code <= 57 ? code - 48 : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
  for (let i = start; i < end; i++) {
    let code = source.charCodeAt(i);
    if (code === 37 && i + 2 < end) {
      const a = hex(source.charCodeAt(i + 1)), b = hex(source.charCodeAt(i + 2));
      if (a >= 0 && b >= 0) { feed(a * 16 + b); i += 2; continue; }
    }
    if (code === 43) code = 32;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < end && source.charCodeAt(i + 1) >= 0xdc00 && source.charCodeAt(i + 1) <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + source.charCodeAt(++i) - 0xdc00; }
    else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 128) feed(code);
    else if (code < 2048) { feed(192 | (code >> 6)); feed(128 | (code & 63)); }
    else if (code < 65536) { feed(224 | (code >> 12)); feed(128 | ((code >> 6) & 63)); feed(128 | (code & 63)); }
    else { feed(240 | (code >> 18)); feed(128 | ((code >> 12) & 63)); feed(128 | ((code >> 6) & 63)); feed(128 | (code & 63)); }
  }
  if (needed) emit(0xfffd);
  return encoded;
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
      let source = replacement, lo = i, hi = i + 1;
      if (replacement[i] === "$" && i + 1 < replacement.length && "$&`'".includes(replacement[i + 1])) {
        const code = replacement[i + 1]; i += 2;
        if (code === "&") { source = pattern; lo = 0; hi = pattern.length; }
        else if (code === "`") { source = value; lo = 0; hi = at; }
        else if (code === "'") { source = value; lo = at + pattern.length; hi = value.length; }
      } else { hi = i + (replacement.codePointAt(i)! > 0xffff ? 2 : 1); i = hi; }
      replacementUnits += hi - lo; replacementBytes += preparationBytes(source, lo, hi);
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
  if (!owner) return new Set([...provider.optional_config_keys, ...providerConfigurationList(csv)]);
  const optional = new Set<string>();
  for (const key of provider.optional_config_keys) {
    owner.text(key, 256); owner.primitive("CLAWROUTER_OPTIONAL_CONFIG_KEYS", key); optional.add(key);
  }
  for (const key of providerConfigurationList(csv, owner, "CLAWROUTER_OPTIONAL_CONFIG_KEYS", provider.config_keys, true)) optional.add(key);
  return optional;
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
    if (owner && privateConfigurations && configurationApply(configurationGet, privateConfigurations, [owner]))
      throw privateConfigurationFailure(owner, name, provider);
    throw new HttpError(503, "provider_not_configured", `missing Cloudflare config value ${name} for provider ${provider.id}`);
  }, owner, limit);
  // Resolve every binding before omitting a header: an optional field must not
  // hide a missing required field in the same template.
  return omit ? null : resolved;
}

// Private command state is lazy and external to ordinary preparation instances.
// The one empty registry container stays in the permanent fixed slice after its
// first private claim; every live entry/slot/nonce remains charged to its request.
interface PrivateConfigurationSlot { http: OwnedHttpRequest; nonce: object; error?: HttpError; consumed: boolean }
let privateConfigurations: WeakMap<PreparationAdmission, PrivateConfigurationSlot> | undefined;
const configurationMap = WeakMap;
const configurationGet = WeakMap.prototype.get;
const configurationSet = WeakMap.prototype.set;
const configurationDelete = WeakMap.prototype.delete;
const configurationApply = Reflect.apply;
const configurationFreeze = Object.freeze;
export function beginPrivateConfiguration(http: OwnedHttpRequest, preparation: PreparationAdmission, providerPermit?: object): object {
  admitOwnedHttpConfigurationCommand(http, preparation, providerPermit);
  if (privateConfigurations && configurationApply(configurationGet, privateConfigurations, [preparation])) throw identityFailure("protocol");
  const nonce = configurationFreeze({});
  const slot: PrivateConfigurationSlot = { __proto__: null, http, nonce, error: undefined, consumed: false } as PrivateConfigurationSlot;
  configurationApply(configurationSet, privateConfigurations ??= new configurationMap(), [preparation, slot]);
  return nonce;
}
export function isPrivateConfiguration(preparation: PreparationAdmission | undefined): boolean {
  return !!preparation && !!privateConfigurations && !!configurationApply(configurationGet, privateConfigurations, [preparation]);
}
export function matchesPrivateConfigurationError(preparation: PreparationAdmission, error: unknown): boolean {
  const slot = privateConfigurations && configurationApply(configurationGet, privateConfigurations, [preparation]) as PrivateConfigurationSlot | undefined;
  return !!slot && !slot.consumed && slot.error !== undefined && slot.error === error;
}
function privateConfigurationFailure(preparation: PreparationAdmission, name: string, provider: CompiledProvider): HttpError {
  return configurationFailure(preparation, 0, name, provider);
}
export function privateGrantTransportFailure(preparation: PreparationAdmission): HttpError { return configurationFailure(preparation, 1); }
export function privateProviderConfigurationFailure(preparation: PreparationAdmission): HttpError { return configurationFailure(preparation, 2); }
export function privateMissingCredentialFailure(preparation: PreparationAdmission, provider: CompiledProvider): HttpError { return configurationFailure(preparation, 3, undefined, provider); }
export function privateAwsCredentialFailure(preparation: PreparationAdmission): HttpError { return configurationFailure(preparation, 4); }
export function privateTransportBodyFailure(preparation: PreparationAdmission): HttpError { return configurationFailure(preparation, 5); }
export function privateGrantTemplateFailure(preparation: PreparationAdmission, name: string): HttpError { return configurationFailure(preparation, 6, name); }
// Site is module-owned, never a caller-supplied status/code/message or formatter.
function configurationFailure(preparation: PreparationAdmission, site: 0 | 1 | 2 | 3 | 4 | 5 | 6, name?: string, provider?: CompiledProvider): HttpError {
  const slot = privateConfigurations && configurationApply(configurationGet, privateConfigurations, [preparation]) as PrivateConfigurationSlot | undefined;
  if (!slot || slot.error || slot.consumed) throw identityFailure("protocol");
  const nonce = slot.nonce;
  // Keep the provider.id read at the original message-evaluation point, once.
  const providerId = site === 0 || site === 3 ? provider!.id : undefined;
  if ((site === 0 || site === 3) && typeof providerId !== "string" || (site === 0 || site === 6) && typeof name !== "string") throw identityFailure("protocol");
  if (!privateConfigurations || configurationApply(configurationGet, privateConfigurations, [preparation]) !== slot
    || slot.nonce !== nonce || slot.error || slot.consumed) throw identityFailure("protocol");
  const code = site === 0 || site === 3 || site === 4 ? "provider_not_configured"
    : site === 1 || site === 6 ? "grant_transport_unavailable" : "provider_request_invalid";
  const units = site === 0 ? 46 + name!.length + providerId!.length : site === 1 ? 54 : site === 2 ? 41
    : site === 3 ? 43 + providerId!.length : site === 4 ? 51 : site === 5 ? 56 : 25 + name!.length;
  admitOwnedHttpErrorText(slot.http, units + code.length);
  if (!privateConfigurations || configurationApply(configurationGet, privateConfigurations, [preparation]) !== slot
    || slot.nonce !== nonce || slot.error || slot.consumed) throw identityFailure("protocol");
  const message = site === 0 ? `missing Cloudflare config value ${name} for provider ${providerId}`
    : site === 1 ? "upstream authorization does not support this operation"
    : site === 2 ? "provider request configuration is invalid"
    : site === 3 ? `provider ${providerId} has no usable upstream credential`
    : site === 4 ? "AWS access key, secret key, and region are required"
    : site === 5 ? "system instruction transforms require a JSON object body" : `grant transport requires ${name}`;
  const error = configurationFreeze(new HttpError(site === 1 || site === 5 || site === 6 ? 400 : 503, code, message));
  if (configurationApply(configurationGet, privateConfigurations, [preparation]) !== slot
    || slot.nonce !== nonce || slot.error || slot.consumed) throw identityFailure("protocol");
  slot.error = error;
  return error;
}
export function consumePrivateConfiguration(preparation: PreparationAdmission, nonce: object, error: unknown): error is HttpError {
  const slot = privateConfigurations && configurationApply(configurationGet, privateConfigurations, [preparation]) as PrivateConfigurationSlot | undefined;
  if (!slot || slot.nonce !== nonce || slot.consumed || slot.error === undefined || slot.error !== error) return false;
  slot.consumed = true;
  return true;
}
export function endPrivateConfiguration(preparation: PreparationAdmission, nonce: object): void {
  const slot = privateConfigurations && configurationApply(configurationGet, privateConfigurations, [preparation]) as PrivateConfigurationSlot | undefined;
  if (!slot || slot.nonce !== nonce) throw identityFailure("protocol");
  slot.error = undefined; slot.http = undefined as never; slot.nonce = undefined as never;
  configurationApply(configurationDelete, privateConfigurations!, [preparation]);
}

function admitOwnedHttpConfigurationCommand(cap: Parameters<typeof import("./http-identity-owner.ts").admitOwnedHttpConfigurationCommand>[0], preparation: Parameters<typeof import("./http-identity-owner.ts").admitOwnedHttpConfigurationCommand>[1], providerPermit?: Parameters<typeof import("./http-identity-owner.ts").admitOwnedHttpConfigurationCommand>[2]): ReturnType<typeof import("./http-identity-owner.ts").admitOwnedHttpConfigurationCommand> {
  const receiver = ownedHttpRequestReceiver(cap);
  if (!receiver) throw identityFailure("protocol");
  return receiver.admitOwnedHttpConfigurationCommand(cap, preparation, providerPermit);
}

function admitOwnedHttpErrorText(cap: Parameters<typeof import("./http-identity-owner.ts").admitOwnedHttpErrorText>[0], units: Parameters<typeof import("./http-identity-owner.ts").admitOwnedHttpErrorText>[1]): ReturnType<typeof import("./http-identity-owner.ts").admitOwnedHttpErrorText> {
  const receiver = ownedHttpRequestReceiver(cap);
  if (!receiver) throw identityFailure("protocol");
  return receiver.admitOwnedHttpErrorText(cap, units);
}
