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
    "startString", "stringChunk:c", "stringChunk:é", "endString",
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
