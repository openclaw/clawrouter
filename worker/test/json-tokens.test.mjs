import assert from "node:assert/strict";
import test from "node:test";
import { createJsonTokenizer } from "../json-tokens.ts";

function tokens(...feeds) {
  const seen = [], tokenizer = createJsonTokenizer(token => seen.push(token.value === undefined ? token.name : `${token.name}:${token.value}`));
  for (const feed of feeds) tokenizer.push(feed);
  tokenizer.end();
  return seen;
}

test("synchronous tokenizer streams keys, strings and numbers across feeds", () => {
  assert.deepEqual(tokens('{"a', 'b":"c\\u00e9', '",', '"n":1', '2}'), [
    "startObject", "startKey", "stringChunk:a", "stringChunk:b", "endKey",
    "startString", "stringChunk:cé", "endString",
    "startKey", "stringChunk:n", "endKey", "startNumber", "numberChunk:1", "numberChunk:2", "endNumber", "endObject",
  ]);
  assert.deepEqual(tokens("7"), ["startNumber", "numberChunk:7", "endNumber"]);
});

test("synchronous tokenizer rejects a malformed feed before dispatching its tokens", () => {
  const seen = [], tokenizer = createJsonTokenizer(token => seen.push(token.name));
  tokenizer.push("[1");
  assert.throws(() => tokenizer.push(",]"));
  assert.deepEqual(seen, ["startArray", "startNumber", "numberChunk"]);
  assert.throws(() => tokens('{"a":1}', "{}"));
  assert.throws(() => tokens('{"a":'));
});

test("synchronous tokenizer merges a feed's adjacent chunks without crossing token boundaries", () => {
  // Cross-feed strings split at every escape; one chunk per feed must remain.
  const text = 'say "hi"\\\n'.repeat(2000), wire = JSON.stringify({ k: text, n: 12345 });
  const feeds = [];
  for (let offset = 0; offset < wire.length; offset += 4096) feeds.push(wire.slice(offset, offset + 4096));
  const seen = tokens(...feeds), chunks = seen.filter(token => token.startsWith("stringChunk:"));
  // Key chunks "k" and "n" plus exactly one value chunk per feed.
  assert.equal(chunks.length, 2 + feeds.length);
  assert.equal(chunks.slice(1, -1).map(chunk => chunk.slice("stringChunk:".length)).join(""), text);
  assert.deepEqual(seen.slice(0, 5), ["startObject", "startKey", "stringChunk:k", "endKey", "startString"]);
  assert.deepEqual(seen.slice(-8), ["endString", "startKey", "stringChunk:n", "endKey", "startNumber", "numberChunk:12345", "endNumber", "endObject"]);
});

test("merged chunks rebuild every value exactly under random feed splits", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pieces = ["a", "é", "🦊", "\uD83E", "\uDD8A", '"', "\\", "\n", "\t", "\u0000", "\u00e9", "/", " "];
  // Raw characters, including lone surrogates; JSON.stringify escapes them.
  const string = () => Array.from({ length: Math.floor(random() * 700) }, () => pieces[Math.floor(random() * pieces.length)]).join("");
  for (let round = 0; round < 200; round++) {
    const value = { [string().slice(0, 40)]: [string(), -123.5e-7, { deep: string(), ok: true, none: null }], tail: string() };
    const wire = JSON.stringify(value), feeds = [];
    for (let offset = 0; offset < wire.length;) { const size = 1 + Math.floor(random() * 600); feeds.push(wire.slice(offset, offset + size)); offset += size; }
    const stack = [], keys = [];
    let root, scalar = "", key = false;
    const attach = item => { const top = stack.at(-1); if (!top) root = item; else if (Array.isArray(top)) top.push(item); else top[keys.at(-1)] = item; };
    const tokenizer = createJsonTokenizer(token => {
      switch (token.name) {
        case "startObject": case "startArray": { const item = token.name === "startArray" ? [] : {}; attach(item); stack.push(item); keys.push(null); break; }
        case "endObject": case "endArray": stack.pop(); keys.pop(); break;
        case "startKey": key = true; scalar = ""; break;
        case "endKey": keys[keys.length - 1] = scalar; break;
        case "startString": case "startNumber": key = false; scalar = ""; break;
        case "stringChunk": case "numberChunk": scalar += token.value; break;
        case "endString": attach(scalar); break;
        case "endNumber": attach(Number(scalar)); break;
        default: attach(token.value);
      }
    });
    for (const feed of feeds) tokenizer.push(feed);
    tokenizer.end();
    assert.deepEqual(root, JSON.parse(wire), `round ${round}`);
    assert.equal(key, false);
  }
});
