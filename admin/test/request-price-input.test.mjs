import assert from "node:assert/strict";
import test from "node:test";
import { optionalRequestPriceMicros, requestPriceInput, requestPricesInput, requestPricesMicros } from "../src/request-price-input.ts";

test("dollar request prices convert exactly without rounding balances", () => {
  for (const [dollars, micros] of [["0.001", 1000], [".000001", 1], ["$1.234567", 1234567], ["1e-6", 1], ["0.0010000", 1000], ["0", 0], ["1.000001", 1000001], ["9007199254.740991", Number.MAX_SAFE_INTEGER]]) {
    assert.equal(optionalRequestPriceMicros(dollars), micros, dollars);
    assert.equal(optionalRequestPriceMicros(requestPriceInput(micros)), micros, dollars);
  }
  assert.equal(optionalRequestPriceMicros(" "), undefined);
  assert.equal(requestPriceInput(null), "");
  assert.equal(requestPriceInput(undefined), "");
  assert.equal(requestPriceInput(1000), "0.001");
  assert.equal(requestPriceInput(1), "0.000001");
});

test("request prices reject fractional microdollars, invalid numbers and overflow", () => {
  for (const input of ["0.0000001", "1e-7", "1.0000001", "0.0010001"]) {
    assert.throws(() => optionalRequestPriceMicros(input), /six decimal places/, input);
  }
  for (const input of ["-1", "NaN", "Infinity", "$", "0x10", "1,000", "9007199254.740992", "1e1000000"]) {
    assert.throws(() => optionalRequestPriceMicros(input), /Request price/, input);
  }
});

test("capability JSON prices round-trip the API's full integer range in dollars", () => {
  const stored = { "search.web": 1000, "llm.responses": 0, "test.unit": 1, "test.price": 1234567, "test.large": 9007199254740990, "test.maximum": Number.MAX_SAFE_INTEGER };
  const input = requestPricesInput(stored);
  assert.match(input, /"search.web": 0\.001/);
  assert.match(input, /"test.maximum": 9007199254\.740991/);
  assert.deepEqual(requestPricesMicros(input), stored);
  assert.deepEqual(requestPricesMicros('{"test.v2":1e-6,"search.\\u0077eb":0.001}'), { "test.v2": 1, "search.web": 1000 });
  assert.deepEqual(requestPricesMicros('{"search.web":0.002,"search.web":0.001}'), { "search.web": 1000 });
  assert.deepEqual(requestPricesMicros("{}"), {});
  assert.equal(requestPricesInput({}), "{}");
  assert.equal(requestPricesInput(null), "");
  assert.equal(requestPricesMicros(" "), null);
  assert.equal(requestPricesMicros("null"), null);
});

test("capability prices reject nonnumeric JSON values and unrepresentable prices", () => {
  for (const input of ["{", "[]", "true", "0.001", '{"search.web":"0.001"}', '{"search.web":null}', '{"search.web":{}}', '{"search.web":[]}', '{"search.web":false}', '{"search.web":-0.001}', '{"search.web":1e999}']) {
    assert.throws(() => requestPricesMicros(input), /Capability prices/, input);
  }
  assert.throws(() => requestPricesMicros('{"search.web":0.0000001}'), /six decimal places/);
  assert.throws(() => requestPricesMicros('{"search.web":9007199254.740992}'), /exceeds/);
  assert.throws(() => requestPricesMicros(JSON.stringify(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`test.cap${i}`, 0.001])))), /64/);
});
