import assert from "node:assert/strict";
import test from "node:test";
import { createCopilotAccountProjection } from "../copilot-account-projection.ts";
import { qualifyCopilotIdentity } from "../provider-copilot.ts";

const encode = text => new TextEncoder().encode(text);
const invalid = { message: "invalid_copilot_account_projection" };
function project(input, size = Infinity) {
  const bytes = typeof input === "string" ? encode(input) : input;
  const parser = createCopilotAccountProjection();
  for (let offset = 0; offset < bytes.length; offset += size) parser.push(bytes.subarray(offset, offset + size));
  return parser.finish();
}
const reject = input => assert.throws(() => project(input), invalid);
const oracle = text => {
  const value = JSON.parse(text);
  return !Object.hasOwn(value, "endpoints") ? {} : { endpoints: !Object.hasOwn(value.endpoints, "api") ? {} : { api: value.endpoints.api } };
};

test("absent endpoints, absent api, null and empty remain distinct frozen projections", () => {
  for (const text of ['{}', '{"endpoints":{}}', '{"endpoints":{"api":null}}', '{"endpoints":{"api":""}}', '{"endpoints":{"api":"https://api.individual.githubcopilot.com/base/"}}']) {
    const result = project(text, 1);
    assert.deepEqual(result, oracle(text));
    assert.ok(Object.isFrozen(result));
    if (result.endpoints) assert.ok(Object.isFrozen(result.endpoints));
  }
});

test("existing selected-domain fallback and nonempty base paths are unchanged", () => {
  for (const domain of ["github.com", "fixture.ghe.com"]) {
    for (const text of ['{}', '{"endpoints":{}}', '{"endpoints":{"api":null}}', '{"endpoints":{"api":""}}']) {
      assert.deepEqual(qualifyCopilotIdentity(project(text), domain, "original-owner"), qualifyCopilotIdentity(JSON.parse(text), domain, "original-owner"));
    }
  }
  const text = '{"endpoints":{"api":"https://api.individual.githubcopilot.com/existing/base/"}}';
  assert.equal(project(text).endpoints.api, JSON.parse(text).endpoints.api);
  assert.equal(qualifyCopilotIdentity(project(text), "github.com", "original-owner").apiBaseUrl, "https://api.individual.githubcopilot.com/existing/base");
  const foreign = project('{"endpoints":{"api":"https://foreign.example/path"}}');
  assert.equal(foreign.endpoints.api, "https://foreign.example/path");
  assert.throws(() => qualifyCopilotIdentity(foreign, "github.com", "original-owner"), /api_origin/);
});

test("wrong authority shapes never turn into empty fallback", () => {
  for (const text of ['null', '[]', 'true', '1', '"x"', '{"endpoints":null}', '{"endpoints":[]}', '{"endpoints":1}', '{"endpoints":""}', '{"endpoints":false}', '{"endpoints":{"api":{}}}', '{"endpoints":{"api":[]}}', '{"endpoints":{"api":0}}', '{"endpoints":{"api":true}}']) reject(text);
});

test("authority duplicates reject escaped equivalents; unknown duplicates remain legal", () => {
  for (const text of ['{"endpoints":{},"endpoints":{}}', '{"endpoints":{},"\\u0065ndpoints":{}}', '{"endpoints":{"api":null,"a\\u0070i":""}}', '{"endpoints":{"\\u0061pi":"","api":""}}']) reject(text);
  const text = '{"other":{"api":1,"api":2,"endpoints":[]},"other":false,"endpoints":{"ignored":1,"ignored":2,"api":null}}';
  assert.deepEqual(project(text, 1), oracle(text));
  assert.deepEqual(project('{"Endpoints":null,"endpoints":{"API":false}}'), { endpoints: {} });
});

test("raw and escaped UTF-16 including lone escaped surrogates match JSON.parse", () => {
  for (const value of ["é", "🦊", "\ud800", "\udfff", "\ud800x\udc00", "\u0000\b\f\n\r\t\"\\/", "e\u0301", "\ufeff"]) {
    const text = JSON.stringify({ ignored: value, endpoints: { api: value } });
    assert.deepEqual(project(text, 1), oracle(text));
  }
  assert.deepEqual(project('{"\\u0065ndpoints":{"\\u0061pi":"\\ud83e\\udd8a"}}', 1), { endpoints: { api: "🦊" } });
});

test("every byte split preserves fragmented UTF-8, keys, escapes, numbers and literal state", () => {
  const text = '{"ignored":[-1.25e+12,true,false,null,"é🦊"],"\\u0065ndpoints":{"api":"x\\uD800/🦊"}}';
  const bytes = encode(text);
  for (let split = 0; split <= bytes.length; split++) {
    const parser = createCopilotAccountProjection();
    parser.push(bytes.subarray(0, split)); parser.push(bytes.subarray(split));
    assert.deepEqual(parser.finish(), oracle(text));
  }
});

test("initial BOM agrees with native Response text decoding; other BOM positions stay JSON data or error", async () => {
  const bytes = encode('\ufeff{"endpoints":{"api":"\ufeff"}}');
  const native = await new Response(bytes).text();
  assert.deepEqual(project(bytes, 1), oracle(native));
  reject('\ufeff\ufeff{}'); reject(' \ufeff{}'); reject('{}\ufeff');
});

test("fatal UTF-8 rejects overlong, surrogate, out-of-range, stray and truncated sequences", () => {
  const prefix = encode('{"ignored":"'), suffix = encode('"}');
  for (const malformed of [[0x80], [0xc0,0x80], [0xc1,0xbf], [0xc2], [0xc2,0x20], [0xe0,0x80,0x80], [0xed,0xa0,0x80], [0xf0,0x80,0x80,0x80], [0xf4,0x90,0x80,0x80], [0xf5,0x80,0x80,0x80], [0xff]]) {
    reject(Uint8Array.from([...prefix, ...malformed, ...suffix]));
    reject(Uint8Array.from([...prefix, ...malformed]));
  }
});

test("complete JSON number grammar is checked without retaining or interpreting numeric facts", () => {
  for (const number of ['0', '-0', '12', '-123', '0.5', '-0.01', '1e2', '1E+2', '1e-2', '1e99999', '9'.repeat(10000)]) assert.deepEqual(project(`{"ignored":${number}}`, 1), {});
  for (const number of ['+1', '01', '-01', '.1', '1.', '-', '1e', '1e+', '1e-', '1..2', '1e2e3', 'NaN', 'Infinity', '0x1', '1 2', '--1']) reject(`{"ignored":${number}}`);
});

test("malformed syntax and trailing content never release an earlier valid authority field", () => {
  for (const tail of [',', ',"x":', ',"x":[1,]', ',"x":"unterminated', ',"x":tru', ',"x":nul', ',"x":falsee', ',"x":1e', ',"x":{"k" 1}', ',"x":"\\q"', ',"x":"\\u123x"', ',"x":"\n"']) reject('{"endpoints":{"api":"synthetic-private-value"}}'.slice(0, -1) + tail + '}');
  for (const text of ['', ' ', '{', '}', '{,}', '{"x":}', '{"x":1,}', '{"x"::1}', '{"x":[,]}', '{"x":[1}}', '{}{}', '{} synthetic-private-value']) reject(text);
});

test("borrowed byte views are never retained or re-read", () => {
  const parser = createCopilotAccountProjection();
  const input = encode('{"endpoints":{"api":"https://example.test/base"},"discard":"🦊"}');
  const borrowed = new Uint8Array(7);
  for (let offset = 0; offset < input.length; offset += borrowed.length) {
    const length = Math.min(borrowed.length, input.length - offset);
    borrowed.set(input.subarray(offset, offset + length)); parser.push(borrowed.subarray(0, length)); borrowed.fill(0xff);
  }
  assert.deepEqual(parser.finish(), { endpoints: { api: "https://example.test/base" } });
});

test("all failures poison state and no result is available twice or before complete EOF", () => {
  const parser = createCopilotAccountProjection(); parser.push(encode('{"endpoints":{"api":"x"}'));
  assert.throws(() => parser.finish(), invalid); assert.throws(() => parser.push(encode('}')), invalid); assert.throws(() => parser.finish(), invalid);
  const complete = createCopilotAccountProjection(); complete.push(encode('{}')); assert.deepEqual(complete.finish(), {});
  assert.throws(() => complete.push(new Uint8Array()), invalid); assert.throws(() => complete.finish(), invalid);
  const malformed = createCopilotAccountProjection(); assert.throws(() => malformed.push(encode('{]')), invalid); assert.throws(() => malformed.finish(), invalid);
  const type = createCopilotAccountProjection(); assert.throws(() => type.push('not bytes'), invalid); assert.throws(() => type.finish(), invalid);
});

test("16 MiB exact wire bound includes ignored strings, whitespace, BOM and UTF-8 bytes", () => {
  const cap = 16 * 1024 * 1024;
  for (const prefix of ['{"ignored":"', '\ufeff{"ignored":"é']) {
    const text = prefix + 'x'.repeat(cap - encode(prefix + '"}').length) + '"}';
    assert.equal(encode(text).length, cap); assert.deepEqual(project(text, 16384), {}); reject(text + ' ');
  }
  assert.deepEqual(project('{}' + ' '.repeat(cap - 2), 32768), {});
});

test("URL bound is decoded UTF-16 units, with no trimming, normalization or truncation", () => {
  for (const value of ['x'.repeat(4096), '🦊'.repeat(2048), '\ud800'.repeat(4096)]) {
    const text = JSON.stringify({ endpoints: { api: value } });
    assert.deepEqual(project(text, 1), oracle(text));
    reject(JSON.stringify({ endpoints: { api: value + 'x' } }));
  }
  const value = ' https://example.test/base/?unchanged#fragment ';
  assert.equal(project(JSON.stringify({ endpoints: { api: value } })).endpoints.api, value);
});

test("depth 64 and container count 512 include ignored containers", () => {
  assert.deepEqual(project('{"x":' + '['.repeat(63) + '0' + ']'.repeat(63) + '}'), {});
  reject('{"x":' + '['.repeat(64) + '0' + ']'.repeat(64) + '}');
  const build = n => '{"x":[' + Array(n).fill('{}').join(',') + ']}';
  assert.deepEqual(project(build(510)), {}); reject(build(511));
});

test("member count 2048 includes ignored duplicate and escaped keys", () => {
  const build = n => '{' + Array(n).fill('"\\u0078":0').join(',') + '}';
  assert.deepEqual(project(build(2048)), {}); reject(build(2049));
});

test("array-entry count 2048 is aggregate, not per array", () => {
  const build = n => '{"x":[' + Array(1024).fill('0').join(',') + '],"y":[' + Array(n).fill('0').join(',') + ']}';
  assert.deepEqual(project(build(1024)), {}); reject(build(1025));
});

test("4097 values is reachable and the next necessarily breaches a member or entry limit", () => {
  const build = n => '{' + Array(2047).fill('"":null').join(',') + ',"array":[' + Array(n).fill('0').join(',') + ']}';
  assert.deepEqual(project(build(2048)), {}); reject(build(2049));
});

test("declared parser storage stays two fixed typed buffers with no AST, decoder or whole text", () => {
  const input = encode('{"unknown":"' + 'x'.repeat(100000) + '","endpoints":{"api":"original"}}');
  const original = globalThis.Uint16Array, parse = JSON.parse, decoder = globalThis.TextDecoder;
  const allocated = [];
  globalThis.Uint16Array = new Proxy(original, { construct(target, args) { if (typeof args[0] === 'number') allocated.push(args[0]); return Reflect.construct(target, args, target); } });
  JSON.parse = () => { throw new Error('unexpected AST'); };
  globalThis.TextDecoder = class { constructor() { throw new Error('unexpected decoded archive'); } };
  try { assert.deepEqual(project(input, 13), { endpoints: { api: "original" } }); }
  finally { globalThis.Uint16Array = original; JSON.parse = parse; globalThis.TextDecoder = decoder; }
  assert.deepEqual(allocated, [64 * 3, 4096]);
  // This proves declared storage, not engine heap, transport or a pool charge.
});

test("deterministic nested metadata oracle agrees with JSON.parse projection across feed sizes", () => {
  let seed = 183;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const leaf = [null, true, false, 0, -1.25, 'é🦊', '\ud800', '\u0000'];
  const metadata = depth => depth === 0 || random() % 3 === 0 ? leaf[random() % leaf.length] : random() % 2 ? [metadata(depth - 1), metadata(depth - 1)] : { a: metadata(depth - 1), b: metadata(depth - 1) };
  for (let i = 0; i < 100; i++) {
    const body = { discarded: metadata(4) };
    if (i % 4) body.endpoints = i % 4 === 1 ? {} : { api: i % 4 === 2 ? null : `https://example.test/é/${i}` };
    const text = JSON.stringify(body);
    for (const size of [1, 2, 7, 1024]) assert.deepEqual(project(text, size), oracle(text));
  }
});
