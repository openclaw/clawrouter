import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prepareDuckDuckGoSearch, parseDuckDuckGoHtml, readDuckDuckGoHtml } from "../duckduckgo-html.ts";
const wire = JSON.parse(readFileSync(new URL("../../providers/_fixtures/duckduckgo/search.json", import.meta.url), "utf8"));
const response = html => new Response(html, { headers: { "content-type": wire.success.contentType } });

test("DuckDuckGo native query keeps region/safe-search without credentials or browser impersonation", () => {
  const value = prepareDuckDuckGoSearch(new URLSearchParams(wire.request.query));
  assert.equal(value.url, "https://html.duckduckgo.com/html?q=synthetic+query&kl=us-en&kp=-1");
  assert.equal(value.headers.get("authorization"), null);
  assert.equal(value.headers.get("cookie"), null);
  assert.match(value.headers.get("user-agent"), /^clawrouter-duckduckgo\//);
  assert.equal(new URL(prepareDuckDuckGoSearch(new URLSearchParams("q=synthetic")).url).searchParams.get("kp"), "-1");
  for (const query of ["q=a&q=b", "q=a&kp=0", "q=a&format=json", "q=a&api_key=synthetic", "q=a&kl=invalid", "q="]) assert.throws(() => prepareDuckDuckGoSearch(new URLSearchParams(query)));
});

test("DuckDuckGo HTML preserves highlighted words, entities, redirect URLs and scoped snippets", async () => {
  const value = await readDuckDuckGoHtml(response(wire.success.html));
  assert.equal(value.html, wire.success.html);
  assert.deepEqual(value.results, wire.success.results);
  assert.deepEqual(parseDuckDuckGoHtml(wire.success.html, 1), wire.success.results.slice(0, 1));
});

test("DuckDuckGo challenge, changed layout and explicit empty results are distinct", () => {
  assert.deepEqual(parseDuckDuckGoHtml(wire.empty), []);
  assert.throws(() => parseDuckDuckGoHtml(wire.challenge), { message: "duckduckgo_challenge" });
  assert.throws(() => parseDuckDuckGoHtml(wire.changedLayout), { message: "duckduckgo_layout_changed" });
  assert.throws(() => parseDuckDuckGoHtml(wire.success.html + wire.challenge), /challenge/);
  assert.equal(wire.billing.challengeIsSearchSuccess, false);
  assert.equal(wire.billing.upstreamUsdQualified, false);
});

test("DuckDuckGo ignores inert markup, rejects invalid links and never unwraps unrelated domains", () => {
  assert.deepEqual(parseDuckDuckGoHtml("<script>" + wire.success.html + "</script>" + wire.empty), []);
  assert.deepEqual(parseDuckDuckGoHtml("<!--" + wire.success.html + "-->" + wire.empty), []);
  for (const href of ["", "javascript:alert(1)", "data:text/plain,synthetic", "https://user:synthetic@example.com"]) {
    assert.throws(() => parseDuckDuckGoHtml('<a class="result__a" href="' + href + '">Synthetic</a>'), /invalid_results/);
  }
  const html = '<a class="result__a" href="https://example.com/?uddg=https%3A%2F%2Fother.example">Synthetic</a>';
  assert.equal(parseDuckDuckGoHtml(html)[0].url, "https://example.com/?uddg=https%3A%2F%2Fother.example");
  assert.throws(() => parseDuckDuckGoHtml('<a class="result__a">Synthetic<a>nested</a>'), /layout_changed/);
  assert.throws(() => parseDuckDuckGoHtml("<script>unclosed"), /layout_changed/);
});

test("DuckDuckGo full-body observation rejects HTTP/MIME errors, partial UTF-8 and oversized HTML", async () => {
  for (const value of [
    new Response(wire.success.html, { status: 403, headers: { "content-type": "text/html" } }),
    Response.json({ results: [] }),
    response(new Uint8Array([0xe2, 0x82])),
    new Response(" ", { headers: { "content-type": "text/html", "content-length": "2097153" } }),
  ]) await assert.rejects(() => readDuckDuckGoHtml(value));
  await assert.rejects(() => readDuckDuckGoHtml(response(wire.challenge)), /challenge/);
  assert.throws(() => parseDuckDuckGoHtml(wire.success.html, 21));
});

test("DuckDuckGo fragmented native HTML reaches EOF before exposing results", async () => {
  const bytes = new TextEncoder().encode(wire.success.html);
  const stream = new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
    controller.close();
  } });
  assert.deepEqual((await readDuckDuckGoHtml(response(stream))).results, wire.success.results);
  const failed = new ReadableStream({ start(controller) {
    controller.enqueue(bytes); controller.error(new Error("synthetic disconnect"));
  } });
  await assert.rejects(() => readDuckDuckGoHtml(response(failed)), { message: "invalid_duckduckgo_body" });
});
