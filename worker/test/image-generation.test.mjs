import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { providerById, capabilityForPath, unifiedPathForEndpoint } from "../providers.ts";
import { actualModelCost, estimateModelCost, requestPricingGap } from "../pricing.ts";
import { validateImageGeneration, extractImageUsageTokens } from "../image-generation.ts";
import { observeUsage } from "../proxy-response.ts";
import { HttpOperation } from "../http-operation.ts";

const provider = providerById("openai");
const model = provider.models.find(m => m.id === "openai/gpt-image-2.5-sunburst");
const pricing = model.pricing;
const usage = { input_tokens: 15, output_tokens: 100, total_tokens: 115, input_tokens_details: { text_tokens: 10, image_tokens: 5 } };
const format = "openai.images_generations";

test("current image aliases and dated snapshots expose modality tariffs and generation only", () => {
  const images = provider.models.filter(m => m.capabilities.includes("image.generation"));
  assert.equal(images.length, 4);
  assert.equal(capabilityForPath("/v1/images/generations"), "image.generation");
  const endpoint = provider.endpoints.find(e => e.id === "images_generations");
  assert.equal(unifiedPathForEndpoint(provider, endpoint), "/v1/images/generations");
  assert.equal(endpoint.streaming, null);
  for (const m of images) {
    assert.deepEqual(m.capabilities, ["image.generation"]);
    assert.equal(m.pricing.textInputMicrosPerMillion, 5_000_000);
    assert.equal(m.pricing.imageInputMicrosPerMillion, 8_000_000);
    assert.equal(m.pricing.imageOutputMicrosPerMillion, 30_000_000);
  }
  assert.equal(requestPricingGap(pricing, { tools: [{ type: "image_generation" }] }, "openai.responses"), "hosted_tool_fee");
});

test("generation admits only bounded JSON options, including worst-case auto/count/Unicode", () => {
  for (const size of [undefined, "auto", "1024x1024", "1536x1024", "1024x1536", "1536x864", "3840x2160", "2880x2880"]) {
    for (const quality of [undefined, "auto", "low", "medium", "high", "xhigh", "max"]) {
      const body = { prompt: "😀".repeat(32000), n: 10, ...(size ? { size } : {}), ...(quality ? { quality } : {}) };
      validateImageGeneration(body, pricing);
      const estimate = estimateModelCost(pricing, body);
      assert.ok(estimate.reserveMicros > 0);
      assert.ok(estimate.inputTokens >= 1280000);
    }
  }
  for (const patch of [{prompt:""}, {prompt:"a".repeat(32001)}, {prompt:null}, {n:0}, {n:11}, {n:1.1}, {n:null}, {size:"500x500"}, {size:"4096x2048"}, {size:"3840x3840"}, {size:"3840x640"}, {size:"1025x1024"}, {size:null}, {quality:"hd"}, {quality:null}, {stream:true}, {stream:null}, {partial_images:0}, {response_format:"b64_json"}, {image:"fixture"}, {tools:[]}, {service_tier:"priority"}, {output_compression:50}, {output_format:"jpeg",background:"transparent"}, {output_format:"webp",output_compression:101}, {safety_identifier:"x".repeat(129)}]) {
    assert.throws(() => validateImageGeneration({ prompt: "fixture", ...patch }, pricing), /image|compression|transparent|stream|unsupported/);
  }
  validateImageGeneration({prompt:"fixture", output_format:"webp", output_compression:0, background:"transparent", moderation:"low", safety_identifier:"hash", user:"legacy", stream:false}, pricing);
});

test("reservation envelope bounds the official 2.5 calculator at every valid dimension and quality", () => {
  // Explicit 2.5 mode, fetched 2026-10-20. Image 2 uses different coefficients.
  const factors = {low:16, medium:24, high:48, xhigh:64, max:96};
  const evenRound = x => x % 1 === 0.5 ? 2 * Math.round(x / 2) : Math.round(x);
  for (const [quality, factor] of Object.entries(factors)) {
    const bound = estimateModelCost(pricing, {prompt:"fixture",n:1,quality}).outputTokens;
    for (let w = 16; w <= 3840; w += 16) for (let h = 16; h <= 3840; h += 16) {
      const pixels = w*h;
      if (pixels < 655360 || pixels > 8294400 || Math.max(w,h)/Math.min(w,h)>3) continue;
      const short = evenRound(factor / (Math.max(w,h)/Math.min(w,h)));
      const calculated = Math.ceil(factor * short * (2000000 + pixels) / 4000000);
      assert.ok(bound >= calculated, quality + " " + w + "x" + h);
    }
    assert.equal(estimateModelCost(pricing, {prompt:"fixture",n:10,quality}).outputTokens, 10*bound);
  }
  const a = estimateModelCost(pricing, {prompt:"fixture"});
  assert.equal(a.outputTokens, 23719);
  assert.equal(estimateModelCost(pricing, {prompt:"fixture",quality:"auto",size:"auto"}).reserveMicros, a.reserveMicros);
});

test("actual billing requires consistent modality usage and never chat/cache/flat prices", () => {
  const tokens = extractImageUsageTokens({usage});
  assert.equal(actualModelCost(pricing, tokens, format), 3090);
  assert.equal(actualModelCost(pricing, tokens, "openai.responses"), null);
  assert.equal(actualModelCost(pricing, {input:15,output:100}, format), null);
  assert.equal(actualModelCost(pricing, extractImageUsageTokens({usage:{...usage,input_tokens_details:{...usage.input_tokens_details,cached_tokens:15}}}), format), 3090, "direct Images has no cache discount");
  assert.equal(actualModelCost(pricing, extractImageUsageTokens({usage:{...usage,output_tokens_details:{image_tokens:90,text_tokens:10}}}), format), 2790);
  for (const patch of [{input_tokens:16},{total_tokens:0},{input_tokens_details:null},{input_tokens_details:{text_tokens:10,image_tokens:-1}},{output_tokens:1.5},{output_tokens_details:{image_tokens:90,text_tokens:0}}]) assert.equal(extractImageUsageTokens({usage:{...usage,...patch}}), null);
});

for (const chunkSize of [1, 4096, 6_000_000]) test("large base64 JSON retains bounded trailing usage, chunk="+chunkSize, async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({data:[{b64_json:"A".repeat(chunkSize === 1 ? 8192 : 3*1024*1024)}],usage}));
  let offset=0,pulls=0;
  const upstream = new Response(new ReadableStream({pull(c){pulls++; if(offset===bytes.length) return c.close(); const end=Math.min(bytes.length,offset+chunkSize);c.enqueue(bytes.subarray(offset,end));offset=end;}},{highWaterMark:0}), {headers:{"content-type":"application/json"}});
  const observed=observeUsage(upstream,new HttpOperation(),undefined,format);
  assert.equal(pulls,0,"no eager drain");
  const delivered=new Uint8Array(await observed.response.arrayBuffer());
  assert.deepEqual(delivered,bytes);
  const result=await observed.result;
  assert.equal(result.delivery,"complete");
  assert.equal(actualModelCost(pricing,result.tokens,format),3090);
});

for (const scenario of ["cancel","abort","error","malformed","missing","sse"]) test("image inspection conservative "+scenario, async () => {
  let cancel=0,pulls=0;
  const abort=new AbortController();
  const bytes=new TextEncoder().encode(scenario==="missing"?'{"data":[]}':scenario==="sse"?'data: '+JSON.stringify({usage})+'\n\n':JSON.stringify({usage}));
  const response=new Response(new ReadableStream({pull(c){if(pulls++===0)c.enqueue(bytes);else if(scenario==="error")c.error(new Error("fixture"));else if(scenario==="malformed") {c.enqueue(new TextEncoder().encode("!"));c.close();}else c.close();},cancel(){cancel++;}},{highWaterMark:0}),{headers:{"content-type":scenario==="sse"?"text/event-stream":"application/json"}});
  const observed=observeUsage(response,new HttpOperation(abort.signal),undefined,format);
  const reader=observed.response.body.getReader();await reader.read();
  if(scenario==="cancel")await reader.cancel();
  else if(scenario==="abort"){abort.abort(new Error("fixture"));await assert.rejects(reader.read());}
  else if(scenario==="error")await assert.rejects(reader.read());
  else while(!(await reader.read()).done){}
  assert.equal((await observed.result).tokens,null,"partial, malformed or non-JSON usage cannot discount the reservation");
  if(["cancel","abort","error"].includes(scenario))assert.equal(cancel,scenario==="error"?0:1);
});

test("prompt and n diagnostics name corrective manifest-derived limits without exposing caller content", () => {
  const custom = { ...pricing, generation: { ...pricing.generation, maxPromptCharacters: 2, maxImages: 3 } };
  for (const tariff of [pricing, custom]) {
    const { maxPromptCharacters, maxImages } = tariff.generation;
    const promptMessage = "image prompt must be a nonempty string of at most " + maxPromptCharacters + " Unicode code points";
    const countMessage = "image n must be an integer from 1 to " + maxImages;
    const privateIdentifier = "fixture-private-identifier";
    const check = (body, message) => assert.throws(() => validateImageGeneration({ safety_identifier: privateIdentifier, ...body }, tariff), error => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_image_generation");
      assert.equal(error.message, message);
      assert.ok(!error.message.includes(privateIdentifier));
      return true;
    });
    for (const prompt of [undefined, null, 42, "", "😀".repeat(maxPromptCharacters + 1)]) check({ prompt }, promptMessage);
    for (const n of [0, -1, 1.5, null, "1", maxImages + 1]) check({ prompt: "😀", n }, countMessage);
    // Limits count Unicode code points, not UTF-16 code units. Omitted n stays valid.
    validateImageGeneration({ prompt: "😀".repeat(maxPromptCharacters) }, tariff);
    validateImageGeneration({ prompt: "😀", n: maxImages }, tariff);
  }
});
