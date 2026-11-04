import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { inspectCopilotJsonText } from "../copilot-json-guard.ts";

const inspect = (text, profile = "catalog") => inspectCopilotJsonText(text, profile);
const limited = error => error instanceof RangeError && error.message === "copilot_json_limit";
const malformed = error => error instanceof SyntaxError && error.message === "invalid_copilot_json";
const array = (item, count) => "[" + Array(count).fill(item).join(",") + "]";
const members = count => "{" + Array(count).fill('"":0').join(",") + "}";

test("statistics count containers and primitive values, not keys, including overwritten occurrences", () => {
  const text = '{"a":[{"b":"é🦊"},null,true,4],"a":"tail"}';
  const result = inspect(text);
  assert.deepEqual(result, { utf8Bytes: Buffer.byteLength(text), depth: 3, values: 8, containers: 3, members: 3, arrayEntries: 4, decodedStringUnits: 10 });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(JSON.parse(text), { a: "tail" });
  assert.deepEqual(inspect("null"), { utf8Bytes: 4, depth: 1, values: 1, containers: 0, members: 0, arrayEntries: 0, decodedStringUnits: 0 });
  assert.deepEqual(inspect("{}"), { utf8Bytes: 2, depth: 1, values: 1, containers: 1, members: 0, arrayEntries: 0, decodedStringUnits: 0 });
});

for (const [profile, cap] of [["catalog", 2 * 1024 * 1024], ["device", 8192]]) {
  test(`${profile} admits exact UTF-8 bytes and rejects one extra byte without a character shortcut`, () => {
    for (const content of ["x".repeat(cap - 2), "é".repeat((cap - 2) / 2)]) {
      const text = '"' + content + '"';
      assert.equal(Buffer.byteLength(text), cap);
      assert.equal(inspect(text, profile).utf8Bytes, cap);
      assert.equal(inspect(text, profile).decodedStringUnits, content.length);
      assert.throws(() => inspect(text + " ", profile), limited);
    }
    assert.throws(() => inspect("é".repeat(cap / 2 + 1), profile), limited);
    for (const value of [undefined, null, [], 42]) assert.throws(() => inspect(value, profile), limited);
  });
}

test("catalog root depth one admits 64 containers and rejects the next before JSON allocation", () => {
  const text = "[".repeat(64) + "]".repeat(64);
  assert.equal(inspect(text).depth, 64);
  assert.equal(inspect(text).containers, 64);
  assert.throws(() => inspect("[" + text + "]"), limited);
});

test("device retains the full 4096-container/depth allowance within its exact 8 KiB wire bound", () => {
  const text = "[".repeat(4096) + "]".repeat(4096);
  const result = inspect(text, "device");
  assert.deepEqual(result, { utf8Bytes: 8192, depth: 4096, values: 4096, containers: 4096, members: 0, arrayEntries: 4095, decodedStringUnits: 0 });
  // Another container also exceeds the wire cap; no test-only limit override.
  assert.throws(() => inspect("[" + text + "]", "device"), limited);
});

test("catalog container bound includes empty discarded containers at exact and plus one", () => {
  const result = inspect(array("[]", 32769));
  assert.equal(result.containers, 32770); assert.equal(result.depth, 2);
  assert.throws(() => inspect(array("[]", 32770)), limited);
});

test("catalog member bound counts duplicate empty keys, not just the final parsed object", () => {
  const exact = members(131072);
  assert.equal(inspect(exact).members, 131072);
  assert.deepEqual(JSON.parse(exact), { "": 0 });
  assert.throws(() => inspect(members(131073)), limited);
});

test("catalog array-entry bound is global and rejects the first extra entry", () => {
  assert.equal(inspect(array("0", 131072)).arrayEntries, 131072);
  assert.equal(inspect('[' + array("0", 65535) + ',' + array("0", 65535) + ']').arrayEntries, 131072);
  assert.throws(() => inspect(array("0", 131073)), limited);
});

test("value budget respects the tighter combined member and array-entry bounds", () => {
  const text = '{"":' + array("0", 131072) + ',' + Array(131071).fill('"":0').join(",") + '}';
  const result = inspect(text);
  assert.equal(result.members, 131072); assert.equal(result.arrayEntries, 131072);
  // Every non-root value has one member or array slot. Their combined bound
  // permits at most 262145 values, below the separate 262146 ceiling.
  assert.equal(result.values, 262145);
  assert.throws(() => inspect(text.slice(0, -1) + ',"":0}'), limited);
});

test("device wire bound dominates denser member, value and decoded-string budgets", () => {
  const object = inspect(members(1638), "device");
  assert.equal(object.utf8Bytes, 8191); assert.equal(object.members, 1638); assert.equal(object.values, 1639);
  assert.throws(() => inspect(members(1639), "device"), limited);
  const list = inspect(array("0", 4095), "device");
  assert.equal(list.utf8Bytes, 8191); assert.equal(list.values, 4096);
  assert.throws(() => inspect(array("0", 4096), "device"), limited);
  assert.equal(inspect('"' + "x".repeat(8190) + '"', "device").decodedStringUnits, 8190);
});

test("decoded string units include escaped keys, duplicate values and surrogate code units", () => {
  const text = '{"\\u0061":"\\uD83E\\uDD8A","\\u0061":"x"}';
  assert.equal(inspect(text).decodedStringUnits, 5);
  assert.equal(inspect(text).members, 2);
  for (const value of ["é", "🦊", "\ud800", "\udfff", "e\u0301", '"\\[]{}']) {
    const escaped = JSON.stringify(value);
    assert.equal(inspect(escaped).decodedStringUnits, value.length);
    assert.equal(inspect(escaped).utf8Bytes, Buffer.byteLength(escaped));
  }
  const rawSurrogate = '"\ud800"';
  assert.equal(inspect(rawSurrogate).utf8Bytes, Buffer.byteLength(rawSurrogate));
});

test("malformed whole envelopes fail content-free and never return prefix statistics", () => {
  for (const text of ["", " ", "{} {}", "{} synthetic-private", '[1,]', '{"x":}', '{"x":"unterminated', '{"x":"\\u00xz"}', '"\n"', '01', '{"x":NaN}']) assert.throws(() => inspect(text), malformed);
  assert.throws(() => inspect("{}", "account"), limited);
});

test("inspection uses neither JSON.parse nor a whole encoded copy", () => {
  const parse = JSON.parse, encode = TextEncoder.prototype.encode, encodeInto = TextEncoder.prototype.encodeInto;
  let calls = 0;
  const unexpected = () => { calls++; throw new Error("unexpected whole-document allocation"); };
  JSON.parse = unexpected; TextEncoder.prototype.encode = unexpected; TextEncoder.prototype.encodeInto = unexpected;
  try {
    assert.equal(inspect('{"escaped":"\\u00e9","ignored":[null,false,1.2e3]}').values, 6);
    assert.throws(() => inspect('{"ignored":' + array("[]", 32770) + '}'), limited);
    assert.equal(calls, 0);
  } finally { JSON.parse = parse; TextEncoder.prototype.encode = encode; TextEncoder.prototype.encodeInto = encodeInto; }
});

test("actual tokenizer receives at most 1024 UTF-8 bytes without split raw surrogate pairs", async () => {
  const guardUrl = new URL("../copilot-json-guard.ts?feed-observation", import.meta.url).href;
  const observerUrl = "data:text/javascript," + encodeURIComponent(`
    import {createJsonTokenizer as actual} from ${JSON.stringify(new URL("../json-tokens.ts", import.meta.url).href)};
    export const feeds=[];
    export function createJsonTokenizer(accept){const real=actual(accept);return{
      push(text){feeds.push({bytes:Buffer.byteLength(text),first:text.charCodeAt(0),last:text.charCodeAt(text.length-1)});real.push(text);},
      end(){real.end();}
    };}
  `);
  // Observe the real guard and tokenizer through the existing native hook
  // pattern; no replacement parser, source rewrite or temporary module file.
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === guardUrl && specifier === "./json-tokens.ts") return { shortCircuit: true, url: observerUrl };
    return nextResolve(specifier, context);
  } });
  try {
    const guard = await import(guardUrl), observer = await import(observerUrl);
    const text = JSON.stringify({ ["é".repeat(513)]: "🦊".repeat(1100) + "a".repeat(3000), value: 1e42 });
    assert.equal(guard.inspectCopilotJsonText(text, "catalog").utf8Bytes, Buffer.byteLength(text));
    assert.ok(observer.feeds.length > 10);
    assert.ok(observer.feeds.some(feed => feed.bytes === 1024));
    assert.ok(observer.feeds.every(feed => feed.bytes > 0 && feed.bytes <= 1024
      && !(feed.first >= 0xdc00 && feed.first <= 0xdfff) && !(feed.last >= 0xd800 && feed.last <= 0xdbff)));
  } finally { hooks.deregister(); }
});
